import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { analyze, capabilities } from './engine.mjs'

const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url))
const directory = path.join(workspaceRoot, 'V2/web/.runtime/video-analysis-tests')
const media = path.join(workspaceRoot, '.build-tools/media')
const models = path.join(workspaceRoot, '.build-tools/models')
const config = {
  ...process.env,
  SPUR_FFMPEG_BIN: process.env.SPUR_FFMPEG_BIN || path.join(media, 'ffmpeg/bin/ffmpeg.exe'),
  SPUR_FFPROBE_BIN: process.env.SPUR_FFPROBE_BIN || path.join(media, 'ffmpeg/bin/ffprobe.exe'),
  SPUR_WHISPER_BIN: process.env.SPUR_WHISPER_BIN || path.join(media, 'whisper/whisper-cli.exe'),
  SPUR_WHISPER_MODEL: process.env.SPUR_WHISPER_MODEL || path.join(models, 'ggml-base-q5_1.bin'),
  SPUR_WHISPER_VAD_MODEL: process.env.SPUR_WHISPER_VAD_MODEL || path.join(models, 'ggml-silero-v5.1.2.bin'),
  SPUR_VIDEO_ANALYSIS_OLLAMA_URL: process.env.SPUR_VIDEO_ANALYSIS_OLLAMA_URL || 'http://127.0.0.1:11435',
  SPUR_VIDEO_ANALYSIS_MODEL: process.env.SPUR_VIDEO_ANALYSIS_MODEL || 'qwen3-vl:2b-instruct',
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks = [], errors = []
    child.stdout.on('data', data => chunks.push(data))
    child.stderr.on('data', data => errors.push(data))
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve(Buffer.concat(chunks).toString('utf8')) : reject(new Error(Buffer.concat(errors).toString('utf8').slice(-3000))))
  })
}

if (process.platform !== 'win32') throw new Error('The synthetic verification fixture uses Windows speech synthesis.')
await mkdir(directory, { recursive: true })
console.log(await run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./create-verification-fixture.ps1', import.meta.url)), '-OutputDirectory', directory]))
const audio = path.join(directory, 'speech.wav')
const probe = JSON.parse(await run(config.SPUR_FFPROBE_BIN, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', audio]))
const duration = Math.max(12, Math.ceil(Number(probe.format.duration)) + 2)
const filePath = path.join(directory, 'synthetic-script-ocr-verification.mp4')
await run(config.SPUR_FFMPEG_BIN, [
  '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
  '-loop', '1', '-t', String(duration / 2), '-i', path.join(directory, 'scene-one.png'),
  '-loop', '1', '-t', String(duration / 2), '-i', path.join(directory, 'scene-two.png'), '-i', audio,
  '-filter_complex', '[0:v]fps=24,format=yuv420p[v0];[1:v]fps=24,format=yuv420p[v1];[v0][v1]concat=n=2:v=1:a=0[v];[2:a]apad[a]',
  '-map', '[v]', '-map', '[a]', '-t', String(duration), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-c:a', 'aac', filePath,
])
const available = await capabilities(config)
console.log(JSON.stringify({ fixture: 'synthetic', filePath, capabilities: available }))
const longFixture = path.join(directory, 'over-limit-verification.mp4')
await run(config.SPUR_FFMPEG_BIN, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=black:s=16x16:r=1:d=301', '-c:v', 'libx264', '-preset', 'ultrafast', longFixture])
const overLimitProgress = []
await assert.rejects(analyze({ filePath: longFixture, allowedRoots: [directory], config, onProgress: update => overLimitProgress.push(update.stage) }), /5 minutes or less/)
assert.deepEqual(overLimitProgress, ['preparing'], 'Long videos must fail before scene measurements, speech or vision inference.')
console.log(JSON.stringify({ fixture: 'synthetic', durationGuardPassed: true }))
const analysisStarted = Date.now()
const result = await analyze({ filePath, allowedRoots: [directory], config, onProgress: update => console.log(JSON.stringify(update)) })
const analysisSeconds = Math.round((Date.now() - analysisStarted) / 100) / 10
await writeFile(path.join(directory, 'synthetic-verification-result.json'), JSON.stringify(result, null, 2))
const expectedSpeech = /video script test/i.test(result.script.text) && /travel reel/i.test(result.script.text)
const screen = result.script.onScreenText.map(item => item.text).join(' ')
const expectedText = /SPUR RING/i.test(screen) && /TOMORROW/i.test(screen)
console.log(JSON.stringify({ fixture: 'synthetic', analysisSeconds, status: result.status, shots: result.shots.length, expectedSpeech, expectedText, script: result.script.text, screen, inversePrompt: result.inversePrompt, warnings: result.warnings, provenance: result.provenance }, null, 2))
if (!available.vision.available) process.exitCode = 2 // Partial verification is not a full pipeline pass.
else if (!expectedSpeech || !expectedText || result.shots.length < 2 || result.status !== 'complete') process.exitCode = 1
