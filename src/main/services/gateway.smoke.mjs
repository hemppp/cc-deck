/**
 * CC Deck — gateway smoke test (no Electron required).
 *
 *   node src/main/services/gateway.smoke.mjs
 *
 * Bundles `gateway.ts` with esbuild, substituting a tiny in-memory stub for
 * `../store` (so we don't pull in electron-store/electron), points it at a mock
 * OpenAI-compatible upstream, then exercises:
 *   1. non-streaming translation  (OpenAI -> Anthropic message)
 *   2. streaming translation      (OpenAI SSE -> Anthropic SSE events)
 *   3. gateway token auth         (401 on mismatch)
 *   4. tool-call translation
 *
 * Exits non-zero on any failed assertion.
 */
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/* ---------------------------------------------------------------- */
/* Stub the store so the bundle is Electron-free                     */
/* ---------------------------------------------------------------- */
const storeStub = {
  name: 'cc-deck-store-stub',
  setup(b) {
    b.onResolve({ filter: /^\.\.\/store$/ }, () => ({ path: 'store-stub', namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents:
        'export function getModelConfigs(){ return globalThis.__SMOKE_CONFIGS__ || [] }\n' +
        'export function setModelConfigs(c){ globalThis.__SMOKE_CONFIGS__ = c; return c }\n',
      loader: 'js'
    }))
  }
}

// Emit the bundle *inside* the project so `require('express')` resolves upward
// into the project's node_modules (the temp dir has none).
const outDir = join(here, '..', '..', '..', 'node_modules', '.cc-deck-smoke')
mkdirSync(outDir, { recursive: true })
const outFile = join(outDir, 'gateway.mjs')

await build({
  entryPoints: [join(here, 'gateway.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  outfile: outFile,
  plugins: [storeStub],
  banner: {
    // Express & friends are CJS; give the bundled ESM output a real `require`.
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);"
  },
  logLevel: 'warning'
})

const gw = await import(pathToFileURL(outFile).href)

/* ---------------------------------------------------------------- */
/* Mock OpenAI-compatible upstream                                   */
/* ---------------------------------------------------------------- */
function sseChunk(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`
}

const mock = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    let parsed = {}
    try {
      parsed = JSON.parse(body)
    } catch {
      /* ignore */
    }

    // /models discovery
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'mock-model' }, { id: 'other-model' }] }))
      return
    }

    // Native Ollama /api/tags discovery
    if (req.url?.endsWith('/api/tags')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ models: [{ name: 'llama3:latest' }, { name: 'qwen2.5-coder:14b' }] }))
      return
    }

    // Native Ollama /api/chat
    if (req.url?.endsWith('/api/chat')) {
      if (!parsed.stream) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            model: 'llama3',
            created_at: '2024-01-01T00:00:00Z',
            message: {
              role: 'assistant',
              content: 'Hello from ollama',
              tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Paris' } } }]
            },
            done: true,
            done_reason: 'stop',
            prompt_eval_count: 12,
            eval_count: 7
          })
        )
        return
      }
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.write(JSON.stringify({ model: 'llama3', message: { role: 'assistant', content: 'Hel' }, done: false }) + '\n')
      res.write(JSON.stringify({ model: 'llama3', message: { role: 'assistant', content: 'lo' }, done: false }) + '\n')
      res.write(
        JSON.stringify({
          model: 'llama3',
          message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Rome' } } }] },
          done: false
        }) + '\n'
      )
      res.write(
        JSON.stringify({
          model: 'llama3',
          message: { role: 'assistant', content: '' },
          done: true,
          done_reason: 'stop',
          prompt_eval_count: 5,
          eval_count: 9
        }) + '\n'
      )
      res.end()
      return
    }

    if (!parsed.stream) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'chatcmpl-1',
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: 'Hello from mock',
                tool_calls: [
                  {
                    id: 'call_abc',
                    type: 'function',
                    function: { name: 'get_weather', arguments: '{"city":"Paris"}' }
                  }
                ]
              }
            }
          ],
          usage: { prompt_tokens: 12, completion_tokens: 7 }
        })
      )
      return
    }

    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(sseChunk({ choices: [{ delta: { role: 'assistant' }, finish_reason: null }] }))
    res.write(sseChunk({ choices: [{ delta: { content: 'Hel' }, finish_reason: null }] }))
    res.write(sseChunk({ choices: [{ delta: { content: 'lo' }, finish_reason: null }] }))
    res.write(
      sseChunk({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_x', function: { name: 'get_weather', arguments: '{"ci' } }
              ]
            },
            finish_reason: null
          }
        ]
      })
    )
    res.write(
      sseChunk({
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"Rome"}' } }] }, finish_reason: null }
        ]
      })
    )
    res.write(sseChunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 9 } }))
    res.write('data: [DONE]\n\n')
    res.end()
  })
})

await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve))
const mockPort = mock.address().port

/* ---------------------------------------------------------------- */
/* Point the gateway at the mock                                     */
/* ---------------------------------------------------------------- */
globalThis.__SMOKE_CONFIGS__ = [
  {
    id: 'm1',
    name: 'Mock',
    kind: 'openai-compatible',
    baseUrl: `http://127.0.0.1:${mockPort}`,
    apiKey: '',
    model: 'mock-model',
    createdAt: new Date().toISOString()
  },
  {
    id: 'm2',
    name: 'Ollama',
    kind: 'ollama',
    baseUrl: `http://127.0.0.1:${mockPort}/api`,
    apiKey: '',
    model: 'llama3',
    createdAt: new Date().toISOString()
  }
]

const failures = []
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`)
  } else {
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
    failures.push(name)
  }
}

const start = await gw.startGateway('m1', 0)
const base = start.baseUrl
const token = start.token
console.log(`gateway on ${base} (token ${token ? 'set' : 'none'})`)

/* 1. health ------------------------------------------------------- */
const health = await fetch(`${base}/health`).then((r) => r.json())
check('health ok', health.ok === true && health.status === 'running')

/* 2. auth --------------------------------------------------------- */
const unauth = await fetch(`${base}/v1/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': 'wrong' },
  body: JSON.stringify({ messages: [] })
})
check('rejects bad token (401)', unauth.status === 401)

/* 3. non-streaming translation ------------------------------------ */
const headers = { 'content-type': 'application/json', 'x-api-key': token }
const msg = await fetch(`${base}/v1/messages`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    model: 'mock-model',
    max_tokens: 64,
    system: 'You are terse.',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'get_weather', description: 'w', input_schema: { type: 'object' } }]
  })
}).then((r) => r.json())

check('non-stream type=message', msg.type === 'message' && msg.role === 'assistant')
check('non-stream text block', msg.content?.[0]?.type === 'text' && msg.content[0].text === 'Hello from mock')
const toolUse = msg.content?.find((b) => b.type === 'tool_use')
check('non-stream tool_use', toolUse?.id === 'call_abc' && toolUse?.name === 'get_weather' && toolUse?.input?.city === 'Paris')
check('stop_reason tool_use', msg.stop_reason === 'tool_use')
check('usage mapped', msg.usage?.input_tokens === 12 && msg.usage?.output_tokens === 7)

/* 4. streaming translation ---------------------------------------- */
const streamRes = await fetch(`${base}/v1/messages`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ model: 'mock-model', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] })
})
check('stream content-type', (streamRes.headers.get('content-type') || '').includes('text/event-stream'))
const sse = await streamRes.text()
const events = [...sse.matchAll(/^event: (\S+)/gm)].map((m) => m[1])
check('stream has message_start', events[0] === 'message_start')
check('stream has content_block_start', events.includes('content_block_start'))
check('stream has text_delta', sse.includes('"type":"text_delta"'))
check('stream has input_json_delta', sse.includes('"type":"input_json_delta"'))
check('stream has content_block_stop', events.includes('content_block_stop'))
check('stream has message_delta', events.includes('message_delta'))
check('stream ends with message_stop', events[events.length - 1] === 'message_stop')
// Partial JSON should concatenate back to the full argument object.
const partials = [...sse.matchAll(/"partial_json":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`))
const joined = partials.join('')
check('streamed tool args reassemble', joined === '{"city":"Rome"}', joined)

/* 5. env ---------------------------------------------------------- */
const env = gw.getActiveEnv()
check('getActiveEnv', env.ANTHROPIC_BASE_URL === base && env.ANTHROPIC_MODEL === 'mock-model' && env.ANTHROPIC_AUTH_TOKEN === token)

/* 6. native Ollama (/api/chat) ------------------------------------ */
const oStart = await gw.startGateway('m2', 0)
const obase = oStart.baseUrl
const oheaders = { 'content-type': 'application/json', 'x-api-key': oStart.token }
console.log(`ollama gateway on ${obase}`)

const oMsg = await fetch(`${obase}/v1/messages`, {
  method: 'POST',
  headers: oheaders,
  body: JSON.stringify({ model: 'llama3', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] })
}).then((r) => r.json())
check('ollama non-stream text', oMsg.content?.[0]?.type === 'text' && oMsg.content[0].text === 'Hello from ollama')
const oTool = oMsg.content?.find((b) => b.type === 'tool_use')
check('ollama non-stream tool_use', oTool?.name === 'get_weather' && oTool?.input?.city === 'Paris')
check('ollama stop_reason tool_use', oMsg.stop_reason === 'tool_use')
check('ollama usage mapped', oMsg.usage?.input_tokens === 12 && oMsg.usage?.output_tokens === 7)

const oStreamRes = await fetch(`${obase}/v1/messages`, {
  method: 'POST',
  headers: oheaders,
  body: JSON.stringify({ model: 'llama3', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] })
})
const oSse = await oStreamRes.text()
const oEvents = [...oSse.matchAll(/^event: (\S+)/gm)].map((m) => m[1])
check('ollama stream message_start first', oEvents[0] === 'message_start')
check('ollama stream text_delta', oSse.includes('"type":"text_delta"') && oSse.includes('"text":"Hel"'))
check('ollama stream input_json_delta', oSse.includes('"type":"input_json_delta"') && oSse.includes('\\"city\\":\\"Rome\\"'))
check('ollama stream message_stop last', oEvents[oEvents.length - 1] === 'message_stop')
check('ollama stream usage', oSse.includes('"input_tokens":5') && oSse.includes('"output_tokens":9'))

await gw.stopGateway()
check('stop resets after ollama', gw.getGatewayState().status === 'stopped')

mock.closeAllConnections?.()
await new Promise((resolve) => mock.close(resolve))
rmSync(outDir, { recursive: true, force: true })

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nAll gateway smoke checks passed.')
