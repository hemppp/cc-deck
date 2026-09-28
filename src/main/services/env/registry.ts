/**
 * CC Deck — Windows registry PATH driver. FROZEN CONTRACT: ./driver.ts.
 *
 * Implements `MutationDriver` for the two Windows PATH registry targets:
 *   - `registry-user`   -> HKCU\Environment                            (user scope)
 *   - `registry-system` -> HKLM\...\Session Manager\Environment        (system scope)
 *
 * All registry access goes through `reg.exe` invoked with `execFile` (argv, no
 * shell), so spaces/quotes in the value are never interpreted by a shell.
 *
 * Design notes:
 *   - The PATH value is `REG_EXPAND_SZ`: it legitimately contains `%VAR%` tokens
 *     (e.g. `%SystemRoot%\system32`). We never expand them — we split on `;`,
 *     edit entries as opaque strings, and re-join, preserving every token.
 *   - Idempotent: re-applying when `binDir` is already present is a no-op.
 *   - Never crashes the process: every `reg.exe` call is wrapped in try/catch and
 *     every method degrades to an empty/false result off Windows or on failure.
 *     `apply()` is the sole exception — a *write* failure throws (per contract)
 *     so the orchestrator can record `ok:false`.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type {
  BackupEntry,
  ConflictEvent,
  MutationTarget,
  MutationTargetKind
} from '@shared/types'
import type { ApplyOutcome, MutationDriver, TargetContext } from './driver'

const execFileAsync = promisify(execFile)

const IS_WIN = process.platform === 'win32'

/** Target-id prefix / driver id. */
const DRIVER_ID = 'registry'

/** Registry key paths (no quoting — passed as a single argv element). */
const HKCU_ENV = 'HKCU\\Environment'
const HKLM_ENV = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'

/** Registry value name we manage. */
const VALUE_NAME = 'Path'

/** Display truncation for `currentValue`. */
const MAX_PREVIEW = 500

const NOTE_SYSTEM = 'Requires administrator'

/* ------------------------------------------------------------------ */
/* reg.exe plumbing                                                    */
/* ------------------------------------------------------------------ */

interface RegQueryResult {
  /** Raw value data exactly as reg.exe printed it, or null when absent. */
  value: string | null
  /** Registry type token, e.g. `REG_EXPAND_SZ`, when reported. */
  type: string | null
}

/**
 * Run `reg.exe` with argv. Returns stdout on success; throws otherwise.
 * `windowsHide` avoids a flashing console window on Windows.
 */
async function runReg(args: string[], timeout = 5000): Promise<string> {
  const { stdout } = await execFileAsync('reg.exe', args, { timeout, windowsHide: true })
  return stdout
}

/**
 * Parse `reg.exe query "<key>" /v Path` output. Handles both the success shape:
 *
 *     HKEY_CURRENT_USER\Environment
 *         Path    REG_EXPAND_SZ    C:\a;%SystemRoot%\b
 *
 * and the "value not found" shape (exit code 1):
 *
 *     ERROR: The system was unable to find the specified registry key or value.
 *
 * We split on runs of 2+ spaces / tabs, which is how reg.exe aligns columns,
 * and take everything after the type token so spaces inside the value survive.
 */
function parseRegQuery(stdout: string): RegQueryResult {
  const lines = stdout.split(/\r?\n/)
  for (const line of lines) {
    const m = line.match(/^\s{2,}(.+?)\s{2,}(REG_[A-Z_]+)\s{2,}([\s\S]*)$/)
    if (!m) continue
    const name = m[1]
    if (name.toLowerCase() !== VALUE_NAME.toLowerCase()) continue
    return { value: m[3].replace(/\s+$/, ''), type: m[2] }
  }
  return { value: null, type: null }
}

/** Read the current PATH value + type from a registry key (never throws). */
async function readPath(key: string): Promise<RegQueryResult> {
  try {
    const stdout = await runReg(['query', key, '/v', VALUE_NAME])
    return parseRegQuery(stdout)
  } catch {
    // Missing key/value, or reg.exe unavailable — treat as absent.
    return { value: null, type: null }
  }
}

/** Write `REG_EXPAND_SZ` PATH via `reg add`. Throws on failure (e.g. HKLM w/o admin). */
async function writePath(key: string, value: string): Promise<void> {
  await runReg(['add', key, '/v', VALUE_NAME, '/t', 'REG_EXPAND_SZ', '/d', value, '/f'])
}

/** Delete the PATH value via `reg delete`. Throws on failure. */
async function deletePath(key: string): Promise<void> {
  await runReg(['delete', key, '/v', VALUE_NAME, '/f'])
}

/* ------------------------------------------------------------------ */
/* PATH entry helpers                                                  */
/* ------------------------------------------------------------------ */

/** Split a raw PATH into non-empty entries, preserving `%VAR%` tokens verbatim. */
function splitPath(raw: string): string[] {
  return raw.split(';').filter((e) => e.trim() !== '')
}

/** Normalise an entry for comparison: strip quotes, trailing slashes, lowercase. */
function normalizeEntry(entry: string): string {
  let s = entry.trim()
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1)
  s = s.replace(/[\\/]+$/, '')
  return s.toLowerCase()
}

/** Whether a PATH entry equals `dir` (case-insensitive, quote/trailing-slash tolerant). */
function entryMatches(entry: string, dir: string): boolean {
  const a = normalizeEntry(entry)
  const b = normalizeEntry(dir)
  return a !== '' && a === b
}

/** Whether `binDir` (or its parent for a file executable) is present on PATH. */
function pathContainsDir(entries: string[], ctx: TargetContext): boolean {
  if (entries.some((e) => entryMatches(e, ctx.binDir))) return true

  // Also treat the install's executable dir as "applied" (defensive: some
  // installs place the launcher beside a differently-named bin dir).
  if (ctx.executable) {
    const execDir = dirnameLoose(ctx.executable)
    if (execDir && entries.some((e) => entryMatches(e, execDir))) return true
  }
  return false
}

/** Minimal dirname that works for both `\` and `/` separators, no `node:path` needed. */
function dirnameLoose(p: string): string {
  const idx = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  if (idx <= 0) return ''
  return p.slice(0, idx)
}

/**
 * Build the next PATH value: drop empties, remove any existing entry matching
 * `binDir`, then insert at front (prepend) or append at end. `%VAR%` tokens in
 * surviving entries are preserved verbatim.
 */
function buildNextPath(raw: string, ctx: TargetContext): string {
  const entries = splitPath(raw).filter((e) => !entryMatches(e, ctx.binDir))
  if (ctx.prependPath) entries.unshift(ctx.binDir)
  else entries.push(ctx.binDir)
  return entries.join(';')
}

/** Whether `binDir`'s own raw form already appears (used to detect a true no-op). */
function rawContainsBinDir(raw: string, ctx: TargetContext): boolean {
  return splitPath(raw).some((e) => entryMatches(e, ctx.binDir))
}

/* ------------------------------------------------------------------ */
/* WM_SETTINGCHANGE broadcast (best-effort)                            */
/* ------------------------------------------------------------------ */

const PS_BROADCAST = [
  '$sig = \'[DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)]',
  'public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);\'',
  '$t = Add-Type -MemberDefinition $sig -Name Win32 -Namespace CCDeck -PassThru',
  '[void]$t::SendMessageTimeout([IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, "Environment", 2, 5000, [ref]([UIntPtr]::Zero))'
].join('\n')

/**
 * Best-effort broadcast of WM_SETTINGCHANGE so already-open shells/Explorer pick
 * up the new PATH. Runs a tiny inline PowerShell P/Invoke; fully non-fatal.
 */
async function broadcastSettingChange(): Promise<void> {
  try {
    await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', PS_BROADCAST],
      { timeout: 5000, windowsHide: true }
    )
  } catch {
    // Optional; new processes read the registry directly anyway.
  }
}

/* ------------------------------------------------------------------ */
/* Targets                                                             */
/* ------------------------------------------------------------------ */

function makeTarget(kind: MutationTargetKind, id: string, label: string, location: string): MutationTarget {
  const isSystem = kind === 'windows-system-path'
  return {
    id,
    kind,
    label,
    location,
    scope: isSystem ? 'system' : 'user',
    available: IS_WIN,
    writable: !isSystem,
    requiresElevation: isSystem,
    applied: false,
    currentValue: null,
    ...(isSystem ? { note: NOTE_SYSTEM } : {})
  }
}

const USER_TARGET: MutationTarget = makeTarget(
  'windows-user-path',
  `${DRIVER_ID}-user`,
  'User PATH (HKCU\\Environment)',
  HKCU_ENV
)

const SYSTEM_TARGET: MutationTarget = makeTarget(
  'windows-system-path',
  `${DRIVER_ID}-system`,
  'System PATH (HKLM)',
  HKLM_ENV
)

/* ------------------------------------------------------------------ */
/* Driver                                                              */
/* ------------------------------------------------------------------ */

export const registryDriver: MutationDriver = {
  id: DRIVER_ID,
  kind: 'windows-user-path',

  async list(): Promise<MutationTarget[]> {
    if (!IS_WIN) return []

    const out: MutationTarget[] = []
    for (const base of [USER_TARGET, SYSTEM_TARGET]) {
      const { value } = await readPath(base.location)
      out.push({
        ...base,
        // list() has no TargetContext, so it cannot know whether the custom
        // binDir is present — `applied` stays false and isApplied() decides.
        applied: false,
        currentValue:
          value === null ? null : value.length > MAX_PREVIEW ? `${value.slice(0, MAX_PREVIEW)}…` : value
      })
    }
    return out
  },

  async isApplied(target: MutationTarget, ctx: TargetContext): Promise<boolean> {
    if (!IS_WIN) return false
    const { value } = await readPath(target.location)
    if (value === null) return false
    return pathContainsDir(splitPath(value), ctx)
  },

  async apply(target: MutationTarget, ctx: TargetContext): Promise<ApplyOutcome> {
    const backupBase = {
      targetId: target.id,
      kind: target.kind,
      location: target.location
    }

    // Off Windows: no-op, nothing existed, nothing changed.
    if (!IS_WIN) {
      return {
        changed: false,
        newValue: null,
        backup: { ...backupBase, existed: false, previous: null },
        conflicts: []
      }
    }

    const { value: current, type } = await readPath(target.location)
    const existed = current !== null
    const raw = current ?? ''
    const conflicts: ConflictEvent[] = []

    // Detect type drift (we expect REG_EXPAND_SZ). We always rewrite as
    // REG_EXPAND_SZ regardless, but surface the observation as a conflict event.
    if (existed && type && type.toUpperCase() !== 'REG_EXPAND_SZ') {
      conflicts.push({
        targetId: target.id,
        location: target.location,
        detectedAt: new Date().toISOString(),
        kind: 'external-modification',
        resolution: 'merged',
        message: `PATH was ${type}; rewriting as REG_EXPAND_SZ (was this intentional?)`
      })
    }

    // Idempotent no-op: binDir already present, keep the value exactly as-is.
    if (existed && rawContainsBinDir(raw, ctx)) {
      return {
        changed: false,
        newValue: raw,
        backup: { ...backupBase, existed: true, previous: raw },
        conflicts
      }
    }

    const next = buildNextPath(raw, ctx)

    // Same content after a no-op edit (e.g. empty PATH + nothing to add).
    if (existed && next === raw) {
      return {
        changed: false,
        newValue: raw,
        backup: { ...backupBase, existed: true, previous: raw },
        conflicts
      }
    }

    // Dry run: report the intended value without touching the registry.
    if (ctx.dryRun) {
      return {
        changed: true,
        newValue: next,
        backup: { ...backupBase, existed, previous: existed ? raw : null },
        conflicts
      }
    }

    try {
      await writePath(target.location, next)
    } catch (err) {
      // Write failure (e.g. HKLM without elevation) MUST throw so the
      // orchestrator records ok:false for this target.
      const detail = err instanceof Error ? err.message : String(err)
      throw new Error(
        `Failed to write PATH to ${target.location} (${target.id}): ${detail.trim()}`
      )
    }

    // Optional, best-effort: notify running processes of the environment change.
    await broadcastSettingChange()

    return {
      changed: true,
      newValue: next,
      backup: { ...backupBase, existed, previous: existed ? raw : null },
      conflicts
    }
  },

  async revert(entry: BackupEntry): Promise<{ ok: boolean; message: string }> {
    if (!IS_WIN) {
      return { ok: false, message: 'Registry PATH is only available on Windows.' }
    }

    try {
      if (entry.existed) {
        if (entry.previous === null) {
          return { ok: false, message: `No previous value recorded for ${entry.location}.` }
        }
        await writePath(entry.location, entry.previous)
        await broadcastSettingChange()
        return { ok: true, message: `Restored previous PATH in ${entry.location}.` }
      }

      // Nothing existed before us — remove the value we created.
      try {
        await deletePath(entry.location)
        await broadcastSettingChange()
        return { ok: true, message: `Removed PATH value from ${entry.location}.` }
      } catch {
        // Already absent counts as success.
        return { ok: true, message: `PATH value already absent in ${entry.location}.` }
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      return { ok: false, message: `Failed to revert ${entry.location}: ${detail.trim()}` }
    }
  }
}

export default registryDriver
