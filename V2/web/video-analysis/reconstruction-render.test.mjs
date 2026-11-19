import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { renderReconstruction, probeReconstructionMedia, runReconstructionProcess } from './reconstruction-render.mjs'

test('real FFmpeg assembles generated footage at planned hard cuts with reference audio or silence', async t => {
  const repository = fileURLToPath(new URL('../../../', import.meta.url))
  const ffmpegCandidates = [process.env.SPUR_FFMPEG_BIN, path.join(repository, '.build-tools/media/ffmpeg/bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'), 'ffmpeg'].filter(Boolean)
  const ffmpeg = ffmpegCandidates.find(command => spawnSync(command, ['-version'], { timeout: 10000, stdio: 'ignore' }).status === 0)
  if (!ffmpeg) { t.skip('FFmpeg is not installed.'); return }
  const ffprobe = path.join(path.dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
  if (spawnSync(ffprobe, ['-version'], { timeout: 10000, stdio: 'ignore' }).status !== 0) { t.skip('FFprobe is not installed.'); return }
  const directory = await mkdtemp(path.join(process.cwd(), '.spur-reconstruction-render-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const config = { SPUR_FFMPEG_BIN: ffmpeg, SPUR_FFPROBE_BIN: ffprobe }
  const realProcess = async (command, args, options = {}) => {
    const result = spawnSync(command, args, { timeout: options.timeoutMs || 30000, maxBuffer: options.maxBytes || 1024 ** 2 })
    assert.equal(result.status, 0, result.stderr?.toString())
    return { stdout: result.stdout, stderr: result.stderr.toString() }
  }
  const referencePath = path.join(directory, 'reference.mp4')
  await runReconstructionProcess(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=c=red:size=96x64:rate=30:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', referencePath])
  const clips = []
  for (const [index, color, durationSeconds] of [[0, 'blue', 1.37], [1, 'green', 1.23]]) {
    const filePath = path.join(directory, `generated-${index}.mp4`)
    await runReconstructionProcess(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', `color=c=${color}:size=96x64:rate=24:duration=2`, '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', filePath])
    clips.push({ filePath, durationSeconds })
  }
  for (const audioMode of ['reference', 'silent']) {
    const outputPath = path.join(directory, `output-${audioMode}.mp4`)
    const result = await renderReconstruction({ clips, referencePath, audioMode, outputPath, ratio: '9:16', resolution: '480p', config, runProcess: realProcess })
    assert.ok(Math.abs(result.durationSeconds - 2.6) <= 0.075)
    assert.equal(result.width, 480)
    assert.equal(result.height, 854)
    assert.equal(result.hasAudio, audioMode === 'reference')
    for (const [time, strongest] of [[0.5, 2], [2, 1]]) {
      const sample = await runReconstructionProcess(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', String(time), '-i', outputPath, '-frames:v', '1', '-vf', 'scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'])
      assert.ok(sample.stdout[strongest] > sample.stdout[0] + 30, 'output visuals come from generated blue/green clips, not the red reference')
    }
  }
  const remaining = await readdir(directory)
  assert.equal(remaining.some(name => name.startsWith('normalized-') || name === 'assembly-list.txt'), false)
  assert.equal((await probeReconstructionMedia(referencePath, { config })).hasAudio, true)
})

test('short generated clips fail without using reference visuals or invented padding', async t => {
  const directory = await mkdtemp(path.join(process.cwd(), '.spur-reconstruction-short-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const clip = path.join(directory, 'generated.mp4')
  await writeFile(clip, 'fixture')
  let processes = 0
  await assert.rejects(renderReconstruction({ clips: [{ filePath: clip, durationSeconds: 5 }], outputPath: path.join(directory, 'output.mp4'), audioMode: 'silent', probe: async () => ({ durationSeconds: 1 }), runProcess: async () => { processes++ } }), /shorter than its required shot/)
  assert.equal(processes, 0)
})

test('real FFmpeg preserves authored start, middle and trailing black gaps with reference audio at absolute times', async t => {
  const repository = fileURLToPath(new URL('../../../', import.meta.url))
  const ffmpegCandidates = [process.env.SPUR_FFMPEG_BIN, path.join(repository, '.build-tools/media/ffmpeg/bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'), 'ffmpeg'].filter(Boolean)
  const ffmpeg = ffmpegCandidates.find(command => spawnSync(command, ['-version'], { timeout: 10000, stdio: 'ignore' }).status === 0)
  if (!ffmpeg) { t.skip('FFmpeg is not installed.'); return }
  const ffprobe = path.join(path.dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
  if (spawnSync(ffprobe, ['-version'], { timeout: 10000, stdio: 'ignore' }).status !== 0) { t.skip('FFprobe is not installed.'); return }
  const directory = await mkdtemp(path.join(process.cwd(), '.spur-reconstruction-gaps-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const config = { SPUR_FFMPEG_BIN: ffmpeg, SPUR_FFPROBE_BIN: ffprobe }
  const commands = []
  const realProcess = async (command, args, options = {}) => {
    commands.push(args)
    const result = spawnSync(command, args, { timeout: options.timeoutMs || 30000, maxBuffer: options.maxBytes || 1024 ** 2 })
    assert.equal(result.status, 0, result.stderr?.toString())
    return { stdout: result.stdout, stderr: result.stderr.toString() }
  }
  const referencePath = path.join(directory, 'reference.mp4')
  // The reference changes tone at 0.9 s. It must not move when black gaps are inserted.
  await realProcess(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=c=red:size=96x64:rate=30:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=0.9', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=16000:duration=1.1', '-filter_complex', '[1:a][2:a]concat=n=2:v=0:a=1[a]', '-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', referencePath])
  const clips = []
  // Non-frame-aligned authored boundaries are rounded at their absolute 30 fps positions.
  for (const [index, color, startSeconds, endSeconds] of [[0, 'blue', 0.213, 0.717], [1, 'green', 1.113, 1.617]]) {
    const filePath = path.join(directory, `generated-${index}.mp4`)
    // Generated audio has a different frequency and must not enter the assembled output.
    await realProcess(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', `color=c=${color}:size=96x64:rate=24:duration=1`, '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=16000:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', filePath])
    clips.push({ filePath, startSeconds, endSeconds, durationSeconds: endSeconds - startSeconds })
  }
  const outputPath = path.join(directory, 'output.mp4')
  const result = await renderReconstruction({ clips, totalDurationSeconds: 2.013, referencePath, outputPath, resolution: '480p', config, runProcess: realProcess })
  assert.ok(Math.abs(result.durationSeconds - 2.013) <= 0.075)
  assert.equal(result.intendedDurationSeconds, 2.013)
  assert.equal(result.hasAudio, true)
  assert.ok(result.warnings.some(value => /black editorial frames/.test(value)))
  assert.equal(commands.filter(args => args.some(value => typeof value === 'string' && value.startsWith('color=c=black:'))).length, 3)
  for (const [time, strongest] of [[0.1, null], [0.4, 2], [0.8, null], [1.3, 1], [1.8, null]]) {
    const sample = await realProcess(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', String(time), '-i', outputPath, '-frames:v', '1', '-vf', 'crop=2:2:(iw-2)/2:(ih-2)/2,scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'])
    assert.equal(sample.stdout.length, 3)
    if (strongest === null) assert.ok([...sample.stdout].every(value => value < 8), `authored gap at ${time} s is black`)
    else assert.ok(sample.stdout[strongest] > sample.stdout[0] + 30, 'only generated blue and green visuals fill the authored shots')
  }
  for (const [time, frequency] of [[0.3, 440], [0.74, 440], [1.2, 880], [1.75, 880]]) {
    const sample = await realProcess(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', String(time), '-i', outputPath, '-t', '0.15', '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'])
    let crossings = 0, amplitude = 0
    for (let offset = 2; offset < sample.stdout.length; offset += 2) {
      const current = sample.stdout.readInt16LE(offset), previous = sample.stdout.readInt16LE(offset - 2)
      if (previous < 0 && current >= 0) crossings++
      amplitude = Math.max(amplitude, Math.abs(current))
    }
    const measuredFrequency = crossings / (sample.stdout.length / 2 / 8000)
    assert.ok(amplitude > 200, `reference audio continues through the timeline at ${time} s`)
    assert.ok(Math.abs(measuredFrequency - frequency) < 20, `reference tone is ${frequency} Hz at absolute time ${time} s, measured ${measuredFrequency}`)
  }
  assert.equal((await readdir(directory)).some(name => name.startsWith('normalized-') || name.startsWith('editorial-gap-') || name === 'assembly-list.txt'), false)
})

test('invalid authored timing is rejected before processing or creating editorial footage', async () => {
  const clip = { filePath: 'unused.mp4', durationSeconds: 1, startSeconds: 0, endSeconds: 1 }
  for (const options of [
    { clips: [{ ...clip, startSeconds: 2 }] },
    { clips: [{ ...clip, endSeconds: undefined }] },
    { clips: [{ ...clip, durationSeconds: 0.5 }] },
    { clips: [clip, { ...clip, startSeconds: 0.5, endSeconds: 1.5 }] },
    { clips: [{ ...clip, durationSeconds: 0.01, endSeconds: 0.01 }] },
    { clips: [clip], totalDurationSeconds: 0.5 },
    { clips: [clip], totalDurationSeconds: 301 }
  ]) {
    let processes = 0
    await assert.rejects(renderReconstruction({ ...options, audioMode: 'silent', outputPath: 'unused-output.mp4', runProcess: async () => { processes++ } }), cause => cause.code === 'reconstruction_render_failed')
    assert.equal(processes, 0)
  }
})

test('output or temporary filename collisions never overwrite or delete source footage', async t => {
  const directory = await mkdtemp(path.join(process.cwd(), '.spur-reconstruction-collision-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  for (const name of ['original.mp4', 'normalized-0.mp4', 'editorial-gap-0.mp4']) {
    const file = path.join(directory, name)
    await writeFile(file, 'ORIGINAL MEDIA')
    await assert.rejects(renderReconstruction({ clips: [{ filePath: file, durationSeconds: 1 }], outputPath: name === 'original.mp4' ? file : path.join(directory, 'output.mp4'), audioMode: 'silent' }), /cannot replace source media/)
    assert.equal(await readFile(file, 'utf8'), 'ORIGINAL MEDIA')
  }
})
