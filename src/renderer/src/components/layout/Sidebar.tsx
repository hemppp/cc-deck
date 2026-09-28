import { NavLink } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Layers } from 'lucide-react'
import { StatusDot } from '@/components/ui'
import { useGatewayStore } from '@/store'
import { gatewayStatusMeta } from '@/lib/gateway'
import { useT } from '@/i18n'
import { cn } from '@/lib/cn'
import { navItems, statusKey } from './nav'

export function Sidebar() {
  const t = useT()
  const gateway = useGatewayStore((s) => s.state)
  const meta = gatewayStatusMeta(gateway)

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-surface/60">
      {/* Wordmark */}
      <div className="flex h-14 items-center gap-2.5 px-5">
        <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
          <Layers className="size-[18px]" />
        </div>
        <div className="leading-tight">
          <div className="text-sm font-semibold tracking-tight">{t('app.name')}</div>
          <div className="text-[11px] text-muted-foreground">{t('app.tagline')}</div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex flex-1 flex-col gap-0.5 px-3 py-2">
        {navItems.map((item) => {
          const Icon = item.icon
          return (
            <NavLink key={item.path} to={item.path} className="relative block">
              {({ isActive }) => (
                <span
                  className={cn(
                    'relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors focus-ring',
                    isActive
                      ? 'text-foreground'
                      : 'text-muted-foreground hover:bg-surface-muted hover:text-foreground'
                  )}
                >
                  {isActive ? (
                    <motion.span
                      layoutId="sidebar-active-pill"
                      className="absolute inset-0 rounded-lg bg-accent"
                      transition={{ type: 'spring', stiffness: 400, damping: 32 }}
                    />
                  ) : null}
                  <Icon
                    className={cn('relative size-[18px]', isActive && 'text-primary')}
                  />
                  <span className="relative">{t(item.labelKey)}</span>
                </span>
              )}
            </NavLink>
          )
        })}
      </nav>

      {/* Gateway status footer */}
      <div className="border-t border-border px-5 py-3.5">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {t('titlebar.gateway')}
          </span>
          <StatusDot status={meta.status} label={t(statusKey(meta.status))} />
        </div>
        {gateway.status === 'running' && gateway.baseUrl ? (
          <p className="mt-1.5 truncate font-mono text-[11px] text-muted-foreground">
            {gateway.baseUrl}
          </p>
        ) : null}
      </div>
    </aside>
  )
}
