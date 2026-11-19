import test from 'node:test'
import assert from 'node:assert/strict'
import { inspectImportedMedia, probeImportedVideo } from './imported-media.mjs'

test('accepts actual portrait video duration with or without audio', () => {
  const result = inspectImportedMedia({ format: { duration: '15.25' }, streams: [{ codec_type: 'video', width: 1080, height: 1920 }, { codec_type: 'audio', duration: '15.30' }] })
  assert.deepEqual(result, { durationSeconds: 15.3, hasVideo: true, hasAudio: true, width: 1080, height: 1920 })
  assert.equal(inspectImportedMedia({ streams: [{ codec_type: 'video', width: 720, height: 1280, duration: '30' }] }).hasAudio, false)
})

test('rejects unverified, zero or overlong duration instead of trusting missing social metadata', () => {
  const video = { codec_type: 'video', width: 720, height: 1280 }
  for (const duration of [undefined, null, 'N/A', 'Infinity', '0', '-1']) {
    assert.throws(() => inspectImportedMedia({ format: { duration }, streams: [video] }), /duration could not be verified/)
  }
  assert.throws(() => inspectImportedMedia({ format: { duration: '301' }, streams: [video] }), /five minutes/)
  assert.throws(() => inspectImportedMedia({ format: { duration: '10' }, streams: [{ ...video, duration: '301' }] }), /five minutes/)
})

test('audio and embedded artwork cannot be imported as a video', () => {
  for (const streams of [[{ codec_type: 'audio' }], [{ codec_type: 'video', width: 400, height: 400, disposition: { attached_pic: 1 } }], [{ codec_type: 'video', width: 0, height: 0 }], []]) {
    assert.throws(() => inspectImportedMedia({ format: { duration: '12' }, streams }), /playable video/)
  }
})

test('media probing requires a host-configured absolute executable', async () => {
  await assert.rejects(probeImportedVideo('reference.mp4', { config: {} }), /verification is unavailable/)
  await assert.rejects(probeImportedVideo('reference.mp4', { config: { SPUR_FFPROBE_BIN: 'ffprobe' } }), /verification is unavailable/)
})
