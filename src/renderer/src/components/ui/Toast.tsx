import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { CheckCircle2, Info, X, XCircle } from 'lucide-react'
import { create } from 'zustand'
import { cn } from '@/lib/cn'
import { useT } from '@/i18n'

export type ToastVariant = 'default' | 'success' | 'error'

export interface ToastItem {
  id: string
  title: string
  description?: string
  variant: ToastVariant
  duration: number
}

export interface ToastOptions {
  title: string
  description?: string
  variant?: ToastVariant
  duration?: number
}

interface ToastStore {
  toasts: ToastItem[]
  push: (t: ToastItem) => void
  dismiss: (id: string) => void
  clear: () => void
}

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  push: (t) => set((s) => ({ toasts: [...s.toasts, t] })),
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  clear: () => set({ toasts: [] })
}))

let counter = 0

/** Imperative toast helper usable from anywhere (stores, pages, hooks). */
export function toast({ title, description, variant = 'default', duration = 4000 }: ToastOptions): string {
  const id = `toast-${Date.now()}-${counter++}`
  useToastStore.getState().push({ id, title, description, variant, duration })
  return id
}

const variantIcon = {
  default: Info,
  success: CheckCircle2,
  error: XCircle
} as const

const variantAccent = {
  default: 'text-muted-foreground',
  success: 'text-success',
  error: 'text-destructive'
} as const

function ToastCard({ item }: { item: ToastItem }): JSX.Element {
  const t = useT()
  const dismiss = useToastStore((s) => s.dismiss)
  const Icon = variantIcon[item.variant]

  useEffect(() => {
    if (item.duration <= 0) return
    const timer = window.setTimeout(() => dismiss(item.id), item.duration)
    return () => window.clearTimeout(timer)
  }, [item.id, item.duration, dismiss])

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, x: 24, scale: 0.98 }}
      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
      className="pointer-events-auto flex w-80 items-start gap-3 rounded-xl border border-border bg-surface p-3.5 shadow-lg"
    >
      <Icon className={cn('mt-0.5 size-4 shrink-0', variantAccent[item.variant])} />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-sm font-medium leading-snug text-foreground">{item.title}</p>
        {item.description ? (
          <p className="text-xs leading-snug text-muted-foreground">{item.description}</p>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => dismiss(item.id)}
        aria-label={t('common.dismiss')}
        className="-mr-1 -mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-surface-muted hover:text-foreground focus-ring"
      >
        <X className="size-3.5" />
      </button>
    </motion.div>
  )
}

export function Toaster(): JSX.Element | null {
  const toasts = useToastStore((s) => s.toasts)
  if (typeof document === 'undefined') return null

  return createPortal(
    <div className="pointer-events-none fixed bottom-4 right-4 z-[200] flex flex-col items-end gap-2">
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <ToastCard key={t.id} item={t} />
        ))}
      </AnimatePresence>
    </div>,
    document.body
  )
}
