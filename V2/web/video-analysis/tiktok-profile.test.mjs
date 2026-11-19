import test from 'node:test'
import assert from 'node:assert/strict'
import { parseTikTokProfile, parseTikTokCreatorMetadata, fetchTikTokCreatorMetadata, discoverTikTokProfile, TIKTOK_PREVIEW_LIMIT } from './tiktok-profile.mjs'
const entry = (id, more = {}) => ({ id, uploader: 'ez_home', channel: 'EZ Home', title: 'Build a shelf', duration: 23, timestamp: 1700000000, thumbnails: [{ url: 'https://p16.tiktokcdn-us.com/cover.jpg' }], ...more })
const profileUrl = 'https://www.tiktok.com/@ez_home'
const profileHtml = (user = {}) => `<script nonce="public" id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({ __DEFAULT_SCOPE__: { 'webapp.user-detail': { userInfo: { user: { uniqueId: 'ez_home', nickname: 'EZ Home', avatarMedium: 'https://p19-common-sign.tiktokcdn-us.com/avatar.jpeg', ...user } } } } })}</script>`

test('TikTok preview keeps only the requested creator and bounded video identities', () => {
  const result = parseTikTokProfile({ entries: [entry('7014215295795498245'), entry('7014215295795498245'), entry('7014215295795498246', { uploader: 'someone_else' }), entry('../escape'), entry('7014215295795498247', { thumbnails: [{ url: 'https://p16.tiktokcdn-us.com/photomode-image.jpeg' }] })] }, 'https://www.tiktok.com/@ez_home')
  assert.equal(result.platform, 'tiktok'); assert.equal(result.handle, 'ez_home'); assert.equal(result.name, 'EZ Home')
  assert.equal(result.discoveredVideos.length, 1); assert.equal(result.coverage, 'preview')
  assert.equal(result.discoveredVideos[0].url, 'https://www.tiktok.com/@ez_home/video/7014215295795498245')
  assert.equal(result.discoveredVideos[0].durationSeconds, 23)
  assert.equal(result.avatarUrl, undefined)
})

test('public metadata cannot create arbitrary video or image requests and never implies complete coverage', () => {
  const result = parseTikTokProfile({ thumbnails: [{ url: 'https://localhost/private' }], entries: Array.from({ length: 40 }, (_, i) => entry(String(7014215295795498000n + BigInt(i)), { thumbnails: [{ url: 'https://evil-tiktokcdn-us.com/x.jpg' }] })) }, 'https://tiktok.com/@ez_home')
  assert.equal(result.discoveredVideos.length, TIKTOK_PREVIEW_LIMIT)
  assert.ok(result.discoveredVideos.every(item => item.thumbnailUrl === undefined))
  assert.equal(result.catalogComplete, undefined)
  assert.throws(() => parseTikTokProfile({}, 'https://tiktok.com/@ez_home'))
  assert.throws(() => parseTikTokProfile({ entries: [] }, 'https://evil.example/@ez_home'))
})

test('creator discovery requires a configured host executable and respects cancellation before running', async () => {
  await assert.rejects(discoverTikTokProfile({ url: 'https://www.tiktok.com/@ez_home' }), { status: 503 })
  await assert.rejects(discoverTikTokProfile({ url: 'https://www.tiktok.com/@ez_home', config: { SPUR_YTDLP_BIN: process.execPath }, signal: AbortSignal.abort() }), /cancelled/)
})

test('creator artwork comes from the matching profile state instead of video or playlist covers', () => {
  assert.deepEqual(parseTikTokCreatorMetadata(profileHtml(), profileUrl), { name: 'EZ Home', avatarUrl: 'https://p19-common-sign.tiktokcdn-us.com/avatar.jpeg' })
  assert.deepEqual(parseTikTokCreatorMetadata(profileHtml({ uniqueId: 'EZ_HOME', avatarMedium: 'https://evil.example/photo', avatarLarger: 'https://p16.tiktokcdn.com/real-avatar.webp' }), profileUrl), { name: 'EZ Home', avatarUrl: 'https://p16.tiktokcdn.com/real-avatar.webp' })
  assert.deepEqual(parseTikTokCreatorMetadata(profileHtml({ uniqueId: 'someone_else' }), profileUrl), {})
  assert.deepEqual(parseTikTokCreatorMetadata(profileHtml().replace('id=', 'data-id='), profileUrl), {})
  assert.deepEqual(parseTikTokCreatorMetadata('<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">not JSON</script>', profileUrl), {})
  assert.deepEqual(parseTikTokCreatorMetadata(profileHtml({ avatarMedium: 'https://tiktokcdn-us.com.evil.example/photo' }), profileUrl), { name: 'EZ Home' })
  assert.equal(parseTikTokProfile({ entries: [entry('7014215295795498245')], thumbnails: [{ url: 'https://p16.tiktokcdn.com/playlist-cover.jpeg' }] }, profileUrl).avatarUrl, undefined)
})

test('public profile request is canonical, bounded, and never follows redirects', async () => {
  let requests = 0
  const result = await fetchTikTokCreatorMetadata({ url: 'https://tiktok.com/@EZ_HOME?lang=en', fetchImpl: async (url, options) => {
    requests++
    assert.equal(url, profileUrl); assert.equal(options.redirect, 'manual'); assert.equal(options.headers.cookie, undefined)
    return new Response(profileHtml(), { headers: { 'content-type': 'text/html; charset=utf-8' } })
  } })
  assert.equal(requests, 1); assert.equal(result.avatarUrl, 'https://p19-common-sign.tiktokcdn-us.com/avatar.jpeg')
  assert.deepEqual(await fetchTikTokCreatorMetadata({ url: profileUrl, fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://localhost/private' } }) }), {})
  assert.deepEqual(await fetchTikTokCreatorMetadata({ url: profileUrl, fetchImpl: async () => new Response(profileHtml(), { headers: { 'content-type': 'application/json' } }) }), {})
  assert.deepEqual(await fetchTikTokCreatorMetadata({ url: profileUrl, fetchImpl: async () => new Response(profileHtml(), { headers: { 'content-length': String(3 * 1024 * 1024) } }) }), {})
  assert.deepEqual(await fetchTikTokCreatorMetadata({ url: profileUrl, fetchImpl: async () => new Response(' '.repeat(2 * 1024 * 1024 + 1)) }), {})
})

test('blocked, malformed, cancelled, or unavailable artwork metadata remains optional', async () => {
  assert.deepEqual(await fetchTikTokCreatorMetadata({ url: profileUrl, fetchImpl: async () => { throw Error('Network failure') } }), {})
  assert.deepEqual(await fetchTikTokCreatorMetadata({ url: profileUrl, fetchImpl: async () => new Response('Please log in', { status: 403 }) }), {})
  assert.deepEqual(await fetchTikTokCreatorMetadata({ url: profileUrl, signal: AbortSignal.abort(), fetchImpl: async () => { assert.fail('No request should start after cancellation') } }), {})
  const controller = new AbortController()
  const pending = fetchTikTokCreatorMetadata({ url: profileUrl, signal: controller.signal, fetchImpl: async (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    controller.abort()
  }) })
  assert.deepEqual(await pending, {})
})
