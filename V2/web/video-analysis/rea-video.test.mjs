import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { REA_VIDEO_REVISION, REA_VIDEO_UPSTREAM_REVISION, normalizeReaOutput, reaVideoCapability, runReaProcess } from './rea-video.mjs'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=', 'base64')
const image = (overrides = {}) => ({ id: 'storyboard', label: 'Storyboard', contentType: 'image/png', dataBase64: PNG.toString('base64'), ...overrides })

const report = (overrides = {}) => ({
  schemaVersion: 1,
  toolVersion: 'fixture-version',
  verdict: 'One continuous shot; measured motion and texture support a live-action estimate.',
  technicalShots: [{ startSeconds: 0, endSeconds: 5, label: 'live_action', confidence: 0.7, evidence: ['Measured optical flow.'] }],
  vlmStatus: 'not_requested',
  reviewStatus: 'unreviewed',
  ...overrides,
})

function fakeProcess(effect, { closeOnKill = true } = {}) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  const calls = [], kills = []
  child.kill = signal => {
    kills.push(signal)
    if (closeOnKill) queueMicrotask(() => child.emit('close', null))
    return closeOnKill
  }
  return {
    child, calls, kills,
    spawnProcess(command, args, options) {
      calls.push({ command, args, options })
      queueMicrotask(() => effect?.(child))
      return child
    },
  }
}

test('local capability requires absolute existing runtime/source and never reveals configuration', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'spur-rea-capability-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const source = path.join(directory, 'private-source-folder')
  await mkdir(path.join(source, 'rea_video'), { recursive: true })
  await writeFile(path.join(source, 'rea_video', 'pipeline.py'), '# fixture; never executed\n')
  const credential = 'synthetic-private-api-key'
  const config = { SPUR_REA_VIDEO_PYTHON: process.execPath, SPUR_REA_VIDEO_SOURCE: source, POE_API_KEY: credential }
  const capability = reaVideoCapability(config)
  assert.deepEqual(capability, { available: true, configured: true, provider: 'rea-video', model: null, inputMode: 'local_media', revision: REA_VIDEO_REVISION })
  for (const invalid of [{}, { ...config, SPUR_REA_VIDEO_PYTHON: 'relative-python' }, { ...config, SPUR_REA_VIDEO_SOURCE: 'relative-source' }, { ...config, SPUR_REA_VIDEO_SOURCE: path.join(source, 'missing') }]) {
    const value = reaVideoCapability(invalid)
    assert.equal(value.available, false)
    assert.doesNotMatch(JSON.stringify(value), new RegExp(credential))
    assert.ok(!JSON.stringify(value).includes(directory))
    assert.ok(!JSON.stringify(value).includes(process.execPath))
  }
  assert.ok(!JSON.stringify(capability).includes(source))
})

test('normalization keeps technical evidence but discards unreviewed semantic/provider extras', () => {
  const privatePath = 'C:\\private\\clip.mp4'
  const result = normalizeReaOutput(report({
    verdict: `Evidence from ${privatePath}\u0000`,
    technicalShots: [{ startSeconds: 0.0001, endSeconds: 5.01, label: 'unknown', confidence: null, evidence: [privatePath, '\u0001 measured contrast ', null, { text: 'not an allowed string' }] }],
    story: 'The pawn transforms into a king.',
    transcript: 'Invented dialogue',
    inversePrompt: 'Invented remake prompt',
    apiKey: 'private-token',
    reviewed: true,
  }), { duration: 5, redact: [privatePath] })
  assert.deepEqual(result.technicalShots, [{ index: 0, startSeconds: 0, endSeconds: 5, label: 'unknown', confidence: null, evidence: ['[local path]', 'measured contrast'] }])
  assert.equal(result.verdict, 'Evidence from [local path]')
  assert.equal(result.vlmStatus, 'not_requested')
  assert.equal(result.reviewStatus, 'unreviewed')
  assert.equal(result.workflowRevision, REA_VIDEO_REVISION)
  assert.ok(result.limitations.some(value => /story, object actions and payoff have not been interpreted/.test(value)))
  assert.ok(result.limitations.some(value => /heuristic estimates/.test(value)))
  assert.doesNotMatch(JSON.stringify(result), /Invented|private-token|The pawn|C:\\\\private|\u0000/)
  assert.equal('story' in result, false)
  assert.equal('transcript' in result, false)
  assert.equal('inversePrompt' in result, false)
})

test('normalization rejects unsupported schema, model/review claims and malformed durations', () => {
  const invalid = [null, {}, report({ schemaVersion: 2 }), report({ vlmStatus: 'complete' }), report({ reviewStatus: 'reviewed' }), report({ technicalShots: [] }), report({ technicalShots: [null] }), report({ technicalShots: Array.from({ length: 2001 }, () => ({})) }), report({ verdict: '' })]
  for (const value of invalid) assert.throws(() => normalizeReaOutput(value, { duration: 5 }), cause => cause.code === 'rea_video_failed' && cause.status === 422)
  for (const duration of [undefined, null, '5', 0, -1, Infinity, NaN, 300.01]) assert.throws(() => normalizeReaOutput(report(), { duration }))
})

test('normalization rejects invalid labels, confidence, timing and overlapping shots', () => {
  const shot = report().technicalShots[0]
  const invalid = [
    { startSeconds: -0.001 }, { startSeconds: '0' }, { startSeconds: NaN }, { endSeconds: Infinity },
    { endSeconds: 0 }, { endSeconds: 5.021 }, { label: 'verified_real' }, { confidence: -0.01 },
    { confidence: 1.01 }, { confidence: '0.7' }, { confidence: undefined }, { evidence: 'not a list' },
  ]
  for (const overrides of invalid) assert.throws(() => normalizeReaOutput(report({ technicalShots: [{ ...shot, ...overrides }] }), { duration: 5 }), cause => cause.code === 'rea_video_failed')
  assert.throws(() => normalizeReaOutput(report({ technicalShots: [{ ...shot, endSeconds: 3 }, { ...shot, startSeconds: 2.9 }] }), { duration: 5 }), /overlapping/)
  assert.throws(() => normalizeReaOutput(report({ technicalShots: [{ ...shot, startSeconds: 0.0001, endSeconds: 0.0002 }] }), { duration: 5 }), /invalid shot intervals/)
})

test('normalization caps retained report text and shot evidence', () => {
  const result = normalizeReaOutput(report({ toolVersion: 'v'.repeat(200), verdict: 'x'.repeat(7000), technicalShots: [{ ...report().technicalShots[0], evidence: Array.from({ length: 20 }, () => 'e'.repeat(600)) }] }), { duration: 5 })
  assert.equal(result.toolVersion.length, 80)
  assert.equal(result.verdict.length, 6000)
  assert.equal(result.technicalShots[0].evidence.length, 12)
  assert.ok(result.technicalShots[0].evidence.every(value => value.length === 500))
})

test('expanded reports preserve bounded native prose, remove frontmatter and redact private paths', () => {
  const result = normalizeReaOutput(report({
    sections: [{ id: 'look', title: 'Camera', body: '---\nvideomd: 1\npart: look\n---\n\nUnreviewed native estimate.\nC:\\Users\\someone\\private source\\clip.mp4\n/home/someone/private/clip.mp4\nhttps://example.test/native-docs' },
      { id: 'sound', title: 'Sound', body: '音'.repeat(16000) }],
    soundCandidates: [{ startSeconds: .1234, endSeconds: .9211, description: 'whoosh' }],
    assets: [image()], capabilities: [{ id: 'vision', status: 'available', detail: 'False model claim' }],
  }), { duration: 5 })
  assert.equal(result.sections.length, 2)
  assert.equal(result.sections[0].body.startsWith('Unreviewed native estimate.'), true)
  assert.doesNotMatch(result.sections[0].body, /videomd|someone|private source/)
  assert.match(result.sections[0].body, /\[local path\]/)
  assert.match(result.sections[0].body, /https:\/\/example\.test\/native-docs/)
  assert.ok(Buffer.byteLength(result.sections[1].body) <= 16000)
  assert.doesNotMatch(result.sections[1].body, /\uFFFD/)
  assert.deepEqual(result.soundCandidates, [{ startSeconds: .123, endSeconds: .921, description: 'whoosh' }])
  assert.deepEqual(result.assets, [image()])
  assert.equal(result.capabilities.find(value => value.id === 'vision').status, 'requires_model')
  assert.equal(result.capabilities.find(value => value.id === 'ocr').status, 'requires_download')
  assert.doesNotMatch(JSON.stringify(result), /False model claim/)
  assert.equal(REA_VIDEO_REVISION, `${REA_VIDEO_UPSTREAM_REVISION}:2`)
})

test('old compact reports remain supported without expanded optional fields', () => {
  const result = normalizeReaOutput(report(), { duration: 5 })
  assert.deepEqual(result.sections, [])
  assert.deepEqual(result.assets, [])
  assert.deepEqual(result.soundCandidates, [])
  assert.ok(result.capabilities.every(value => ['available', 'requires_model', 'requires_download', 'separate_workflow'].includes(value.status)))
})

test('sections reject arbitrary objects, duplicate IDs and excessive counts', () => {
  const section = { id: 'look', title: 'Camera', body: 'Unreviewed measured estimate.' }
  for (const sections of [null, {}, [null], [section, section], [{ ...section, id: 'script' }], [{ ...section, body: {} }], [{ ...section, title: '' }], [{ ...section, body: '' }], Array.from({ length: 8 }, () => section)]) {
    assert.throws(() => normalizeReaOutput(report({ sections }), { duration: 5 }), /report sections/)
  }
})

test('sound candidates reject unsupported semantic objects and invalid intervals', () => {
  const event = { startSeconds: 1, endSeconds: 2, description: 'native transient type' }
  for (const soundCandidates of [null, {}, [null], [{ ...event, startSeconds: -1 }], [{ ...event, endSeconds: 1 }], [{ ...event, endSeconds: 5.021 }], [{ ...event, endSeconds: Infinity }], [{ ...event, startSeconds: '1' }], [{ ...event, description: {} }], [{ ...event, description: '' }], [{ ...event, startSeconds: .0001, endSeconds: .0002 }], Array.from({ length: 61 }, () => event)]) {
    assert.throws(() => normalizeReaOutput(report({ soundCandidates }), { duration: 5 }), /sound candidates/)
  }
})

test('reference images require allowlisted names, canonical base64, image signatures and bounded sizes', () => {
  const malformed = Buffer.from(PNG)
  malformed[0] = 0
  const hugeDimensions = Buffer.from(PNG)
  hugeDimensions.writeUInt32BE(50000, 16)
  const oversized = Buffer.concat([PNG.subarray(0, PNG.length - 12), Buffer.alloc(256 * 1024), PNG.subarray(PNG.length - 12)])
  for (const assets of [null, {}, [null], [image(), image()], [image({ id: '../private' })], [image({ label: '' })], [image({ contentType: 'image/svg+xml' })], [image({ dataBase64: 'PHN2Zy8+' })], [image({ dataBase64: PNG.toString('base64') + '\n' })], [image({ dataBase64: malformed.toString('base64') })], [image({ dataBase64: hugeDimensions.toString('base64') })], [image({ dataBase64: oversized.toString('base64') })], [image({ contentType: 'image/jpeg', dataBase64: Buffer.from([255, 216, 255, 1, 2, 3, 4, 5, 6, 7, 255, 217]).toString('base64') })], Array.from({ length: 9 }, (_, index) => image({ id: `shot-${String(index + 1).padStart(3, '0')}` }))]) {
    assert.throws(() => normalizeReaOutput(report({ assets }), { duration: 5 }), /reference images/)
  }
  const padded = Buffer.concat([PNG.subarray(0, PNG.length - 12), Buffer.alloc(256 * 1024 - PNG.length), PNG.subarray(PNG.length - 12)])
  const bounded = Array.from({ length: 4 }, (_, index) => image({ id: `shot-${String(index + 1).padStart(3, '0')}`, dataBase64: padded.toString('base64') }))
  assert.equal(normalizeReaOutput(report({ assets: bounded }), { duration: 5 }).assets.length, 4)
  assert.throws(() => normalizeReaOutput(report({ assets: [...bounded, image()] }), { duration: 5 }), /reference images/)
})

test('subprocess uses argument arrays, hidden window and supplied isolated environment', async () => {
  const fixture = fakeProcess(child => {
    const json = Buffer.from(JSON.stringify(report()))
    child.stdout.emit('data', json.subarray(0, 23))
    child.stdout.emit('data', json.subarray(23))
    child.stderr.emit('data', Buffer.from('private diagnostic; never returned'))
    child.emit('close', 0)
  })
  const env = { PATH: 'isolated', PYTHONNOUSERSITE: '1' }
  const value = await runReaProcess('python', ['runner.py', '--video', 'a & b.mp4'], { env, cwd: 'work-dir', spawnProcess: fixture.spawnProcess })
  assert.deepEqual(value, report())
  assert.deepEqual(fixture.calls, [{ command: 'python', args: ['runner.py', '--video', 'a & b.mp4'], options: { env, cwd: 'work-dir', shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] } }])
  assert.equal(fixture.kills.length, 0)
})

test('subprocess sanitizes spawn, runtime and malformed JSON errors', async () => {
  const privateDiagnostic = 'C:\\private\\media.mp4 api-key=synthetic-secret'
  await assert.rejects(runReaProcess('python', [], { spawnProcess() { throw new Error(privateDiagnostic) } }), cause => cause.code === 'rea_video_runtime' && !cause.message.includes('private'))
  for (const effect of [
    child => child.emit('error', new Error(privateDiagnostic)),
    child => { child.stderr.emit('data', Buffer.from(privateDiagnostic)); child.emit('close', 1) },
    child => { child.stdout.emit('data', Buffer.from(privateDiagnostic)); child.emit('close', 0) },
  ]) {
    const fixture = fakeProcess(effect)
    await assert.rejects(runReaProcess('python', [], { spawnProcess: fixture.spawnProcess }), cause => ['rea_video_runtime', 'rea_video_failed'].includes(cause.code) && !cause.message.includes('private') && !cause.message.includes('synthetic-secret'))
  }
})

test('already-cancelled subprocess never starts; running cancellation kills and rejects', async () => {
  const skipped = fakeProcess()
  await assert.rejects(runReaProcess('python', [], { signal: AbortSignal.abort(), spawnProcess: skipped.spawnProcess }), cause => cause.code === 'analysis_cancelled' && cause.status === 499)
  assert.equal(skipped.calls.length, 0)
  const controller = new AbortController()
  const fixture = fakeProcess(() => controller.abort())
  await assert.rejects(runReaProcess('python', [], { signal: controller.signal, spawnProcess: fixture.spawnProcess }), cause => cause.code === 'analysis_cancelled' && cause.status === 499)
  assert.ok(fixture.kills.length > 0)
})

test('subprocess timeout and independent stdout/stderr bounds terminate work', async () => {
  const timedOut = fakeProcess()
  await assert.rejects(runReaProcess('python', [], { timeoutMs: 5, spawnProcess: timedOut.spawnProcess }), cause => cause.code === 'rea_video_timeout' && cause.status === 504)
  assert.ok(timedOut.kills.length > 0)
  for (const [stream, limit] of [['stdout', 2 * 1024 ** 2], ['stderr', 256 * 1024]]) {
    const fixture = fakeProcess(child => {
      child[stream].emit('data', Buffer.alloc(limit))
      child[stream].emit('data', Buffer.from('x'))
    })
    await assert.rejects(runReaProcess('python', [], { spawnProcess: fixture.spawnProcess }), cause => cause.code === 'rea_video_output_limit')
    assert.ok(fixture.kills.length > 0)
  }
})

test('subprocess eventually rejects even when termination never produces a close event', { timeout: 5000 }, async () => {
  const fixture = fakeProcess(undefined, { closeOnKill: false })
  await assert.rejects(runReaProcess('python', [], { timeoutMs: 5, spawnProcess: fixture.spawnProcess }), cause => cause.code === 'rea_video_timeout')
  assert.ok(fixture.kills.includes('SIGKILL'))
})

test('Python wrapper disables remote/model paths and leaves interpretation explicitly unreviewed', async () => {
  const source = await readFile(new URL('./rea-video-runner.py', import.meta.url), 'utf8')
  for (const expected of ['socket.socket.connect = offline', 'socket.socket.connect_ex = offline', 'socket.create_connection = offline', 'rea_video.util.fetch = offline', 'use_vlm=False', 'whole_vlm=False', 'ocr=False', 'stems=False', 'memory=False', 'asr=False', 'speakers=False', '"vlmStatus": "not_requested"', '"reviewStatus": "unreviewed"', '"networkEnabled": False', 'is_relative_to(source)', '"-protocol_whitelist", "file,pipe"']) assert.ok(source.includes(expected), expected)
})
