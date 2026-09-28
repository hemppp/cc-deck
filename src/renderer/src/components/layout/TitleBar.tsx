import { useLocation } from 'react-router-dom'
import { StatusDot } from '@/components/ui'
import { useGatewayStore } from '@/store'
import { gatewayStatusMeta } from '@/lib/gateway'
import { useT } from '@/i18n'
import { cn } from '@/lib/cn'
import { titleForPath, statusKey } from './nav'

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent)

export function TitleBar() {
  const t = useT()
  const { pathname } = useLocation()
  const gateway = useGatewayStore((s) => s.state)
  const meta = gatewayStatusMeta(gateway)

  return (
    <header
      className={cn(
        'drag-region flex h-10 shrink-0 items-center border-b border-border bg-surface/80 backdrop-blur',
        // Reserve space for native window controls (titleBarOverlay).
        isMac ? 'pl-20 pr-4' : 'pl-4 pr-[140px]'
      )}
    >
      <span className="text-xs font-medium text-muted-foreground">{t(titleForPath(pathname))}</span>

      <div className="no-drag ml-auto flex items-center gap-2 rounded-full border border-border bg-surface px-2.5 py-1">
        <StatusDot status={meta.status} />
        <span className="text-[11px] font-medium text-muted-foreground">
          {gateway.status === 'running' && gateway.port
            ? `:${gateway.port}`
            : t(statusKey(meta.status))}
        </span>
      </div>
    </header>
  )
}
