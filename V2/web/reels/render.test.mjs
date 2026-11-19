import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildRenderArgs, renderReel } from './render.mjs'
import { getMediaCapabilities } from './media.mjs'

const execute = promisify(execFile)
const baseAssets = [{ id: 'footage', filePath: path.resolve('footage.mp4'), durationSeconds: 10, hasVideo: true, hasAudio: true }, { id: 'song', filePath: path.resolve('music.wav'), durationSeconds: 15, hasAudio: true, hasVideo: false }]
const plan = () => ({ schemaVersion: 1, canvas: { width: 1080, height: 1920, fps: 30 }, shots: [{ assetId: 'footage', sourceStartSeconds: 2, durationSeconds: 1.25 }, { assetId: 'footage', sourceStartSeconds: 6, durationSeconds: 2.75 }], durationSeconds: 4, music: { assetId: 'song', sourceStartSeconds: 3, gainDb: -6 } })
const options = value => ({ plan: value ?? plan(), assets: structuredClone(baseAssets), outputPath: path.resolve('output.mp4') })

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'spur-reel-render-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const assets = [{ ...baseAssets[0], filePath: path.join(root, 'footage.mp4') }, { ...baseAssets[1], filePath: path.join(root, 'music.wav') }]
  await Promise.all(assets.map(asset => writeFile(asset.filePath, 'not actual media')))
  return { root, assets, plan: plan(), outputPath: path.join(root, 'output.mp4'), allowedRoots: [root] }
}

test('cuts preserve source order, normalize canvas, discard source audio, and add one trimmed music track', () => {
  const args = buildRenderArgs(options())
  assert(args.includes('-n'))
  assert(!args.includes('-y'))
  assert.equal(args.filter(item => item === '-i').length, 3)
  const filter = args[args.indexOf('-filter_complex') + 1]
  assert.match(filter, /trim=start=2:duration=1\.25/)
  assert.match(filter, /trim=start=6:duration=2\.75/)
  assert.match(filter, /scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30/)
  assert.match(filter, /\[v0\]\[v1\]concat=n=2:v=1:a=0\[vout\]/)
  assert.match(filter, /\[2:a:0\]atrim=start=3:duration=4,asetpts=PTS-STARTPTS,volume=-6dB/)
  assert(!args.includes('0:a:0'))
  assert.equal(args.at(-1), options().outputPath)
  assert(args.includes('libx264'))
  assert(args.includes('aac'))
})

test('music-free output has no audio mapping and metadata does not influence render arguments', () => {
  const value = plan()
  delete value.music
  value.provenance = { referenceId: 'ref-one', method: 'reference_timing_transfer' }
  value.limitations = ['No inferred artistic quality guarantee']
  const args = buildRenderArgs(options(value))
  assert(args.includes('-an'))
  assert(!args.includes('[aout]'))
  assert(!args.includes('ref-one'))
})

test('invalid or unsupported plans cannot reach FFmpeg', () => {
  const mutations = [
    value => { value.schemaVersion = 2 },
    value => { value.canvas.width = 1079 },
    value => { value.canvas.height = 4000 },
    value => { value.canvas.fps = 120 },
    value => { value.shots[0].assetId = 'missing' },
    value => { value.shots[0].sourceStartSeconds = -1 },
    value => { value.shots[0].sourceStartSeconds = 9.5 },
    value => { value.shots[0].durationSeconds = Infinity },
    value => { value.shots[0].transition = 'fade' },
    value => { value.durationSeconds = 3 },
    value => { value.music.sourceStartSeconds = 13 },
    value => { value.music.gainDb = 100 },
    value => { value.shots = Array.from({ length: 61 }, () => ({ ...value.shots[0] })) },
  ]
  for (const mutate of mutations) {
    const value = plan(); mutate(value)
    assert.throws(() => buildRenderArgs(options(value)))
  }
  for (const outputPath of ['relative.mp4', path.resolve('output.txt'), baseAssets[0].filePath]) assert.throws(() => buildRenderArgs({ ...options(), outputPath }))
  const assets = [...baseAssets, { ...baseAssets[0] }]
  assert.throws(() => buildRenderArgs({ ...options(), assets }), /unique/)
  const audioOnly = structuredClone(baseAssets); audioOnly[0].hasVideo = false
  assert.throws(() => buildRenderArgs({ ...options(), assets: audioOnly }), /video asset/)
})

test('existing destination and paths escaping approved roots are refused before running tools', async t => {
  const value = await fixture(t)
  await writeFile(value.outputPath, 'keep this output')
  await assert.rejects(renderReel(value), /already exists/)
  assert.equal(await readFile(value.outputPath, 'utf8'), 'keep this output')
  await assert.rejects(renderReel({ ...value, outputPath: path.join(path.dirname(value.root), 'outside.mp4') }), /outside/)
  const other = await mkdtemp(path.join(tmpdir(), 'spur-reel-outside-'))
  t.after(() => rm(other, { recursive: true, force: true }))
  const escaped = { ...value.assets[0], filePath: path.join(other, 'outside.mp4') }
  await writeFile(escaped.filePath, 'outside')
  await assert.rejects(renderReel({ ...value, outputPath: path.join(value.root, 'fresh.mp4'), assets: [escaped, value.assets[1]] }), /outside/)
})

test('symlinked source cannot escape approved roots', async t => {
  const value = await fixture(t)
  const other = await mkdtemp(path.join(tmpdir(), 'spur-reel-symlink-outside-'))
  t.after(() => rm(other, { recursive: true, force: true }))
  const target = path.join(other, 'outside.mp4'), linked = path.join(value.root, 'linked.mp4')
  await writeFile(target, 'outside')
  try { await symlink(target, linked) } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip('Creating file symlinks is unavailable for this account')
    throw error
  }
  await assert.rejects(renderReel({ ...value, assets: [{ ...value.assets[0], filePath: linked }, value.assets[1]] }), /outside/)
})

test('missing binaries and cancellation never report completed media', async t => {
  const value = await fixture(t)
  await assert.rejects(renderReel({ ...value, ffmpegPath: path.join(value.root, 'missing-ffmpeg'), ffprobePath: path.join(value.root, 'missing-ffprobe') }), /FFmpeg and FFprobe are required/)
  await assert.rejects(readFile(value.outputPath), { code: 'ENOENT' })
  const controller = new AbortController(); controller.abort()
  await assert.rejects(renderReel({ ...value, signal: controller.signal }), /cancelled/)
})

test('only one render is active per process and failure releases the guard', async t => {
  const value = await fixture(t)
  const missing = { ...value, ffmpegPath: path.join(value.root, 'missing-ffmpeg'), ffprobePath: path.join(value.root, 'missing-ffprobe') }
  const first = renderReel(missing).then(() => null, error => error)
  await assert.rejects(renderReel(missing), /already active/)
  assert.match((await first).message, /FFmpeg and FFprobe are required/)
  await assert.rejects(renderReel(missing), /FFmpeg and FFprobe are required/)
  await assert.rejects(renderReel({ ...missing, plan: null }), /Invalid reel plan/)
  await assert.rejects(renderReel(missing), /FFmpeg and FFprobe are required/)
})

test('real local fixture renders verified silent and music reels without overwriting', async t => {
  const tools = await getMediaCapabilities({ ffmpegPath: process.env.SPUR_FFMPEG_PATH, ffprobePath: process.env.SPUR_FFPROBE_PATH })
  if (!tools.ffmpeg.available || !tools.ffprobe.available) return t.skip('FFmpeg and FFprobe are not installed; actual media rendering was not exercised')
  const value = await fixture(t)
  await rm(value.assets[0].filePath)
  await rm(value.assets[1].filePath)
  await execute(tools.ffmpeg.command, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', value.assets[0].filePath], { windowsHide: true })
  await execute(tools.ffmpeg.command, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=15', value.assets[1].filePath], { windowsHide: true })
  value.plan.canvas = { width: 180, height: 320, fps: 30 }
  const result = await renderReel({ ...value, ffmpegPath: tools.ffmpeg.command, ffprobePath: tools.ffprobe.command })
  assert.equal(result.status, 'completed')
  assert.equal(result.metadata.hasAudio, true)
  assert.equal(result.metadata.hasVideo, true)
  assert(Math.abs(result.durationSeconds - 4) < 0.15)
  assert.deepEqual(result.verification, { metadata: true, decoded: true })
  const contents = await readFile(value.outputPath)
  await assert.rejects(renderReel(value), /already exists/)
  assert.deepEqual(await readFile(value.outputPath), contents)
  delete value.plan.music
  const silent = await renderReel({ ...value, outputPath: path.join(value.root, 'silent.mp4'), ffmpegPath: tools.ffmpeg.command, ffprobePath: tools.ffprobe.command })
  assert.equal(silent.metadata.hasAudio, false)
})
