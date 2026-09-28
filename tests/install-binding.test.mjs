/**
 * CC Deck — per-workspace install binding verification (no Electron required).
 *
 *   node tests/install-binding.test.mjs
 *
 * Bundles `src/main/services/workspaces.ts` and `src/main/services/launch.ts`
 * with in-memory stubs for `electron`, `../store`, `./installs` and `./gateway`
 * so the launch-plan resolution and workspace persistence can be exercised
 * deterministically against throwaway fake installs on disk.
 *
 * Covers:
 *   A. Workspace persistence: add/update/read of `installPath`, legacy records
 *      (no `installPath`) normalise to null on read.
 *   B. buildLaunchPlan install resolution precedence:
 *      opts.installPath -> workspace.installPath -> active install, and that the
 *      resolved version/executable track the chosen install.
 *   C. verifyLaunch checks for a valid binding (ok) vs a bogus binding (fails).
 *   D. End-to-end: workspace created via addWorkspace() is honoured by the plan.
 *
 * Exits non-zero on any failed assertion.
 */
import { build } from 'esbuild'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const outDir = join(here, '.bundled')
await fs.mkdir(outDir, { recursive: true })

const IS_WIN = process.platform === 'win32'

const stubPlugin = {
  name: 'stubs',
  setup(b) {
    b.onResolve({ filter: /^\.\.\/store$/ }, () => ({ path: 'store-stub', namespace: 'stub' }))
    b.onResolve({ filter: /^\.\/installs$/ }, () => ({ path: 'installs-stub', namespace: 'stub' }))
    b.onResolve({ filter: /^\.\/gateway$/ }, () => ({ path: 'gateway-stub', namespace: 'stub' }))
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron-stub', namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => {
      if (args.path === 'store-stub') {
        return {
          contents: `
            const g = globalThis
            g.__STORE__ = g.__STORE__ || { workspaces: [], settings: { launchMode: 'in-app' }, active: null, backups: [], models: [] }
            export function getWorkspaces(){ return g.__STORE__.workspaces }
            export function setWorkspaces(w){ g.__STORE__.workspaces = w; return w }
            export function getSettings(){ return g.__STORE__.settings }
            export function setSettings(s){ g.__STORE__.settings = s; return s }
            export function getActiveInstallPath(){ return g.__STORE__.active }
            export function setActiveInstallPath(p){ g.__STORE__.active = p; return p }
            export function getModelConfigs(){ return g.__STORE__.models }
            export function setModelConfigs(c){ g.__STORE__.models = c; return c }
            export function getBackups(){ return g.__STORE__.backups }
            export function setBackups(b){ g.__STORE__.backups = b; return b }
            export default {}
          `,
          loader: 'js'
        }
      }
      if (args.path === 'installs-stub') {
        return {
          contents: `
            export async function detectInstalls(){ return globalThis.__INSTALLS__ || [] }
            export function onActiveInstallChange(){ return () => {} }
            export function setActiveInstall(){}
            export async function selectInstall(){ return [] }
            export async function pickInstallDir(){ return null }
          `,
          loader: 'js'
        }
      }
      if (args.path === 'gateway-stub') {
        return {
          contents: `
            export function getActiveEnv(){ return globalThis.__ENV__ || {} }
            export function getGatewayState(){
              return globalThis.__GW__ || { status: 'stopped', port: null, baseUrl: null, activeConfigId: null, token: null, error: null, requestCount: 0 }
            }
            export function onGatewayState(){ return () => {} }
          `,
          loader: 'js'
        }
      }
      return {
        contents: `export const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
          export const app = { getPath: () => ${JSON.stringify(tmpdir())} }
          export default { dialog, app }`,
        loader: 'js'
      }
    })
  }
}

async function bundle(entry, out) {
  await build({
    entryPoints: [join(root, entry)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node18',
    outfile: join(outDir, out),
    plugins: [stubPlugin],
    external: ['node:*'],
    banner: {
      js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"
    },
    logLevel: 'warning'
  })
  return import(pathToFileURL(join(outDir, out)).href)
}

const ws = await bundle('src/main/services/workspaces.ts', 'binding-workspaces.mjs')
const launch = await bundle('src/main/services/launch.ts', 'binding-launch.mjs')

const failures = []
const check = (n, c, d) => {
  if (c) console.log(`  ok   ${n}`)
  else {
    console.error(`  FAIL ${n}${d ? ` — ${d}` : ''}`)
    failures.push(n)
  }
}

/* ------------------------------------------------------------------ */
/* Fixtures: throwaway fake installs + a workspace dir on disk         */
/* ------------------------------------------------------------------ */

const sandbox = join(tmpdir(), `ccdeck-binding-${process.pid}`)
await fs.rm(sandbox, { recursive: true, force: true })

const launcherName = IS_WIN ? 'claude.cmd' : 'claude'

async function makeInstall(name, version) {
  const dir = join(sandbox, name)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: '@anthropic-ai/claude-code', version })
  )
  const exe = join(dir, launcherName)
  await fs.writeFile(exe, IS_WIN ? '@echo off\r\n' : '#!/bin/sh\n')
  if (!IS_WIN) await fs.chmod(exe, 0o755)
  return { path: dir, executable: exe, version, source: 'custom', active: false, valid: true }
}

const installA = await makeInstall('install-a', '1.1.1')
const installB = await makeInstall('install-b', '2.2.2')
const workspaceDir = join(sandbox, 'workspace')
await fs.mkdir(workspaceDir, { recursive: true })
const bogusInstall = join(sandbox, 'does-not-exist-install')

const resetStore = (workspaces = []) => {
  globalThis.__STORE__ = {
    workspaces,
    settings: { launchMode: 'in-app' },
    active: null,
    backups: [],
    models: []
  }
}
// Detection: A is the active install; B is a valid but inactive install.
globalThis.__INSTALLS__ = [{ ...installA, active: true }, { ...installB, active: false }]
globalThis.__ENV__ = {}
globalThis.__GW__ = {
  status: 'stopped',
  port: null,
  baseUrl: null,
  activeConfigId: null,
  token: null,
  error: null,
  requestCount: 0
}

/* ------------------------------------------------------------------ */
console.log('A. workspace persistence of installPath')
{
  resetStore()
  const a = await ws.addWorkspace({ name: 'A', path: workspaceDir })
  check('addWorkspace defaults installPath to null', a.installPath === null, `got ${a.installPath}`)

  const b = await ws.addWorkspace({ name: 'B', path: workspaceDir, installPath: installB.path })
  check('addWorkspace honours provided installPath', b.installPath === installB.path, `got ${b.installPath}`)

  const list = await ws.listWorkspaces()
  check('listWorkspaces returns both', list.length === 2, `got ${list.length}`)

  const upd = await ws.updateWorkspace(a.id, { installPath: installB.path })
  check('updateWorkspace persists installPath', upd.installPath === installB.path, `got ${upd.installPath}`)
  const reread = (await ws.listWorkspaces()).find((w) => w.id === a.id)
  check('installPath survives a store round-trip', reread?.installPath === installB.path, `got ${reread?.installPath}`)

  const keep = await ws.updateWorkspace(b.id, { name: 'B renamed' })
  check('updateWorkspace keeps installPath when omitted', keep.installPath === installB.path, `got ${keep.installPath}`)
  check('updateWorkspace still applies other fields', keep.name === 'B renamed', `got ${keep.name}`)

  const cleared = await ws.updateWorkspace(b.id, { installPath: null })
  check('updateWorkspace can clear installPath to null', cleared.installPath === null, `got ${cleared.installPath}`)

  // Legacy record: written before installPath existed.
  resetStore([
    {
      id: 'legacy-1',
      name: 'Legacy',
      path: workspaceDir,
      modelConfigId: null,
      createdAt: '2020-01-01T00:00:00.000Z',
      lastOpenedAt: null,
      color: null
    }
  ])
  const legacyList = await ws.listWorkspaces()
  check('legacy record without installPath reads back as null', legacyList[0]?.installPath === null, `got ${legacyList[0]?.installPath}`)

  const legacyUpd = await ws.updateWorkspace('legacy-1', { name: 'Legacy v2' })
  check('updating a legacy record normalises installPath to null', legacyUpd.installPath === null, `got ${legacyUpd.installPath}`)
}

/* ------------------------------------------------------------------ */
console.log('B. buildLaunchPlan install resolution precedence')
{
  resetStore([
    { id: 'ws-b', name: 'Bound to B', path: workspaceDir, modelConfigId: null, installPath: installB.path, createdAt: 'x', lastOpenedAt: null, color: null },
    { id: 'ws-none', name: 'Unbound', path: workspaceDir, modelConfigId: null, installPath: null, createdAt: 'x', lastOpenedAt: null, color: null }
  ])

  const planB = await launch.buildLaunchPlan({ workspaceId: 'ws-b' })
  check('workspace.installPath selects install B', planB.installPath === installB.path, `got ${planB.installPath}`)
  check('resolved version tracks install B', planB.version === '2.2.2', `got ${planB.version}`)
  check('requestedInstallPath is the workspace pin', planB.requestedInstallPath === installB.path, `got ${planB.requestedInstallPath}`)
  check('installMatches true for bound workspace', planB.installMatches === true)

  const planNone = await launch.buildLaunchPlan({ workspaceId: 'ws-none' })
  check('unbound workspace falls back to active install A', planNone.installPath === installA.path, `got ${planNone.installPath}`)
  check('fallback resolves active version 1.1.1', planNone.version === '1.1.1', `got ${planNone.version}`)
  check('no requested path when unbound', planNone.requestedInstallPath === null, `got ${planNone.requestedInstallPath}`)
  check('installMatches true against active install', planNone.installMatches === true)

  const planOverride = await launch.buildLaunchPlan({ workspaceId: 'ws-b', installPath: installA.path })
  check('opts.installPath overrides the workspace pin', planOverride.installPath === installA.path, `got ${planOverride.installPath}`)
  check('override resolves version 1.1.1', planOverride.version === '1.1.1', `got ${planOverride.version}`)
  check('override installMatches true', planOverride.installMatches === true)

  const planBogus = await launch.buildLaunchPlan({ workspaceId: 'ws-b', installPath: bogusInstall })
  check('bogus request is still honoured as install root', planBogus.installPath === bogusInstall, `got ${planBogus.installPath}`)
  check('bogus request has no version', planBogus.version === null, `got ${planBogus.version}`)
}

/* ------------------------------------------------------------------ */
console.log('C. verifyLaunch for a valid vs a bogus binding')
{
  resetStore([
    { id: 'ws-b', name: 'Bound to B', path: workspaceDir, modelConfigId: null, installPath: installB.path, createdAt: 'x', lastOpenedAt: null, color: null }
  ])

  const good = await launch.verifyLaunch({ workspaceId: 'ws-b' })
  check('valid binding verifies ok', good.ok === true, good.message)
  check('valid binding passes install-matches', good.checks.find((c) => c.id === 'install-matches')?.ok === true)
  check('valid binding passes install-version', good.checks.find((c) => c.id === 'install-version')?.ok === true)
  check('valid binding passes executable-exists', good.checks.find((c) => c.id === 'executable-exists')?.ok === true)

  const bad = await launch.verifyLaunch({ workspaceId: 'ws-b', installPath: bogusInstall })
  check('bogus binding fails verification', bad.ok === false, bad.message)
  check('bogus binding fails executable-exists', bad.checks.find((c) => c.id === 'executable-exists')?.ok === false)
  check('bogus binding fails install-version', bad.checks.find((c) => c.id === 'install-version')?.ok === false)
  check('bogus binding still resolves a path (install-selected)', bad.checks.find((c) => c.id === 'install-selected')?.ok === true)
}

/* ------------------------------------------------------------------ */
console.log('D. end-to-end: addWorkspace -> buildLaunchPlan honours the binding')
{
  resetStore()
  const created = await ws.addWorkspace({ name: 'E2E', path: workspaceDir, installPath: installB.path })
  const plan = await launch.buildLaunchPlan({ workspaceId: created.id })
  check('plan uses the freshly persisted workspace binding', plan.installPath === installB.path, `got ${plan.installPath}`)
  check('plan version matches bound install', plan.version === '2.2.2', `got ${plan.version}`)

  const verify = await launch.verifyLaunch({ workspaceId: created.id })
  check('end-to-end verification passes', verify.ok === true, verify.message)
}

/* ------------------------------------------------------------------ */
await fs.rm(sandbox, { recursive: true, force: true })

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nAll install-binding checks passed.')
