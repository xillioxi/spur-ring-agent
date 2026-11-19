import { spawn } from 'node:child_process'
import { realpath as resolveRealPath } from 'node:fs'
import { stat, lstat, writeFile, rm } from 'node:fs/promises'
import { promisify } from 'node:util'
import path from 'node:path'

const MAX_FILE_BYTES = 48 * 1024 ** 2
const FPS = 30
const realpath = promisify(resolveRealPath)
const failure = (message, status = 422) => Object.assign(new Error(message), { status, code: 'reconstruction_render_failed', definitive: true })
const cancelled = signal => { if (signal?.aborted) throw Object.assign(failure('Reconstruction was stopped.', 499), { code: 'reconstruction_cancelled' }) }
const inside = (root, file) => { const relative = path.relative(root, file); return relative && !relative.startsWith('..') && !path.isAbsolute(relative) }

export async function runReconstructionProcess(command, args, { signal, timeoutMs = 180000, maxBytes = 1024 ** 2 } = {}) {
  cancelled(signal)
  return new Promise((resolve, reject) => {
    let child, done = false, size = 0
    const output = [], errors = []
    const finish = (error, code) => {
      if (done) return
      done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort)
      if (error || code !== 0) reject(error || failure('The generated clips could not be processed.'))
      else resolve({ stdout: Buffer.concat(output), stderr: Buffer.concat(errors).toString('utf8') })
    }
    try { child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }) } catch { reject(failure('The video rendering tools could not start.', 503)); return }
    const abort = () => { child.kill(); finish(failure('Reconstruction was stopped.', 499)) }
    const timer = setTimeout(() => { child.kill(); finish(failure('The generated clips took too long to process.', 504)) }, timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    for (const [stream, chunks] of [[child.stdout, output], [child.stderr, errors]]) stream.on('data', value => {
      size += value.length
      if (size > maxBytes) { child.kill(); finish(failure('The rendering tools exceeded their output limit.')) } else chunks.push(value)
    })
    child.once('error', () => finish(failure('The video rendering tools could not start.', 503)))
    child.once('close', code => finish(null, code))
    if (signal?.aborted) abort()
  })
}

const tools = config => ({ ffmpeg: config.SPUR_FFMPEG_BIN || config.SPUR_FFMPEG_PATH || config.FFMPEG_PATH || 'ffmpeg', ffprobe: config.SPUR_FFPROBE_BIN || config.SPUR_FFPROBE_PATH || config.FFPROBE_PATH || 'ffprobe' })

export async function probeReconstructionMedia(filePath, { config = {}, signal, runProcess = runReconstructionProcess } = {}) {
  cancelled(signal)
  const output = await runProcess(tools(config).ffprobe, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', filePath], { signal, timeoutMs: 15000, maxBytes: 64 * 1024 })
  let data
  try { data = JSON.parse(output.stdout.toString('utf8')) } catch { throw failure('A generated clip did not contain readable video metadata.') }
  const video = data.streams?.find(value => value.codec_type === 'video'), durationSeconds = Number(data.format?.duration)
  if (!video || !Number.isFinite(durationSeconds) || durationSeconds <= 0) throw failure('A generated clip did not contain a measurable video track.')
  return { durationSeconds, width: video.width, height: video.height, hasAudio: data.streams.some(value => value.codec_type === 'audio') }
}

function dimensions(ratio, resolution) {
  if (!['480p', '768p'].includes(resolution) || !['1:1', '3:4', '4:3', '9:16', '16:9', '21:9'].includes(ratio)) throw failure('Choose a supported output ratio and resolution.')
  const [width, height] = ratio.split(':').map(Number), short = resolution === '480p' ? 480 : 768
  return width >= height ? [Math.round(short * width / height / 2) * 2, short] : [short, Math.round(short * height / width / 2) * 2]
}

function timeline(clips, totalDurationSeconds) {
  let cursor = 0, previousFrame = 0
  const planned = clips.map(clip => {
    if (!clip || !Number.isFinite(clip.durationSeconds) || clip.durationSeconds <= 0) throw failure('A generated clip has invalid timing.')
    const explicit = clip.startSeconds !== undefined || clip.endSeconds !== undefined
    const start = explicit ? clip.startSeconds : cursor, end = explicit ? clip.endSeconds : cursor + clip.durationSeconds
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || start < cursor - 0.002 || Math.abs(end - start - clip.durationSeconds) > 0.002) throw failure('Generated clips need ordered, non-overlapping start and end times matching their durations.')
    const startFrame = Math.round(start * FPS), endFrame = Math.round(end * FPS)
    if (startFrame < previousFrame || endFrame - startFrame < 1) throw failure('A generated shot must occupy at least one frame without overlapping another shot.')
    const gapFrames = startFrame - previousFrame
    cursor = end; previousFrame = endFrame
    return { ...clip, gapFrames, frameCount: endFrame - startFrame }
  })
  const duration = totalDurationSeconds ?? cursor
  if (!Number.isFinite(duration) || duration <= 0 || duration > 300.001 || duration < cursor - 0.002) throw failure('The reconstruction timeline must cover every shot and stay within five minutes.')
  const finalFrame = Math.round(duration * FPS)
  if (finalFrame < previousFrame) throw failure('The reconstruction timeline ends before its final generated shot.')
  return { clips: planned, duration, trailingGapFrames: finalFrame - previousFrame }
}

/** Generated footage at authored times, with black editorial gaps. Reference media contributes audio, never visuals. */
export async function renderReconstruction({ clips, totalDurationSeconds, referencePath, audioMode = 'reference', outputPath, ratio = '9:16', resolution = '480p', config = {}, signal, runProcess = runReconstructionProcess, probe = probeReconstructionMedia, ensureStorage = async () => {} } = {}) {
  if (!Array.isArray(clips) || !clips.length || clips.length > 24 || !['reference', 'silent'].includes(audioMode)) throw failure('Choose a bounded set of generated clips and an audio mode.')
  const planned = timeline(clips, totalDurationSeconds)
  const directory = await realpath(path.dirname(outputPath))
  if (!inside(directory, path.resolve(outputPath))) throw failure('The reconstruction output must stay in its job directory.')
  const inputs = new Set(await Promise.all([...clips.map(clip => clip.filePath), ...(referencePath ? [referencePath] : [])].map(file => realpath(file))))
  // Never let cleanup or -y overwrite an input, even when this helper is called
  // independently of the manager's fixed clip/output filenames.
  for (const file of [outputPath, path.join(directory, 'assembly-list.txt'), ...clips.map((_, index) => path.join(directory, `normalized-${index}.mp4`)), ...Array.from({ length: clips.length + 1 }, (_, index) => path.join(directory, `editorial-gap-${index}.mp4`))]) {
    if (inputs.has(path.resolve(file))) throw failure('Reconstruction output and temporary files cannot replace source media.')
    try { if ((await lstat(file)).isSymbolicLink()) throw failure('Reconstruction output cannot use a symbolic link.') } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const [width, height] = dimensions(ratio, resolution)
  const normalized = [], temporary = [], listPath = path.join(directory, 'assembly-list.txt')
  const duration = planned.duration
  let complete = false
  const addGap = async (frameCount, index) => {
    if (!frameCount) return
    cancelled(signal)
    const file = path.join(directory, `editorial-gap-${index}.mp4`)
    temporary.push(file)
    await ensureStorage(MAX_FILE_BYTES)
    await runProcess(tools(config).ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', `color=c=black:size=${width}x${height}:rate=${FPS}`, '-an', '-frames:v', String(frameCount), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-map_metadata', '-1', '-fs', String(MAX_FILE_BYTES), file], { signal, timeoutMs: 180000, maxBytes: 1024 ** 2 })
    const info = await probe(file, { config, signal, runProcess })
    if (Math.abs(info.durationSeconds - frameCount / FPS) > 0.05) throw failure('An editorial gap could not be rendered to its planned duration.')
    normalized.push(file)
  }
  try {
    for (let index = 0; index < planned.clips.length; index++) {
      cancelled(signal)
      const clip = planned.clips[index], actual = await realpath(clip.filePath)
      if (!inside(directory, actual) || !(await stat(actual)).isFile() || !Number.isFinite(clip.durationSeconds) || clip.durationSeconds <= 0) throw failure('A generated clip is missing or outside its job directory.')
      const info = await probe(actual, { config, signal, runProcess })
      const frameCount = clip.frameCount
      if (frameCount < 1 || info.durationSeconds + 0.05 < frameCount / FPS) throw failure('A generated clip is shorter than its required shot. No reference visuals or invented padding were substituted.')
      await addGap(clip.gapFrames, index)
      const file = path.join(directory, `normalized-${index}.mp4`)
      temporary.push(file)
      await ensureStorage(MAX_FILE_BYTES)
      await runProcess(tools(config).ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe', '-i', actual, '-map', '0:v:0', '-an', '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS},trim=end_frame=${frameCount},setpts=PTS-STARTPTS`, '-frames:v', String(frameCount), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-map_metadata', '-1', '-fs', String(MAX_FILE_BYTES), file], { signal, timeoutMs: 180000, maxBytes: 1024 ** 2 })
      const rendered = await probe(file, { config, signal, runProcess })
      if (Math.abs(rendered.durationSeconds - frameCount / FPS) > 0.05) throw failure('A generated shot could not be rendered to its planned duration.')
      normalized.push(file)
    }
    await addGap(planned.trailingGapFrames, planned.clips.length)
    await writeFile(listPath, normalized.map(file => `file '${path.basename(file)}'`).join('\n') + '\n', { mode: 0o600 })
    temporary.push(listPath)
    await ensureStorage(MAX_FILE_BYTES)
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe', '-f', 'concat', '-safe', '1', '-i', listPath]
    if (audioMode === 'reference') {
      if (!referencePath || !(await stat(await realpath(referencePath))).isFile()) throw failure('Reference audio is unavailable. Choose silent output instead.')
      args.push('-i', referencePath, '-map', '0:v:0', '-map', '1:a:0', '-c:a', 'aac', '-b:a', '128k')
    } else args.push('-map', '0:v:0', '-an')
    args.push('-c:v', 'copy', '-t', String(duration), '-map_metadata', '-1', '-movflags', '+faststart', '-fs', String(MAX_FILE_BYTES), outputPath)
    await runProcess(tools(config).ffmpeg, args, { signal, timeoutMs: 180000, maxBytes: 1024 ** 2 })
    const result = await probe(outputPath, { config, signal, runProcess }), size = (await stat(outputPath)).size
    if (!size || size > MAX_FILE_BYTES || Math.abs(result.durationSeconds - duration) > 0.075 || audioMode === 'reference' && !result.hasAudio || audioMode === 'silent' && result.hasAudio) throw failure('The assembled output did not match its planned duration and audio mode.')
    complete = true
    return { ...result, size, intendedDurationSeconds: duration, warnings: ['Generated clips are cut at the planned shot boundaries, rounded to the nearest 30 fps frame.', ...(planned.trailingGapFrames || planned.clips.some(clip => clip.gapFrames) ? ['Authored timeline gaps are rendered as black editorial frames; reference audio keeps its original timing.'] : [])] }
  } finally {
    for (const file of temporary) await rm(file, { force: true }).catch(() => {})
    if (!complete) await rm(outputPath, { force: true }).catch(() => {})
  }
}
