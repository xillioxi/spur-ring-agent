import test from 'node:test'
import assert from 'node:assert/strict'
import { createReelPlan, summarizeReferenceTiming } from './plan.mjs'
import { buildRenderArgs } from './render.mjs'
import path from 'node:path'

const reference = { id: 'hotel-01', source: { url: 'https://example.com/reference', title: 'Timing fixture, not a real analyzed video' }, durationSeconds: 6,
  segments: [{ id: 'a', startSeconds: 0, endSeconds: 1 }, { id: 'b', startSeconds: 1, endSeconds: 3 }, { id: 'c', startSeconds: 3, endSeconds: 6 }] }
const assets = [{ id: 'footage', filePath: path.resolve('footage.mp4'), durationSeconds: 30, hasVideo: true, hasAudio: false },
  { id: 'music', filePath: path.resolve('music.wav'), durationSeconds: 60, hasVideo: false, hasAudio: true }]
const shots = [0, 4, 8].map(sourceStartSeconds => ({ assetId: 'footage', sourceStartSeconds }))

test('ordered reference rhythm transfers without inventing semantic shot labels', () => {
  const plan = createReelPlan({ reference, assets, shots, targetDurationSeconds: 12, music: { assetId: 'music' } })
  assert.deepEqual(plan.shots.map(shot => shot.durationSeconds), [2, 4, 6])
  assert.deepEqual(plan.shots.map(shot => shot.sourceStartSeconds), [0, 4, 8])
  assert.equal(plan.provenance.referenceId, reference.id)
  assert.equal(plan.provenance.timingScale, 2)
  assert.equal(plan.music.gainDb, 0)
  assert.ok(plan.limitations.some(text => text.includes('No visual style')))
  assert.ok(buildRenderArgs({ plan, assets, outputPath: path.resolve('new-reel.mp4') }).includes('[vout]'))
})
test('frame quantization preserves total duration and is accepted by renderer', () => {
  const plan = createReelPlan({ reference, assets, shots, targetDurationSeconds: 5.17 })
  assert.equal(plan.durationSeconds, 155 / 30)
  assert.ok(plan.shots.every(shot => Math.abs(shot.durationSeconds * 30 - Math.round(shot.durationSeconds * 30)) < 1e-8))
  assert.doesNotThrow(() => buildRenderArgs({ plan, assets, outputPath: path.resolve('new-reel.mp4') }))
})
test('rejects insufficient footage, short music, missing shots, overlapping reference sections and bad canvas', () => {
  assert.throws(() => createReelPlan({ reference, assets, shots: shots.slice(1) }), /one footage range/)
  assert.throws(() => createReelPlan({ reference, assets, shots: shots.map(shot => ({ ...shot, sourceStartSeconds: 29 })) }), /too short/)
  assert.throws(() => createReelPlan({ reference, assets, shots, music: { assetId: 'music', sourceStartSeconds: 59 } }), /complete reel/)
  assert.throws(() => createReelPlan({ reference: { ...reference, segments: reference.segments.map((s, i) => i === 1 ? { ...s, startSeconds: .5 } : s) }, assets, shots }), /contiguous/)
  assert.throws(() => createReelPlan({ reference, assets, shots, canvas: { width: 1081, height: 1920, fps: 30 } }), /even integers/)
})
test('timing summary keeps individual examples instead of imposing an averaged template', () => {
  const summary = summarizeReferenceTiming([reference])
  assert.deepEqual(summary.examples[0].orderedDurationsSeconds, [1, 2, 3])
  assert.equal(summary.segmentDurationSeconds.median, 2)
  assert.equal(summary.referenceCount, 1)
  assert.equal(summarizeReferenceTiming([]).segmentDurationSeconds.median, null)
})
