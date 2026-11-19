import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import { analysisPrompt as prompt, normalizeAnalysis } from './multimodal-format.mjs'
import path from 'node:path'
import { buildAudioTimeline, annotateAudioShots } from './audio-timeline.mjs'

const PROVIDER = 'siliconflow'
const DEFAULT_MODEL = 'Qwen/Qwen3-Omni-30B-A3B-Instruct'
const VIDEO_FPS = 2
const MAX_VIDEO_FRAMES = 128
const MAX_DURATION = 300
const MAX_MEDIA_BYTES = 12 * 1024 ** 2
const MAX_VIDEO_BYTES = 48 * 1024 ** 2
const MAX_BODY_BYTES = 84 * 1024 ** 2
const MAX_RESPONSE_BYTES = 2 * 1024 ** 2
const REQUEST_TIMEOUT_MS = 180000
const finite = value => typeof value === 'number' && Number.isFinite(value)
const round = value => Math.round(value * 1000) / 1000
const clean = (value, max = 4000) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max) : ''

function failure(message, status = 502, code = 'siliconflow_analysis_failed') {
  return Object.assign(new Error(message), { status, code })
}

function cancelled(signal) {
  if (signal?.aborted) throw failure('Video analysis cancelled.', 499, 'analysis_cancelled')
}

function modelName(config = {}) {
  const value = clean(config.SPUR_VIDEO_ANALYSIS_CLOUD_MODEL, 200)
  // The model identifier is configuration, not a prompt or a place for credentials.
  return /^[a-zA-Z0-9_.:/-]+$/.test(value) && !value.startsWith('sk-') ? value : DEFAULT_MODEL
}

function apiKey(config = {}) {
  return typeof config.SILICONFLOW_API_KEY === 'string' ? config.SILICONFLOW_API_KEY.trim() : ''
}

function endpoint(config = {}) {
  let url
  try { url = new URL(config.SILICONFLOW_BASE_URL || 'https://api.siliconflow.cn/v1') } catch { throw failure('Configure a valid HTTPS SiliconFlow API base URL.', 503, 'siliconflow_configuration') }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) throw failure('Configure a valid HTTPS SiliconFlow API base URL without credentials, query or fragment.', 503, 'siliconflow_configuration')
  return `${url.href.replace(/\/+$/, '')}/chat/completions`
}

export function siliconFlowConfigured(config = {}) {
  return config.SPUR_VIDEO_ANALYSIS_PROVIDER === PROVIDER
}

export function siliconFlowCapability(config = {}) {
  const configured = Boolean(apiKey(config))
  const metadata = { available: configured, configured, provider: PROVIDER, model: modelName(config), inputMode: 'video_and_audio', mediaTransport: 'original_video' }
  if (!configured) return { ...metadata, reason: 'Configure SILICONFLOW_API_KEY on the server to enable cloud video analysis.' }
  try { endpoint(config) } catch { return { ...metadata, available: false, reason: 'Configure a valid HTTPS SiliconFlow API base URL.' } }
  return metadata
}

async function boundedJson(response) {
  const declared = response.headers?.get('content-length')
  if (declared && Number(declared) > MAX_RESPONSE_BYTES) throw failure('SiliconFlow response exceeded the analysis size limit.')
  if (!response.body?.getReader) throw failure('SiliconFlow returned an empty analysis response.')
  const reader = response.body.getReader()
  const chunks = []
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw failure('SiliconFlow response exceeded the analysis size limit.') }
      chunks.push(Buffer.from(value))
    }
  } finally { reader.releaseLock() }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw failure('SiliconFlow returned invalid analysis JSON.') }
}

async function request(body, config, signal) {
  cancelled(signal)
  const serialized = JSON.stringify(body)
  if (Buffer.byteLength(serialized) > MAX_BODY_BYTES) throw failure('Prepared media exceeded the cloud analysis size limit.', 413)
  const controller = new AbortController()
  const abort = () => controller.abort()
  const timer = setTimeout(abort, REQUEST_TIMEOUT_MS)
  signal?.addEventListener('abort', abort, { once: true })
  try {
    const response = await fetch(endpoint(config), {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey(config)}` },
      body: serialized,
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      if ([401, 403].includes(response.status)) throw failure('SiliconFlow rejected the server API key or account permissions.', response.status, 'siliconflow_authentication')
      if (response.status === 429) throw failure('SiliconFlow rate limit reached. Wait before starting analysis again.', 429, 'siliconflow_rate_limit')
      if (response.status >= 300 && response.status < 400) throw failure('SiliconFlow redirects are not allowed.', 502, 'siliconflow_redirect')
      throw failure(`SiliconFlow could not analyze this interval (HTTP ${Number(response.status) || 502}). Check that the configured model supports the supplied media.`, response.status >= 400 && response.status <= 599 ? response.status : 502)
    }
    const result = await boundedJson(response)
    cancelled(signal)
    return result
  } catch (error) {
    cancelled(signal)
    if (controller.signal.aborted) throw failure('SiliconFlow analysis timed out. No paid request was retried.', 504, 'siliconflow_timeout')
    if (error?.code?.startsWith('siliconflow_')) throw error
    // Network exceptions and provider error bodies may include URLs, keys or paths.
    throw failure('The SiliconFlow analysis request could not complete. No paid request was retried.')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

function normalize(rawText, options) { return normalizeAnalysis(rawText, { ...options, providerLabel: 'SiliconFlow', errorFactory: failure }) }

function usageOf(value) {
  const numeric = key => Number.isSafeInteger(value?.[key]) && value[key] >= 0 ? value[key] : 0
  const result = { promptTokens: numeric('prompt_tokens'), completionTokens: numeric('completion_tokens'), totalTokens: numeric('total_tokens') }
  const reasoning = value?.completion_tokens_details?.reasoning_tokens
  if (Number.isSafeInteger(reasoning) && reasoning >= 0) result.reasoningTokens = reasoning
  if (!result.totalTokens) result.totalTokens = result.promptTokens + result.completionTokens
  return result
}

async function mediaData(file, mime, maximum = MAX_MEDIA_BYTES) {
  const info = await stat(file)
  if (!info.isFile() || !info.size || info.size > maximum) throw failure('The complete media file exceeds Spur\'s direct cloud analysis size limit.', 413)
  const bytes = await readFile(file)
  if (bytes.length > maximum) throw failure('The complete media file exceeds Spur\'s direct cloud analysis size limit.', 413)
  return `data:${mime};base64,${bytes.toString('base64')}`
}

export async function analyzeSiliconFlow({ filePath, mode = 'both', scriptTemplateId = 'none', config = {}, signal, onProgress, measurement, runProcess, ffmpegPath = 'ffmpeg', tempRoot = os.tmpdir() } = {}) {
  cancelled(signal)
  if (!siliconFlowConfigured(config)) throw failure('Explicitly select the SiliconFlow analysis provider first.', 503, 'siliconflow_configuration')
  if (!apiKey(config)) throw failure('Configure SILICONFLOW_API_KEY on the server to analyze videos.', 503, 'siliconflow_configuration')
  endpoint(config)
  if (!['both', 'breakdown', 'script', 'audio'].includes(mode)) throw failure('Choose both, breakdown, script or audio analysis.', 400)
  const duration = measurement?.analyzedDurationSeconds
  if (!finite(duration) || duration <= 0 || duration > MAX_DURATION || measurement?.metadata?.durationSeconds > MAX_DURATION) throw failure('Choose a video of 5 minutes or less with a measurable duration.', 422)
  if (typeof runProcess !== 'function') throw failure('Cloud video analysis requires the media preparation tools.', 503)
  const hasAudio = measurement.metadata?.hasAudio === true
  // Older installations may still define VISION_MODEL. Native video always
  // goes to the selected Omni model; that legacy setting cannot select frames.
  const model = modelName(config)
  const inputMode = mode === 'audio' ? 'audio' : hasAudio ? 'video_and_audio' : 'video'
  const warnings = ['The complete video is sent to the multimodal model. SiliconFlow decodes and samples it internally; fast actions, cuts or small text may be missed. Shot sections and timestamps are model estimates, and may separate actions within a continuous take. Verify important details against the original video.']
  if (hasAudio && mode !== 'breakdown') warnings.push('Speech is machine transcribed from the audio. Check words, names and timing against the original; music can cause false transcripts.')
  const successful = [], coverage = [], summaries = [], languages = [], shots = [], segments = [], onScreenText = [], semanticSegments = [], semanticEvents = [], descriptions = []
  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, reasoningTokens: 0 }
  const usageByModel = Object.create(null)
  const accountedRequest = async (body, passedConfig, passedSignal) => {
    const response = await request(body, passedConfig, passedSignal)
    const billed = usageOf(response.usage)
    usageByModel[body.model] ||= { promptTokens: 0, completionTokens: 0, totalTokens: 0, reasoningTokens: 0 }
    for (const key of Object.keys(usage)) { usage[key] += billed[key] || 0; usageByModel[body.model][key] += billed[key] || 0 }
    return response
  }
  const chunkCount = mode === 'audio' && !hasAudio ? 0 : 1
  const root = path.resolve(tempRoot)
  let directory, lastFailure, scriptStructure
  try {
    if (chunkCount) { await mkdir(root, { recursive: true }); directory = await mkdtemp(path.join(root, 'spur-siliconflow-')) }
    for (let index = 0; index < chunkCount; index++) {
      cancelled(signal)
      const start = 0, length = duration
      const interval = { startSeconds: round(start), endSeconds: round(start + length) }
      onProgress?.({ stage: 'preparing_cloud_media', percent: 15, message: 'Preparing the complete video and synchronized audio' })
      const audio = path.join(directory, 'complete-audio.wav')
      try {
        const content = []
        const base = ['-hide_banner', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe', '-i', filePath]
        if (mode !== 'audio') {
          const mime = ({ '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.m4v': 'video/mp4', '.avi': 'video/x-msvideo' })[path.extname(filePath).toLowerCase()] || 'video/mp4'
          content.push({ type: 'video_url', video_url: { url: await mediaData(filePath, mime, MAX_VIDEO_BYTES), detail: 'auto', fps: VIDEO_FPS, max_frames: MAX_VIDEO_FRAMES } })
        }
        if (hasAudio) {
          await runProcess(ffmpegPath, [...base, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-map_metadata', '-1', '-f', 'wav', audio], { signal, timeoutMs: 60000, maxBytes: 1024 ** 2 })
          cancelled(signal)
          content.push({ type: 'audio_url', audio_url: { url: await mediaData(audio, 'audio/wav') } })
        }
        content.push({ type: 'text', text: prompt({ mode, duration: length, hasAudio, scriptTemplateId }) })
        onProgress?.({ stage: 'analyzing_cloud', percent: 30, message: 'SiliconFlow is analyzing the complete video and audio together' })
        // SiliconFlow's current Omni Thinking endpoint rejects guided JSON mode.
        // Its final text still goes through the same strict JSON validation.
        const thinking = model.endsWith('-Thinking')
        const response = await accountedRequest({ model, messages: [{ role: 'user', content }], stream: false, temperature: thinking ? 0.6 : 0.1, max_tokens: thinking ? 16384 : 8192, ...(thinking ? { top_p: 0.95, top_k: 20 } : {}) }, config, signal)
        const observation = normalize(response.choices?.[0]?.message?.content, { duration: length, offset: 0, mode, hasAudio, scriptTemplateId })
        const truncated = response.choices?.[0]?.finish_reason === 'length'
        const partial = observation.discarded > 0 || truncated
        if (partial) warnings.push(`Video analysis needs review: ${[...observation.reviewReasons, ...(truncated ? ['the provider truncated its output'] : [])].join('; ')}.`)
        coverage.push({ ...interval, status: partial ? 'partial' : 'analyzed' })
        successful.push(index)
        shots.push(...observation.shots); segments.push(...observation.transcript); onScreenText.push(...observation.onScreenText)
        semanticSegments.push(...observation.semanticSegments); semanticEvents.push(...observation.semanticEvents)
        if (observation.scriptStructure) scriptStructure = observation.scriptStructure
        if (observation.summary) summaries.push(observation.summary)
        if (observation.language) languages.push(observation.language)
        if (observation.semanticDescription) descriptions.push(`${round(start)}–${round(start + length)}s: ${observation.semanticDescription}`)
      } catch (error) {
        cancelled(signal)
        if (['siliconflow_authentication', 'siliconflow_rate_limit'].includes(error?.code)) throw error
        lastFailure = error?.code?.startsWith('siliconflow_') ? error : failure('Media preparation for SiliconFlow analysis failed.', 422)
        coverage.push({ ...interval, status: 'failed' })
        warnings.push(`Cloud analysis failed for ${round(start)}–${round(start + length)} seconds. This interval has no replacement observations.`)
      } finally {
        await rm(audio, { force: true }).catch(() => {})
      }
    }
  } catch (error) {
    cancelled(signal)
    if (error?.code?.startsWith('siliconflow_')) throw error
    throw failure('Cloud media preparation could not complete.', 503, 'siliconflow_media_preparation')
  } finally {
    if (directory) {
      const relative = path.relative(root, path.resolve(directory))
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) await rm(directory, { recursive: true, force: true }).catch(() => warnings.push('Temporary cloud media could not be removed; server cleanup is required.'))
    }
  }
  if (chunkCount && !successful.length) throw failure(`${lastFailure?.message || 'SiliconFlow could not produce usable analysis for any interval.'} No local replacement analysis was substituted.`, lastFailure?.status || 502, lastFailure?.code)
  const status = coverage.some(value => value.status !== 'analyzed') ? 'partial' : 'complete'
  const observationStatus = status === 'complete' ? 'analyzed' : 'partial'
  const audioObservationStatus = observationStatus
  const visualObservationStatus = observationStatus
  const speechStatus = !hasAudio ? 'no_audio' : mode === 'breakdown' ? 'not_requested' : audioObservationStatus
  const script = { segments, text: segments.map(value => value.text).join('\n'), onScreenText }
  shots.forEach((shot, index) => { shot.index = index; shot.onScreenText = [...new Set(onScreenText.filter(value => value.startSeconds < shot.endSeconds && value.endSeconds > shot.startSeconds).map(value => value.text))] })
  const semanticDescription = descriptions.join('\n')
  const semanticStatus = !hasAudio ? 'no_audio' : audioObservationStatus
  const audio = buildAudioTimeline({ durationSeconds: duration, shots, script, measurementAudio: measurement.audio, hasAudio, speechStatus, semanticStatus, semanticEvents, semanticSegments, semanticDescription })
  // Preserve the model's semantic evidence separately from measured RMS/onset prose.
  audio.measurementDescription = audio.measurementDescription || audio.description
  Object.assign(audio, { semanticDescription, semanticSegments, semanticEvents, semanticModel: model, semanticMethod: 'multimodal_audio_understanding' })
  const provenance = {
    multimodal: { provider: PROVIDER, model, inputMode, mediaTransport: mode === 'audio' ? 'audio_track' : 'original_video', chunkCount, successfulChunks: successful.length, sampling: { provider: PROVIDER, fps: VIDEO_FPS, maxFrames: MAX_VIDEO_FRAMES }, status: chunkCount ? observationStatus : 'no_audio', usage, usageByModel, coverage },
    boundaries: { provider: PROVIDER, model, method: 'multimodal_estimated_shot_boundaries', status: ['script', 'audio'].includes(mode) ? 'not_requested' : visualObservationStatus },
    vision: { provider: PROVIDER, model, method: 'multimodal_video_understanding', status: ['script', 'audio'].includes(mode) ? 'not_requested' : visualObservationStatus },
    ocr: { provider: PROVIDER, model, method: 'multimodal_video_ocr', status: mode === 'audio' ? 'not_requested' : visualObservationStatus },
    speech: { provider: PROVIDER, model, method: 'multimodal_audio_transcription', status: speechStatus },
    soundEvents: { provider: PROVIDER, model, method: 'multimodal_audio_understanding', status: semanticStatus },
    audio: { method: 'ffmpeg_rms_energy_onsets', status: measurement.audio?.status || 'unavailable' },
    analyzedDurationSeconds: duration, originalDurationSeconds: measurement.metadata?.durationSeconds,
  }
  onProgress?.({ stage: 'complete', percent: 100, message: status === 'complete' ? 'SiliconFlow video and audio analysis are ready' : 'Available SiliconFlow analysis is ready; some intervals need review' })
  const result = { schemaVersion: 1, status, mode, summary: summaries.join('\n').slice(0, 24000) || (hasAudio ? 'Audio analysis is ready.' : 'This file has no audio track.'), language: [...new Set(languages)].join(', ') || null, shots: annotateAudioShots(shots, audio), script, ...(scriptStructure ? { scriptStructure } : {}), audio, metadata: measurement.metadata, warnings: [...new Set(warnings)], provenance }
  // Defense in depth for a provider accidentally echoing credentials or local paths.
  const sensitive = [apiKey(config), filePath, directory].filter(value => typeof value === 'string' && value.length > 2)
  const redact = value => typeof value === 'string' ? sensitive.reduce((text, token) => text.split(token).join('[redacted]'), value) : Array.isArray(value) ? value.map(redact) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)])) : value
  return redact(result)
}
