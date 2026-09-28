import { create } from 'zustand'
import type {
  LaunchOptions,
  LaunchResult,
  LaunchSession,
  LaunchVerification
} from '@shared/types'
import { api, formatError, hasBridge } from '@/lib/api'

export interface LaunchStore {
  /** Tracked Claude Code sessions, newest first. */
  sessions: LaunchSession[]
  loading: boolean
  error: string | null
  /** Fetch the current session list. */
  loadSessions: () => Promise<void>
  /** Dry-run: resolve what would launch + verify the workspace/install binding. */
  verify: (opts: LaunchOptions) => Promise<LaunchVerification>
  /** Launch Claude Code for a workspace. */
  run: (opts: LaunchOptions) => Promise<LaunchResult>
  /** Wire live session start/exit events; returns an unsubscribe fn. */
  subscribe: () => () => void
}

const NO_BRIDGE = 'CC Deck bridge is unavailable (running outside Electron).'

/** Newest-first by `startedAt`, tolerating unparseable timestamps. */
function sortSessions(sessions: LaunchSession[]): LaunchSession[] {
  return [...sessions].sort((a, b) => {
    const ta = Date.parse(a.startedAt)
    const tb = Date.parse(b.startedAt)
    if (Number.isNaN(ta) || Number.isNaN(tb)) return 0
    return tb - ta
  })
}

/** Insert or replace a session by id, keeping the list newest-first. */
export function upsertSession(sessions: LaunchSession[], session: LaunchSession): LaunchSession[] {
  return sortSessions([session, ...sessions.filter((s) => s.id !== session.id)])
}

export const useLaunchStore = create<LaunchStore>((set) => ({
  sessions: [],
  loading: false,
  error: null,

  loadSessions: async () => {
    if (!hasBridge()) {
      set({ loading: false, error: null })
      return
    }
    set({ loading: true, error: null })
    try {
      const sessions = await api.value.launch.sessions()
      set({ sessions: sortSessions(sessions), loading: false })
    } catch (e) {
      set({ error: formatError(e), loading: false })
      throw e
    }
  },

  verify: async (opts) => {
    if (!hasBridge()) throw new Error(NO_BRIDGE)
    try {
      return await api.value.launch.verify(opts)
    } catch (e) {
      set({ error: formatError(e) })
      throw e
    }
  },

  run: async (opts) => {
    if (!hasBridge()) throw new Error(NO_BRIDGE)
    try {
      const result = await api.value.launch.run(opts)
      // Best-effort refresh so the session list reflects the new launch even
      // if the live `onSession` event is delayed.
      await api.value.launch
        .sessions()
        .then((sessions) => set({ sessions: sortSessions(sessions) }))
        .catch(() => {})
      return result
    } catch (e) {
      set({ error: formatError(e) })
      throw e
    }
  },

  subscribe: () => {
    if (!hasBridge()) return () => {}
    return api.value.launch.onSession((session) => {
      set((s) => ({ sessions: upsertSession(s.sessions, session) }))
    })
  }
}))
