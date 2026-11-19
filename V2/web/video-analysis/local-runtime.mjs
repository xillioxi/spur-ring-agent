import { existsSync, mkdirSync, openSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'

/** Discover only this workspace's explicitly provisioned tools. Never downloads. */
export function localAnalysisConfig(repoRoot, config = {}) {
  const tools = join(repoRoot, '.build-tools', 'media')
  const models = join(repoRoot, '.build-tools', 'models')
  const defaults = process.platform === 'win32' ? {
    SPUR_FFMPEG_BIN: join(tools, 'ffmpeg', 'bin', 'ffmpeg.exe'),
    SPUR_FFPROBE_BIN: join(tools, 'ffmpeg', 'bin', 'ffprobe.exe'),
    SPUR_WHISPER_BIN: join(tools, 'whisper', 'whisper-cli.exe'),
    SPUR_YTDLP_BIN: join(tools, 'yt-dlp.exe'),
  } : {}
  defaults.SPUR_WHISPER_MODEL = join(models, 'ggml-base-q5_1.bin')
  defaults.SPUR_WHISPER_VAD_MODEL = join(models, 'ggml-silero-v5.1.2.bin')
  defaults.SPUR_AUDIO_MODEL = join(models, 'yamnet', 'yamnet-classification.tflite')
  defaults.SPUR_AUDIO_LABELS = join(models, 'yamnet', 'yamnet_class_map.csv')
  if (process.platform === 'win32') defaults.SPUR_AUDIO_PYTHON = join(homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python311', 'python.exe')
  const result = { ...config }
  for (const [key, value] of Object.entries(defaults)) if (!result[key] && existsSync(value)) result[key] = value
  if (!result.SPUR_FFMPEG_BIN && result.SPUR_FFMPEG_PATH) result.SPUR_FFMPEG_BIN = result.SPUR_FFMPEG_PATH
  if (!result.SPUR_FFPROBE_BIN && result.SPUR_FFPROBE_PATH) result.SPUR_FFPROBE_BIN = result.SPUR_FFPROBE_PATH
  const manifest = join(models, 'ollama', 'manifests', 'registry.ollama.ai', 'library', 'qwen3-vl', '2b-instruct')
  if (existsSync(manifest) && !result.SPUR_VIDEO_ANALYSIS_OLLAMA_URL && !result.SPUR_VIDEO_ANALYSIS_MODEL) {
    result.SPUR_VIDEO_ANALYSIS_OLLAMA_URL = 'http://127.0.0.1:11435'
    result.SPUR_VIDEO_ANALYSIS_MODEL = 'qwen3-vl:2b-instruct'
  }
  return result
}

export async function startLocalAnalysisRuntime({ repoRoot, runtimeRoot, config }) {
  const resolved = localAnalysisConfig(repoRoot, config)
  // Cloud analysis still uses local FFmpeg, but does not need to load a local LLM.
  if (['siliconflow', 'poe'].includes(resolved.SPUR_VIDEO_ANALYSIS_PROVIDER)) return { config: resolved, stop() {} }
  const url = resolved.SPUR_VIDEO_ANALYSIS_OLLAMA_URL
  const models = join(repoRoot, '.build-tools', 'models', 'ollama')
  // Only auto-start the dedicated, project-local service; other providers belong to their host.
  if (url !== 'http://127.0.0.1:11435' || !existsSync(models)) return { config: resolved, stop() {} }
  try {
    const response = await fetch(url + '/api/version', { signal: AbortSignal.timeout(1500) })
    if (response.ok) return { config: resolved, stop() {} }
  } catch {}
  const installed = join(homedir(), 'AppData', 'Local', 'Programs', 'Ollama', 'ollama.exe')
  const binary = resolved.SPUR_OLLAMA_BIN || (process.platform === 'win32' && existsSync(installed) ? installed : 'ollama')
  mkdirSync(runtimeRoot, { recursive: true })
  const stdout = openSync(join(runtimeRoot, 'local-vision.log'), 'a')
  const stderr = openSync(join(runtimeRoot, 'local-vision-error.log'), 'a')
  let failed = false
  const child = spawn(binary, ['serve'], { windowsHide: true, shell: false,
    env: { ...process.env, OLLAMA_HOST: '127.0.0.1:11435', OLLAMA_MODELS: models, OLLAMA_NO_CLOUD: '1', OLLAMA_NUM_PARALLEL: '1', OLLAMA_MAX_LOADED_MODELS: '1' }, stdio: ['ignore', stdout, stderr] })
  closeSync(stdout); closeSync(stderr)
  child.on('error', () => { failed = true })
  for (let attempt = 0; attempt < 12 && !failed; attempt++) {
    try { if ((await fetch(url + '/api/version', { signal: AbortSignal.timeout(800) })).ok) break } catch {}
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  return { config: resolved, stop() { if (child.exitCode == null && !failed) child.kill() } }
}
