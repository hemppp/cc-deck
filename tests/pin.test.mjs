/**
 * Regression test: applying a CUSTOM install path must not let auto-detection
 * clobber the pinned path.
 *
 *   node tests/prepare.mjs && node tests/pin.test.mjs
 *
 * Bundles install-manager + installs with in-memory stubs for `../store` and
 * `electron`, so no Electron runtime is required.
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
const outFile = join(outDir, 'pin-manager.mjs')

const stubPlugin = {
  name: 'stubs',
  setup(b) {
    b.onResolve({ filter: /^\.\.\/store$/ }, () => ({ path: 'store-stub', namespace: 'stub' }))
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron-stub', namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => {
      if (args.path === 'store-stub') {
        return {
          contents: `
            const g = globalThis
            g.__STORE__ = g.__STORE__ || { active: null, backups: [] }
            export function getActiveInstallPath(){ return g.__STORE__.active }
            export function setActiveInstallPath(p){ g.__STORE__.active = p; return p }
            export function getBackups(){ return g.__STORE__.backups }
            export function setBackups(b){ g.__STORE__.backups = b; return b }
            export function getModelConfigs(){ return [] }
            export function setModelConfigs(c){ return c }
            export function getWorkspaces(){ return [] }
            export function setWorkspaces(w){ return w }
            export function getSettings(){ return {} }
            export function setSettings(s){ return s }
            export default {}
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

await build({
  entryPoints: [join(root, 'src/main/services/install-manager.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  outfile: outFile,
  plugins: [stubPlugin],
  external: ['node:*'],
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"
  },
  logLevel: 'warning'
})

const mgr = await import(pathToFileURL(outFile).href)

const failures = []
const check = (n, c, d) => {
  if (c) console.log(`  ok   ${n}`)
  else {
    console.error(`  FAIL ${n}${d ? ` — ${d}` : ''}`)
    failures.push(n)
  }
}

// A fake custom Claude Code install that auto-detection will NOT discover.
const fake = join(tmpdir(), `ccdeck-fake-${process.pid}`)
await fs.rm(fake, { recursive: true, force: true })
await fs.mkdir(fake, { recursive: true })
await fs.writeFile(
  join(fake, 'package.json'),
  JSON.stringify({ name: '@anthropic-ai/claude-code', version: '9.9.9-test' })
)

console.log('regression: custom pin survives detectInstalls()')
{
  // Simulate what applyInstall does internally: pin, then detect.
  globalThis.__STORE__ = { active: fake, backups: [] }
  const installs = await mgr.installStatus()
  check('status.installPath keeps the custom pin', installs.installPath === fake, `got ${installs.installPath}`)

  // And full applyInstall on the fake install (claude-settings target in a sandbox).
  const sandbox = join(here, '.cfg')
  process.env.CLAUDE_CONFIG_DIR = sandbox
  await fs.rm(sandbox, { recursive: true, force: true })
  await fs.mkdir(sandbox, { recursive: true })

  globalThis.__STORE__ = { active: null, backups: [] }
  // Discover the real target id (claude-settings driver ids include the path).
  const pre = await mgr.installStatus()
  const settingsTarget = pre.targets.find((t) => t.kind === 'claude-settings')
  check('claude-settings target is offered', !!settingsTarget, JSON.stringify(pre.targets.map((t) => t.id)))

  const res = await mgr.applyInstall({
    installPath: fake,
    targetIds: [settingsTarget.id],
    prependPath: true
  })
  check('applyInstall ok', res.ok === true, JSON.stringify(res.results))
  check('backup recorded', res.backupId != null && globalThis.__STORE__.backups.length === 1)

  const st = await mgr.installStatus()
  check('pin NOT clobbered by auto-detection after apply', st.installPath === fake, `got ${st.installPath}`)
  check('status.pathResolvesTo reflects real PATH (may be null)', st.pathResolvesTo === null || typeof st.pathResolvesTo === 'string')

  await fs.rm(sandbox, { recursive: true, force: true })
}

await fs.rm(fake, { recursive: true, force: true })
await fs.rm(outFile, { force: true })

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nPin regression checks passed.')
