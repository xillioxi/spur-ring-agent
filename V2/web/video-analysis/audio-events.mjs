import { spawn } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateLocalMediaPath } from '../reels/media.mjs'

const helper = fileURLToPath(new URL('./audio-events.py', import.meta.url))
const MODEL = 'Google YAMNet / AudioSet 521 classes'
const METHOD = 'yamnet_waveform_classification'
const LIMITATIONS = [
  'Sound labels are predictions from the actual mixed soundtrack, not separated audio stems or confirmed sound identities.',
  'Scores are model confidence scores, not calibrated probabilities. Quiet, overlapping or unfamiliar sounds may be missed or mislabeled.',
  'Sound-event intervals come from overlapping 0.975 second windows every 0.48 seconds; their boundaries are approximate.',
]
const checks = new Map()
const round = value => Math.round(value * 1000) / 1000
const cancelled = signal => { if (signal?.aborted) throw new Error('Video analysis cancelled') }

async function localFile(filename, maxBytes) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) return false
  try { const info = await stat(filename); return info.isFile() && info.size > 0 && info.size <= maxBytes } catch { return false }
}

function run(command, args, { signal, timeoutMs = 180000, maxBytes = 2 * 1024 ** 2 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Video analysis cancelled'))
    let child, settled = false, failure, size = 0
    const chunks = []
    try {
      child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, TF_CPP_MIN_LOG_LEVEL: '3', TF_ENABLE_ONEDNN_OPTS: '0' } })
    } catch { return reject(new Error('Local audio analysis could not start')) }
    const stop = message => { failure ||= new Error(message); child.kill() }
    const timeout = setTimeout(() => stop('Local audio analysis timed out'), timeoutMs)
    const abort = () => stop('Video analysis cancelled')
    signal?.addEventListener('abort', abort, { once: true })
    const finish = (error, output) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
      error ? reject(error) : resolve(output)
    }
    child.stdout.on('data', chunk => {
      size += chunk.length
      if (size > maxBytes) stop('Local audio analysis exceeded its output limit')
      else chunks.push(chunk)
    })
    child.stderr.on('data', chunk => {
      size += chunk.length
      if (size > maxBytes) stop('Local audio analysis exceeded its output limit')
    })
    child.on('error', () => finish(new Error('Local audio analysis could not start')))
    child.on('close', code => finish(failure || (code !== 0 ? new Error('Local audio analysis could not process this file') : null), Buffer.concat(chunks).toString('utf8')))
  })
}

/** Host-only configuration; HTTP clients cannot supply executables or model paths. */
export async function discoverAudioEventCapabilities(config = {}, { signal } = {}) {
  cancelled(signal)
  const values = [config.SPUR_AUDIO_PYTHON, config.SPUR_AUDIO_MODEL, config.SPUR_AUDIO_LABELS]
  const files = await Promise.all(values.map((value, index) => localFile(value, index === 1 ? 8 * 1024 ** 2 : index === 2 ? 100 * 1024 : 256 * 1024 ** 2)))
  const base = { available: false, method: METHOD, model: MODEL, local: true, windowSeconds: 0.975, hopSeconds: 0.48, maxDurationSeconds: 300 }
  if (!files.every(Boolean)) return { ...base, reason: 'The local sound-event model or Python runtime is not configured.' }
  const key = values.join('\0')
  let entry = checks.get(key)
  if (!entry || entry.until < Date.now()) {
    // Probe module availability, without importing TensorFlow on every status request.
    const promise = run(values[0], [helper, '--check'], { signal, timeoutMs: 8000, maxBytes: 128 * 1024 })
      .then(output => JSON.parse(output).available === true).catch(() => false)
    entry = { until: Date.now() + 60000, promise }
    checks.set(key, entry)
    if (checks.size > 8) checks.delete(checks.keys().next().value)
  }
  const available = await entry.promise
  cancelled(signal)
  return { ...base, available, ...(available ? {} : { reason: 'The configured Python runtime does not have a working local audio classifier.' }) }
}

/** Strictly validate waveform model output, then merge only overlapping predictions of the same label. */
export function parseAudioEvents(document) {
  if (!document || typeof document !== 'object' || !Number.isFinite(document.durationSeconds) || document.durationSeconds <= 0 || document.durationSeconds > 300 ||
      document.windowSeconds !== 0.975 || document.hopSeconds !== 0.48 || !Number.isInteger(document.windowCount) || document.windowCount < 1 || document.windowCount > 625 ||
      document.windowCount !== Math.ceil(document.durationSeconds / 0.48) || document.threshold !== 0.25 ||
      !Array.isArray(document.events) || document.events.length > document.windowCount * 3) throw new Error('The audio classifier returned invalid timing data')
  const events = document.events.map(event => {
    if (!event || typeof event.label !== 'string' || !event.label.trim() || event.label.length > 160 || /[\u0000-\u001f]/.test(event.label) ||
        !Number.isFinite(event.startSeconds) || !Number.isFinite(event.endSeconds) || event.startSeconds < 0 || event.endSeconds <= event.startSeconds ||
        event.endSeconds > document.durationSeconds + 0.001 || event.endSeconds - event.startSeconds > 0.976 ||
        !Number.isFinite(event.confidence) || event.confidence < 0.25 || event.confidence > 1) throw new Error('The audio classifier returned invalid sound events')
    return { startSeconds: event.startSeconds, endSeconds: Math.min(document.durationSeconds, event.endSeconds), label: event.label.trim(), confidence: event.confidence }
  }).sort((a, b) => a.startSeconds - b.startSeconds || a.label.localeCompare(b.label))
  const merged = [], latest = new Map()
  for (const event of events) {
    const prior = latest.get(event.label)
    if (prior && event.startSeconds <= prior.endSeconds + 0.001) {
      prior.endSeconds = Math.max(prior.endSeconds, event.endSeconds)
      prior.confidence = Math.max(prior.confidence, event.confidence)
    } else {
      const copy = { ...event }
      merged.push(copy)
      latest.set(event.label, copy)
    }
  }
  return { durationSeconds: round(document.durationSeconds), windowSeconds: 0.975, hopSeconds: 0.48, windowCount: document.windowCount,
    threshold: 0.25, confidenceAggregation: 'maximum_over_overlapping_windows', events: merged.map(event => ({ ...event, startSeconds: round(event.startSeconds), endSeconds: round(event.endSeconds) })) }
}

/** Analyze actual local waveform samples. No video frames, generated text, network or remote inference are used. */
export async function analyzeAudioEvents({ filePath, allowedRoots, config = {}, signal, onProgress } = {}) {
  cancelled(signal)
  const capability = await discoverAudioEventCapabilities(config, { signal })
  const base = { method: METHOD, model: MODEL, events: [], limitations: [...LIMITATIONS] }
  if (!capability.available) return { ...base, status: 'unavailable', limitations: [capability.reason, ...LIMITATIONS] }
  const safePath = await validateLocalMediaPath(filePath, allowedRoots)
  let directory
  try {
    directory = await mkdtemp(path.join(os.tmpdir(), 'spur-audio-events-'))
    const audio = path.join(directory, 'soundtrack.wav')
    onProgress?.({ stage: 'analyzing_audio', message: 'Listening for music, speech and sound events' })
    await run(config.SPUR_FFMPEG_BIN || config.SPUR_FFMPEG_PATH || config.FFMPEG_PATH || 'ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe', '-i', safePath,
      '-t', '300.001', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', audio,
    ], { signal, timeoutMs: 60000, maxBytes: 128 * 1024 })
    const output = await run(config.SPUR_AUDIO_PYTHON, [helper, '--model', config.SPUR_AUDIO_MODEL, '--labels', config.SPUR_AUDIO_LABELS, '--audio', audio], { signal })
    return { ...base, status: 'analyzed', ...parseAudioEvents(JSON.parse(output)) }
  } catch {
    cancelled(signal)
    return { ...base, status: 'failed', limitations: ['Sound classification could not finish for this file. No replacement sound labels were invented.', ...LIMITATIONS] }
  } finally {
    // Only this generated temporary directory is removed; callers never supply its path.
    if (directory) await rm(directory, { recursive: true, force: true })
  }
}
