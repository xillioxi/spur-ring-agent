import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeAudioEvents, discoverAudioEventCapabilities, parseAudioEvents } from './audio-events.mjs'

const document = events => ({ durationSeconds: 3, windowSeconds: 0.975, hopSeconds: 0.48, windowCount: 7, threshold: 0.25, events })
const event = (startSeconds, endSeconds, label = 'Music', confidence = 0.6) => ({ startSeconds, endSeconds, label, confidence })

test('sound events merge only overlapping same-label waveform predictions and retain simultaneous classes', () => {
  const result = parseAudioEvents(document([
    event(0, 0.975), event(0.48, 1.455, 'Music', 0.85), event(0.48, 1.455, 'Speech', 0.7),
    event(2.4, 3, 'Music', 0.4),
  ]))
  assert.deepEqual(result.events, [
    event(0, 1.455, 'Music', 0.85), event(0.48, 1.455, 'Speech', 0.7), event(2.4, 3, 'Music', 0.4),
  ])
  assert.equal(result.confidenceAggregation, 'maximum_over_overlapping_windows')
})

test('empty model predictions remain empty rather than acquiring generic speech or music labels', () => {
  assert.deepEqual(parseAudioEvents(document([])).events, [])
})

test('semantic results require bounded actual audio timing, known framing and valid model scores', () => {
  for (const value of [
    null, { ...document([]), durationSeconds: 301 }, { ...document([]), windowCount: 626 },
    { ...document([]), hopSeconds: 1 }, { ...document([]), threshold: 0 },
    document([event(-1, 0)]), document([event(0, 2)]), document([event(2.4, 4)]),
    document([event(0, 0.975, 'Music', NaN)]), document([event(0, 0.975, 'Music', 1.1)]),
    document([event(0, 0.975, 'Music', 0.1)]), document([event(0, 0.975, '\nMusic')]),
  ]) assert.throws(() => parseAudioEvents(value), /audio classifier returned invalid/)
})

test('missing local waveform model is unavailable without executing inference or inventing labels', async () => {
  const capability = await discoverAudioEventCapabilities({})
  assert.equal(capability.available, false)
  assert.equal(capability.local, true)
  const result = await analyzeAudioEvents({ config: {} })
  assert.equal(result.status, 'unavailable')
  assert.deepEqual(result.events, [])
  assert.match(result.limitations.join(' '), /not configured/)
})

test('aborted audio work is cancelled before dependency checks or local media reads', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(discoverAudioEventCapabilities({}, { signal: controller.signal }), /cancelled/)
  await assert.rejects(analyzeAudioEvents({ signal: controller.signal }), /cancelled/)
})

test('a full five minute model result has bounded grouping and no extrapolation beyond the waveform', () => {
  const events = Array.from({ length: 625 }, (_, index) => event(index * 0.48, Math.min(300, index * 0.48 + 0.975), 'Music', 0.7))
  const result = parseAudioEvents({ ...document(events), durationSeconds: 300, windowCount: 625 })
  assert.deepEqual(result.events, [event(0, 300, 'Music', 0.7)])
})
