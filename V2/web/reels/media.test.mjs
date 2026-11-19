import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import childProcess from 'node:child_process'
import { existsSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { analyzeLocalMedia, analyzePcmEnvelope, buildSections, getMediaCapabilities, parseProbeMetadata, parseSceneBoundaries, validateLocalMediaPath } from './media.mjs'

test('metadata distinguishes unmeasured duration and rates from real values', () => {
  assert.deepEqual(parseProbeMetadata({ format: { duration: '12.5' }, streams: [{ codec_type: 'video', width: 1080, height: 1920, avg_frame_rate: '30000/1001' }, { codec_type: 'audio' }] }), { durationSeconds: 12.5, width: 1080, height: 1920, fps: 29.97, hasVideo: true, hasAudio: true })
  assert.deepEqual(parseProbeMetadata({ streams: [{ codec_type: 'audio', duration: '4' }] }), { durationSeconds: 4, width: null, height: null, fps: null, hasVideo: false, hasAudio: true })
  assert.equal(parseProbeMetadata({ streams: [{ codec_type: 'video', avg_frame_rate: '0/0' }] }).durationSeconds, null)
})

test('scene evidence becomes chronological sections without duplicate or tiny edge shots', () => {
  const boundaries = parseSceneBoundaries('frame:0 pts:0 pts_time:0\nlavfi.scene_score=0.9\nframe:1 pts:15 pts_time:2.5\nlavfi.scene_score=0.78\nframe:2 pts:16 pts_time:2.6\nlavfi.scene_score=0.81\nframe:3 pts:59 pts_time:9.9\nlavfi.scene_score=0.91', 10)
  assert.deepEqual(boundaries, [{ timeSeconds: 2.5, score: 0.78 }])
  const sections = buildSections(10, [...boundaries, ...boundaries])
  assert.equal(sections.length, 2)
  assert.equal(sections[0].startSeconds, 0)
  assert.equal(sections[0].endSeconds, sections[1].startSeconds)
  assert.equal(sections[1].endSeconds, 10)
  assert.equal(sections[1].boundary.score, 0.78)
  assert.deepEqual(buildSections(null), [])
})

test('audio envelope measures silence and candidate onsets without inventing a beat grid', () => {
  const pcm = Buffer.alloc(8000 * 2)
  for (let sample = 2400; sample < 3200; sample++) pcm.writeInt16LE(16384, sample * 2)
  const result = analyzePcmEnvelope(pcm)
  assert.equal(result.windows.length, 10)
  assert.equal(result.windows[0].rmsDb, -96)
  assert.equal(result.windows[3].rmsDb, -6.021)
  assert.deepEqual(result.beatCandidates, [{ timeSeconds: 0.3, strength: 1 }])
  assert.deepEqual(analyzePcmEnvelope(Buffer.alloc(0)), { windows: [], beatCandidates: [] })
})

test('media paths enforce server-approved roots including real symlink destinations', async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'spur-reel-paths-'))
  t.after(() => rm(tmp, { recursive: true, force: true }))
  const library = path.join(tmp, 'library'), outside = path.join(tmp, 'library-other')
  await mkdir(library); await mkdir(outside)
  const insideFile = path.join(library, 'clip.mp4'), outsideFile = path.join(outside, 'clip.mp4')
  await writeFile(insideFile, 'fixture'); await writeFile(outsideFile, 'fixture')
  assert.equal(await validateLocalMediaPath(insideFile, [library]), insideFile)
  await assert.rejects(validateLocalMediaPath(outsideFile, [library]), /outside/)
  await assert.rejects(validateLocalMediaPath('clip.mp4', [library]), /absolute/)
  await writeFile(path.join(library, 'playlist.m3u8'), 'fixture')
  await assert.rejects(validateLocalMediaPath(path.join(library, 'playlist.m3u8'), [library]), /Unsupported/)
  await symlink(outside, path.join(library, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(validateLocalMediaPath(path.join(library, 'escape', 'clip.mp4'), [library]), /outside/)
})

test('missing tools report unavailable and return no fabricated measurements', async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'spur-reel-unavailable-'))
  t.after(() => rm(tmp, { recursive: true, force: true }))
  const filePath = path.join(tmp, 'clip.mp4')
  await writeFile(filePath, 'not a video; unavailable tools must not claim to analyze it')
  const options = { filePath, allowedRoots: [tmp], ffmpegPath: path.join(tmp, 'no-ffmpeg'), ffprobePath: path.join(tmp, 'no-ffprobe') }
  const capabilities = await getMediaCapabilities(options)
  assert.equal(capabilities.metadataAvailable, false)
  assert.equal(capabilities.sceneAnalysisAvailable, false)
  const result = await analyzeLocalMedia(options)
  assert.equal(result.status, 'unavailable')
  assert.equal(result.metadata, null)
  assert.deepEqual(result.sections, [])
  assert.deepEqual(result.audio.windows, [])
  assert.match(result.limitations[0], /No video or audio observations/)
})

const bundledMedia = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.build-tools/media/ffmpeg/bin')
const regressionFfmpeg = process.env.SPUR_FFMPEG_BIN || path.join(bundledMedia, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
const regressionFfprobe = process.env.SPUR_FFPROBE_BIN || path.join(bundledMedia, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')

test('skipping cloud scene analysis performs no visual FFmpeg pass and retains audio RMS; local default still detects sections', { skip: !existsSync(regressionFfmpeg) || !existsSync(regressionFfprobe) }, async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'spur-media-scene-skip-'))
  t.after(() => rm(tmp, { recursive: true, force: true }))
  const filePath = path.join(tmp, 'synthetic.mp4')
  await promisify(childProcess.execFile)(regressionFfmpeg, ['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=6:d=1', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=1', '-shortest', '-c:v', 'libx264', '-c:a', 'aac', filePath], { windowsHide: true })
  const originalSpawn = childProcess.spawn, calls = []
  const mockedSpawn = t.mock.method(childProcess, 'spawn', function (...args) { calls.push(args); return Reflect.apply(originalSpawn, this, args) })
  syncBuiltinESMExports()
  try {
    const options = { filePath, allowedRoots: [tmp], ffmpegPath: regressionFfmpeg, ffprobePath: regressionFfprobe }
    const skipped = await analyzeLocalMedia({ ...options, skipSceneAnalysis: true })
    assert.equal(skipped.metadata.hasVideo, true)
    assert.equal(skipped.audio.status, 'analyzed')
    assert.ok(skipped.audio.windows.length > 0)
    assert.deepEqual(skipped.sections, [])
    assert.equal(calls.some(([, args]) => args.includes('-vf') || args.includes('-frames:v')), false)
    assert.ok(calls.some(([, args]) => args.includes('-vn')), 'audio measurements still run')
    calls.length = 0
    const local = await analyzeLocalMedia(options)
    assert.ok(local.sections.length > 0)
    assert.ok(calls.some(([, args]) => args.includes('-vf')), 'the existing local visual measurement remains enabled')
  } finally { mockedSpawn.mock.restore(); syncBuiltinESMExports() }
})
