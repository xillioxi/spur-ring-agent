import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createReaFrameGrid } from './rea-frame-grid.mjs'
import { runReaProcess } from './rea-video.mjs'

// Only the JPEG envelope is needed to exercise the transport boundary here.
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 0x42), Buffer.from([0xff, 0xd9])])
const response = overrides => ({ schemaVersion: 1, contentType: 'image/jpeg', dataBase64: jpeg.toString('base64'), ...overrides })

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'spur-rea-frame-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const source = path.join(directory, 'source with & spaces')
  await mkdir(path.join(source, 'rea_video'), { recursive: true })
  await writeFile(path.join(source, 'rea_video', 'pipeline.py'), '# fixture')
  const filePath = path.join(directory, 'clip & $(do-not-execute).mp4')
  await writeFile(filePath, 'local video fixture')
  const tempRoot = path.join(directory, 'isolated work')
  return { directory, tempRoot, filePath, durationSeconds: 22.8, startSeconds: 14, endSeconds: 22, config: { SPUR_REA_VIDEO_PYTHON: process.execPath, SPUR_REA_VIDEO_SOURCE: source, SPUR_FFMPEG_BIN: process.execPath, SPUR_FFPROBE_BIN: process.execPath, POE_API_KEY: 'synthetic-private-provider-key' } }
}

test('frame range validation rejects hostile or unbounded input before starting work', async () => {
  let started = 0
  const base = { durationSeconds: 22.8, startSeconds: 14, endSeconds: 22, processRunner: async () => { started++; return response() } }
  for (const overrides of [{ durationSeconds: NaN }, { durationSeconds: 301 }, { durationSeconds: '22.8' }, { startSeconds: -1 }, { startSeconds: '14; echo injected' }, { startSeconds: Infinity }, { endSeconds: NaN }, { endSeconds: 14 }, { endSeconds: 23 }, { startSeconds: 0, endSeconds: 12.001 }]) {
    await assert.rejects(createReaFrameGrid({ ...base, ...overrides }), cause => cause.code === 'rea_frame_grid_invalid')
  }
  assert.equal(started, 0)
})

test('pre-cancelled grid never starts the isolated runtime', async () => {
  let started = false
  await assert.rejects(createReaFrameGrid({ durationSeconds: 20, startSeconds: 0, endSeconds: 12, signal: AbortSignal.abort(), processRunner: async () => { started = true } }), cause => cause.code === 'analysis_cancelled' && cause.status === 499)
  assert.equal(started, false)
})

test('fixed argument array preserves shell metacharacters and isolates provider settings', async t => {
  const setup = await fixture(t)
  let invocation
  const result = await createReaFrameGrid({ ...setup, processRunner: async (command, args, options) => { invocation = { command, args, options }; return response({ privatePath: setup.filePath, filename: 'injected.html' }) } })
  assert.deepEqual(result, { bytes: jpeg, contentType: 'image/jpeg', filename: 'rea-frame-grid.jpg' })
  const { command, args, options } = invocation
  assert.equal(command, process.execPath)
  assert.equal(args[args.indexOf('--video') + 1], setup.filePath)
  assert.equal(args[args.indexOf('--source') + 1], setup.config.SPUR_REA_VIDEO_SOURCE)
  assert.deepEqual(args.slice(-4), ['--start', '14', '--end', '22'])
  assert.equal(options.timeoutMs, 120000)
  assert.equal(options.env.POE_API_KEY, undefined)
  assert.equal(options.env.PYTHONNOUSERSITE, '1')
  assert.equal(options.env.HOME, options.cwd)
  assert.equal(options.env.REA_VIDEO_MODELS, path.join(options.cwd, 'models'))
  assert.ok(!JSON.stringify(result).includes(setup.directory))
  await assert.rejects(access(options.cwd))
  assert.deepEqual(await readdir(setup.tempRoot), [])
})

test('media and runtime validation blocks invalid local inputs', async t => {
  const setup = await fixture(t)
  let started = 0
  const processRunner = async () => { started++; return response() }
  for (const overrides of [
    { filePath: 'https://example.invalid/video.mp4' },
    { filePath: path.join(setup.directory, 'missing.mp4') },
    { filePath: setup.directory },
    { config: { ...setup.config, SPUR_FFMPEG_BIN: 'ffmpeg' } },
    { config: { ...setup.config, SPUR_FFPROBE_BIN: path.join(setup.directory, 'missing-ffprobe') } },
    { config: { ...setup.config, SPUR_REA_VIDEO_SOURCE: 'relative-source' } },
  ]) await assert.rejects(createReaFrameGrid({ ...setup, ...overrides, processRunner }), cause => ['rea_video_configuration', 'rea_frame_grid_media'].includes(cause.code))
  assert.equal(started, 0)
})

test('image transport rejects oversized, malformed or disguised payloads and cleans the run directory', async t => {
  const setup = await fixture(t)
  const huge = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(512 * 1024), Buffer.from([0xff, 0xd9])])
  const values = [null, response({ schemaVersion: 2 }), response({ contentType: 'text/html' }), response({ dataBase64: '<script>alert(1)</script>' }), response({ dataBase64: 'AAAA' }), response({ dataBase64: jpeg.subarray(0, -2).toString('base64') }), response({ dataBase64: huge.toString('base64') }), response({ dataBase64: jpeg.toString('base64') + '\n' })]
  for (const value of values) {
    await assert.rejects(createReaFrameGrid({ ...setup, processRunner: async () => value }), cause => cause.code === 'rea_frame_grid_output' && !cause.message.includes(setup.directory))
    assert.deepEqual(await readdir(setup.tempRoot), [])
  }
})

test('real child-process fixture verifies subprocess output and cleanup across errors', async t => {
  const setup = await fixture(t)
  const results = await createReaFrameGrid({ ...setup, processRunner: (_command, _args, options) => runReaProcess(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(JSON.stringify(response()))})`], options) })
  assert.deepEqual(results.bytes, jpeg)
  for (const script of ['process.stdout.write("not json")', 'process.stderr.write("private source path and token");process.exit(3)']) {
    await assert.rejects(createReaFrameGrid({ ...setup, processRunner: (_command, _args, options) => runReaProcess(process.execPath, ['-e', script], options) }), cause => !cause.message.includes('token') && !cause.message.includes(setup.directory))
    assert.deepEqual(await readdir(setup.tempRoot), [])
  }
})

test('native wrapper blocks network, restricts subprocesses and uses bounded native tiles', async () => {
  const source = await readFile(new URL('./rea-frame-grid.py', import.meta.url), 'utf8')
  for (const expected of ['socket.socket.connect = offline', 'socket.socket.connect_ex = offline', 'socket.create_connection = offline', 'rea_video.util.fetch = offline', 'from rea_video.cli import cmd_tiles', 'is_relative_to(source)', '"-protocol_whitelist", "file,pipe"', 'subprocess.CREATE_NO_WINDOW', 'min(24, max(2,', 'len(encoded) <= 512 * 1024']) assert.ok(source.includes(expected), expected)
})
