import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createReconstructionService } from './reconstruction.mjs'

const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom-generated-video')])
const privateConfig = { SILICONFLOW_API_KEY: 'synthetic-private-credential' }
const capability = () => ({ available: true, configured: true, provider: 'siliconflow', model: 'test-native-generator' })
const clone = value => JSON.parse(JSON.stringify(value))

async function fixture(t, { shots, duration = 26.7, hasAudio = true, provider = {}, render, configured = true, maxReadFailures = 4 } = {}) {
  const root = await mkdtemp(path.join(process.cwd(), '.spur-reconstruction-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const referenceId = randomUUID(), mediaRoot = path.join(root, 'media')
  await mkdir(mediaRoot)
  const referencePath = path.join(mediaRoot, `${referenceId}.mp4`)
  await writeFile(referencePath, Buffer.from('ORIGINAL SOURCE VISUALS AND AUDIO'))
  const items = new Map([[referenceId, { id: referenceId, status: 'complete', source: { kind: 'url', channelId: 'instagram-dreamcode_films' }, result: { metadata: { durationSeconds: duration, hasAudio, width: 1080, height: 1920 }, shots: shots || [{ startSeconds: 0, endSeconds: 8.1, visual: 'A hotel room', action: 'A door opens', framing: 'Wide', cameraMovement: 'Dolly forward' }, { startSeconds: 8.1, endSeconds: duration, visual: 'A travel scene', action: 'A person walks', framing: 'Medium', cameraMovement: 'Tracking' }], script: { text: 'A complete spoken reference.' } } }]])
  const submitted = [], polled = [], downloads = [], renders = [], uploads = [], analyses = []
  const referenceService = {
    async get(id) { if (!items.has(id)) throw Object.assign(new Error('Private reference not found'), { status: 404 }); return clone(items.get(id)) },
    async list() { return [...items.values()].map(clone) },
    async getMedia(id) { if (!items.has(id)) throw Object.assign(new Error('Private reference not found'), { status: 404 }); return { filePath: path.join(mediaRoot, `${id}.mp4`), size: (await readFile(path.join(mediaRoot, `${id}.mp4`))).length, extension: '.mp4' } },
    async upload(stream, options) {
      const chunks = []; for await (const chunk of stream) chunks.push(chunk)
      const bytes = Buffer.concat(chunks), id = randomUUID()
      uploads.push({ options, bytes }); await writeFile(path.join(mediaRoot, `${id}.mp4`), bytes)
      const item = { id, status: 'ready', source: { kind: 'reconstruction', referenceId: options.reconstruction.referenceId, reconstructionId: options.reconstruction.jobId } }
      items.set(id, item); return clone(item)
    },
    async analyze(id, options) { analyses.push({ id, options }); items.get(id).status = 'queued'; return clone(items.get(id)) },
  }
  const adapter = { capability: configured ? capability : () => ({ available: false, configured: false, reason: 'Configure the server provider first.' }), submit: async args => { submitted.push(args); return { requestId: `private-provider-receipt-${submitted.length}` } }, get: async args => { polled.push(args); return { status: 'ready', url: 'https://private-provider.example/result.mp4' } }, download: async (url, options) => { downloads.push({ url, options }); return mp4 }, ...provider }
  const renderImpl = async args => { renders.push(args); if (render) return render(args); await writeFile(args.outputPath, mp4); return { warnings: ['Generated footage may differ from the reference.'] } }
  const options = { root, referenceService, config: privateConfig, provider: adapter, render: renderImpl, wait: async () => {}, maxReadFailures }
  const service = createReconstructionService(options)
  return { root, referenceId, referencePath, referenceService, items, submitted, polled, downloads, renders, uploads, analyses, service, options, request: async extra => ({ requestKey: randomUUID(), planRevision: (await service.plan(referenceId)).planRevision, ...extra }) }
}

test('plan preserves actual shot timing and splits long shots into bounded billable clips', async t => {
  const f = await fixture(t)
  const plan = await f.service.plan(f.referenceId)
  assert.equal(plan.ratio, '9:16')
  assert.equal(plan.resolution, '480p')
  assert.equal(plan.audioMode, 'reference')
  assert.deepEqual(plan.clips.map(clip => [clip.startSeconds, clip.endSeconds, clip.durationSeconds, clip.requestDurationSeconds]), [[0, 8.1, 8.1, 9], [8.1, 23.1, 15, 15], [23.1, 26.7, 3.6, 5]])
  assert.equal(plan.billableSeconds, 29)
  assert.equal(plan.totalDurationSeconds, 26.7)
  assert.match(plan.clips[0].prompt, /Visual: A hotel room/)
  assert.match(plan.clips[0].prompt, /Action: A door opens/)
  assert.match(plan.clips[0].prompt, /Framing: Wide/)
  assert.match(plan.clips[0].prompt, /Camera movement: Dolly forward/)
  assert.equal(f.submitted.length, 0)
})

const authoredTimeline = () => [
  { startSeconds: 0, endSeconds: 3.6, prompt: '  [Shake] A photorealistic spacecraft porthole.\n[Push in] toward a black hole.  ' },
  { startSeconds: 3.7, endSeconds: 11.6, prompt: '[Pedestal down] Through the checkerboard trapdoor into a forest freefall.' },
  { startSeconds: 11.7, endSeconds: 16, prompt: '[Tilt up,Pan left] Rooftop POV and seven orange meteors.' },
  { startSeconds: 16.5, endSeconds: 23.7, prompt: "[Static shot] A man walks away through an O'Neill cylinder." },
  { startSeconds: 23.7, endSeconds: 26, prompt: '[Static shot] The same empty habitat, with no people.' },
]

test('unreviewed Rea technical reports cannot create automatic recreation plans or paid requests while authored timelines remain available', async t => {
  const f = await fixture(t), item = f.items.get(f.referenceId)
  item.status = 'partial'
  item.result.analysisWorkflowId = 'rea-video'
  item.result.provenance = { workflow: { id: 'rea-video', status: 'unreviewed' } }
  item.result.reaVideo = { reviewStatus: 'unreviewed', vlmStatus: 'not_requested' }
  item.result.shots = [{ startSeconds: 0, endSeconds: 26.7, visual: 'Technical shot: estimated live action. Visual content is unreviewed.' }]
  await assert.rejects(f.service.plan(f.referenceId), error => error.status === 409 && error.code === 'reconstruction_analysis_required' && /model breakdown.*automatic recreation/.test(error.message))
  await assert.rejects(f.service.create(f.referenceId, { requestKey: randomUUID(), planRevision: 'not-reviewed' }), { status: 409, code: 'reconstruction_analysis_required' })
  const before = clone(item), timeline = authoredTimeline(), plan = await f.service.plan(f.referenceId, { timeline })
  assert.equal(plan.source, 'authored_timeline')
  assert.deepEqual(plan.clips.map(clip => clip.prompt), timeline.map(clip => clip.prompt.trim()))
  assert.deepEqual(f.items.get(f.referenceId), before)
  assert.equal(f.submitted.length, 0); assert.equal(f.polled.length, 0); assert.equal(f.downloads.length, 0)
})

test('authored plan keeps exact prompts and independent timing without replacing the source analysis', async t => {
  const f = await fixture(t), before = clone(f.items.get(f.referenceId)), timeline = authoredTimeline()
  const originalPlan = await f.service.plan(f.referenceId)
  const plan = await f.service.plan(f.referenceId, { timeline })
  assert.equal(plan.source, 'authored_timeline')
  assert.equal(plan.referenceDurationSeconds, 26.7)
  assert.equal(plan.totalDurationSeconds, 26)
  assert.equal(plan.billableSeconds, 31)
  assert.deepEqual(plan.clips.map(clip => clip.requestDurationSeconds), [5, 8, 5, 8, 5])
  assert.deepEqual(plan.clips.map(clip => clip.prompt), timeline.map(clip => clip.prompt.trim()))
  assert.deepEqual(plan.clips.map(clip => [clip.startSeconds, clip.endSeconds]), timeline.map(clip => [clip.startSeconds, clip.endSeconds]))
  assert.ok(plan.clips.every(clip => !('sourceShotIndex' in clip)))
  assert.match(plan.warnings.join(' '), /0\.7 seconds.*gaps.*black/)
  assert.match(plan.warnings.join(' '), /first\/last-frame.*2K.*not applied/)
  assert.notEqual(plan.planRevision, originalPlan.planRevision)
  assert.equal((await f.service.plan(f.referenceId, { timeline: clone(timeline) })).planRevision, plan.planRevision)
  const changed = clone(timeline); changed[0].endSeconds = 3.5
  assert.notEqual((await f.service.plan(f.referenceId, { timeline: changed })).planRevision, plan.planRevision)
  assert.deepEqual(f.items.get(f.referenceId), before)
  assert.equal(f.submitted.length, 0)
})

test('authored generation freezes the reviewed timeline, preserves receipts and forwards gaps to rendering', async t => {
  const f = await fixture(t), timeline = authoredTimeline(), before = clone(f.items.get(f.referenceId))
  const plan = await f.service.plan(f.referenceId, { timeline })
  const request = { requestKey: randomUUID(), planRevision: plan.planRevision, timeline, resolution: '768p' }
  const first = await f.service.create(f.referenceId, request)
  assert.equal((await f.service.create(f.referenceId, request)).id, first.id)
  await f.service.whenIdle()
  const completed = await f.service.get(first.id)
  assert.equal(completed.status, 'completed')
  assert.equal(completed.source, 'authored_timeline')
  assert.equal(completed.totalDurationSeconds, 26)
  assert.equal(completed.referenceDurationSeconds, 26.7)
  assert.equal(completed.billableSeconds, 31)
  assert.deepEqual(f.submitted.map(clip => clip.durationSeconds), [5, 8, 5, 8, 5])
  assert.deepEqual(f.submitted.map(clip => clip.prompt), timeline.map(clip => clip.prompt.trim()))
  assert.equal(f.renders[0].totalDurationSeconds, 26)
  assert.deepEqual(f.renders[0].clips.map(clip => [clip.startSeconds, clip.endSeconds, clip.durationSeconds]), [[0, 3.6, 3.6], [3.7, 11.6, 7.9], [11.7, 16, 4.3], [16.5, 23.7, 7.2], [23.7, 26, 2.3]])
  assert.equal(f.submitted.length, 5, 'timeline gaps never submit generated clips')
  const altered = clone(timeline); altered[0].prompt = 'A different camera prompt.'
  await assert.rejects(f.service.create(f.referenceId, { ...request, timeline: altered }), error => error.code === 'reconstruction_request_conflict')
  await assert.rejects(f.service.create(f.referenceId, { ...request, requestKey: randomUUID(), timeline: altered }), error => error.code === 'reconstruction_stale_plan')
  timeline[0].prompt = 'Mutated after job creation.'
  assert.equal((await f.service.get(first.id)).clips[0].prompt, plan.clips[0].prompt)
  const persisted = JSON.parse(await readFile(path.join(f.root, 'reconstructions', first.id, 'manifest.json'), 'utf8'))
  assert.equal(persisted.clips[0].prompt, plan.clips[0].prompt)
  assert.deepEqual(f.items.get(f.referenceId), before)
  assert.equal(f.submitted.length, 5)
})

test('authored timelines can replace missing shot analysis without fabricating analysis evidence', async t => {
  const f = await fixture(t)
  delete f.items.get(f.referenceId).result.shots
  await assert.rejects(f.service.plan(f.referenceId), error => error.code === 'reconstruction_analysis_required')
  const timeline = [{ startSeconds: 1, endSeconds: 2, prompt: 'An authored one-second shot after a black opening.' }]
  const plan = await f.service.plan(f.referenceId, { timeline })
  assert.equal(plan.totalDurationSeconds, 2)
  const receipt = await f.service.create(f.referenceId, { requestKey: randomUUID(), planRevision: plan.planRevision, timeline })
  await f.service.whenIdle()
  assert.equal((await f.service.get(receipt.id)).status, 'completed')
  assert.equal(f.items.get(f.referenceId).result.shots, undefined)
})

test('malformed, overlapping, excessive and provider-bearing custom timelines never submit generation', async t => {
  const f = await fixture(t), shot = { startSeconds: 0, endSeconds: 2, prompt: 'One authored shot.' }
  const invalid = [null, [], {}, Array(25).fill(shot), [{ ...shot, startSeconds: -1 }], [{ ...shot, startSeconds: '0' }], [{ ...shot, endSeconds: Infinity }], [{ ...shot, endSeconds: 0 }], [{ ...shot, endSeconds: 0.01 }], [{ ...shot, endSeconds: 15.1 }], [{ ...shot, startSeconds: 299, endSeconds: 301 }], [shot, { ...shot, startSeconds: 1, endSeconds: 3 }], [{ ...shot, prompt: '  ' }], [{ ...shot, prompt: 'x'.repeat(8001) }], [{ ...shot, prompt: 'unsafe\u0000prompt' }], [{ ...shot, model: 'other-provider-model' }], [{ ...shot, images: [{ url: 'https://your-storage.url/placeholder.png' }] }]]
  for (const timeline of invalid) {
    await assert.rejects(f.service.plan(f.referenceId, { timeline }), error => error.status === 422)
    await assert.rejects(f.service.create(f.referenceId, { requestKey: randomUUID(), planRevision: 'unreviewed', timeline }), error => error.status === 422)
  }
  for (const key of ['apiKey', 'model', 'baseUrl', 'resolution']) await assert.rejects(f.service.plan(f.referenceId, { timeline: [shot], [key]: 'unsupported' }), error => error.status === 422)
  assert.equal(f.submitted.length, 0)
  assert.deepEqual(await f.service.list(), [])
})

test('generation is sequential, trims only generated clips and imports a private derived output', async t => {
  const f = await fixture(t)
  const request = await f.request({ shots: [{ index: 0, prompt: 'An edited generated shot prompt.' }] })
  const receipt = await f.service.create(f.referenceId, request)
  assert.equal(receipt.status, 'queued')
  assert.equal(receipt.requestKey, request.requestKey)
  await f.service.whenIdle()
  const job = await f.service.get(receipt.id)
  assert.equal(job.status, 'completed')
  assert.equal(job.hasMedia, true)
  assert.equal(f.submitted.length, 3)
  assert.deepEqual(f.submitted.map(value => value.durationSeconds), [9, 15, 5])
  assert.equal(f.submitted[0].prompt, 'An edited generated shot prompt.')
  assert.equal(f.renders.length, 1)
  assert.equal(f.renders[0].referencePath, f.referencePath)
  assert.ok(f.renders[0].clips.every(clip => clip.filePath !== f.referencePath))
  assert.deepEqual(f.renders[0].clips.map(clip => clip.durationSeconds), [8.1, 15, 3.6])
  assert.equal(f.uploads[0].options.channelId, undefined)
  assert.deepEqual(f.uploads[0].options.reconstruction, { referenceId: f.referenceId, jobId: receipt.id })
  assert.deepEqual(await readFile(f.referencePath), Buffer.from('ORIGINAL SOURCE VISUALS AND AUDIO'))
  const media = await f.service.getMedia(job.id)
  assert.equal(media.extension, '.mp4')
  assert.deepEqual(await readFile(media.filePath), mp4)
  assert.deepEqual(await readdir(path.join(f.root, 'reconstructions', job.id)), ['manifest.json'])
  const publicText = JSON.stringify(job)
  assert.doesNotMatch(publicText, /synthetic-private-credential|private-provider-receipt|https:\/\/private-provider/)
  assert.equal(publicText.includes(f.root), false)
})

test('same requestKey recovers one job and altered requests cannot create another paid generation', async t => {
  const f = await fixture(t)
  const request = await f.request()
  const [first, second] = await Promise.all([f.service.create(f.referenceId, request), f.service.create(f.referenceId, request)])
  assert.equal(first.id, second.id)
  await f.service.whenIdle()
  assert.equal((await f.service.create(f.referenceId, request)).id, first.id)
  await assert.rejects(f.service.create(f.referenceId, { ...request, resolution: '768p' }), error => error.status === 409)
  assert.equal(f.submitted.length, 3)
  assert.equal((await f.service.list(f.referenceId))[0].requestKey, request.requestKey)
})

test('no key, stale revision, invalid prompts and incomplete timelines do not submit generation', async t => {
  const f = await fixture(t, { configured: false })
  const plan = await f.service.plan(f.referenceId)
  assert.equal(plan.capability.available, false)
  await assert.rejects(f.service.create(f.referenceId, await f.request()), error => error.status === 503)
  assert.deepEqual(await f.service.list(), [])
  const g = await fixture(t)
  await assert.rejects(g.service.create(g.referenceId, { ...await g.request(), planRevision: 'stale' }), error => error.code === 'reconstruction_stale_plan')
  await assert.rejects(g.service.create(g.referenceId, await g.request({ shots: [{ index: 99, prompt: 'invalid index' }] })), /clip index/)
  g.items.get(g.referenceId).result.shots[0].startSeconds = 1
  await assert.rejects(g.service.plan(g.referenceId), error => error.code === 'reconstruction_incomplete_timeline')
  assert.equal(g.submitted.length, 0)
})

test('ambiguous submissions never retry or generate later shots and expose no provider exception', async t => {
  let calls = 0
  const f = await fixture(t, { provider: { submit: async () => { calls++; throw new Error('synthetic-private-credential C:\\private\\provider') } } })
  const receipt = await f.service.create(f.referenceId, await f.request())
  await f.service.whenIdle()
  const job = await f.service.get(receipt.id)
  assert.equal(calls, 1)
  assert.equal(job.status, 'submission_unknown')
  assert.equal(job.clips[0].status, 'submission_unknown')
  assert.equal(job.retryable, false)
  assert.doesNotMatch(JSON.stringify(job), /synthetic-private-credential|C:\\private/)
})

test('definitive authentication rejection stops at one shot and preserves sanitized failure status', async t => {
  let calls = 0
  const f = await fixture(t, { provider: { submit: async () => { calls++; throw Object.assign(new Error('synthetic-private-credential provider body'), { code: 'reconstruction_authentication', status: 401, definitive: true }) } } })
  const request = await f.request(), receipt = await f.service.create(f.referenceId, request)
  await f.service.whenIdle()
  const job = await f.service.get(receipt.id)
  assert.equal(job.status, 'failed')
  assert.match(job.error, /credentials/)
  assert.doesNotMatch(job.error, /synthetic-private-credential|provider body/)
  assert.equal(calls, 1)
  await f.service.create(f.referenceId, request)
  await f.service.whenIdle()
  assert.equal(calls, 1)
  await assert.rejects(f.service.resume(receipt.id), error => error.status === 409)
})

test('status and download recovery use the same receipt without submitting another generation', async t => {
  let reads = 0, downloads = 0
  const ids = []
  const f = await fixture(t, { duration: 2, shots: [{ startSeconds: 0, endSeconds: 2, visual: 'One shot' }], provider: {
    get: async ({ requestId }) => { ids.push(requestId); if (++reads === 1) throw new Error('temporary'); return { status: 'ready', url: 'https://provider.example/file.mp4' } },
    download: async () => { if (++downloads === 1) throw new Error('temporary download'); return mp4 },
  } })
  const receipt = await f.service.create(f.referenceId, await f.request())
  await f.service.whenIdle()
  assert.equal((await f.service.get(receipt.id)).status, 'completed')
  assert.equal(f.submitted.length, 1)
  assert.equal(reads, 3)
  assert.equal(downloads, 2)
  assert.equal(new Set(ids).size, 1)
})

test('exhausted downloads pause durably and explicit resume recovers the same single paid request', async t => {
  let canDownload = false, downloads = 0
  const receiptIds = []
  const f = await fixture(t, { duration: 2, shots: [{ startSeconds: 0, endSeconds: 2, visual: 'One recoverable shot' }], provider: {
    get: async ({ requestId }) => { receiptIds.push(requestId); return { status: 'ready', url: 'https://provider.example/file.mp4' } },
    download: async () => { downloads++; if (!canDownload) throw new Error('temporary CDN outage'); return mp4 },
  } })
  const request = await f.request(), receipt = await f.service.create(f.referenceId, request)
  await f.service.whenIdle()
  const paused = await f.service.get(receipt.id)
  assert.equal(paused.status, 'paused')
  assert.equal(paused.retryable, true)
  assert.equal(paused.clips[0].status, 'paused')
  assert.equal(downloads, 4)
  assert.equal(f.submitted.length, 1)
  assert.equal((await f.service.create(f.referenceId, request)).status, 'paused', 'idempotent creation does not resume automatically')
  const restarted = createReconstructionService(f.options)
  await restarted.whenIdle()
  assert.equal((await restarted.list(f.referenceId))[0].status, 'paused')
  assert.equal(downloads, 4, 'restart and reads never resume paused requests')
  canDownload = true
  const resumed = await restarted.resume(receipt.id)
  assert.equal(resumed.id, receipt.id)
  assert.equal(resumed.status, 'queued')
  assert.equal((await restarted.resume(receipt.id)).id, receipt.id, 'duplicate resume cannot enqueue another worker')
  await restarted.whenIdle()
  assert.equal((await restarted.get(receipt.id)).status, 'completed')
  assert.equal(f.submitted.length, 1)
  assert.equal(downloads, 5)
  assert.equal(new Set(receiptIds).size, 1)
})

test('resuming a paused later shot preserves completed clips and only submits remaining planned shots', async t => {
  let canDownload = false, downloadingId
  const reads = []
  const f = await fixture(t, { duration: 6, shots: [0, 2, 4].map(startSeconds => ({ startSeconds, endSeconds: startSeconds + 2, visual: 'A planned two second shot' })), provider: {
    get: async ({ requestId }) => { reads.push(requestId); downloadingId = requestId; return { status: 'ready', url: 'https://provider.example/file.mp4' } },
    download: async () => { if (downloadingId.endsWith('-2') && !canDownload) throw new Error('temporary CDN outage'); return mp4 },
  } })
  const receipt = await f.service.create(f.referenceId, await f.request())
  await f.service.whenIdle()
  const paused = await f.service.get(receipt.id)
  assert.deepEqual(paused.clips.map(clip => clip.status), ['completed', 'paused', 'pending'])
  assert.equal(f.submitted.length, 2)
  canDownload = true
  await f.service.resume(receipt.id)
  await f.service.whenIdle()
  assert.equal((await f.service.get(receipt.id)).status, 'completed')
  assert.equal(f.submitted.length, 3)
  assert.equal(reads.filter(id => id.endsWith('-1')).length, 1, 'completed first clip is neither queried nor generated again')
})

test('restart marks a submitting shot without a receipt unconfirmed and never resubmits', async t => {
  const f = await fixture(t)
  const plan = await f.service.plan(f.referenceId), id = randomUUID(), directory = path.join(f.root, 'reconstructions', id)
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id, requestKey: randomUUID(), referenceId: f.referenceId, status: 'submitting', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), clips: plan.clips.map((clip, index) => ({ ...clip, status: index ? 'pending' : 'submitting' })) }))
  const resumed = createReconstructionService(f.options)
  assert.equal((await resumed.get(id)).status, 'submission_unknown')
  await resumed.whenIdle()
  assert.equal(f.submitted.length, 0)
})

test('restart resumes polling a saved provider receipt and does not submit it again', async t => {
  const f = await fixture(t, { duration: 2, shots: [{ startSeconds: 0, endSeconds: 2, visual: 'One saved shot' }] })
  const plan = await f.service.plan(f.referenceId), id = randomUUID(), directory = path.join(f.root, 'reconstructions', id)
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id, requestKey: randomUUID(), referenceId: f.referenceId, status: 'generating', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), totalDurationSeconds: 2, audioMode: 'silent', ratio: '9:16', resolution: '480p', warnings: [], clips: plan.clips.map(clip => ({ ...clip, status: 'queued', requestId: 'saved-provider-receipt' })) }))
  const resumed = createReconstructionService(f.options)
  await resumed.whenIdle()
  assert.equal((await resumed.get(id)).status, 'completed')
  assert.equal(f.submitted.length, 0)
  assert.equal(f.polled[0].requestId, 'saved-provider-receipt')
})

test('output analysis is explicit, reuses the same item and reports approximate observable comparisons', async t => {
  const f = await fixture(t)
  const receipt = await f.service.create(f.referenceId, await f.request())
  await f.service.whenIdle()
  assert.equal(f.analyses.length, 0)
  const value = await f.service.analyzeOutput(receipt.id)
  assert.deepEqual(f.analyses, [{ id: value.job.outputItemId, options: { mode: 'both' } }])
  assert.equal(value.job.comparison.status, 'pending')
  const output = f.items.get(value.job.outputItemId)
  output.status = 'partial'; output.result = { metadata: { durationSeconds: 26.733 }, shots: [{}, {}, {}], script: { text: 'A complete spoken output.' } }
  const compared = await f.service.get(receipt.id)
  assert.equal(compared.comparison.status, 'ready')
  assert.equal(compared.comparison.referenceShotCount, 2)
  assert.equal(compared.comparison.outputShotCount, 3)
  assert.equal(compared.comparison.durationDeltaSeconds, 0.033)
  assert.equal(compared.comparison.transcriptWordOverlap, 0.6)
  assert.equal((await f.service.list(f.referenceId))[0].comparison.status, 'ready')
  await f.service.analyzeOutput(receipt.id)
  assert.equal(f.analyses.length, 1)
  assert.equal(f.submitted.length, 3)
})

test('private reference lookup and bounded plans reject foreign references and excessive shot counts', async t => {
  const f = await fixture(t)
  await assert.rejects(f.service.list(randomUUID()), error => error.status === 404)
  await assert.rejects(f.service.get(randomUUID()), error => error.status === 404)
  const many = await fixture(t, { duration: 25, shots: Array.from({ length: 25 }, (_, index) => ({ startSeconds: index, endSeconds: index + 1, visual: 'A small shot' })) })
  await assert.rejects(many.service.plan(many.referenceId), error => error.code === 'reconstruction_clip_limit')
  assert.equal(many.submitted.length, 0)
})
