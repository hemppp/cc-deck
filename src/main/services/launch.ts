/**
 * CC Deck — launch Claude Code.
 *
 * Builds the environment for a Claude Code process (gateway base URL + token +
 * model, via `getActiveEnv()`), resolves the install's launcher, sets the
 * workspace directory as cwd, and either opens a fresh OS terminal
 * (`launchMode: 'external-terminal'`) or spawns in-process (`'in-app'`).
 *
 * Install resolution is per-workspace aware: `opts.installPath ??
 * workspace.installPath ?? active install`. The same resolution feeds both the
 * dry-run `buildLaunchPlan()` / `verifyLaunch()` (so the UI's verification is
 * truthful) and the real `launchClaude()`.
 *
 * `launchClaude` never throws: all failures are returned as
 * `{ ok: false, error }` so the renderer can surface a message instead of an
 * unhandled rejection. `buildLaunchPlan`/`verifyLaunch` do not throw for
 * *invalid* input either — they return a plan/verification with `ok:false`
 * checks — but they may reject on unexpected internal errors.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type {
  ClaudeInstall,
  LaunchOptions,
  LaunchPlan,
  LaunchResult,
  LaunchSession,
  LaunchVerification,
  VerificationCheck,
  Workspace
} from '@shared/types'
import { detectInstalls } from './installs'
import { getActiveEnv, getGatewayState } from './gateway'
import { getSettings } from '../store'
import { listWorkspaces, touchWorkspace } from './workspaces'

/* ------------------------------------------------------------------ */
/* Shell quoting                                                       */
/* ------------------------------------------------------------------ */

/** Windows cmd.exe quoting: wrap in quotes when the token has spaces/quotes. */
function quoteWin(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** POSIX single-quote escaping. */
function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Escape a string for embedding inside an AppleScript double-quoted literal. */
function quoteAppleScript(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/* ------------------------------------------------------------------ */
/* Install resolution                                                  */
/* ------------------------------------------------------------------ */

/** The install `detectInstalls()` flags as active, else the first valid entry. */
function pickActiveInstall(installs: ClaudeInstall[]): ClaudeInstall | undefined {
  return installs.find((i) => i.active && i.valid) ?? installs.find((i) => i.valid) ?? installs.find((i) => i.active)
}

/** Normalise a path for comparison (Windows is case-insensitive). */
function normalisePath(p: string): string {
  const resolved = path.resolve(p)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  return normalisePath(a) === normalisePath(b)
}

/** True when `executable` lives inside the install rooted at `installPath`. */
function executableBelongsTo(executable: string, installPath: string): boolean {
  const exe = normalisePath(executable)
  const root = normalisePath(installPath)
  return exe === root || exe.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
}

interface ResolvedInstall {
  installPath: string | null
  executable: string
  version: string | null
  /** The detected entry the executable came from, when any. */
  matched: ClaudeInstall | undefined
  requestedInstallPath: string | null
}

/**
 * Resolve which install to launch. Precedence:
 *   1. `opts.installPath` (explicit per-call override)
 *   2. `workspace.installPath` (per-workspace pin)
 *   3. the active install from `detectInstalls()`
 * A requested path that detection does not know about is still honoured as the
 * install root (with a best-effort launcher lookup).
 */
async function resolveInstall(
  requested: string | null,
  installs: ClaudeInstall[]
): Promise<ResolvedInstall> {
  let install: ClaudeInstall | undefined
  if (requested) {
    install = installs.find((i) => samePath(i.path, requested) || samePath(i.executable, requested))
    if (!install) {
      // Custom install the detector does not know about: synthesise an entry so
      // we can still resolve a launcher for it.
      const launcher = await launcherFor(requested)
      install = {
        path: requested,
        executable: launcher,
        version: await versionFor(requested),
        source: 'custom',
        active: false,
        valid: await pathExists(requested)
      }
    }
  } else {
    install = pickActiveInstall(installs)
  }

  const executable = install?.executable ?? install?.path ?? (await fallbackExecutable(installs))
  const version = install?.version ?? null
  return {
    installPath: install?.path ?? null,
    executable,
    version,
    matched: install,
    requestedInstallPath: requested
  }
}

/** Look for a launcher inside (or adjacent to) an install root. */
async function launcherFor(root: string): Promise<string | null> {
  const names =
    process.platform === 'win32' ? ['claude.cmd', 'claude.ps1', 'claude.exe', 'claude'] : ['claude']
  for (const name of names) {
    const candidate = path.join(root, name)
    if (await pathExists(candidate)) return candidate
  }
  // npm global layout: <npmRoot>/node_modules/@anthropic-ai/claude-code -> <npmRoot>/claude
  const npmBin = path.join(root, '..', '..', '..', process.platform === 'win32' ? 'claude.cmd' : 'claude')
  if (await pathExists(npmBin)) return npmBin
  return null
}

/** Best-effort version: read `version` from the install root's package.json. */
async function versionFor(root: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(root, 'package.json'), 'utf8')
    const pkg = JSON.parse(raw) as { version?: unknown }
    if (typeof pkg.version === 'string') return pkg.version
  } catch {
    /* no package.json */
  }
  return null
}

/** Last-resort executable when nothing usable was resolved: bare `claude` on PATH. */
async function fallbackExecutable(installs: ClaudeInstall[]): Promise<string> {
  const valid = installs.find((i) => i.valid)
  return valid?.executable ?? valid?.path ?? 'claude'
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/** `fs.access` on an executable. Bare names (no path separator) are "unknown". */
async function executableResolvable(executable: string): Promise<boolean | null> {
  if (!executable) return null
  if (executable === 'claude' || !executable.includes(path.sep)) return null
  return pathExists(executable)
}

/* ------------------------------------------------------------------ */
/* Launch plan                                                         */
/* ------------------------------------------------------------------ */

/**
 * Resolve a would-be launch without executing it. Uses the exact same
 * resolution as `launchClaude`, so the returned plan is truthful. Never throws
 * for invalid input (the plan simply carries `ok:false`-style facts).
 */
export async function buildLaunchPlan(opts: LaunchOptions): Promise<LaunchPlan> {
  const workspaceId = typeof opts?.workspaceId === 'string' ? opts.workspaceId : ''
  const requestedInstallPath =
    typeof opts?.installPath === 'string' && opts.installPath ? opts.installPath : null

  let workspaces: Workspace[] = []
  try {
    workspaces = await listWorkspaces()
  } catch {
    workspaces = []
  }
  const workspace = workspaces.find((w) => w.id === workspaceId)

  const workspacePath = workspace?.path ?? ''
  let workspaceValid = false
  if (workspacePath) {
    try {
      const stat = await fs.stat(workspacePath)
      workspaceValid = stat.isDirectory()
    } catch {
      workspaceValid = false
    }
  }

  // Effective install: explicit override -> workspace pin -> active install.
  const effectiveRequested = requestedInstallPath ?? (workspace?.installPath ?? null)
  let installs: ClaudeInstall[] = []
  try {
    installs = await detectInstalls()
  } catch {
    installs = []
  }
  const resolved = await resolveInstall(effectiveRequested, installs)

  const executableExists = await executableResolvable(resolved.executable)

  // installMatches: does the resolved executable/root equal what was requested
  // (or, when nothing was requested, the detected active install)?
  let installMatches: boolean
  if (resolved.requestedInstallPath) {
    installMatches =
      samePath(resolved.installPath, resolved.requestedInstallPath) ||
      executableBelongsTo(resolved.executable, resolved.requestedInstallPath)
  } else {
    const active = pickActiveInstall(installs)
    installMatches =
      !!active &&
      (samePath(resolved.installPath, active.path) || samePath(resolved.executable, active.executable))
  }

  // Gateway-derived env: base URL, token, model. Empty when stopped.
  let gatewayEnv: Record<string, string> = {}
  try {
    gatewayEnv = getActiveEnv() ?? {}
  } catch {
    gatewayEnv = {}
  }
  const gatewayState = getGatewayState()

  // Env that will be injected (auth token masked for display).
  const planEnv: Record<string, string> = {}
  for (const [k, v] of Object.entries(gatewayEnv)) planEnv[k] = v
  for (const [k, v] of Object.entries(opts?.env ?? {})) planEnv[k] = v
  if (planEnv.ANTHROPIC_AUTH_TOKEN) planEnv.ANTHROPIC_AUTH_TOKEN = '***'

  const args = Array.isArray(opts?.extraArgs) ? opts.extraArgs.filter((a) => typeof a === 'string') : []

  return {
    workspaceId,
    workspaceName: workspace?.name ?? '',
    workspacePath,
    workspaceValid,
    installPath: resolved.installPath,
    executable: resolved.executable,
    executableExists: executableExists ?? false,
    version: resolved.version,
    requestedInstallPath: resolved.requestedInstallPath,
    installMatches,
    model: gatewayEnv.ANTHROPIC_MODEL ?? null,
    gatewayBaseUrl: gatewayState.baseUrl,
    gatewayRunning: gatewayState.status === 'running',
    launchMode: getSettings().launchMode,
    args,
    env: planEnv
  }
}

/* ------------------------------------------------------------------ */
/* Verification                                                        */
/* ------------------------------------------------------------------ */

/**
 * Dry-run verification: build the plan and assert the workspace/install binding
 * actually resolves. `ok` is true when every non-informational check passes.
 */
export async function verifyLaunch(opts: LaunchOptions): Promise<LaunchVerification> {
  const plan = await buildLaunchPlan(opts)
  const checks: VerificationCheck[] = []

  checks.push({
    id: 'workspace-exists',
    label: 'Workspace directory exists',
    ok: plan.workspaceValid,
    detail: plan.workspacePath
      ? plan.workspaceValid
        ? plan.workspacePath
        : `Not found or not a directory: ${plan.workspacePath}`
      : `Unknown workspace: ${plan.workspaceId || '(none)'}`
  })

  checks.push({
    id: 'workspace-is-dir',
    label: 'Workspace path is a directory',
    ok: plan.workspaceValid,
    detail: plan.workspaceValid ? plan.workspacePath : 'Workspace path is not a directory'
  })

  checks.push({
    id: 'install-selected',
    label: 'A Claude Code install is selected',
    ok: !!plan.installPath,
    detail: plan.installPath ?? 'No install resolved (nothing pinned and none detected)'
  })

  checks.push({
    id: 'install-version',
    label: 'Install version is known',
    ok: !!plan.version,
    detail: plan.version ?? 'Version could not be determined for the chosen install'
  })

  // fs.access on the executable. A bare `claude` (no path separator) is resolved
  // via PATH, which we cannot check here — treat it as pass-by-default.
  const executableExists = await executableResolvable(plan.executable)
  checks.push({
    id: 'executable-exists',
    label: 'Launcher executable exists',
    ok: executableExists !== false,
    detail:
      executableExists === null
        ? `${plan.executable} (resolved via PATH; not checked)`
        : executableExists
          ? plan.executable
          : `Executable not found: ${plan.executable}`
  })

  checks.push({
    id: 'install-matches',
    label: 'Launched install matches the selection',
    ok: plan.installMatches,
    detail: plan.installMatches
      ? `Using ${plan.executable}${plan.installPath ? ` from ${plan.installPath}` : ''}`
      : plan.requestedInstallPath
        ? `Requested ${plan.requestedInstallPath} but resolved ${plan.executable}`
        : 'Resolved executable does not match the active install'
  })

  checks.push({
    id: 'model-configured',
    label: 'A model is configured',
    ok: !!plan.model || !plan.gatewayRunning,
    detail: plan.model
      ? `ANTHROPIC_MODEL=${plan.model}`
      : plan.gatewayRunning
        ? 'Gateway is running but no model is routed'
        : 'No gateway model needed (gateway stopped)'
  })

  checks.push({
    id: 'gateway-state',
    label: 'Gateway state',
    ok: true,
    detail: plan.gatewayRunning
      ? `running at ${plan.gatewayBaseUrl ?? '(no base URL)'}`
      : 'stopped'
  })

  const failed = checks.filter((c) => !c.ok && c.id !== 'gateway-state')
  const ok = failed.length === 0
  const message = ok
    ? `Launch verified: ${plan.executable}${plan.version ? ` (v${plan.version})` : ''} in ${plan.workspacePath || plan.workspaceName}`
    : `Verification failed: ${failed.map((c) => c.label).join(', ')}`

  return { ok, plan, checks, message }
}

/* ------------------------------------------------------------------ */
/* Launch strategies                                                   */
/* ------------------------------------------------------------------ */

interface SpawnTarget {
  file: string
  args: string[]
  windowsVerbatimArguments?: boolean
}

/**
 * Resolve the actual process to spawn for an in-app launch.
 *
 * On Windows, `spawn()` cannot execute `.cmd`/`.bat` shims directly (Node throws
 * `EINVAL`) and `.ps1` scripts are not executables at all. An npm-global Claude
 * Code install is exactly a `claude.cmd` shim, so we route those through the
 * command interpreter. The wrapper's exit code mirrors the real process, so the
 * session exit wiring is unaffected.
 */
function resolveInAppSpawn(exe: string, args: string[]): SpawnTarget {
  if (process.platform === 'win32') {
    const lower = exe.toLowerCase()
    if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
      const comspec = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe'
      // cmd.exe /c with a single (whole-command-line) string; the outer quotes are
      // consumed by /s and the inner command (exe + args) is quoted for spaces.
      const inner = [exe, ...args].map(quoteWin).join(' ')
      return { file: comspec, args: ['/d', '/s', '/c', `"${inner}"`], windowsVerbatimArguments: true }
    }
    if (lower.endsWith('.ps1')) {
      return {
        file: 'powershell.exe',
        args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', exe, ...args]
      }
    }
  }
  return { file: exe, args }
}

function spawnInApp(
  exe: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  onExit: (code: number | null) => void
): ChildProcess {
  const target = resolveInAppSpawn(exe, args)
  const child = spawn(target.file, target.args, {
    cwd,
    env,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
    ...(target.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {})
  })

  // The frozen IPC contract has no launch-output channel, so relay the child's
  // stdout/stderr to the main-process console rather than dropping it. (Adding a
  // streaming channel would require a shared/types.ts change owned by the lead.)
  const relay = (stream: NodeJS.ReadableStream, tag: string): void => {
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => process.stdout.write(`[claude:${tag}] ${chunk}`))
  }
  if (child.stdout) relay(child.stdout, 'out')
  if (child.stderr) relay(child.stderr, 'err')
  child.on('error', (err) => console.error('[claude] failed to start:', err.message))

  // 'exit' and 'close' both fire; report the exit exactly once.
  let reported = false
  const fire = (code: number | null): void => {
    if (reported) return
    reported = true
    onExit(code)
  }
  child.on('exit', fire)
  child.on('close', fire)

  return child
}

function launchExternalTerminal(
  exe: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv
): number | undefined {
  if (process.platform === 'win32') {
    // `start "" cmd /k <cmd>` keeps the console open after Claude exits.
    const cmd = [exe, ...args].map(quoteWin).join(' ')
    const child = spawn('cmd.exe', ['/c', 'start', '', 'cmd', '/k', cmd], {
      cwd,
      env,
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    })
    child.unref()
    return child.pid
  }

  const posixCmd = [exe, ...args].map(quotePosix).join(' ')
  const script = `cd ${quotePosix(cwd)} && exec ${posixCmd}`

  if (process.platform === 'darwin') {
    // AppleScript asks Terminal to run the command in a new window.
    const osa = `tell application "Terminal" to do script "${quoteAppleScript(script)}"`
    const activate = 'tell application "Terminal" to activate'
    const child = spawn('osascript', ['-e', osa, '-e', activate], {
      env,
      detached: true,
      stdio: 'ignore'
    })
    child.unref()
    return child.pid
  }

  // Linux: try a handful of common terminal emulators.
  const candidates: Array<{ bin: string; args: string[] }> = [
    { bin: 'x-terminal-emulator', args: ['-e', 'bash', '-lc', script] },
    { bin: 'gnome-terminal', args: ['--', 'bash', '-lc', script] },
    { bin: 'konsole', args: ['-e', 'bash', '-lc', script] },
    { bin: 'xfce4-terminal', args: ['-e', `bash -lc ${JSON.stringify(script)}`] },
    { bin: 'xterm', args: ['-e', 'bash', '-lc', script] }
  ]
  for (const c of candidates) {
    try {
      const child = spawn(c.bin, c.args, { cwd, env, detached: true, stdio: 'ignore' })
      child.unref()
      return child.pid
    } catch {
      /* try next emulator */
    }
  }
  throw new Error('No supported terminal emulator found (tried x-terminal-emulator, gnome-terminal, konsole, xfce4-terminal, xterm)')
}

/* ------------------------------------------------------------------ */
/* Session tracking                                                    */
/* ------------------------------------------------------------------ */

const MAX_SESSIONS = 50
/** Newest-first ring of tracked launch sessions. */
const sessions: LaunchSession[] = []
type SessionListener = (session: LaunchSession) => void
const sessionListeners = new Set<SessionListener>()

function emitSession(session: LaunchSession): void {
  for (const cb of sessionListeners) {
    try {
      cb({ ...session })
    } catch (err) {
      console.error('[launch] session listener threw:', err)
    }
  }
}

function recordSession(session: LaunchSession): void {
  sessions.unshift(session)
  if (sessions.length > MAX_SESSIONS) sessions.length = MAX_SESSIONS
  emitSession(session)
}

/** Mark a session exited (idempotent) and notify subscribers. */
function markExited(id: string): void {
  const session = sessions.find((s) => s.id === id)
  if (!session || session.status === 'exited') return
  session.status = 'exited'
  emitSession(session)
}

/** Tracked launch sessions, newest first. */
export function getSessions(): LaunchSession[] {
  return sessions.map((s) => ({ ...s }))
}

/**
 * Subscribe to session start/exit events. Returns an unsubscribe function.
 * Unlike `onGatewayState`, the callback is not invoked on subscribe.
 */
export function onLaunchSession(cb: (s: LaunchSession) => void): () => void {
  sessionListeners.add(cb)
  return () => {
    sessionListeners.delete(cb)
  }
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

/** Launch Claude Code for a workspace. Never throws. */
export async function launchClaude(opts: LaunchOptions): Promise<LaunchResult> {
  const env: Record<string, string> = {}
  try {
    const workspaceId = typeof opts?.workspaceId === 'string' ? opts.workspaceId : ''
    if (!workspaceId) return { ok: false, env, error: 'workspaceId is required' }

    const workspaces = await listWorkspaces()
    const workspace = workspaces.find((w) => w.id === workspaceId)
    if (!workspace) return { ok: false, env, error: `Workspace not found: ${workspaceId}` }

    // Ensure the workspace directory still exists before we spawn anything.
    try {
      const stat = await fs.stat(workspace.path)
      if (!stat.isDirectory()) return { ok: false, env, error: `Not a directory: ${workspace.path}` }
    } catch {
      return { ok: false, env, error: `Workspace directory missing: ${workspace.path}` }
    }

    // The plan is the single source of truth for install + env resolution.
    const plan = await buildLaunchPlan(opts)

    // Gateway-injected Anthropic env (base URL / auth token / model). May be
    // empty when the gateway is stopped — that's fine, Claude falls back.
    let gatewayEnv: Record<string, string> = {}
    try {
      gatewayEnv = getActiveEnv() ?? {}
    } catch {
      gatewayEnv = {}
    }

    const merged: NodeJS.ProcessEnv = {
      ...process.env,
      ...gatewayEnv,
      ...(opts.env ?? {})
    }
    // Mirror into the return payload (gateway token included so the UI can show
    // what was injected; it is not a secret the user doesn't own).
    for (const [k, v] of Object.entries(gatewayEnv)) env[k] = v
    for (const [k, v] of Object.entries(opts.env ?? {})) env[k] = v

    const exe = plan.executable
    const args = plan.args
    const mode = plan.launchMode

    // Post-launch verification (same checks the dry-run produces).
    const verification = await verifyLaunch(opts)
    const session: LaunchSession = {
      id: randomUUID(),
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspacePath: workspace.path,
      installPath: plan.installPath,
      executable: exe,
      version: plan.version,
      pid: null,
      launchMode: mode,
      startedAt: new Date().toISOString(),
      status: 'running'
    }

    let pid: number | undefined
    if (mode === 'in-app') {
      const child = spawnInApp(exe, args, workspace.path, merged, (code) => {
        markExited(session.id)
        console.log(`[launch] session ${session.id} exited${code === null ? '' : ` (code ${code})`}`)
      })
      pid = child.pid ?? undefined
    } else {
      pid = launchExternalTerminal(exe, args, workspace.path, merged)
    }

    session.pid = pid ?? null
    recordSession(session)

    void touchWorkspace(workspace.id)

    return {
      ok: true,
      env,
      pid,
      installPath: plan.installPath,
      executable: exe,
      version: plan.version,
      workspacePath: workspace.path,
      sessionId: session.id,
      checks: verification.checks
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, env, error: message }
  }
}
