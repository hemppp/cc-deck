import { useEffect, type ReactNode } from 'react'
import { useGatewayStore } from '@/store'
import { Sidebar } from './Sidebar'
import { TitleBar } from './TitleBar'

export interface AppShellProps {
  children: ReactNode
}

export function AppShell({ children }: AppShellProps) {
  // Keep gateway state live for the whole shell (title bar + sidebar status).
  useEffect(() => {
    const { subscribe, load } = useGatewayStore.getState()
    void load()
    return subscribe()
  }, [])

  return (
    <div className="flex h-full w-full overflow-hidden bg-background text-foreground">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TitleBar />
        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-5xl px-8 py-8">{children}</div>
        </main>
      </div>
    </div>
  )
}
