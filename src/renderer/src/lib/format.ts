/**
 * Small, dependency-free formatting helpers shared across the UI.
 */

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY

/** "just now" / "5m ago" / "3h ago" / "2d ago" / locale date for old values. */
export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  const time = date.getTime()
  if (Number.isNaN(time)) return '—'

  const diff = Date.now() - time
  const abs = Math.abs(diff)
  const suffix = diff >= 0 ? 'ago' : 'from now'

  if (abs < 45 * SECOND) return 'just now'
  if (abs < MINUTE) return `${Math.round(abs / SECOND)}s ${suffix}`
  if (abs < HOUR) return `${Math.round(abs / MINUTE)}m ${suffix}`
  if (abs < DAY) return `${Math.round(abs / HOUR)}h ${suffix}`
  if (abs < WEEK) return `${Math.round(abs / DAY)}d ${suffix}`

  return date.toLocaleDateString(undefined, {
    year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
    month: 'short',
    day: 'numeric'
  })
}

/** Middle-truncates a path so the most meaningful tail stays visible. */
export function truncatePath(p: string | null | undefined, max = 48): string {
  if (!p) return '—'
  if (p.length <= max) return p

  const sep = p.includes('\\') ? '\\' : '/'
  const parts = p.split(/[\\/]+/).filter(Boolean)
  const last = parts[parts.length - 1] ?? p
  const first = parts[0] ?? ''

  const candidate = `${first}${sep}…${sep}${last}`
  if (candidate.length <= max) return candidate

  const tailRoom = Math.max(1, max - 2)
  return `…${sep}${last.slice(-tailRoom)}`
}

/** Replaces a leading home directory with `~` (Windows + POSIX). */
export function shortenHome(p: string | null | undefined): string {
  if (!p) return '—'
  const match = p.match(/^([A-Za-z]:\\Users\\[^\\]+|\/(?:Users|home)\/[^/]+)(.*)$/)
  if (match) return `~${match[2]}`
  return p
}

/** 820 -> "820ms", 1500 -> "1.5s", 90000 -> "1m 30s", 3720000 -> "1h 2m". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < SECOND) return `${Math.round(ms)}ms`

  const seconds = ms / SECOND
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`

  const minutes = Math.floor(seconds / 60)
  const remSeconds = Math.round(seconds % 60)
  if (minutes < 60) return remSeconds ? `${minutes}m ${remSeconds}s` : `${minutes}m`

  const hours = Math.floor(minutes / 60)
  const remMinutes = minutes % 60
  return remMinutes ? `${hours}h ${remMinutes}m` : `${hours}h`
}

/** 1234 -> "1.2k", 3_400_000 -> "3.4M". */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return '0'
  const abs = Math.abs(n)
  const trim = (v: number): string => String(Math.round(v * 10) / 10)

  if (abs < 1000) return String(n)
  if (abs < 1_000_000) return `${trim(n / 1000)}k`
  if (abs < 1_000_000_000) return `${trim(n / 1_000_000)}M`
  return `${trim(n / 1_000_000_000)}B`
}
