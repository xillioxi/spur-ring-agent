import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createChannelAnalysisManager, uniqueSavedChannelVideos } from './channel-analyses.mjs'

const items = count => Array.from({ length: count }, () => ({ id: randomUUID(), hasMedia: true, source: { kind: 'upload' }, updatedAt: '2026-11-12T00:00:00Z' }))
async function fixture(t) { const root = await mkdtemp(join(process.cwd(), '.spur-channel-analysis-test-')); t.after(() => rm(root, { recursive: true, force: true })); return root }

test('saved media batches exceed queue size without parallel inference and retain partial and failed outcomes', async t => {
  const root = await fixture(t); let calls = 0, active = 0, peak = 0
  const manager = createChannelAnalysisManager({ root, getItems: async () => items(35), analyzeOne: async () => {
    calls++; active++; peak = Math.max(peak, active); await Promise.resolve(); active--
    return calls === 4 ? { status: 'failed', error: 'Unreadable video', hasResult: true } : { status: calls === 5 ? 'partial' : 'complete', hasResult: true, skipped: calls <= 2 }
  } })
  const receipt = await manager.start('tiktok-creator')
  assert.equal(receipt.total, 35)
  assert.equal(receipt.scriptTemplateId, 'none')
  await manager.whenIdle()
  const result = await manager.get('tiktok-creator')
  assert.equal(calls, 35); assert.equal(peak, 1); assert.equal(result.status, 'complete')
  assert.equal(result.analyzed, 32); assert.equal(result.partial, 1); assert.equal(result.skipped, 2); assert.equal(result.failed, 1); assert.equal(result.processed, 35)
  assert.equal(result.failures[0].error, 'Unreadable video'); assert.equal(result.entries, undefined)
  assert.equal((await createChannelAnalysisManager({ root }).get('tiktok-creator')).processed, 35)
  assert.equal(await manager.get('tiktok-other'), null)
})

test('stop waits for the current analysis and repeated starts are idempotent', async t => {
  const root = await fixture(t); let release, started, calls = 0
  const held = new Promise(resolve => release = resolve), entered = new Promise(resolve => started = resolve)
  const manager = createChannelAnalysisManager({ root, getItems: async () => items(30), analyzeOne: async () => { calls++; started(); await held; return { status: 'complete', hasResult: true } } })
  const first = await manager.start('tiktok-creator'); await entered
  assert.equal((await manager.start('tiktok-creator')).id, first.id)
  await assert.rejects(manager.start('tiktok-other'), { status: 409 })
  assert.equal((await manager.stop('tiktok-creator')).status, 'stopping')
  release(); await manager.whenIdle()
  assert.equal(calls, 1); assert.equal((await manager.get()).status, 'cancelled'); assert.equal((await manager.get()).analyzed, 1)
})

test('bulk analysis freezes template selection, persists only its ID and rejects changes to a running batch', async t => {
  const root = await fixture(t), seen = []
  let release, started
  const held = new Promise(resolve => release = resolve), entered = new Promise(resolve => started = resolve)
  const context = { id: 'local', scriptTemplateId: 'auto', scriptTemplateRevision: 'source-v1', config: { apiKey: 'synthetic-private-key' } }
  const manager = createChannelAnalysisManager({ root, getItems: async () => items(2), analyzeOne: async (_id, _channel, selection) => {
    seen.push(selection)
    if (seen.length === 1) { started(); await held }
    return { status: 'complete', hasResult: true }
  } })
  const first = await manager.start('tiktok-creator', { analysisModelId: 'local', scriptTemplateId: 'xc-1', context })
  try {
    await entered
    assert.equal(first.scriptTemplateId, 'xc-1')
    assert.equal((await manager.start('tiktok-creator', { analysisModelId: 'local', scriptTemplateId: 'xc-1', context })).id, first.id)
    await assert.rejects(manager.start('tiktok-creator', { analysisModelId: 'local', scriptTemplateId: 'xc-2', context }), { status: 409 })
    context.scriptTemplateId = 'xc-2'; context.scriptTemplateRevision = 'changed-after-start'
    assert.equal(seen[0].scriptTemplateId, 'xc-1')
    assert.equal(seen[0].scriptTemplateRevision, 'source-v1')
    assert.equal(Object.isFrozen(seen[0]), true)
    const data = JSON.parse(await readFile(join(root, 'channel-analysis-job.json'), 'utf8'))
    assert.equal(data.job.scriptTemplateId, 'xc-1')
    assert.equal(JSON.stringify(data).includes('synthetic-private-key'), false)
  } finally { release(); await manager.whenIdle() }
  assert.equal(seen.length, 2)
  assert.equal(seen[1].scriptTemplateId, 'xc-1')
  assert.equal(seen[1].scriptTemplateRevision, 'source-v1')
  assert.equal((await createChannelAnalysisManager({ root }).get('tiktok-creator')).scriptTemplateId, 'xc-1')
})

test('temporary failures pause at a durable checkpoint and restarts never resume inference automatically', async t => {
  const root = await fixture(t)
  const manager = createChannelAnalysisManager({ root, getItems: async () => items(3), analyzeOne: async () => { throw Object.assign(new Error('Analyzer unavailable'), { status: 503 }) } })
  await manager.start('tiktok-creator'); await manager.whenIdle()
  assert.equal((await manager.get()).status, 'paused'); assert.equal((await manager.get()).processed, 0)
  const filename = join(root, 'channel-analysis-job.json'), data = JSON.parse(await readFile(filename, 'utf8'))
  data.job.status = 'running'; await writeFile(filename, JSON.stringify(data))
  let calls = 0
  const restored = createChannelAnalysisManager({ root, analyzeOne: async () => { calls++ } })
  assert.equal((await restored.get()).status, 'paused'); assert.match((await restored.get()).message, /restart/); assert.equal(calls, 0)
})

test('bulk workflow identity cannot change underneath a running batch', async t => {
  const root = await fixture(t), seen = []
  let release, entered
  const held = new Promise(resolve => release = resolve), started = new Promise(resolve => entered = resolve)
  const manager = createChannelAnalysisManager({ root, getItems: async () => items(1), analyzeOne: async (_id, _channel, selection) => { seen.push(selection); entered(); await held; return { status: 'partial', hasResult: true } } })
  const selection = { workflowId: 'rea-video', workflowRevision: 'pinned', config: { apiKey: 'not-to-be-persisted' } }
  const first = await manager.start('tiktok-creator', { analysisModelId: null, analysisWorkflowId: 'rea-video', context: selection })
  try {
    await started
    assert.equal(first.analysisWorkflowId, 'rea-video')
    assert.equal((await manager.start('tiktok-creator', { analysisModelId: null, analysisWorkflowId: 'rea-video', context: selection })).id, first.id)
    await assert.rejects(manager.start('tiktok-creator', { analysisModelId: null, analysisWorkflowId: 'standard', context: selection }), { status: 409 })
    assert.equal(seen[0].workflowId, 'rea-video'); assert.equal(seen[0].workflowRevision, 'pinned')
    assert.doesNotMatch(await readFile(join(root, 'channel-analysis-job.json'), 'utf8'), /not-to-be-persisted|apiKey/)
  } finally { release(); await manager.whenIdle() }
  assert.equal((await createChannelAnalysisManager({ root }).get()).analysisWorkflowId, 'rea-video')
})

test('snapshots deduplicate retried URL references and ignore media-less discovered videos', async () => {
  const base = items(1)[0], url = 'https://www.tiktok.com/@creator/video/7014215295795498245'
  const old = { ...base, source: { kind: 'url', url: `${url}?lang=en` }, status: 'failed' }
  const completed = { ...base, id: randomUUID(), source: { kind: 'url', url }, status: 'complete', hasResult: true }
  const latestFailed = { ...old, id: randomUUID(), updatedAt: '2026-11-13T00:00:00Z' }
  assert.deepEqual(uniqueSavedChannelVideos([old, completed, latestFailed, { ...items(1)[0], hasMedia: false }]), [completed])
  assert.equal(uniqueSavedChannelVideos([{ ...old, source: { kind: 'url', url: 'https://instagram.com/reel/REF/' } }, { ...completed, source: { kind: 'url', url: 'https://www.instagram.com/p/REF/?igsh=share' } }]).length, 1)
})
