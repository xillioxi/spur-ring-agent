import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { createReelIndex } from './index.mjs'

async function workspace(t) {
  const prefix = join(resolve(tmpdir()), 'spur-reel-index-')
  const root = await mkdtemp(prefix)
  t.after(async () => {
    assert.ok(resolve(root).startsWith(prefix) && resolve(root).startsWith(resolve(tmpdir()) + sep))
    await rm(root, { recursive: true, force: true })
  })
  return root
}

const vector = (values, model = 'test-video-embedding', version = '1') => ({ model, version, dimensions: values.length, values })
function reference(id, values = [1, 0], measured = { shotDurationSeconds: 2, cameraMotion: 0.5 }) {
  return { id, source: { url: `https://example.com/videos/${id}`, title: `Reference ${id}` }, durationSeconds: 10,
    analysis: { method: 'manual_import', version: '1', notes: 'Test descriptions, not an actual video analysis.' },
    segments: [{ id: 'opening', startSeconds: 0, endSeconds: 2,
      observations: { visual: 'Wide shot of the property.', audio: 'Music continues over the opening cut.' }, features: measured,
      ...(values ? { embedding: vector(values) } : {}) },
    { id: 'detail', startSeconds: 2, endSeconds: 5, observations: { visual: 'Detail shot.' }, features: { shotDurationSeconds: 3 } }] }
}

test('timed multimodal evidence and vector provenance survive a reload without inventing embeddings', async t => {
  const root = await workspace(t), index = createReelIndex({ root })
  const created = await index.upsertReference(reference('first'))
  const fresh = createReelIndex({ root })
  assert.deepEqual(await fresh.getReference('first'), created)
  assert.deepEqual(created.segments.map(item => item.id), ['opening', 'detail'])
  assert.equal(created.segments[1].embedding, undefined)
  assert.equal((await fresh.listReferences())[0].segmentCount, 2)
  assert.deepEqual(await fresh.listEmbeddingSpaces(), [{ model: 'test-video-embedding', version: '1', dimensions: 2, segmentCount: 1 }])
  const changed = await fresh.upsertReference({ ...reference('first'), source: { url: 'https://example.com/new', title: 'Changed' } })
  assert.equal(changed.createdAt, created.createdAt)
  assert.equal((await index.listReferences()).length, 1)
  const disk = JSON.parse(await readFile(join(root, 'reels', 'reference-index.json'), 'utf8'))
  assert.equal(disk.schemaVersion, 1)
})

test('semantic cosine ranks compatible vectors and retains the source, timing and separate numeric diagnostics', async t => {
  const index = createReelIndex({ root: await workspace(t) })
  await index.upsertReference(reference('same', [1, 0]))
  await index.upsertReference(reference('near', [1, 1]))
  await index.upsertReference(reference('opposite', [-1, 0]))
  const incompatible = reference('other', [1, 0]); incompatible.segments[0].embedding.version = '2'
  await index.upsertReference(incompatible)
  const result = await index.search({ embedding: vector([1, 0]), features: { shotDurationSeconds: 3 }, limit: 3 })
  assert.equal(result.mode, 'semantic_with_numeric_diagnostics')
  assert.deepEqual(result.results.map(item => item.referenceId), ['same', 'near', 'opposite'])
  assert.equal(result.results[0].semanticCosine, 1)
  assert.ok(Math.abs(result.results[1].semanticCosine - Math.SQRT1_2) < 1e-12)
  assert.equal(result.results[2].semanticCosine, -1)
  assert.equal(result.results[0].numericDistance, 1 / 3)
  assert.equal(result.results[0].source.url, 'https://example.com/videos/same')
  assert.equal(result.results[0].segment.startSeconds, 0)
  assert.equal(result.results[0].segment.observations.visual, 'Wide shot of the property.')
  assert.equal(result.incompatibleEmbeddingSegments, 5)
  assert.equal(result.results[0].segment.embedding, undefined)
  assert.match(result.notice, /not production quality/)
})

test('numeric-only search works without an embedder and penalizes missing requested measurements', async t => {
  const index = createReelIndex({ root: await workspace(t) })
  await index.upsertReference(reference('long', null, { shotDurationSeconds: 8, cameraMotion: 0.5 }))
  await index.upsertReference(reference('close', null, { shotDurationSeconds: 2, cameraMotion: 0.5 }))
  const result = await index.search({ features: { shotDurationSeconds: 2, cameraMotion: 0.5 } })
  assert.equal(result.mode, 'numeric_only')
  assert.equal(result.ranking, 'normalized_numeric_distance_ascending')
  assert.equal(result.results[0].referenceId, 'close')
  assert.equal(result.results[0].numericDistance, 0)
  assert.equal(result.results[0].semanticCosine, null)
  assert.ok(result.results.find(item => item.segment.id === 'detail').missingFeatures.includes('cameraMotion'))
  assert.equal((await index.search({ features: { unknownMetric: 10 } })).results.length, 0)
  assert.equal((await index.search({ features: { shotDurationSeconds: 2 }, referenceIds: ['long'] })).results.every(item => item.referenceId === 'long'), true)
})

test('different embedding model, version and dimensions never silently share a semantic space', async t => {
  const index = createReelIndex({ root: await workspace(t) })
  await index.upsertReference(reference('first'))
  for (const queryVector of [vector([1, 0], 'other'), vector([1, 0], 'test-video-embedding', '2'), vector([1, 0, 0])]) {
    const result = await index.search({ embedding: queryVector })
    assert.equal(result.matchingSegments, 0)
    assert.equal(result.incompatibleEmbeddingSegments, 2)
  }
})

test('invalid evidence, zero vectors, non-finite numbers and unknown path fields are rejected before storage', async t => {
  const index = createReelIndex({ root: await workspace(t) })
  const mutations = [
    value => { delete value.source.url },
    value => { delete value.analysis },
    value => { delete value.segments[0].observations },
    value => { value.segments[0].embedding = vector([0, 0]) },
    value => { value.segments[0].embedding.values[0] = Infinity },
    value => { value.segments[0].embedding.dimensions = 3 },
    value => { delete value.segments[0].embedding.version },
    value => { value.segments[0].features.shotDurationSeconds = NaN },
    value => { value.segments[0].endSeconds = 20 },
    value => { value.segments.reverse() },
    value => { value.segments[1].id = 'opening' },
    value => { value.root = 'elsewhere' },
    value => { value.source.url = 'file:///etc/passwd' },
  ]
  for (const mutate of mutations) {
    const value = reference('invalid'); mutate(value)
    await assert.rejects(index.upsertReference(value), error => error.status === 422)
  }
  assert.deepEqual(await index.listReferences(), [])
  await assert.rejects(index.search({}), error => error.code === 'missing_search_features')
  await assert.rejects(index.search({ embedding: vector([0, 0]) }), error => error.status === 422)
  await assert.rejects(index.search({ features: { shotDurationSeconds: 2 }, root: 'elsewhere' }), error => error.status === 422)
})

test('workspace roots are isolated and concurrent instances in the same host do not lose updates', async t => {
  const root = await workspace(t), otherRoot = await workspace(t)
  await Promise.all(Array.from({ length: 12 }, (_, index) => createReelIndex({ root }).upsertReference(reference(`video-${index}`))))
  assert.equal((await createReelIndex({ root }).listReferences()).length, 12)
  assert.deepEqual(await createReelIndex({ root: otherRoot }).listReferences(), [])
  await assert.rejects(createReelIndex({ root: otherRoot }).getReference('video-0'), error => error.status === 404)
})

test('corrupt persisted evidence is never silently replaced on a later import', async t => {
  const root = await workspace(t), index = createReelIndex({ root })
  await index.upsertReference(reference('first'))
  const file = join(root, 'reels', 'reference-index.json')
  await writeFile(file, '{bad json', 'utf8')
  await assert.rejects(index.upsertReference(reference('second')), error => error.code === 'invalid_index')
  assert.equal(await readFile(file, 'utf8'), '{bad json')
})
