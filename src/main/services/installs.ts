/**
 * CC Deck — Claude Code installation discovery.
 *
 * Best-effort, never-throwing detection of Claude Code installs across
 * platforms. We probe several well-known locations (npm global roots, local
 * bin dirs, native installs, PATH) and normalise each hit into a `ClaudeInstall`.
 */
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { dialog } from 'electron'
import type { ClaudeInstall } from '@shared/types'
import { getActiveInstallPath, setActiveInstallPath } from '../store'

const execFileAsync = promisify(execFile)
const IS_WIN = process.platform === 'win32'
const IS_MAC = process.platform === 'darwin'
const PACKAGE_SEGMENT = path.join('@anthropic-ai', 'claude-code')

/* ------------------------------------------------------------------ */
/* Active-install change notifications                                 */
/* ------------------------------------------------------------------ */

type ActiveInstallListener = (path: string | null) => void

const activeInstallListeners = new Set<ActiveInstallListener>()

/**
 * Subscribe to global active-install changes. Returns an unsubscribe fn.
 * Listeners are invoked whenever the pinned install path changes (e.g. via
 * `selectInstall` or `setActiveInstall`).
 */
export function onActiveInstallChange(cb: ActiveInstallListener): () => void {
  activeInstallListeners.add(cb)
  return () => {
    activeInstallListeners.delete(cb)
  }
}

/** Notify listeners that the active install path changed. Never throws. */
function emitActiveInstallChange(path: string | null): void {
  for (const listener of [...activeInstallListeners]) {
    try {
      listener(path)
    } catch {
      /* a misbehaving listener must not break install selection */
    }
  }
}

/**
 * Pin the active install path and notify subscribers. Thin wrapper around the
 * store setter that also emits an `onActiveInstallChange` event.
 */
export function setActiveInstall(path: string | null): string | null {
  const next = setActiveInstallPath(path)
  emitActiveInstallChange(next)
  return next
}

/** Run a command, resolving to stdout or null on any failure/timeout. */
async function tryExec(cmd: string, args: string[], timeout = 3000): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout, windowsHide: true })
    return stdout.trim()
  } catch {
    // On Windows, bare names and .cmd/.bat shims (npm, claude.cmd) can only be
    // launched through cmd.exe; execFile cannot exec them directly.
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

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/** realpath when possible (dedupe/symlink resolution), else the original path. */
async function safeRealpath(p: string): Promise<string> {
  try {
    return await fs.realpath(p)
  } catch {
    return p
  }
}

/** Read `version` from a package.json directly inside `dir`, or null. */
async function readPkgVersion(dir: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(dir, 'package.json'), 'utf8')
    const pkg = JSON.parse(raw) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : null
  } catch {
    return null
  }
}

/**
 * Candidate install roots: directories that (should) contain the
 * `@anthropic-ai/claude-code` package.
 */
async function candidateRoots(): Promise<string[]> {
  const roots: string[] = []

  // 1. npm global root (authoritative when npm is on PATH).
  const npmRoot = await tryExec('npm', ['root', '-g'], 5000)
  if (npmRoot) roots.push(path.join(npmRoot, PACKAGE_SEGMENT))

  // 2. Well-known global node_modules locations.
  if (IS_WIN) {
    const appData = process.env['APPDATA']
    if (appData) roots.push(path.join(appData, 'npm', 'node_modules', PACKAGE_SEGMENT))
  } else {
    roots.push(path.join('/usr/local/lib/node_modules', PACKAGE_SEGMENT))
    roots.push(path.join('/usr/lib/node_modules', PACKAGE_SEGMENT))
    roots.push(path.join(homedir(), '.npm-global', 'lib', 'node_modules', PACKAGE_SEGMENT))
  }

  // 3. nvm-managed node versions (one level of globbing).
  const nvmBase = path.join(homedir(), '.nvm', 'versions', 'node')
  try {
    const versions = await fs.readdir(nvmBase)
    for (const v of versions) {
      roots.push(path.join(nvmBase, v, 'lib', 'node_modules', PACKAGE_SEGMENT))
    }
  } catch {
    /* nvm not installed */
  }

  // 4. Native / standalone installs.
  roots.push(path.join(homedir(), '.claude', 'local'))
  roots.push(path.join(homedir(), '.local', 'share', 'claude'))

  return roots
}

/** Candidate launcher (bin) paths for Claude Code. */
function candidateBins(): string[] {
  const bins: string[] = []
  if (IS_WIN) {
    const appData = process.env['APPDATA']
    if (appData) {
      const npmDir = path.join(appData, 'npm')
      bins.push(path.join(npmDir, 'claude.cmd'), path.join(npmDir, 'claude.ps1'), path.join(npmDir, 'claude'))
    }
  } else {
    bins.push(path.join(homedir(), '.local', 'bin', 'claude'))
    bins.push('/usr/local/bin/claude')
    if (IS_MAC) bins.push('/opt/homebrew/bin/claude')
  }
  return bins
}

/** Find a launcher inside an install root (npm layout: sibling bin or local bin). */
async function launcherForRoot(root: string): Promise<string | null> {
  const localCandidates = IS_WIN
    ? ['claude.cmd', 'claude.ps1', 'claude']
    : ['claude']
  for (const name of localCandidates) {
    const local = path.join(root, name)
    if (await pathExists(local)) return local
  }
  // npm global layout: <npmRoot>/node_modules/@anthropic-ai/claude-code -> <npmRoot>/claude
  const npmBin = path.join(root, '..', '..', '..', IS_WIN ? 'claude.cmd' : 'claude')
  if (await pathExists(npmBin)) return npmBin
  return null
}

/** Resolve a launcher via PATH (`where` on Windows, `which` elsewhere). */
async function whichClaude(): Promise<string | null> {
  const out = await tryExec(IS_WIN ? 'where' : 'which', ['claude'], 3000)
  if (!out) return null
  return out.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? null
}

interface RawEntry {
  path: string
  executable: string | null
  source: ClaudeInstall['source']
}

/** Build a fully-populated ClaudeInstall from a raw candidate. */
async function buildInstall(raw: RawEntry): Promise<ClaudeInstall> {
  const real = await safeRealpath(raw.path)
  const valid = await pathExists(real)

  let version = await readPkgVersion(real)
  if (!version && raw.executable) {
    const out = await tryExec(raw.executable, ['--version'], 3000)
    // e.g. "1.0.44 (Claude Code)" -> take the first token.
    if (out) version = out.split(/\s+/)[0] ?? null
  }

  let executable = raw.executable
  if (!executable && valid) executable = await launcherForRoot(real)

  return { path: real, executable, version, source: raw.source, active: false, valid }
}

/** Gather all candidates (roots + bins + PATH), then normalise + dedupe. */
async function collectCandidates(): Promise<ClaudeInstall[]> {
  const raws: RawEntry[] = []

  for (const root of await candidateRoots()) {
    if (await pathExists(root)) raws.push({ path: root, executable: null, source: 'npm-global' })
  }

  for (const bin of candidateBins()) {
    if (await pathExists(bin)) raws.push({ path: bin, executable: bin, source: 'local-bin' })
  }

  const fromPath = await whichClaude()
  if (fromPath) {
    // Prefer the package root so we can read its version; fall back to the bin.
    const root = path.join(path.dirname(fromPath), 'node_modules', PACKAGE_SEGMENT)
    if (await pathExists(root)) raws.push({ path: root, executable: fromPath, source: 'path' })
    else raws.push({ path: fromPath, executable: fromPath, source: 'path' })
  }

  const built = await Promise.all(raws.map(buildInstall))

  // Dedupe by realpath, preferring valid entries and richer versions.
  const byPath = new Map<string, ClaudeInstall>()
  for (const inst of built) {
    const key = inst.path
    const existing = byPath.get(key)
    if (!existing) {
      byPath.set(key, inst)
    } else if (inst.valid && !existing.valid) {
      byPath.set(key, inst)
    } else if (!existing.version && inst.version) {
      byPath.set(key, { ...existing, version: inst.version })
    }
  }
  return [...byPath.values()]
}

/** Detect all installs and flag the active one (stored path, else first valid). */
export async function detectInstalls(): Promise<ClaudeInstall[]> {
  const installs = await collectCandidates()
  const stored = getActiveInstallPath()

  let activePath: string | null
  if (stored) {
    // Respect an explicitly pinned path (including a custom install that our
    // auto-detection does not know about). Never clobber the user's choice.
    activePath = stored
  } else {
    activePath = installs.find((i) => i.valid)?.path ?? installs[0]?.path ?? null
    if (activePath) setActiveInstallPath(activePath)
  }

  return installs.map((i) => ({ ...i, active: i.path === activePath }))
}

/** Pin a specific install root as active and return the refreshed list. */
export async function selectInstall(installPath: string): Promise<ClaudeInstall[]> {
  if (typeof installPath !== 'string' || !installPath) {
    throw new Error('selectInstall: path is required')
  }
  const real = await safeRealpath(installPath)
  setActiveInstall(real)
  return detectInstalls()
}

/** Open a native directory picker; returns the chosen path or null. */
export async function pickInstallDir(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    title: 'Select Claude Code install directory',
    properties: ['openDirectory']
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0] ?? null
}
