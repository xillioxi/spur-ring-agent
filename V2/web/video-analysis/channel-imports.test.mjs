import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createChannelImportManager } from './channel-imports.mjs'

const videos = count => Array.from({ length: count }, (_, i) => ({ url: `https://www.tiktok.com/@creator/video/${7014215295795498000n + BigInt(i)}`, durationSeconds: 20 }))
async function fixture(t) { const root = await mkdtemp(join(process.cwd(), '.spur-bulk-test-')); t.after(() => rm(root, { recursive: true, force: true })); return root }

test('a channel larger than the queue imports serially, skips saved files and continues after individual failures', async t => {
  const root = await fixture(t); let calls = 0, active = 0, peak = 0
  const manager = createChannelImportManager({ root, getChannel: async () => ({ discoveredVideos: videos(35), catalogComplete: false }), importOne: async () => {
    calls++; active++; peak = Math.max(active, peak); await Promise.resolve(); active--
    return calls === 5 ? { status: 'failed', error: 'Private video' } : { id: `item-${calls}`, status: 'ready', skipped: calls <= 3 }
  } })
  assert.equal((await manager.start('tiktok-creator')).total, 35)
  await manager.whenIdle()
  const result = await manager.get('tiktok-creator')
  assert.equal(peak, 1); assert.equal(calls, 35); assert.equal(result.status, 'complete')
  assert.equal(result.imported, 31); assert.equal(result.skipped, 3); assert.equal(result.failed, 1); assert.equal(result.processed, 35)
  assert.equal(result.coverageComplete, false); assert.equal(result.entries, undefined); assert.equal(result.failures[0].error, 'Private video')
  const reloaded = createChannelImportManager({ root })
  assert.equal((await reloaded.get('tiktok-creator')).processed, 35)
})

test('repeated starts do not duplicate work and stop finishes only the current video', async t => {
  const root = await fixture(t); let release, started
  const held = new Promise(resolve => release = resolve), entered = new Promise(resolve => started = resolve)
  let calls = 0
  const manager = createChannelImportManager({ root, getChannel: async () => ({ discoveredVideos: videos(30) }), importOne: async () => { calls++; started(); await held; return { id: 'one', status: 'ready' } } })
  const first = await manager.start('tiktok-creator'); await entered
  assert.equal((await manager.start('tiktok-creator')).id, first.id)
  await assert.rejects(manager.start('instagram-other'), { status: 409 })
  assert.equal((await manager.stop('tiktok-creator')).status, 'stopping')
  release(); await manager.whenIdle()
  assert.equal(calls, 1); const result = await manager.get('tiktok-creator')
  assert.equal(result.status, 'cancelled'); assert.equal(result.imported, 1); assert.equal(result.processed, 1)
})

test('capacity and rate limits pause pending entries instead of reporting an entire channel imported', async t => {
  for (const status of [429, 507]) {
    const root = await fixture(t); let calls = 0
    const manager = createChannelImportManager({ root, getChannel: async () => ({ discoveredVideos: videos(5) }), importOne: async () => { calls++; if (calls === 2) throw Object.assign(new Error('Limit reached'), { status }); return { id: 'first', status: 'ready' } } })
    await manager.start('tiktok-creator'); await manager.whenIdle()
    const result = await manager.get('tiktok-creator')
    assert.equal(calls, 2); assert.equal(result.status, 'paused'); assert.equal(result.processed, 1); assert.equal(result.imported, 1)
    const file = JSON.parse(await readFile(join(root, 'channel-import-job.json'), 'utf8'))
    assert.equal(file.job.entries[1].status, 'pending')
  }
})

test('a restart exposes interrupted work as resumable without downloading automatically', async t => {
  const root = await fixture(t)
  await writeFile(join(root, 'channel-import-job.json'), JSON.stringify({ schemaVersion: 1, job: { id: 'interrupted', channelId: 'tiktok-creator', status: 'running', entries: videos(2).map(value => ({ ...value, status: 'pending' })), createdAt: '2026-11-12T00:00:00Z', updatedAt: '2026-11-12T00:00:00Z' } }))
  let calls = 0
  const manager = createChannelImportManager({ root, importOne: async () => { calls++ } })
  const result = await manager.get('tiktok-creator')
  assert.equal(result.status, 'paused'); assert.match(result.message, /restart/); assert.equal(calls, 0)
})
