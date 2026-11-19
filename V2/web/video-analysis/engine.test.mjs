import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import childProcess from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import { syncBuiltinESMExports } from 'node:module'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { analyze, buildInversePrompt, groupSpeechWords, parseOcrResponse, parseVisualResponse, parseWhisperTranscript, selectFrameSamples } from './engine.mjs'

const bundledMedia = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.build-tools/media/ffmpeg/bin')
const regressionFfmpeg = process.env.SPUR_FFMPEG_BIN || path.join(bundledMedia, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
const regressionFfprobe = process.env.SPUR_FFPROBE_BIN || path.join(bundledMedia, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')

test('Whisper millisecond offsets become bounded audio evidence with original language', () => {
  const result = parseWhisperTranscript({
    result: { language: 'zh' },
    transcription: [
      { offsets: { from: 1250, to: 3400 }, text: '  今天去旅行。 ' },
      { offsets: { from: 3500, to: 6500 }, text: 'See you tomorrow.' },
    ],
  }, 5)
  assert.equal(result.language, 'zh')
  assert.deepEqual(result.segments, [
    { startSeconds: 1.25, endSeconds: 3.4, text: '今天去旅行。' },
    { startSeconds: 3.5, endSeconds: 5, text: 'See you tomorrow.' },
  ])
  assert.equal(result.text, '今天去旅行。\nSee you tomorrow.')
})

test('Whisper timestamps fallback is supported without inventing timings', () => {
  const result = parseWhisperTranscript({ transcription: [
    { timestamps: { from: '00:00:00,500', to: '00:00:01,250' }, text: 'Hello.' },
    { text: 'No timing evidence.' },
  ] }, 2)
  assert.deepEqual(result.segments, [{ startSeconds: 0.5, endSeconds: 1.25, text: 'Hello.' }])
})

test('non-speech markers and invalid or out-of-range speech timestamps are excluded', () => {
  const result = parseWhisperTranscript({ transcription: [
    { offsets: { from: 0, to: 1000 }, text: '[Music]' },
    { offsets: { from: 0, to: 1000 }, text: '(silence)' },
    { offsets: { from: -1, to: 1000 }, text: 'negative' },
    { offsets: { from: 1000, to: 1000 }, text: 'zero' },
    { offsets: { from: 4000, to: 5000 }, text: 'outside' },
    { offsets: { from: 'not a time', to: 1000 }, text: 'invalid' },
  ] }, 3)
  assert.equal(result.text, '')
  assert.deepEqual(result.segments, [])
  assert.throws(() => parseWhisperTranscript({}, 3), /invalid transcript/)
})

test('word timestamps remain evidence while script lines are readable and respect pauses', () => {
  const words = [
    { startSeconds: 0, endSeconds: 0.5, text: 'Welcome' },
    { startSeconds: 0.5, endSeconds: 1, text: 'back.' },
    { startSeconds: 2, endSeconds: 2.5, text: '今天' },
    { startSeconds: 2.5, endSeconds: 3, text: '旅行。' },
  ]
  assert.deepEqual(groupSpeechWords(words), [
    { startSeconds: 0, endSeconds: 1, text: 'Welcome back.' },
    { startSeconds: 2, endSeconds: 3, text: '今天旅行。' },
  ])
  assert.equal(words.length, 4)
})

test('sampling covers short reels with two actual timestamps inside each shot', () => {
  const result = selectFrameSamples([
    { index: 0, startSeconds: 0, endSeconds: 2 },
    { index: 1, startSeconds: 2, endSeconds: 4 },
  ])
  assert.deepEqual(result, [{ index: 0, timestamps: [0.4, 1.6] }, { index: 1, timestamps: [2.4, 3.6] }])
})

test('sampling enforces the frame budget and includes the start and end of longer reels', () => {
  const sections = Array.from({ length: 80 }, (_, index) => ({ index, startSeconds: index, endSeconds: index + 1 }))
  const samples = selectFrameSamples(sections)
  assert.equal(samples.length, 12)
  assert.equal(samples.flatMap(sample => sample.timestamps).length, 24)
  assert.equal(samples[0].index, 0)
  assert.equal(samples.at(-1).index, 79)
  assert.equal(new Set(samples.map(sample => sample.index)).size, samples.length)
})

test('scene descriptions cannot supply OCR or speech text', () => {
  const result = parseVisualResponse(JSON.stringify({
    visual: 'An ocean-facing hotel balcony.', framing: 'Wide shot', cameraMovement: null,
    action: null, frames: [
      { timeSeconds: 999, onScreenText: ['BALI', 'BALI', 123, ''] },
      { timeSeconds: -5, onScreenText: ['早上好'] },
    ],
    spokenText: 'Unheard dialogue must never become a transcript.',
  }))
  assert.equal(result.cameraMovement, null)
  assert.equal(result.frames, undefined)
  assert.equal(result.onScreenText, undefined)
  assert.equal(result.spokenText, undefined)
})

test('independent OCR uses the supplied timestamp and accepts an actual empty transcription', () => {
  assert.deepEqual(parseOcrResponse({ timeSeconds: 999, onScreenText: ['BALI', 'BALI', '早上好'] }, 1.2), { timeSeconds: 1.2, onScreenText: ['BALI', '早上好'], ocrStatus: 'analyzed' })
  assert.deepEqual(parseOcrResponse({ onScreenText: [] }, 1.8), { timeSeconds: 1.8, onScreenText: [], ocrStatus: 'analyzed' })
  assert.throws(() => parseOcrResponse({ visual: 'A scene description is not OCR.' }, 1.2), /invalid transcript/)
  assert.throws(() => parseOcrResponse({ onScreenText: [123] }, 1.2), /invalid transcript/)
})

test('visual model response rejects unusable output and tolerates JSON fences', () => {
  assert.throws(() => parseVisualResponse('This is not JSON'), /valid analysis JSON/)
  assert.throws(() => parseVisualResponse('{}'), /no usable/)
  const result = parseVisualResponse('```json\n{"visual":"A green tree."}\n```')
  assert.equal(result.visual, 'A green tree.')
  assert.equal(result.frames, undefined)
})

test('OCR placeholder-only strings are excluded while actual longer text remains exact', () => {
  const result = parseOcrResponse({ onScreenText: ['null', ' undefined ', 'None', 'N/A', 'Null Island', 'NULL', 'n/a', 'None shall pass.', 'HELLO WORLD'] }, 1.2)
  assert.deepEqual(result.onScreenText, ['Null Island', 'None shall pass.', 'HELLO WORLD'])
  const actualCaption = 'The character is shown in a close-up, with a focused expression, in a dimly lit room with a patterned wall.'
  assert.deepEqual(parseOcrResponse({ onScreenText: [actualCaption] }, 1.2).onScreenText, [actualCaption], 'The parser must not delete legitimate printed captions using wording or length heuristics.')
})

test('OCR schema-key echoes fail the sample explicitly instead of becoming printed text', () => {
  assert.throws(() => parseOcrResponse({ onScreenText: ['onScreenText'] }, 1.2), /echoed its output schema/)
  assert.throws(() => parseOcrResponse({ onScreenText: ['A real title', 'on_screen_text'] }, 1.2), /unreliable and need review/)
  assert.deepEqual(parseOcrResponse({ onScreenText: ['Using onScreenText in a schema'] }, 1.2).onScreenText, ['Using onScreenText in a schema'])
})

test('inverse prompts keep observed composition, visible text and timed dialogue together', () => {
  const prompt = buildInversePrompt([
    { index: 0, startSeconds: 0, endSeconds: 1.5, visual: 'A blue pool beside a hotel.', framing: 'Wide shot', cameraMovement: null, action: null, onScreenText: ['Weekend escape'], spokenText: 'A transcript is separate.' },
    { index: 1, startSeconds: 1.5, endSeconds: 3, visual: null, onScreenText: [] },
  ])
  assert.match(prompt, /Shot 1 \(1\.5s; 0–1\.5s\)/)
  assert.match(prompt, /blue pool/)
  assert.match(prompt, /"Weekend escape"/)
  assert.match(prompt, /Machine-transcribed dialogue: "A transcript is separate\."/)
  assert.doesNotMatch(prompt, /Shot 2|undefined/)
  assert.equal(buildInversePrompt([{ visual: null }]), null)
})

test('analyzer rejects modes outside the app contract before reading files', async () => {
  await assert.rejects(analyze({ mode: 'train' }), /both, breakdown, script or audio/)
  await assert.rejects(analyze({ analysisWorkflowId: 'unregistered' }), /available video breakdown workflow/)
  await assert.rejects(analyze({ analysisWorkflowId: 'rea-video', mode: 'audio' }), { status: 422, code: 'unsupported_analysis_workflow_mode' })
})

test('Rea dispatch reaches only the local runtime even when the configured cloud model is unavailable', { skip: !existsSync(regressionFfmpeg) || !existsSync(regressionFfprobe) }, async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'spur-rea-engine-'))
  t.after(() => rm(tmp, { recursive: true, force: true }))
  const filePath = path.join(tmp, 'synthetic.mp4'), source = path.join(tmp, 'source'), python = path.join(tmp, 'python-not-executable.exe')
  await mkdir(path.join(source, 'rea_video'), { recursive: true })
  await Promise.all([writeFile(path.join(source, 'rea_video', 'pipeline.py'), '# readiness fixture'), writeFile(python, 'not executable')])
  await promisify(childProcess.execFile)(regressionFfmpeg, ['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=6:d=1', '-c:v', 'libx264', filePath], { windowsHide: true })
  const mockedFetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Rea must not use a network provider') })
  try {
    await assert.rejects(analyze({ filePath, allowedRoots: [tmp], analysisWorkflowId: 'rea-video', config: { SPUR_VIDEO_ANALYSIS_PROVIDER: 'poe', SPUR_POE_FLASH_API_AVAILABLE: '0', SPUR_REA_VIDEO_PYTHON: python, SPUR_REA_VIDEO_SOURCE: source, SPUR_FFMPEG_BIN: regressionFfmpeg, SPUR_FFPROBE_BIN: regressionFfprobe, SPUR_VIDEO_ANALYSIS_TEMP_ROOT: tmp } }), { code: 'rea_video_runtime', status: 503 })
    assert.equal(mockedFetch.mock.callCount(), 0)
  } finally { mockedFetch.mock.restore() }
})

test('real media/provider integration when a fixture and local tools are configured', { skip: !process.env.SPUR_VIDEO_ANALYSIS_TEST_VIDEO }, async () => {
  const filePath = path.resolve(process.env.SPUR_VIDEO_ANALYSIS_TEST_VIDEO)
  const progress = []
  const result = await analyze({ filePath, allowedRoots: [path.dirname(filePath)], config: process.env, onProgress: update => progress.push(update) })
  assert.ok(result.shots.length > 0)
  assert.ok(result.metadata.durationSeconds > 0)
  assert.equal(progress.at(-1).percent, 100)
  assert.ok(['complete', 'partial'].includes(result.status))
  assert.ok(Array.isArray(result.script.segments))
  if (process.env.SPUR_VIDEO_ANALYSIS_MODEL) {
    assert.ok(result.provenance.vision.sampledFrameCount > 0, JSON.stringify(result.warnings))
    assert.ok(result.inversePrompt)
  }
})

test('cloud engine checks original video and audio without any local visual processing or paid calls', { skip: !existsSync(regressionFfmpeg) || !existsSync(regressionFfprobe) }, async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'spur-cloud-engine-skip-'))
  t.after(() => rm(tmp, { recursive: true, force: true }))
  const filePath = path.join(tmp, 'synthetic.mp4')
  await promisify(childProcess.execFile)(regressionFfmpeg, ['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=6:d=1', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=1', '-shortest', '-c:v', 'libx264', '-c:a', 'aac', filePath], { windowsHide: true })
  const originalSpawn = childProcess.spawn, calls = [], progress = []
  const mockedSpawn = t.mock.method(childProcess, 'spawn', function (...args) { calls.push(args); return Reflect.apply(originalSpawn, this, args) })
  const mockedFetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('No provider request is allowed in this regression test') })
  syncBuiltinESMExports()
  try {
    for (const [provider, missingKey] of [['siliconflow', /SILICONFLOW_API_KEY/], ['poe', /POE_API_KEY/]]) {
      await assert.rejects(analyze({ filePath, allowedRoots: [tmp], config: { SPUR_VIDEO_ANALYSIS_PROVIDER: provider, SPUR_FFMPEG_BIN: regressionFfmpeg, SPUR_FFPROBE_BIN: regressionFfprobe }, onProgress: update => progress.push(update) }), missingKey)
    }
    assert.equal(mockedFetch.mock.callCount(), 0)
    assert.equal(calls.some(([, args]) => args.includes('-vf') || args.includes('-frames:v')), false)
    assert.ok(calls.some(([, args]) => args.includes('-vn')))
    assert.ok(progress.some(update => /Checking video duration and measuring the audio track/.test(update.message)))
    assert.equal(progress.some(update => /Finding shot boundaries/.test(update.message)), false)
  } finally { mockedSpawn.mock.restore(); mockedFetch.mock.restore(); syncBuiltinESMExports() }
})
