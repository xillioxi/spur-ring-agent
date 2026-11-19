import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import https from 'node:https'
import { reconstructionCapability, submitReconstructionClip, getReconstructionClip, downloadReconstructionClip } from './reconstruction-provider.mjs'

const require = createRequire(import.meta.url)
const network = require('../../agent/tools/playwright-browser/public-network.cjs')
const credential = 'synthetic-reconstruction-credential'
const config = { SILICONFLOW_API_KEY: credential, SILICONFLOW_BASE_URL: 'https://api.siliconflow.cn/v1' }
const input = { config, prompt: 'A specific chronological camera action in a vertical composition.', durationSeconds: 5 }
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

test('capability advertises actual H3 limits without keys and rejects unsupported model substitution', () => {
  const capability = reconstructionCapability(config)
  assert.equal(capability.available, true)
  assert.equal(capability.model, 'MiniMaxAI/MiniMax-H3')
  assert.equal(capability.minDurationSeconds, 5)
  assert.equal(capability.maxDurationSeconds, 15)
  assert.deepEqual(capability.resolutions, ['480p', '768p'])
  assert.ok(capability.ratios.includes('9:16'))
  assert.equal(reconstructionCapability({}).available, false)
  assert.equal(reconstructionCapability({ ...config, SPUR_VIDEO_RECONSTRUCTION_MODEL: 'Wan-AI/Wan2.2-T2V-A14B' }).available, false)
  assert.doesNotMatch(JSON.stringify(capability), new RegExp(credential))
})

test('submit uses current async endpoint and duration/ratio/resolution fields exactly once', async t => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => { calls.push({ url, options }); return json({ requestId: 'provider-task-123', ignored: credential }) })
  assert.deepEqual(await submitReconstructionClip(input), { requestId: 'provider-task-123' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.siliconflow.cn/v1/video/submit')
  assert.equal(calls[0].options.redirect, 'error')
  assert.equal(calls[0].options.headers.authorization, `Bearer ${credential}`)
  assert.deepEqual(JSON.parse(calls[0].options.body), { model: 'MiniMaxAI/MiniMax-H3', prompt: input.prompt, duration: 5, ratio: '9:16', resolution: '768p' })
  assert.equal('image_size' in JSON.parse(calls[0].options.body), false)
})

test('invalid durations, dimensions, prompts and configuration cannot create paid jobs', async t => {
  const fetched = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Must not be called') })
  for (const overrides of [{ durationSeconds: 4 }, { durationSeconds: 16 }, { durationSeconds: 5.5 }, { durationSeconds: '5' }, { ratio: '720x1280' }, { resolution: '2K' }, { prompt: '' }, { prompt: 'x'.repeat(8001) }, { config: {} }, { config: { ...config, SPUR_VIDEO_RECONSTRUCTION_MODEL: 'Wan-AI/Wan2.2-T2V-A14B' } }, { config: { ...config, SILICONFLOW_BASE_URL: 'http://insecure.test/v1' } }, { config: { ...config, SILICONFLOW_BASE_URL: 'https://user:pass@api.test/v1' } }, { config: { ...config, SILICONFLOW_BASE_URL: 'https://api.test/v1?secret=not-allowed' } }]) {
    await assert.rejects(submitReconstructionClip({ ...input, ...overrides }), cause => cause.definitive === true && !cause.message.includes(credential))
  }
  assert.equal(fetched.mock.callCount(), 0)
})

test('explicitly rejected submissions are definitive while service and network uncertainty never auto-retries', async t => {
  const calls = []
  let status = 401
  t.mock.method(globalThis, 'fetch', async () => { calls.push(status); if (status === 0) throw new Error(`https://private.test/?key=${credential}`); return json({ error: credential, url: 'https://private.test' }, status) })
  for (const code of [401, 403, 422, 429, 500, 503, 0]) {
    status = code
    const before = calls.length
    await assert.rejects(submitReconstructionClip(input), cause => cause.definitive === (code > 0 && code < 500) && !cause.message.includes(credential) && !cause.message.includes('private.test') && (code < 500 && code !== 0 || cause.code === 'reconstruction_submission_unknown'))
    assert.equal(calls.length, before + 1)
  }
})

test('unconfirmed success bodies cannot cause a paid submission to be repeated', async t => {
  let reply = {}
  const fetched = t.mock.method(globalThis, 'fetch', async () => reply)
  for (const make of [() => json({}), () => json({ requestId: credential }), () => new Response('not JSON'), () => new Response('{}', { headers: { 'content-length': String(1024 * 1024) } })]) {
    reply = make()
    await assert.rejects(submitReconstructionClip(input), cause => cause.code === 'reconstruction_submission_unknown' && cause.definitive === false && !cause.message.includes(credential))
  }
  assert.equal(fetched.mock.callCount(), 4)
})

test('poll maps provider states and exposes only the required task DTO', async t => {
  let status = 'InQueue'
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => { calls.push({ url, options }); return json({ status, reason: credential, internal: 'private', results: { videos: [{ url: 'https://cdn.example.org/result.mp4?signature=opaque' }] } }) })
  for (const [remote, local] of [['InQueue', 'queued'], ['InProgress', 'generating'], ['Failed', 'failed'], ['Succeed', 'ready']]) {
    status = remote
    const result = await getReconstructionClip({ config, requestId: 'provider-123' })
    assert.equal(result.status, local)
    assert.deepEqual(Object.keys(result), local === 'ready' ? ['status', 'url'] : ['status'])
    assert.doesNotMatch(JSON.stringify(result), new RegExp(credential))
  }
  assert.ok(calls.every(call => call.url.endsWith('/video/status') && JSON.parse(call.options.body).requestId === 'provider-123'))
})

test('poll rejects unknown states and private or credential-bearing result locations', async t => {
  let reply
  t.mock.method(globalThis, 'fetch', async () => json(reply))
  for (const value of [{ status: 'Unknown' }, { status: 'Succeed', results: { videos: [{ url: 'https://127.0.0.1/video.mp4' }] } }, { status: 'Succeed', results: { videos: [{ url: `https://cdn.example.org/video.mp4?key=${credential}` }] } }, { status: 'Succeed' }]) {
    reply = value
    await assert.rejects(getReconstructionClip({ config, requestId: 'provider-123' }), cause => !cause.message.includes(credential) && !cause.message.includes('127.0.0.1'))
  }
})

test('cancellation before submission is definitive, while cancellation after dispatch remains uncertain', async t => {
  const controller = new AbortController()
  let called = 0
  t.mock.method(globalThis, 'fetch', async (url, options) => { called++; controller.abort(); assert.equal(options.signal.aborted, true); throw new Error(credential) })
  await assert.rejects(submitReconstructionClip({ ...input, signal: AbortSignal.abort() }), cause => cause.code === 'reconstruction_cancelled' && cause.definitive)
  assert.equal(called, 0)
  await assert.rejects(submitReconstructionClip({ ...input, signal: controller.signal }), cause => cause.code === 'reconstruction_cancelled' && !cause.definitive)
  assert.equal(called, 1)
})

function mockDownload(t, responseFor) {
  const calls = []
  t.mock.method(network, 'resolvePublic', async () => ({ address: '8.8.8.8', family: 4 }))
  t.mock.method(https, 'get', (options, callback) => {
    calls.push(options)
    const request = new EventEmitter()
    request.setTimeout = () => request
    request.destroy = () => queueMicrotask(() => request.emit('error', new Error('private diagnostic')))
    queueMicrotask(() => {
      const response = new PassThrough()
      const value = responseFor(calls.length)
      response.statusCode = value.status || 200
      response.headers = value.headers || { 'content-type': 'video/mp4' }
      callback(response)
      if (!response.destroyed) response.end(value.bytes || Buffer.from('0000ftypisom0000'))
    })
    return request
  })
  return calls
}

test('download pins a public numeric destination and accepts bounded MP4 bytes without sending credentials', async t => {
  const calls = mockDownload(t, () => ({}))
  const result = await downloadReconstructionClip('https://cdn.example.org/video.mp4?signed=value')
  assert.ok(Buffer.isBuffer(result))
  assert.equal(result.toString('ascii', 4, 8), 'ftyp')
  assert.equal(calls[0].hostname, '8.8.8.8')
  assert.equal(calls[0].servername, 'cdn.example.org')
  assert.equal(calls[0].headers.Host, 'cdn.example.org')
  assert.equal(calls[0].headers.authorization, undefined)
})

test('download revalidates redirected destinations and blocks private access', async t => {
  const calls = mockDownload(t, () => ({ status: 302, headers: { location: 'https://127.0.0.1/private.mp4' } }))
  await assert.rejects(downloadReconstructionClip('https://cdn.example.org/video.mp4'), cause => !cause.message.includes('127.0.0.1') && !cause.message.includes('private.mp4'))
  assert.equal(calls.length, 1)
})

test('download rejects invalid formats, oversized content and redirect loops', async t => {
  let value = { bytes: Buffer.from('this is not a video') }
  const calls = mockDownload(t, () => value)
  await assert.rejects(downloadReconstructionClip('https://cdn.example.org/video.mp4'), /MP4/)
  value = { headers: { 'content-type': 'video/mp4', 'content-length': String(151 * 1024 ** 2) } }
  await assert.rejects(downloadReconstructionClip('https://cdn.example.org/video.mp4'), /150 MiB/)
  value = { status: 302, headers: { location: 'https://cdn.example.org/loop.mp4' } }
  await assert.rejects(downloadReconstructionClip('https://cdn.example.org/video.mp4'), /redirect limit/)
  assert.equal(calls.length, 8)
})

test('cancelled and private downloads never open a network connection', async t => {
  const calls = mockDownload(t, () => ({}))
  await assert.rejects(downloadReconstructionClip('https://cdn.example.org/video.mp4', { signal: AbortSignal.abort() }), /cancelled/)
  await assert.rejects(downloadReconstructionClip('https://10.0.0.1/video.mp4'), /private result location/)
  assert.equal(calls.length, 0)
})
