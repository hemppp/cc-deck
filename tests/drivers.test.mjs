/**
 * CC Deck — driver smoke tests (no Electron required, registry is read-only).
 *
 *   node tests/prepare.mjs && node tests/drivers.test.mjs
 *
 * Covers:
 *   A. claude-settings driver — apply / idempotency / revert against a throwaway
 *      CLAUDE_CONFIG_DIR (never touches the real config). Includes the
 *      platform-aware PATH separator behaviour.
 *   B. registry driver — read-only + dryRun only (never writes the registry).
 *
 * Exits non-zero on any failed assertion.
 */
import { claudeConfigDriver } from './.bundled/claude-config.mjs'
import { registryDriver } from './.bundled/registry.mjs'
import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const failures = []
const check = (n, c, d) => {
  if (c) console.log(`  ok   ${n}`)
  else {
    console.error(`  FAIL ${n}${d ? ` — ${d}` : ''}`)
    failures.push(n)
  }
}

/* ------------------------------------------------------------------ */
console.log('A. claude-settings driver (throwaway CLAUDE_CONFIG_DIR)')
{
  const sandbox = join(here, '.cfg')
  process.env.CLAUDE_CONFIG_DIR = sandbox
  await fs.rm(sandbox, { recursive: true, force: true })
  await fs.mkdir(sandbox, { recursive: true })

  const binDir = process.platform === 'win32' ? 'C:\\tools\\claude-custom' : '/opt/claude-custom'
  const ctx = { installPath: binDir, binDir, executable: null, prependPath: true, dryRun: false }

  const targets = await claudeConfigDriver.list()
  check('list() returns the settings target', targets.length === 1, JSON.stringify(targets.map((t) => t.id)))
  const target = targets[0]

  await fs.writeFile(target.location, JSON.stringify({ theme: 'dark', env: { FOO: 'bar' } }, null, 2))
  check('isApplied false before apply', (await claudeConfigDriver.isApplied(target, ctx)) === false)

  const out = await claudeConfigDriver.apply(target, ctx)
  check('apply changed the file', out.changed === true)
  check('backup captured previous content', out.backup.previous.includes('"FOO": "bar"'))

  const parsed = JSON.parse(await fs.readFile(target.location, 'utf8'))
  check('env.PATH contains binDir', typeof parsed.env.PATH === 'string' && parsed.env.PATH.includes(binDir))
  check('unrelated keys preserved', parsed.theme === 'dark' && parsed.env.FOO === 'bar')
  check('isApplied true after apply', (await claudeConfigDriver.isApplied(target, ctx)) === true)

  const out2 = await claudeConfigDriver.apply(target, ctx)
  check('second apply is a no-op (idempotent)', out2.changed === false)

  const rev = await claudeConfigDriver.revert(out.backup)
  check('revert ok', rev.ok === true, rev.message)
  const after = JSON.parse(await fs.readFile(target.location, 'utf8'))
  check('revert restored original content', after.theme === 'dark' && after.env.FOO === 'bar' && !after.env.PATH)

  await fs.rm(sandbox, { recursive: true, force: true })
}

/* ------------------------------------------------------------------ */
console.log('B. registry driver (read-only + dryRun)')
{
  const targets = await registryDriver.list()
  if (process.platform !== 'win32') {
    check('non-Windows: no targets', targets.length === 0)
  } else {
    check('two targets (user + system)', targets.length === 2, JSON.stringify(targets.map((t) => t.id)))
    const sys = targets.find((t) => t.id === 'registry-system')
    const usr = targets.find((t) => t.id === 'registry-user')
    check('system target requires elevation', sys?.requiresElevation === true && sys?.writable === false)
    check('user target writable, no elevation', usr?.writable === true && usr?.requiresElevation === false)

    const binDir = 'C:\\__cc_deck_absent__\\bin'
    const ctx = { installPath: binDir, binDir, executable: `${binDir}\\claude.cmd`, prependPath: true, dryRun: true }
    check('isApplied false for absent dir', (await registryDriver.isApplied(usr, ctx)) === false)

    const out = await registryDriver.apply(usr, ctx)
    check('dryRun reports a change without writing', out.changed === true)
    check('dryRun newValue prepends binDir', out.newValue.split(';')[0] === binDir)
    const count = out.newValue.split(';').filter((p) => p.toLowerCase() === binDir.toLowerCase()).length
    check('binDir appears exactly once', count === 1, `count=${count}`)
  }
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nAll driver checks passed.')
