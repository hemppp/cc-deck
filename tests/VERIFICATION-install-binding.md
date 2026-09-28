# Verification report — per-workspace Claude Code install selection

Task #2 · "验证：构建 + 选择生效 + 实机" · owner: workspace-install
Date: 2026-09-28 · Platform: win32 (headless CI shell)

## Verdict: **PASS** (with one environment limitation noted)

| # | Check | Result |
|---|-------|--------|
| 1 | `tsc --noEmit` node project | **PASS** |
| 2 | `tsc --noEmit` web project | **PASS** |
| 3 | `electron-vite build` (main/preload/renderer) | **PASS** |
| 4 | Existing suite: concurrency / drivers / pin / launch | **PASS** |
| 5 | New `tests/install-binding.test.mjs` (34 assertions) | **PASS** |
| 6 | Real-machine Electron launch | **PARTIAL** (see limitation) |
| 7 | UI wiring for install display / select / verify / sessions | **PASS** (static) |

## 1–3. Build & typecheck
- `npx tsc --noEmit -p tsconfig.node.json --composite false` → clean.
- `npx tsc --noEmit -p tsconfig.web.json --composite false` → clean.
- `npm run build` → main 108.33 kB, preload 3.92 kB, renderer built; no errors.

## 4–5. Test suite
`npm test` → EXIT 0. Sections:
- concurrency safety — passed
- driver checks — 17 ok
- pin regression — 6 ok
- launch verification — 22 ok
- **install-binding — 34 ok** (new, this task)

### What `install-binding.test.mjs` proves
Bundles `workspaces.ts` + `launch.ts` with in-memory stubs (no Electron), against
throwaway fake installs on disk:

- **A. Persistence** — `addWorkspace` defaults `installPath` to `null`; provided
  value is honoured; `updateWorkspace` persists it, keeps it when omitted, clears
  it on explicit `null`; survives a store round-trip; **legacy records without
  `installPath` read back as `null`** (and normalise on update).
- **B. Resolution precedence** — `opts.installPath` → `workspace.installPath` →
  active install. Resolved `installPath`/`version` track the chosen install;
  `requestedInstallPath` and `installMatches` are truthful; a bogus request is
  still honoured as the root with `version: null`.
- **C. `verifyLaunch`** — valid binding → `ok:true` (install-matches,
  install-version, executable-exists all pass); bogus binding → `ok:false`
  (executable-exists + install-version fail, install-selected still true).
- **D. End-to-end** — a workspace created via `addWorkspace()` is honoured by
  `buildLaunchPlan()` and verifies `ok`.

## 6. Real-machine limitation
`npx electron .` boots the main process (network/GPU service log lines appear)
but the sandbox has **no display**, so the app hangs on window creation and is
killed by timeout — not a crash, and no app-level error. A visual UI pass
("displays installed version / can select / verify passes / session recorded")
could **not** be performed here.

## 7. UI wiring verified statically (substitute evidence)
- `preload/index.ts` exposes `launch.run/verify/sessions/onSession` and
  `workspaces.add/update` — full bridge present.
- `ipc.ts` routes `workspacesAdd`/`workspacesUpdate` → `addWorkspace`/
  `updateWorkspace` (typed `Partial<Workspace>`), `launchVerify` → `verifyLaunch`,
  `installsSelect` → `selectInstall`.
- `WorkspacesPage.tsx` resolves per-workspace version (`resolveInstallVersion`),
  passes `installPath` on add/update/launch, renders verify results and session
  version; `InstallPicker.tsx` shows the chosen version + active fallback.

## Notes / residual risks
- In-app launch spawns a real child; in the sandbox it returns a handled error
  (`spawn EINVAL`) rather than throwing — acceptable, and `launchClaude` never
  throws by design.
- `launch.test.mjs` cleanup previously raced the spawned child (EBUSY on
  Windows); now waits for session exit + best-effort rm. Fixed by backend-launch.
