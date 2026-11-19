import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { localAnalysisConfig, startLocalAnalysisRuntime } from './local-runtime.mjs'

test('discover installed project tools and the verified instruct model without overriding host configuration', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'spur-video-local-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const models = path.join(root, '.build-tools', 'models')
  const manifest = path.join(models, 'ollama', 'manifests', 'registry.ollama.ai', 'library', 'qwen3-vl')
  await mkdir(manifest, { recursive: true })
  await writeFile(path.join(manifest, '2b-instruct'), '{}')
  await writeFile(path.join(models, 'ggml-base-q5_1.bin'), 'fixture')
  const config = localAnalysisConfig(root)
  assert.equal(config.SPUR_VIDEO_ANALYSIS_MODEL, 'qwen3-vl:2b-instruct')
  assert.equal(config.SPUR_VIDEO_ANALYSIS_OLLAMA_URL, 'http://127.0.0.1:11435')
  assert.equal(config.SPUR_WHISPER_MODEL, path.join(models, 'ggml-base-q5_1.bin'))
  assert.equal(localAnalysisConfig(root, { SPUR_VIDEO_ANALYSIS_MODEL: 'host-model' }).SPUR_VIDEO_ANALYSIS_MODEL, 'host-model')
  assert.equal(localAnalysisConfig(root, { SPUR_WHISPER_MODEL: '/host/model.bin' }).SPUR_WHISPER_MODEL, '/host/model.bin')
})
test('no model or binary is claimed to exist in an unprovisioned workspace', () => {
  const config = localAnalysisConfig(path.resolve('nonexistent-video-test-root'), { SPUR_FFMPEG_PATH: '/host/ffmpeg' })
  assert.equal(config.SPUR_FFMPEG_BIN, '/host/ffmpeg')
  assert.equal(config.SPUR_VIDEO_ANALYSIS_MODEL, undefined)
  assert.equal(config.SPUR_WHISPER_MODEL, undefined)
})

for (const provider of ['siliconflow', 'poe']) test(`${provider} cloud analysis retains media configuration and does not start or probe Ollama`, async t => {
  const original = globalThis.fetch
  globalThis.fetch = () => { throw Error('Cloud runtime must not probe Ollama') }
  t.after(() => { globalThis.fetch = original })
  const runtime = await startLocalAnalysisRuntime({ repoRoot: process.cwd(), runtimeRoot: process.cwd(), config: {
    SPUR_VIDEO_ANALYSIS_PROVIDER: provider, SPUR_FFMPEG_BIN: '/configured/ffmpeg',
    SPUR_VIDEO_ANALYSIS_OLLAMA_URL: 'http://127.0.0.1:11435',
  } })
  assert.equal(runtime.config.SPUR_VIDEO_ANALYSIS_PROVIDER, provider)
  assert.equal(runtime.config.SPUR_FFMPEG_BIN, '/configured/ffmpeg')
  runtime.stop()
})
