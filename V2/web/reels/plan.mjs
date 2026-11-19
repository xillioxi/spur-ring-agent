const round = value => Math.round(value * 1000000) / 1000000
const finite = (value, min, max, name) => {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid ${name}`)
  return value
}
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value)
const quantile = (sorted, fraction) => sorted.length ? sorted[Math.round((sorted.length - 1) * fraction)] : null

/** Descriptive timing evidence only. This does not learn visual semantics or predict views. */
export function summarizeReferenceTiming(references) {
  const durations = [], examples = []
  for (const reference of references) {
    const ordered = reference.segments || []
    const shots = ordered.map(segment => segment.endSeconds - segment.startSeconds).filter(value => value > 0)
    durations.push(...shots)
    examples.push({ referenceId: reference.id, source: reference.source, durationSeconds: reference.durationSeconds,
      segmentCount: shots.length, orderedDurationsSeconds: shots.map(round) })
  }
  durations.sort((a, b) => a - b)
  return { referenceCount: references.length, segmentCount: durations.length,
    segmentDurationSeconds: { p25: quantile(durations, .25), median: quantile(durations, .5), p75: quantile(durations, .75) },
    examples, limitations: ['Timing statistics describe the supplied references; they do not establish a learned channel style.',
      'Keep distinct recurring series separate when selecting references; imported segments may be narrative sections rather than physical shots.'] }
}

/** Agent-selected footage follows one real reference's ordered timing. No fixed creative format. */
export function createReelPlan({ reference, assets, shots, music, targetDurationSeconds, canvas = { width: 1080, height: 1920, fps: 30 } }) {
  if (!reference?.id || !reference.segments?.length) throw new Error('A reference with timed segments is required')
  const segments = reference.segments
  if (segments.length > 60 || !Array.isArray(shots) || shots.length !== segments.length) {
    throw new Error('Select one footage range per reference segment (at most 60)')
  }
  let previousEnd = 0
  for (const segment of segments) {
    finite(segment.startSeconds, 0, 600, 'reference start')
    finite(segment.endSeconds, segment.startSeconds + .001, 600, 'reference end')
    if (Math.abs(segment.startSeconds - previousEnd) > .05) throw new Error('Timing transfer requires contiguous, ordered reference segments')
    previousEnd = segment.endSeconds
  }
  if (Math.abs(previousEnd - reference.durationSeconds) > .05) throw new Error('Reference segments must cover the full reference')
  finite(canvas.width, 64, 2160, 'width'); finite(canvas.height, 64, 2160, 'height'); finite(canvas.fps, 15, 60, 'fps')
  if (!Number.isInteger(canvas.fps) || !Number.isInteger(canvas.width) || !Number.isInteger(canvas.height) || canvas.width % 2 || canvas.height % 2) throw new Error('Canvas dimensions must be even integers and fps must be an integer')
  const requestedDuration = finite(targetDurationSeconds ?? previousEnd, .5, 180, 'reel duration')
  const durationSeconds = Math.round(requestedDuration * canvas.fps) / canvas.fps
  const scale = durationSeconds / previousEnd
  const registered = new Map((assets || []).map(asset => [asset.id, asset]))
  let elapsedFrames = 0
  const planned = shots.map((shot, index) => {
    const asset = registered.get(shot.assetId)
    if (!id(shot.assetId) || !asset || asset.hasVideo !== true) throw new Error('Every shot needs a registered video asset')
    const start = finite(shot.sourceStartSeconds ?? 0, 0, asset.durationSeconds, 'footage start')
    const endFrame = Math.round(segments[index].endSeconds * scale * canvas.fps)
    const duration = (endFrame - elapsedFrames) / canvas.fps
    finite(duration, .1, 60, 'shot duration')
    if (start + duration > asset.durationSeconds + .000001) throw new Error(`Footage ${shot.assetId} is too short for reference segment ${index}`)
    elapsedFrames = endFrame
    return { assetId: shot.assetId, sourceStartSeconds: start, durationSeconds: duration }
  })
  let soundtrack
  if (music != null) {
    const asset = registered.get(music.assetId)
    if (!id(music.assetId) || !asset || asset.hasAudio !== true) throw new Error('Music needs a registered audio asset')
    const start = finite(music.sourceStartSeconds ?? 0, 0, asset.durationSeconds, 'music start')
    if (start + durationSeconds > asset.durationSeconds + .000001) throw new Error('Music must cover the complete reel')
    soundtrack = { assetId: music.assetId, sourceStartSeconds: start, gainDb: finite(music.gainDb ?? 0, -60, 12, 'music gain') }
  }
  return { schemaVersion: 1, canvas: { width: canvas.width, height: canvas.height, fps: canvas.fps }, durationSeconds,
    shots: planned, ...(soundtrack ? { music: soundtrack } : {}),
    provenance: { referenceId: reference.id, referenceSource: reference.source,
      referenceSegmentIds: segments.map(segment => segment.id), method: 'reference_timing_transfer', timingScale: round(scale) },
    limitations: ['Only shot order and timing are transferred. Footage selection and source ranges are supplied by the caller.',
      'No visual style, camera motion, beat alignment, voice or view performance has been inferred.',
      'Rendering uses straight cuts and center crops; inspect composition before publication.'] }
}
