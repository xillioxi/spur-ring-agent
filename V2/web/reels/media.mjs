import { spawn } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'

const MEDIA_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg'])
const round = value => Math.round(value * 1000) / 1000
const positive = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null

/** allowedRoots must come from server configuration, never from an HTTP request. */
export async function validateLocalMediaPath(filePath, allowedRoots) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || !Array.isArray(allowedRoots) || !allowedRoots.length) {
    throw new Error('An absolute local media path and server-approved roots are required')
  }
  const resolved = await realpath(filePath)
  const roots = await Promise.all(allowedRoots.map(root => {
    if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('Media roots must be absolute paths')
    return realpath(root)
  }))
  if (!roots.some(root => {
    const relative = path.relative(root, resolved)
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  })) throw new Error('Media file is outside the approved library')
  if (!MEDIA_EXTENSIONS.has(path.extname(resolved).toLowerCase())) throw new Error('Unsupported media file type')
  const info = await stat(resolved)
  if (!info.isFile()) throw new Error('Media path must be a regular file')
  if (info.size > 2 * 1024 ** 3) throw new Error('Media files larger than 2 GiB are not supported by the reel analyzer')
  return resolved
}

function executable(value, fallback) {
  if (value == null) return fallback
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error('Invalid media executable')
  return value
}

function runTool(command, args, { signal, timeoutMs = 30000, maxBytes = 8 * 1024 ** 2 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Media analysis cancelled'))
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = [], stderr = []
    let outputBytes = 0, failure
    const stop = message => { failure = new Error(message); child.kill() }
    const timer = setTimeout(() => stop('Media tool timed out'), timeoutMs)
    const cancel = () => stop('Media analysis cancelled')
    signal?.addEventListener('abort', cancel, { once: true })
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) {
      stream.on('data', chunk => {
        outputBytes += chunk.length
        if (outputBytes > maxBytes) stop('Media tool output limit exceeded')
        else chunks.push(chunk)
      })
    }
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel) }
    child.on('error', error => { cleanup(); reject(error) })
    child.on('close', code => {
      cleanup()
      if (failure) return reject(failure)
      if (code !== 0) return reject(new Error('Media tool could not process this file'))
      resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString('utf8') })
    })
  })
}

export async function getMediaCapabilities(options = {}) {
  const commands = { ffmpeg: executable(options.ffmpegPath, 'ffmpeg'), ffprobe: executable(options.ffprobePath, 'ffprobe') }
  const entries = await Promise.all(Object.entries(commands).map(async ([name, command]) => {
    try {
      const result = await runTool(command, ['-version'], { signal: options.signal, timeoutMs: 5000, maxBytes: 128 * 1024 })
      return [name, { available: true, command, version: result.stdout.toString('utf8').split(/\r?\n/)[0] }]
    } catch {
      return [name, { available: false, command }]
    }
  }))
  const tools = Object.fromEntries(entries)
  return { ...tools, metadataAvailable: tools.ffprobe.available, sceneAnalysisAvailable: tools.ffprobe.available && tools.ffmpeg.available, audioAnalysisAvailable: tools.ffprobe.available && tools.ffmpeg.available }
}

export function parseProbeMetadata(probe) {
  const video = probe.streams?.find(stream => stream.codec_type === 'video')
  const audio = probe.streams?.find(stream => stream.codec_type === 'audio')
  const [numerator, denominator = '1'] = String(video?.avg_frame_rate || '').split('/')
  const fps = positive(Number(numerator) / Number(denominator))
  return {
    durationSeconds: positive(probe.format?.duration) ?? positive(video?.duration) ?? positive(audio?.duration),
    width: positive(video?.width), height: positive(video?.height), fps: fps == null ? null : round(fps),
    hasVideo: Boolean(video), hasAudio: Boolean(audio),
  }
}

export function parseSceneBoundaries(log, durationSeconds, { minSceneSeconds = 0.3 } = {}) {
  const found = []
  let timestamp = null
  for (const line of log.split(/\r?\n/)) {
    const time = /\bpts_time:([\d.e+-]+)/.exec(line)
    if (time) timestamp = Number(time[1])
    const score = /lavfi\.scene_score=([\d.e+-]+)/.exec(line)
    if (score && timestamp != null && timestamp > 0 && timestamp < durationSeconds) {
      const previous = found.at(-1)?.timeSeconds ?? 0
      if (timestamp - previous >= minSceneSeconds && durationSeconds - timestamp >= minSceneSeconds) found.push({ timeSeconds: round(timestamp), score: round(Number(score[1])) })
      timestamp = null
    }
  }
  return found
}

export function buildSections(durationSeconds, boundaries = []) {
  if (!positive(durationSeconds)) return []
  const valid = boundaries.filter(item => Number.isFinite(item.timeSeconds) && item.timeSeconds > 0 && item.timeSeconds < durationSeconds).sort((a, b) => a.timeSeconds - b.timeSeconds)
  const starts = [{ timeSeconds: 0 }, ...valid.filter((item, index) => !index || item.timeSeconds > valid[index - 1].timeSeconds)]
  return starts.map((item, index) => ({ index, startSeconds: round(item.timeSeconds), endSeconds: round(starts[index + 1]?.timeSeconds ?? durationSeconds), durationSeconds: round((starts[index + 1]?.timeSeconds ?? durationSeconds) - item.timeSeconds), boundary: index === 0 ? { kind: 'start' } : { kind: 'scene_change', score: item.score } }))
}

/** RMS describes loudness variation; candidates are onsets, not a verified beat grid. */
export function analyzePcmEnvelope(pcm, { sampleRate = 8000, windowSeconds = 0.1 } = {}) {
  const samplesPerWindow = Math.round(sampleRate * windowSeconds)
  if (!(samplesPerWindow > 0) || !(sampleRate > 0)) throw new Error('Invalid audio sampling configuration')
  const count = Math.floor(pcm.length / 2), windows = []
  for (let start = 0; start < count; start += samplesPerWindow) {
    const end = Math.min(count, start + samplesPerWindow)
    let squared = 0
    for (let sample = start; sample < end; sample++) squared += (pcm.readInt16LE(sample * 2) / 32768) ** 2
    windows.push({ startSeconds: round(start / sampleRate), endSeconds: round(end / sampleRate), rmsDb: round(Math.max(-96, 20 * Math.log10(Math.sqrt(squared / (end - start)) || 1e-8))) })
  }
  const beatCandidates = []
  for (let index = 1; index < windows.length - 1; index++) {
    const current = windows[index], rise = current.rmsDb - windows[index - 1].rmsDb
    if (current.rmsDb > -48 && rise >= 6 && current.rmsDb >= windows[index + 1].rmsDb && current.startSeconds - (beatCandidates.at(-1)?.timeSeconds ?? -Infinity) >= 0.25) beatCandidates.push({ timeSeconds: current.startSeconds, strength: round(Math.min(1, rise / 24)) })
  }
  return { windows, beatCandidates }
}

export async function analyzeLocalMedia(options) {
  const { allowedRoots, signal } = options
  const filePath = await validateLocalMediaPath(options.filePath, allowedRoots)
  const maxDurationSeconds = options.maxDurationSeconds ?? 300
  if (!Number.isFinite(maxDurationSeconds) || maxDurationSeconds < 1 || maxDurationSeconds > 600) throw new Error('Analysis duration must be between 1 and 600 seconds')
  const capabilities = await getMediaCapabilities(options)
  const result = { schemaVersion: 1, filename: path.basename(filePath), status: 'unavailable', metadata: null, analyzedDurationSeconds: 0, sections: [], audio: { status: 'unavailable', windows: [], beatCandidates: [], limitations: [] }, provenance: { method: 'local_ffmpeg_measurements', tools: capabilities }, limitations: [] }
  if (!capabilities.metadataAvailable) {
    result.limitations.push('FFprobe is not available. No video or audio observations were produced.')
    return result
  }
  const probe = await runTool(capabilities.ffprobe.command, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries', 'format=duration:stream=codec_type,width,height,avg_frame_rate,duration', '-of', 'json', filePath], { signal, timeoutMs: 15000, maxBytes: 1024 ** 2 })
  result.metadata = parseProbeMetadata(JSON.parse(probe.stdout.toString('utf8')))
  const duration = result.metadata.durationSeconds
  if (duration == null) {
    result.status = 'metadata_only'
    result.limitations.push('Duration could not be measured; scene and audio analysis were skipped.')
    return result
  }
  const analyzedDuration = Math.min(duration, maxDurationSeconds)
  result.analyzedDurationSeconds = round(analyzedDuration)
  if (duration > maxDurationSeconds) result.limitations.push(`Only the first ${maxDurationSeconds} seconds were analyzed.`)
  if (!capabilities.ffmpeg.available) {
    result.status = 'metadata_only'
    result.limitations.push('FFmpeg is not available. Scene boundaries and audio envelope were not analyzed.')
    return result
  }
  const baseArgs = ['-hide_banner', '-nostdin', '-protocol_whitelist', 'file,pipe', '-i', filePath, '-t', String(analyzedDuration)]
  result.status = 'analyzed'
  if (result.metadata.hasVideo && options.skipSceneAnalysis !== true) {
    try {
      const scenes = await runTool(capabilities.ffmpeg.command, [...baseArgs, '-an', '-vf', "fps=6,scale=320:-2,select='gt(scene,0.30)',metadata=print:key=lavfi.scene_score", '-f', 'null', '-'], { signal })
      result.sections = buildSections(analyzedDuration, parseSceneBoundaries(scenes.stderr, analyzedDuration))
      result.limitations.push('Scene-change candidates use 6 fps at 320px width and threshold 0.30; rapid cuts, fades and semantic changes may be missed. Sections are not narrative labels.')
    } catch (error) {
      if (signal?.aborted) throw error
      result.status = 'partial'
      result.limitations.push('Scene analysis failed; no scene observations were produced.')
    }
  }
  if (!result.metadata.hasAudio) result.audio.status = 'no_audio'
  else {
    try {
      const audio = await runTool(capabilities.ffmpeg.command, [...baseArgs, '-vn', '-ac', '1', '-ar', '8000', '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1'], { signal, maxBytes: 12 * 1024 ** 2 })
      result.audio = { status: 'analyzed', ...analyzePcmEnvelope(audio.stdout), limitations: ['100ms mono RMS windows and energy-onset candidates only; this is not BPM detection, musical beat tracking, speech transcription or sound classification.'] }
    } catch (error) {
      if (signal?.aborted) throw error
      result.status = 'partial'
      result.audio.limitations.push('Audio analysis failed; no envelope or onset observations were produced.')
    }
  }
  return result
}
