# CC Deck

**A desktop control panel for Claude Code** — manage workspaces, route Claude Code to
local / custom models through a built-in Anthropic-compatible gateway, take control of
the Claude Code install path, and verify exactly what each workspace launches.

Built with **Electron + React + TypeScript**. English / 简体中文 UI.

---

## Features

- **🗂 Workspaces** — add project folders, launch Claude Code in them, and track every
  launch session (version, PID, running/exited).
- **🔌 Local model gateway** — a built-in proxy that exposes an Anthropic-compatible
  endpoint (`POST /v1/messages`, SSE streaming) and translates it to OpenAI-compatible
  or native Ollama providers — including tools / `tool_use` / `tool_result`.
- **📦 Install-path management** — detect Claude Code installs, pin a custom one, and
  apply it to the places that matter: **environment variables / PATH**, the **Windows
  registry** (`HKCU` / `HKLM`), **Unix shell profiles** (`.zshrc` / `.bashrc` / fish),
  and **`~/.claude/settings.json`** — with **concurrency safety** (cross-process locks,
  snapshot/hash conflict detection, atomic writes) and **one-click backups + revert**.
- **✅ Version display & launch verification** — see the installed Claude Code version,
  pick one per workspace, and run a dry-run `verify()` that reports whether the selected
  install will actually apply to the workspace (workspace valid, install matches,
  executable exists, gateway / model state).
- **🌐 English / 简体中文** — a global language toggle, persisted to settings.
- **🎨 Polished UI** — Tailwind design system, light/dark themes, motion, fully
  responsive modals, complete empty / loading / error states.

## Tech stack

| Layer | Technology |
|---|---|
| Shell | Electron 31 |
| Build | electron-vite 2 + Vite 5 |
| Language | TypeScript (strict, ESM) |
| UI | React 18, Tailwind CSS 3, zustand, framer-motion, lucide-react |
| Gateway | Express 4 (Anthropic ⇄ OpenAI / Ollama translation) |
| Persistence | electron-store |
| Packaging | electron-builder |

## Getting started

```bash
# install dependencies
npm install

# run in development (hot reload)
npm run dev

# type-check both the main and renderer projects
npm run typecheck

# run the test suites (concurrency, drivers, launch, install-binding)
npm test

# build the production bundles
npm run build

# package installers
npm run dist:win     # Windows (NSIS)
npm run dist:mac     # macOS (DMG)
npm run dist:linux   # Linux (AppImage)
```

> **Requirements:** Node.js 18+ and npm. The packaged app bundles Electron, so end users
> do not need Node.js.

## How it works

```
┌──────────────────────────────────────────────────────────────┐
│                        CC Deck (Electron)                    │
│                                                              │
│  Renderer (React)  ──window.ccdeck──▶  Preload (contextBridge)│
│        │                                      │              │
│        └──────────── IPC (ipcMain) ───────────┘              │
│                         │                                    │
│              Main process services                           │
│   ┌────────────┬────────────┬──────────────┬─────────────┐   │
│   │ installs   │ workspaces │ launch       │ models      │   │
│   │ install-   │            │ verify()     │ gateway     │   │
│   │ manager    │            │ sessions     │ (proxy)     │   │
│   └────────────┴────────────┴──────────────┴─────────────┘   │
│                         │                                    │
│        env drivers: registry · shell profile · claude.json   │
│        concurrency: withLock · snapshot · atomicWriteFile    │
└──────────────────────────────────────────────────────────────┘
                     │                        │
                     ▼                        ▼
            ~/.claude / registry      OpenAI-compatible / Ollama
```

- **Renderer** never touches Node/Electron directly — it only calls `window.ccdeck`
  (exposed by the preload with `contextIsolation` on, `nodeIntegration` off).
- **Gateway** translates the Anthropic Messages API (incl. streaming and tool calls)
  to your local/custom provider, so Claude Code can talk to any model.
- **Install-path mutation** is orchestrated with cross-process locks and atomic writes,
  and every change is journalled so it can be reverted.

## Project structure

```
cc-deck/
├── shared/                    # Frozen contract shared by main/preload/renderer
│   ├── types.ts               #   domain types + IPC channel constants
│   └── ipc.ts                 #   the CcDeckApi bridge interface
├── src/
│   ├── main/                  # Electron main process
│   │   ├── index.ts           #   window, single-instance lock, event forwarding
│   │   ├── ipc.ts             #   ipcMain handler registration
│   │   ├── store.ts           #   electron-store persistence
│   │   └── services/
│   │       ├── gateway.ts     #   Anthropic ⇄ OpenAI/Ollama proxy
│   │       ├── models.ts      #   model config CRUD + connectivity test
│   │       ├── installs.ts    #   install detection
│   │       ├── install-manager.ts  #  path mutation orchestration + backups
│   │       ├── workspaces.ts  #   workspace CRUD
│   │       ├── launch.ts      #   launch plan / verify / sessions
│   │       └── env/           #   mutation drivers + concurrency primitives
│   │           ├── driver.ts
│   │           ├── fs-lock.ts
│   │           ├── registry.ts        # Windows registry PATH
│   │           ├── unix-profile.ts    # shell profiles
│   │           └── claude-config.ts   # ~/.claude/settings.json
│   ├── preload/               # contextBridge API (window.ccdeck)
│   └── renderer/              # React UI
│       └── src/
│           ├── pages/         #   Workspaces / Models / Gateway / Settings
│           ├── components/    #   ui primitives + layout + install widgets
│           ├── store/         #   zustand stores
│           ├── i18n/          #   en / zh dictionaries + runtime
│           └── lib/
└── tests/                     # Node test suites (no Electron needed)
```

## Testing

The `tests/` suites run under plain Node (no Electron required) and cover the
trickiest parts of the app:

| Suite | Covers |
|---|---|
| `concurrency.test.mjs` | cross-process locking, lost-update prevention, idempotency, atomic writes |
| `drivers.test.mjs` | claude-settings driver apply/idempotency/revert; registry driver (read-only) |
| `pin.test.mjs` | custom install pin survives auto-detection |
| `launch.test.mjs` | per-workspace install resolution + `verify()` + sessions |
| `install-binding.test.mjs` | workspace `installPath` persistence + end-to-end resolution |

```bash
npm test
```

## License

[MIT](./LICENSE)
