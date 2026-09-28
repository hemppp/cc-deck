/**
 * CC Deck — IPC dispatcher.
 *
 * Registers one `ipcMain.handle` per channel in the frozen `IPC` constant and
 * delegates to the service modules. Handlers validate input loosely (shape /
 * type checks only) and let service errors propagate to the renderer, where
 * `ipcRenderer.invoke` rejects.
 *
 * Sibling service modules and their expected exports (owned by other agents):
 *
 *   ./services/installs   (this agent)
 *     detectInstalls(): Promise<ClaudeInstall[]>
 *     selectInstall(path: string): Promise<ClaudeInstall[]>
 *     pickInstallDir(): Promise<string | null>
 *
 *   ./services/workspaces (renderer-foundation)
 *     listWorkspaces(): Promise<Workspace[]>
 *     addWorkspace(input: Pick<Workspace,'name'|'path'> & Partial<Workspace>): Promise<Workspace>
 *     removeWorkspace(id: string): Promise<Workspace[]>
 *     updateWorkspace(id: string, patch: Partial<Workspace>): Promise<Workspace>
 *     pickWorkspaceDir(): Promise<string | null>
 *
 *   ./services/models     (model-gateway)
 *     listModels(): Promise<ModelConfig[]>
 *     saveModel(config: ModelConfig): Promise<ModelConfig[]>
 *     removeModel(id: string): Promise<ModelConfig[]>
 *     testModel(config: ModelConfig): Promise<TestConnectionResult>
 *
 *   ./services/gateway    (model-gateway)
 *     startGateway(configId: string, port?: number): Promise<GatewayState>
 *     stopGateway(): Promise<GatewayState>
 *     getGatewayState(): GatewayState
 *     getActiveEnv(): Record<string, string>
 *
 *   ./services/launch     (renderer-foundation)
 *     launchClaude(opts: LaunchOptions): Promise<LaunchResult>
 */
import { ipcMain } from 'electron'
import { IPC } from '@shared/types'
import type {
  AppSettings,
  ApplyRequest,
  BackupRecord,
  InstallStatus,
  LaunchOptions,
  ModelConfig,
  ValidateResult,
  Workspace
} from '@shared/types'
import { detectInstalls, pickInstallDir, selectInstall } from './services/installs'
import {
  applyInstall,
  installStatus,
  listBackups,
  refreshStatus,
  revertInstall,
  validateInstallPath
} from './services/install-manager'
import {
  addWorkspace,
  listWorkspaces,
  pickWorkspaceDir,
  removeWorkspace,
  updateWorkspace
} from './services/workspaces'
import { listModels, removeModel, saveModel, testModel } from './services/models'
import { getGatewayState, startGateway, stopGateway } from './services/gateway'
import { getSessions, launchClaude, verifyLaunch } from './services/launch'
import { getSettings, setSettings } from './store'

/* ------------------------------------------------------------------ */
/* Loose input validation helpers                                      */
/* ------------------------------------------------------------------ */

function asString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid "${label}": expected a non-empty string`)
  }
  return value
}

function asObject<T extends object>(value: unknown, label: string): T {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`Invalid "${label}": expected an object`)
  }
  return value as T
}

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

/** Register every CC Deck IPC handler. Call once, after `app.whenReady()`. */
export function registerIpc(): void {
  /* installs ---------------------------------------------------------- */
  ipcMain.handle(IPC.installsDetect, () => detectInstalls())
  ipcMain.handle(IPC.installsSelect, (_e, path: unknown) => selectInstall(asString(path, 'path')))
  ipcMain.handle(IPC.installsPickDir, () => pickInstallDir())
  ipcMain.handle(IPC.installsStatus, (): Promise<InstallStatus> => installStatus())
  ipcMain.handle(IPC.installsValidate, (_e, path: unknown) =>
    validateInstallPath(asString(path, 'path'))
  )
  ipcMain.handle(IPC.installsApply, (_e, req: unknown) =>
    applyInstall(asObject<ApplyRequest>(req, 'request'))
  )
  ipcMain.handle(IPC.installsRevert, (_e, backupId: unknown) =>
    revertInstall(asString(backupId, 'backupId'))
  )
  ipcMain.handle(IPC.installsBackups, (): Promise<BackupRecord[]> => listBackups())
  ipcMain.handle(IPC.installsRefresh, (): Promise<InstallStatus> => refreshStatus())

  /* workspaces -------------------------------------------------------- */
  ipcMain.handle(IPC.workspacesList, () => listWorkspaces())
  ipcMain.handle(IPC.workspacesAdd, (_e, input: unknown) =>
    addWorkspace(asObject<Pick<Workspace, 'name' | 'path'> & Partial<Workspace>>(input, 'input'))
  )
  ipcMain.handle(IPC.workspacesRemove, (_e, id: unknown) => removeWorkspace(asString(id, 'id')))
  ipcMain.handle(IPC.workspacesUpdate, (_e, id: unknown, patch: unknown) =>
    updateWorkspace(asString(id, 'id'), asObject<Partial<Workspace>>(patch, 'patch'))
  )
  ipcMain.handle(IPC.workspacesPickDir, () => pickWorkspaceDir())

  /* models ------------------------------------------------------------ */
  ipcMain.handle(IPC.modelsList, () => listModels())
  ipcMain.handle(IPC.modelsSave, (_e, config: unknown) =>
    saveModel(asObject<ModelConfig>(config, 'config'))
  )
  ipcMain.handle(IPC.modelsRemove, (_e, id: unknown) => removeModel(asString(id, 'id')))
  ipcMain.handle(IPC.modelsTest, (_e, config: unknown) =>
    testModel(asObject<ModelConfig>(config, 'config'))
  )

  /* gateway ----------------------------------------------------------- */
  ipcMain.handle(IPC.gatewayStart, (_e, configId: unknown, port: unknown) =>
    startGateway(asString(configId, 'configId'), typeof port === 'number' ? port : undefined)
  )
  ipcMain.handle(IPC.gatewayStop, () => stopGateway())
  ipcMain.handle(IPC.gatewayState, () => getGatewayState())

  /* launch ------------------------------------------------------------ */
  ipcMain.handle(IPC.launchRun, (_e, opts: unknown) =>
    launchClaude(asObject<LaunchOptions>(opts, 'options'))
  )
  ipcMain.handle(IPC.launchVerify, (_e, opts: unknown) =>
    verifyLaunch(asObject<LaunchOptions>(opts, 'options'))
  )
  ipcMain.handle(IPC.launchSessions, () => getSessions())

  /* settings ---------------------------------------------------------- */
  ipcMain.handle(IPC.settingsGet, () => getSettings())
  ipcMain.handle(IPC.settingsSet, (_e, patch: unknown) =>
    setSettings(asObject<Partial<AppSettings>>(patch, 'patch'))
  )
}
