import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, stat, rm, realpath, symlink, utimes, rename, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createReelWorkspace } from './workspace.mjs'
import { createReelTools } from './tools.mjs'
import { main } from './cli.mjs'

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'spur-reel-workspace-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, 'media')); await mkdir(path.join(root, 'analysis'))
  await writeFile(path.join(root, 'media', 'a.mp4'), 'synthetic bytes; never passed as real footage')
  await writeFile(path.join(root, 'media', 'unused.mp4'), 'not analyzed')
  await writeFile(path.join(root, 'project.json'), JSON.stringify({ schemaVersion: 1, assets: [{ id: 'a', file: 'a.mp4' }, { id: 'unused', file: 'unused.mp4' }] }))
  const info = await stat(path.join(root, 'media', 'a.mp4'))
  await writeFile(path.join(root, 'analysis', 'a.json'), JSON.stringify({ assetId: 'a', source: { filePath: await realpath(path.join(root, 'media', 'a.mp4')), size: info.size, mtimeMs: info.mtimeMs },
    analysis: { status: 'synthetic_test_fixture', metadata: { durationSeconds: 5, hasVideo: true, hasAudio: false } } }))
  const reference = { id: 'ref', source: { url: 'https://example.com/fixture', title: 'Synthetic test fixture, not real observations' }, durationSeconds: 2,
    analysis: { method: 'synthetic_test_fixture', version: '1' },
    segments: [{ id: 'first', startSeconds: 0, endSeconds: .5, observations: { visual: 'Test fixture only' }, features: { shotDurationSeconds: .5 } },
      { id: 'second', startSeconds: .5, endSeconds: 2, observations: { visual: 'Test fixture only' }, features: { shotDurationSeconds: 1.5 } }] }
  return { root, reference, workspace: createReelWorkspace({ root, ffmpegPath: path.join(root, 'absent-ffmpeg'), ffprobePath: path.join(root, 'absent-ffprobe') }) }
}
test('workspace imports, reloads, searches timed evidence and plans using only selected registered assets', async t => {
  const { root, reference, workspace } = await fixture(t)
  await workspace.importReference(reference)
  const fresh = createReelWorkspace({ root })
  assert.equal((await fresh.references())[0].id, 'ref')
  const results = await fresh.search({ features: { shotDurationSeconds: 1.4 }, limit: 1 })
  assert.equal(results.mode, 'numeric_only'); assert.equal(results.results[0].segment.id, 'second')
  assert.equal(results.results[0].semanticCosine, null)
  const plan = await fresh.plan({ referenceId: 'ref', shots: [{ assetId: 'a', sourceStartSeconds: 0 }, { assetId: 'a', sourceStartSeconds: 1 }] })
  assert.deepEqual(plan.shots.map(shot => shot.durationSeconds), [.5, 1.5])
  assert.equal((await fresh.timing()).referenceCount, 1)
  assert.deepEqual((await fresh.assets()).map(asset => [asset.id, asset.status]), [['a', 'synthetic_test_fixture'], ['unused', 'not_analyzed']])
  assert.equal(Object.hasOwn((await fresh.assets())[0], 'filePath'), false)
})
test('changed footage invalidates cached metadata before planning', async t => {
  const { root, reference, workspace } = await fixture(t)
  await workspace.importReference(reference)
  await writeFile(path.join(root, 'media', 'a.mp4'), 'different fixture bytes, not real footage')
  await assert.rejects(workspace.plan({ referenceId: 'ref', shots: [{ assetId: 'a' }, { assetId: 'a' }] }), /changed/)
  assert.equal((await workspace.assets())[0].status, 'changed')
})
test('remapping an asset invalidates cached analysis even with identical size and timestamps', async t => {
  const { root, reference, workspace } = await fixture(t)
  await workspace.importReference(reference)
  const original = path.join(root, 'media', 'a.mp4'), replacement = path.join(root, 'media', 'other.mp4')
  const info = await stat(original)
  await writeFile(replacement, await readFile(original)); await utimes(replacement, info.atime, info.mtime)
  await writeFile(path.join(root, 'project.json'), JSON.stringify({ schemaVersion: 1, assets: [{ id: 'a', file: 'other.mp4' }] }))
  assert.equal((await workspace.assets())[0].status, 'changed')
  await assert.rejects(workspace.plan({ referenceId: 'ref', shots: [{ assetId: 'a' }, { assetId: 'a' }] }), /changed/)
})
test('cached metadata cannot override registered asset identity or expose paths in asset listing', async t => {
  const { root, reference, workspace } = await fixture(t)
  await workspace.importReference(reference)
  const cachePath = path.join(root, 'analysis', 'a.json')
  const cache = JSON.parse(await readFile(cachePath, 'utf8'))
  cache.analysis.metadata.id = 'intruder'; cache.analysis.metadata.filePath = path.resolve(root, '..', 'outside.mp4')
  await writeFile(cachePath, JSON.stringify(cache))
  const plan = await workspace.plan({ referenceId: 'ref', shots: [{ assetId: 'a' }, { assetId: 'a' }] })
  assert.equal(plan.shots[0].assetId, 'a')
  assert.equal(Object.hasOwn((await workspace.assets())[0].metadata, 'filePath'), false)
})
test('media folder junctions cannot select a library outside the workspace', async t => {
  const { root, workspace } = await fixture(t)
  const outside = await mkdtemp(path.join(os.tmpdir(), 'spur-reel-outside-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await rename(path.join(root, 'media'), path.join(root, 'old-media'))
  try { await symlink(outside, path.join(root, 'media'), process.platform === 'win32' ? 'junction' : 'dir') }
  catch (error) { if (error.code === 'EPERM') return t.skip('Directory links unavailable'); throw error }
  await assert.rejects(workspace.assets(), /outside the workspace/)
})
test('missing binaries produce no observations and reanalysis can replace its own cache', async t => {
  const { workspace } = await fixture(t)
  const first = await workspace.analyze({ assetId: 'a' })
  const second = await workspace.analyze({ assetId: 'a' })
  assert.equal(first.analysis.status, 'unavailable')
  assert.equal(second.analysis.metadata, null)
  assert.deepEqual(second.analysis.sections, [])
  assert.deepEqual(await workspace.references(), [])
})
test('JSON paths and asset registration reject workspace escapes and output replacement', async t => {
  const { root, workspace } = await fixture(t)
  await assert.rejects(workspace.readWorkspaceJson('../outside.json'), /workspace-relative/)
  await assert.rejects(workspace.writeWorkspaceJson('../outside.json', {}), /workspace-relative/)
  await workspace.writeWorkspaceJson('export.json', { ok: true })
  await assert.rejects(workspace.writeWorkspaceJson('export.json', {}), /EEXIST/)
  await writeFile(path.join(root, 'project.json'), JSON.stringify({ schemaVersion: 1, assets: [{ id: 'escape', file: '../project.json' }] }))
  await assert.rejects(workspace.assets(), /approved library/)
})
test('host grants gate mutation/render and tool adapter supports the real persistence flow', async t => {
  const { root, reference } = await fixture(t)
  const reader = createReelTools({ root })
  assert.equal(reader.catalog().find(tool => tool.name === 'reel_import_reference').enabled, false)
  await assert.rejects(reader.execute('reel_import_reference', { input: JSON.stringify(reference) }), /not granted/)
  const writer = createReelTools({ root, allowWrites: true })
  await writer.execute('reel_import_reference', { input: JSON.stringify(reference) })
  assert.equal((await reader.execute('reel_reference', { input: '{"id":"ref"}' })).segments.length, 2)
  await assert.rejects(writer.execute('reel_render', { input: '{}' }), /not granted/)
  await assert.rejects(reader.execute('reel_reference', { input: '[]' }), /must be an object/)
})
test('CLI uses the same stored evidence and rejects unknown command/options', async t => {
  const { root, workspace, reference } = await fixture(t)
  await workspace.importReference(reference)
  assert.equal((await main(['references', '--workspace', root]))[0].id, 'ref')
  await assert.rejects(main(['unknown']), /Commands/)
  await assert.rejects(main(['references', '--workspace', root, '--root', root]), /Unknown option/)
})
