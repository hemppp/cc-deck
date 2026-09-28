import { create } from 'zustand'
import type { ModelConfig, TestConnectionResult } from '@shared/types'
import { api, formatError, hasBridge } from '@/lib/api'

export interface ModelsStore {
  models: ModelConfig[]
  loading: boolean
  error: string | null
  load: () => Promise<void>
  save: (config: ModelConfig) => Promise<void>
  remove: (id: string) => Promise<void>
  test: (config: ModelConfig) => Promise<TestConnectionResult>
}

export const useModelsStore = create<ModelsStore>((set) => ({
  models: [],
  loading: false,
  error: null,

  load: async () => {
    if (!hasBridge()) {
      set({ loading: false, error: null })
      return
    }
    set({ loading: true, error: null })
    try {
      const models = await api.value.models.list()
      set({ models, loading: false })
    } catch (e) {
      set({ error: formatError(e), loading: false })
      throw e
    }
  },

  save: async (config) => {
    set({ loading: true, error: null })
    try {
      const models = await api.value.models.save(config)
      set({ models, loading: false })
    } catch (e) {
      set({ error: formatError(e), loading: false })
      throw e
    }
  },

  remove: async (id) => {
    set({ loading: true, error: null })
    try {
      const models = await api.value.models.remove(id)
      set({ models, loading: false })
    } catch (e) {
      set({ error: formatError(e), loading: false })
      throw e
    }
  },

  test: async (config) => {
    return api.value.models.test(config)
  }
}))
