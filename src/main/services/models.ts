/**
 * CC Deck — model configuration CRUD + upstream connectivity testing.
 *
 * Configs are persisted in the shared electron-store facade (`../store`). This
 * module never talks to the raw store shape; it uses the typed model-config
 * accessors so it stays in sync with whatever schema the store owner defines.
 *
 * `testModel` is deliberately forgiving: it never throws and always resolves to
 * a `TestConnectionResult` so the renderer can render a friendly error.
 */
import type { ModelConfig, TestConnectionResult } from '@shared/types'
import { getModelConfigs, setModelConfigs } from '../store'

const DEFAULT_TEST_TIMEOUT_MS = 8000

/* ------------------------------------------------------------------ */
/* CRUD                                                                */
/* ------------------------------------------------------------------ */

/** Return every persisted model config (insertion order). */
export async function listModels(): Promise<ModelConfig[]> {
  return getModelConfigs()
}

/** Insert or update a config by `id`; returns the full, updated list. */
export async function saveModel(config: ModelConfig): Promise<ModelConfig[]> {
  const list = getModelConfigs()
  const index = list.findIndex((c) => c.id === config.id)
  if (index >= 0) {
    list[index] = { ...list[index], ...config }
  } else {
    list.push(config)
  }
  return setModelConfigs(list)
}

/** Delete a config by `id`; returns the full, updated list. */
export async function removeModel(id: string): Promise<ModelConfig[]> {
  const list = getModelConfigs().filter((c) => c.id !== id)
  return setModelConfigs(list)
}

/* ------------------------------------------------------------------ */
/* Connectivity testing                                                */
/* ------------------------------------------------------------------ */

function trimSlash(url: string): string {
  return (url || '').trim().replace(/\/+$/, '')
}

/**
 * Normalise a configured base URL to an API root ending in `/v1` (unless it
 * already ends in `/v1`, a deeper version segment, or a full endpoint path).
 */
function normalizeBaseUrl(baseUrl: string): string {
  let url = trimSlash(baseUrl)
  if (!url) return url
  if (/\/chat\/completions$/.test(url)) url = url.replace(/\/chat\/completions$/, '')
  if (/\/messages$/.test(url)) url = url.replace(/\/messages$/, '')
  if (!/\/v\d+$/.test(url)) url = `${url}/v1`
  return url
}

function extractModelIds(json: unknown): string[] {
  if (json == null) return []
  const root = json as Record<string, unknown>
  let arr: unknown[] = []
  if (Array.isArray(root.data)) arr = root.data
  else if (Array.isArray(root.models)) arr = root.models
  else if (Array.isArray(json)) arr = json as unknown[]
  const ids: string[] = []
  for (const item of arr) {
    if (typeof item === 'string') ids.push(item)
    else if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>
      const candidate = o.id ?? o.name ?? o.model
      if (typeof candidate === 'string') ids.push(candidate)
    }
  }
  return ids
}

function truncate(text: string, max = 400): string {
  const clean = (text || '').replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'AbortError') return 'Request timed out'
    return err.message
  }
  return String(err)
}

interface ProbeResult {
  ok: boolean
  status: number | null
  latencyMs: number
  text: string
  json: unknown
}

async function probe(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<ProbeResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    const text = await res.text()
    const latencyMs = Date.now() - started
    let json: unknown = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    return { ok: res.ok, status: res.status, latencyMs, text, json }
  } finally {
    clearTimeout(timer)
  }
}

function bearerHeaders(apiKey: string, extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`
  if (extra) for (const [k, v] of Object.entries(extra)) headers[k] = v
  return headers
}

/** Try `/models` then `/v1/models` for `custom` providers. */
async function testOpenAICompatible(
  config: ModelConfig,
  timeoutMs: number,
  tryBoth: boolean
): Promise<TestConnectionResult> {
  const base = normalizeBaseUrl(config.baseUrl)
  const urls = tryBoth
    ? Array.from(new Set([`${base}/models`, `${trimSlash(config.baseUrl)}/v1/models`]))
    : [`${base}/models`]
  let last: TestConnectionResult = {
    ok: false,
    latencyMs: null,
    models: [],
    message: 'No endpoint reachable',
    status: null
  }
  for (const url of urls) {
    try {
      const res = await probe(
        url,
        { method: 'GET', headers: bearerHeaders(config.apiKey, config.headers) },
        timeoutMs
      )
      const models = extractModelIds(res.json)
      if (res.ok) {
        return {
          ok: true,
          latencyMs: res.latencyMs,
          models,
          message: `Connected — ${models.length} model(s) available (HTTP ${res.status})`,
          status: res.status
        }
      }
      last = {
        ok: false,
        latencyMs: res.latencyMs,
        models,
        message: `HTTP ${res.status}: ${truncate(res.text) || 'request rejected'}`,
        status: res.status
      }
    } catch (err) {
      last = {
        ok: false,
        latencyMs: null,
        models: [],
        message: `${url} — ${errorMessage(err)}`,
        status: null
      }
    }
  }
  return last
}

/**
 * Ollama exposes two surfaces: the native API (`/api/tags`) and an
 * OpenAI-compat one (`/v1/models`). Detect which one the base URL points at and
 * probe the matching discovery endpoint.
 */
async function testOllama(config: ModelConfig, timeoutMs: number): Promise<TestConnectionResult> {
  const raw = trimSlash(config.baseUrl)
  const isNative = /\/api(\/|$)/.test(raw)
  const url = isNative
    ? `${raw.replace(/\/chat$/, '')}/tags`
    : `${normalizeBaseUrl(raw)}/models`
  try {
    const res = await probe(
      url,
      { method: 'GET', headers: bearerHeaders(config.apiKey, config.headers) },
      timeoutMs
    )
    const models = extractModelIds(res.json)
    if (res.ok) {
      return {
        ok: true,
        latencyMs: res.latencyMs,
        models,
        message: `Connected — Ollama reachable, ${models.length} model(s) (HTTP ${res.status})`,
        status: res.status
      }
    }
    return {
      ok: false,
      latencyMs: res.latencyMs,
      models,
      message: `HTTP ${res.status}: ${truncate(res.text) || 'request rejected'}`,
      status: res.status
    }
  } catch (err) {
    return { ok: false, latencyMs: null, models: [], message: errorMessage(err), status: null }
  }
}

async function testAnthropic(config: ModelConfig, timeoutMs: number): Promise<TestConnectionResult> {
  const url = `${normalizeBaseUrl(config.baseUrl)}/messages`
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01'
  }
  if (config.apiKey) headers['x-api-key'] = config.apiKey
  if (config.headers) for (const [k, v] of Object.entries(config.headers)) headers[k] = v
  const model = config.model || 'claude-3-5-haiku-20241022'
  const body = JSON.stringify({
    model,
    max_tokens: 1,
    messages: [{ role: 'user', content: 'ping' }]
  })
  try {
    const res = await probe(url, { method: 'POST', headers, body }, timeoutMs)
    if (res.ok) {
      return {
        ok: true,
        latencyMs: res.latencyMs,
        models: [model],
        message: `Connected — Anthropic-compatible endpoint OK (HTTP ${res.status})`,
        status: res.status
      }
    }
    return {
      ok: false,
      latencyMs: res.latencyMs,
      models: [],
      message: `HTTP ${res.status}: ${truncate(res.text) || 'request rejected'}`,
      status: res.status
    }
  } catch (err) {
    return { ok: false, latencyMs: null, models: [], message: errorMessage(err), status: null }
  }
}

/**
 * Ping the configured upstream and measure round-trip latency. Never throws.
 */
export async function testModel(config: ModelConfig): Promise<TestConnectionResult> {
  if (!config || !config.baseUrl) {
    return { ok: false, latencyMs: null, models: [], message: 'Missing base URL', status: null }
  }
  const timeoutMs =
    typeof config.timeoutMs === 'number' && config.timeoutMs > 0
      ? config.timeoutMs
      : DEFAULT_TEST_TIMEOUT_MS
  try {
    switch (config.kind) {
      case 'anthropic':
        return await testAnthropic(config, timeoutMs)
      case 'ollama':
        return await testOllama(config, timeoutMs)
      case 'custom':
        return await testOpenAICompatible(config, timeoutMs, true)
      case 'openai-compatible':
      default:
        return await testOpenAICompatible(config, timeoutMs, false)
    }
  } catch (err) {
    return { ok: false, latencyMs: null, models: [], message: errorMessage(err), status: null }
  }
}
