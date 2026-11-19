import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { analyzePoe, poeCapability, poeConfigured } from './poe.mjs'
import { scriptTemplatePrompt } from './script-templates.mjs'

const credential = 'synthetic-poe-test-credential'
const otherCredential = 'synthetic-siliconflow-test-credential'
const videoBytes = Buffer.from('complete original MP4 including its embedded audio track')
const audioBytes = Buffer.from('complete extracted MP3 audio track fixture')
const config = { SPUR_VIDEO_ANALYSIS_PROVIDER: 'poe', POE_API_KEY: credential }
const observation = (duration = 15) => ({
  summary: 'A continuous POV fall through a checkerboard room reaches a landscape.',
  language: 'en',
  shots: [{ startSeconds: 0, endSeconds: duration, visual: 'The camera falls from a checkerboard room toward the ground.', framing: 'POV', cameraMovement: 'Downward descent', action: 'Falls through the floor', unsupported: 'must be discarded' }],
  onScreenText: [{ startSeconds: 0, endSeconds: duration, text: 'KEEP HOLDING THE CAMERA' }],
  transcript: [{ startSeconds: 0.5, endSeconds: 2.5, text: 'Do not let go of the camera.' }],
  audio: {
    description: 'Low music, a spoken warning and a brief rushing effect.',
    segments: [{ startSeconds: 0, endSeconds: duration, description: 'Quiet instrumental music continues under the voice.' }],
    events: [{ startSeconds: 4.2, endSeconds: 4.8, label: 'Rushing whoosh', category: 'sfx', description: 'A short rush grows louder.' }],
  },
})
const response = (value, { finishReason = 'stop', contentArray = false } = {}) => new Response(JSON.stringify({
  choices: [{ message: { content: contentArray ? [{ type: 'text', text: JSON.stringify(value) }] : typeof value === 'string' ? value : JSON.stringify(value) }, finish_reason: finishReason }],
  usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
}), { headers: { 'content-type': 'application/json' } })

async function fixture(t, { duration = 15, hasAudio = true, mode = 'both', fetchImpl, processImpl, extraConfig = {} } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'spur-poe-test-'))
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  const tempRoot = path.join(root, 'prepared')
  await mkdir(tempRoot)
  const filePath = path.join(root, 'private-source-name.mp4')
  await writeFile(filePath, videoBytes)
  const calls = [], processes = [], progress = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body)
    calls.push({ url, options, body })
    return fetchImpl ? fetchImpl(url, options, calls.length, body) : response(observation(duration))
  })
  const measurement = {
    status: 'analyzed', analyzedDurationSeconds: duration,
    metadata: { durationSeconds: duration, hasVideo: true, hasAudio, width: 720, height: 1280, fps: 24 },
    audio: { status: hasAudio ? 'analyzed' : 'no_audio', windows: hasAudio ? [{ startSeconds: 0, endSeconds: duration, rmsDb: -24 }] : [], limitations: [] },
  }
  const runProcess = async (command, args, options) => {
    processes.push({ command, args, options })
    if (processImpl) return processImpl(command, args, options)
    await writeFile(args.at(-1), audioBytes)
    return { stdout: Buffer.alloc(0), stderr: '' }
  }
  const args = { filePath, mode, config: { ...config, ...extraConfig }, measurement, runProcess, tempRoot, ffmpegPath: 'ffmpeg-test', onProgress: value => progress.push(value) }
  return { root, calls, processes, progress, args, run: extra => analyzePoe({ ...args, ...extra }) }
}

test('Poe selection is explicit and capability does not expose credentials', () => {
  assert.equal(poeConfigured({ POE_API_KEY: credential }), false)
  assert.equal(poeConfigured({ SPUR_VIDEO_ANALYSIS_PROVIDER: 'Poe' }), false)
  assert.equal(poeConfigured(config), true)
  assert.equal(poeCapability(config).available, true)
  assert.equal(poeCapability(config).model, 'Gemini-3.7-Flash')
  assert.equal(poeCapability({}).configured, false)
  assert.equal(poeCapability({ ...config, POE_BASE_URL: 'http://insecure.invalid' }).available, false)
  assert.equal(poeCapability({ ...config, SPUR_VIDEO_ANALYSIS_POE_MODEL: 'unrequested-model' }).available, false)
  assert.equal(JSON.stringify(poeCapability(config)).includes(credential), false)
})

test('known Flash API refusal keeps the key configured while disabling capability explicitly', () => {
  const capability = poeCapability({ ...config, SPUR_POE_FLASH_API_AVAILABLE: '0' })
  assert.equal(capability.configured, true)
  assert.equal(capability.available, false)
  assert.equal(capability.provider, 'poe')
  assert.equal(capability.model, 'Gemini-3.7-Flash')
  assert.match(capability.reason, /API access/)
  assert.equal(JSON.stringify(capability).includes(credential), false)
})

test('known Flash API refusal rejects every mode before source reads, transcoding or network calls', async t => {
  const f = await fixture(t, { extraConfig: { SPUR_POE_FLASH_API_AVAILABLE: '0' } })
  const missingFile = path.join(f.root, 'nonexistent-private-source.mp4')
  for (const mode of ['both', 'breakdown', 'script', 'audio']) {
    await assert.rejects(f.run({ mode, filePath: missingFile }), error => {
      assert.equal(error.code, 'poe_model_unavailable')
      assert.equal(error.status, 503)
      assert.match(error.message, /API access/)
      assert.equal(error.message.includes(missingFile), false)
      assert.equal(error.message.includes(credential), false)
      return true
    })
  }
  assert.equal(f.calls.length, 0)
  assert.equal(f.processes.length, 0)
  assert.deepEqual(await readdir(f.args.tempRoot), [])
})

test('the historical Argon refusal flag does not disable or reroute Flash', async t => {
  const legacy = { ...config, SPUR_POE_ARGON_API_AVAILABLE: '0' }
  assert.equal(poeCapability(legacy).available, true)
  assert.equal(poeCapability(legacy).model, 'Gemini-3.7-Flash')
  const f = await fixture(t, { extraConfig: { SPUR_POE_ARGON_API_AVAILABLE: '0' } })
  const result = await f.run()
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].body.model, 'Gemini-3.7-Flash')
  assert.equal(result.provenance.multimodal.model, 'Gemini-3.7-Flash')
  assert.equal(result.scriptStructure, undefined)
  assert.deepEqual(result.script.segments, observation().transcript)
  assert.ok(f.calls[0].body.messages[0].content.at(-1).text.includes('分镜编号 | 取景地 | 画面 | 台词 | 镜头运用 | 秒数 | 花字 | 背景特效与滤镜 | 备注'))
})

test('complete original MP4 is sent byte-for-byte with embedded audio and no extracted frames', async t => {
  const f = await fixture(t, { duration: 26.700091 })
  const result = await f.run()
  assert.equal(f.calls.length, 1)
  const { url, options, body } = f.calls[0]
  assert.equal(url, 'https://api.poe.com/v1/chat/completions')
  assert.equal(options.headers.authorization, `Bearer ${credential}`)
  assert.equal(options.redirect, 'error')
  assert.equal(body.model, 'Gemini-3.7-Flash')
  assert.equal(body.stream, false)
  assert.equal(body.response_format, undefined)
  assert.deepEqual(body.messages[0].content.map(part => part.type), ['file', 'text'])
  const file = body.messages[0].content[0].file
  assert.equal(file.filename, 'reference.mp4')
  assert.match(file.file_data, /^data:video\/mp4;base64,/)
  assert.deepEqual(Buffer.from(file.file_data.split(',')[1], 'base64'), videoBytes)
  assert.equal(JSON.stringify(body).includes(f.args.filePath), false)
  assert.equal(JSON.stringify(body).includes('private-source-name'), false)
  assert.equal(JSON.stringify(body).includes(credential), false)
  assert.equal(f.processes.length, 0, 'full video mode must not extract or resize any media')
  assert.deepEqual(await readFile(f.args.filePath), videoBytes)
  assert.equal(result.status, 'complete')
  assert.equal(result.script.text, 'Do not let go of the camera.')
  assert.equal(result.shots[0].action, 'Falls through the floor')
  assert.equal(result.shots[0].unsupported, undefined)
  assert.match(result.audio.semanticDescription, /rushing effect/)
  assert.equal(result.audio.semanticEvents[0].startSeconds, 4.2)
  assert.equal(result.provenance.multimodal.provider, 'poe')
  assert.equal(result.provenance.multimodal.inputMode, 'video_and_audio')
  assert.equal(result.provenance.multimodal.mediaTransport, 'original_video')
  assert.deepEqual(result.provenance.multimodal.usage, { promptTokens: 100, completionTokens: 50, totalTokens: 150 })
  assert.equal(result.provenance.multimodal.sampling.controlledBy, 'provider')
  assert.equal(result.provenance.multimodal.sampling.frameTimestampsAvailable, false)
  assert.deepEqual(result.provenance.multimodal.coverage, [{ startSeconds: 0, endSeconds: 26.7, status: 'analyzed' }])
  assert.equal(f.progress.at(-1).stage, 'complete')
  assert.deepEqual(await readdir(f.args.tempRoot), [])
})

test('whole-video observations retain their original timestamps and text-part responses are accepted', async t => {
  const raw = observation(27)
  raw.shots = [{ startSeconds: 0, endSeconds: 8.25, visual: 'Checkerboard room.' }, { startSeconds: 8.25, endSeconds: 12.5, visual: 'Falls through the floor and reaches the ground.' }, { startSeconds: 12.5, endSeconds: 27, visual: 'Landscape curls overhead.' }]
  raw.audio.events = [{ startSeconds: 22.25, endSeconds: 23.5, label: 'Wind rush', category: 'ambient' }]
  const f = await fixture(t, { duration: 27, fetchImpl: () => response(raw, { contentArray: true }) })
  const result = await f.run()
  assert.deepEqual(result.shots.map(shot => [shot.startSeconds, shot.endSeconds]), [[0, 8.25], [8.25, 12.5], [12.5, 27]])
  assert.equal(result.audio.semanticEvents[0].startSeconds, 22.25)
  assert.equal(f.calls.length, 1)
  assert.equal(result.provenance.multimodal.chunkCount, 1)
})

test('Poe forwards the selected workbook lens and retains evidence-backed interpretation separately from exact words', async t => {
  const raw = observation()
  Object.assign(raw.shots[0], { location: 'Checkerboard room', effects: 'A visible floor transition', notes: 'The camera remains in a continuous descent.' })
  raw.scriptStructure = {
    templateId: 'xc-1', summary: 'A spoken warning opens the action.',
    stages: [{ stageId: 'hook', startSeconds: 0, endSeconds: 3, interpretation: 'The warning creates an immediate question.', evidence: [{ source: 'speech', ...raw.transcript[0] }] }],
  }
  const f = await fixture(t, { fetchImpl: () => response(raw) })
  const result = await f.run({ scriptTemplateId: 'xc-1' })
  assert.ok(f.calls[0].body.messages[0].content.at(-1).text.includes(scriptTemplatePrompt('xc-1')))
  assert.equal(result.scriptStructure.templateId, 'xc-1')
  assert.equal(result.scriptStructure.stages[0].stageId, 'hook')
  assert.deepEqual(result.script.segments, raw.transcript)
  assert.deepEqual(result.script.onScreenText.map(({ evidence, ...value }) => value), raw.onScreenText)
  assert.equal(result.script.scriptStructure, undefined)
  assert.equal(result.shots[0].location, 'Checkerboard room')
  assert.equal(result.shots[0].effects, 'A visible floor transition')
  assert.equal(result.shots[0].notes, 'The camera remains in a continuous descent.')
  assert.equal(f.calls.length, 1, 'structure interpretation uses the existing paid analysis request')
})

test('Poe defaults to the nine-column observed breakdown and ignores unsolicited narrative classifications', async t => {
  const raw = observation()
  raw.scriptStructure = {
    templateId: 'xc-1', summary: 'An unsolicited narrative role.',
    stages: [{ stageId: 'hook', startSeconds: 0, endSeconds: 3, interpretation: 'A proposed hook.', evidence: [{ source: 'speech', ...raw.transcript[0] }] }],
  }
  const f = await fixture(t, { fetchImpl: () => response(raw) })
  const result = await f.run()
  const prompt = f.calls[0].body.messages[0].content.at(-1).text
  assert.ok(prompt.includes('分镜编号 | 取景地 | 画面 | 台词 | 镜头运用 | 秒数 | 花字 | 背景特效与滤镜 | 备注'))
  assert.equal(prompt.includes('Template catalog:'), false)
  assert.equal(result.scriptStructure, undefined)
  assert.deepEqual(result.script.segments, raw.transcript)
  assert.deepEqual(result.script.onScreenText.map(({ evidence, ...value }) => value), raw.onScreenText)
  assert.equal(f.calls.length, 1)
})

test('script and breakdown modes retain the complete video but honor their output contracts', async t => {
  for (const mode of ['script', 'breakdown']) {
    const f = await fixture(t, { mode })
    const result = await f.run()
    assert.deepEqual(f.calls[0].body.messages[0].content.map(part => part.type), ['file', 'text'])
    assert.equal(f.processes.length, 0)
    assert.equal(result.script.onScreenText[0].text, 'KEEP HOLDING THE CAMERA')
    if (mode === 'script') {
      assert.deepEqual(result.shots, [])
      assert.equal(result.script.text, 'Do not let go of the camera.')
      assert.equal(result.provenance.vision.status, 'not_requested')
    } else {
      assert.equal(result.shots.length, 1)
      assert.equal(result.script.text, '')
      assert.equal(result.provenance.speech.status, 'not_requested')
      assert.match(f.calls[0].body.messages[0].content.at(-1).text, /TRANSCRIPTION DISABLED/)
    }
    assert.equal(result.audio.semanticEvents.length, 1)
  }
})

test('audio-only mode sends the complete extracted track and removes temporary media', async t => {
  const f = await fixture(t, { mode: 'audio' })
  const result = await f.run()
  assert.equal(f.processes.length, 1)
  const { command, args } = f.processes[0]
  assert.equal(command, 'ffmpeg-test')
  assert.equal(args[args.indexOf('-i') + 1], f.args.filePath)
  assert.equal(args[args.indexOf('-map') + 1], '0:a:0')
  assert.ok(args.includes('-vn'))
  assert.equal(args.includes('-ss'), false)
  assert.equal(args.includes('-t'), false)
  assert.equal(args.includes('-vf'), false)
  const parts = f.calls[0].body.messages[0].content
  assert.deepEqual(parts.map(part => part.type), ['file', 'text'])
  assert.equal(parts[0].file.filename, 'reference-audio.mp3')
  assert.match(parts[0].file.file_data, /^data:audio\/mpeg;base64,/)
  assert.deepEqual(Buffer.from(parts[0].file.file_data.split(',')[1], 'base64'), audioBytes)
  assert.deepEqual(result.shots, [])
  assert.deepEqual(result.script.onScreenText, [])
  assert.equal(result.provenance.multimodal.inputMode, 'audio')
  assert.equal(result.provenance.multimodal.mediaTransport, 'audio_track')
  assert.equal(result.provenance.vision.status, 'not_requested')
  assert.deepEqual(await readdir(f.args.tempRoot), [])
  assert.equal(result.scriptStructure, undefined)
  assert.equal(parts.at(-1).text.includes(scriptTemplatePrompt('auto')), false)
})

test('silent video removes hallucinated audio observations without extracting media', async t => {
  const f = await fixture(t, { hasAudio: false })
  const result = await f.run()
  assert.equal(f.calls.length, 1)
  assert.equal(f.processes.length, 0)
  assert.equal(result.script.text, '')
  assert.deepEqual(result.audio.semanticEvents, [])
  assert.equal(result.audio.semanticDescription, '')
  assert.equal(result.provenance.speech.status, 'no_audio')
  assert.equal(result.provenance.multimodal.inputMode, 'video')
})

test('audio mode on a silent file makes no paid request', async t => {
  const f = await fixture(t, { mode: 'audio', hasAudio: false })
  const result = await f.run()
  assert.equal(f.calls.length, 0)
  assert.equal(f.processes.length, 0)
  assert.equal(result.audio.status, 'no_audio')
  assert.equal(result.provenance.multimodal.status, 'no_audio')
})

test('authentication, credits, missing model and rate errors fail once without leaking provider bodies', async t => {
  const expected = { 401: 'poe_authentication', 403: 'poe_authentication', 402: 'poe_credits', 404: 'poe_model_unavailable', 429: 'poe_rate_limit', 500: 'poe_analysis_failed' }
  for (const [statusText, code] of Object.entries(expected)) {
    const status = Number(statusText)
    const f = await fixture(t, { mode: 'audio', fetchImpl: () => new Response(`${credential} private-source-name.mp4`, { status }) })
    await assert.rejects(f.run(), error => error.status === status && error.code === code && !error.message.includes(credential) && !error.message.includes('private-source-name'))
    assert.equal(f.calls.length, 1, 'paid requests must never be automatically retried')
    assert.deepEqual(await readdir(f.args.tempRoot), [])
  }
})

test('network errors are sanitized and never retried or silently switched to another provider', async t => {
  const f = await fixture(t, { fetchImpl: () => { throw new Error(`network ${credential} C:\\private\\source.mp4`) } })
  await assert.rejects(f.run(), error => error.code === 'poe_analysis_failed' && /No paid request was retried/.test(error.message) && !error.message.includes(credential) && !error.message.includes('private'))
  assert.equal(f.calls.length, 1)
})

test('invalid provider JSON and invalid analysis JSON never become successful observations', async t => {
  for (const fetchImpl of [() => new Response('not JSON'), () => response('not analysis JSON'), () => response('{}')]) {
    const f = await fixture(t, { fetchImpl })
    await assert.rejects(f.run(), error => error.code === 'poe_analysis_failed')
    assert.equal(f.calls.length, 1)
  }
})

test('truncated but parseable output is visibly partial', async t => {
  const f = await fixture(t, { fetchImpl: () => response(observation(), { finishReason: 'length' }) })
  const result = await f.run()
  assert.equal(result.status, 'partial')
  assert.equal(result.provenance.vision.status, 'partial')
  assert.ok(result.warnings.some(warning => /truncated/.test(warning)))
})

test('invalid timestamps and missing fields mark results partial instead of inventing observations', async t => {
  const raw = observation()
  raw.shots.push({ startSeconds: '3', endSeconds: 4, visual: 'Invalid string timestamp.' })
  delete raw.audio
  delete raw.transcript
  const f = await fixture(t, { fetchImpl: () => response(raw) })
  const result = await f.run()
  assert.equal(result.status, 'partial')
  assert.equal(result.shots.length, 1)
  assert.equal(result.script.text, '')
  assert.deepEqual(result.audio.semanticEvents, [])
})

test('echoed credentials and private paths are removed from saved observations', async t => {
  let sourcePath
  const f = await fixture(t, { extraConfig: { SILICONFLOW_API_KEY: otherCredential }, fetchImpl: () => {
    const raw = observation()
    raw.summary = `${credential} ${otherCredential} ${sourcePath}`
    raw.shots[0].visual = raw.summary
    raw.transcript[0].text = raw.summary
    raw.audio.description = raw.summary
    return response(raw)
  } })
  sourcePath = f.args.filePath
  const result = await f.run()
  const serialized = JSON.stringify(result)
  assert.equal(serialized.includes(credential), false)
  assert.equal(serialized.includes(otherCredential), false)
  assert.equal(serialized.includes(sourcePath), false)
  assert.match(result.summary, /\[redacted\]/)
})

test('cancelling an active request aborts transport and cleans extracted audio', async t => {
  const controller = new AbortController()
  const f = await fixture(t, { mode: 'audio', fetchImpl: async (_url, options) => {
    controller.abort()
    assert.equal(options.signal.aborted, true)
    throw new Error(credential)
  } })
  await assert.rejects(f.run({ signal: controller.signal }), error => error.code === 'analysis_cancelled' && !error.message.includes(credential))
  assert.equal(f.calls.length, 1)
  assert.deepEqual(await readdir(f.args.tempRoot), [])
})

test('media preparation failures are sanitized and remove their temporary directory', async t => {
  const f = await fixture(t, { mode: 'audio', processImpl: () => { throw new Error(`cannot read ${credential} C:\\private\\source.mp4`) } })
  await assert.rejects(f.run(), error => error.code === 'poe_media_preparation' && !error.message.includes(credential) && !error.message.includes('private'))
  assert.equal(f.calls.length, 0)
  assert.deepEqual(await readdir(f.args.tempRoot), [])
})

test('untrusted API addresses, unsupported models, absent provider and invalid keys fail before media work', async t => {
  const f = await fixture(t, { mode: 'audio' })
  for (const bad of [
    { POE_BASE_URL: 'https://evil.invalid/v1' },
    { POE_BASE_URL: 'http://api.poe.com/v1' },
    { POE_BASE_URL: 'https://api.poe.com/v1?key=private' },
    { SPUR_VIDEO_ANALYSIS_POE_MODEL: 'another-bot' },
    { SPUR_VIDEO_ANALYSIS_POE_MODEL: 'Gemini-4-Argon' },
    { SPUR_VIDEO_ANALYSIS_PROVIDER: 'siliconflow' },
    { POE_API_KEY: '' },
    { POE_API_KEY: 'malformed\r\nkey' },
  ]) await assert.rejects(f.run({ config: { ...config, ...bad } }), error => error.code === 'poe_configuration')
  assert.equal(f.calls.length, 0)
  assert.equal(f.processes.length, 0)
})

test('duration caps, invalid mode, empty media and pre-cancellation make no paid calls', async t => {
  const f = await fixture(t)
  await assert.rejects(f.run({ measurement: { ...f.args.measurement, analyzedDurationSeconds: 301 } }), /five minutes/i)
  await assert.rejects(f.run({ mode: 'unknown' }), /Choose both/)
  await assert.rejects(f.run({ signal: AbortSignal.abort() }), error => error.code === 'analysis_cancelled')
  await writeFile(f.args.filePath, Buffer.alloc(0))
  await assert.rejects(f.run(), error => error.code === 'poe_media_limit')
  assert.equal(f.calls.length, 0)
  assert.equal(f.processes.length, 0)
})

test('redirects and oversized provider responses fail without being parsed as observations', async t => {
  for (const fetchImpl of [
    () => new Response('private error', { status: 302, headers: { location: 'https://evil.invalid' } }),
    () => new Response('{}', { headers: { 'content-length': String(3 * 1024 ** 2) } }),
  ]) {
    const f = await fixture(t, { fetchImpl })
    await assert.rejects(f.run(), error => error.code === 'poe_analysis_failed')
    assert.equal(f.calls.length, 1)
  }
})
