/**
 * CC Deck — launch routing tests (no Electron required).
 *
 *   node tests/launch-routing.test.mjs
 *
 * Verifies the "custom API / key takes effect" fix end-to-end at the service
 * layer, without spawning anything:
 *
 *   A. resolveEffectiveConfig precedence
 *   B. buildLaunchPlan({autoStart:true}) brings the gateway up for the effective
 *      config and injects the gateway env
 *   C. an already-running matching gateway is reused (no restart)
 *   D. a native Anthropic-compatible config is injected DIRECTLY
 *      (ANTHROPIC_API_KEY, never ANTHROPIC_AUTH_TOKEN) and never starts the gateway
 *   E. verifyLaunch() is side-effect free (never starts the gateway)
 *   F. an unroutable translated config fails the `routing-mode` check
 *
 * Exits non-zero on any failed assertion.
 */
import { build } from 'esbuild'
import { mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const outDir = join(root, 'node_modules', '.cc-deck-routing')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const launchOut = join(outDir, 'launch.mjs')
const gatewayOut = join(outDir, 'gateway.mjs')

const GATEWAY_STUB = `
  export function getActiveEnv(config){
    if (config && config.kind === 'anthropic') {
      const env = { ANTHROPIC_BASE_URL: (config.baseUrl||'').replace(/\\/+$/,'').replace(/\\/v1\\/messages$/,'').replace(/\\/messages$/,'').replace(/\\/v1$/,'') }
      if (config.apiKey) env.ANTHROPIC_API_KEY = config.apiKey
      if (config.model) env.ANTHROPIC_MODEL = config.model
      return env
    }
    const gw = globalThis.__GW__ || {}
    if (gw.status !== 'running' || !gw.baseUrl) return {}
    if (config && gw.activeConfigId !== config.id) return {}
    const env = { ANTHROPIC_BASE_URL: gw.baseUrl }
    if (gw.token) env.ANTHROPIC_AUTH_TOKEN = gw.token
    const model = gw.model || (config && config.model)
    if (model) env.ANTHROPIC_MODEL = model
    return env
  }
  export function getGatewayState(){
    return globalThis.__GW__ || { status:'stopped', port:null, baseUrl:null, activeConfigId:null, token:null, error:null, requestCount:0 }
  }
  export async function startGateway(id, port){
    globalThis.__START_CALLS__ = globalThis.__START_CALLS__ || []
    globalThis.__START_CALLS__.push({ id, port })
    if (globalThis.__START_THROWS__) {
      const s = { status:'error', port:null, baseUrl:null, activeConfigId:id, token:null, error:'boom', requestCount:0 }
      globalThis.__GW__ = s
      return s
    }
    const cfg = (globalThis.__MODELS__ || []).find((m) => m.id === id)
    const s = { status:'running', port: port || 8788, baseUrl: 'http://127.0.0.1:' + (port || 8788), activeConfigId:id, token:'tok', error:null, requestCount:0, model: cfg ? cfg.model : null }
    globalThis.__GW__ = s
    return s
  }
`

const launchStub = {
  name: 'launch-stubs',
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
      if (args.path === 'gateway') return mod(GATEWAY_STUB)
      return mod(`
        export function getSettings(){ return globalThis.__SETTINGS__ || { launchMode:'in-app', gatewayPort:0, defaultModelConfigId:null } }
        export function getModelConfigs(){ return globalThis.__MODELS__ || [] }
      `)
    })
  }
}

const storeStub = {
  name: 'store-stub',
  setup(b) {
    b.onResolve({ filter: /^\.\.\/store$/ }, () => ({ path: 'store', namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'export function getModelConfigs(){ return globalThis.__MODELS__ || [] }\n',
      loader: 'js'
    }))
  }
}

const banner = {
  js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"
}

await build({
  entryPoints: [join(root, 'src/main/services/launch.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  outfile: launchOut,
  plugins: [launchStub],
  external: ['node:*'],
  banner,
  logLevel: 'warning'
})

await build({
  entryPoints: [join(root, 'src/main/services/gateway.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  outfile: gatewayOut,
  plugins: [storeStub],
  banner,
  logLevel: 'warning'
})

const mod = await import(pathToFileURL(launchOut).href)
const gw = await import(pathToFileURL(gatewayOut).href)

const failures = []
const check = (n, c, d) => {
  if (c) console.log(`  ok   ${n}`)
  else {
    console.error(`  FAIL ${n}${d ? ` — ${d}` : ''}`)
    failures.push(n)
  }
}

const STOPPED = { status: 'stopped', port: null, baseUrl: null, activeConfigId: null, token: null, error: null, requestCount: 0 }

const CFG = {
  anth: { id: 'm-anth', name: 'Anthropic relay', kind: 'anthropic', baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-real', model: 'claude-sonnet-4', createdAt: '' },
  oai: { id: 'm-oai', name: 'DeepSeek', kind: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-oai', model: 'deepseek-chat', createdAt: '' },
  ollama: { id: 'm-ollama', name: 'Ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', apiKey: '', model: 'qwen2.5-coder:14b', createdAt: '' }
}

const WS = { id: 'w1', name: 'W', path: process.cwd(), modelConfigId: null, installPath: null, createdAt: '', lastOpenedAt: null, color: null }

function reset({ ws = [], models = [], settings = {}, gtw = STOPPED, startThrows = false } = {}) {
  globalThis.__WS__ = ws
  globalThis.__MODELS__ = models
  globalThis.__SETTINGS__ = { launchMode: 'in-app', gatewayPort: 0, defaultModelConfigId: null, ...settings }
  globalThis.__GW__ = gtw
  globalThis.__START_CALLS__ = []
  globalThis.__START_THROWS__ = startThrows
  globalThis.__INSTALLS__ = []
}

console.log('A. resolveEffectiveConfig precedence')
{
  reset()
  check('opts.modelConfigId wins', mod.resolveEffectiveConfig({ modelConfigId: 'm-oai' }, { ...WS, modelConfigId: 'm-anth' }, { defaultModelConfigId: 'm-ollama' }, [CFG.oai, CFG.anth, CFG.ollama], null)?.id === 'm-oai')
  check('workspace pin next', mod.resolveEffectiveConfig({}, { ...WS, modelConfigId: 'm-anth' }, { defaultModelConfigId: 'm-ollama' }, [CFG.oai, CFG.anth, CFG.ollama], null)?.id === 'm-anth')
  check('settings default next', mod.resolveEffectiveConfig({}, WS, { defaultModelConfigId: 'm-ollama' }, [CFG.oai, CFG.anth, CFG.ollama], null)?.id === 'm-ollama')
  check('active gateway config next', mod.resolveEffectiveConfig({}, WS, { defaultModelConfigId: null }, [CFG.oai, CFG.anth], 'm-anth')?.id === 'm-anth')
  check('first config fallback', mod.resolveEffectiveConfig({}, WS, {}, [CFG.oai, CFG.anth], null)?.id === 'm-oai')
  check('null when nothing configured', mod.resolveEffectiveConfig({}, WS, {}, [], null) === null)
}

console.log('B. autoStart brings the gateway up for the effective config')
{
  reset({ ws: [{ ...WS, modelConfigId: 'm-oai' }], models: [CFG.oai, CFG.anth], settings: { gatewayPort: 8899 } })
  const plan = await mod.buildLaunchPlan({ workspaceId: 'w1' }, { autoStart: true })
  check('startGateway called with the effective id', globalThis.__START_CALLS__.length === 1 && globalThis.__START_CALLS__[0].id === 'm-oai', JSON.stringify(globalThis.__START_CALLS__))
  check('startGateway got the configured port', globalThis.__START_CALLS__[0]?.port === 8899)
  check('plan.env has gateway base URL', plan.env.ANTHROPIC_BASE_URL === 'http://127.0.0.1:8899')
  check('plan.env has gateway token (not the real key)', !!plan.env.ANTHROPIC_AUTH_TOKEN && !plan.env.ANTHROPIC_API_KEY)
  check('plan.model is the routed model', plan.model === 'deepseek-chat')
  check('gatewayRunning true', plan.gatewayRunning === true)
}

console.log('C. already-running matching gateway is reused')
{
  reset({
    ws: [{ ...WS, modelConfigId: 'm-oai' }],
    models: [CFG.oai],
    gtw: { status: 'running', port: 8899, baseUrl: 'http://127.0.0.1:8899', activeConfigId: 'm-oai', token: 'tok', error: null, requestCount: 5, model: 'deepseek-chat' }
  })
  const plan = await mod.buildLaunchPlan({ workspaceId: 'w1' }, { autoStart: true })
  check('no new start call', globalThis.__START_CALLS__.length === 0)
  check('env still injected', plan.env.ANTHROPIC_BASE_URL === 'http://127.0.0.1:8899')
}

console.log('D. anthropic config is injected directly (no gateway)')
{
  reset({ ws: [{ ...WS, modelConfigId: 'm-anth' }], models: [CFG.anth], settings: { gatewayPort: 8899 } })
  const plan = await mod.buildLaunchPlan({ workspaceId: 'w1' }, { autoStart: true })
  check('startGateway NOT called', globalThis.__START_CALLS__.length === 0)
  check('ANTHROPIC_BASE_URL normalised (no /v1)', plan.env.ANTHROPIC_BASE_URL === 'https://relay.example.com')
  check('ANTHROPIC_API_KEY = real key', plan.env.ANTHROPIC_API_KEY === 'sk-real')
  check('no ANTHROPIC_AUTH_TOKEN', plan.env.ANTHROPIC_AUTH_TOKEN === undefined)
  check('ANTHROPIC_MODEL injected', plan.env.ANTHROPIC_MODEL === 'claude-sonnet-4')
}

console.log('E. verifyLaunch is side-effect free')
{
  reset({ ws: [{ ...WS, modelConfigId: 'm-oai' }], models: [CFG.oai] })
  const v = await mod.verifyLaunch({ workspaceId: 'w1' })
  check('startGateway NOT called during verify', globalThis.__START_CALLS__.length === 0)
  const routing = v.checks.find((c) => c.id === 'routing-mode')
  check('routing-mode check present', !!routing)
  check('routing-mode ok (startable)', routing?.ok === true, routing?.detail)
}

console.log('F. unroutable translated config fails routing-mode')
{
  reset({ ws: [{ ...WS, modelConfigId: 'm-bad' }], models: [{ ...CFG.oai, id: 'm-bad', name: 'Bad', baseUrl: '' }] })
  const v = await mod.verifyLaunch({ workspaceId: 'w1' })
  const routing = v.checks.find((c) => c.id === 'routing-mode')
  check('routing-mode fails', routing?.ok === false, routing?.detail)
  check('verification not ok', v.ok === false)
}

console.log('G. gateway env helpers (real gateway.ts)')
{
  globalThis.__MODELS__ = []
  check('directEnvFor(anthropic) normalises + uses API key', (() => {
    const e = gw.directEnvFor({ kind: 'anthropic', baseUrl: 'https://r.example.com/v1/messages', apiKey: 'k', model: 'm' })
    return e.ANTHROPIC_BASE_URL === 'https://r.example.com' && e.ANTHROPIC_API_KEY === 'k' && e.ANTHROPIC_MODEL === 'm' && e.ANTHROPIC_AUTH_TOKEN === undefined
  })())
  check('directEnvFor(non-anthropic) empty', Object.keys(gw.directEnvFor({ kind: 'openai-compatible', baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' })).length === 0)
  check('getActiveEnv(anthropic) works while gateway stopped', gw.getActiveEnv({ kind: 'anthropic', baseUrl: 'https://r.example.com/v1', apiKey: 'k', model: 'm' }).ANTHROPIC_API_KEY === 'k')
  check('getActiveEnv() with no arg is empty while stopped', Object.keys(gw.getActiveEnv()).length === 0)
}

if (failures.length) {
  console.error(`\n${failures.length} routing check(s) failed.`)
  process.exit(1)
}
console.log('\nAll launch-routing checks passed.')
