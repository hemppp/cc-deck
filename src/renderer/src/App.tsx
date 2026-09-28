import { useEffect } from 'react'
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import type { ThemeMode } from '@shared/types'
import { AppShell } from '@/components/layout'
import { Toaster } from '@/components/ui'
import { useSettingsStore } from '@/store'
import Workspaces from '@/pages/WorkspacesPage'
import Models from '@/pages/ModelsPage'
import Gateway from '@/pages/GatewayPage'
import Settings from '@/pages/SettingsPage'

function applyTheme(theme: ThemeMode, prefersDark: boolean): void {
  const dark = theme === 'dark' || (theme === 'system' && prefersDark)
  document.documentElement.classList.toggle('dark', dark)
}

export default function App(): JSX.Element {
  const theme = useSettingsStore((s) => s.settings?.theme)
  const loadSettings = useSettingsStore((s) => s.load)

  // Load settings once, then keep the document theme in sync.
  useEffect(() => {
    void loadSettings().catch(() => {
      /* surfaced via store.error / page toast */
    })
  }, [loadSettings])

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const resolved = theme ?? 'system'
    const apply = (): void => applyTheme(resolved, mq.matches)

    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [theme])

  return (
    <HashRouter>
      <AppShell>
        <Routes>
          <Route path="/" element={<Navigate to="/workspaces" replace />} />
          <Route path="/workspaces" element={<Workspaces />} />
          <Route path="/models" element={<Models />} />
          <Route path="/gateway" element={<Gateway />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/workspaces" replace />} />
        </Routes>
      </AppShell>
      <Toaster />
    </HashRouter>
  )
}
