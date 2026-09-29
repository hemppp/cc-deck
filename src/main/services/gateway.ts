/**
 * CC Deck — built-in model gateway.
 *
 * A small Express server that speaks the **Anthropic Messages API** to Claude
 * Code (and anything else that expects that shape) and translates every request
 * to the configured upstream provider:
 *
 *   anthropic          → pure proxy to `${baseUrl}/v1/messages`
 *   openai-compatible  → translate to `${baseUrl}/v1/chat/completions`
 *   ollama             → same as openai-compatible (Ollama's /v1 compat layer)
 *   custom             → same as openai-compatible
 *
 * Both non-streaming and streaming (SSE) responses are translated back into
 * Anthropic-shaped payloads / events.
 *
 * The module is intentionally self-contained: it never throws out of an HTTP
 * handler, never crashes the Electron app on upstream failure, and exposes a
 * tiny observable state API so `main/index.ts` can mirror it to the renderer.
 */
import express from 'express'
import type { Request, Response } from 'express'
import { createServer, type Server } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import type {
  GatewayState,
  ModelConfig,
  ProviderKind
} from '@shared/types'
import { getModelConfigs } from '../store'

/* ------------------------------------------------------------------ */
/* Tunables                                                            */
/* ------------------------------------------------------------------ */

const UPSTREAM_TIMEOUT_MS = 120_000
const LOG_PREFIX = '[gateway]'

function log(...args: unknown[]): void {
  console.log(LOG_PREFIX, ...args)
}

function logError(...args: unknown[]): void {
  console.error(LOG_PREFIX, ...args)
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const state: GatewayState = {
  status: 'stopped',
  port: null,
  baseUrl: null,
  activeConfigId: null,
  token: null,
  error: null,
  requestCount: 0
}

let server: Server | null = null
let activeConfig: ModelConfig | null = null
let startPromise: Promise<GatewayState> | null = null

type Listener = (s: GatewayState) => void
const listeners = new Set<Listener>()

/** Snapshot so subscribers never receive the mutable internal object. */
function snapshot(): GatewayState {
  return { ...state }
}

function emit(): void {
  const snap = snapshot()
  for (const cb of listeners) {
    try {
      cb(snap)
    } catch (err) {
      logError('state listener threw', err)
    }
  }
}

/**
 * Subscribe to gateway state changes. Returns an unsubscribe function.
 * The callback is invoked synchronously with the current snapshot on subscribe.
 */
export function onGatewayState(cb: (s: GatewayState) => void): () => void {
  listeners.add(cb)
  try {
    cb(snapshot())
  } catch (err) {
    logError('state listener threw', err)
  }
  return () => {
    listeners.delete(cb)
  }
}

/** Current gateway state (copy). */
export function getGatewayState(): GatewayState {
  return snapshot()
}

/* ------------------------------------------------------------------ */
/* Port helpers                                                        */
/* ------------------------------------------------------------------ */

function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = createNetServer()
    tester.once('error', () => resolve(false))
    tester.once('listening', () => {
      tester.close(() => resolve(true))
    })
    tester.listen(port, '127.0.0.1')
  })
}

async function findFreePort(preferred?: number): Promise<number> {
  if (preferred && preferred > 0) {
    if (await probePort(preferred)) return preferred
    log(`port ${preferred} busy, picking a free one`)
  }
  return new Promise((resolve, reject) => {
    const tester = createNetServer()
    tester.once('error', reject)
    tester.listen(0, '127.0.0.1', () => {
      const addr = tester.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      tester.close(() => resolve(port))
    })
  })
}

/* ------------------------------------------------------------------ */
/* Anthropic ⇄ OpenAI translation helpers                              */
/* ------------------------------------------------------------------ */

type JsonObject = Record<string, unknown>

function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Flatten an Anthropic system field (string | block[]) into plain text. */
function extractSystem(system: unknown): string {
  if (typeof system === 'string') return system
  if (Array.isArray(system)) {
    const parts: string[] = []
    for (const block of system) {
      if (typeof block === 'string') parts.push(block)
      else if (isObject(block) && typeof block.text === 'string') parts.push(block.text)
    }
    return parts.join('\n\n')
  }
  return ''
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      if (typeof block === 'string') parts.push(block)
      else if (isObject(block) && block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text)
      }
    }
    return parts.join('\n')
  }
  return ''
}

/** Anthropic tools[] -> OpenAI tools[] */
function mapTools(tools: unknown): JsonObject[] | undefined {
  if (!Array.isArray(tools)) return undefined
  const mapped: JsonObject[] = []
  for (const tool of tools) {
    if (!isObject(tool) || typeof tool.name !== 'string') continue
    mapped.push({
      type: 'function',
      function: {
        name: tool.name,
        description: typeof tool.description === 'string' ? tool.description : '',
        parameters: isObject(tool.input_schema) ? tool.input_schema : { type: 'object', properties: {} }
      }
    })
  }
  return mapped.length ? mapped : undefined
}

/** Anthropic tool_choice -> OpenAI tool_choice */
function mapToolChoice(choice: unknown): unknown {
  if (!isObject(choice)) return undefined
  switch (choice.type) {
    case 'auto':
      return 'auto'
    case 'any':
      return 'required'
    case 'none':
      return 'none'
    case 'tool':
      return typeof choice.name === 'string'
        ? { type: 'function', function: { name: choice.name } }
        : undefined
    default:
      return undefined
  }
}

function safeParse(raw: string): unknown {
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

/**
 * Translate an Anthropic Messages request body into an OpenAI chat-completions
 * request body. Returns `{ body, stream }`.
 */
function buildOpenAIRequest(reqBody: JsonObject, config: ModelConfig): JsonObject {
  const messages: JsonObject[] = []

  const systemText = extractSystem(reqBody.system)
  if (systemText) messages.push({ role: 'system', content: systemText })

  const input = Array.isArray(reqBody.messages) ? reqBody.messages : []
  for (const msg of input) {
    if (!isObject(msg)) continue
    const role = msg.role
    const content = msg.content

    if (role === 'user') {
      if (typeof content === 'string') {
        messages.push({ role: 'user', content })
        continue
      }
      if (!Array.isArray(content)) continue

      // Tool results become standalone `role:"tool"` messages (must directly
      // follow the assistant message that issued the tool_call).
      const toolMsgs: JsonObject[] = []
      const textParts: string[] = []
      for (const block of content) {
        if (!isObject(block)) continue
        if (block.type === 'tool_result') {
          toolMsgs.push({
            role: 'tool',
            tool_call_id: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
            content:
              typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '')
          })
        } else if (block.type === 'text' && typeof block.text === 'string') {
          textParts.push(block.text)
        }
      }
      for (const tm of toolMsgs) messages.push(tm)
      if (textParts.length) messages.push({ role: 'user', content: textParts.join('\n') })
    } else if (role === 'assistant') {
      if (typeof content === 'string') {
        messages.push({ role: 'assistant', content })
        continue
      }
      if (!Array.isArray(content)) continue

      const textParts: string[] = []
      const toolCalls: JsonObject[] = []
      for (const block of content) {
        if (!isObject(block)) continue
        if (block.type === 'text' && typeof block.text === 'string') {
          textParts.push(block.text)
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: typeof block.id === 'string' ? block.id : `call_${randomUUID()}`,
            type: 'function',
            function: {
              name: typeof block.name === 'string' ? block.name : '',
              arguments:
                typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {})
            }
          })
        }
      }
      const out: JsonObject = { role: 'assistant' }
      out.content = textParts.length ? textParts.join('\n') : null
      if (toolCalls.length) out.tool_calls = toolCalls
      messages.push(out)
    }
  }

  const body: JsonObject = {
    model: config.model,
    messages,
    stream: Boolean(reqBody.stream)
  }
  if (typeof reqBody.max_tokens === 'number') body.max_tokens = reqBody.max_tokens
  if (typeof reqBody.temperature === 'number') body.temperature = reqBody.temperature
  if (typeof reqBody.top_p === 'number') body.top_p = reqBody.top_p
  if (Array.isArray(reqBody.stop_sequences) && reqBody.stop_sequences.length) {
    body.stop = reqBody.stop_sequences
  }

  if (config.supportsTools !== false) {
    const tools = mapTools(reqBody.tools)
    if (tools) {
      body.tools = tools
      const tc = mapToolChoice(reqBody.tool_choice)
      if (tc !== undefined) body.tool_choice = tc
    }
  }

  return body
}

function mapStopReason(finish: unknown): string {
  switch (finish) {
    case 'length':
      return 'max_tokens'
    case 'tool_calls':
    case 'function_call':
      return 'tool_use'
    case 'content_filter':
      return 'end_turn'
    case 'stop':
      return 'end_turn'
    default:
      return 'end_turn'
  }
}

function buildAnthropicResponse(
  oai: JsonObject,
  model: string
): JsonObject {
  const choice = Array.isArray(oai.choices) ? (oai.choices[0] as JsonObject | undefined) : undefined
  const message = choice && isObject(choice.message) ? choice.message : {}
  const content: JsonObject[] = []

  const text = typeof message.content === 'string' ? message.content : ''
  if (text) content.push({ type: 'text', text })

  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      if (!isObject(call)) continue
      const fn = isObject(call.function) ? call.function : {}
      content.push({
        type: 'tool_use',
        id: typeof call.id === 'string' ? call.id : `toolu_${randomUUID()}`,
        name: typeof fn.name === 'string' ? fn.name : '',
        input: safeParse(typeof fn.arguments === 'string' ? fn.arguments : '{}')
      })
    }
  }
  if (!content.length) content.push({ type: 'text', text: '' })

  const usage = isObject(oai.usage) ? oai.usage : {}
  return {
    id: typeof oai.id === 'string' ? oai.id : `msg_${randomUUID().replace(/-/g, '')}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: mapStopReason(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0,
      output_tokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0
    }
  }
}

/* ------------------------------------------------------------------ */
/* SSE translation (OpenAI stream -> Anthropic stream)                 */
/* ------------------------------------------------------------------ */

interface StreamBlock {
  index: number
  kind: 'text' | 'tool'
  anthropicIndex: number
  id?: string
  name?: string
  argsBuffer: string
}

class AnthropicSseTranslator {
  private started = false
  /** True once any upstream payload has been consumed (see `finish`). */
  public emittedStart = false
  private blocks = new Map<number, StreamBlock>()
  private nextIndex = 0
  private inputTokens = 0
  private outputTokens = 0
  private finishReason: unknown = null

  constructor(private readonly model: string) {}

  private frame(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  }

  private ensureStart(): string {
    if (this.started) return ''
    this.started = true
    return this.frame('message_start', {
      type: 'message_start',
      message: {
        id: `msg_${randomUUID().replace(/-/g, '')}`,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    })
  }

  private startTextBlock(): { out: string; block: StreamBlock } {
    const block: StreamBlock = {
      index: -1,
      kind: 'text',
      anthropicIndex: this.nextIndex++,
      argsBuffer: ''
    }
    this.blocks.set(-1, block)
    const out =
      this.ensureStart() +
      this.frame('content_block_start', {
        type: 'content_block_start',
        index: block.anthropicIndex,
        content_block: { type: 'text', text: '' }
      })
    return { out, block }
  }

  /** Consume one upstream SSE `data:` JSON payload; return Anthropic frames. */
  public handle(json: JsonObject): string {
    this.emittedStart = true
    let out = ''
    const choice = Array.isArray(json.choices) ? (json.choices[0] as JsonObject | undefined) : undefined
    const delta = choice && isObject(choice.delta) ? choice.delta : {}
    const finish = choice?.finish_reason

    if (isObject(json.usage)) {
      const usage = json.usage
      if (typeof usage.prompt_tokens === 'number') this.inputTokens = usage.prompt_tokens
      if (typeof usage.completion_tokens === 'number') this.outputTokens = usage.completion_tokens
    }

    const textDelta = typeof delta.content === 'string' ? delta.content : ''
    if (textDelta) {
      let block = this.blocks.get(-1)
      if (!block) {
        const started = this.startTextBlock()
        out += started.out
        block = started.block
      }
      out += this.frame('content_block_delta', {
        type: 'content_block_delta',
        index: block.anthropicIndex,
        delta: { type: 'text_delta', text: textDelta }
      })
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const rawCall of delta.tool_calls) {
        if (!isObject(rawCall)) continue
        const oaiIndex = typeof rawCall.index === 'number' ? rawCall.index : 0
        let block = this.blocks.get(oaiIndex)
        if (!block) {
          block = {
            index: oaiIndex,
            kind: 'tool',
            anthropicIndex: this.nextIndex++,
            id: undefined,
            name: undefined,
            argsBuffer: ''
          }
          this.blocks.set(oaiIndex, block)
          out += this.ensureStart()
          out += this.frame('content_block_start', {
            type: 'content_block_start',
            index: block.anthropicIndex,
            content_block: { type: 'tool_use', id: '', name: '', input: {} }
          })
        }
        const fn = isObject(rawCall.function) ? rawCall.function : {}
        if (typeof rawCall.id === 'string' && rawCall.id) block.id = rawCall.id
        if (typeof fn.name === 'string' && fn.name) block.name = fn.name
        const args = typeof fn.arguments === 'string' ? fn.arguments : ''
        if (args) {
          block.argsBuffer += args
          out += this.frame('content_block_delta', {
            type: 'content_block_delta',
            index: block.anthropicIndex,
            delta: { type: 'input_json_delta', partial_json: args }
          })
        }
      }
    }

    if (finish != null) this.finishReason = finish
    return out
  }

  /** Flush remaining events: content_block_stop(s), message_delta, message_stop. */
  public finish(): string {
    let out = ''
    if (!this.emittedStart) out += this.ensureStart()
    const ordered = [...this.blocks.values()].sort((a, b) => a.anthropicIndex - b.anthropicIndex)
    for (const block of ordered) {
      out += this.frame('content_block_stop', {
        type: 'content_block_stop',
        index: block.anthropicIndex
      })
    }
    out += this.frame('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: mapStopReason(this.finishReason), stop_sequence: null },
      usage: { input_tokens: this.inputTokens, output_tokens: this.outputTokens }
    })
    out += this.frame('message_stop', { type: 'message_stop' })
    return out
  }
}

/* ------------------------------------------------------------------ */
/* Upstream calls                                                      */
/* ------------------------------------------------------------------ */

function upstreamEndpoint(config: ModelConfig): string {
  const base = (config.baseUrl || '').trim().replace(/\/+$/, '')
  if (config.kind === 'anthropic') {
    if (/\/messages$/.test(base)) return base
    if (/\/v\d+$/.test(base)) return `${base}/messages`
    return `${base}/v1/messages`
  }
  // openai-compatible / ollama / custom
  if (/\/chat\/completions$/.test(base)) return base
  if (/\/v\d+$/.test(base)) return `${base}/chat/completions`
  return `${base}/v1/chat/completions`
}

function upstreamHeaders(config: ModelConfig): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (config.kind === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01'
    if (config.apiKey) headers['x-api-key'] = config.apiKey
  } else if (config.apiKey) {
    headers.authorization = `Bearer ${config.apiKey}`
  }
  if (config.headers) {
    for (const [k, v] of Object.entries(config.headers)) {
      if (typeof v === 'string') headers[k] = v
    }
  }
  return headers
}

function timeoutFor(config: ModelConfig): number {
  return typeof config.timeoutMs === 'number' && config.timeoutMs > 0
    ? config.timeoutMs
    : UPSTREAM_TIMEOUT_MS
}

/* ------------------------------------------------------------------ */
/* Native Ollama (/api/chat) support                                   */
/* ------------------------------------------------------------------ */

/**
 * A config targets Ollama's *native* API when its kind is `ollama` and the base
 * URL carries the Ollama `/api` marker. Anything else (plain `http://host:11434`
 * or an explicit `/v1`) uses Ollama's OpenAI-compatible `/v1` endpoint.
 */
function useNativeOllama(config: ModelConfig): boolean {
  return config.kind === 'ollama' && /\/api(\/|$)/.test((config.baseUrl || '').trim())
}

/** Resolve the native Ollama chat endpoint (`/api/chat`). */
function ollamaNativeEndpoint(baseUrl: string): string {
  const base = (baseUrl || '').trim().replace(/\/+$/, '')
  if (/\/api\/chat$/.test(base)) return base
  if (/\/api$/.test(base)) return `${base}/chat`
  if (/\/v\d+$/.test(base)) {
    // http://host:11434/v1 → http://host:11434/api/chat
    return `${base.replace(/\/v\d+$/, '')}/api/chat`
  }
  return `${base}/api/chat`
}

/**
 * Convert an OpenAI-shaped request body into Ollama's native `/api/chat` body.
 * Tool results (`role:"tool"`) are folded into the preceding user message's
 * `tool_name` field, since native Ollama has no standalone tool role.
 */
function buildOllamaChatRequest(openaiBody: JsonObject): JsonObject {
  const rawMessages = Array.isArray(openaiBody.messages) ? openaiBody.messages : []
  const messages: JsonObject[] = []
  for (const msg of rawMessages) {
    if (!isObject(msg)) continue
    if (msg.role === 'tool') {
      const last = messages[messages.length - 1]
      if (last) last.tool_name = msg.tool_call_id ?? last.tool_name
      continue
    }
    const out: JsonObject = { role: msg.role, content: msg.content ?? '' }
    if (Array.isArray(msg.tool_calls)) out.tool_calls = msg.tool_calls
    messages.push(out)
  }

  const options: JsonObject = {}
  if (typeof openaiBody.temperature === 'number') options.temperature = openaiBody.temperature
  if (typeof openaiBody.top_p === 'number') options.top_p = openaiBody.top_p
  if (typeof openaiBody.max_tokens === 'number') options.num_predict = openaiBody.max_tokens
  if (openaiBody.stop !== undefined) options.stop = openaiBody.stop

  const body: JsonObject = { model: openaiBody.model, messages, stream: Boolean(openaiBody.stream) }
  if (Array.isArray(openaiBody.tools) && openaiBody.tools.length) body.tools = openaiBody.tools
  if (Object.keys(options).length) body.options = options
  return body
}

function ollamaContentBlocks(msg: JsonObject): JsonObject[] {
  const content: JsonObject[] = []
  const text = typeof msg.content === 'string' ? msg.content : ''
  if (text) content.push({ type: 'text', text })
  if (Array.isArray(msg.tool_calls)) {
    for (const call of msg.tool_calls) {
      if (!isObject(call)) continue
      const fn = isObject(call.function) ? call.function : {}
      content.push({
        type: 'tool_use',
        id: `toolu_${randomUUID().replace(/-/g, '')}`,
        name: typeof fn.name === 'string' ? fn.name : '',
        input: isObject(fn.arguments) ? fn.arguments : safeParse(typeof fn.arguments === 'string' ? fn.arguments : '{}')
      })
    }
  }
  if (!content.length) content.push({ type: 'text', text: '' })
  return content
}

function buildAnthropicResponseFromOllama(json: JsonObject, model: string): JsonObject {
  const msg = isObject(json.message) ? json.message : {}
  const hasTools = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0
  const doneReason = typeof json.done_reason === 'string' ? json.done_reason : 'stop'
  const usage = isObject(json.usage) ? json.usage : {}
  // Native Ollama reports counts at the top level; OpenAI-compat nests them.
  const inputTokens =
    typeof json.prompt_eval_count === 'number'
      ? json.prompt_eval_count
      : typeof usage.prompt_tokens === 'number'
        ? usage.prompt_tokens
        : 0
  const outputTokens =
    typeof json.eval_count === 'number'
      ? json.eval_count
      : typeof usage.completion_tokens === 'number'
        ? usage.completion_tokens
        : 0
  return {
    id: `msg_${randomUUID().replace(/-/g, '')}`,
    type: 'message',
    role: 'assistant',
    model,
    content: ollamaContentBlocks(msg),
    stop_reason: hasTools ? 'tool_use' : mapStopReason(doneReason),
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens }
  }
}

/** Translate Ollama native streaming chunks into Anthropic SSE frames. */
class OllamaSseTranslator {
  private started = false
  public emittedStart = false
  private textBlockOpen = false
  private textIndex = 0
  private toolBlocks = new Map<number, { anthropicIndex: number; argsBuffer: string }>()
  private nextIndex = 0
  private inputTokens = 0
  private outputTokens = 0
  private finishReason = 'stop'
  private hasTools = false

  constructor(private readonly model: string) {}

  private frame(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  }

  private ensureStart(): string {
    if (this.started) return ''
    this.started = true
    return this.frame('message_start', {
      type: 'message_start',
      message: {
        id: `msg_${randomUUID().replace(/-/g, '')}`,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    })
  }

  public handle(json: JsonObject): string {
    this.emittedStart = true
    let out = ''
    const msg = isObject(json.message) ? json.message : {}

    if (typeof json.prompt_eval_count === 'number') this.inputTokens = json.prompt_eval_count
    if (typeof json.eval_count === 'number') this.outputTokens = json.eval_count
    if (typeof json.done_reason === 'string') this.finishReason = json.done_reason

    const text = typeof msg.content === 'string' ? msg.content : ''
    if (text) {
      out += this.ensureStart()
      if (!this.textBlockOpen) {
        this.textBlockOpen = true
        this.textIndex = this.nextIndex++
        out += this.frame('content_block_start', {
          type: 'content_block_start',
          index: this.textIndex,
          content_block: { type: 'text', text: '' }
        })
      }
      out += this.frame('content_block_delta', {
        type: 'content_block_delta',
        index: this.textIndex,
        delta: { type: 'text_delta', text }
      })
    }

    if (Array.isArray(msg.tool_calls)) {
      msg.tool_calls.forEach((call, i) => {
        if (!isObject(call)) return
        this.hasTools = true
        out += this.ensureStart()
        const fn = isObject(call.function) ? call.function : {}
        const anthropicIndex = this.nextIndex++
        const args = isObject(fn.arguments)
          ? JSON.stringify(fn.arguments)
          : typeof fn.arguments === 'string'
            ? fn.arguments
            : '{}'
        out += this.frame('content_block_start', {
          type: 'content_block_start',
          index: anthropicIndex,
          content_block: {
            type: 'tool_use',
            id: `toolu_${randomUUID().replace(/-/g, '')}`,
            name: typeof fn.name === 'string' ? fn.name : '',
            input: {}
          }
        })
        out += this.frame('content_block_delta', {
          type: 'content_block_delta',
          index: anthropicIndex,
          delta: { type: 'input_json_delta', partial_json: args }
        })
        this.toolBlocks.set(i, { anthropicIndex, argsBuffer: args })
      })
    }

    return out
  }

  public finish(): string {
    let out = ''
    if (!this.emittedStart) out += this.ensureStart()
    if (this.textBlockOpen) {
      out += this.frame('content_block_stop', { type: 'content_block_stop', index: this.textIndex })
    }
    for (const block of this.toolBlocks.values()) {
      out += this.frame('content_block_stop', { type: 'content_block_stop', index: block.anthropicIndex })
    }
    out += this.frame('message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: this.hasTools ? 'tool_use' : mapStopReason(this.finishReason),
        stop_sequence: null
      },
      usage: { input_tokens: this.inputTokens, output_tokens: this.outputTokens }
    })
    out += this.frame('message_stop', { type: 'message_stop' })
    return out
  }
}

/* ------------------------------------------------------------------ */
/* HTTP error helpers                                                  */
/* ------------------------------------------------------------------ */

function sendAnthropicError(
  res: Response,
  status: number,
  type: string,
  message: string
): void {
  if (res.headersSent) {
    try {
      res.end()
    } catch {
      /* ignore */
    }
    return
  }
  res.status(status).json({ type: 'error', error: { type, message } })
}

function statusForError(err: unknown): { status: number; type: string; message: string } {
  if (err instanceof Error && err.name === 'AbortError') {
    return { status: 504, type: 'timeout_error', message: 'Upstream request timed out' }
  }
  const message = err instanceof Error ? err.message : String(err)
  return { status: 502, type: 'api_error', message: `Upstream request failed: ${message}` }
}

/* ------------------------------------------------------------------ */
/* Request handlers                                                    */
/* ------------------------------------------------------------------ */

function authorized(req: Request): boolean {
  if (!state.token) return true
  const bearer = req.header('authorization')
  const xApiKey = req.header('x-api-key')
  const provided = bearer?.replace(/^Bearer\s+/i, '') ?? xApiKey ?? ''
  return provided === state.token
}

interface UpstreamResponse {
  ok: boolean
  status: number
  body: ReadableStream<Uint8Array> | null
  text: string | null
}

/**
 * POST a JSON body to the resolved upstream endpoint. Returns the raw response
 * without consuming the body when streaming; for non-streaming the caller reads
 * `.text`. The caller owns the AbortController/timer.
 */
async function postUpstream(
  config: ModelConfig,
  body: JsonObject,
  signal: AbortSignal,
  streaming: boolean
): Promise<UpstreamResponse> {
  const nativeOllama = useNativeOllama(config)
  const url = nativeOllama ? ollamaNativeEndpoint(config.baseUrl) : upstreamEndpoint(config)
  const payload = nativeOllama ? buildOllamaChatRequest(body) : body
  const upstream = await fetch(url, {
    method: 'POST',
    headers: upstreamHeaders(config),
    body: JSON.stringify(payload),
    signal
  })
  if (streaming) {
    return { ok: upstream.ok, status: upstream.status, body: upstream.body, text: null }
  }
  return { ok: upstream.ok, status: upstream.status, body: null, text: await upstream.text() }
}

async function handleAnthropicPassThrough(req: Request, res: Response): Promise<void> {
  const config = activeConfig as ModelConfig
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutFor(config))
  try {
    const upstream = await fetch(upstreamEndpoint(config), {
      method: 'POST',
      headers: upstreamHeaders(config),
      body: JSON.stringify(req.body ?? {}),
      signal: controller.signal
    })
    const text = await upstream.text()
    res.status(upstream.status)
    const contentType = upstream.headers.get('content-type')
    if (contentType) res.setHeader('content-type', contentType)
    res.send(text)
  } catch (err) {
    const info = statusForError(err)
    logError('anthropic pass-through failed:', info.message)
    sendAnthropicError(res, info.status, info.type, info.message)
  } finally {
    clearTimeout(timer)
  }
}

async function handleTranslateNonStreaming(
  req: Request,
  res: Response,
  config: ModelConfig,
  openaiBody: JsonObject
): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutFor(config))
  try {
    const upstream = await postUpstream(config, openaiBody, controller.signal, false)
    const text = upstream.text ?? ''
    let parsed: unknown = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = null
    }
    if (!upstream.ok) {
      const message =
        isObject(parsed) && isObject(parsed.error) && typeof parsed.error.message === 'string'
          ? parsed.error.message
          : text || `Upstream returned HTTP ${upstream.status}`
      logError(`upstream HTTP ${upstream.status}:`, message)
      sendAnthropicError(res, upstream.status, 'api_error', message)
      return
    }
    if (!isObject(parsed)) {
      sendAnthropicError(res, 502, 'api_error', 'Upstream returned a non-JSON response')
      return
    }
    res.json(
      useNativeOllama(config)
        ? buildAnthropicResponseFromOllama(parsed, config.model)
        : buildAnthropicResponse(parsed, config.model)
    )
  } catch (err) {
    const info = statusForError(err)
    logError('translation request failed:', info.message)
    sendAnthropicError(res, info.status, info.type, info.message)
  } finally {
    clearTimeout(timer)
  }
}

async function handleTranslateStreaming(
  req: Request,
  res: Response,
  config: ModelConfig,
  openaiBody: JsonObject
): Promise<void> {
  res.status(200)
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutFor(config))
  const nativeOllama = useNativeOllama(config)
  const translator = nativeOllama
    ? new OllamaSseTranslator(config.model)
    : new AnthropicSseTranslator(config.model)

  const write = (chunk: string): void => {
    if (chunk) res.write(chunk)
  }

  try {
    const upstream = await postUpstream(config, openaiBody, controller.signal, true)

    if (!upstream.ok || !upstream.body) {
      const raw = upstream.text ?? (upstream.body ? await new Response(upstream.body).text() : '')
      const status = upstream.status || 502
      let message = raw || `Upstream returned HTTP ${status}`
      try {
        const parsed = JSON.parse(raw)
        if (isObject(parsed) && isObject(parsed.error) && typeof parsed.error.message === 'string') {
          message = parsed.error.message
        }
      } catch {
        /* keep raw text */
      }
      logError(`stream upstream HTTP ${status}:`, message)
      write(
        `event: error\ndata: ${JSON.stringify({
          type: 'error',
          error: { type: 'api_error', message }
        })}\n\n`
      )
      res.end()
      return
    }

    const reader = upstream.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let sawDone = false

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newlineIndex: number
      while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, '')
        buffer = buffer.slice(newlineIndex + 1)
        if (!line) continue
        if (nativeOllama) {
          // Ollama native streaming is newline-delimited JSON.
          let json: unknown
          try {
            json = JSON.parse(line)
          } catch {
            continue
          }
          if (isObject(json)) write(translator.handle(json))
        } else {
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (data === '[DONE]') {
            sawDone = true
            continue
          }
          if (!data) continue
          let json: unknown
          try {
            json = JSON.parse(data)
          } catch {
            continue
          }
          if (isObject(json)) write(translator.handle(json))
        }
      }
      if (sawDone) break
    }

    write(translator.finish())
    res.end()
  } catch (err) {
    const info = statusForError(err)
    logError('streaming translation failed:', info.message)
    if (!res.headersSent) {
      sendAnthropicError(res, info.status, info.type, info.message)
    } else {
      write(
        `event: error\ndata: ${JSON.stringify({
          type: 'error',
          error: { type: info.type, message: info.message }
        })}\n\n`
      )
      res.end()
    }
  } finally {
    clearTimeout(timer)
  }
}

async function handleMessages(req: Request, res: Response): Promise<void> {
  state.requestCount += 1
  emit()

  if (!activeConfig) {
    sendAnthropicError(res, 503, 'overloaded_error', 'Gateway has no active model configuration')
    return
  }
  const body = isObject(req.body) ? req.body : {}
  const wantsStream = Boolean(body.stream)

  try {
    if (activeConfig.kind === 'anthropic') {
      await handleAnthropicPassThrough(req, res)
      return
    }
    const openaiBody = buildOpenAIRequest(body, activeConfig)
    if (wantsStream && activeConfig.supportsStreaming !== false) {
      await handleTranslateStreaming(req, res, activeConfig, openaiBody)
    } else {
      await handleTranslateNonStreaming(req, res, activeConfig, openaiBody)
    }
  } catch (err) {
    // Defensive: nothing above should throw, but never let it crash the app.
    logError('unhandled gateway error:', err)
    sendAnthropicError(res, 500, 'api_error', 'Internal gateway error')
  }
}

/* ------------------------------------------------------------------ */
/* Server lifecycle                                                    */
/* ------------------------------------------------------------------ */

function buildApp(): express.Express {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '50mb' }))

  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: state.status,
      ok: state.status === 'running',
      activeConfigId: state.activeConfigId,
      requestCount: state.requestCount
    })
  })

  app.post('/v1/messages', (req: Request, res: Response) => {
    if (!authorized(req)) {
      sendAnthropicError(res, 401, 'authentication_error', 'Invalid or missing gateway token')
      return
    }
    void handleMessages(req, res)
  })

  // Catch-all: keep responses Anthropic-shaped.
  app.use((req: Request, res: Response) => {
    sendAnthropicError(res, 404, 'not_found_error', `No route for ${req.method} ${req.path}`)
  })

  // Express error handler (e.g. malformed JSON body).
  app.use((err: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
    const message = err instanceof Error ? err.message : 'Bad request'
    sendAnthropicError(res, 400, 'invalid_request_error', message)
  })

  return app
}

/**
 * Start the gateway, routing to the model config with `configId`.
 * Picks a free port when `port` is falsy/0/busy.
 */
export async function startGateway(configId: string, port?: number): Promise<GatewayState> {
  if (state.status === 'running' && server && state.activeConfigId === configId) {
    return snapshot()
  }
  // Serialise concurrent starts.
  if (startPromise) await startPromise.catch(() => undefined)

  const run = async (): Promise<GatewayState> => {
    state.status = 'starting'
    state.error = null
    state.activeConfigId = configId
    emit()

    try {
      const config = getModelConfigs().find((c) => c.id === configId)
      if (!config) throw new Error(`Unknown model config: ${configId}`)
      if (!config.baseUrl) throw new Error(`Model config "${config.name}" has no base URL`)

      // Tear down any previous server first.
      if (server) await closeServer()

      const listenPort = await findFreePort(port)
      const app = buildApp()

      await new Promise<void>((resolve, reject) => {
        const s = createServer(app)
        s.once('error', reject)
        s.listen(listenPort, '127.0.0.1', () => {
          s.removeListener('error', reject)
          resolve()
        })
        server = s
      })

      activeConfig = config
      state.port = listenPort
      state.baseUrl = `http://127.0.0.1:${listenPort}`
      state.token = state.token ?? randomUUID()
      state.status = 'running'
      state.error = null
      log(`listening on ${state.baseUrl} → ${config.kind} ${config.baseUrl}`)
      emit()
      return snapshot()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logError('start failed:', message)
      await closeServer().catch(() => undefined)
      activeConfig = null
      state.status = 'error'
      state.error = message
      state.port = null
      state.baseUrl = null
      emit()
      return snapshot()
    }
  }

  startPromise = run()
  try {
    return await startPromise
  } finally {
    startPromise = null
  }
}

function closeServer(): Promise<void> {
  const s = server
  server = null
  if (!s) return Promise.resolve()
  return new Promise((resolve) => {
    s.close(() => resolve())
    // Force-close idle keep-alive connections so close() resolves promptly.
    s.closeAllConnections?.()
  })
}

/** Stop the gateway and reset state to `stopped`. */
export async function stopGateway(): Promise<GatewayState> {
  try {
    await closeServer()
  } catch (err) {
    logError('stop failed:', err)
  }
  activeConfig = null
  state.status = 'stopped'
  state.port = null
  state.baseUrl = null
  state.activeConfigId = null
  state.token = null
  state.error = null
  emit()
  return snapshot()
}

/**
 * Normalise an Anthropic-compatible base URL to the root Claude Code expects
 * (it appends `/v1/messages` itself). Strips a trailing `/v1/messages`,
 * `/messages`, or `/v1` so a user can paste any of those forms.
 */
function anthropicBaseUrl(baseUrl: string): string {
  return (baseUrl || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/v1\/messages$/, '')
    .replace(/\/messages$/, '')
    .replace(/\/v1$/, '')
}

/**
 * Environment that points Claude Code **directly** at a native
 * Anthropic-compatible upstream, bypassing the gateway. Only meaningful for
 * `kind === 'anthropic'`; every other provider kind must be translated by the
 * gateway. Returns `{}` when the config cannot be reached directly.
 *
 * We inject `ANTHROPIC_API_KEY` (not `ANTHROPIC_AUTH_TOKEN`) so Claude Code
 * sends the key as the `x-api-key` header — the two must never both be set.
 */
export function directEnvFor(config: ModelConfig | null | undefined): Record<string, string> {
  if (!config || config.kind !== 'anthropic' || !config.baseUrl) return {}
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: anthropicBaseUrl(config.baseUrl)
  }
  if (config.apiKey) env.ANTHROPIC_API_KEY = config.apiKey
  if (config.model) env.ANTHROPIC_MODEL = config.model
  return env
}

/**
 * Environment Claude Code needs to reach its model, given the effective config.
 *
 * - `kind === 'anthropic'` → direct injection (no gateway involved).
 * - any other kind → the gateway's base URL + token, but only when the gateway
 *   is running *and* actually routing to `config` (so we never point Claude at
 *   the wrong upstream). Empty otherwise.
 *
 * Called with no argument it keeps the legacy behaviour: the gateway env while
 * running, else `{}`.
 */
export function getActiveEnv(config?: ModelConfig | null): Record<string, string> {
  // A native Anthropic-compatible upstream is reached directly, always.
  if (config && config.kind === 'anthropic') return directEnvFor(config)
  if (state.status !== 'running' || !state.baseUrl) return {}
  // A specific config was requested but the gateway is routing elsewhere.
  if (config && state.activeConfigId !== config.id) return {}
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: state.baseUrl
  }
  if (state.token) env.ANTHROPIC_AUTH_TOKEN = state.token
  const model = activeConfig?.model ?? config?.model
  if (model) env.ANTHROPIC_MODEL = model
  return env
}

/* ------------------------------------------------------------------ */
/* Smoke test helper                                                   */
/* ------------------------------------------------------------------ */
/*
 * Runnable end-to-end check without Electron (uses a tiny mock upstream):
 *
 *   node src/main/services/gateway.smoke.mjs
 *
 * It boots the gateway against a mock OpenAI server, POSTs an Anthropic-shaped
 * `/v1/messages` request, and asserts the translated response. A pure-curl
 * equivalent once the app is running (token printed in the UI):
 *
 *   curl -s http://127.0.0.1:8788/health
 *   curl -s -X POST http://127.0.0.1:8788/v1/messages \
 *     -H 'content-type: application/json' \
 *     -H 'x-api-key: <GATEWAY_TOKEN>' \
 *     -d '{"model":"x","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}'
 */

export type { ProviderKind }
