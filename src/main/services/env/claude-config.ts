/**
 * CC Deck — Claude Code settings.json mutation driver. FROZEN CONTRACT: `./driver`.
 *
 * Manages the custom install path inside `~/.claude/settings.json` (or
 * `$CLAUDE_CONFIG_DIR/settings.json`). We only touch the top-level `env.PATH`
 * value and preserve every other key and its order. The file is parsed as JSON
 * with a strict failure mode: if it exists but is not valid JSON we refuse to
 * write, so we never clobber a user's config.
 */
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { BackupEntry, MutationTarget } from '@shared/types'
import type { ApplyOutcome, MutationDriver, TargetContext } from './driver'
import { atomicWriteFile, snapshot } from './fs-lock'

const ID = 'claude-settings'
const PREVIEW_MAX = 400
const IS_WIN = process.platform === 'win32'
const PATH_SEP = IS_WIN ? ';' : ':'

function settingsFile(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude')
  return path.join(dir, 'settings.json')
}

function preview(content: string | null): string | null {
  if (content == null) return null
  return content.length > PREVIEW_MAX ? `${content.slice(0, PREVIEW_MAX)}…` : content
}

function targetFor(file: string, currentValue: string | null): MutationTarget {
  return {
    id: `${ID}:${file}`,
    kind: 'claude-settings',
    label: 'Claude Code — settings.json',
    location: file,
    scope: 'user',
    available: true,
    writable: true,
    requiresElevation: false,
    applied: false,
    currentValue: preview(currentValue)
  }
}

function backupFor(target: MutationTarget, existed: boolean, previous: string | null): BackupEntry {
  return { targetId: target.id, kind: target.kind, location: target.location, existed, previous }
}

/** Parse settings JSON. Empty/whitespace => {}. Invalid but present => throw. */
function parseSettings(raw: string | null, existed: boolean): Record<string, unknown> {
  if (!existed || raw == null || raw.trim() === '') return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('settings.json is not a JSON object')
    }
    return parsed as Record<string, unknown>
  } catch (err) {
    throw new Error(
      `Refusing to modify ${settingsFile()}: existing file is not valid JSON (${(err as Error).message})`
    )
  }
}

/** Comparison key for a PATH entry (case-insensitive on Windows). */
function pathKey(entry: string): string {
  return IS_WIN ? entry.toLowerCase() : entry
}

/** Split a PATH string into entries, dropping empties and duplicates (first wins). */
function splitPath(value: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of value.split(PATH_SEP)) {
    if (p === '') continue
    const key = pathKey(p)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(p)
  }
  return out
}

/**
 * Compute the desired `env.PATH` value: dedupe entries, drop any existing
 * occurrence of `binDir`, then prepend/append it. Uses the platform separator.
 */
function desiredPath(current: string, binDir: string, prepend: boolean): string {
  const key = pathKey(binDir)
  const rest = splitPath(current).filter((p) => pathKey(p) !== key)
  return (prepend ? [binDir, ...rest] : [...rest, binDir]).join(PATH_SEP)
}

function serialize(obj: Record<string, unknown>): string {
  return `${JSON.stringify(obj, null, 2)}\n`
}

export const claudeConfigDriver: MutationDriver = {
  id: ID,
  kind: 'claude-settings',

  async list(): Promise<MutationTarget[]> {
    const file = settingsFile()
    const snap = await snapshot(file)
    return [targetFor(file, snap.exists ? snap.content : null)]
  },

  async isApplied(target: MutationTarget, ctx: TargetContext): Promise<boolean> {
    const snap = await snapshot(target.location)
    if (!snap.exists || snap.content == null || snap.content.trim() === '') return false
    let parsed: Record<string, unknown>
    try {
      const raw = JSON.parse(snap.content) as unknown
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false
      parsed = raw as Record<string, unknown>
    } catch {
      return false
    }
    const env = parsed.env
    if (env === null || typeof env !== 'object' || Array.isArray(env)) return false
    const p = (env as Record<string, unknown>).PATH
    if (typeof p !== 'string') return false
    return splitPath(p).includes(ctx.binDir)
  },

  async apply(target: MutationTarget, ctx: TargetContext): Promise<ApplyOutcome> {
    const snap = await snapshot(target.location)
    const existed = snap.exists
    const previous = existed ? snap.content : null
    const backup = backupFor(target, existed, previous)

    const settings = parseSettings(previous, existed)
    const envRaw = settings.env
    const env: Record<string, unknown> =
      envRaw !== null && typeof envRaw === 'object' && !Array.isArray(envRaw)
        ? { ...(envRaw as Record<string, unknown>) }
        : {}
    const currentPath = typeof env.PATH === 'string' ? env.PATH : ''

    const nextPath = desiredPath(currentPath, ctx.binDir, ctx.prependPath)
    if (currentPath === nextPath) {
      return { changed: false, newValue: previous, backup, conflicts: [] }
    }

    env.PATH = nextPath
    settings.env = env
    const content = serialize(settings)

    if (ctx.dryRun) {
      return { changed: true, newValue: content, backup, conflicts: [] }
    }

    await atomicWriteFile(target.location, content)
    return { changed: true, newValue: content, backup, conflicts: [] }
  },

  async revert(entry: BackupEntry): Promise<{ ok: boolean; message: string }> {
    if (entry.existed) {
      await atomicWriteFile(entry.location, entry.previous ?? '')
      return { ok: true, message: `Restored ${entry.location}` }
    }

    // We created the file. If it is now empty (`{}`) remove it; otherwise leave
    // the user's additions in place.
    const snap = await snapshot(entry.location)
    if (!snap.exists) {
      return { ok: true, message: `Nothing to revert at ${entry.location}` }
    }
    const content = (snap.content ?? '').trim()
    if (content === '' || content === '{}') {
      await fs.unlink(entry.location)
      return { ok: true, message: `Removed file created by CC Deck: ${entry.location}` }
    }
    return { ok: true, message: `Left ${entry.location} intact (contains user data)` }
  }
}
