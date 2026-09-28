import { create } from 'zustand'
import type { AppSettings } from '@shared/types'
import { api, formatError, hasBridge } from '@/lib/api'

export interface SettingsStore {
  settings: AppSettings | null
  loading: boolean
  error: string | null
  load: () => Promise<void>
  update: (patch: Partial<AppSettings>) => Promise<void>
}

export const useSettingsStore = create<SettingsStore>((set) => ({
  settings: null,
  loading: false,
  error: null,

  load: async () => {
    if (!hasBridge()) {
      set({ loading: false, error: null })
      return
    }
    set({ loading: true, error: null })
    try {
      const settings = await api.value.settings.get()
      set({ settings, loading: false })
    } catch (e) {
      set({ error: formatError(e), loading: false })
      throw e
    }
  },

  update: async (patch) => {
    if (!hasBridge()) return
    set({ loading: true, error: null })
    try {
      const settings = await api.value.settings.set(patch)
      set({ settings, loading: false })
    } catch (e) {
      set({ error: formatError(e), loading: false })
      throw e
    }
  }
}))
