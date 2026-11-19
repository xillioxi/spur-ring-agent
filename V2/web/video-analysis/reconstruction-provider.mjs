import { createRequire } from 'node:module'
import https from 'node:https'

const require = createRequire(import.meta.url)
const publicNetwork = require('../../agent/tools/playwright-browser/public-network.cjs')
const MODEL = 'MiniMaxAI/MiniMax-H3'
const RATIOS = ['1:1', '3:4', '4:3', '9:16', '16:9', '21:9']
const RESOLUTIONS = ['480p', '768p']
const MAX_RESPONSE_BYTES = 512 * 1024
const MAX_DOWNLOAD_BYTES = 150 * 1024 ** 2
const clean = value => typeof value === 'string' ? value.trim() : ''
const error = (message, status = 502, code = 'reconstruction_provider_error', definitive = false) => Object.assign(new Error(message), { status, code, definitive })
const cancelError = definitive => error('Video reconstruction cancelled.', 499, 'reconstruction_cancelled', definitive)

function cancelled(signal, definitive = true) { if (signal?.aborted) throw cancelError(definitive) }

function configuration(config = {}) {
  const apiKey = clean(config.SILICONFLOW_API_KEY)
  if (!apiKey || /[\r\n]/.test(apiKey)) throw error('Configure SILICONFLOW_API_KEY on the server before generating a video.', 503, 'reconstruction_configuration', true)
  if (clean(config.SPUR_VIDEO_RECONSTRUCTION_MODEL) && clean(config.SPUR_VIDEO_RECONSTRUCTION_MODEL) !== MODEL) throw error('Configure MiniMaxAI/MiniMax-H3 for reconstruction; unsupported or retired models cannot be substituted automatically.', 503, 'reconstruction_configuration', true)
  let base
  try { base = new URL(config.SILICONFLOW_BASE_URL || 'https://api.siliconflow.cn/v1') } catch { throw error('Configure a valid HTTPS SiliconFlow API base URL.', 503, 'reconstruction_configuration', true) }
  if (base.protocol !== 'https:' || !base.hostname || base.username || base.password || base.search || base.hash) throw error('Configure a valid HTTPS SiliconFlow API base URL without credentials, query or fragment.', 503, 'reconstruction_configuration', true)
  return { apiKey, base: base.href.replace(/\/+$/, ''), model: MODEL }
}

export function reconstructionCapability(config = {}) {
  const metadata = { available: false, configured: Boolean(clean(config.SILICONFLOW_API_KEY)), provider: 'siliconflow', model: MODEL, minDurationSeconds: 5, maxDurationSeconds: 15, ratios: [...RATIOS], resolutions: [...RESOLUTIONS], defaultRatio: '9:16', defaultResolution: '768p' }
  try { configuration(config); return { ...metadata, available: true } } catch (cause) { return { ...metadata, reason: cause.message } }
}

async function readJson(response) {
  if (Number(response.headers?.get('content-length')) > MAX_RESPONSE_BYTES) throw error('Video service response exceeded its size limit.')
  if (!response.body?.getReader) throw error('Video service returned an empty response.')
  const reader = response.body.getReader(), chunks = []
  let bytes = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw error('Video service response exceeded its size limit.') }
      chunks.push(Buffer.from(part.value))
    }
  } finally { reader.releaseLock() }
  let parsed
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw error('Video service returned invalid JSON.') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw error('Video service returned an invalid response.')
  return parsed
}

async function call(config, route, body, signal, submitting = false) {
  cancelled(signal)
  const settings = configuration(config)
  const controller = new AbortController()
  const abort = () => controller.abort()
  const timer = setTimeout(abort, 30000)
  signal?.addEventListener('abort', abort, { once: true })
  try {
    cancelled(signal)
    const response = await fetch(`${settings.base}${route}`, { method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${settings.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal })
    if (!response.ok) {
      try { await response.body?.cancel() } catch {}
      const status = Number.isInteger(response.status) && response.status >= 400 && response.status <= 599 ? response.status : 502
      const definitive = status >= 400 && status < 500 && ![408, 409].includes(status)
      if ([401, 403].includes(status)) throw error('The video service rejected the server API key or account permissions.', status, 'reconstruction_authentication', true)
      if (status === 429) throw error('The video service rate limit was reached. No generation was automatically retried.', 429, 'reconstruction_rate_limit', true)
      throw error(`The video service rejected the request (HTTP ${status}). No generation was automatically retried.`, status, definitive ? 'reconstruction_provider_error' : submitting ? 'reconstruction_submission_unknown' : 'reconstruction_provider_error', definitive)
    }
    return await readJson(response)
  } catch (cause) {
    if (signal?.aborted) throw cancelError(false)
    if (controller.signal.aborted) throw error(submitting ? 'Video submission timed out; its outcome is unknown. Do not automatically submit it again.' : 'Video status query timed out.', 504, submitting ? 'reconstruction_submission_unknown' : 'reconstruction_timeout', false)
    if (cause?.code?.startsWith('reconstruction_')) {
      if (submitting && !cause.definitive) throw error(cause.message, cause.status, 'reconstruction_submission_unknown', false)
      throw cause
    }
    throw error(submitting ? 'Video submission could not be confirmed. Do not automatically submit it again.' : 'The video status query could not complete.', 502, submitting ? 'reconstruction_submission_unknown' : 'reconstruction_provider_error', false)
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}

function validRequestId(value, config) {
  const key = clean(config?.SILICONFLOW_API_KEY)
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(value) && (!key || !value.includes(key))
}

export async function submitReconstructionClip({ config = {}, prompt, durationSeconds, ratio = '9:16', resolution = '768p', signal } = {}) {
  cancelled(signal)
  const settings = configuration(config)
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 8000 || prompt.includes('\0')) throw error('Provide a reconstruction prompt of 1–8000 characters.', 422, 'reconstruction_invalid_request', true)
  if (!Number.isInteger(durationSeconds) || durationSeconds < 5 || durationSeconds > 15) throw error('Generated clips require an integer duration from 5 to 15 seconds.', 422, 'reconstruction_invalid_request', true)
  if (!RATIOS.includes(ratio) || !RESOLUTIONS.includes(resolution)) throw error('Choose a supported video aspect ratio and resolution.', 422, 'reconstruction_invalid_request', true)
  const result = await call(config, '/video/submit', { model: settings.model, prompt: prompt.trim(), duration: durationSeconds, ratio, resolution }, signal, true)
  if (!validRequestId(result.requestId, config)) throw error('The video service did not return a usable task identifier; submission outcome is unknown. Do not automatically submit it again.', 502, 'reconstruction_submission_unknown', false)
  return { requestId: result.requestId }
}

function safeVideoUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) throw error('Video service returned an invalid result location.')
  try {
    const url = publicNetwork.publicUrl(value)
    if (url.protocol !== 'https:') throw new Error('HTTPS required')
    return url.href
  } catch { throw error('Video service returned an unsupported or private result location.') }
}

export async function getReconstructionClip({ config = {}, requestId, signal } = {}) {
  cancelled(signal)
  if (!validRequestId(requestId, config)) throw error('Provide a valid existing video task identifier.', 422, 'reconstruction_invalid_request', true)
  const result = await call(config, '/video/status', { requestId }, signal)
  const status = { InQueue: 'queued', InProgress: 'generating', Succeed: 'ready', Failed: 'failed' }[result.status]
  if (!status) throw error('Video service returned an unknown task status.')
  if (status !== 'ready') return { status }
  const url = result.results?.videos?.[0]?.url
  if (typeof url === 'string' && clean(config.SILICONFLOW_API_KEY) && url.includes(clean(config.SILICONFLOW_API_KEY))) throw error('Video service returned an invalid result location.')
  return { status, url: safeVideoUrl(url) }
}

async function resolveDestination(hostname, signal) {
  cancelled(signal, false)
  let abort
  const interrupted = new Promise((_, reject) => { abort = () => reject(cancelError(false)); signal.addEventListener('abort', abort, { once: true }) })
  try {
    const result = await Promise.race([publicNetwork.resolvePublic(hostname), interrupted])
    cancelled(signal, false)
    if (!publicNetwork.isPublicAddress(result.address)) throw error('Video download destination is not public.')
    return result
  } finally { signal.removeEventListener('abort', abort) }
}

async function downloadOnce(value, signal) {
  const url = new URL(safeVideoUrl(value)), hostname = url.hostname.replace(/^\[|\]$/g, '')
  const record = await resolveDestination(hostname, signal)
  return new Promise((resolve, reject) => {
    const request = https.get({ hostname: record.address, family: record.family, port: url.port || 443, servername: hostname, path: url.pathname + url.search, headers: { Host: url.host, 'User-Agent': 'Spur/1.0 video reconstruction', Accept: 'video/mp4,application/octet-stream' }, agent: false, signal }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && typeof response.headers.location === 'string') {
        response.destroy()
        try { resolve({ redirect: new URL(response.headers.location, url).href }) } catch { reject(error('Video download returned an invalid redirect.')) }
        return
      }
      if (!(response.statusCode >= 200 && response.statusCode < 300)) { response.destroy(); reject(error('The generated video could not be downloaded.')); return }
      const type = response.headers['content-type'] || ''
      if (type && !/^(?:video\/mp4|application\/octet-stream|binary\/octet-stream)(?:;|$)/i.test(type) || Number(response.headers['content-length']) > MAX_DOWNLOAD_BYTES) { response.destroy(); reject(error('The generated video has an unsupported type or exceeds the 150 MiB download limit.')); return }
      const chunks = []
      let bytes = 0
      response.on('data', chunk => { bytes += chunk.length; if (bytes > MAX_DOWNLOAD_BYTES) { response.destroy(); reject(error('The generated video exceeds the 150 MiB download limit.')) } else chunks.push(Buffer.from(chunk)) })
      response.on('error', () => reject(error('The generated video download was interrupted.')))
      response.on('end', () => resolve({ bytes: Buffer.concat(chunks) }))
    })
    request.setTimeout(30000, () => request.destroy())
    request.on('error', () => reject(error('The generated video download could not complete.')))
  })
}

export async function downloadReconstructionClip(url, { signal } = {}) {
  cancelled(signal)
  const controller = new AbortController(), abort = () => controller.abort()
  const timer = setTimeout(abort, 120000)
  signal?.addEventListener('abort', abort, { once: true })
  try {
    let location = url
    for (let redirects = 0; redirects <= 5; redirects++) {
      cancelled(signal, false)
      const result = await downloadOnce(location, controller.signal)
      if (result.redirect) { location = result.redirect; continue }
      if (result.bytes.length < 12 || result.bytes.toString('ascii', 4, 8) !== 'ftyp') throw error('The generated file is not a supported MP4 video.')
      return result.bytes
    }
    throw error('The generated video exceeded the safe redirect limit.')
  } catch (cause) {
    if (signal?.aborted) throw cancelError(false)
    if (controller.signal.aborted) throw error('The generated video download timed out.', 504, 'reconstruction_timeout', false)
    if (cause?.code?.startsWith('reconstruction_')) throw cause
    throw error('The generated video could not be downloaded safely.')
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}
