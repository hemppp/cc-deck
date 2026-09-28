/**
 * Bundle the TypeScript sources under test into `tests/.bundled/` so the plain
 * Node test scripts can import them without a TS loader.
 *
 *   node tests/prepare.mjs
 */
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const outDir = join(here, '.bundled')
mkdirSync(outDir, { recursive: true })

const entries = [
  ['src/main/services/env/fs-lock.ts', 'fs-lock.mjs'],
  ['src/main/services/env/claude-config.ts', 'claude-config.mjs'],
  ['src/main/services/env/registry.ts', 'registry.mjs'],
  ['src/main/services/env/unix-profile.ts', 'unix-profile.mjs']
]

for (const [src, out] of entries) {
  await build({
    entryPoints: [join(root, src)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node18',
    outfile: join(outDir, out),
    logLevel: 'warning'
  })
  console.log(`bundled ${src} -> tests/.bundled/${out}`)
}
