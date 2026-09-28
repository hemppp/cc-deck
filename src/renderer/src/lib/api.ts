/**
 * Typed accessor for the preload bridge (`window.ccdeck`).
 *
 * The renderer is also expected to run in a plain browser during design work,
 * so every access is guarded by `hasBridge()`. When the bridge is missing the
 * UI degrades gracefully (empty states) instead of throwing on import.
 */
import type { CcDeckApi } from '@shared/ipc'

/** True when the Electron preload bridge is available. */
export function hasBridge(): boolean {
  return typeof window !== 'undefined' && typeof window.ccdeck !== 'undefined' && window.ccdeck !== null
}

/**
 * Returns the bridge. Throws a friendly error when unavailable — callers that
 * want to degrade gracefully should check `hasBridge()` first.
 */
export function getApi(): CcDeckApi {
  if (!hasBridge()) {
    throw new Error('CC Deck bridge is unavailable (running outside Electron).')
  }
  return window.ccdeck
}

/** Alias used across stores for readability. */
export const api = {
  get value(): CcDeckApi {
    return getApi()
  }
}

/**
 * Best-effort human readable message from anything that can be thrown,
 * including IPC errors that surface as `{ message }` objects.
 */
export function formatError(e: unknown): string {
  if (e === null || e === undefined) return 'Unknown error'
  if (typeof e === 'string') return e
  if (e instanceof Error) return e.message || e.name || 'Error'

  if (typeof e === 'object') {
    const record = e as Record<string, unknown>
    if (typeof record.message === 'string' && record.message) return record.message
    if (typeof record.error === 'string' && record.error) return record.error
    try {
      const json = JSON.stringify(e)
      if (json && json !== '{}') return json
    } catch {
      /* fall through */
    }
  }

  return String(e)
}
