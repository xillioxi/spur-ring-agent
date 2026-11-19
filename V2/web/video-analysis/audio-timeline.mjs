const MAX_DURATION = 300
const MAX_WINDOWS = 3000
const MAX_SHOTS = 2000
const MAX_WORDS = 12000
const MAX_ONSETS = 1200
const MAX_SEMANTIC_EVENTS = 1875
const SILENCE_DB = -55
const round = value => Math.round(value * 1000) / 1000
const finite = value => typeof value === 'number' && Number.isFinite(value)
const clean = (value, max = 2000) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max) : ''
const joinWords = words => words.map(word => word.text).join(' ').replace(/\s+([,.;:!?。！？、，])/g, '$1').replace(/([\u3000-\u9fff])\s+(?=[\u3000-\u9fff])/g, '$1').slice(0, 12000)
const statuses = new Set(['analyzed', 'partial', 'failed', 'unavailable', 'not_requested', 'no_audio', 'silence'])
const status = (value, fallback) => statuses.has(value) ? value : fallback

function boundedInterval(value, duration) {
  if (!finite(value?.startSeconds) || !finite(value?.endSeconds)) return null
  const startSeconds = Math.max(0, value.startSeconds)
  const endSeconds = Math.min(duration, value.endSeconds)
  if (!(endSeconds > startSeconds)) return null
  const interval = { startSeconds: round(startSeconds), endSeconds: round(endSeconds) }
  return interval.endSeconds > interval.startSeconds ? interval : null
}

function normalizeWindows(raw, duration) {
  const candidates = (Array.isArray(raw) ? raw : []).slice(0, MAX_WINDOWS).flatMap(window => {
    const interval = boundedInterval(window, duration)
    if (!interval || !finite(window.rmsDb)) return []
    return [{ ...interval, rmsDb: round(Math.min(0, Math.max(-160, window.rmsDb))) }]
  }).sort((a, b) => a.startSeconds - b.startSeconds)
  const windows = []
  // FFmpeg emits disjoint windows. Defensive trimming prevents malformed persisted
  // overlaps from inflating coverage or counting one instant of sound twice.
  for (const window of candidates) {
    const startSeconds = Math.max(window.startSeconds, windows.at(-1)?.endSeconds ?? 0)
    if (window.endSeconds > startSeconds) windows.push({ ...window, startSeconds })
  }
  return windows
}

function normalizeOnsets(raw, duration) {
  const seen = new Set()
  return (Array.isArray(raw) ? raw : []).slice(0, MAX_ONSETS).flatMap(onset => {
    if (!finite(onset?.timeSeconds) || onset.timeSeconds < 0 || onset.timeSeconds >= duration) return []
    const timeSeconds = round(onset.timeSeconds)
    if (seen.has(timeSeconds)) return []
    seen.add(timeSeconds)
    return [{ timeSeconds, ...(finite(onset.strength) ? { strength: round(Math.max(0, Math.min(1, onset.strength))) } : {}) }]
  }).sort((a, b) => a.timeSeconds - b.timeSeconds)
}

function normalizeEvents(raw, duration) {
  return (Array.isArray(raw) ? raw : []).slice(0, MAX_SEMANTIC_EVENTS).flatMap(event => {
    const interval = boundedInterval(event, duration)
    const label = clean(event?.label, 160)
    if (!interval || !label) return []
    const description = clean(event.description, 1000)
    const category = ['music', 'sfx', 'ambient', 'speech'].includes(event.category) ? event.category : ''
    return [{ ...interval, label, ...(description ? { description } : {}), ...(category ? { category } : {}), ...(finite(event.confidence) && event.confidence >= 0 && event.confidence <= 1 ? { confidence: round(event.confidence) } : {}) }]
  }).sort((a, b) => a.startSeconds - b.startSeconds)
}

function normalizeSemanticSegments(raw, duration) {
  return (Array.isArray(raw) ? raw : []).slice(0, MAX_SHOTS).flatMap(segment => {
    const interval = boundedInterval(segment, duration)
    const description = clean(segment?.description, 4000)
    return interval && description ? [{ ...interval, description }] : []
  }).sort((a, b) => a.startSeconds - b.startSeconds)
}

function intervalsForShots(shots, duration) {
  const candidates = (Array.isArray(shots) ? shots : []).slice(0, MAX_SHOTS).flatMap((shot, position) => {
    const interval = boundedInterval(shot, duration)
    if (!interval) return []
    return [{ ...interval, shotIndex: Number.isInteger(shot.index) && shot.index >= 0 ? shot.index : position }]
  }).sort((a, b) => a.startSeconds - b.startSeconds)
  const intervals = []
  let cursor = 0
  for (const candidate of candidates) {
    if (candidate.startSeconds > cursor) intervals.push({ shotIndex: null, startSeconds: cursor, endSeconds: candidate.startSeconds })
    const startSeconds = Math.max(cursor, candidate.startSeconds)
    if (candidate.endSeconds > startSeconds) {
      intervals.push({ ...candidate, startSeconds })
      cursor = candidate.endSeconds
    }
  }
  if (cursor < duration) intervals.push({ shotIndex: null, startSeconds: cursor, endSeconds: duration })
  return intervals
}

function speechEvidence(script, duration) {
  const words = (Array.isArray(script?.words) ? script.words : []).slice(0, MAX_WORDS).flatMap(word => {
    const interval = boundedInterval(word, duration)
    const text = clean(word?.text, 4000)
    return interval && text ? [{ ...interval, text }] : []
  })
  // Old saved analyses only have segment timestamps. Keep each segment whole and
  // assign it by midpoint rather than duplicating its complete sentence at cuts.
  const evidence = words.length ? words : (Array.isArray(script?.segments) ? script.segments : []).slice(0, 2000).flatMap(segment => {
    const interval = boundedInterval(segment, duration)
    const text = clean(segment?.text, 4000)
    return interval && text ? [{ ...interval, text }] : []
  })
  return evidence.sort((a, b) => a.startSeconds - b.startSeconds)
}

function measuredSegment(interval, windows) {
  let coveredSeconds = 0, audibleSeconds = 0, energySeconds = 0
  let peakWindowDb = -Infinity
  for (const window of windows) {
    if (window.startSeconds >= interval.endSeconds) break
    const overlap = Math.min(window.endSeconds, interval.endSeconds) - Math.max(window.startSeconds, interval.startSeconds)
    if (!(overlap > 0)) continue
    coveredSeconds += overlap
    energySeconds += 10 ** (window.rmsDb / 10) * overlap
    peakWindowDb = Math.max(peakWindowDb, window.rmsDb)
    if (window.rmsDb > SILENCE_DB) audibleSeconds += overlap
  }
  if (!(coveredSeconds > 0)) return null
  return {
    meanDb: round(10 * Math.log10(energySeconds / coveredSeconds)),
    peakWindowDb,
    audibleFraction: round(audibleSeconds / coveredSeconds),
    coverageFraction: round(Math.min(1, coveredSeconds / (interval.endSeconds - interval.startSeconds))),
    measuredSeconds: round(coveredSeconds),
  }
}

function segmentDescription(segment, speechStatus, semanticStatus) {
  if (segment.status === 'no_audio') return 'No audio track.'
  const parts = []
  if (segment.status === 'failed') parts.push('Audio measurements failed for this interval.')
  else if (segment.status === 'unavailable') parts.push('Audio measurements are unavailable for this interval.')
  else {
    if (segment.status === 'silence') parts.push(`All measured audio windows are at or below ${SILENCE_DB} dB RMS.`)
    else parts.push(`Mean ${segment.meanDb} dB RMS; strongest measured window ${segment.peakWindowDb} dB RMS.`)
    parts.push(`${Math.round(segment.audibleFraction * 100)}% of measured audio is above ${SILENCE_DB} dB RMS.`)
    if (segment.coverageFraction < 0.99) parts.push(`Measurements cover ${Math.round(segment.coverageFraction * 100)}% of this interval.`)
    if (segment.onsetTimes.length) parts.push(`${segment.onsetTimes.length} energy-onset candidate${segment.onsetTimes.length === 1 ? '' : 's'}.`)
  }
  if (segment.spokenText) parts.push('Timed speech is aligned with this interval.')
  else if (speechStatus === 'analyzed') parts.push('The transcript contains no words assigned to this interval.')
  else if (speechStatus === 'silence') parts.push('Speech transcription was skipped for a near-silent track.')
  else if (speechStatus === 'failed') parts.push('Speech transcription failed; speech content is unknown.')
  else if (speechStatus !== 'no_audio') parts.push('Speech content is unknown because transcription is unavailable or was not requested.')
  if (segment.events.length) parts.push(`Audio-model labels: ${[...new Set(segment.events.map(event => event.label))].join(', ')}.`)
  else if (semanticStatus !== 'analyzed') parts.push('Music and sound effects were not classified.')
  return parts.join(' ')
}

/**
 * Align continuous, measured audio and timed speech with every shot interval.
 * RMS/onsets are physical measurements, not music, beat or sound-effect labels.
 * Optional semantic events must come from an actual audio model, never stills.
 */
export function buildAudioTimeline({ durationSeconds, shots = [], script = {}, measurementAudio = {}, hasAudio, speechStatus, semanticEvents, semanticStatus, semanticSegments, semanticDescription } = {}) {
  const duration = finite(durationSeconds) && durationSeconds > 0 ? round(Math.min(MAX_DURATION, durationSeconds)) : 0
  const noAudio = hasAudio === false || measurementAudio?.status === 'no_audio'
  const windows = noAudio ? [] : normalizeWindows(measurementAudio?.windows, duration)
  const onsetCandidates = noAudio ? [] : normalizeOnsets(measurementAudio?.onsetCandidates ?? measurementAudio?.beatCandidates, duration)
  const events = noAudio ? [] : normalizeEvents(semanticEvents, duration)
  const descriptions = noAudio ? [] : normalizeSemanticSegments(semanticSegments, duration)
  const overallSemanticDescription = noAudio ? '' : clean(semanticDescription, 12000)
  const audioStatus = noAudio ? 'no_audio' : measurementAudio?.status === 'failed' ? 'failed' : measurementAudio?.status === 'analyzed' && windows.length ? 'analyzed' : 'unavailable'
  const speech = noAudio ? 'no_audio' : status(speechStatus, speechEvidence(script, duration).length ? 'analyzed' : 'unavailable')
  const semanticTruncated = !noAudio && Array.isArray(semanticEvents) && semanticEvents.length > MAX_SEMANTIC_EVENTS
  const semantics = noAudio ? 'no_audio' : semanticTruncated ? 'partial' : status(semanticStatus, events.length ? 'analyzed' : 'unavailable')
  const words = noAudio ? [] : speechEvidence(script, duration)
  const segments = intervalsForShots(shots, duration).map(interval => {
    const measured = audioStatus === 'analyzed' ? measuredSegment(interval, windows) : null
    const intervalStatus = measured ? measured.peakWindowDb <= SILENCE_DB && measured.coverageFraction >= 0.99 ? 'silence' : 'analyzed' : audioStatus === 'analyzed' ? 'unavailable' : audioStatus
    const segment = {
      ...interval,
      status: intervalStatus,
      spokenText: joinWords(words.filter(word => {
        const midpoint = (word.startSeconds + word.endSeconds) / 2
        return midpoint >= interval.startSeconds && midpoint < interval.endSeconds
      })),
      ...(measured || {}),
      onsetTimes: onsetCandidates.filter(onset => onset.timeSeconds >= interval.startSeconds && onset.timeSeconds < interval.endSeconds).map(onset => onset.timeSeconds),
      events: events.filter(event => event.startSeconds < interval.endSeconds && event.endSeconds > interval.startSeconds),
    }
    const interpretation = [...new Set(descriptions.filter(value => value.startSeconds < interval.endSeconds && value.endSeconds > interval.startSeconds).map(value => value.description))].join(' ')
    segment.description = interpretation || segmentDescription(segment, speech, semantics)
    if (interpretation) segment.measurementDescription = segmentDescription(segment, speech, semantics)
    return segment
  })
  const overallMeasurement = duration > 0 && audioStatus === 'analyzed' ? measuredSegment({ startSeconds: 0, endSeconds: duration }, windows) : null
  const limitations = (Array.isArray(measurementAudio?.limitations) ? measurementAudio.limitations : []).slice(0, 20).map(value => clean(value, 1000)).filter(Boolean)
  if (!noAudio) {
    limitations.push('Energy-onset candidates are not verified beats or BPM. RMS measurements do not identify music, instruments or sound effects.')
    limitations.push(`An interval marked silence means all available windows are at or below ${SILENCE_DB} dB RMS; it is not a claim of absolute silence.`)
    if (overallMeasurement && overallMeasurement.coverageFraction < 0.99) limitations.push('Audio measurements do not cover the entire video; unmeasured intervals remain unknown.')
  }
  if (finite(durationSeconds) && durationSeconds > MAX_DURATION) limitations.push(`Only the first ${MAX_DURATION} seconds are represented in this audio timeline.`)
  if (semanticTruncated) limitations.push(`Only the first ${MAX_SEMANTIC_EVENTS} sound-event observations are included; sound classification coverage is partial.`)
  const description = noAudio ? 'This file has no audio track.' : audioStatus === 'failed' ? 'Audio measurements failed. Available timed speech is retained separately.' : audioStatus !== 'analyzed' ? 'Audio measurements are unavailable. Available timed speech is retained separately.' : `Audio measured across ${Math.round(overallMeasurement.coverageFraction * 100)}% of the video in 100 ms windows; ${Math.round(overallMeasurement.audibleFraction * 100)}% of measured audio exceeds ${SILENCE_DB} dB RMS. ${onsetCandidates.length} energy-onset candidates were detected.`
  return {
    timelineVersion: 1, status: audioStatus, description: overallSemanticDescription || description, speechStatus: speech, semanticStatus: semantics,
    ...(overallSemanticDescription ? { semanticDescription: overallSemanticDescription, measurementDescription: description } : {}),
    ...(descriptions.length ? { semanticSegments: descriptions } : {}),
    measurementWindowSeconds: 0.1, silenceThresholdDb: SILENCE_DB,
    ...(overallMeasurement || {}), windows, onsetCandidates, semanticEvents: events, events, segments,
    limitations: [...new Set(limitations)],
  }
}

/** Keep shot descriptions, audio evidence and speech on the same timing grid. */
export function annotateAudioShots(shots, audio) {
  if (!Array.isArray(shots)) return []
  const segments = Array.isArray(audio?.segments) ? audio.segments : []
  return shots.map((shot, position) => {
    const index = Number.isInteger(shot.index) ? shot.index : position
    const segment = segments.find(value => value.shotIndex === index && value.startSeconds === shot.startSeconds && value.endSeconds === shot.endSeconds)
    if (!segment) return { ...shot }
    return { ...shot, audio: segment.description, spokenText: segment.spokenText, audioAnalysis: segment }
  })
}
