import { Boxes, Network, Settings, SquareKanban, type LucideIcon } from 'lucide-react'
import type { TranslationKey } from '@/i18n'
import type { StatusDotStatus } from '@/components/ui'

export interface NavItem {
  /** Translation key for the item's label (resolved via `t()` at render time). */
  labelKey: TranslationKey
  path: string
  icon: LucideIcon
}

export const navItems: NavItem[] = [
  { labelKey: 'nav.workspaces', path: '/workspaces', icon: SquareKanban },
  { labelKey: 'nav.models', path: '/models', icon: Boxes },
  { labelKey: 'nav.gateway', path: '/gateway', icon: Network },
  { labelKey: 'nav.settings', path: '/settings', icon: Settings }
]

/** Best-effort page-title translation key for the title bar given a pathname. */
export function titleForPath(pathname: string): TranslationKey {
  const match = navItems.find((item) => pathname.startsWith(item.path))
  return match?.labelKey ?? 'app.name'
}

const STATUS_KEYS: Record<StatusDotStatus, TranslationKey> = {
  stopped: 'status.stopped',
  starting: 'status.starting',
  running: 'status.running',
  error: 'status.error',
  ok: 'status.running',
  warn: 'status.error'
}

/** Translation key for a `StatusDot` status value (gateway footer / title bar chip). */
export function statusKey(status: StatusDotStatus): TranslationKey {
  return STATUS_KEYS[status]
}
