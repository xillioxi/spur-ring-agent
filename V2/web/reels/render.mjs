import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, link, lstat, mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { getMediaCapabilities, parseProbeMetadata, validateLocalMediaPath } from './media.mjs'

const ID = /^[A-Za-z0-9_-]{1,120}$/
// Reject playlist demuxers, even if an input is disguised with a media suffix.
const INPUT_FORMATS = 'mov,matroska,webm,avi,mp3,wav,aac,flac,ogg,m4v'
let renderActive = false
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const number = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
const decimal = value => String(Math.round(value * 1e9) / 1e9)
const fail = message => { throw new Error(message) }

function fields(value, allowed, label) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(`Invalid ${label} fields`)
}

function validate({ plan, assets, outputPath }) {
  fields(plan, ['schemaVersion', 'canvas', 'shots', 'music', 'durationSeconds', 'provenance', 'limitations'], 'reel plan')
  if (plan.schemaVersion !== 1) fail('Unsupported reel plan schemaVersion')
  fields(plan.canvas, ['width', 'height', 'fps'], 'canvas')
  const { width, height, fps } = plan.canvas
  if (![width, height].every(value => Number.isInteger(value) && value >= 64 && value <= 2160 && value % 2 === 0)) fail('Canvas dimensions must be even integers between 64 and 2160')
  if (!Number.isInteger(fps) || fps < 15 || fps > 60) fail('Canvas fps must be an integer between 15 and 60')
  if (!Array.isArray(assets) || !assets.length || assets.length > 200) fail('Provide between 1 and 200 registered assets')
  const byId = new Map()
  for (const asset of assets) {
    if (!object(asset) || typeof asset.id !== 'string' || !ID.test(asset.id) || byId.has(asset.id)) fail('Asset IDs must be unique registered identifiers')
    if (typeof asset.filePath !== 'string' || !path.isAbsolute(asset.filePath) || asset.filePath.includes('\0')) fail('Assets require absolute local file paths')
    if (!number(asset.durationSeconds, 0.001, 24 * 60 * 60)) fail('Asset duration must be known and bounded')
    if (asset.hasVideo !== undefined && typeof asset.hasVideo !== 'boolean') fail('Invalid asset video metadata')
    if (asset.hasAudio !== undefined && typeof asset.hasAudio !== 'boolean') fail('Invalid asset audio metadata')
    byId.set(asset.id, asset)
  }
  if (!Array.isArray(plan.shots) || plan.shots.length < 1 || plan.shots.length > 60) fail('A reel must contain between 1 and 60 shots')
  let duration = 0
  const shots = plan.shots.map(shot => {
    fields(shot, ['assetId', 'sourceStartSeconds', 'durationSeconds'], 'shot')
    const asset = byId.get(shot.assetId)
    if (!asset || asset.hasVideo === false) fail('Every shot requires a registered video asset')
    if (!number(shot.sourceStartSeconds, 0, asset.durationSeconds) || !number(shot.durationSeconds, 0.1, 60) || shot.sourceStartSeconds + shot.durationSeconds > asset.durationSeconds + 1e-6) fail('Shot trim exceeds its registered source duration')
    duration += shot.durationSeconds
    return { ...shot, asset }
  })
  if (!number(plan.durationSeconds, 0.5, 180) || duration > 180 + 1e-6 || Math.abs(duration - plan.durationSeconds) > 1e-6) fail('Reel duration must match its shots and be between 0.5 and 180 seconds')
  let music = null
  if (plan.music != null) {
    fields(plan.music, ['assetId', 'sourceStartSeconds', 'gainDb'], 'music')
    const asset = byId.get(plan.music.assetId)
    if (!asset || asset.hasAudio === false) fail('Music requires a registered audio asset')
    if (!number(plan.music.sourceStartSeconds, 0, asset.durationSeconds) || plan.music.sourceStartSeconds + duration > asset.durationSeconds + 1e-6) fail('Music must cover the entire reel without looping')
    if (!number(plan.music.gainDb, -60, 12)) fail('Music gain must be between -60 and 12 dB')
    music = { ...plan.music, asset }
  }
  if (typeof outputPath !== 'string' || !path.isAbsolute(outputPath) || outputPath.includes('\0') || path.extname(outputPath).toLowerCase() !== '.mp4') fail('Output must be an absolute local MP4 path')
  if (assets.some(asset => path.resolve(asset.filePath) === path.resolve(outputPath))) fail('Output cannot replace a registered source asset')
  return { shots, music, width, height, fps, duration }
}

/** Pure argv construction. renderReel additionally enforces approved roots and probes actual files. */
export function buildRenderArgs(options) {
  const { shots, music, width, height, fps, duration } = validate(options)
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n']
  for (const shot of shots) args.push('-protocol_whitelist', 'file,pipe', '-format_whitelist', INPUT_FORMATS, '-i', shot.asset.filePath)
  if (music) args.push('-protocol_whitelist', 'file,pipe', '-format_whitelist', INPUT_FORMATS, '-i', music.asset.filePath)
  const filters = shots.map((shot, index) => `[${index}:v:0]trim=start=${decimal(shot.sourceStartSeconds)}:duration=${decimal(shot.durationSeconds)},setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=${fps},format=yuv420p[v${index}]`)
  filters.push(`${shots.map((_, index) => `[v${index}]`).join('')}concat=n=${shots.length}:v=1:a=0[vout]`)
  if (music) filters.push(`[${shots.length}:a:0]atrim=start=${decimal(music.sourceStartSeconds)}:duration=${decimal(duration)},asetpts=PTS-STARTPTS,volume=${decimal(music.gainDb)}dB,aresample=48000[aout]`)
  args.push('-filter_complex_threads', '1', '-filter_complex', filters.join(';'), '-map', '[vout]')
  if (music) args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000')
  else args.push('-an')
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-t', decimal(duration), '-map_metadata', '-1', '-map_chapters', '-1', '-movflags', '+faststart', '-f', 'mp4', options.outputPath)
  return args
}

function run(command, args, { signal, timeoutMs = 180000, maxBytes = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Reel rendering cancelled'))
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = [], stderr = []
    let bytes = 0, failure, forceTimer
    const stop = message => {
      if (failure) return
      failure = new Error(message)
      child.kill()
      forceTimer = setTimeout(() => child.kill('SIGKILL'), 2000)
    }
    const timer = setTimeout(() => stop('Reel media tool timed out'), timeoutMs)
    const cancel = () => stop('Reel rendering cancelled')
    signal?.addEventListener('abort', cancel, { once: true })
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) stream.on('data', chunk => {
      bytes += chunk.length
      if (bytes > maxBytes) stop('Reel media tool output limit exceeded')
      else chunks.push(chunk)
    })
    const cleanup = () => { clearTimeout(timer); clearTimeout(forceTimer); signal?.removeEventListener('abort', cancel) }
    child.once('error', error => { cleanup(); reject(new Error(error.code === 'ENOENT' ? 'Required media executable is unavailable' : 'Could not start reel media tool')) })
    child.once('close', code => {
      cleanup()
      if (failure) return reject(failure)
      if (code !== 0) return reject(new Error('Reel media processing failed; no verified reel was produced'))
      resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString('utf8') })
    })
  })
}

const inside = (root, file) => {
  const relative = path.relative(root, file)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

async function outputLocation(outputPath, allowedRoots) {
  if (!Array.isArray(allowedRoots) || !allowedRoots.length) fail('Server-approved media roots are required')
  const roots = await Promise.all(allowedRoots.map(async root => {
    if (typeof root !== 'string' || !path.isAbsolute(root)) fail('Media roots must be absolute paths')
    return realpath(root)
  }))
  const parent = await realpath(path.dirname(outputPath))
  if (!(await stat(parent)).isDirectory()) fail('Output parent must be a directory')
  const canonical = path.join(parent, path.basename(outputPath))
  if (!roots.some(root => inside(root, canonical))) fail('Output is outside the approved library')
  try { await lstat(canonical); fail('Output already exists; choose a new filename') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  await access(parent, constants.W_OK)
  return canonical
}

async function probe(command, filePath, signal) {
  const result = await run(command, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', INPUT_FORMATS, '-show_entries', 'format=duration:stream=codec_type,width,height,avg_frame_rate,duration', '-of', 'json', filePath], { signal, timeoutMs: 15000 })
  let value
  try { value = JSON.parse(result.stdout.toString('utf8')) } catch { fail('FFprobe returned invalid metadata') }
  return parseProbeMetadata(value)
}

/** Cuts-only MP4 rendering. No downloads, model calls, publishing, or source-file writes. */
export async function renderReel(options) {
  if (renderActive) fail('A reel render is already active in this process; retry after it finishes')
  renderActive = true
  try { return await renderUnlocked(options) }
  finally { renderActive = false }
}

async function renderUnlocked({ plan, assets, outputPath, allowedRoots, ffmpegPath, ffprobePath, signal }) {
  const shape = validate({ plan, assets, outputPath })
  if (signal?.aborted) fail('Reel rendering cancelled')
  const finalPath = await outputLocation(outputPath, allowedRoots)
  const usedIds = new Set([...shape.shots.map(shot => shot.asset.id), ...(shape.music ? [shape.music.asset.id] : [])])
  const safeAssets = []
  for (const asset of assets.filter(item => usedIds.has(item.id))) safeAssets.push({ ...asset, filePath: await validateLocalMediaPath(asset.filePath, allowedRoots) })
  if (safeAssets.some(asset => asset.filePath === finalPath)) fail('Output cannot replace a registered source asset')
  const tools = await getMediaCapabilities({ ffmpegPath, ffprobePath, signal })
  if (signal?.aborted) fail('Reel rendering cancelled')
  if (!tools.ffmpeg.available || !tools.ffprobe.available) fail('FFmpeg and FFprobe are required; no reel was rendered')
  const actual = new Map()
  for (const asset of safeAssets) actual.set(asset.id, await probe(tools.ffprobe.command, asset.filePath, signal))
  for (const shot of shape.shots) {
    const metadata = actual.get(shot.assetId)
    if (!metadata.hasVideo || metadata.durationSeconds == null || shot.sourceStartSeconds + shot.durationSeconds > metadata.durationSeconds + 0.01) fail('Shot exceeds the actual video duration or has no video stream')
  }
  if (shape.music) {
    const metadata = actual.get(shape.music.assetId)
    if (!metadata.hasAudio || metadata.durationSeconds == null || shape.music.sourceStartSeconds + shape.duration > metadata.durationSeconds + 0.01) fail('Music exceeds the actual audio duration or has no audio stream')
  }
  // A private temporary directory isolates our partial output. Final link() is
  // exclusive, so a source or an existing destination can never be overwritten.
  const work = await mkdtemp(path.join(path.dirname(finalPath), '.spur-reel-'))
  const temporary = path.join(work, 'render.mp4')
  try {
    await run(tools.ffmpeg.command, buildRenderArgs({ plan, assets: safeAssets, outputPath: temporary }), { signal })
    const metadata = await probe(tools.ffprobe.command, temporary, signal)
    const tolerance = Math.max(0.15, shape.shots.length / shape.fps + 0.05)
    if (!metadata.hasVideo || metadata.hasAudio !== Boolean(shape.music) || metadata.width !== shape.width || metadata.height !== shape.height || metadata.fps == null || Math.abs(metadata.fps - shape.fps) > 0.01 || metadata.durationSeconds == null || Math.abs(metadata.durationSeconds - shape.duration) > tolerance) fail('Rendered reel did not match the requested video, audio, canvas, or duration')
    await run(tools.ffmpeg.command, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-xerror', '-protocol_whitelist', 'file,pipe', '-i', temporary, '-map', '0:v:0', ...(shape.music ? ['-map', '0:a:0'] : []), '-f', 'null', '-'], { signal })
    if (signal?.aborted) fail('Reel rendering cancelled')
    await link(temporary, finalPath)
    return { status: 'completed', outputPath: finalPath, metadata, durationSeconds: metadata.durationSeconds, verification: { metadata: true, decoded: true }, limitations: ['Cuts only with center cropping; source audio is discarded.', 'This verifies media integrity and requested layout, not editorial quality or channel resemblance.'] }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}
