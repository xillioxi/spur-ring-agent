import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { analysisPrompt, normalizeAnalysis } from './multimodal-format.mjs'
import { buildAudioTimeline, annotateAudioShots } from './audio-timeline.mjs'

const MODEL = 'Gemini-3.7-Flash'
const MODEL_LABEL = 'Gemini 3.7 Flash'
const MAX_VIDEO_BYTES = 48 * 1024 ** 2
const MAX_AUDIO_BYTES = 12 * 1024 ** 2
const MAX_BODY_BYTES = 84 * 1024 ** 2
const MAX_RESPONSE_BYTES = 2 * 1024 ** 2
const TIMEOUT_MS = 600000
const round = value => Math.round(value * 1000) / 1000
const clean = value => typeof value === 'string' ? value.trim() : ''
const failure = (message, status = 502, code = 'poe_analysis_failed') => Object.assign(new Error(message), { status, code })
const cancelled = signal => { if (signal?.aborted) throw failure('Video analysis cancelled.', 499, 'analysis_cancelled') }

function settings(config = {}) {
  const key = clean(config.POE_API_KEY)
  if (!key || /[\r\n]/.test(key)) throw failure(`Configure POE_API_KEY on the server to use ${MODEL_LABEL}.`, 503, 'poe_configuration')
  if (config.SPUR_POE_FLASH_API_AVAILABLE === '0') throw failure(`${MODEL_LABEL} API access is unavailable with the current Poe configuration. Choose another model or check Poe model access.`, 503, 'poe_model_unavailable')
  if (clean(config.SPUR_VIDEO_ANALYSIS_POE_MODEL) && clean(config.SPUR_VIDEO_ANALYSIS_POE_MODEL) !== MODEL) throw failure(`Choose the supported ${MODEL} model for Poe analysis.`, 503, 'poe_configuration')
  const base = clean(config.POE_BASE_URL) || 'https://api.poe.com/v1'
  if (base.replace(/\/+$/, '') !== 'https://api.poe.com/v1') throw failure('Configure the official HTTPS Poe API endpoint.', 503, 'poe_configuration')
  return { key, model: MODEL, endpoint: 'https://api.poe.com/v1/chat/completions' }
}

export function poeConfigured(config = {}) { return config.SPUR_VIDEO_ANALYSIS_PROVIDER === 'poe' }
export function poeCapability(config = {}) {
  const metadata = { available: false, configured: Boolean(clean(config.POE_API_KEY)), provider: 'poe', model: MODEL, inputMode: 'video_and_audio', mediaTransport: 'original_video' }
  try { settings(config); return { ...metadata, available: true } } catch (cause) { return { ...metadata, reason: cause.message } }
}

async function filePart(file, filename, mime, maximum) {
  const info = await stat(file)
  if (!info.isFile() || !info.size || info.size > maximum) throw failure('The complete file exceeds the Poe analysis size limit. Choose a smaller video.', 413, 'poe_media_limit')
  const bytes = await readFile(file)
  if (!bytes.length || bytes.length > maximum) throw failure('The complete file exceeds the Poe analysis size limit.', 413, 'poe_media_limit')
  // Poe documents generic file inputs for MP4/MP3. Its input_audio format is
  // stripped by the compatibility layer, so never use that format here.
  return { type: 'file', file: { filename, file_data: `data:${mime};base64,${bytes.toString('base64')}` } }
}

async function responseJson(response) {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) throw failure('Poe analysis response exceeded its size limit.')
  if (!response.body?.getReader) throw failure('Poe returned an empty response.')
  const reader = response.body.getReader(), chunks = []
  let size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw failure('Poe analysis response exceeded its size limit.') }
      chunks.push(Buffer.from(part.value))
    }
  } finally { reader.releaseLock() }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw failure('Poe returned invalid response JSON.') }
}

async function request(body, config, signal) {
  cancelled(signal)
  const options = settings(config), serialized = JSON.stringify(body)
  if (Buffer.byteLength(serialized) > MAX_BODY_BYTES) throw failure('The prepared media exceeds the Poe request size limit.', 413, 'poe_media_limit')
  const controller = new AbortController(), abort = () => controller.abort()
  const timer = setTimeout(abort, TIMEOUT_MS)
  signal?.addEventListener('abort', abort, { once: true })
  try {
    const response = await fetch(options.endpoint, { method: 'POST', redirect: 'error', signal: controller.signal, headers: { authorization: `Bearer ${options.key}`, 'content-type': 'application/json' }, body: serialized })
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      if ([401, 403].includes(response.status)) throw failure(`Poe rejected the API key or access to ${MODEL_LABEL}.`, response.status, 'poe_authentication')
      if (response.status === 402) throw failure(`Poe requires an active subscription or additional points for ${MODEL_LABEL}.`, 402, 'poe_credits')
      if (response.status === 404) throw failure(`Poe cannot access ${MODEL} with this account. Choose another configured model or check Poe model access.`, 404, 'poe_model_unavailable')
      if (response.status === 429) throw failure('Poe rate limit reached. No paid request was retried.', 429, 'poe_rate_limit')
      throw failure(`Poe rejected the video analysis request (HTTP ${Number(response.status) || 502}). No paid request was retried.`, response.status >= 400 && response.status <= 599 ? response.status : 502)
    }
    const value = await responseJson(response)
    cancelled(signal)
    return value
  } catch (cause) {
    cancelled(signal)
    if (controller.signal.aborted) throw failure('Poe analysis timed out. No paid request was retried.', 504, 'poe_timeout')
    if (cause?.code?.startsWith('poe_')) throw cause
    throw failure('The Poe analysis request could not complete. No paid request was retried.')
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}

function usageOf(value) {
  const number = name => Number.isSafeInteger(value?.[name]) && value[name] >= 0 ? value[name] : 0
  return { promptTokens: number('prompt_tokens'), completionTokens: number('completion_tokens'), totalTokens: number('total_tokens') || number('prompt_tokens') + number('completion_tokens') }
}

/** Complete media input; no locally extracted visual frames and no silent model fallback. */
export async function analyzePoe({ filePath, mode = 'both', scriptTemplateId = 'none', config = {}, signal, onProgress, measurement, runProcess, ffmpegPath = 'ffmpeg', tempRoot = os.tmpdir() } = {}) {
  cancelled(signal)
  if (!poeConfigured(config)) throw failure('Explicitly select Poe for this analysis.', 503, 'poe_configuration')
  const { key, model } = settings(config)
  const duration = measurement?.analyzedDurationSeconds
  if (!['both', 'breakdown', 'script', 'audio'].includes(mode)) throw failure('Choose both, breakdown, script or audio analysis.', 400)
  if (!Number.isFinite(duration) || duration <= 0 || duration > 300 || measurement?.metadata?.durationSeconds > 300) throw failure('Choose a video of five minutes or less.', 422)
  const hasAudio = measurement.metadata?.hasAudio === true, audioOnly = mode === 'audio'
  const warnings = [`${MODEL_LABEL} estimates shot boundaries, motion and sound labels from the complete media. Verify important details against the original video. Poe controls internal video sampling; decoded frame timestamps are not provided.`]
  const root = path.resolve(tempRoot)
  let directory, response, observation
  try {
    const parts = []
    if (!audioOnly) {
      const extension = path.extname(filePath).toLowerCase()
      const mime = ({ '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.m4v': 'video/mp4', '.avi': 'video/x-msvideo' })[extension] || 'video/mp4'
      parts.push(await filePart(filePath, `reference${extension || '.mp4'}`, mime, MAX_VIDEO_BYTES))
    } else if (hasAudio) {
      if (typeof runProcess !== 'function') throw failure('Audio analysis requires the configured media tools.', 503, 'poe_media_preparation')
      await mkdir(root, { recursive: true }); directory = await mkdtemp(path.join(root, 'spur-poe-'))
      const audio = path.join(directory, 'reference-audio.mp3')
      await runProcess(ffmpegPath, ['-hide_banner', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe', '-i', filePath, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '24000', '-c:a', 'libmp3lame', '-b:a', '96k', '-map_metadata', '-1', audio], { signal, timeoutMs: 60000, maxBytes: 1024 ** 2 })
      cancelled(signal)
      parts.push(await filePart(audio, 'reference-audio.mp3', 'audio/mpeg', MAX_AUDIO_BYTES))
    }
    if (parts.length) {
      const prompt = analysisPrompt({ mode, duration, hasAudio, scriptTemplateId }).replace('The audio track is supplied separately alongside this clip.', audioOnly ? 'The complete audio track is supplied as an audio file.' : 'The original video file includes its synchronized audio track; listen to that embedded audio.')
      parts.push({ type: 'text', text: prompt })
      onProgress?.({ stage: 'analyzing_cloud', percent: 30, message: audioOnly ? `${MODEL_LABEL} on Poe is listening to the complete audio track` : `${MODEL_LABEL} on Poe is analyzing the complete video and its audio` })
      response = await request({ model, messages: [{ role: 'user', content: parts }], stream: false, max_tokens: 16384 }, config, signal)
      const message = response.choices?.[0]?.message?.content
      const text = typeof message === 'string' ? message : Array.isArray(message) ? message.filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('') : ''
      observation = normalizeAnalysis(text, { duration, offset: 0, mode, hasAudio, scriptTemplateId, providerLabel: `Poe ${MODEL_LABEL}`, errorFactory: failure })
    } else observation = { summary: 'This file has no audio track.', language: null, shots: [], transcript: [], onScreenText: [], semanticDescription: '', semanticSegments: [], semanticEvents: [], discarded: 0, reviewReasons: [] }
  } catch (cause) {
    cancelled(signal)
    if (cause?.code?.startsWith('poe_')) throw cause
    throw failure('The complete media could not be prepared for Poe analysis.', 422, 'poe_media_preparation')
  } finally {
    if (directory) {
      const relative = path.relative(root, path.resolve(directory))
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) await rm(directory, { recursive: true, force: true }).catch(() => warnings.push('Temporary audio could not be removed; server cleanup is required.'))
    }
  }
  const truncated = response?.choices?.[0]?.finish_reason === 'length'
  const status = observation.discarded || truncated ? 'partial' : 'complete'
  if (status === 'partial') warnings.push(`Video analysis needs review: ${[...observation.reviewReasons, ...(truncated ? ['Poe truncated its output'] : [])].join('; ')}.`)
  if (hasAudio && mode !== 'breakdown') warnings.push('Speech is machine transcribed. Check words and timing against the original audio.')
  const observedStatus = status === 'complete' ? 'analyzed' : 'partial'
  const speechStatus = !hasAudio ? 'no_audio' : mode === 'breakdown' ? 'not_requested' : observedStatus
  const semanticStatus = !hasAudio ? 'no_audio' : observedStatus
  const script = { segments: observation.transcript, text: observation.transcript.map(value => value.text).join('\n'), onScreenText: observation.onScreenText }
  const shots = observation.shots.map((shot, index) => ({ ...shot, index, onScreenText: [...new Set(observation.onScreenText.filter(value => value.startSeconds < shot.endSeconds && value.endSeconds > shot.startSeconds).map(value => value.text))] }))
  const audio = buildAudioTimeline({ durationSeconds: duration, shots, script, measurementAudio: measurement.audio, hasAudio, speechStatus, semanticStatus, semanticEvents: observation.semanticEvents, semanticSegments: observation.semanticSegments, semanticDescription: observation.semanticDescription })
  Object.assign(audio, { measurementDescription: audio.measurementDescription || audio.description, semanticDescription: observation.semanticDescription, semanticSegments: observation.semanticSegments, semanticEvents: observation.semanticEvents, semanticModel: model, semanticMethod: 'multimodal_audio_understanding' })
  const identity = { provider: 'poe', model }
  const usage = usageOf(response?.usage)
  const provenance = {
    multimodal: { ...identity, inputMode: audioOnly ? 'audio' : hasAudio ? 'video_and_audio' : 'video', mediaTransport: audioOnly ? 'audio_track' : 'original_video', status: audioOnly && !hasAudio ? 'no_audio' : observedStatus, chunkCount: response ? 1 : 0, successfulChunks: response ? 1 : 0, sampling: { provider: 'poe', controlledBy: 'provider', frameTimestampsAvailable: false }, usage, usageByModel: response ? { [model]: usage } : {}, coverage: response ? [{ startSeconds: 0, endSeconds: round(duration), status: observedStatus }] : [] },
    boundaries: { ...identity, method: 'multimodal_estimated_shot_boundaries', status: ['audio', 'script'].includes(mode) ? 'not_requested' : observedStatus },
    vision: { ...identity, method: 'multimodal_video_understanding', status: ['audio', 'script'].includes(mode) ? 'not_requested' : observedStatus },
    ocr: { ...identity, method: 'multimodal_video_ocr', status: audioOnly ? 'not_requested' : observedStatus },
    speech: { ...identity, method: 'multimodal_audio_transcription', status: speechStatus },
    soundEvents: { ...identity, method: 'multimodal_audio_understanding', status: semanticStatus },
    audio: { method: 'ffmpeg_rms_energy_onsets', status: measurement.audio?.status || 'unavailable' },
    analyzedDurationSeconds: duration, originalDurationSeconds: measurement.metadata?.durationSeconds,
  }
  const sensitive = [key, clean(config.SILICONFLOW_API_KEY), filePath, directory].filter(value => value?.length > 2)
  const redact = value => typeof value === 'string' ? sensitive.reduce((text, token) => text.split(token).join('[redacted]'), value) : Array.isArray(value) ? value.map(redact) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, redact(entry)])) : value
  const result = redact({ schemaVersion: 1, status, mode, summary: observation.summary, language: observation.language, shots: annotateAudioShots(shots, audio), script, ...(observation.scriptStructure ? { scriptStructure: observation.scriptStructure } : {}), audio, metadata: measurement.metadata, warnings, provenance })
  onProgress?.({ stage: 'complete', percent: 100, message: status === 'complete' ? `${MODEL_LABEL} shot and audio analysis are ready` : `${MODEL_LABEL} analysis is ready; some observations need review` })
  return result
}
