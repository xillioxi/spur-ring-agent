import { mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { reaVideoCapability, runReaProcess } from './rea-video.mjs'

const RUNNER = fileURLToPath(new URL('./rea-frame-grid.py', import.meta.url))
const MAX_IMAGE_BYTES = 512 * 1024
const fail = (message, code = 'rea_frame_grid_invalid', status = 422) => Object.assign(new Error(message), { code, status })
const finite = value => typeof value === 'number' && Number.isFinite(value)

function isolatedEnv(config, directory, ffmpeg, ffprobe) {
  const env = Object.fromEntries(['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'SYSTEMDRIVE', 'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH'].filter(key => process.env[key]).map(key => [key, process.env[key]]))
  env.PATH = [...new Set([path.dirname(config.SPUR_REA_VIDEO_PYTHON), path.dirname(ffmpeg), path.dirname(ffprobe)])].join(path.delimiter)
  return { ...env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONNOUSERSITE: '1', REA_VIDEO_HOME: path.join(directory, 'home'), REA_VIDEO_MODELS: path.join(directory, 'models'), TEMP: directory, TMP: directory, TMPDIR: directory, HOME: directory, USERPROFILE: directory }
}

function imageBytes(raw) {
  if (!raw || raw.schemaVersion !== 1 || raw.contentType !== 'image/jpeg' || typeof raw.dataBase64 !== 'string' || !raw.dataBase64.length || raw.dataBase64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || raw.dataBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw.dataBase64)) throw fail('The local frame grid returned invalid image data.', 'rea_frame_grid_output')
  const bytes = Buffer.from(raw.dataBase64, 'base64')
  if (bytes.length < 32 || bytes.length > MAX_IMAGE_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9 || bytes.toString('base64') !== raw.dataBase64) throw fail('The local frame grid returned invalid image data.', 'rea_frame_grid_output')
  return bytes
}

/** Generate a timestamped full-frame contact sheet locally; no media is uploaded. */
export async function createReaFrameGrid({ filePath, durationSeconds, startSeconds, endSeconds, config = {}, signal, processRunner = runReaProcess, tempRoot = config.SPUR_VIDEO_ANALYSIS_TEMP_ROOT || os.tmpdir() } = {}) {
  if (![durationSeconds, startSeconds, endSeconds].every(finite) || durationSeconds <= 0 || durationSeconds > 300 || startSeconds < 0 || endSeconds <= startSeconds || endSeconds > durationSeconds || endSeconds - startSeconds > 12) throw fail('Choose a range within the video, no longer than 12 seconds.')
  if (signal?.aborted) throw fail('Video analysis cancelled.', 'analysis_cancelled', 499)
  const capability = reaVideoCapability(config)
  if (!capability.available) throw fail(capability.reason, 'rea_video_configuration', 503)
  const ffmpeg = config.SPUR_FFMPEG_BIN || config.SPUR_FFMPEG_PATH || config.FFMPEG_PATH
  const ffprobe = config.SPUR_FFPROBE_BIN || config.SPUR_FFPROBE_PATH || config.FFPROBE_PATH
  if (![filePath, ffmpeg, ffprobe].every(value => typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0'))) throw fail('Configure absolute local media paths for the frame grid.', 'rea_video_configuration', 503)
  let video
  try {
    const [input, encoder, probe] = await Promise.all([stat(filePath), stat(ffmpeg), stat(ffprobe)])
    if (!input.isFile() || input.size <= 0 || input.size > 80 * 1024 ** 2 || !encoder.isFile() || !probe.isFile()) throw new Error('invalid local media')
    video = await realpath(filePath)
  } catch { throw fail('The local video or media tools are unavailable.', 'rea_frame_grid_media', 404) }
  await mkdir(tempRoot, { recursive: true })
  const root = await realpath(tempRoot)
  const directory = await mkdtemp(path.join(root, 'spur-rea-frames-'))
  let operationError
  try {
    const raw = await processRunner(config.SPUR_REA_VIDEO_PYTHON, [RUNNER, '--source', config.SPUR_REA_VIDEO_SOURCE, '--video', video, '--out', path.join(directory, 'grid.jpg'), '--ffmpeg', ffmpeg, '--ffprobe', ffprobe, '--start', String(startSeconds), '--end', String(endSeconds)], { env: isolatedEnv(config, directory, ffmpeg, ffprobe), cwd: directory, signal, timeoutMs: 120000 })
    return { bytes: imageBytes(raw), contentType: 'image/jpeg', filename: 'rea-frame-grid.jpg' }
  } catch (cause) {
    operationError = cause
    throw cause
  } finally {
    // The only recursive target is the verified per-run child of our chosen root.
    const relative = path.relative(root, path.resolve(directory))
    if (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      try { await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) } catch {
        if (!operationError) throw fail('The local frame grid could not clean up its temporary files.', 'rea_frame_grid_cleanup', 503)
      }
    }
  }
}
