import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { prepareFacePhoto, extractFaceCandidates, normalizeFaceCandidates } from './facecap-media.mjs'
import { runReaProcess } from './rea-video.mjs'

// Fixed SOF dimensions are meaningful here: the boundary must match metadata to JPEG bytes.
const jpeg = (width = 100, height = 120, padding = 0) => {
  const header = Buffer.from([255, 216, 255, 192, 0, 17, 8, 0, 0, 0, 0, 3, 1, 17, 0, 2, 17, 0, 3, 17, 0])
  header.writeUInt16BE(height, 7); header.writeUInt16BE(width, 9)
  return Buffer.concat([header, Buffer.alloc(padding), Buffer.from([255, 217])]).toString('base64')
}
const candidate = overrides => ({ imageBase64: jpeg(), contextBase64: jpeg(500, 600), width: 100, height: 120, contextWidth: 500, contextHeight: 600, sourceTimeSeconds: null, cropBox: { x: .1, y: .1, width: .3, height: .5 }, detection: 'face', quality: { sharpness: 45.2, brightness: .52 }, ...overrides })
const report = overrides => ({ schemaVersion: 1, networkEnabled: false, candidates: [candidate()], warnings: ['Generic face detection only; choose the intended reference manually.'], ...overrides })

async function fixture(t) {
  const root = await mkdtemp(path.join(process.cwd(), '.facecap-media-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const photo = path.join(root, 'portrait & $(not-a-command).png'), video = path.join(root, 'video & $(not-a-command).mp4')
  await writeFile(photo, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]))
  await writeFile(video, 'video fixture')
  const tempRoot = path.join(root, 'work')
  return { root, filePath: photo, video, tempRoot, config: { SPUR_REA_VIDEO_PYTHON: process.execPath, SPUR_FFMPEG_BIN: process.execPath, SPUR_FFPROBE_BIN: process.execPath, POE_API_KEY: 'synthetic-key-not-for-child', SILICONFLOW_API_KEY: 'synthetic-key-not-for-child' } }
}

test('candidate contract retains only bounded crop, context and generic detection measurements', () => {
  const raw = report({ candidates: [candidate({ privatePath: 'C:/private/photo.png', identity: 'Not a recognition result' })], provider: 'injected' })
  const value = normalizeFaceCandidates(raw, { mode: 'photo' })
  assert.equal(value.candidates.length, 1)
  assert.deepEqual(value.candidates[0].cropBox, { x: .1, y: .1, width: .3, height: .5 })
  assert.equal(value.candidates[0].privatePath, undefined); assert.equal(value.candidates[0].identity, undefined)
  assert.equal(value.provider, undefined)
  assert.doesNotMatch(JSON.stringify(value), /C:\/private|recognition result/)
  assert.equal(normalizeFaceCandidates(report({ candidates: [candidate({ detection: 'manual', cropBox: { x: 0, y: 0, width: 1, height: 1 } })] }), { mode: 'photo' }).candidates[0].detection, 'manual')
})

test('candidate contract rejects identity claims, invalid bounds, dimensions and timestamps', () => {
  for (const overrides of [
    { detection: 'identified' }, { quality: { sharpness: NaN, brightness: .5 } }, { quality: { sharpness: 1, brightness: 1.1 } },
    { cropBox: { x: -.1, y: 0, width: .5, height: .5 } }, { cropBox: { x: .7, y: 0, width: .5, height: .5 } },
    { cropBox: { x: 0, y: 0, width: 0, height: 1 } }, { width: 101 }, { contextHeight: 961 }, { sourceTimeSeconds: 1 },
    { imageBase64: '<script>not an image</script>' }, { imageBase64: jpeg() + '\n' }, { imageBase64: jpeg(769, 100), width: 769, height: 100 },
  ]) assert.throws(() => normalizeFaceCandidates(report({ candidates: [candidate(overrides)] }), { mode: 'photo' }), { code: 'facecap_media_output' })
  for (const sourceTimeSeconds of [null, -1, 23, NaN, '1']) assert.throws(() => normalizeFaceCandidates(report({ candidates: [candidate({ sourceTimeSeconds })] }), { mode: 'video', durationSeconds: 22.8 }), { code: 'facecap_media_output' })
  assert.equal(normalizeFaceCandidates(report({ candidates: [candidate({ sourceTimeSeconds: 21.4 })] }), { mode: 'video', durationSeconds: 22.8 }).candidates[0].sourceTimeSeconds, 21.4)
})

test('candidate transport caps aggregate images and rejects malformed reports without path leaks', () => {
  for (const raw of [null, report({ schemaVersion: 2 }), report({ networkEnabled: true }), report({ candidates: [] }), report({ candidates: Array.from({ length: 13 }, () => candidate()) }), report({ warnings: ['C:/Users/private/photo.png'] }), report({ warnings: [{}] })]) assert.throws(() => normalizeFaceCandidates(raw, { mode: 'photo' }), { code: 'facecap_media_output' })
  assert.throws(() => normalizeFaceCandidates(report({ candidates: Array.from({ length: 6 }, () => candidate({ imageBase64: jpeg(100, 120, 100000), contextBase64: jpeg(500, 600, 100000) })) }), { mode: 'photo' }), { code: 'facecap_media_output' })
})

test('photo subprocess uses fixed arguments and isolated credentials, then removes only its temporary child', async t => {
  const setup = await fixture(t)
  let invocation
  const value = await prepareFacePhoto({ ...setup, processRunner: async (command, args, options) => { invocation = { command, args, options }; await writeFile(path.join(options.cwd, 'temporary.jpg'), 'test'); return report() } })
  assert.equal(value.candidates.length, 1)
  assert.equal(invocation.command, process.execPath)
  assert.deepEqual(invocation.args.slice(-4), ['--mode', 'photo', '--input', setup.filePath])
  assert.equal(invocation.options.env.POE_API_KEY, undefined); assert.equal(invocation.options.env.SILICONFLOW_API_KEY, undefined)
  assert.equal(invocation.options.env.HOME, invocation.options.cwd)
  assert.equal(invocation.options.env.PYTHONNOUSERSITE, '1')
  assert.equal(invocation.options.timeoutMs, 45000)
  await assert.rejects(access(invocation.options.cwd)); assert.deepEqual(await readdir(setup.tempRoot), [])
  await access(setup.filePath)
})

test('video subprocess passes a numeric duration and only the fixed media tools', async t => {
  const setup = await fixture(t)
  let invocation
  const value = await extractFaceCandidates({ ...setup, filePath: setup.video, durationSeconds: 22.8, processRunner: async (command, args, options) => { invocation = { command, args, options }; return report({ candidates: [candidate({ sourceTimeSeconds: 14.25 })] }) } })
  assert.equal(value.candidates[0].sourceTimeSeconds, 14.25)
  assert.deepEqual(invocation.args.slice(-6), ['--duration', '22.8', '--ffmpeg', process.execPath, '--ffprobe', process.execPath])
  assert.equal(invocation.options.timeoutMs, 120000)
})

test('hostile local inputs and cancellation are rejected before process execution', async t => {
  const setup = await fixture(t)
  let calls = 0
  const processRunner = async () => { calls++; return report() }
  for (const filePath of ['https://example.invalid/portrait.png', setup.root, path.join(setup.root, 'missing.png')]) await assert.rejects(prepareFacePhoto({ ...setup, filePath, processRunner }), error => ['facecap_media_input', 'facecap_media_configuration'].includes(error.code))
  await writeFile(path.join(setup.root, 'injected.svg'), '<svg><script>bad</script></svg>')
  await assert.rejects(prepareFacePhoto({ ...setup, filePath: path.join(setup.root, 'injected.svg'), processRunner }), { code: 'facecap_media_input' })
  for (const durationSeconds of [undefined, 0, -1, 301, Infinity, '5;echo injected']) await assert.rejects(extractFaceCandidates({ ...setup, filePath: setup.video, durationSeconds, processRunner }), { code: 'facecap_media_invalid' })
  await assert.rejects(prepareFacePhoto({ ...setup, signal: AbortSignal.abort(), processRunner }), { code: 'analysis_cancelled', status: 499 })
  assert.equal(calls, 0)
})

test('output and subprocess failures are sanitized and still clean temporary images', async t => {
  const setup = await fixture(t)
  for (const processRunner of [async () => report({ candidates: [candidate({ width: 99 })] }), async () => { throw new Error(`EPERM ${setup.filePath} synthetic-private-key`) }]) {
    await assert.rejects(prepareFacePhoto({ ...setup, processRunner }), error => error.code.startsWith('facecap_') && !error.message.includes(setup.filePath) && !error.message.includes('private-key'))
    assert.deepEqual(await readdir(setup.tempRoot), [])
  }
  const value = await prepareFacePhoto({ ...setup, processRunner: (_command, _args, options) => runReaProcess(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(JSON.stringify(report()))})`], options) })
  assert.equal(value.candidates.length, 1)
})

test('Python worker is offline generic detection with clean bounded image encoding', async () => {
  const source = await readFile(new URL('./facecap-media.py', import.meta.url), 'utf8')
  for (const expected of ['socket.socket.connect = offline', 'socket.create_connection = offline', '"-protocol_whitelist", "file,pipe"', 'subprocess.CREATE_NO_WINDOW', 'haarcascade_frontalface_default.xml', 'haarcascade_profileface.xml', 'ImageOps.exif_transpose', '24_000_000', 'range(8)', 'candidates[:12]', '(1024 * 1024) // len(candidates)']) assert.ok(source.includes(expected), expected)
  assert.doesNotMatch(source, /face_recognition|insightface|embedding|cosine_similarity/)
})
