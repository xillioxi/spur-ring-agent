import { mkdir, mkdtemp, open, realpath, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runReaProcess } from './rea-video.mjs'

const RUNNER = fileURLToPath(new URL('./facecap-media.py', import.meta.url))
const MAX_BYTES = 1024 ** 2
const finite = value => typeof value === 'number' && Number.isFinite(value)
const fail = (message, code = 'facecap_media_invalid', status = 422) => Object.assign(new Error(message), { code, status })

function jpegSize(bytes) {
  if (bytes.length < 12 || bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) return null
  for (let cursor = 2; cursor + 4 <= bytes.length;) {
    if (bytes[cursor++] !== 255) return null
    while (bytes[cursor] === 255) cursor++
    const marker = bytes[cursor++]
    if (marker === 218 || marker === 217 || cursor + 2 > bytes.length) return null
    const size = bytes.readUInt16BE(cursor)
    if (size < 2 || cursor + size > bytes.length) return null
    if ([192, 193, 194].includes(marker)) {
      if (size < 8) return null
      return { width: bytes.readUInt16BE(cursor + 5), height: bytes.readUInt16BE(cursor + 3) }
    }
    cursor += size
  }
  return null
}

function image(value, width, height, side) {
  if (typeof value !== 'string' || !value.length || value.length > 350000 || value.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw fail('The face-reference worker returned invalid image data.', 'facecap_media_output')
  const bytes = Buffer.from(value, 'base64'), actual = jpegSize(bytes)
  if (bytes.length > 256 * 1024 || bytes.toString('base64') !== value || !actual || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > side || height > side || actual.width !== width || actual.height !== height) throw fail('The face-reference worker returned invalid image data.', 'facecap_media_output')
  return bytes.length
}

export function normalizeFaceCandidates(raw, { mode, durationSeconds } = {}) {
  if (!raw || raw.schemaVersion !== 1 || raw.networkEnabled !== false || !Array.isArray(raw.candidates) || !raw.candidates.length || raw.candidates.length > 12 || !Array.isArray(raw.warnings) || raw.warnings.length > 12 || !['photo', 'video'].includes(mode)) throw fail('The face-reference worker returned an invalid report.', 'facecap_media_output')
  let bytes = 0
  const candidates = raw.candidates.map(candidate => {
    if (!candidate || typeof candidate !== 'object' || !['face', 'manual'].includes(candidate.detection)) throw fail('The face-reference worker returned an invalid candidate.', 'facecap_media_output')
    const { width, height, contextWidth, contextHeight, sourceTimeSeconds, cropBox, quality } = candidate
    if (mode === 'photo' ? sourceTimeSeconds !== null : !finite(sourceTimeSeconds) || sourceTimeSeconds < 0 || !finite(durationSeconds) || sourceTimeSeconds > durationSeconds) throw fail('The face-reference worker returned an invalid timestamp.', 'facecap_media_output')
    if (!cropBox || !['x', 'y', 'width', 'height'].every(key => finite(cropBox[key])) || cropBox.x < 0 || cropBox.y < 0 || cropBox.width <= 0 || cropBox.height <= 0 || cropBox.x + cropBox.width > 1.000001 || cropBox.y + cropBox.height > 1.000001) throw fail('The face-reference worker returned an invalid crop.', 'facecap_media_output')
    if (!quality || !finite(quality.sharpness) || quality.sharpness < 0 || quality.sharpness > 1e8 || !finite(quality.brightness) || quality.brightness < 0 || quality.brightness > 1) throw fail('The face-reference worker returned invalid quality measurements.', 'facecap_media_output')
    bytes += image(candidate.imageBase64, width, height, 768) + image(candidate.contextBase64, contextWidth, contextHeight, 960)
    if (bytes > MAX_BYTES) throw fail('Face-reference images exceeded the saved size limit.', 'facecap_media_output')
    return { imageBase64: candidate.imageBase64, contextBase64: candidate.contextBase64, width, height, contextWidth, contextHeight, sourceTimeSeconds, cropBox: Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, cropBox[key]])), detection: candidate.detection, quality: { sharpness: quality.sharpness, brightness: quality.brightness } }
  })
  const warnings = raw.warnings.map(value => {
    if (typeof value !== 'string' || value.length > 1000 || /\b[a-z]:[\\/]|(?:^|\s)\/(?:Users|home|tmp|var|private)\//i.test(value)) throw fail('The face-reference worker returned invalid warnings.', 'facecap_media_output')
    return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim()
  }).filter(Boolean)
  return { candidates, warnings }
}

function isolatedEnv(python, directory, tools) {
  const env = Object.fromEntries(['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'SYSTEMDRIVE', 'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH'].filter(key => process.env[key]).map(key => [key, process.env[key]]))
  env.PATH = [...new Set([path.dirname(python), ...tools.map(tool => path.dirname(tool))])].join(path.delimiter)
  return { ...env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONNOUSERSITE: '1', HOME: directory, USERPROFILE: directory, TEMP: directory, TMP: directory, TMPDIR: directory }
}

async function prepare({ mode, filePath, durationSeconds, config = {}, signal, processRunner = runReaProcess, tempRoot = config.SPUR_VIDEO_ANALYSIS_TEMP_ROOT || os.tmpdir() } = {}) {
  if (mode === 'video' && (!finite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 300)) throw fail('Choose a saved video of five minutes or less.')
  if (signal?.aborted) throw fail('Face-reference processing cancelled.', 'analysis_cancelled', 499)
  const python = config.SPUR_REA_VIDEO_PYTHON
  const ffmpeg = config.SPUR_FFMPEG_BIN || config.SPUR_FFMPEG_PATH || config.FFMPEG_PATH
  const ffprobe = config.SPUR_FFPROBE_BIN || config.SPUR_FFPROBE_PATH || config.FFPROBE_PATH
  const tools = mode === 'video' ? [ffmpeg, ffprobe] : []
  if (![filePath, python, ...tools].every(value => typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0'))) throw fail('Configure the local Python and media tools for face references.', 'facecap_media_configuration', 503)
  let input
  try {
    const info = await stat(filePath)
    if (!info.isFile() || !info.size || info.size > (mode === 'photo' ? 8 : 80) * 1024 ** 2 || !(await stat(python)).isFile() || (await Promise.all(tools.map(tool => stat(tool)))).some(tool => !tool.isFile())) throw new Error('invalid input')
    input = await realpath(filePath)
    if (mode === 'photo') {
      const handle = await open(input, 'r')
      const header = Buffer.alloc(16)
      try { await handle.read(header, 0, 16, 0) } finally { await handle.close() }
      if (!(header[0] === 255 && header[1] === 216 && header[2] === 255) && !header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && !(header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP')) throw new Error('invalid image header')
    }
  } catch { throw fail('Choose an available JPEG, PNG or WebP photo within 8 MiB, or a saved video within 80 MiB.', 'facecap_media_input', 422) }
  let directory, root, operationError
  try {
    await mkdir(tempRoot, { recursive: true }); root = await realpath(tempRoot)
    directory = await mkdtemp(path.join(root, 'spur-facecap-'))
    const args = [RUNNER, '--mode', mode, '--input', input]
    if (mode === 'video') args.push('--duration', String(durationSeconds), '--ffmpeg', ffmpeg, '--ffprobe', ffprobe)
    const raw = await processRunner(python, args, { cwd: directory, env: isolatedEnv(python, directory, tools), signal, timeoutMs: mode === 'photo' ? 45000 : 120000 })
    return normalizeFaceCandidates(raw, { mode, durationSeconds })
  } catch (error) {
    operationError = error
    if (error?.code === 'analysis_cancelled' || typeof error?.code === 'string' && error.code.startsWith('facecap_')) throw error
    throw fail('Local face-reference processing could not finish. Check the Python runtime and media tools.', 'facecap_media_runtime', 503)
  } finally {
    if (directory && root) {
      const relative = path.relative(root, path.resolve(directory))
      if (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
        try { await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) } catch {
          if (!operationError) throw fail('Face-reference processing could not clean up temporary files.', 'facecap_media_cleanup', 503)
        }
      }
    }
  }
}

export const prepareFacePhoto = options => prepare({ ...options, mode: 'photo' })
export const extractFaceCandidates = options => prepare({ ...options, mode: 'video' })
