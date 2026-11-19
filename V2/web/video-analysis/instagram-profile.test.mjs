import test from 'node:test'
import assert from 'node:assert/strict'
import { parseInstagramProfile, parseInstagramChannelProfile, discoverInstagramProfile } from './instagram-profile.mjs'

const video = (code, extra = {}) => ({ shortcode: code, __typename: 'GraphVideo', is_video: true, owner: { username: 'creator', is_private: false }, edge_media_to_caption: { edges: [{ node: { text: 'A public reel' } }] }, ...extra })
const page = (media, extra = {}) => `<script>init({"contextJSON":${JSON.stringify(JSON.stringify({ context: { username: 'creator', graphql_media: media.map(shortcode_media => ({ shortcode_media })), ...extra } }))}})</script>`

test('public embed selects owned videos, skips photos and keeps original individual reel URLs', () => {
  const result = parseInstagramProfile(page([
    video('photo', { __typename: 'GraphImage', is_video: false }), video('first'), video('first'),
    video('foreign', { owner: { username: 'other' } }), video('private', { owner: { username: 'creator', is_private: true } }),
    video('second', { edge_media_to_caption: { edges: [{ node: { text: 'Travel "reel" \\ sound' } }] } }),
  ]), 'CREATOR')
  assert.deepEqual(result.map(item => item.url), ['https://www.instagram.com/reel/first/', 'https://www.instagram.com/reel/second/'])
  assert.equal(result[1].title, 'Travel "reel" \\ sound')
})

test('video carousels use the parent post and unsafe or unowned codes cannot become requests', () => {
  const result = parseInstagramProfile(page([
    video('../bad'), video('evil/?url=https://localhost'),
    video('carousel', { is_video: false, __typename: 'GraphSidecar', edge_sidecar_to_children: { edges: [{ node: { is_video: true } }] } }),
  ]), 'creator')
  assert.deepEqual(result, [{ url: 'https://www.instagram.com/p/carousel/', title: 'A public reel' }])
})

test('login pages, other profiles, private and empty previews are explicit failures', () => {
  for (const html of ['<h1>Log in</h1>', '{"contextJSON":"bad json"}', page([]), page([video('ok')], { username: 'other' })]) assert.throws(() => parseInstagramProfile(html, 'creator'))
  assert.throws(() => parseInstagramProfile(page([video('ok')], { is_private: true }), 'creator'), { status: 401 })
  assert.throws(() => parseInstagramProfile(page([video('ok')]), '../creator'))
  assert.throws(() => parseInstagramProfile('x'.repeat(4 * 1024 * 1024 + 1), 'creator'))
})

test('discovery reads only the official public embed without cookies and preserves profile provenance', async () => {
  let target, options, checked
  const result = await discoverInstagramProfile(new URL('https://www.instagram.com/creator/'), {
    checkHost: async url => { checked = url.href },
    fetchImpl: async (url, args) => { target = url.href; options = args; return new Response(page([video('working')]), { headers: { 'content-type': 'text/html' } }) },
  })
  assert.equal(target, 'https://www.instagram.com/creator/embed/')
  assert.equal(checked, target); assert.equal(options.redirect, 'manual'); assert.equal(options.headers.cookie, undefined)
  assert.equal(result.profileUrl, 'https://www.instagram.com/creator/')
  assert.equal(result.discoveryMethod, 'public_profile_embed')
  assert.equal(result.reels[0].url, 'https://www.instagram.com/reel/working/')
})

test('redirects, rate limits, oversized responses and cancellation do not fall through to download', async () => {
  const url = new URL('https://www.instagram.com/creator/')
  await assert.rejects(discoverInstagramProfile(url, { fetchImpl: async () => new Response('', { status: 302, headers: { location: 'http://localhost/' } }) }))
  await assert.rejects(discoverInstagramProfile(url, { fetchImpl: async () => new Response('', { status: 429 }) }), { status: 429 })
  await assert.rejects(discoverInstagramProfile(url, { fetchImpl: async () => new Response('x', { headers: { 'content-length': String(5 * 1024 * 1024) } }) }))
  await assert.rejects(discoverInstagramProfile(url, { signal: AbortSignal.abort(), fetchImpl: async () => { throw Error('must not fetch') } }), /cancelled/)
})

test('channel catalogue includes actual handle, display name, avatar, thumbnails and publication time', () => {
  const result = parseInstagramChannelProfile(page([video('one', { display_url: 'https://scontent.cdninstagram.com/reel.jpg?sig=public', taken_at_timestamp: 1792488776 })], {
    full_name: 'Creator\nStudio', profile_pic_url: 'https://scontent.cdninstagram.com/avatar.jpg?sig=public',
  }), 'CREATOR')
  assert.equal(result.handle, 'creator'); assert.equal(result.name, 'Creator Studio')
  assert.equal(result.url, 'https://www.instagram.com/creator/')
  assert.equal(result.avatarUrl, 'https://scontent.cdninstagram.com/avatar.jpg?sig=public')
  assert.equal(result.videos[0].thumbnailUrl, 'https://scontent.cdninstagram.com/reel.jpg?sig=public')
  assert.equal(result.videos[0].publishedAt, '2026-10-20T09:32:56.000Z')
  assert.deepEqual(parseInstagramProfile(page([video('one', { display_url: 'https://scontent.cdninstagram.com/reel.jpg' })]), 'creator'), [{ url: 'https://www.instagram.com/reel/one/', title: 'A public reel' }])
})

test('channel artwork cannot expose arbitrary hosts and empty public catalogue stays honest', () => {
  const result = parseInstagramChannelProfile(page([video('one', { display_url: 'https://evil.test/track.svg', taken_at_timestamp: 'not-a-date' })], {
    full_name: '', profile_pic_url: 'https://cdninstagram.com.evil.test/a.jpg',
  }), 'creator')
  assert.equal(result.name, 'creator'); assert.equal(result.avatarUrl, undefined)
  assert.equal(result.videos[0].thumbnailUrl, undefined); assert.equal(result.videos[0].publishedAt, undefined)
  assert.deepEqual(parseInstagramChannelProfile(page([]), 'creator').videos, [])
  assert.throws(() => parseInstagramProfile(page([]), 'creator'), /No public video/)
})
