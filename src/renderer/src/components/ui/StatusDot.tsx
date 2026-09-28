import { cn } from '@/lib/cn'

export type StatusDotStatus = 'stopped' | 'starting' | 'running' | 'error' | 'ok' | 'warn'

export interface StatusDotProps {
  status: StatusDotStatus
  label?: string
  className?: string
}

const dotColor: Record<StatusDotStatus, string> = {
  stopped: 'bg-muted-foreground/60',
  starting: 'bg-warning',
  running: 'bg-success',
  ok: 'bg-success',
  warn: 'bg-warning',
  error: 'bg-destructive'
}

const labelColor: Record<StatusDotStatus, string> = {
  stopped: 'text-muted-foreground',
  starting: 'text-warning',
  running: 'text-success',
  ok: 'text-success',
  warn: 'text-warning',
  error: 'text-destructive'
}

const pulsing: StatusDotStatus[] = ['starting', 'running']

export function StatusDot({ status, label, className }: StatusDotProps) {
  const isPulsing = pulsing.includes(status)
  return (
    <span className={cn('inline-flex items-center gap-2 text-xs font-medium', className)}>
      <span className="relative flex size-2">
        {isPulsing ? (
          <span
            className={cn('absolute inline-flex size-full animate-ping rounded-full opacity-60', dotColor[status])}
          />
        ) : null}
        <span className={cn('relative inline-flex size-2 rounded-full', dotColor[status])} />
      </span>
      {label ? <span className={cn(labelColor[status])}>{label}</span> : null}
    </span>
  )
}
