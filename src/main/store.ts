/**
 * CC Deck — persistence layer.
 *
 * Wraps `electron-store` (v8, CommonJS) behind a small typed facade so the rest
 * of the main process never touches the raw store shape. The project is ESM
 * ("type": "module"), so we import the CJS default with a default import; esbuild
 * (electron-vite) and tsc (`esModuleInterop`) both resolve it correctly.
 */
import Store from 'electron-store'
import type { AppSettings, BackupRecord, ModelConfig, Workspace } from '@shared/types'

/** Shape persisted on disk. Everything the app needs to remember. */
interface StoreSchema {
  workspaces: Workspace[]
  modelConfigs: ModelConfig[]
  settings: AppSettings
  /** Currently pinned Claude Code install root, or null for auto-detect. */
  activeInstallPath: string | null
  /** Backups taken before mutating install targets, newest last. */
  backups: BackupRecord[]
}

export const DEFAULT_SETTINGS: AppSettings = {
  claudeInstallPath: null,
  gatewayPort: 8788,
  defaultModelConfigId: null,
  theme: 'system',
  language: 'en',
  launchMode: 'external-terminal'
}

const store = new Store<StoreSchema>({
  name: 'cc-deck',
  defaults: {
    workspaces: [],
    modelConfigs: [],
    settings: DEFAULT_SETTINGS,
    activeInstallPath: null,
    backups: []
  }
})

/* ------------------------------------------------------------------ */
/* Workspaces                                                          */
/* ------------------------------------------------------------------ */

export function getWorkspaces(): Workspace[] {
  return store.get('workspaces', [])
}

export function setWorkspaces(workspaces: Workspace[]): Workspace[] {
  store.set('workspaces', workspaces)
  return workspaces
}

/* ------------------------------------------------------------------ */
/* Model configs                                                       */
/* ------------------------------------------------------------------ */

export function getModelConfigs(): ModelConfig[] {
  return store.get('modelConfigs', [])
}

export function setModelConfigs(configs: ModelConfig[]): ModelConfig[] {
  store.set('modelConfigs', configs)
  return configs
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

/** Merge stored settings over defaults so newly-added keys always resolve. */
export function getSettings(): AppSettings {
  return { ...DEFAULT_SETTINGS, ...store.get('settings', DEFAULT_SETTINGS) }
}

export function setSettings(patch: Partial<AppSettings>): AppSettings {
  const next: AppSettings = { ...getSettings(), ...patch }
  store.set('settings', next)
  return next
}

/* ------------------------------------------------------------------ */
/* Active Claude install                                               */
/* ------------------------------------------------------------------ */

export function getActiveInstallPath(): string | null {
  return store.get('activeInstallPath', null)
}

export function setActiveInstallPath(path: string | null): string | null {
  store.set('activeInstallPath', path)
  return path
}

/* ------------------------------------------------------------------ */
/* Install backups                                                     */
/* ------------------------------------------------------------------ */

export function getBackups(): BackupRecord[] {
  return store.get('backups', [])
}

export function setBackups(records: BackupRecord[]): BackupRecord[] {
  store.set('backups', records)
  return records
}

export default store
