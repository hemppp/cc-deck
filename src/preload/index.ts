/**
 * CC Deck — preload bridge.
 *
 * Exposes a minimal, dependency-free `window.ccdeck` surface that maps 1:1 to
 * the frozen `CcDeckApi` contract in `@shared/ipc`. Every call is a plain
 * `ipcRenderer.invoke` over a whitelisted channel; no Node primitive and no raw
 * `ipcRenderer` is ever handed to the renderer.
 */
import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import {
  IPC,
  type ConflictEvent,
  type GatewayState,
  type LaunchSession,
  type LaunchVerification
} from '@shared/types'
import type { CcDeckApi } from '@shared/ipc'

const api: CcDeckApi = {
  installs: {
    detect: () => ipcRenderer.invoke(IPC.installsDetect),
    select: (path) => ipcRenderer.invoke(IPC.installsSelect, path),
    pickDir: () => ipcRenderer.invoke(IPC.installsPickDir),
    status: () => ipcRenderer.invoke(IPC.installsStatus),
    validate: (path) => ipcRenderer.invoke(IPC.installsValidate, path),
    apply: (req) => ipcRenderer.invoke(IPC.installsApply, req),
    revert: (backupId) => ipcRenderer.invoke(IPC.installsRevert, backupId),
    backups: () => ipcRenderer.invoke(IPC.installsBackups),
    refresh: () => ipcRenderer.invoke(IPC.installsRefresh),
    onMutation: (cb) => {
      const listener = (_event: IpcRendererEvent, ev: ConflictEvent): void => cb(ev)
      ipcRenderer.on(IPC.eventInstallMutation, listener)
      return () => {
        ipcRenderer.removeListener(IPC.eventInstallMutation, listener)
      }
    }
  },

  workspaces: {
    list: () => ipcRenderer.invoke(IPC.workspacesList),
    add: (input) => ipcRenderer.invoke(IPC.workspacesAdd, input),
    remove: (id) => ipcRenderer.invoke(IPC.workspacesRemove, id),
    update: (id, patch) => ipcRenderer.invoke(IPC.workspacesUpdate, id, patch),
    pickDir: () => ipcRenderer.invoke(IPC.workspacesPickDir)
  },

  models: {
    list: () => ipcRenderer.invoke(IPC.modelsList),
    save: (config) => ipcRenderer.invoke(IPC.modelsSave, config),
    remove: (id) => ipcRenderer.invoke(IPC.modelsRemove, id),
    test: (config) => ipcRenderer.invoke(IPC.modelsTest, config)
  },

  gateway: {
    start: (configId, port) => ipcRenderer.invoke(IPC.gatewayStart, configId, port),
    stop: () => ipcRenderer.invoke(IPC.gatewayStop),
    state: () => ipcRenderer.invoke(IPC.gatewayState),
    onState: (cb) => {
      const listener = (_event: IpcRendererEvent, state: GatewayState): void => cb(state)
      ipcRenderer.on(IPC.eventGatewayState, listener)
      return () => {
        ipcRenderer.removeListener(IPC.eventGatewayState, listener)
      }
    }
  },

  launch: {
    run: (opts) => ipcRenderer.invoke(IPC.launchRun, opts),
    verify: (opts) => ipcRenderer.invoke(IPC.launchVerify, opts),
    sessions: () => ipcRenderer.invoke(IPC.launchSessions),
    onSession: (cb) => {
      const listener = (_event: IpcRendererEvent, session: LaunchSession): void => cb(session)
      ipcRenderer.on(IPC.eventLaunchSession, listener)
      return () => {
        ipcRenderer.removeListener(IPC.eventLaunchSession, listener)
      }
    }
  },

  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    set: (patch) => ipcRenderer.invoke(IPC.settingsSet, patch)
  }
}

// `contextBridge` only exists in a context-isolated renderer. In a plain Node
// context (tests/tooling) fall back to a global assignment of the *same wrapped
// API* — never `ipcRenderer` or any Node primitive, so isolation is preserved.
if (typeof contextBridge !== 'undefined' && typeof contextBridge.exposeInMainWorld === 'function') {
  contextBridge.exposeInMainWorld('ccdeck', api)
} else {
  ;(globalThis as typeof globalThis & { ccdeck?: CcDeckApi }).ccdeck = api
}
