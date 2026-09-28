import { create } from 'zustand'
import type {
  ApplyRequest,
  ApplyResult,
  BackupRecord,
  ClaudeInstall,
  ConflictEvent,
  InstallStatus,
  ValidateResult
} from '@shared/types'
import { api, formatError, hasBridge } from '@/lib/api'

export interface InstallsStore {
  /** All Claude Code installs discovered on this machine. */
  installs: ClaudeInstall[]
  /** Full mutation status for the pinned install (targets, backups, PATH). */
  status: InstallStatus | null
  /** Available backups, newest first. */
  backups: BackupRecord[]
  /** Concurrency / lock-contention events observed while mutating. */
  conflicts: ConflictEvent[]
  loading: boolean
  applying: boolean
  error: string | null

  /** detect + status + backups. */
  load: () => Promise<void>
  /** Pin an install path as active (re-detects + refreshes status). */
  select: (path: string) => Promise<void>
  /** Open a native directory picker. */
  pickDir: () => Promise<string | null>
  /** Validate that a directory looks like a Claude Code install. */
  validate: (path: string) => Promise<ValidateResult>
  /** Apply the custom install path to the chosen targets. */
  apply: (req: ApplyRequest) => Promise<ApplyResult>
  /** Restore a backup (revert env/registry/config changes). */
  revert: (backupId: string) => Promise<ApplyResult>
  /** Recompute status (re-read PATH + targets) without changing anything. */
  refresh: () => Promise<void>
  /** Wire live mutation events; returns an unsubscribe fn. */
  subscribe: () => () => void
  clearConflicts: () => void
}

export const useInstallsStore = create<InstallsStore>((set, get) => ({
  installs: [],
  status: null,
  backups: [],
  conflicts: [],
  loading: false,
  applying: false,
  error: null,

  load: async () => {
    if (!hasBridge()) {
      set({ loading: false, error: null })
      return
    }
    set({ loading: true, error: null })
    try {
      const [installs, status, backups] = await Promise.all([
        api.value.installs.detect(),
        api.value.installs.status(),
        api.value.installs.backups()
      ])
      set({ installs, status, backups, loading: false })
    } catch (e) {
      set({ error: formatError(e), loading: false })
      throw e
    }
  },

  select: async (path) => {
    if (!hasBridge()) return
    set({ loading: true, error: null })
    try {
      const installs = await api.value.installs.select(path)
      set({ installs, loading: false })
      await get()
        .refresh()
        .catch(() => {})
    } catch (e) {
      set({ error: formatError(e), loading: false })
      throw e
    }
  },

  pickDir: async () => {
    if (!hasBridge()) return null
    return api.value.installs.pickDir()
  },

  validate: async (path) => {
    if (!hasBridge()) {
      return {
        ok: false,
        isClaudeCode: false,
        version: null,
        executable: null,
        message: 'CC Deck bridge is unavailable (running outside Electron).'
      }
    }
    try {
      return await api.value.installs.validate(path)
    } catch (e) {
      set({ error: formatError(e) })
      throw e
    }
  },

  apply: async (req) => {
    if (!hasBridge()) throw new Error('CC Deck bridge is unavailable (running outside Electron).')
    set({ applying: true, error: null })
    try {
      const result = await api.value.installs.apply(req)
      set((s) => ({ conflicts: [...s.conflicts, ...result.conflicts], applying: false }))
      await get()
        .refresh()
        .catch(() => {})
      return result
    } catch (e) {
      set({ error: formatError(e), applying: false })
      throw e
    }
  },

  revert: async (backupId) => {
    if (!hasBridge()) throw new Error('CC Deck bridge is unavailable (running outside Electron).')
    set({ applying: true, error: null })
    try {
      const result = await api.value.installs.revert(backupId)
      set((s) => ({ conflicts: [...s.conflicts, ...result.conflicts], applying: false }))
      await get()
        .refresh()
        .catch(() => {})
      return result
    } catch (e) {
      set({ error: formatError(e), applying: false })
      throw e
    }
  },

  refresh: async () => {
    if (!hasBridge()) return
    try {
      const status = await api.value.installs.status()
      set({ status, backups: status.backups })
    } catch (e) {
      set({ error: formatError(e) })
      throw e
    }
  },

  subscribe: () => {
    if (!hasBridge()) return () => {}
    return api.value.installs.onMutation((event) => {
      set((s) => ({ conflicts: [...s.conflicts, event] }))
      void get()
        .refresh()
        .catch(() => {})
    })
  },

  clearConflicts: () => set({ conflicts: [] })
}))
