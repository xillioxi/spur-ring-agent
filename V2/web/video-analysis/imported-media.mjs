import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import path from 'node:path'

const failure = (message, status = 422) => Object.assign(new Error(message), { status })

export function inspectImportedMedia(metadata, { maxDurationSeconds = 300 } = {}) {
  if (!Number.isFinite(maxDurationSeconds) || maxDurationSeconds <= 0 || maxDurationSeconds > 300) throw failure('Invalid video duration limit.')
  const streams = Array.isArray(metadata?.streams) ? metadata.streams : []
  const video = streams.find(stream => stream?.codec_type === 'video' && Number(stream.disposition?.attached_pic) !== 1 && Number(stream.width) > 0 && Number(stream.height) > 0)
  if (!video) throw failure('The imported file does not contain a playable video.')
  const durations = [metadata?.format?.duration, ...streams.map(stream => stream?.duration)].map(Number).filter(value => Number.isFinite(value) && value > 0)
  if (!durations.length) throw failure('The video duration could not be verified. Try another reel.')
  const durationSeconds = Math.max(...durations)
  if (durationSeconds > maxDurationSeconds) throw failure('Choose a recorded video of five minutes or less.')
  return { durationSeconds, hasVideo: true, hasAudio: streams.some(stream => stream?.codec_type === 'audio'), width: Number(video.width), height: Number(video.height) }
}

export async function probeImportedVideo(filePath, { config = {}, signal, maxDurationSeconds = 300 } = {}) {
  const binary = config.SPUR_FFPROBE_BIN || config.SPUR_FFPROBE_PATH
  if (typeof binary !== 'string' || !path.isAbsolute(binary) || !await stat(binary).then(value => value.isFile(), () => false)) throw failure('Video verification is unavailable. Configure the local media tools before importing.', 503)
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw failure('A host-selected video file is required.')
  if (signal?.aborted) throw failure('Video import cancelled.')
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries', 'format=duration:stream=codec_type,width,height,duration:stream_disposition=attached_pic', '-of', 'json', filePath]
    const child = spawn(binary, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    let output = '', bytes = 0, stopped, settled = false
    const stop = message => { stopped ||= failure(message); child.kill() }
    const abort = () => stop('Video import cancelled.')
    const timer = setTimeout(() => stop('Video verification timed out. Try another reel.'), 15_000)
    signal?.addEventListener('abort', abort, { once: true })
    const finish = (cause, result) => {
      if (settled) return
      settled = true
      clearTimeout(timer); signal?.removeEventListener('abort', abort)
      cause ? reject(cause) : resolve(result)
    }
    child.stdout.on('data', chunk => {
      bytes += chunk.length
      if (bytes > 1024 * 1024) return stop('The imported file returned too much media metadata.')
      output += chunk.toString()
    })
    child.once('error', () => finish(failure('The local video verification tool could not start.', 503)))
    child.once('close', code => {
      if (stopped) return finish(stopped)
      if (code !== 0) return finish(failure('The imported file could not be verified as a playable video.'))
      let metadata
      try { metadata = JSON.parse(output) } catch { return finish(failure('The imported file returned invalid media metadata.')) }
      try { finish(null, inspectImportedMedia(metadata, { maxDurationSeconds })) } catch (cause) { finish(cause) }
    })
    // Close the race between the initial check and installing the listener.
    if (signal?.aborted) abort()
  })
}
