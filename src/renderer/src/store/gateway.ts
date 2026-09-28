import { create } from 'zustand'
import type { GatewayState } from '@shared/types'
import { api, formatError, hasBridge } from '@/lib/api'

export interface GatewayStore {
  state: GatewayState
  loading: boolean
  error: string | null
  load: () => Promise<void>
  start: (configId: string, port?: number) => Promise<void>
  stop: () => Promise<void>
  subscribe: () => () => void
}

export const initialGatewayState: GatewayState = {
  status: 'stopped',
  port: null,
  baseUrl: null,
  activeConfigId: null,
  token: null,
  error: null,
  requestCount: 0
}

export const useGatewayStore = create<GatewayStore>((set) => ({
  state: initialGatewayState,
  loading: false,
  error: null,

  load: async () => {
    if (!hasBridge()) {
      set({ loading: false, error: null })
      return
    }
    set({ loading: true, error: null })
    try {
      const state = await api.value.gateway.state()
      set({ state, loading: false })
    } catch (e) {
      set({ error: formatError(e), loading: false })
      throw e
    }
  },

  start: async (configId, port) => {
    set({ loading: true, error: null })
    try {
      const state = await api.value.gateway.start(configId, port)
      set({ state, loading: false })
    } catch (e) {
      set({ error: formatError(e), loading: false })
      throw e
    }
  },

  stop: async () => {
    set({ loading: true, error: null })
    try {
      const state = await api.value.gateway.stop()
      set({ state, loading: false })
    } catch (e) {
      set({ error: formatError(e), loading: false })
      throw e
    }
  },

  subscribe: () => {
    if (!hasBridge()) return () => {}
    return api.value.gateway.onState((state) => set({ state }))
  }
}))
