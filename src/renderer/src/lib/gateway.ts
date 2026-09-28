import type { GatewayState } from '@shared/types'
import type { StatusDotStatus } from '@/components/ui'

export interface GatewayStatusMeta {
  /** Maps onto StatusDot's status vocabulary. */
  status: StatusDotStatus
  label: string
}

/** Human-friendly presentation for a gateway state (shared by title bar, sidebar, pages). */
export function gatewayStatusMeta(state: GatewayState | null | undefined): GatewayStatusMeta {
  const status = state?.status ?? 'stopped'
  switch (status) {
    case 'running':
      return { status: 'running', label: 'Running' }
    case 'starting':
      return { status: 'starting', label: 'Starting…' }
    case 'error':
      return { status: 'error', label: 'Error' }
    case 'stopped':
    default:
      return { status: 'stopped', label: 'Stopped' }
  }
}
