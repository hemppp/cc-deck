import { create } from 'zustand'
import type { Workspace } from '@shared/types'
import { api, formatError, hasBridge } from '@/lib/api'

export interface WorkspacesStore {
  workspaces: Workspace[]
  loading: boolean
  error: string | null
  load: () => Promise<void>
  add: (input: Pick<Workspace, 'name' | 'path'> & Partial<Workspace>) => Promise<Workspace>
  remove: (id: string) => Promise<void>
  update: (id: string, patch: Partial<Workspace>) => Promise<void>
  pickDir: () => Promise<string | null>
}

export const useWorkspacesStore = create<WorkspacesStore>((set) => ({
  workspaces: [],
  loading: false,
  error: null,

  load: async () => {
    if (!hasBridge()) {
      set({ loading: false, error: null })
      return
    }
    set({ loading: true, error: null })
    try {
      const workspaces = await api.value.workspaces.list()
      set({ workspaces, loading: false })
    } catch (e) {
      set({ error: formatError(e), loading: false })
      throw e
    }
  },

  add: async (input) => {
    set({ loading: true, error: null })
    try {
      const created = await api.value.workspaces.add(input)
      set((s) => ({ workspaces: [...s.workspaces, created], loading: false }))
      return created
    } catch (e) {
      set({ error: formatError(e), loading: false })
      throw e
    }
  },

  remove: async (id) => {
    set({ loading: true, error: null })
    try {
      const workspaces = await api.value.workspaces.remove(id)
      set({ workspaces, loading: false })
    } catch (e) {
      set({ error: formatError(e), loading: false })
      throw e
    }
  },

  update: async (id, patch) => {
    set({ loading: true, error: null })
    try {
      const updated = await api.value.workspaces.update(id, patch)
      set((s) => ({
        workspaces: s.workspaces.map((w) => (w.id === id ? updated : w)),
        loading: false
      }))
    } catch (e) {
      set({ error: formatError(e), loading: false })
      throw e
    }
  },

  pickDir: async () => {
    if (!hasBridge()) return null
    return api.value.workspaces.pickDir()
  }
}))
