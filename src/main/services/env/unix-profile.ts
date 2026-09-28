/**
 * CC Deck — Unix shell-profile mutation driver. FROZEN CONTRACT: `./driver`.
 *
 * Manages the custom Claude Code install path inside the user's shell rc files
 * (~/.zshrc, ~/.bashrc, ~/.profile, fish config). The change is confined to a
 * clearly-delimited, idempotent marker block so every byte outside the block is
 * preserved exactly.
 *
 *   # >>> cc-deck path >>>
 *   export PATH="<binDir>:$PATH"      # prepend (or "$PATH:<binDir>" append)
 *   # <<< cc-deck path <<<
 *
 * Fish uses `set -gx PATH <binDir> $PATH` instead of the `export` form.
 */
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { BackupEntry, MutationTarget } from '@shared/types'
import type { ApplyOutcome, MutationDriver, TargetContext } from './driver'
import { atomicWriteFile, snapshot } from './fs-lock'

const ID = 'unix-shell-profile'
const IS_WIN = process.platform === 'win32'
const PREVIEW_MAX = 400

const BEGIN_MARKER = '# >>> cc-deck path >>>'
const END_MARKER = '# <<< cc-deck path <<<'

interface Candidate {
  file: string
  fish: boolean
  label: string
}

function shellCandidates(): Candidate[] {
  const home = os.homedir()
  return [
    { file: path.join(home, '.zshrc'), fish: false, label: 'Zsh — ~/.zshrc' },
    { file: path.join(home, '.bashrc'), fish: false, label: 'Bash — ~/.bashrc' },
    { file: path.join(home, '.profile'), fish: false, label: 'POSIX shell — ~/.profile' },
    {
      file: path.join(home, '.config', 'fish', 'config.fish'),
      fish: true,
      label: 'Fish — ~/.config/fish/config.fish'
    }
  ]
}

function isFishFile(file: string): boolean {
  return path.basename(file) === 'config.fish'
}

/** Matches the full managed block (markers inclusive), never the trailing newline. */
function markerBlockRegex(): RegExp {
  return /^[ \t]*# >>> cc-deck path >>>[ \t]*\r?\n[\s\S]*?^[ \t]*# <<< cc-deck path <<<[ \t]*\r?$/m
}

function pathLine(binDir: string, prepend: boolean, fish: boolean): string {
  if (fish) {
    return prepend ? `set -gx PATH ${binDir} $PATH` : `set -gx PATH $PATH ${binDir}`
  }
  return prepend ? `export PATH="${binDir}:$PATH"` : `export PATH="$PATH:${binDir}"`
}

function buildBlock(binDir: string, prepend: boolean, fish: boolean): string {
  return `${BEGIN_MARKER}\n${pathLine(binDir, prepend, fish)}\n${END_MARKER}`
}

function preview(content: string | null): string | null {
  if (content == null) return null
  return content.length > PREVIEW_MAX ? `${content.slice(0, PREVIEW_MAX)}…` : content
}

function targetFor(c: Candidate, currentValue: string | null, note?: string): MutationTarget {
  return {
    id: `${ID}:${c.file}`,
    kind: 'unix-shell-profile',
    label: c.label,
    location: c.file,
    scope: 'user',
    available: true,
    writable: true,
    requiresElevation: false,
    applied: false, // list() has no context; isApplied() decides
    currentValue: preview(currentValue),
    ...(note ? { note } : {})
  }
}

function backupFor(target: MutationTarget, existed: boolean, previous: string | null): BackupEntry {
  return { targetId: target.id, kind: target.kind, location: target.location, existed, previous }
}

/**
 * Compute the new file content for `apply`. Returns the content and whether the
 * managed block already matched the desired state exactly.
 */
function computeContent(
  existing: string,
  block: string
): { content: string; unchanged: boolean } {
  const match = markerBlockRegex().exec(existing)
  if (match) {
    if (match[0] === block) return { content: existing, unchanged: true }
    const content =
      existing.slice(0, match.index) + block + existing.slice(match.index + match[0].length)
    return { content, unchanged: content === existing }
  }
  // Append with a single separating newline (no leading blank line in a new file).
  const content = existing.length === 0 ? `${block}\n` : `${existing}${existing.endsWith('\n') ? '' : '\n'}${block}\n`
  return { content, unchanged: false }
}

export const unixProfileDriver: MutationDriver = {
  id: ID,
  kind: 'unix-shell-profile',

  async list(): Promise<MutationTarget[]> {
    if (IS_WIN) return []

    const targets: MutationTarget[] = []
    let anyExists = false
    for (const c of shellCandidates()) {
      const snap = await snapshot(c.file)
      if (snap.exists) {
        anyExists = true
        targets.push(targetFor(c, snap.content))
      }
    }
    if (!anyExists) {
      const profile = shellCandidates().find((c) => c.file.endsWith(`${path.sep}.profile`))
      if (profile) targets.push(targetFor(profile, null, 'will be created'))
    }
    return targets
  },

  async isApplied(target: MutationTarget, ctx: TargetContext): Promise<boolean> {
    const snap = await snapshot(target.location)
    if (!snap.exists || snap.content == null) return false
    const match = markerBlockRegex().exec(snap.content)
    return match != null && match[0].includes(ctx.binDir)
  },

  async apply(target: MutationTarget, ctx: TargetContext): Promise<ApplyOutcome> {
    const fish = isFishFile(target.location)
    const block = buildBlock(ctx.binDir, ctx.prependPath, fish)

    const snap = await snapshot(target.location)
    const existed = snap.exists
    const previous = existed ? snap.content : null
    const existing = previous ?? ''

    const { content, unchanged } = computeContent(existing, block)
    const backup = backupFor(target, existed, previous)

    if (unchanged) {
      return { changed: false, newValue: existing, backup, conflicts: [] }
    }
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

    // The file did not exist before we touched it. Only remove it if it now
    // contains nothing but our managed block; otherwise strip just the block.
    const snap = await snapshot(entry.location)
    if (!snap.exists) {
      return { ok: true, message: `Nothing to revert at ${entry.location}` }
    }
    const content = snap.content ?? ''
    const stripped = content.replace(markerBlockRegex(), '')
    if (stripped.trim() === '') {
      await fs.unlink(entry.location)
      return { ok: true, message: `Removed file created by CC Deck: ${entry.location}` }
    }
    await atomicWriteFile(entry.location, stripped)
    return { ok: true, message: `Removed cc-deck block from ${entry.location}` }
  }
}
