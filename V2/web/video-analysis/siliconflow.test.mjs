import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { analyzeSiliconFlow, siliconFlowCapability, siliconFlowConfigured } from './siliconflow.mjs'
import { scriptTemplatePrompt } from './script-templates.mjs'

const credential = 'synthetic-test-credential'
const sourceVideoBytes = Buffer.from('original complete MP4 bytes, without resizing, splitting or frame extraction')
const sourceAudioBytes = Buffer.from('complete source audio track fixture')
const config = { SPUR_VIDEO_ANALYSIS_PROVIDER: 'siliconflow', SILICONFLOW_API_KEY: credential, SILICONFLOW_BASE_URL: 'https://api.siliconflow.cn/v1' }
const observed = (duration = 15, label = 'A hand clips a knife to a sign.') => ({
  summary: 'POV community scavenger hunt.', language: 'en',
  shots: [{ startSeconds: 0, endSeconds: duration, visual: label, framing: 'Close-up', action: 'Clips a knife', cameraMovement: 'Handheld POV', secret: 'drop me' }],
  onScreenText: [{ startSeconds: 0, endSeconds: duration, text: 'WHEN YOUR MARKETING BUDGET IS $0' }],
  transcript: [{ startSeconds: 0.2, endSeconds: Math.min(2, duration), text: 'Come grab it.' }],
  audio: { description: 'A low beat accompanies speech and a metallic click.', segments: [{ startSeconds: 0, endSeconds: duration, description: 'Quiet instrumental music beneath a male voice.' }], events: [{ startSeconds: 0.5, endSeconds: Math.min(0.8, duration), label: 'Metallic click', category: 'sfx', description: 'A blade flicks open.' }] },
})
const response = (value, options = {}) => new Response(JSON.stringify({ choices: [{ message: { content: typeof value === 'string' ? value : JSON.stringify(value) }, finish_reason: options.finishReason || 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, completion_tokens_details: { reasoning_tokens: 5 } } }), { status: 200, headers: { 'content-type': 'application/json' } })

async function fixture(t, { duration = 15, hasAudio = true, mode = 'both', fetchImpl, processImpl, extraConfig = {} } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'spur-sf-test-'))
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  const tempRoot = path.join(root, 'prepared')
  await mkdir(tempRoot)
  const calls = [], processes = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body)
    calls.push({ url, options, body })
    return fetchImpl ? fetchImpl(url, options, calls.length, body) : response(observed(duration))
  })
  const measurement = { status: 'analyzed', analyzedDurationSeconds: duration, metadata: { durationSeconds: duration, hasVideo: true, hasAudio, width: 1080, height: 1920, fps: 30 }, sections: [{ index: 0, startSeconds: 0, endSeconds: duration }], audio: { status: hasAudio ? 'analyzed' : 'no_audio', windows: hasAudio ? [{ startSeconds: 0, endSeconds: duration, rmsDb: -24 }] : [], limitations: [] } }
  const filePath = path.join(root, 'private-source.mp4')
  await writeFile(filePath, sourceVideoBytes)
  const runProcess = async (command, args, options) => {
    processes.push({ command, args, options })
    let output
    if (processImpl) output = await processImpl(command, args, options)
    else {
      assert.notEqual(args.at(-1), 'pipe:1', 'native video analysis must not extract reference images')
      await writeFile(args.at(-1), sourceAudioBytes)
    }
    return output || { stdout: Buffer.alloc(0), stderr: '' }
  }
  const args = { filePath, mode, config: { ...config, ...extraConfig }, measurement, runProcess, tempRoot, ffmpegPath: 'ffmpeg-test' }
  return { root, calls, processes, args, run: extra => analyzeSiliconFlow({ ...args, ...extra }) }
}

test('provider is explicit and capability contains sanitized model metadata only', () => {
  assert.equal(siliconFlowConfigured({ SILICONFLOW_API_KEY: credential }), false)
  assert.equal(siliconFlowConfigured(config), true)
  assert.equal(siliconFlowConfigured({ SPUR_VIDEO_ANALYSIS_PROVIDER: 'SiliconFlow' }), false)
  assert.equal(siliconFlowCapability(config).available, true)
  assert.equal(siliconFlowCapability({}).configured, false)
  assert.equal(siliconFlowCapability({ ...config, SILICONFLOW_BASE_URL: 'http://insecure.test' }).available, false)
  assert.doesNotMatch(JSON.stringify(siliconFlowCapability(config)), new RegExp(credential))
})

test('sends the complete original video and full audio together without local visual extraction', async t => {
  const duration = 26.700091
  const f = await fixture(t, { duration })
  const result = await f.run()
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].url, 'https://api.siliconflow.cn/v1/chat/completions')
  assert.equal(f.calls[0].options.redirect, 'error')
  assert.equal(f.calls[0].options.headers.authorization, `Bearer ${credential}`)
  const parts = f.calls[0].body.messages[0].content
  assert.deepEqual(parts.map(value => value.type), ['video_url', 'audio_url', 'text'])
  assert.deepEqual({ ...parts[0].video_url, url: 'omitted' }, { url: 'omitted', detail: 'auto', fps: 2, max_frames: 128 })
  assert.match(parts[0].video_url.url, /^data:video\/mp4;base64,/)
  assert.match(parts[1].audio_url.url, /^data:audio\/wav;base64,/)
  assert.deepEqual(Buffer.from(parts[0].video_url.url.split(',')[1], 'base64'), sourceVideoBytes)
  assert.deepEqual(Buffer.from(parts[1].audio_url.url.split(',')[1], 'base64'), sourceAudioBytes)
  assert.deepEqual(await readFile(f.args.filePath), sourceVideoBytes)
  assert.equal(f.calls[0].body.response_format, undefined)
  assert.equal(f.calls[0].body.max_tokens, 8192)
  assert.match(parts.at(-1).text, /26\.7/)
  assert.equal(result.status, 'complete')
  assert.equal(result.script.text, 'Come grab it.')
  assert.equal('words' in result.script, false)
  assert.equal('secret' in result.shots[0], false)
  assert.equal(result.shots[0].spokenText, 'Come grab it.')
  assert.match(result.audio.semanticDescription, /metallic click/)
  assert.match(result.audio.semanticSegments[0].description, /instrumental/)
  assert.match(result.audio.measurementDescription, /measured/i)
  assert.equal(result.provenance.multimodal.inputMode, 'video_and_audio')
  assert.equal(result.provenance.multimodal.mediaTransport, 'original_video')
  assert.equal('sampledFrameCount' in result.provenance.vision, false)
  assert.deepEqual(result.provenance.multimodal.usage, { promptTokens: 100, completionTokens: 50, totalTokens: 150, reasoningTokens: 5 })
  assert.equal(f.processes.length, 1, 'only the complete audio track is prepared locally')
  const args = f.processes[0].args
  assert.ok(args.includes('16000'))
  assert.ok(args.includes('-vn'))
  assert.equal(args[args.indexOf('-map') + 1], '0:a:0')
  assert.equal(args[args.indexOf('-i') + 1], f.args.filePath)
  assert.equal(args.includes('-ss'), false)
  assert.equal(args.includes('-vf'), false)
  assert.equal(args.includes('libx264'), false)
  assert.equal(args.includes('image2pipe'), false)
  if (args.includes('-t')) assert.ok(Math.abs(Number(args[args.indexOf('-t') + 1]) - duration) < 0.001)
  assert.deepEqual(await readdir(f.args.tempRoot), [])
})

test('Omni Thinking uses plain final JSON because SiliconFlow rejects forced JSON mode', async t => {
  const f = await fixture(t, { extraConfig: { SPUR_VIDEO_ANALYSIS_CLOUD_MODEL: 'Qwen/Qwen3-Omni-30B-A3B-Thinking' } })
  const result = await f.run()
  assert.equal(f.calls[0].body.response_format, undefined)
  assert.equal(f.calls[0].body.max_tokens, 16384)
  assert.equal(f.calls[0].body.temperature, 0.6)
  assert.equal(result.provenance.multimodal.model, 'Qwen/Qwen3-Omni-30B-A3B-Thinking')
  assert.equal(result.status, 'complete')
})

test('whole-video timestamps retain the original chronology without synthetic chunk offsets', async t => {
  const raw = observed(32)
  raw.shots = [{ startSeconds: 0, endSeconds: 16.25, visual: 'The opening action' }, { startSeconds: 16.25, endSeconds: 32, visual: 'The ending action' }]
  raw.transcript = [{ startSeconds: 15.2, endSeconds: 17.1, text: 'Speech crosses the old chunk boundary.' }]
  raw.audio.events = [{ startSeconds: 30.5, endSeconds: 31.1, label: 'Click', category: 'sfx' }]
  const f = await fixture(t, { duration: 32, fetchImpl: () => response(raw) })
  const result = await f.run()
  assert.equal(f.calls.length, 1)
  assert.deepEqual(result.shots.map(value => [value.startSeconds, value.endSeconds]), [[0, 16.25], [16.25, 32]])
  assert.deepEqual(result.script.segments.map(value => [value.startSeconds, value.endSeconds]), [[15.2, 17.1]])
  assert.deepEqual(result.script.onScreenText.map(value => value.endSeconds), [32])
  assert.deepEqual(result.audio.semanticEvents.map(value => value.startSeconds), [30.5])
  assert.equal(result.provenance.multimodal.chunkCount, 1)
  assert.equal(result.provenance.multimodal.successfulChunks, 1)
  assert.deepEqual(result.provenance.multimodal.coverage, [{ startSeconds: 0, endSeconds: 32, status: 'analyzed' }])
  assert.equal(result.provenance.multimodal.usage.totalTokens, 150)
  assert.equal(f.processes.length, 1)
  assert.equal(result.warnings.some(value => /consecutive intervals|interval boundary/.test(value)), false)
  assert.deepEqual(await readdir(f.args.tempRoot), [])
})

test('SiliconFlow forwards the selected workbook lens and retains interpretation without replacing transcript or captions', async t => {
  const raw = observed()
  Object.assign(raw.shots[0], { location: 'Beside a visible sign', effects: 'No visible transition', notes: 'The action stays within the close-up.' })
  raw.scriptStructure = {
    templateId: 'xc-1', summary: 'An invitation opens the product action.',
    stages: [{ stageId: 'hook', startSeconds: 0, endSeconds: 2, interpretation: 'The short invitation gives the opening a direct call.', evidence: [{ source: 'speech', ...raw.transcript[0] }] }],
  }
  const f = await fixture(t, { fetchImpl: () => response(raw) })
  const result = await f.run({ scriptTemplateId: 'xc-1' })
  assert.ok(f.calls[0].body.messages[0].content.at(-1).text.includes(scriptTemplatePrompt('xc-1')))
  assert.equal(result.scriptStructure.templateId, 'xc-1')
  assert.equal(result.scriptStructure.stages[0].stageId, 'hook')
  assert.deepEqual(result.script.segments, raw.transcript)
  assert.deepEqual(result.script.onScreenText.map(({ evidence, ...value }) => value), raw.onScreenText)
  assert.equal(result.script.scriptStructure, undefined)
  assert.equal(result.shots[0].location, 'Beside a visible sign')
  assert.equal(result.shots[0].effects, 'No visible transition')
  assert.equal(result.shots[0].notes, 'The action stays within the close-up.')
  assert.equal(f.calls.length, 1, 'structure interpretation does not issue an extra paid request')
})

test('SiliconFlow defaults to production columns without narrative matching or altered source wording', async t => {
  const raw = observed()
  raw.scriptStructure = {
    templateId: 'xc-1', summary: 'An unsolicited sales interpretation.',
    stages: [{ stageId: 'hook', startSeconds: 0, endSeconds: 2, interpretation: 'A proposed sales hook.', evidence: [{ source: 'speech', ...raw.transcript[0] }] }],
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

test('invalid whole-video output fails once without splitting, retrying or inventing observations', async t => {
  const f = await fixture(t, { duration: 32, fetchImpl: () => response('invalid JSON') })
  await assert.rejects(f.run(), /invalid.*JSON/i)
  assert.equal(f.calls.length, 1, 'paid calls are never retried')
  assert.equal(f.processes.length, 1)
  assert.deepEqual(await readdir(f.args.tempRoot), [])
})

test('invalid times and unknown fields are discarded rather than coerced or clamped', async t => {
  const raw = observed()
  raw.shots.push({ startSeconds: '2', endSeconds: 3, visual: 'String timestamp' }, { startSeconds: -1, endSeconds: 3, visual: 'Negative' }, { startSeconds: 14, endSeconds: 16, visual: 'Beyond interval' })
  raw.transcript.push({ startSeconds: 4, endSeconds: 4, text: 'Zero duration' })
  raw.arbitrary = credential
  const f = await fixture(t, { fetchImpl: () => response(raw) })
  const result = await f.run()
  assert.equal(result.status, 'partial')
  assert.equal(result.shots.length, 1)
  assert.equal(result.script.segments.length, 1)
  assert.equal('arbitrary' in result, false)
})

test('audio-only mode sends no video and never invents visual observations', async t => {
  const f = await fixture(t, { mode: 'audio' })
  const result = await f.run()
  assert.deepEqual(f.calls[0].body.messages[0].content.map(value => value.type), ['audio_url', 'text'])
  assert.equal(f.processes.length, 1)
  assert.deepEqual(result.shots, [])
  assert.deepEqual(result.script.onScreenText, [])
  assert.equal(result.provenance.vision.status, 'not_requested')
  assert.equal(result.provenance.multimodal.inputMode, 'audio')
})

test('no-audio video drops model hallucinated speech and sounds', async t => {
  const f = await fixture(t, { hasAudio: false })
  const result = await f.run()
  assert.deepEqual(f.calls[0].body.messages[0].content.map(value => value.type), ['video_url', 'text'])
  assert.equal(f.processes.length, 0, 'a silent original video requires no media extraction')
  assert.deepEqual(Buffer.from(f.calls[0].body.messages[0].content[0].video_url.url.split(',')[1], 'base64'), sourceVideoBytes)
  assert.equal(result.script.text, '')
  assert.deepEqual(result.audio.semanticEvents, [])
  assert.equal(result.audio.semanticDescription, '')
  assert.equal(result.provenance.speech.status, 'no_audio')
  assert.equal(result.provenance.multimodal.inputMode, 'video')
})

test('no-audio audio mode returns measured no-audio without paid requests', async t => {
  const f = await fixture(t, { hasAudio: false, mode: 'audio' })
  const result = await f.run()
  assert.equal(f.calls.length, 0)
  assert.equal(f.processes.length, 0)
  assert.equal(result.audio.status, 'no_audio')
  assert.equal(result.status, 'complete')
})

test('breakdown does not transcribe speech but keeps actual semantic audio', async t => {
  const f = await fixture(t, { mode: 'breakdown' })
  const result = await f.run()
  assert.equal(result.script.text, '')
  assert.equal(result.provenance.speech.status, 'not_requested')
  assert.equal(result.audio.semanticEvents.length, 1)
})

test('authentication and rate-limit failures stop immediately and redact provider errors', async t => {
  for (const status of [401, 403, 429]) {
    const f = await fixture(t, { duration: 32, fetchImpl: () => new Response(`${credential} private-source.mp4`, { status }) })
    await assert.rejects(f.run(), error => error.status === status && !error.message.includes(credential) && !error.message.includes('private-source'))
    assert.equal(f.calls.length, 1)
    assert.deepEqual(await readdir(f.args.tempRoot), [])
  }
})

test('all provider errors fail explicitly without local substitution or raw errors', async t => {
  const f = await fixture(t, { fetchImpl: () => { throw new Error(`${credential} C:\\private\\video.mp4`) } })
  await assert.rejects(f.run(), error => /no local replacement/i.test(error.message) && !error.message.includes(credential) && !error.message.includes('private'))
  assert.equal(f.calls.length, 1)
  assert.deepEqual(await readdir(f.args.tempRoot), [])
})

test('cancellation aborts request and cleans all temporary media', async t => {
  const controller = new AbortController()
  const f = await fixture(t, { fetchImpl: async (url, options) => {
    controller.abort()
    assert.equal(options.signal.aborted, true)
    throw new Error(credential)
  } })
  await assert.rejects(f.run({ signal: controller.signal }), error => error.code === 'analysis_cancelled' && !error.message.includes(credential))
  assert.deepEqual(await readdir(f.args.tempRoot), [])
})

test('unsafe API addresses and absent explicit provider are rejected before media or API work', async t => {
  const f = await fixture(t)
  for (const base of ['http://api.test/v1', 'https://user:pass@api.test/v1', 'https://api.test/v1?key=private', 'https://api.test/v1#private', 'not a URL']) {
    await assert.rejects(f.run({ config: { ...config, SILICONFLOW_BASE_URL: base } }), error => error.code === 'siliconflow_configuration' && !error.message.includes(base))
  }
  await assert.rejects(f.run({ config: { SILICONFLOW_API_KEY: credential } }), /Explicitly select/)
  assert.equal(f.calls.length, 0)
  assert.equal(f.processes.length, 0)
})

test('malformed output, oversized responses and redirects cannot become observations', async t => {
  for (const makeResponse of [() => response('{}'), () => new Response('private', { status: 302, headers: { location: 'https://elsewhere.test' } }), () => new Response('{}', { status: 200, headers: { 'content-length': String(3 * 1024 ** 2) } })]) {
    const f = await fixture(t, { fetchImpl: makeResponse })
    await assert.rejects(f.run(), /no local replacement/i)
    assert.equal(f.calls.length, 1)
    assert.deepEqual(await readdir(f.args.tempRoot), [])
  }
})

test('unexpected credential and source-path echoes are redacted from persisted results', async t => {
  let sourcePath
  const f = await fixture(t, { fetchImpl: () => response(observed(15, `${credential} ${sourcePath}`)) })
  sourcePath = f.args.filePath
  const result = await f.run()
  assert.doesNotMatch(JSON.stringify(result), new RegExp(credential))
  assert.equal(JSON.stringify(result).includes(sourcePath), false)
  assert.match(result.shots[0].visual, /\[redacted\]/)
})

test('duration cap and cancelled jobs perform no media work or paid calls', async t => {
  const f = await fixture(t, { duration: 301 })
  await assert.rejects(f.run(), /5 minutes/)
  await assert.rejects(f.run({ signal: AbortSignal.abort() }), /cancelled/i)
  assert.equal(f.calls.length, 0)
  assert.equal(f.processes.length, 0)
})

test('overlapping shots are excluded and uncovered visual intervals mark partial coverage', async t => {
  const raw = observed()
  raw.shots = [{ startSeconds: 1, endSeconds: 5, visual: 'First observed shot' }, { startSeconds: 4, endSeconds: 6, visual: 'Invalid overlapping shot' }, { startSeconds: 8, endSeconds: 14, visual: 'Later observed shot' }]
  const f = await fixture(t, { fetchImpl: () => response(raw) })
  const result = await f.run()
  assert.equal(result.status, 'partial')
  assert.deepEqual(result.shots.map(shot => [shot.startSeconds, shot.endSeconds]), [[1, 5], [8, 14]])
})

test('missing audio or transcript fields do not report complete multimodal success', async t => {
  const raw = observed()
  delete raw.audio
  delete raw.transcript
  const f = await fixture(t, { fetchImpl: () => response(raw) })
  const result = await f.run()
  assert.equal(result.status, 'partial')
  assert.equal(result.shots.length, 1)
  assert.equal(result.script.text, '')
  assert.equal(result.audio.semanticDescription, '')
})

test('unsupported model rejection preserves safe HTTP status and never retries', async t => {
  const f = await fixture(t, { fetchImpl: () => new Response(JSON.stringify({ error: credential }), { status: 400 }) })
  await assert.rejects(f.run(), error => error.status === 400 && /configured model supports/.test(error.message) && !error.message.includes(credential))
  assert.equal(f.calls.length, 1)
})

test('media preparation errors are sanitized and do not send incomplete paid requests', async t => {
  const f = await fixture(t, { processImpl: () => { throw new Error(`Cannot read C:\\private\\file.mp4 ${credential}`) } })
  await assert.rejects(f.run(), error => error.status === 422 && !error.message.includes('private') && !error.message.includes(credential))
  assert.equal(f.calls.length, 0)
  assert.deepEqual(await readdir(f.args.tempRoot), [])
})

test('prompt asks for full chronology without concrete example timestamps or filled placeholders', async t => {
  const f = await fixture(t, { duration: 14.836 })
  await f.run()
  const prompt = f.calls[0].body.messages[0].content.find(part => part.type === 'text').text
  assert.match(prompt, /ENTIRE clip/)
  assert.match(prompt, /14\.836/)
  assert.match(prompt, /whole supplied clip interval/)
  assert.match(prompt, /persistent caption should retain its full visible extent/)
  assert.doesNotMatch(prompt, /observed content and format|observed composition|"startSeconds"\s*:\s*0|"endSeconds"\s*:\s*1/)
})

test('literal placeholder summaries are removed and flagged without deleting real matching phrases', async t => {
  const raw = observed()
  raw.summary = 'observed content and format'
  const f = await fixture(t, { fetchImpl: () => response(raw) })
  const result = await f.run()
  assert.equal(result.status, 'partial')
  assert.notEqual(result.summary, raw.summary)
  assert.ok(result.warnings.some(warning => /schema placeholder/.test(warning)))
  raw.summary = 'The speaker discusses observed content and format in a media analysis lesson.'
  const legitimate = await f.run()
  assert.equal(legitimate.summary, raw.summary)
  assert.equal(legitimate.status, 'complete')
})

test('incomplete visual chronology identifies coverage gaps in warnings', async t => {
  const raw = observed()
  raw.shots = [{ startSeconds: 2, endSeconds: 4, visual: 'A visible action in the middle of the clip.' }]
  const f = await fixture(t, { fetchImpl: () => response(raw) })
  const result = await f.run()
  assert.equal(result.status, 'partial')
  assert.ok(result.warnings.some(warning => /uncovered gaps/.test(warning) && /end of the clip/.test(warning)))
})

test('stale visual-model settings cannot replace whole-video input with frame images', async t => {
  for (const legacyModel of ['deepseek-ai/DeepSeek-V4.1-Flash', 'invalid legacy setting']) {
    const f = await fixture(t, { duration: 26.700091, extraConfig: { SPUR_VIDEO_ANALYSIS_VISION_MODEL: legacyModel, SPUR_VIDEO_ANALYSIS_TRANSCRIPT_CONTEXT: '1' } })
    const result = await f.run()
    assert.equal(siliconFlowCapability(f.args.config).available, true)
    assert.equal(siliconFlowCapability(f.args.config).visionModel, undefined)
    assert.equal(f.calls.length, 1)
    assert.deepEqual(f.calls[0].body.messages[0].content.map(value => value.type), ['video_url', 'audio_url', 'text'])
    assert.equal(result.provenance.multimodal.inputMode, 'video_and_audio')
    assert.equal(result.provenance.multimodal.visionModel, undefined)
    assert.equal(result.provenance.vision.model, f.calls[0].body.model)
    assert.equal(result.provenance.vision.method, 'multimodal_video_understanding')
    assert.equal(result.provenance.vision.observedFrameCount, undefined)
    assert.equal(result.provenance.vision.observedAtSeconds, undefined)
    assert.equal(result.provenance.multimodal.usage.totalTokens, 150)
    assert.deepEqual(Object.keys(result.provenance.multimodal.usageByModel), [f.calls[0].body.model])
    assert.equal(result.script.text, 'Come grab it.')
    assert.match(result.audio.semanticDescription, /metallic click/)
    assert.equal(result.shots[0].visual, observed().shots[0].visual)
    assert.equal(result.status, 'complete')
    assert.equal(f.processes.length, 1)
    assert.deepEqual(await readdir(f.args.tempRoot), [])
  }
})

test('silent video still uses the native model when a legacy visual model is configured', async t => {
  const f = await fixture(t, { hasAudio: false, extraConfig: { SPUR_VIDEO_ANALYSIS_VISION_MODEL: 'deepseek-ai/DeepSeek-V4.1-Flash' } })
  const result = await f.run()
  assert.equal(f.calls.length, 1)
  assert.notEqual(f.calls[0].body.model, f.args.config.SPUR_VIDEO_ANALYSIS_VISION_MODEL)
  assert.deepEqual(f.calls[0].body.messages[0].content.map(value => value.type), ['video_url', 'text'])
  assert.equal(f.processes.length, 0)
  assert.equal(result.provenance.multimodal.inputMode, 'video')
  assert.equal(result.script.text, '')
  assert.equal(result.audio.semanticEvents.length, 0)
  assert.equal(result.provenance.speech.status, 'no_audio')
  assert.equal(result.status, 'complete')
})

test('script and breakdown modes use the same whole video while preserving their output contracts', async t => {
  for (const mode of ['script', 'breakdown']) {
    const f = await fixture(t, { mode, duration: 26.700091, extraConfig: { SPUR_VIDEO_ANALYSIS_VISION_MODEL: 'deepseek-ai/DeepSeek-V4.1-Flash' } })
    const result = await f.run()
    if (mode === 'script') { assert.deepEqual(result.shots, []); assert.equal(result.script.text, 'Come grab it.') }
    else { assert.equal(result.shots.length, 1); assert.equal(result.script.text, ''); assert.equal(result.provenance.speech.status, 'not_requested'); assert.match(f.calls[0].body.messages[0].content.at(-1).text, /TRANSCRIPTION DISABLED/i) }
    assert.equal(f.calls.length, 1)
    assert.deepEqual(f.calls[0].body.messages[0].content.map(value => value.type), ['video_url', 'audio_url', 'text'])
    assert.equal(result.script.onScreenText[0].text, observed().onScreenText[0].text)
  }
})

test('audio-only requests ignore optional visual verifier configuration', async t => {
  const f = await fixture(t, { mode: 'audio', duration: 26.700091, extraConfig: { SPUR_VIDEO_ANALYSIS_VISION_MODEL: 'deepseek-ai/DeepSeek-V4.1-Flash' } })
  const result = await f.run()
  assert.equal(f.calls.length, 1)
  assert.deepEqual(f.calls[0].body.messages[0].content.map(value => value.type), ['audio_url', 'text'])
  assert.equal(result.provenance.multimodal.inputMode, 'audio')
  assert.equal(result.provenance.multimodal.visionModel, undefined)
})
