import test from 'node:test'
import assert from 'node:assert/strict'
import { annotateAudioShots, buildAudioTimeline } from './audio-timeline.mjs'

const shots = boundaries => boundaries.slice(0, -1).map((startSeconds, index) => ({ index, startSeconds, endSeconds: boundaries[index + 1], visual: index % 2 ? null : 'An observed scene.' }))
const envelope = levels => ({ status: 'analyzed', windows: levels.map((rmsDb, index) => ({ startSeconds: index / 10, endSeconds: (index + 1) / 10, rmsDb })), beatCandidates: [] })

test('cloud audio descriptions survive alignment to retained visual cuts without becoming measurements', () => {
  const audio = buildAudioTimeline({
    durationSeconds: 3, shots: shots([0, 1, 3]), hasAudio: true,
    measurementAudio: envelope(Array(30).fill(-25)), speechStatus: 'analyzed', semanticStatus: 'analyzed',
    semanticDescription: 'Soft music with a sharp metallic click.',
    semanticSegments: [
      { startSeconds: 0, endSeconds: 3, description: 'Soft instrumental music.' },
      { startSeconds: 1.5, endSeconds: 2, description: 'A metallic click is audible.' },
      { startSeconds: -4, endSeconds: -1, description: 'Invalid interval must disappear.' },
    ],
    semanticEvents: [{ startSeconds: 1.5, endSeconds: 1.8, label: 'Metallic click', category: 'sfx', description: 'A brief metal-on-metal sound.' }],
    script: { segments: [{ startSeconds: 0.1, endSeconds: 0.8, text: 'Welcome.' }] },
  })
  assert.equal(audio.description, 'Soft music with a sharp metallic click.')
  assert.equal(audio.segments[0].description, 'Soft instrumental music.')
  assert.match(audio.segments[1].description, /metallic click/)
  assert.match(audio.segments[1].measurementDescription, /-25 dB RMS/)
  assert.equal(audio.segments[0].spokenText, 'Welcome.')
  assert.equal(audio.semanticSegments.length, 2)
  assert.equal(audio.semanticEvents[0].description, 'A brief metal-on-metal sound.')
  assert.equal(audio.semanticEvents[0].category, 'sfx')
  assert.equal(annotateAudioShots(shots([0, 1, 3]), audio)[1].audio, audio.segments[1].description)
  const noAudio = buildAudioTimeline({ durationSeconds: 3, hasAudio: false, semanticSegments: audio.semanticSegments, semanticDescription: audio.semanticDescription })
  assert.equal(noAudio.semanticSegments, undefined)
  assert.equal(noAudio.semanticDescription, undefined)
  assert.equal(noAudio.description, 'This file has no audio track.')
})

test('continuous audio is aligned with all cuts, including visually unsampled shots', () => {
  const inputShots = shots(Array.from({ length: 81 }, (_, index) => index / 10))
  const audio = buildAudioTimeline({ durationSeconds: 8, shots: inputShots, hasAudio: true, measurementAudio: envelope(Array.from({ length: 80 }, (_, index) => index === 79 ? -12 : -30)) })
  assert.equal(audio.status, 'analyzed')
  assert.equal(audio.segments.length, 80)
  assert.equal(audio.coverageFraction, 1)
  assert.deepEqual(audio.segments.map(segment => segment.shotIndex), inputShots.map(shot => shot.index))
  assert.equal(audio.segments[1].meanDb, -30)
  assert.equal(audio.segments.at(-1).meanDb, -12)
  assert.equal(audio.segments.at(-1).endSeconds, 8)
})

test('energy uses overlap weighted power, strongest window RMS is not a peak amplitude claim', () => {
  const audio = buildAudioTimeline({ durationSeconds: 0.2, shots: shots([0, 0.05, 0.2]), measurementAudio: envelope([-20, -40]) })
  assert.equal(audio.segments[0].meanDb, -20)
  assert.equal(audio.segments[1].meanDb, -24.685)
  assert.equal(audio.segments[1].peakWindowDb, -20)
  assert.equal(audio.meanDb, -22.967)
  assert.equal(audio.segments[1].coverageFraction, 1)
  assert.equal(audio.peakDb, undefined)
})

test('word midpoint assigns a word that straddles a cut once, exactly on the boundary goes to following shot', () => {
  const audio = buildAudioTimeline({
    durationSeconds: 3, shots: shots([0, 1, 2, 3]), measurementAudio: envelope(Array(30).fill(-25)), speechStatus: 'analyzed',
    script: { words: [
      { startSeconds: 0.2, endSeconds: 0.4, text: 'Hello' },
      { startSeconds: 0.8, endSeconds: 1.2, text: 'world.' },
      { startSeconds: 1.8, endSeconds: 2, text: '今天' },
      { startSeconds: 2, endSeconds: 2.2, text: '旅行。' },
    ], segments: [{ startSeconds: 0, endSeconds: 3, text: 'This fallback must not duplicate the words.' }] },
  })
  assert.deepEqual(audio.segments.map(segment => segment.spokenText), ['Hello', 'world. 今天', '旅行。'])
  assert.equal(audio.segments.map(segment => segment.spokenText).join(' ').match(/world\./g).length, 1)
  assert.doesNotMatch(audio.segments.map(segment => segment.spokenText).join(' '), /fallback/)
})

test('legacy segment timestamps use one midpoint assignment without copying sentences across cuts', () => {
  const audio = buildAudioTimeline({ durationSeconds: 4, shots: shots([0, 1, 2, 4]), measurementAudio: envelope(Array(40).fill(-30)), script: { segments: [
    { startSeconds: 0.2, endSeconds: 2.8, text: 'A sentence spanning several cuts.' },
    { startSeconds: 3, endSeconds: 4, text: 'The final sentence.' },
  ] } })
  assert.deepEqual(audio.segments.map(segment => segment.spokenText), ['', 'A sentence spanning several cuts.', 'The final sentence.'])
  assert.equal(audio.speechStatus, 'analyzed')
})

test('near silence, no track, and missing or failed measurements remain distinct', () => {
  const options = { durationSeconds: 0.2, shots: shots([0, 0.2]) }
  const silent = buildAudioTimeline({ ...options, hasAudio: true, speechStatus: 'unavailable', measurementAudio: envelope([-96, -55]) })
  assert.equal(silent.status, 'analyzed')
  assert.equal(silent.segments[0].status, 'silence')
  assert.equal(silent.segments[0].audibleFraction, 0)
  assert.match(silent.segments[0].description, /at or below -55 dB RMS/)
  assert.match(silent.segments[0].description, /Speech content is unknown/)
  assert.doesNotMatch(silent.segments[0].description, /no speech|no words/)

  const absent = buildAudioTimeline({ ...options, hasAudio: false, measurementAudio: envelope([-10, -10]), semanticEvents: [{ startSeconds: 0, endSeconds: 0.2, label: 'Music' }] })
  assert.equal(absent.status, 'no_audio')
  assert.equal(absent.speechStatus, 'no_audio')
  assert.equal(absent.segments[0].status, 'no_audio')
  assert.deepEqual(absent.windows, [])
  assert.deepEqual(absent.events, [])
  assert.equal(absent.meanDb, undefined)

  for (const measurementStatus of ['unavailable', 'failed']) {
    const result = buildAudioTimeline({ ...options, hasAudio: true, measurementAudio: { status: measurementStatus }, speechStatus: 'failed' })
    assert.equal(result.status, measurementStatus)
    assert.equal(result.segments[0].status, measurementStatus)
    assert.equal(result.segments[0].audibleFraction, undefined)
    assert.equal(result.segments[0].meanDb, undefined)
    assert.match(result.segments[0].description, /speech content is unknown/)
  }
})

test('onsets are timestamped candidates and are never presented as a detected beat or sound class', () => {
  const measurementAudio = { ...envelope(Array(20).fill(-30)), beatCandidates: [
    { timeSeconds: 0, strength: 0.5 }, { timeSeconds: 1, strength: 0.8 },
    { timeSeconds: 1, strength: 0.8 }, { timeSeconds: 2, strength: 1 },
    { timeSeconds: -1, strength: 1 }, { timeSeconds: Infinity, strength: 1 },
  ] }
  const audio = buildAudioTimeline({ durationSeconds: 2, shots: shots([0, 1, 2]), measurementAudio })
  assert.deepEqual(audio.onsetCandidates, [{ timeSeconds: 0, strength: 0.5 }, { timeSeconds: 1, strength: 0.8 }])
  assert.deepEqual(audio.segments.map(segment => segment.onsetTimes), [[0], [1]])
  assert.deepEqual(audio.segments.map(segment => segment.events), [[], []])
  assert.equal(audio.semanticStatus, 'unavailable')
  assert.match(audio.segments[0].description, /energy-onset candidate/)
  assert.match(audio.segments[0].description, /Music and sound effects were not classified/)
})

test('real overlapping semantic events retain timing and confidence through every overlapping shot', () => {
  const audio = buildAudioTimeline({
    durationSeconds: 3, shots: shots([0, 1, 2, 3]), measurementAudio: envelope(Array(30).fill(-24)), semanticStatus: 'analyzed',
    semanticEvents: [
      { startSeconds: 0.4, endSeconds: 2.4, label: 'Music', confidence: 0.82 },
      { startSeconds: 0.8, endSeconds: 1.2, label: 'Speech', confidence: 0.74 },
      { startSeconds: 9, endSeconds: 10, label: 'Outside' },
      { label: 'Untimed guess' },
    ],
  })
  assert.equal(audio.semanticStatus, 'analyzed')
  assert.equal(audio.events.length, 2)
  assert.deepEqual(audio.segments.map(segment => segment.events.map(event => event.label)), [['Music', 'Speech'], ['Music', 'Speech'], ['Music']])
  assert.deepEqual(audio.segments[0].events[0], { startSeconds: 0.4, endSeconds: 2.4, label: 'Music', confidence: 0.82 })
  assert.match(audio.segments[1].description, /Audio-model labels: Music, Speech/)
})

test('unmeasured gaps remain unknown and gaps in the shot list still retain continuous audio', () => {
  const audio = buildAudioTimeline({ durationSeconds: 3, shots: [{ index: 7, startSeconds: 1, endSeconds: 2 }], measurementAudio: {
    status: 'analyzed', windows: [{ startSeconds: 0, endSeconds: 0.5, rmsDb: -90 }, { startSeconds: 1, endSeconds: 2, rmsDb: -30 }],
  } })
  assert.deepEqual(audio.segments.map(segment => [segment.shotIndex, segment.startSeconds, segment.endSeconds, segment.status]), [
    [null, 0, 1, 'analyzed'], [7, 1, 2, 'analyzed'], [null, 2, 3, 'unavailable'],
  ])
  assert.equal(audio.segments[0].coverageFraction, 0.5)
  assert.equal(audio.segments[0].audibleFraction, 0)
  assert.match(audio.segments[0].description, /Measurements cover 50%/)
  assert.equal(audio.segments[2].meanDb, undefined)
  assert.match(audio.limitations.join(' '), /unmeasured intervals remain unknown/)
})

test('annotations copy shots, preserve frame observations, and use the same aligned speech', () => {
  const original = shots([0, 1, 2])
  const audio = buildAudioTimeline({ durationSeconds: 2, shots: original, measurementAudio: envelope(Array(20).fill(-24)), script: { words: [{ startSeconds: 1.1, endSeconds: 1.3, text: 'Hi.' }] } })
  const annotated = annotateAudioShots(original, audio)
  assert.equal(original[0].audio, undefined)
  assert.equal(original[1].spokenText, undefined)
  assert.equal(annotated[0].visual, original[0].visual)
  assert.equal(annotated[1].visual, null)
  assert.equal(annotated[1].spokenText, 'Hi.')
  assert.equal(annotated[1].audioAnalysis, audio.segments[1])
  assert.match(annotated[1].audio, /Timed speech is aligned/)
  assert.notEqual(annotated[0], original[0])
})

test('safe normalization bounds invalid or oversized persisted evidence without inventing measurements', () => {
  const longAudio = buildAudioTimeline({ durationSeconds: 999, measurementAudio: envelope(Array(4000).fill(-30)), semanticEvents: [
    { startSeconds: -1, endSeconds: 2, label: '  Music\u0000 ', confidence: 7 },
    { startSeconds: NaN, endSeconds: 2, label: 'Invalid' },
  ] })
  assert.equal(longAudio.windows.length, 3000)
  assert.equal(longAudio.segments[0].endSeconds, 300)
  assert.deepEqual(longAudio.events, [{ startSeconds: 0, endSeconds: 2, label: 'Music' }])
  assert.match(longAudio.limitations.join(' '), /first 300 seconds/)
  const empty = buildAudioTimeline({ durationSeconds: NaN, measurementAudio: { status: 'analyzed', windows: [{ startSeconds: 0, endSeconds: Infinity, rmsDb: -10 }] } })
  assert.equal(empty.status, 'unavailable')
  assert.deepEqual(empty.segments, [])
  assert.deepEqual(empty.windows, [])
})

test('legacy duration precision does not create a spurious unmeasured final interval', () => {
  const audio = buildAudioTimeline({ durationSeconds: 1.000002, shots: shots([0, 1]), measurementAudio: envelope(Array(10).fill(-20)) })
  assert.equal(audio.segments.length, 1)
  assert.equal(audio.segments[0].coverageFraction, 1)
})

test('a brief audible window in a long quiet shot is not mislabeled silence by rounding', () => {
  const levels = Array(3000).fill(-96)
  levels[1500] = -20
  const audio = buildAudioTimeline({ durationSeconds: 300, shots: shots([0, 300]), measurementAudio: envelope(levels) })
  assert.equal(audio.segments[0].status, 'analyzed')
  assert.equal(audio.segments[0].peakWindowDb, -20)
  assert.doesNotMatch(audio.segments[0].description, /All measured audio windows are at or below/)
})

test('the full bounded YAMNet event budget is retained and any larger input is explicitly partial', () => {
  const semanticEvents=Array.from({length:1875},(_,index)=>({startSeconds:Math.floor(index/3)*0.48,endSeconds:Math.min(300,Math.floor(index/3)*0.48+0.975),label:`Class ${index%3}`,confidence:0.8}))
  const complete=buildAudioTimeline({durationSeconds:300,semanticEvents,semanticStatus:'analyzed'})
  assert.equal(complete.semanticEvents.length,1875)
  assert.equal(complete.semanticStatus,'analyzed')
  assert.equal(complete.semanticEvents.at(-1).startSeconds,299.52)
  const partial=buildAudioTimeline({durationSeconds:300,semanticEvents:[...semanticEvents,{startSeconds:0,endSeconds:1,label:'Extra'}],semanticStatus:'analyzed'})
  assert.equal(partial.semanticEvents.length,1875)
  assert.equal(partial.semanticStatus,'partial')
  assert.match(partial.limitations.join(' '),/sound classification coverage is partial/)
})
