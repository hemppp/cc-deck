/**
 * CC Deck — IPC payload types + the window.ccdeck bridge contract.
 * FROZEN: preload implements `CcDeckApi`, renderer consumes it.
 */
import type {
  AppSettings,
  ApplyRequest,
  ApplyResult,
  BackupRecord,
  ClaudeInstall,
  GatewayState,
  InstallStatus,
  LaunchOptions,
  LaunchResult,
  LaunchSession,
  LaunchVerification,
  ModelConfig,
  TestConnectionResult,
  ValidateResult,
  Workspace
} from './types'

export interface CcDeckApi {
  installs: {
    detect: () => Promise<ClaudeInstall[]>
    select: (path: string) => Promise<ClaudeInstall[]>
    pickDir: () => Promise<string | null>
    /** Full mutation status: pinned path, PATH resolution, targets, backups. */
    status: () => Promise<InstallStatus>
    /** Validate that a directory looks like a Claude Code install. */
    validate: (path: string) => Promise<ValidateResult>
    /** Apply the custom install path to the chosen env/registry/config targets. */
    apply: (req: ApplyRequest) => Promise<ApplyResult>
    /** Restore a backup (revert env/registry/config changes). */
    revert: (backupId: string) => Promise<ApplyResult>
    /** List available backups, newest first. */
    backups: () => Promise<BackupRecord[]>
    /** Recompute status (re-read PATH + targets) without changing anything. */
    refresh: () => Promise<InstallStatus>
    /** Live concurrency/mutation events during an apply. */
    onMutation: (cb: (event: import('./types').ConflictEvent) => void) => () => void
  }
  workspaces: {
    list: () => Promise<Workspace[]>
    add: (input: Pick<Workspace, 'name' | 'path'> & Partial<Workspace>) => Promise<Workspace>
    remove: (id: string) => Promise<Workspace[]>
    update: (id: string, patch: Partial<Workspace>) => Promise<Workspace>
    pickDir: () => Promise<string | null>
  }
  models: {
    list: () => Promise<ModelConfig[]>
    save: (config: ModelConfig) => Promise<ModelConfig[]>
    remove: (id: string) => Promise<ModelConfig[]>
    test: (config: ModelConfig) => Promise<TestConnectionResult>
  }
  gateway: {
    start: (configId: string, port?: number) => Promise<GatewayState>
    stop: () => Promise<GatewayState>
    state: () => Promise<GatewayState>
    onState: (cb: (state: GatewayState) => void) => () => void
  }
  launch: {
    run: (opts: LaunchOptions) => Promise<LaunchResult>
    /** Dry-run: resolve what WOULD launch and verify the workspace/install binding. */
    verify: (opts: LaunchOptions) => Promise<LaunchVerification>
    /** Tracked launch sessions, newest first. */
    sessions: () => Promise<LaunchSession[]>
    /** Live session start/exit events. */
    onSession: (cb: (session: LaunchSession) => void) => () => void
  }
  settings: {
    get: () => Promise<AppSettings>
    set: (patch: Partial<AppSettings>) => Promise<AppSettings>
  }
}

declare global {
  interface Window {
    ccdeck: CcDeckApi
  }
}
