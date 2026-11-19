import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/videoReconstructionApi.ts', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2020' })
const api = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))
const uiBundle = await build({ stdin: { contents: "export { RecreationPlanEditor, RecreationJobProgress, CustomStoryboardEditor } from './src/VideoReconstruction.tsx'; export { renderToStaticMarkup } from 'react-dom/server.browser'", resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'browser', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' } })
const ui = await import('data:text/javascript;base64,' + Buffer.from(uiBundle.outputFiles[0].text).toString('base64'))
const requestKey = '11111111-1111-4111-8111-111111111111'
const clips = Array.from({ length: 6 }, (_, index) => ({ index, sourceShotIndex: index, startSeconds: index * 15, endSeconds: index === 5 ? 77 : (index + 1) * 15, durationSeconds: index === 5 ? 2 : 15, requestDurationSeconds: index === 5 ? 5 : 15, prompt: `Describe actual shot ${index + 1}.` }))
const plan = { referenceId: 'reference', planRevision: 'revision-1', totalDurationSeconds: 77, referenceDurationSeconds: 77, billableSeconds: 80, ratio: '9:16', hasReferenceAudio: true, audioMode: 'reference', resolution: '480p', clips, capability: { available: true, model: 'MiniMax-Hailuo-3.0' } }
const job = { id: 'job-one', requestKey, referenceId: 'reference', planRevision: plan.planRevision, status: 'generating', stage: 'generating', createdAt: '2026-11-12T10:00:00Z', updatedAt: '2026-11-12T10:00:01Z', totalDurationSeconds: 77, billableSeconds: 80, ratio: '9:16', audioMode: 'reference', resolution: '480p', hasMedia: false, clips: clips.map(clip => ({ ...clip, status: 'queued' })) }
const body = { planRevision: plan.planRevision, shots: clips.map(({ index, prompt }) => ({ index, prompt })), audioMode: 'reference', resolution: '480p' }
const storyboard = {
  project_metadata: { title: 'Liminal teleport sequence', global_settings: { resolution: '2K', watermark: false } },
  clips: ['00:00.0 - 00:03.6', '00:03.7 - 00:11.6', '00:11.7 - 00:16.0', '00:16.5 - 00:23.7', '00:23.7 - 00:26.0'].map((timeline, index) => ({ timeline, mode: index === 1 ? 'first_and_last_frame' : 'text_to_video', api_payload: { prompt: ` [Static shot] Prompt ${index + 1}: photorealistic POV.\nPreserve spacing — and tags. `, model: 'untrusted-model', endpoint: 'https://untrusted.example', images: [{ role: 'first_frame', url: 'https://your-storage.url/placeholder.png' }] } })),
  post_production_sync: { music: 'Reference soundtrack', sfx_cues: ['00:23.7: electrical pop'] },
}

test('custom storyboard preserves all five exact prompts and timestamps while isolating provider settings and placeholder images', () => {
  const parsed = api.parseRecreationStoryboard(JSON.stringify(storyboard))
  assert.equal(parsed.title, storyboard.project_metadata.title)
  assert.deepEqual(parsed.timeline.map(clip => clip.prompt), storyboard.clips.map(clip => clip.api_payload.prompt))
  assert.deepEqual(parsed.timeline.map(({ startSeconds, endSeconds }) => [startSeconds, endSeconds]), [[0, 3.6], [3.7, 11.6], [11.7, 16], [16.5, 23.7], [23.7, 26]])
  assert.ok(parsed.timeline.every(clip => Object.keys(clip).join(',') === 'startSeconds,endSeconds,prompt'))
  assert.ok(parsed.warnings.some(text => text.includes('0.7s of black gaps')))
  assert.ok(parsed.warnings.some(text => text.includes('2K') && text.includes('not sent')))
  assert.ok(parsed.warnings.some(text => text.includes('text prompts only') && text.includes('not fetched')))
  assert.ok(parsed.warnings.some(text => text.includes('post_production_sync') && text.includes('not generated')))
  assert.equal(JSON.stringify(parsed.timeline).includes('https://'), false)
})

test('custom storyboard rejects malformed, overlapping, reversed, oversized and out-of-bounds timelines before requesting a plan', () => {
  const clip = (timeline, prompt = 'A valid shot.') => ({ timeline, api_payload: { prompt } })
  for (const value of [null, [], {}, { clips: [] }, { clips: [clip('00:00 - 00:00')] }, { clips: [clip('00:00 - 00:00.01')] }, { clips: [clip('00:00 - 00:02'), clip('00:01 - 00:03')] }, { clips: [clip('00:60 - 01:02')] }, { clips: [clip('00:00 - 00:16')] }, { clips: [clip('04:59 - 05:01')] }, { clips: [clip('00:00 - 00:02', ' ')] }, { clips: [clip('00:00 - 00:02', 'bad\u0000prompt')] }, { clips: [clip('00:00 - 00:02', 'x'.repeat(8001))] }, { clips: Array(25).fill(clip('00:00 - 00:01')) }]) assert.throws(() => api.parseRecreationStoryboard(JSON.stringify(value)))
  assert.throws(() => api.parseRecreationStoryboard('{broken json'), /valid storyboard JSON/)
  assert.throws(() => api.parseRecreationStoryboard('x'.repeat(150001)), /150,000/)
  assert.equal(api.parseRecreationStoryboard('```json\n' + JSON.stringify({ clips: [clip('00:00 - 00:01')] }) + '\n```').timeline.length, 1)
})

test('custom plan preparation sends only the parsed timeline to the saved-reference route and never generates video', async () => {
  const original = globalThis.fetch, received = [], timeline = api.parseRecreationStoryboard(JSON.stringify(storyboard)).timeline
  globalThis.fetch = async (url, options) => { received.push({ url, method: options.method, body: JSON.parse(options.body) }); return new Response(JSON.stringify({ plan: { ...plan, source: 'authored_timeline' } }), { status: 200 }) }
  try {
    assert.equal((await api.createCustomRecreationPlan('https://untrusted.example', timeline)).plan.source, 'authored_timeline')
    assert.deepEqual(received, [{ url: '/api/creator-agent/video-analysis/items/https%3A%2F%2Funtrusted.example/reconstruction-plan', method: 'POST', body: { timeline } }])
  } finally { globalThis.fetch = original }
})

test('storyboard review separates applying from paid generation and requires applying changed JSON', () => {
  let applied = 0
  const html = ui.renderToStaticMarkup(ui.CustomStoryboardEditor({ value: JSON.stringify(storyboard), onChange() {}, onApply() { applied++ }, onReset() {}, disabled: false, active: true, changed: true }))
  assert.match(html, /Use a custom prompt \/ storyboard/)
  assert.match(html, /Apply storyboard/)
  assert.match(html, /generation starts only when you choose Generate recreation/)
  assert.match(html, /JSON has changed/)
  assert.match(html, /Use analyzed shots/)
  assert.equal(applied, 0)
  assert.equal((html.match(/<textarea/g) || []).length, 1)
  assert.doesNotMatch(html, /<img/)
})

test('saved authored recreations disclose their source, precise timeline and actual submitted prompts', () => {
  const timeline = api.parseRecreationStoryboard(JSON.stringify(storyboard)).timeline
  const authored = { ...job, source: 'authored_timeline', clips: timeline.map((clip, index) => ({ ...clip, index, durationSeconds: clip.endSeconds - clip.startSeconds, requestDurationSeconds: Math.max(5, Math.ceil(clip.endSeconds - clip.startSeconds)), status: 'completed' })) }
  const html = ui.renderToStaticMarkup(ui.RecreationJobProgress({ job: authored }))
  assert.match(html, /Source: authored storyboard/)
  assert.match(html, /View submitted prompts/)
  assert.match(html, /0:03.7–0:11.6/)
  assert.match(html, /0:23.7–0:26/)
  assert.match(html, /\[Static shot\] Prompt 2: photorealistic POV\./)
})

test('a custom timeline and edited prompts remain frozen across uncertain submission and intentional resumption', async () => {
  const sent = [], saved = [], timeline = api.parseRecreationStoryboard(JSON.stringify(storyboard)).timeline
  const customBody = { ...body, resolution: '768p', timeline, shots: [{ index: 0, prompt: '  Exact reviewed prompt.  ' }] }
  const expected = structuredClone(customBody)
  const submission = api.createRecreationSubmission('reference', { newKey: () => requestKey, onPending: (_key, payload) => { if (payload) saved.push(payload) }, create: async (_id, request) => { sent.push(structuredClone(request)); if (sent.length === 1) throw new Error('Uncertain receipt'); return { job } } })
  await assert.rejects(submission.submit(customBody), /Uncertain/)
  timeline[0].prompt = 'An accidental draft change.'; customBody.shots[0].prompt = 'Another accidental change.'
  saved[0].timeline[1].prompt = 'A mutated callback payload.'
  await submission.resume()
  assert.deepEqual(sent, [{ ...expected, requestKey }, { ...expected, requestKey }])
})

test('recreation plan review preserves long timelines and distinguishes trimmed length from billable generation', () => {
  assert.deepEqual(api.recreationTiming(plan), { targetSeconds: 77, billableSeconds: 80, clipCount: 6 })
  assert.equal(api.recreationTiming({ ...plan, billableSeconds: undefined }).billableSeconds, 80)
  const html = ui.renderToStaticMarkup(ui.RecreationPlanEditor({ plan, prompts: { 0: 'Edited opening action.' }, onPrompt() {}, disabled: false }))
  assert.match(html, /77s/)
  assert.match(html, /80s/)
  assert.match(html, /Final target length/)
  assert.match(html, /Billable generation/)
  assert.match(html, /1:15–1:17/)
  assert.match(html, /5s generated/)
  assert.match(html, /Edited opening action\./)
  assert.match(html, /5–15 seconds per clip/)
  assert.equal((html.match(/<textarea/g) || []).length, 6)
})

test('planning, editing, job polling and analysis use only the private saved-reference routes', async () => {
  const original = globalThis.fetch, received = []
  globalThis.fetch = async (url, options) => {
    received.push({ url, method: options.method, body: options.body && JSON.parse(options.body) })
    const value = url.endsWith('/reconstruction-plan') ? { plan } : url.includes('?referenceId=') ? { jobs: [job] } : url.endsWith('/analyze') ? { job, item: { id: 'output-one', source: { kind: 'reconstruction' }, status: 'queued' } } : { job }
    return new Response(JSON.stringify(value), { status: options.method === 'POST' ? 202 : 200 })
  }
  try {
    assert.equal((await api.getRecreationPlan('reference')).plan.totalDurationSeconds, 77)
    await api.createRecreation('reference', { ...body, requestKey, shots: [{ index: 0, prompt: 'My reviewed prompt.' }] })
    await api.listRecreations('reference')
    await api.getRecreation('job-one')
    assert.equal((await api.analyzeRecreation('job-one')).item.source.kind, 'reconstruction')
    assert.deepEqual(received.map(value => [value.url, value.method]), [
      ['/api/creator-agent/video-analysis/items/reference/reconstruction-plan', 'GET'],
      ['/api/creator-agent/video-analysis/items/reference/reconstructions', 'POST'],
      ['/api/creator-agent/video-analysis/reconstructions?referenceId=reference', 'GET'],
      ['/api/creator-agent/video-analysis/reconstructions/job-one', 'GET'],
      ['/api/creator-agent/video-analysis/reconstructions/job-one/analyze', 'POST'],
    ])
    assert.deepEqual(received[1].body, { ...body, requestKey, shots: [{ index: 0, prompt: 'My reviewed prompt.' }] })
    assert.deepEqual(received[4].body, {})
  } finally { globalThis.fetch = original }
})

test('rapid generation clicks share one stable request key and one submission', async () => {
  let calls = 0, finish
  const response = new Promise(resolve => { finish = resolve })
  const submission = api.createRecreationSubmission('reference', { newKey: () => requestKey, create: async (_id, sent) => { calls++; assert.equal(sent.requestKey, requestKey); return response } })
  const first = submission.submit(body), second = submission.submit(body)
  assert.equal(first, second)
  assert.equal(calls, 1)
  assert.equal(submission.getPendingKey(), requestKey)
  finish({ job })
  assert.equal((await first).job.id, job.id)
  assert.equal(submission.getPendingKey(), '')
})

test('a lost receipt never automatically repeats paid generation and recovers by the exact request key', async () => {
  let submissions = 0, checks = 0, found = false
  const pending = []
  const submission = api.createRecreationSubmission('reference', {
    newKey: () => requestKey, onPending: key => pending.push(key),
    create: async () => { submissions++; throw new TypeError('Connection closed after submit') },
    list: async () => { checks++; return { jobs: found ? [job] : [{ ...job, requestKey: 'unrelated-key' }] } },
  })
  await assert.rejects(submission.submit(body), /Connection closed/)
  await assert.rejects(submission.submit(body), /Check the existing submission/)
  assert.equal(await submission.checkReceipt(), undefined)
  assert.equal(submission.getPendingKey(), requestKey)
  found = true
  assert.equal((await submission.checkReceipt()).id, job.id)
  assert.equal(submissions, 1)
  assert.equal(checks, 2)
  assert.deepEqual(pending, [requestKey, ''])
})

test('a restored pending request can only check its receipt until it is resolved', async () => {
  let submissions = 0
  const submission = api.createRecreationSubmission('reference', { pendingKey: requestKey, create: async () => { submissions++; return { job } }, list: async () => ({ jobs: [job] }) })
  await assert.rejects(submission.submit(body), /Check the existing submission/)
  assert.equal(submissions, 0)
  assert.equal((await submission.checkReceipt()).requestKey, requestKey)
  assert.equal(submission.getPendingKey(), '')
})

test('an explicit resubmission uses the original prompts and request key after a preflight failure', async () => {
  let keys = 0
  const sent = [], pending = []
  const originalBody = { ...body, shots: [{ index: 0, prompt: 'Preserve this reviewed prompt.' }] }
  const submission = api.createRecreationSubmission('reference', {
    newKey: () => { keys++; return requestKey }, onPending: (key, request) => pending.push({ key, request }),
    create: async (_id, request) => { sent.push(request); if (sent.length === 1) throw new Error('Video provider is not configured.'); return { job } },
  })
  await assert.rejects(submission.submit(originalBody), /not configured/)
  assert.equal(submission.canResume(), true)
  assert.equal(sent.length, 1)
  await assert.rejects(submission.submit({ ...body, shots: [{ index: 0, prompt: 'An accidental change.' }] }), /Check the existing/)
  assert.equal((await submission.resume()).job.id, job.id)
  assert.equal(keys, 1)
  assert.deepEqual(sent, [{ ...originalBody, requestKey }, { ...originalBody, requestKey }])
  assert.deepEqual(pending[0], { key: requestKey, request: originalBody })
  assert.equal(submission.canResume(), false)
})

test('restoring a pending payload supports an intentional same-request resubmission without a new key', async () => {
  const sent = []
  const submission = api.createRecreationSubmission('reference', { pendingKey: requestKey, pendingBody: body, newKey: () => { throw new Error('Must retain request key') }, create: async (_id, request) => { sent.push(request); return { job } } })
  assert.equal(submission.canResume(), true)
  await submission.resume()
  assert.deepEqual(sent, [{ ...body, requestKey }])
})

test('an unverifiable generation receipt stays pending instead of permitting a duplicate', async () => {
  const submission = api.createRecreationSubmission('reference', { newKey: () => requestKey, create: async () => ({ job: { ...job, requestKey: 'wrong-key' } }) })
  await assert.rejects(submission.submit(body), /receipt could not be verified/)
  assert.equal(submission.getPendingKey(), requestKey)
  await assert.rejects(submission.submit(body), /Check the existing submission/)
})

test('clip progress shows every stage and uncertain submissions remain explicit', () => {
  const statuses = ['queued', 'generating', 'downloading', 'completed', 'failed', 'submission_unknown']
  const value = { ...job, status: 'submission_unknown', clips: clips.map((clip, index) => ({ ...clip, status: statuses[index] })) }
  const html = ui.renderToStaticMarkup(ui.RecreationJobProgress({ job: value }))
  for (const text of ['Queued', 'Generating', 'Downloading', 'Completed', 'Failed', 'Submission needs checking']) assert.ok(html.includes(text), text)
  assert.match(html, /1 \/ 6 clips ready/)
  assert.match(html, /will not be submitted again automatically/)
  assert.equal(api.recreationStatusLabel('rendering'), 'Assembling')
  assert.equal(api.isRecreationRunning({ ...job, status: 'completed' }), false)
  assert.equal(api.isRecreationRunning(job), true)
})

test('paused recreations remain inactive until an explicit resume checks the existing saved job', async () => {
  const paused = { ...job, status: 'paused', retryable: true }
  assert.equal(api.isRecreationRunning(paused), false)
  assert.equal(api.recreationStatusLabel(paused.status), 'Status checks paused')
  const html = ui.renderToStaticMarkup(ui.RecreationJobProgress({ job: paused }))
  assert.match(html, /Status checks paused/)
  assert.match(html, /check its existing clips and continue the original plan/)
  const original = globalThis.fetch, requests = []
  globalThis.fetch = async (url, options) => {
    requests.push({ url, method: options.method, body: JSON.parse(options.body) })
    return new Response(JSON.stringify({ job }), { status: 202 })
  }
  try {
    const resumed = await api.resumeRecreation(paused.id)
    assert.equal(resumed.job.id, paused.id)
    assert.equal(api.isRecreationRunning(resumed.job), true)
    assert.deepEqual(requests, [{ url: '/api/creator-agent/video-analysis/reconstructions/job-one/resume', method: 'POST', body: {} }])
  } finally { globalThis.fetch = original }
})

test('stale job polls cannot overwrite newer progress or discard a just-created recreation', () => {
  const complete = { ...job, status: 'completed', updatedAt: '2026-11-12T10:02:00Z' }
  assert.equal(api.mergeRecreationJobs([complete], [job])[0].status, 'completed')
  assert.equal(api.mergeRecreationJobs([job], [complete])[0].status, 'completed')
  assert.equal(api.mergeRecreationJobs([complete], []).length, 1)
})

test('MP4 previews and downloads fetch the authenticated private route and reject provider URLs', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/creator-agent/video-analysis/reconstructions/https%3A%2F%2Fprovider.example%2Fprivate.mp4/media')
    assert.equal(options.redirect, 'error')
    assert.equal(options.cache, 'no-store')
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'video/mp4' } })
  }
  try { assert.deepEqual([...new Uint8Array(await (await api.getRecreationMedia('https://provider.example/private.mp4')).arrayBuffer())], [1, 2, 3]) }
  finally { globalThis.fetch = original }
})

test('private media errors and unexpected content never become a playable video', async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'This recreation belongs to another workspace.' }), { status: 404 })
    await assert.rejects(api.getRecreationMedia('private'), /another workspace/)
    globalThis.fetch = async () => new Response('<html>Login</html>', { headers: { 'content-type': 'text/html' } })
    await assert.rejects(api.getRecreationMedia('private'), /did not return an MP4/)
  } finally { globalThis.fetch = original }
})

test('private media cancellation remains active while the MP4 body is being read', async () => {
  const original = globalThis.fetch, controller = new AbortController()
  let started
  const reading = new Promise(resolve => { started = resolve })
  globalThis.fetch = async (_url, options) => ({ ok: true, headers: new Headers({ 'content-type': 'video/mp4' }), blob: () => new Promise((_resolve, reject) => { options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }); started() }) })
  try {
    const request = api.getRecreationMedia('private', controller.signal)
    await reading; controller.abort()
    await assert.rejects(request, { name: 'AbortError' })
  } finally { globalThis.fetch = original }
})
