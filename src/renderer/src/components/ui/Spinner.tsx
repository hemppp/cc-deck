import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/cn'

export interface SpinnerProps {
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

const sizes = {
  sm: 'size-4',
  md: 'size-5',
  lg: 'size-7'
} as const

export function Spinner({ size = 'md', className }: SpinnerProps) {
  return (
    <Loader2
      role="status"
      aria-label="Loading"
      className={cn('animate-spin text-muted-foreground', sizes[size], className)}
    />
  )
}
