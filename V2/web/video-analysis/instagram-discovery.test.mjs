import test from 'node:test'
import assert from 'node:assert/strict'
import { discoverInstagramChannelPage, validateInstagramConnection } from './instagram-discovery.mjs'

const config = { SPUR_INSTAGRAM_ACCESS_TOKEN: 'test-private-token', SPUR_INSTAGRAM_ACCOUNT_ID: '123456789' }
const url = 'https://www.instagram.com/creator/'
const video = (code, extra = {}) => ({ id: '987654321', caption: 'A reel\nfrom the channel', media_type: 'VIDEO', permalink: `https://www.instagram.com/reel/${code}/?igsh=public`, thumbnail_url: 'https://scontent.cdninstagram.com/reel.jpg?sig=public', timestamp: '2026-11-10T08:10:00+0000', ...extra })
const page = (data = [], paging, extra = {}) => ({ business_discovery: { username: 'creator', name: 'Creator Studio', profile_picture_url: 'https://scontent.cdninstagram.com/avatar.jpg?sig=public', media_count: 300, media: { data, ...(paging === undefined ? {} : { paging }) }, ...extra } })
const response = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
const discover = (body, options = {}) => discoverInstagramChannelPage({ url, config, fetchImpl: async () => response(body), ...options })

test('missing connection blocks full discovery without network or a false completion marker', async () => {
  const result = await discoverInstagramChannelPage({ url, fetchImpl: () => { throw Error('must not fetch') } })
  assert.equal(result.requiresConnection, true)
  assert.equal(result.authoritative, false)
  assert.equal(result.source, 'instagram_public')
  assert.equal(result.pageInfo, undefined)
  assert.deepEqual(result.discoveredVideos, [])
})

test('two real pages use nested cursors, preserve metadata and never follow next URLs or put tokens in URLs', async () => {
  const requests = []
  const fetchImpl = async (target, options) => {
    requests.push({ url: new URL(target), options })
    if (requests.length === 1) return response(page([video('one')], { next: 'https://malicious.test/?access_token=must-not-persist', cursors: { after: 'NEXT_cursor==' } }))
    return response(page([video('two')], { cursors: { before: 'PREVIOUS', after: 'LAST' } }))
  }
  const first = await discoverInstagramChannelPage({ url, config, fetchImpl })
  const second = await discoverInstagramChannelPage({ url, config, cursor: first.pageInfo.endCursor, fetchImpl })
  assert.deepEqual(first.pageInfo, { hasNextPage: true, endCursor: 'NEXT_cursor==' })
  assert.deepEqual(second.pageInfo, { hasNextPage: false })
  assert.equal(first.source, 'instagram_authorized'); assert.equal(first.authoritative, true)
  assert.equal(first.profileTotalPosts, 300); assert.equal(first.totalCount, undefined); assert.equal(first.scannedPosts, 1)
  assert.deepEqual(first.discoveredVideos[0], { url: 'https://www.instagram.com/reel/one/', title: 'A reel from the channel', thumbnailUrl: 'https://scontent.cdninstagram.com/reel.jpg?sig=public', publishedAt: '2026-11-10T08:10:00.000Z' })
  assert.equal(first.name, 'Creator Studio'); assert.ok(first.avatarUrl)
  assert.equal(second.discoveredVideos[0].url, 'https://www.instagram.com/reel/two/')
  for (const request of requests) {
    assert.equal(request.url.hostname, 'graph.facebook.com')
    assert.equal(request.url.pathname, '/v25.0/123456789')
    assert.equal(request.url.href.includes(config.SPUR_INSTAGRAM_ACCESS_TOKEN), false)
    assert.equal(request.options.headers.authorization, `Bearer ${config.SPUR_INSTAGRAM_ACCESS_TOKEN}`)
    assert.equal(request.options.redirect, 'manual')
  }
  assert.match(requests[1].url.searchParams.get('fields'), /media\.limit\(50\)\.after\(NEXT_cursor==\)/)
  assert.equal(JSON.stringify([first, second]).includes('must-not-persist'), false)
})

test('photos are excluded, video carousels included, duplicate video links collapsed, and all-post count stays separate', async () => {
  const result = await discover(page([
    video('one'), video('one'), { media_type: 'IMAGE' },
    video('carousel', { media_type: 'CAROUSEL_ALBUM', permalink: 'https://instagram.com/p/carousel/', children: { data: [{ media_type: 'IMAGE' }, { media_type: 'VIDEO' }] } }),
    { media_type: 'CAROUSEL_ALBUM', children: { data: [{ media_type: 'IMAGE' }, { media_type: 'IMAGE' }] } },
  ]))
  assert.equal(result.scannedPosts, 5); assert.equal(result.discoveredVideos.length, 2)
  assert.equal(result.discoveredVideos[1].url, 'https://www.instagram.com/p/carousel/')
  assert.equal(result.profileTotalPosts, 300)
  assert.equal(result.pageInfo.hasNextPage, false)
})

test('an empty official page is an explicit end; malformed pages never become an end', async () => {
  assert.deepEqual((await discover(page())).pageInfo, { hasNextPage: false })
  for (const body of [null, [], {}, page([], undefined, { username: 'another' }), page([], undefined, { media: { data: null } }), page([], { next: 'https://graph.facebook.com/next' }), page([video('one')], { next: 'x', cursors: { after: 'bad){id}' } }), page([video('one')], null), page([{ media_type: 'UNKNOWN' }]), page([{ media_type: 'CAROUSEL_ALBUM' }])]) {
    await assert.rejects(discover(body), { status: 502 })
  }
  await assert.rejects(discover(page([video('one')], { next: 'x', cursors: { after: 'SAME' } }), { cursor: 'SAME' }), /next-page cursor/)
})

test('injection in cursor, handle, account id, token header or version is rejected before requests', async () => {
  const noFetch = async () => { throw Error('must not fetch') }
  for (const options of [
    { cursor: 'NEXT){id}' }, { cursor: 'x'.repeat(4097) }, { url: 'https://www.instagram.com/creator/?fields=evil' },
    { url: 'https://instagram.com.evil.test/creator/' }, { url: 'https://www.instagram.com/evil%29%7Bid%7D/' },
    { config: { ...config, SPUR_INSTAGRAM_ACCOUNT_ID: '../me' } },
    { config: { ...config, SPUR_INSTAGRAM_ACCESS_TOKEN: 'secret\r\nx-evil: yes' } },
    { config: { ...config, SPUR_INSTAGRAM_API_VERSION: 'v25.0/../../' } },
  ]) await assert.rejects(discoverInstagramChannelPage({ url, config, fetchImpl: noFetch, ...options }), { status: 422 })
})

test('rate and auth errors use safe messages and do not echo upstream secrets', async () => {
  for (const [status, code, expected] of [[429, 4, 429], [400, 190, 401], [403, 10, 403], [400, 100, 422], [500, 1, 502]]) {
    await assert.rejects(discoverInstagramChannelPage({ url, config, fetchImpl: async () => new Response(JSON.stringify({ error: { code, message: `echo ${config.SPUR_INSTAGRAM_ACCESS_TOKEN}` } }), { status }) }), cause => {
      assert.equal(cause.status, expected)
      assert.equal(cause.message.includes(config.SPUR_INSTAGRAM_ACCESS_TOKEN), false)
      if ([401, 403].includes(expected)) assert.equal(cause.requiresConnection, true)
      return true
    })
  }
  await assert.rejects(discoverInstagramChannelPage({ url, config, fetchImpl: async () => { throw Error(`token ${config.SPUR_INSTAGRAM_ACCESS_TOKEN}`) } }), cause => !cause.message.includes(config.SPUR_INSTAGRAM_ACCESS_TOKEN))
})

test('redirects, oversized declarations and actual bodies, and cancellation stay bounded', async () => {
  await assert.rejects(discoverInstagramChannelPage({ url, config, fetchImpl: async () => new Response('', { status: 302, headers: { location: 'https://evil.test/' } }) }), /redirect/)
  await assert.rejects(discoverInstagramChannelPage({ url, config, fetchImpl: async () => new Response('{}', { headers: { 'content-length': String(5 * 1024 * 1024) } }) }), /too much/)
  await assert.rejects(discoverInstagramChannelPage({ url, config, fetchImpl: async () => new Response('x'.repeat(4 * 1024 * 1024 + 1)) }), /too much/)
  await assert.rejects(discoverInstagramChannelPage({ url, config, signal: AbortSignal.abort(), fetchImpl: () => { throw Error('must not fetch') } }), /cancelled/)
  const controller = new AbortController()
  const pending = discoverInstagramChannelPage({ url, config, signal: controller.signal, fetchImpl: async (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Error('aborted')))) })
  controller.abort()
  await assert.rejects(pending, /cancelled/)
})

test('unsafe image and video URLs cannot escape to stored channel metadata', async () => {
  const result = await discover(page([video('one', { thumbnail_url: 'https://evil.test/a.jpg', timestamp: 'invalid' })], undefined, { profile_picture_url: 'https://cdninstagram.com.evil.test/a.jpg' }))
  assert.equal(result.avatarUrl, undefined); assert.equal(result.discoveredVideos[0].thumbnailUrl, undefined); assert.equal(result.discoveredVideos[0].publishedAt, undefined)
  for (const permalink of ['http://instagram.com/reel/x/', 'https://evil.test/reel/x/', 'https://instagram.com/reel/../x/', 'https://secret@instagram.com/reel/x/']) await assert.rejects(discover(page([video('x', { permalink })])), /invalid video link/)
})

test('connection validation reads the own IG id and handle only', async () => {
  let target
  const result = await validateInstagramConnection(config, { fetchImpl: async url => { target = new URL(url); return response({ id: config.SPUR_INSTAGRAM_ACCOUNT_ID, username: 'Own_Account', unrelated: config.SPUR_INSTAGRAM_ACCESS_TOKEN }) } })
  assert.deepEqual(result, { id: '123456789', handle: 'own_account' })
  assert.equal(target.searchParams.get('fields'), 'id,username')
  await assert.rejects(validateInstagramConnection({}, { fetchImpl: async () => { throw Error('must not fetch') } }), { status: 422 })
  await assert.rejects(validateInstagramConnection(config, { fetchImpl: async () => response({ id: 'different', username: 'creator' }) }), /professional account ID/)
})
