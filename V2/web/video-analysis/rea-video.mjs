import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildAudioTimeline, annotateAudioShots } from './audio-timeline.mjs'

export const REA_VIDEO_UPSTREAM_REVISION = 'e83d5874beb6429d9488129c7f046755b60a5371'
export const REA_VIDEO_REVISION = `${REA_VIDEO_UPSTREAM_REVISION}:2`
const RUNNER = fileURLToPath(new URL('./rea-video-runner.py', import.meta.url))
const REPOSITORY = 'https://github.com/JuneYaooo/rea-video'
const LABELS = new Set(['live_action', 'ai_video', 'avatar', 'cg_3d', 'code_render', 'screen_capture', 'still_motion', 'static_hold', 'anim_2d', 'stop_motion', 'film_footage', 'unknown'])
const MAX_OUTPUT = 2 * 1024 ** 2
const MAX_STDERR = 256 * 1024
const clean = (value, max = 2000) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max) : ''
const finite = value => typeof value === 'number' && Number.isFinite(value)
const failure = (message, code = 'rea_video_failed', status = 422) => Object.assign(new Error(message), { code, status })
const SECTIONS = new Set(['look', 'sound', 'packaging', 'remake', 'materials', 'editing', 'provenance'])
const ASSET_IDS = /^(?:storyboard|audio-chart|shot-\d{3})$/
const MAX_ASSET_BYTES = 256 * 1024
const MAX_ASSETS_BYTES = 1024 ** 2
const CAPABILITIES = [
  { id: 'look', label: 'Camera, lighting and colour', status: 'available', detail: 'Local pixel and motion estimates, with the native technical report. These are unreviewed heuristics.' },
  { id: 'editing', label: 'Editing and shot timing', status: 'available', detail: 'Detected shot boundaries, pacing, transition candidates and contact sheets. Action changes inside a take still need review.' },
  { id: 'sound', label: 'Sound and rhythm', status: 'available', detail: 'Audio energy, estimated rhythm and low-confidence sound candidates. No speech or sound meaning is verified.' },
  { id: 'packaging', label: 'Packaging candidates', status: 'available', detail: 'Local graphic and overlay candidates. OCR is disabled, so empty caption results do not establish that no text appears.' },
  { id: 'materials', label: 'Materials and filming suggestions', status: 'available', detail: 'Native source-material and remake suggestions, requiring visual confirmation before use.' },
  { id: 'reports', label: 'Reports and reference images', status: 'available', detail: 'Bounded native report sections, storyboard, audio chart and up to six shot contact sheets.' },
  { id: 'ocr', label: 'Read captions and visible text', status: 'requires_download', detail: 'The upstream OCR workflow needs optional OCR dependencies and model files. It is disabled in this local adapter.' },
  { id: 'asr', label: 'Speech and speakers', status: 'requires_download', detail: 'The upstream speech workflow needs optional recognition and speaker models. It is disabled in this local adapter.' },
  { id: 'stems', label: 'Separate voice, music and effects', status: 'requires_download', detail: 'The upstream stems workflow needs optional audio-separation dependencies and model weights. No stems are generated here.' },
  { id: 'vision', label: 'Story, actions and visual review', status: 'requires_model', detail: 'The upstream vision workflow needs a configured vision model and a reviewed video analysis. This run makes no model requests.' },
  { id: 'review', label: 'Review, corrections and memory', status: 'separate_workflow', detail: 'Upstream supports review answers and saved corrections. This adapter keeps them isolated and does not silently apply prior answers.' },
  { id: 'remake', label: 'Remake, compare and editable projects', status: 'separate_workflow', detail: 'Upstream includes frame/layer extraction, reference comparison, motion references, remake planning and editable code projects. Executing a remake or generation is a separate workflow.' },
]

function validImage(bytes, contentType) {
  if (contentType === 'image/jpeg') {
    if (bytes.length < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) return false
    for (let offset = 2; offset + 4 <= bytes.length;) {
      if (bytes[offset++] !== 0xff) return false
      while (bytes[offset] === 0xff) offset++
      const marker = bytes[offset++]
      if (marker === 0xda || marker === 0xd9 || offset + 2 > bytes.length) return false
      const size = bytes.readUInt16BE(offset)
      if (size < 2 || offset + size > bytes.length) return false
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (size < 8) return false
        const height = bytes.readUInt16BE(offset + 3), width = bytes.readUInt16BE(offset + 5)
        return width > 0 && height > 0 && width <= 2048 && height <= 2048
      }
      offset += size
    }
    return false
  }
  if (contentType !== 'image/png' || bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.toString('ascii', 12, 16) !== 'IHDR' || bytes.toString('ascii', bytes.length - 8, bytes.length - 4) !== 'IEND') return false
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20)
  return width > 0 && height > 0 && width <= 2048 && height <= 2048
}

export function reaVideoCapability(config = {}) {
  const python = clean(config.SPUR_REA_VIDEO_PYTHON, 4000), source = clean(config.SPUR_REA_VIDEO_SOURCE, 4000)
  const configured = Boolean(python && source)
  const available = configured && path.isAbsolute(python) && path.isAbsolute(source) && existsSync(python) && existsSync(path.join(source, 'rea_video', 'pipeline.py')) && existsSync(RUNNER)
  return { available, configured, provider: 'rea-video', model: null, inputMode: 'local_media', revision: REA_VIDEO_REVISION, ...(!available ? { reason: 'Configure the isolated rea-video Python executable and source folder on this server.' } : {}) }
}

export function normalizeReaOutput(raw, { duration, redact = [] } = {}) {
  if (!raw || raw.schemaVersion !== 1 || !Array.isArray(raw.technicalShots) || !raw.technicalShots.length || raw.technicalShots.length > 2000 || !finite(duration) || duration <= 0 || duration > 300 || raw.vlmStatus !== 'not_requested' || raw.reviewStatus !== 'unreviewed') throw failure('rea-video returned an invalid or unsupported local report.')
  const text = (value, limit) => {
    let result = typeof value === 'string' ? value : ''
    for (const token of redact.filter(value => typeof value === 'string' && value)) {
      for (const variant of new Set([token, token.replaceAll('\\', '/')])) result = result.split(variant).join('[local path]')
    }
    // Native prose can contain absolute paths other than the input/source folders.
    result = result.replace(/\b[a-zA-Z]:[\\/][^\r\n<>"|]*/g, '[local path]')
      .replace(/(^|[\s("'`])\/(?!\/)[^\s)"'`<>]+/g, '$1[local path]')
    return clean(result, limit)
  }
  const technicalShots = []
  for (const shot of raw.technicalShots) {
    if (!shot || typeof shot !== 'object' || !finite(shot.startSeconds) || !finite(shot.endSeconds) || shot.startSeconds < 0 || shot.endSeconds <= shot.startSeconds || shot.endSeconds > duration + 0.02 || !LABELS.has(shot.label) || shot.confidence !== null && (!finite(shot.confidence) || shot.confidence < 0 || shot.confidence > 1) || !Array.isArray(shot.evidence)) throw failure('rea-video returned invalid shot evidence.')
    const startSeconds = Math.round(shot.startSeconds * 1000) / 1000, endSeconds = Math.min(Math.round(shot.endSeconds * 1000) / 1000, duration)
    if (startSeconds < (technicalShots.at(-1)?.endSeconds ?? 0) - 0.02 || endSeconds <= startSeconds) throw failure('rea-video returned overlapping or invalid shot intervals.')
    technicalShots.push({ index: technicalShots.length, startSeconds, endSeconds, label: shot.label, confidence: shot.confidence, evidence: shot.evidence.slice(0, 12).map(value => text(value, 500)).filter(Boolean) })
  }
  const verdict = text(raw.verdict, 6000)
  if (!verdict) throw failure('rea-video did not return its technical verdict.')
  const sections = [], seenSections = new Set()
  if (raw.sections !== undefined && (!Array.isArray(raw.sections) || raw.sections.length > 7)) throw failure('rea-video returned invalid report sections.')
  for (const section of raw.sections || []) {
    if (!section || !SECTIONS.has(section.id) || seenSections.has(section.id) || typeof section.title !== 'string' || typeof section.body !== 'string') throw failure('rea-video returned invalid report sections.')
    seenSections.add(section.id)
    const title = text(section.title, 120)
    const withoutFrontmatter = section.body.replace(/^\uFEFF?---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, '')
    let body = text(withoutFrontmatter, 16000)
    if (Buffer.byteLength(body, 'utf8') > 16000) body = Buffer.from(body).subarray(0, 16000).toString('utf8').replace(/\uFFFD$/, '')
    if (!title || !body) throw failure('rea-video returned empty report sections.')
    sections.push({ id: section.id, title, body })
  }
  const soundCandidates = []
  if (raw.soundCandidates !== undefined && (!Array.isArray(raw.soundCandidates) || raw.soundCandidates.length > 60)) throw failure('rea-video returned invalid sound candidates.')
  for (const event of raw.soundCandidates || []) {
    if (!event || !finite(event.startSeconds) || !finite(event.endSeconds) || event.startSeconds < 0 || event.endSeconds <= event.startSeconds || event.endSeconds > duration + .02 || typeof event.description !== 'string') throw failure('rea-video returned invalid sound candidates.')
    const startSeconds = Math.round(event.startSeconds * 1000) / 1000, endSeconds = Math.min(Math.round(event.endSeconds * 1000) / 1000, duration)
    const description = text(event.description, 500)
    if (!description || endSeconds <= startSeconds) throw failure('rea-video returned invalid sound candidates.')
    soundCandidates.push({ startSeconds, endSeconds, description })
  }
  const assets = [], seenAssets = new Set()
  let assetBytes = 0
  if (raw.assets !== undefined && (!Array.isArray(raw.assets) || raw.assets.length > 8)) throw failure('rea-video returned invalid reference images.')
  for (const asset of raw.assets || []) {
    if (!asset || typeof asset.id !== 'string' || !ASSET_IDS.test(asset.id) || seenAssets.has(asset.id) || typeof asset.label !== 'string' || !['image/jpeg', 'image/png'].includes(asset.contentType) || typeof asset.dataBase64 !== 'string' || asset.dataBase64.length > Math.ceil(MAX_ASSET_BYTES / 3) * 4 || asset.dataBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(asset.dataBase64)) throw failure('rea-video returned invalid reference images.')
    const bytes = Buffer.from(asset.dataBase64, 'base64')
    assetBytes += bytes.length
    const label = text(asset.label, 120)
    if (!label || bytes.length > MAX_ASSET_BYTES || assetBytes > MAX_ASSETS_BYTES || bytes.toString('base64') !== asset.dataBase64 || !validImage(bytes, asset.contentType)) throw failure('rea-video returned invalid reference images.')
    seenAssets.add(asset.id)
    assets.push({ id: asset.id, label, contentType: asset.contentType, dataBase64: asset.dataBase64 })
  }
  return { schemaVersion: 1, toolVersion: text(raw.toolVersion, 80), verdict, technicalShots, sections, soundCandidates, assets, capabilities: CAPABILITIES.map(value => ({ ...value })), vlmStatus: 'not_requested', reviewStatus: 'unreviewed', workflowRevision: REA_VIDEO_REVISION, limitations: [
    'Local technical analysis only. The story, object actions and payoff have not been interpreted or visually reviewed.',
    'Source classifications and confidence scores are heuristic estimates; platform compression can make live footage look generated.',
    'OCR, speech recognition and audio separation are disabled. Transcript and visible-text fields remain empty.',
    'Detected shot boundaries do not describe all action changes within continuous takes.',
  ] }
}

function processEnv(config, directory, ffmpegPath, ffprobePath) {
  // Credentials and unrelated model/provider settings never enter the subprocess.
  const env = Object.fromEntries(['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'SYSTEMDRIVE', 'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH'].filter(key => process.env[key]).map(key => [key, process.env[key]]))
  const executable = clean(config.SPUR_REA_VIDEO_PYTHON)
  env.PATH = [...new Set([path.dirname(executable), path.dirname(ffmpegPath), path.dirname(ffprobePath)])].join(path.delimiter)
  Object.assign(env, { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONNOUSERSITE: '1', REA_VIDEO_HOME: path.join(directory, 'home'), REA_VIDEO_MODELS: path.join(directory, 'models'), TEMP: directory, TMP: directory, TMPDIR: directory, HOME: directory, USERPROFILE: directory })
  return env
}

export function runReaProcess(command, args, { env, cwd, signal, spawnProcess = spawn, timeoutMs = 18 * 60000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(failure('Video analysis cancelled.', 'analysis_cancelled', 499))
    let child
    try { child = spawnProcess(command, args, { env, cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] }) } catch { return reject(failure('The isolated rea-video runtime could not be started.', 'rea_video_runtime', 503)) }
    const chunks = [], errors = []
    let bytes = 0, errorBytes = 0, stopped, settled = false, terminationTimer
    const stop = cause => {
      if (stopped) return
      stopped = cause
      const force = () => { try { child.kill('SIGKILL') } catch {} }
      // Terminate media grandchildren too; never leave an unbounded wait for a close event.
      if (spawnProcess === spawn && Number.isInteger(child.pid) && process.platform === 'win32') {
        const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' })
        killer.once('error', force)
      } else if (spawnProcess === spawn && Number.isInteger(child.pid) && process.platform !== 'win32') {
        try { process.kill(-child.pid, 'SIGTERM') } catch { force() }
      } else { try { child.kill() } catch {} }
      if (!settled) terminationTimer = setTimeout(() => { force(); finish(stopped) }, 2000)
    }
    const timer = setTimeout(() => stop(failure('Local rea-video analysis timed out.', 'rea_video_timeout', 504)), timeoutMs)
    const abort = () => stop(failure('Video analysis cancelled.', 'analysis_cancelled', 499))
    signal?.addEventListener('abort', abort, { once: true })
    const finish = (cause, value) => {
      if (settled) return
      settled = true; clearTimeout(timer); clearTimeout(terminationTimer); signal?.removeEventListener('abort', abort)
      cause ? reject(cause) : resolve(value)
    }
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > MAX_OUTPUT) stop(failure('rea-video output exceeded its size limit.', 'rea_video_output_limit')); else chunks.push(chunk) })
    child.stderr.on('data', chunk => { errorBytes += chunk.length; if (errorBytes > MAX_STDERR) stop(failure('rea-video diagnostics exceeded their size limit.', 'rea_video_output_limit')); else errors.push(chunk) })
    child.on('error', () => finish(failure('The isolated rea-video runtime could not be started.', 'rea_video_runtime', 503)))
    child.on('close', code => {
      if (stopped) return finish(stopped)
      if (code !== 0) return finish(failure('Local rea-video analysis could not finish. Check its isolated runtime and media tools.', 'rea_video_runtime', 503))
      try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { finish(failure('rea-video returned malformed report data.')) }
    })
  })
}

export async function analyzeReaVideo({ filePath, mode = 'both', config = {}, signal, onProgress, measurement, ffmpegPath, ffprobePath, tempRoot = os.tmpdir() } = {}) {
  if (!['both', 'breakdown'].includes(mode)) throw failure('rea-video supports video breakdown modes only.', 'invalid_rea_video_mode')
  const capability = reaVideoCapability(config)
  if (!capability.available) throw failure(capability.reason, 'rea_video_configuration', 503)
  const duration = measurement?.analyzedDurationSeconds
  if (!finite(duration) || duration <= 0 || duration > 300 || !measurement.metadata?.hasVideo) throw failure('Choose a video of five minutes or less.')
  if (!path.isAbsolute(filePath) || !(await stat(filePath)).isFile() || (await stat(filePath)).size > 80 * 1024 ** 2) throw failure('Choose a local video within the rea-video size limit.')
  if (!ffmpegPath || !ffprobePath || !path.isAbsolute(ffmpegPath) || !path.isAbsolute(ffprobePath)) throw failure('Configure absolute local FFmpeg and FFprobe paths for rea-video.', 'rea_video_configuration', 503)
  await mkdir(tempRoot, { recursive: true })
  const directory = await mkdtemp(path.join(path.resolve(tempRoot), 'spur-rea-video-'))
  const python = clean(config.SPUR_REA_VIDEO_PYTHON), source = clean(config.SPUR_REA_VIDEO_SOURCE)
  onProgress?.({ stage: 'analyzing_local', percent: 25, message: 'rea-video is measuring local shots, motion and production evidence' })
  const heartbeat = onProgress ? setInterval(() => onProgress({ stage: 'analyzing_local', percent: 55, message: 'rea-video local technical breakdown is running; no media is uploaded' }), 10000) : null
  let reaVideo
  try {
    const raw = await runReaProcess(python, [RUNNER, '--source', source, '--video', filePath, '--out', path.join(directory, 'report'), '--ffmpeg', ffmpegPath, '--ffprobe', ffprobePath], { env: processEnv(config, directory, ffmpegPath, ffprobePath), cwd: directory, signal })
    reaVideo = normalizeReaOutput(raw, { duration, redact: [filePath, directory, source, python] })
  } finally {
    clearInterval(heartbeat)
    const relative = path.relative(path.resolve(tempRoot), path.resolve(directory))
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) await rm(directory, { recursive: true, force: true })
  }
  const shots = reaVideo.technicalShots.map(shot => ({ index: shot.index, startSeconds: shot.startSeconds, endSeconds: shot.endSeconds, visual: `Technical shot ${shot.index + 1}: estimated ${shot.label.replaceAll('_', ' ')}. Visual content is unreviewed.`, action: null, location: null, framing: null, cameraMovement: null, effects: null, notes: [...shot.evidence, 'Local technical estimate; object actions and meaning are unreviewed.'].join(' '), onScreenText: [], sampledFrames: [], spokenText: '', audio: null, reconstructionPrompt: null }))
  const script = { segments: [], words: [], text: '', onScreenText: [] }
  const audio = buildAudioTimeline({ durationSeconds: duration, shots, script, measurementAudio: measurement.audio, hasAudio: measurement.metadata.hasAudio, speechStatus: 'not_requested', semanticStatus: 'unavailable' })
  const local = { provider: 'rea-video', model: null }
  return { schemaVersion: 1, status: 'partial', mode, summary: `Unreviewed rea-video technical estimate: ${reaVideo.verdict}`, language: null, shots: annotateAudioShots(shots, audio), script, audio, metadata: measurement.metadata, inversePrompt: null, reaVideo, warnings: [...reaVideo.limitations], provenance: {
    workflow: { id: 'rea-video', label: 'rea-video · local technical breakdown', revision: REA_VIDEO_REVISION, upstreamRevision: REA_VIDEO_UPSTREAM_REVISION, repository: REPOSITORY, method: 'native_pipeline_local_only', status: 'unreviewed' },
    boundaries: { ...local, method: 'rea_video_shot_detection', status: 'analyzed' },
    vision: { ...local, method: 'pixel_statistics_and_motion', status: 'partial' },
    ocr: { ...local, status: 'not_requested' }, speech: { ...local, status: measurement.metadata.hasAudio ? 'not_requested' : 'no_audio' }, soundEvents: { ...local, status: measurement.metadata.hasAudio ? 'unavailable' : 'no_audio' },
    audio: { method: 'ffmpeg_rms_energy_onsets', status: measurement.audio?.status || 'unavailable' }, analyzedDurationSeconds: duration, originalDurationSeconds: measurement.metadata.durationSeconds,
  } }
}
