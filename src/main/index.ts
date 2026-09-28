/**
 * CC Deck — Electron main-process bootstrap.
 *
 * Owns the app lifecycle: single-instance lock, the custom-titlebar main window,
 * IPC registration, gateway-state forwarding to the renderer, and graceful
 * shutdown. Paths are derived from `import.meta.url` because the main bundle is
 * emitted as ESM (`out/main/index.mjs`) and Node ESM has no `__dirname`.
 */
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, Menu, nativeTheme, shell } from 'electron'
import { IPC } from '@shared/types'
import type { ConflictEvent, GatewayState, LaunchSession } from '@shared/types'
import { registerIpc } from './ipc'
import { getGatewayState, onGatewayState, stopGateway } from './services/gateway'
import { onInstallMutation } from './services/install-manager'
import { onLaunchSession } from './services/launch'

const isDev = !app.isPackaged

/** Path helpers for the built output tree (out/main -> out/preload, out/renderer). */
const preloadPath = fileURLToPath(new URL('../preload/index.mjs', import.meta.url))
const rendererHtmlPath = fileURLToPath(new URL('../renderer/index.html', import.meta.url))

/** Background colours matching the renderer theme, avoids a white flash. */
const BG_DARK = '#0b0e14'
const BG_LIGHT = '#f8fafc'
const FG_DARK = '#e6e6e6'
const FG_LIGHT = '#1f2937'
/** Height of the native overlay window controls (matches the custom TitleBar). */
const TITLEBAR_HEIGHT = 40

let mainWindow: BrowserWindow | null = null
/** Guards against re-entrant `before-quit` handling during shutdown. */
let quitting = false

function createWindow(): void {
  const dark = nativeTheme.shouldUseDarkColors
  const bg = dark ? BG_DARK : BG_LIGHT
  const fg = dark ? FG_DARK : FG_LIGHT

  // Custom titlebar with working native window controls:
  //  - mac: 'hiddenInset' (traffic lights inset into our titlebar)
  //  - win/linux: 'hidden' + a native titleBarOverlay for min/max/close
  const titleBarOptions: Electron.BrowserWindowConstructorOptions =
    process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' }
      : {
          titleBarStyle: 'hidden',
          titleBarOverlay: { color: bg, symbolColor: fg, height: TITLEBAR_HEIGHT }
        }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: bg,
    ...titleBarOptions,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Keep DevTools reachable in dev even though we drop the app menu.
  if (isDev) {
    mainWindow.webContents.on('before-input-event', (_event, input) => {
      const isToggle =
        input.key === 'F12' ||
        (input.control && input.shift && input.key.toLowerCase() === 'i') ||
        (input.meta && input.alt && input.key.toLowerCase() === 'i')
      if (isToggle) mainWindow?.webContents.toggleDevTools()
    })
  }

  // Open external links in the system browser rather than inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (isDev && devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(rendererHtmlPath)
  }
}

/** Send gateway state to the renderer if a window is alive. */
function forwardGatewayState(state: GatewayState): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.eventGatewayState, state)
  }
}

/** Send a live install-mutation event to the renderer if a window is alive. */
function forwardInstallMutation(event: ConflictEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.eventInstallMutation, event)
  }
}

/** Send a launch-session start/exit event to the renderer if a window is alive. */
function forwardLaunchSession(session: LaunchSession): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.eventLaunchSession, session)
  }
}

/** Minimal app menu: none on Windows/Linux, a bare app menu on macOS. */
function installMenu(): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
    return
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { role: 'windowMenu' }
    ])
  )
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

// Single-instance lock: focus the existing window instead of spawning a second.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    registerIpc()
    installMenu()
    createWindow()

    // Bridge gateway service events -> renderer. Re-send the current snapshot
    // whenever a window (re)loads so the UI never starts stale.
    onGatewayState(forwardGatewayState)
    mainWindow?.webContents.on('did-finish-load', () => forwardGatewayState(getGatewayState()))

    // Bridge install-manager mutation/conflict events -> renderer.
    onInstallMutation(forwardInstallMutation)

    // Bridge launch-session start/exit events -> renderer.
    onLaunchSession(forwardLaunchSession)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  // Graceful shutdown: give the gateway a chance to close before we exit.
  app.on('before-quit', (event) => {
    if (quitting) return
    quitting = true
    event.preventDefault()
    void stopGateway()
      .catch(() => undefined)
      .finally(() => app.quit())
  })
}
