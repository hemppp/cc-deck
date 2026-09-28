/**
 * CC Deck — launch verification test (no Electron required).
 *
 *   node tests/prepare.mjs && node tests/launch.test.mjs
 *
 * Verifies that `buildLaunchPlan()` / `verifyLaunch()` resolve the CORRECT
 * Claude Code install for a workspace (per-workspace pin, explicit override,
 * fallback to active), and that `installMatches` / checks are truthful.
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
const outFile = join(outDir, 'launch.mjs')

/* ------------------------------------------------------------------ */
/* Fake installs on disk                                               */
/* ------------------------------------------------------------------ */
const base = join(tmpdir(), `ccdeck-launch-${process.pid}`)
async function makeInstall(name, version, withLauncher = true) {
  const dir = join(base, name)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(join(dir, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', version }))
  if (withLauncher) await fs.writeFile(join(dir, 'claude.cmd'), '@echo off\n')
  return dir
}
const installA = await makeInstall('A', '1.0.0')
const installB = await makeInstall('B', '2.0.0')
const installC = await makeInstall('C', '3.0.0') // known only as a custom pin (not "detected")
const installMissing = join(base, 'MISSING') // does not exist

const wsDir = join(base, 'ws')
await fs.mkdir(wsDir, { recursive: true })

/* ------------------------------------------------------------------ */
/* Stubs                                                               */
/* ------------------------------------------------------------------ */
const INSTALLS = [
  { path: installA, executable: join(installA, 'claude.cmd'), version: '1.0.0', source: 'npm-global', active: true, valid: true },
  { path: installB, executable: join(installB, 'claude.cmd'), version: '2.0.0', source: 'local-bin', active: false, valid: true }
]
const WORKSPACES = {
  wA: { id: 'wA', name: 'A', path: wsDir, modelConfigId: null, installPath: installB, createdAt: '', lastOpenedAt: null, color: null },
  wActive: { id: 'wActive', name: 'Active', path: wsDir, modelConfigId: null, installPath: null, createdAt: '', lastOpenedAt: null, color: null },
  wCustom: { id: 'wCustom', name: 'Custom', path: wsDir, modelConfigId: null, installPath: installC, createdAt: '', lastOpenedAt: null, color: null },
  wMissing: { id: 'wMissing', name: 'Missing', path: wsDir, modelConfigId: null, installPath: installMissing, createdAt: '', lastOpenedAt: null, color: null }
}

const stub = {
  name: 'stubs',
  setup(b) {
    const mod = (contents) => ({ contents, loader: 'js' })
    b.onResolve({ filter: /^\.\/workspaces$/ }, () => ({ path: 'workspaces', namespace: 'stub' }))
    b.onResolve({ filter: /^\.\/installs$/ }, () => ({ path: 'installs', namespace: 'stub' }))
    b.onResolve({ filter: /^\.\/gateway$/ }, () => ({ path: 'gateway', namespace: 'stub' }))
    b.onResolve({ filter: /^\.\.\/store$/ }, () => ({ path: 'store', namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => {
      if (args.path === 'workspaces')
        return mod(`
          export async function listWorkspaces(){ return globalThis.__WS__ || [] }
          export async function touchWorkspace(){}
        `)
      if (args.path === 'installs')
        return mod(`export async function detectInstalls(){ return globalThis.__INSTALLS__ || [] }`)
      if (args.path === 'gateway')
        return mod(`export function getActiveEnv(){ return globalThis.__ENV__ || {} }
          export function getGatewayState(){ return globalThis.__GW__ || { status:'stopped', port:null, baseUrl:null, activeConfigId:null, token:null, error:null, requestCount:0 } }`)
      return mod(`export function getSettings(){ return { launchMode: 'in-app' } }`)
    })
  }
}

await build({
  entryPoints: [join(root, 'src/main/services/launch.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  outfile: outFile,
  plugins: [stub],
  external: ['node:*'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'warning'
})

const mod = await import(pathToFileURL(outFile).href)
globalThis.__INSTALLS__ = INSTALLS
globalThis.__ENV__ = { ANTHROPIC_MODEL: 'local-model', ANTHROPIC_BASE_URL: 'http://127.0.0.1:8788' }
globalThis.__GW__ = { status: 'running', port: 8788, baseUrl: 'http://127.0.0.1:8788', activeConfigId: 'm1', token: 'tok', error: null, requestCount: 3 }

const failures = []
const check = (n, c, d) => {
  if (c) console.log(`  ok   ${n}`)
  else {
    console.error(`  FAIL ${n}${d ? ` — ${d}` : ''}`)
    failures.push(n)
  }
}
const norm = (p) => (p || '').replace(/\\/g, '/').toLowerCase()

console.log('1. per-workspace pin resolves that install')
{
  globalThis.__WS__ = [WORKSPACES.wA]
  const v = await mod.verifyLaunch({ workspaceId: 'wA', modelConfigId: null })
  check('plan.installPath = workspace install (B)', norm(v.plan.installPath) === norm(installB), v.plan.installPath)
  check('plan.version = 2.0.0', v.plan.version === '2.0.0', v.plan.version)
  check('installMatches true', v.plan.installMatches === true)
  check('verification ok', v.ok === true, v.message)
}

console.log('2. no pin falls back to the active install')
{
  globalThis.__WS__ = [WORKSPACES.wActive]
  const v = await mod.verifyLaunch({ workspaceId: 'wActive', modelConfigId: null })
  check('plan.installPath = active install (A)', norm(v.plan.installPath) === norm(installA), v.plan.installPath)
  check('plan.version = 1.0.0', v.plan.version === '1.0.0', v.plan.version)
  check('installMatches true', v.plan.installMatches === true)
}

console.log('3. custom pin not in detector list still resolves')
{
  globalThis.__WS__ = [WORKSPACES.wCustom]
  const v = await mod.verifyLaunch({ workspaceId: 'wCustom', modelConfigId: null })
  check('plan.installPath = custom install (C)', norm(v.plan.installPath) === norm(installC), v.plan.installPath)
  check('plan.version = 3.0.0 (from package.json)', v.plan.version === '3.0.0', v.plan.version)
  check('executable-exists ok', v.checks.find((c) => c.id === 'executable-exists')?.ok === true)
  check('installMatches true', v.plan.installMatches === true)
}

console.log('4. explicit override wins over the workspace pin')
{
  globalThis.__WS__ = [WORKSPACES.wA] // pinned to B
  const v = await mod.verifyLaunch({ workspaceId: 'wA', modelConfigId: null, installPath: installA })
  check('plan.installPath = override (A)', norm(v.plan.installPath) === norm(installA), v.plan.installPath)
  check('plan.version = 1.0.0', v.plan.version === '1.0.0', v.plan.version)
}

console.log('5. missing install is flagged, not silently ignored')
{
  globalThis.__WS__ = [WORKSPACES.wMissing]
  const v = await mod.verifyLaunch({ workspaceId: 'wMissing', modelConfigId: null })
  const ex = v.checks.find((c) => c.id === 'executable-exists')
  check('executable-exists fails', ex?.ok === false, JSON.stringify(ex))
  check('verification not ok', v.ok === false, v.message)
}

console.log('6. unknown workspace is flagged')
{
  globalThis.__WS__ = [WORKSPACES.wActive]
  const v = await mod.verifyLaunch({ workspaceId: 'nope', modelConfigId: null })
  check('workspace-exists fails', v.checks.find((c) => c.id === 'workspace-exists')?.ok === false)
  check('verification not ok', v.ok === false)
}

console.log('7. launchClaude records a session and returns resolved install')
{
  globalThis.__WS__ = [WORKSPACES.wA]
  // Point the executable at a harmless command so the spawn succeeds.
  const before = mod.getSessions().length
  const res = await mod.launchClaude({ workspaceId: 'wA', modelConfigId: null })
  check('launch ok (in-app spawn of the .cmd launcher succeeds)', res.ok === true, res.error)
  check('result.installPath = B', norm(res.installPath) === norm(installB), res.installPath)
  check('result.version = 2.0.0', res.version === '2.0.0', res.version)
  check('session recorded', mod.getSessions().length === before + 1)
  check('result has checks', Array.isArray(res.checks) && res.checks.length > 0)
}

// Wait for any in-app session spawned by test 7 to exit before removing the temp
// tree: on Windows the child holds the workspace dir as its cwd, so an immediate
// `fs.rm` races the process exit and fails with EBUSY.
for (let i = 0; i < 100; i++) {
  if (mod.getSessions().every((s) => s.status === 'exited')) break
  await new Promise((r) => setTimeout(r, 50))
}
try {
  await fs.rm(base, { recursive: true, force: true })
} catch (e) {
  console.log(`  info temp cleanup skipped (${e.code})`)
}
await fs.rm(outFile, { force: true })

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nLaunch verification checks passed.')
