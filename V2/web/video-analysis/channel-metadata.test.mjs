import test from 'node:test'
import assert from 'node:assert/strict'
import { channelImageUrl, fetchChannelImage } from './channel-metadata.mjs'

const avatar = 'https://scontent-sjc6-1.cdninstagram.com/v/avatar.jpg?signature=public'
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
const resolver = async () => [{ address: '157.240.1.35', family: 4 }]

test('artwork URL allowlist excludes arbitrary origins, credentials and unsafe schemes', () => {
  assert.equal(channelImageUrl(avatar), avatar)
  assert.equal(channelImageUrl('https://scontent.xx.fbcdn.net/image.jpg'), 'https://scontent.xx.fbcdn.net/image.jpg')
  for (const url of ['http://scontent.cdninstagram.com/a.jpg', 'https://cdninstagram.com.evil.test/a.jpg', 'https://evilcdninstagram.com/a.jpg', 'https://user:pass@scontent.cdninstagram.com/a.jpg', 'https://scontent.cdninstagram.com:8443/a.jpg', 'https://scontent.cdninstagram.com/a.jpg#fragment', 'data:image/svg+xml,test', null]) assert.equal(channelImageUrl(url), undefined)
})

test('official image download preserves bytes and validates MIME and raster magic', async () => {
  let options
  const result = await fetchChannelImage(avatar, { resolver, fetchImpl: async (url, args) => {
    assert.equal(url.href, avatar); options = args
    return new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } })
  } })
  assert.equal(result.contentType, 'image/jpeg'); assert.deepEqual(result.bytes, jpeg)
  assert.equal(options.redirect, 'manual'); assert.equal(options.headers.cookie, undefined)
  for (const [bytes, type] of [[jpeg, 'image/png'], ['<svg/>', 'image/svg+xml'], ['<html>login</html>', 'image/jpeg']]) {
    await assert.rejects(fetchChannelImage(avatar, { resolver, fetchImpl: async () => new Response(bytes, { headers: { 'content-type': type } }) }), /supported image/)
  }
})

test('artwork redirects and every DNS answer must remain public and within official CDNs', async () => {
  let fetched = 0
  const fetchImpl = async () => { fetched++; return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } }) }
  await assert.rejects(fetchChannelImage(avatar, { resolver, fetchImpl }), /unsupported host/)
  assert.equal(fetched, 1)
  for (const address of ['127.0.0.1', '169.254.169.254', '192.168.1.1', '::ffff:127.0.0.1', '2001:db8::1']) {
    await assert.rejects(fetchChannelImage(avatar, { resolver: async () => [{ address }], fetchImpl: async () => { throw Error('must not fetch') } }), /public internet/)
  }
  const checked = []
  const result = await fetchChannelImage(avatar, { resolver: async host => { checked.push(host); return resolver() }, fetchImpl: async url => url.hostname.includes('sjc6') ? new Response(null, { status: 302, headers: { location: 'https://scontent.fbcdn.net/avatar.jpg' } }) : new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } }) })
  assert.equal(result.contentType, 'image/jpeg'); assert.deepEqual(checked, ['scontent-sjc6-1.cdninstagram.com', 'scontent.fbcdn.net'])
})

test('artwork length, streaming bytes, redirects and cancellation are bounded', async () => {
  await assert.rejects(fetchChannelImage(avatar, { resolver, fetchImpl: async () => new Response(jpeg, { headers: { 'content-type': 'image/jpeg', 'content-length': String(2 * 1024 * 1024 + 1) } }) }), { status: 413 })
  await assert.rejects(fetchChannelImage(avatar, { resolver, fetchImpl: async () => new Response(Buffer.alloc(2 * 1024 * 1024 + 1), { headers: { 'content-type': 'image/jpeg' } }) }), { status: 413 })
  let count = 0
  await assert.rejects(fetchChannelImage(avatar, { resolver, fetchImpl: async () => { count++; return new Response(null, { status: 302, headers: { location: avatar } }) } }), /too many redirects/)
  assert.equal(count, 4)
  await assert.rejects(fetchChannelImage(avatar, { signal: AbortSignal.abort(), fetchImpl: async () => { throw Error('must not fetch') } }), /cancelled/)
})
