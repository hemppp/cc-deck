/**
 * CC Deck — concurrency primitives for install-path mutation. FROZEN.
 *
 * Provides three guarantees needed to safely edit shared, externally-owned
 * resources (PATH in the registry, shell rc files, ~/.claude/settings.json):
 *
 *   1. `acquireLock` / `withLock` — a cross-process advisory lock so two CC Deck
 *      instances (or a CC Deck instance and a cooperating tool) don't interleave
 *      read-modify-write on the same resource.
 *   2. `snapshot` — capture content + hash + mtime so callers can detect that a
 *      resource changed underneath them (external modification) and retry/merge.
 *   3. `atomicWriteFile` — write via a temp file + rename so a crash mid-write
 *      never leaves a truncated PATH / settings file.
 *
 * Locks are best-effort advisory (they cannot bind external editors); the
 * snapshot/hash check is the real safety net against lost updates.
 */
import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export interface LockOptions {
  /** Max time to wait for the lock before giving up (ms). Default 5000. */
  timeoutMs?: number
  /** A lock older than this is considered abandoned (ms). Default 10000. */
  staleMs?: number
  /** Retry interval while waiting (ms). Default 50. */
  retryMs?: number
}

export interface LockHandle {
  resource: string
  release: () => Promise<void>
}

export interface FileSnapshot {
  exists: boolean
  content: string | null
  /** sha256 of content ('' when absent). */
  hash: string
  mtimeMs: number
}

export function hashString(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

function lockDir(): string {
  return path.join(os.tmpdir(), 'cc-deck-locks')
}

/** A stable, collision-free lock file path for an arbitrary resource key. */
function lockPathFor(resource: string): string {
  return path.join(lockDir(), `${hashString(resource)}.lock`)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isProcessAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM => process exists but we can't signal it; ESRCH => gone.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Acquire an advisory lock for `resource` (any stable string, e.g. an absolute
 * file path or a registry key). Throws if the lock cannot be acquired within
 * `timeoutMs`. Always `release()` in a `finally` (or use `withLock`).
 */
export async function acquireLock(resource: string, opts: LockOptions = {}): Promise<LockHandle> {
  const timeoutMs = opts.timeoutMs ?? 5000
  const staleMs = opts.staleMs ?? 10000
  const retryMs = opts.retryMs ?? 50

  await fs.mkdir(lockDir(), { recursive: true })
  const lockPath = lockPathFor(resource)
  const token = randomUUID()
  const deadline = Date.now() + timeoutMs

  for (;;) {
    try {
      const fh = await fs.open(lockPath, 'wx')
      await fh.writeFile(JSON.stringify({ token, pid: process.pid, ts: Date.now() }))
      await fh.close()
      let released = false
      return {
        resource,
        release: async () => {
          if (released) return
          released = true
          try {
            // Only remove if we still own it.
            const raw = await fs.readFile(lockPath, 'utf8')
            if (JSON.parse(raw).token === token) await fs.unlink(lockPath)
          } catch {
            /* already gone */
          }
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err

      // Lock exists — is it stale?
      try {
        const stat = await fs.stat(lockPath)
        let stale = Date.now() - stat.mtimeMs > staleMs
        if (!stale) {
          try {
            const info = JSON.parse(await fs.readFile(lockPath, 'utf8')) as { pid?: number }
            if (typeof info.pid === 'number' && !isProcessAlive(info.pid)) stale = true
          } catch {
            /* unreadable lock => treat as stale below via age */
          }
        }
        if (stale) {
          await fs.unlink(lockPath).catch(() => undefined)
          continue
        }
      } catch {
        continue // vanished; retry
      }

      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring lock for ${resource}`)
      }
      await delay(retryMs)
    }
  }
}

/** Run `fn` while holding the lock for `resource`, releasing afterwards. */
export async function withLock<T>(
  resource: string,
  fn: () => Promise<T>,
  opts: LockOptions = {}
): Promise<T> {
  const lock = await acquireLock(resource, opts)
  try {
    return await fn()
  } finally {
    await lock.release()
  }
}

/** Capture a resource's current content, hash and mtime (absent => exists:false). */
export async function snapshot(file: string): Promise<FileSnapshot> {
  try {
    const [content, stat] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)])
    return { exists: true, content, hash: hashString(content), mtimeMs: stat.mtimeMs }
  } catch {
    return { exists: false, content: null, hash: '', mtimeMs: 0 }
  }
}

/** True when `file`'s current content hash differs from `expectedHash`. */
export async function changedSince(file: string, expectedHash: string): Promise<boolean> {
  const snap = await snapshot(file)
  return snap.hash !== expectedHash
}

/**
 * Atomically write `content` to `file` (temp file + rename). Creates parent
 * directories. Never leaves a partially-written file behind.
 *
 * On Windows, `rename` onto an existing destination can transiently fail with
 * EPERM/EBUSY/EACCES when another process has the destination open or is
 * renaming onto it concurrently. We retry a few times with a short backoff;
 * callers should still hold a lock for true read-modify-write safety.
 */
export async function atomicWriteFile(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.ccdeck-tmp-${process.pid}-${randomUUID()}`
  const fh = await fs.open(tmp, 'w')
  try {
    await fh.writeFile(content, 'utf8')
    await fh.sync()
  } finally {
    await fh.close()
  }

  const retryable = new Set(['EPERM', 'EBUSY', 'EACCES', 'EEXIST'])
  const maxAttempts = 10
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmp, file)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ''
      if (attempt < maxAttempts - 1 && retryable.has(code)) {
        // Jittered backoff so concurrent writers don't collide in lockstep.
        const backoff = 15 + attempt * 20 + Math.floor(attempt * 7)
        await delay(backoff)
        continue
      }
      await fs.unlink(tmp).catch(() => undefined)
      throw err
    }
  }
}
