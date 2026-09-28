/**
 * CC Deck — install-path manager (orchestration + backups + concurrency).
 *
 * This is the single coordinator for the "custom Claude Code install path"
 * feature. It does NOT know how to edit any particular resource; that lives in
 * the `MutationDriver`s (registry PATH, Unix shell profiles, Claude settings).
 * Here we:
 *
 *   - aggregate drivers and expose a merged target/status view,
 *   - compute the `TargetContext` (install root + bin dir + launcher) for the
 *     pinned install,
 *   - validate a candidate directory really is a Claude Code install,
 *   - apply the change to the selected targets under an advisory lock, with a
 *     snapshot/retry safety net against concurrent external edits,
 *   - journal a `BackupRecord` per apply so the change can be reverted,
 *   - fan out live `ConflictEvent`s to subscribers (`index.ts` -> renderer).
 *
 * Every public entry point is shaped and never throws: failures come back as
 * `{ ok: false, error }` (or an equivalent shaped value) so the IPC layer can
 * surface them without an unhandled rejection.
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import type { Stats } from 'node:fs'
import * as path from 'node:path'
import { promisify } from 'node:util'
import type {
  ApplyRequest,
  ApplyResult,
  BackupEntry,
  BackupRecord,
  ConflictEvent,
  InstallStatus,
  MutationTarget,
  MutationTargetKind,
  Platform,
  TargetResult,
  ValidateResult
} from '@shared/types'
import type { ApplyOutcome, MutationDriver, TargetContext } from './env/driver'
import { changedSince, hashString, snapshot, withLock } from './env/fs-lock'
import { registryDriver } from './env/registry'
import { unixProfileDriver } from './env/unix-profile'
import { claudeConfigDriver } from './env/claude-config'
import { detectInstalls } from './installs'
import { getActiveInstallPath, getBackups, setActiveInstallPath, setBackups } from '../store'

const execFileAsync = promisify(execFile)

const IS_WIN = process.platform === 'win32'

/** npm package segment used to recognise an npm-global install layout. */
const PACKAGE_SEGMENT = '@anthropic-ai/claude-code'

/** Kinds whose `location` is a filesystem path (vs. a registry key). */
function isFileKind(kind: MutationTargetKind): boolean {
  return kind !== 'windows-user-path' && kind !== 'windows-system-path'
}

/* ------------------------------------------------------------------ */
/* Driver registry                                                     */
/* ------------------------------------------------------------------ */

/**
 * All drivers, in display order. `registryDriver` owns BOTH Windows targets
 * (`windows-user-path` + `windows-system-path`), so target-id-prefix matching
 * (below) is used rather than exact kind matching.
 */
const DRIVERS: MutationDriver[] = [registryDriver, unixProfileDriver, claudeConfigDriver]

/**
 * kind -> driver map. Built from the registered drivers, then patched:
 * `registryDriver`'s driver object advertises `windows-user-path`, but its
 * `list()` ALSO emits `windows-system-path` targets, so it must be registered
 * under both kinds. Any future driver (e.g. a `launcher-shim`) registers itself
 * automatically via the loop.
 */
const DRIVER_BY_KIND: Partial<Record<MutationTargetKind, MutationDriver>> = (() => {
  const map: Partial<Record<MutationTargetKind, MutationDriver>> = {}
  for (const d of DRIVERS) map[d.kind] = d
  map['windows-system-path'] = registryDriver
  return map
})()

/** Find the driver that owns a target by its id prefix (`<driverId>...`). */
function driverForTargetId(targetId: string): MutationDriver | null {
  return DRIVERS.find((d) => targetId.startsWith(d.id)) ?? null
}

/** Fallback: find a driver by the target's `kind` (see DRIVER_BY_KIND). */
function driverForKind(kind: MutationTargetKind): MutationDriver | null {
  return DRIVER_BY_KIND[kind] ?? null
}

function driverFor(target: MutationTarget): MutationDriver | null {
  return driverForTargetId(target.id) ?? driverForKind(target.kind)
}

/* ------------------------------------------------------------------ */
/* Mutation event emitter                                              */
/* ------------------------------------------------------------------ */

type MutationListener = (event: ConflictEvent) => void

const listeners = new Set<MutationListener>()

/** Subscribe to live mutation/concurrency events. Returns an unsubscribe fn. */
export function onInstallMutation(cb: MutationListener): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** Fan an event out to subscribers; a throwing listener never breaks an apply. */
function emit(event: ConflictEvent): void {
  for (const cb of [...listeners]) {
    try {
      cb(event)
    } catch (err) {
      log(`listener threw: ${errText(err)}`)
    }
  }
}

function conflictEvent(
  target: Pick<MutationTarget, 'id' | 'location'>,
  kind: ConflictEvent['kind'],
  resolution: ConflictEvent['resolution'],
  message: string
): ConflictEvent {
  return {
    targetId: target.id,
    location: target.location,
    detectedAt: new Date().toISOString(),
    kind,
    resolution,
    message
  }
}

/* ------------------------------------------------------------------ */
/* Small utilities                                                     */
/* ------------------------------------------------------------------ */

function log(message: string): void {
  // Concise diagnostics only; never noisy enough to bother the user.
  console.warn(`[install-manager] ${message}`)
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function safeRealpath(p: string): Promise<string> {
  try {
    return await fs.realpath(p)
  } catch {
    return p
  }
}

function currentPlatform(): Platform {
  const p = process.platform
  return p === 'win32' || p === 'darwin' || p === 'linux' ? p : 'linux'
}

/** Normalise a path for comparison (case-insensitive on Windows). */
function normalizePath(p: string): string {
  const resolved = path.resolve(p)
  return IS_WIN ? resolved.toLowerCase() : resolved
}

function samePath(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b)
}

function sameDir(a: string | null, b: string | null): boolean {
  if (!a || !b) return false
  return normalizePath(a) === normalizePath(b)
}

/** Run a command, resolving to trimmed stdout or null on any failure/timeout. */
async function tryExec(cmd: string, args: string[], timeout = 3000): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout, windowsHide: true })
    return stdout.trim()
  } catch {
    // On Windows bare names and .cmd/.bat shims must go through cmd.exe.
    if (IS_WIN && !/\.exe$/i.test(cmd)) {
      try {
        const { stdout } = await execFileAsync('cmd.exe', ['/d', '/s', '/c', cmd, ...args], {
          timeout,
          windowsHide: true
        })
        return stdout.trim()
      } catch {
        return null
      }
    }
    return null
  }
}

/** Resolve what `claude` currently points to on PATH (`where`/`which`). */
async function whichClaude(): Promise<string | null> {
  const out = await tryExec(IS_WIN ? 'where' : 'which', ['claude'], 3000)
  if (!out) return null
  return out.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? null
}

/** First whitespace-delimited token of `<exe> --version`, or null. */
async function versionOf(exe: string): Promise<string | null> {
  const out = await tryExec(exe, ['--version'], 3000)
  if (!out) return null
  return out.split(/\s+/)[0] ?? null
}

/** Whether `dir` looks like `<...>/node_modules/@anthropic-ai/claude-code`. */
function isNpmPackageDir(dir: string): boolean {
  const normalized = dir.replace(/[\\/]+$/, '').replace(/\\/g, '/')
  return normalized.endsWith(`node_modules/${PACKAGE_SEGMENT}`)
}

/* ------------------------------------------------------------------ */
/* Install resolution + context                                        */
/* ------------------------------------------------------------------ */

interface InstallInfo {
  executable: string | null
  version: string | null
}

const LAUNCHER_NAMES = IS_WIN ? ['claude.cmd', 'claude.ps1', 'claude.exe', 'claude'] : ['claude']

/** Find a `claude` launcher inside `dir` (or `self` if it is itself one). */
async function findLauncher(dir: string, self: string, selfIsDir: boolean): Promise<string | null> {
  if (!selfIsDir && /^claude(\.(cmd|ps1|exe|bat))?$/i.test(path.basename(self))) return self
  for (const name of LAUNCHER_NAMES) {
    const candidate = path.join(dir, name)
    if (await pathExists(candidate)) return candidate
  }
  return null
}

/** Read `name`/`version` from `<dir>/package.json`, tolerating absence/parse errors. */
async function readPackageJson(dir: string): Promise<{ name: string | null; version: string | null }> {
  try {
    const raw = await fs.readFile(path.join(dir, 'package.json'), 'utf8')
    const pkg = JSON.parse(raw) as { name?: unknown; version?: unknown }
    return {
      name: typeof pkg.name === 'string' ? pkg.name : null,
      version: typeof pkg.version === 'string' ? pkg.version : null
    }
  } catch {
    return { name: null, version: null }
  }
}

/** Best-effort probe of an arbitrary install directory (used when not detected). */
async function probeInstall(installPath: string): Promise<InstallInfo> {
  try {
    const stat = await fs.stat(installPath)
    const isDir = stat.isDirectory()
    const dir = isDir ? installPath : path.dirname(installPath)
    const pkg = await readPackageJson(dir)
    const launcher = await findLauncher(dir, path.resolve(installPath), isDir)
    const version = pkg.version ?? (launcher ? await versionOf(launcher) : null)
    return { executable: launcher, version }
  } catch {
    return { executable: null, version: null }
  }
}

/**
 * Resolve the pinned install's launcher + version via `detectInstalls()`
 * (matching on the realpath), falling back to a direct probe when the directory
 * is not in the detected set (e.g. a freshly picked custom path).
 */
async function resolveInstallInfo(installPath: string): Promise<InstallInfo> {
  let info: InstallInfo = { executable: null, version: null }
  try {
    const installs = await detectInstalls()
    const match = installs.find((i) => samePath(i.path, installPath))
    if (match) info = { executable: match.executable, version: match.version }
  } catch (err) {
    log(`detectInstalls failed: ${errText(err)}`)
  }

  if (!info.executable || !info.version) {
    const probe = await probeInstall(installPath)
    info = { executable: info.executable ?? probe.executable, version: info.version ?? probe.version }
  }
  return info
}

/**
 * Compute the directory that must end up on PATH for `installPath`:
 *   1. the resolved launcher's directory when the launcher exists,
 *   2. else the npm prefix for a `node_modules/@anthropic-ai/claude-code` layout,
 *   3. else the install root itself.
 */
async function computeBinDir(installPath: string, executable: string | null): Promise<string> {
  if (executable && (await pathExists(executable))) return path.dirname(executable)
  if (isNpmPackageDir(installPath)) return path.resolve(installPath, '..', '..', '..')
  return installPath
}

/** Build a `TargetContext` for a pinned install. */
async function buildContext(
  installPath: string,
  opts: { prependPath: boolean; dryRun: boolean; info?: InstallInfo }
): Promise<TargetContext> {
  const info = opts.info ?? (await resolveInstallInfo(installPath))
  const binDir = await computeBinDir(installPath, info.executable)
  return {
    installPath,
    binDir,
    executable: info.executable,
    prependPath: opts.prependPath,
    dryRun: opts.dryRun
  }
}

/* ------------------------------------------------------------------ */
/* Target aggregation                                                  */
/* ------------------------------------------------------------------ */

/** Collect every available target from every driver. */
async function collectTargets(): Promise<MutationTarget[]> {
  const targets: MutationTarget[] = []
  for (const driver of DRIVERS) {
    try {
      const listed = await driver.list()
      for (const t of listed) if (t.available) targets.push(t)
    } catch (err) {
      log(`driver ${driver.id} list() failed: ${errText(err)}`)
    }
  }
  return targets
}

/**
 * Collect targets and, when an install is pinned, enrich each with its live
 * `applied` state (`list()` has no context, so it cannot decide this).
 */
async function resolveTargets(installPath: string | null): Promise<MutationTarget[]> {
  const targets = await collectTargets()
  if (!installPath) return targets

  let ctx: TargetContext
  try {
    ctx = await buildContext(installPath, { prependPath: true, dryRun: true })
  } catch (err) {
    log(`failed to build context for ${installPath}: ${errText(err)}`)
    return targets
  }

  await Promise.all(
    targets.map(async (t) => {
      const driver = driverFor(t)
      if (!driver) return
      try {
        t.applied = await driver.isApplied(t, ctx)
      } catch {
        /* leave applied=false on driver failure */
      }
    })
  )
  return targets
}

/* ------------------------------------------------------------------ */
/* Backups                                                             */
/* ------------------------------------------------------------------ */

/** Newest-first copy of the persisted backup records. */
function sortBackups(records: BackupRecord[]): BackupRecord[] {
  return [...records].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** List available backups, newest first. Never throws. */
export async function listBackups(): Promise<BackupRecord[]> {
  try {
    return sortBackups(getBackups())
  } catch (err) {
    log(`listBackups failed: ${errText(err)}`)
    return []
  }
}

/* ------------------------------------------------------------------ */
/* Status                                                              */
/* ------------------------------------------------------------------ */

function emptyStatus(): InstallStatus {
  return {
    installPath: null,
    executable: null,
    version: null,
    pathResolvesTo: null,
    pathApplied: false,
    targets: [],
    backups: [],
    platform: currentPlatform()
  }
}

/**
 * Full mutation status: pinned path, resolved launcher/version, targets (with
 * live `applied` flags) and backups. Does not resolve PATH — see
 * `refreshStatus()` for that. Never throws.
 */
export async function installStatus(): Promise<InstallStatus> {
  try {
    const installPath = getActiveInstallPath()
    const info = installPath ? await resolveInstallInfo(installPath) : { executable: null, version: null }
    const targets = await resolveTargets(installPath)
    return {
      installPath,
      executable: info.executable,
      version: info.version,
      pathResolvesTo: null,
      pathApplied: false,
      targets,
      backups: sortBackups(getBackups()),
      platform: currentPlatform()
    }
  } catch (err) {
    log(`installStatus failed: ${errText(err)}`)
    return emptyStatus()
  }
}

/**
 * Like `installStatus()` but additionally re-resolves what `claude` currently
 * points to on PATH and reports whether that matches the pinned install.
 */
export async function refreshStatus(): Promise<InstallStatus> {
  try {
    const installPath = getActiveInstallPath()
    const info = installPath ? await resolveInstallInfo(installPath) : { executable: null, version: null }
    const binDir = installPath ? await computeBinDir(installPath, info.executable) : null
    const resolved = await whichClaude()
    const pathApplied = resolved !== null && sameDir(path.dirname(resolved), binDir)
    const targets = await resolveTargets(installPath)
    return {
      installPath,
      executable: info.executable,
      version: info.version,
      pathResolvesTo: resolved,
      pathApplied,
      targets,
      backups: sortBackups(getBackups()),
      platform: currentPlatform()
    }
  } catch (err) {
    log(`refreshStatus failed: ${errText(err)}`)
    return emptyStatus()
  }
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

function invalid(message: string, version: string | null = null, executable: string | null = null): ValidateResult {
  return { ok: false, isClaudeCode: false, version, executable, message }
}

/**
 * Check that `p` exists and looks like a Claude Code install: a
 * `@anthropic-ai/claude-code` package.json, a `claude` launcher, or an
 * executable whose `--version` mentions "Claude Code". Never throws.
 */
export async function validateInstallPath(p: string): Promise<ValidateResult> {
  try {
    if (typeof p !== 'string' || p.trim() === '') return invalid('A path is required.')

    const abs = path.resolve(p)
    let stat: Stats
    try {
      stat = await fs.stat(abs)
    } catch {
      return invalid(`Path does not exist: ${abs}`)
    }

    const isDir = stat.isDirectory()
    const dir = isDir ? abs : path.dirname(abs)
    const pkg = await readPackageJson(dir)
    const launcher = await findLauncher(dir, abs, isDir)

    // 1. Authoritative: the Claude Code package itself.
    if (pkg.name === PACKAGE_SEGMENT) {
      const version = pkg.version ?? (launcher ? await versionOf(launcher) : null)
      return {
        ok: true,
        isClaudeCode: true,
        version,
        executable: launcher,
        message: version ? `Claude Code ${version} detected.` : 'Claude Code install detected.'
      }
    }

    // 2. A `claude` launcher next to / at the path.
    if (launcher) {
      const version = pkg.version ?? (await versionOf(launcher))
      return {
        ok: true,
        isClaudeCode: true,
        version,
        executable: launcher,
        message: `Found Claude Code launcher: ${launcher}`
      }
    }

    // 3. Last resort: run the path itself and look for the version banner.
    if (!isDir) {
      const out = await tryExec(abs, ['--version'], 4000)
      if (out && /claude code/i.test(out)) {
        return {
          ok: true,
          isClaudeCode: true,
          version: out.split(/\s+/)[0] ?? null,
          executable: abs,
          message: out
        }
      }
    }

    return invalid(`Not a Claude Code install: ${abs}`, pkg.version, launcher)
  } catch (err) {
    return invalid(errText(err))
  }
}

/* ------------------------------------------------------------------ */
/* Apply                                                               */
/* ------------------------------------------------------------------ */

interface TargetApply {
  result: TargetResult
  backup: BackupEntry | null
}

function pushOutcomeConflicts(outcome: ApplyOutcome, conflicts: ConflictEvent[]): void {
  for (const c of outcome.conflicts) {
    conflicts.push(c)
    emit(c)
  }
}

/**
 * Apply one target, retrying once on a detected concurrent modification.
 * Assumes the caller already holds any necessary lock. Never throws.
 */
async function applyTargetOnce(
  driver: MutationDriver,
  target: MutationTarget,
  ctx: TargetContext,
  conflicts: ConflictEvent[]
): Promise<TargetApply> {
  const fileTarget = isFileKind(target.kind)
  const before = fileTarget ? await snapshot(target.location) : null

  try {
    let outcome = await driver.apply(target, ctx)
    pushOutcomeConflicts(outcome, conflicts)

    if (fileTarget && outcome.changed && outcome.newValue !== null) {
      const expected = hashString(outcome.newValue)
      if (await changedSince(target.location, expected)) {
        // Someone (an editor, another process) rewrote the file between our read
        // and write. Re-snapshot + re-merge exactly once.
        const retry = conflictEvent(
          target,
          'external-modification',
          'retried',
          `File changed concurrently (was ${shortHash(before?.hash)}); re-reading and re-applying once.`
        )
        conflicts.push(retry)
        emit(retry)

        outcome = await driver.apply(target, ctx)
        pushOutcomeConflicts(outcome, conflicts)

        const stillChanged =
          outcome.changed &&
          (outcome.newValue === null || (await changedSince(target.location, hashString(outcome.newValue))))

        const final = conflictEvent(
          target,
          'external-modification',
          stillChanged ? 'aborted' : 'merged',
          stillChanged
            ? 'File kept changing; our write may have been overwritten by an external editor.'
            : 'Merged with the concurrent change on retry.'
        )
        conflicts.push(final)
        emit(final)

        if (stillChanged) {
          return {
            result: {
              targetId: target.id,
              ok: false,
              changed: outcome.changed,
              message: final.message,
              newValue: outcome.newValue
            },
            backup: outcome.backup
          }
        }
      }
    }

    return {
      result: {
        targetId: target.id,
        ok: true,
        changed: outcome.changed,
        message: outcome.changed ? 'Applied.' : 'Already up to date.',
        newValue: outcome.newValue
      },
      backup: outcome.backup
    }
  } catch (err) {
    // A driver write failure (e.g. HKLM without elevation) is not a conflict —
    // it is simply a failed target. Surface it as ok:false.
    const message = errText(err)
    log(`apply failed for ${target.id}: ${message}`)
    return { result: { targetId: target.id, ok: false, changed: false, message }, backup: null }
  }
}

function shortHash(hash: string | undefined): string {
  return hash ? hash.slice(0, 8) : 'absent'
}

/**
 * Apply one target. File targets are wrapped in an advisory lock so two CC Deck
 * instances cannot interleave read-modify-write; lock contention is reported as
 * a `lock-contention` conflict event rather than thrown.
 */
async function applyTarget(
  driver: MutationDriver,
  target: MutationTarget,
  ctx: TargetContext,
  conflicts: ConflictEvent[]
): Promise<TargetApply> {
  if (!isFileKind(target.kind)) return applyTargetOnce(driver, target, ctx, conflicts)

  try {
    return await withLock(target.location, () => applyTargetOnce(driver, target, ctx, conflicts))
  } catch (err) {
    const message = errText(err)
    const event = conflictEvent(target, 'lock-contention', 'aborted', message)
    conflicts.push(event)
    emit(event)
    log(`lock contention on ${target.location}: ${message}`)
    return { result: { targetId: target.id, ok: false, changed: false, message }, backup: null }
  }
}

function applyFail(error: string): ApplyResult {
  return { ok: false, backupId: null, results: [], conflicts: [], error }
}

/**
 * Apply the custom install path to the selected targets. Validates the path,
 * pins it, journals a `BackupRecord`, then mutates each target under a lock.
 * Never throws.
 */
export async function applyInstall(req: ApplyRequest): Promise<ApplyResult> {
  const results: TargetResult[] = []
  const conflicts: ConflictEvent[] = []

  try {
    if (!req || typeof req.installPath !== 'string' || req.installPath.trim() === '') {
      return applyFail('installPath is required.')
    }

    const validation = await validateInstallPath(req.installPath)
    if (!validation.ok || !validation.isClaudeCode) {
      return applyFail(validation.message)
    }

    const real = await safeRealpath(path.resolve(req.installPath))

    // Persist the pinned choice before mutating anything.
    setActiveInstallPath(real)

    const info: InstallInfo = {
      executable: validation.executable,
      version: validation.version
    }
    const ctx = await buildContext(real, {
      prependPath: req.prependPath !== false,
      dryRun: false,
      info
    })

    const requested = Array.isArray(req.targetIds) ? req.targetIds.filter((t) => typeof t === 'string') : []
    const all = await resolveTargets(real)
    const selected = requested.length > 0 ? all.filter((t) => requested.includes(t.id)) : []
    if (selected.length === 0) {
      return applyFail('No valid targets selected.')
    }

    // resolveTargets() runs installStatus() -> detectInstalls(), which must not
    // clobber the pin we just set. Re-assert it defensively so a custom install
    // that auto-detection doesn't discover is still the persisted choice.
    if (getActiveInstallPath() !== real) setActiveInstallPath(real)

    // Journal created BEFORE mutating so a crash mid-apply still leaves a record.
    const record: BackupRecord = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      installPath: real,
      entries: []
    }

    for (const target of selected) {
      const driver = driverFor(target)
      if (!driver) {
        results.push({
          targetId: target.id,
          ok: false,
          changed: false,
          message: `No driver registered for target ${target.id} (${target.kind}).`
        })
        continue
      }
      const outcome = await applyTarget(driver, target, ctx, conflicts)
      results.push(outcome.result)
      if (outcome.backup) record.entries.push(outcome.backup)
    }

    try {
      setBackups([...getBackups(), record])
    } catch (err) {
      log(`failed to persist backup ${record.id}: ${errText(err)}`)
    }

    return { ok: results.every((r) => r.ok), backupId: record.id, results, conflicts }
  } catch (err) {
    const message = errText(err)
    log(`applyInstall failed: ${message}`)
    return { ok: false, backupId: null, results, conflicts, error: message }
  }
}

/* ------------------------------------------------------------------ */
/* Revert                                                              */
/* ------------------------------------------------------------------ */

/**
 * Restore a previously-captured backup: revert each entry through its owning
 * driver (file targets under a lock) and drop the record. Never throws.
 */
export async function revertInstall(backupId: string): Promise<ApplyResult> {
  const results: TargetResult[] = []
  const conflicts: ConflictEvent[] = []

  try {
    if (typeof backupId !== 'string' || backupId === '') {
      return { ok: false, backupId: null, results, conflicts, error: 'backupId is required.' }
    }

    const records = getBackups()
    const record = records.find((r) => r.id === backupId)
    if (!record) {
      return { ok: false, backupId: null, results, conflicts, error: `Backup not found: ${backupId}` }
    }

    for (const entry of record.entries) {
      const driver = driverForTargetId(entry.targetId) ?? driverForKind(entry.kind)
      if (!driver) {
        results.push({
          targetId: entry.targetId,
          ok: false,
          changed: false,
          message: `No driver registered for ${entry.targetId} (${entry.kind}).`
        })
        continue
      }

      try {
        const run = (): Promise<{ ok: boolean; message: string }> => driver.revert(entry)
        const res = isFileKind(entry.kind) ? await withLock(entry.location, run) : await run()
        results.push({
          targetId: entry.targetId,
          ok: res.ok,
          changed: res.ok,
          message: res.message
        })
      } catch (err) {
        const message = errText(err)
        const target = { id: entry.targetId, location: entry.location }
        const event = conflictEvent(target, 'lock-contention', 'aborted', message)
        conflicts.push(event)
        emit(event)
        results.push({ targetId: entry.targetId, ok: false, changed: false, message })
      }
    }

    // Consume the record so it cannot be replayed (marks it reverted).
    try {
      setBackups(records.filter((r) => r.id !== backupId))
    } catch (err) {
      log(`failed to drop backup ${backupId}: ${errText(err)}`)
    }

    return { ok: results.every((r) => r.ok), backupId: null, results, conflicts }
  } catch (err) {
    const message = errText(err)
    log(`revertInstall failed: ${message}`)
    return { ok: false, backupId: null, results, conflicts, error: message }
  }
}
