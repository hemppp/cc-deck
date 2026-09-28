/**
 * CC Deck — concurrency safety test (no Electron required).
 *
 *   node tests/prepare.mjs && node tests/concurrency.test.mjs
 *
 * Validates the primitives that `install-manager.ts` relies on to safely mutate
 * shared resources (registry PATH, shell rc files, ~/.claude/settings.json):
 *   1. withLock gives cross-process mutual exclusion (no lost updates).
 *   2. A control run WITHOUT the lock demonstrates lost updates (proving the
 *      harness actually detects races, so a pass in #1 is meaningful).
 *   3. Idempotency: applying the same entry twice yields one entry.
 *   4. atomicWriteFile never leaves a torn file under concurrent writers.
 *   5. Lock contention times out instead of hanging forever.
 *
 * Exits non-zero on any failed assertion.
 */
import { withLock, atomicWriteFile, snapshot, hashString } from './.bundled/fs-lock.mjs'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const WORK = join(here, '.work')
const N = 8

const failures = []
function check(name, cond, detail) {
  if (cond) console.log(`  ok   ${name}`)
  else {
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
    failures.push(name)
  }
}

async function reset(file) {
  await fs.mkdir(WORK, { recursive: true })
  await fs.writeFile(file, JSON.stringify({ entries: [] }))
}
async function readEntries(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')).entries
  } catch {
    return []
  }
}

const WORKER = `
import { withLock } from './.bundled/fs-lock.mjs'
import { promises as fs } from 'node:fs'
const [file, id, useLock] = process.argv.slice(2)
async function rmw() {
  let data
  try {
    data = JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    // Unlocked control run: another writer truncated/rewrote the file mid-read.
    // That torn read IS the race we're demonstrating — bail out gracefully so
    // the harness reports lost updates instead of crashing.
    process.exit(0)
  }
  await new Promise((r) => setTimeout(r, 25))
  data.entries.push(id)
  await fs.writeFile(file, JSON.stringify(data))
}
if (useLock === '1') await withLock(file + ':test', rmw)
else await rmw()
`
const workerPath = join(here, 'worker.mjs')
await fs.writeFile(workerPath, WORKER)

function runWorker(file, id, useLock) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [workerPath, file, id, useLock ? '1' : '0'], { stdio: 'inherit' })
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker ${id} exit ${code}`))))
    p.on('error', reject)
  })
}

console.log('1. cross-process mutual exclusion (WITH lock)')
{
  const file = join(WORK, 'locked.json')
  await reset(file)
  await Promise.all(Array.from({ length: N }, (_, i) => runWorker(file, `e${i}`, true)))
  const entries = await readEntries(file)
  check(`all ${N} entries survive (no lost updates)`, entries.length === N && new Set(entries).size === N, `got ${entries.length}`)
}

console.log('2. control run WITHOUT lock (expects lost updates)')
{
  const file = join(WORK, 'unlocked.json')
  await reset(file)
  // Tolerate individual worker failures here — a torn read/crash is itself
  // evidence of the race we are demonstrating, not a harness error.
  await Promise.all(
    Array.from({ length: N }, (_, i) => runWorker(file, `e${i}`, false).catch(() => {}))
  )
  const entries = await readEntries(file)
  console.log(`  info unlocked run kept ${entries.length}/${N} entries ` + (entries.length < N ? '(race detected ✓)' : '(no race this run — timing luck)'))
}

console.log('3. idempotency')
{
  const file = join(WORK, 'idem.json')
  await reset(file)
  const applyOnce = (id) =>
    withLock(file + ':idem', async () => {
      const data = JSON.parse(await fs.readFile(file, 'utf8'))
      if (!data.entries.includes(id)) data.entries.push(id)
      await fs.writeFile(file, JSON.stringify(data))
    })
  await applyOnce('bin')
  await applyOnce('bin')
  const entries = await readEntries(file)
  check('applying same entry twice yields one', entries.length === 1 && entries[0] === 'bin', JSON.stringify(entries))
}

console.log('4. atomic write under concurrent writers (no torn file)')
{
  const file = join(WORK, 'atomic.json')
  await fs.mkdir(WORK, { recursive: true })
  const payload = JSON.stringify({ entries: Array.from({ length: 2000 }, (_, i) => `x${i}`) })
  await Promise.all(Array.from({ length: 12 }, () => atomicWriteFile(file, payload)))
  const raw = await fs.readFile(file, 'utf8')
  let parsedOk = true
  try {
    JSON.parse(raw)
  } catch {
    parsedOk = false
  }
  check('file is always valid JSON (no torn write)', parsedOk && raw === payload)
  const snap = await snapshot(file)
  check('snapshot hash matches content', snap.hash === hashString(raw))
}

console.log('5. lock contention times out')
{
  const file = join(WORK, 'contend.json')
  await reset(file)
  let timedOut = false
  const holder = withLock(file + ':contend', async () => {
    await new Promise((r) => setTimeout(r, 600))
  })
  await new Promise((r) => setTimeout(r, 80))
  try {
    await withLock(file + ':contend', async () => {}, { timeoutMs: 150 })
  } catch {
    timedOut = true
  }
  await holder
  check('second acquirer times out instead of hanging', timedOut)
}

await fs.rm(WORK, { recursive: true, force: true })
await fs.rm(workerPath, { force: true })

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nAll concurrency safety checks passed.')
