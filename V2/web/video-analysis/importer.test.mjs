import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyVideoUrl, isPublicAddress, socialDownloadError, resolveTikTokUrl, creatorHandleFromMetadata } from './importer.mjs'

test('creator identity uses the actual channel handle rather than Instagram numeric account PK', () => {
  assert.equal(creatorHandleFromMetadata({ channel: 'dreamcode_films', uploaderId: '76355589902', uploader: 'Dreamcode Films' }, { instagram: true }), 'dreamcode_films')
  assert.equal(creatorHandleFromMetadata({ channel: null, uploaderId: '63745943957', uploader: 'gdarusa' }, { instagram: true }), 'gdarusa')
  assert.equal(creatorHandleFromMetadata({ channel: null, uploaderId: '@gdarusa', uploader: 'Daria Gorbunova' }, { instagram: true }), 'gdarusa')
  assert.equal(creatorHandleFromMetadata({ channel: 'null', uploaderId: '63745943957', uploader: 'Daria Gorbunova' }, { instagram: true }), undefined)
  assert.equal(creatorHandleFromMetadata({ channel: 'bad-name', uploaderId: '76355589902' }, { instagram: true }), undefined)
})

test('TikTok video and share links are canonicalized without enabling profiles, photos or live streams', () => {
  for (const host of ['tiktok.com', 'www.tiktok.com', 'm.tiktok.com']) {
    assert.equal(classifyVideoUrl(`https://${host}/@creator.name/video/6748451240264420610/?_t=tracking`).url.href, 'https://www.tiktok.com/@creator.name/video/6748451240264420610')
  }
  for (const host of ['vm.tiktok.com', 'vt.tiktok.com']) assert.equal(classifyVideoUrl(`https://${host}/ZTR45GpSF/?share=test`).url.href, `https://${host}/ZTR45GpSF/`)
  assert.equal(classifyVideoUrl('https://www.tiktok.com/t/ZTRC5xgJp?share=test').url.href, 'https://www.tiktok.com/t/ZTRC5xgJp/')
  assert.equal(classifyVideoUrl('https://www.tiktok.com/@Creator/?lang=en').url.href, 'https://www.tiktok.com/@creator')
  for (const url of ['https://www.tiktok.com/@creator/live', 'https://www.tiktok.com/@creator/photo/6748451240264420610',
    'https://www.tiktok.com/redirect?url=https://localhost', 'https://vm.tiktok.com/redirect/extra', 'https://evil.tiktok.com/@creator/video/6748451240264420610',
    'https://www.tiktok.com.evil.test/@creator/video/6748451240264420610', 'https://www.tiktok.com/@creator/video/bad', 'http://vm.tiktok.com/ZTR45GpSF/',
    'https://user:pass@vt.tiktok.com/ZTR45GpSF/', 'https://vt.tiktok.com:8443/ZTR45GpSF/']) assert.throws(() => classifyVideoUrl(url), Error, url)
})

test('TikTok share expansion checks each destination and returns the full original video without tracking', async () => {
  const checked = [], requests = []
  const result = await resolveTikTokUrl('https://vm.tiktok.com/ZTR45GpSF/', {
    checkHost: async url => checked.push(url.hostname),
    fetchImpl: async (url, options) => {
      requests.push(url.href); assert.equal(options.redirect, 'manual')
      return new Response(null, { status: 302, headers: { location: requests.length === 1 ? 'https://www.tiktok.com/t/ZTRC5xgJp/' : 'https://www.tiktok.com/@creator/video/6748451240264420610?_t=tracking' } })
    },
  })
  assert.equal(result.href, 'https://www.tiktok.com/@creator/video/6748451240264420610')
  assert.deepEqual(checked, ['vm.tiktok.com', 'www.tiktok.com', 'www.tiktok.com']); assert.equal(requests.length, 2)
})

test('TikTok shares cannot redirect to another service, local addresses, unsafe routes or a private DNS result', async () => {
  for (const location of ['http://127.0.0.1/media', 'https://www.tiktok.com:8443/@creator/video/6748451240264420610',
    'https://www.youtube.com/watch?v=abcdefghijk', 'https://www.tiktok.com/redirect?url=https://localhost']) {
    let count = 0
    await assert.rejects(resolveTikTokUrl('https://vt.tiktok.com/ZTR45GpSF/', { checkHost: async () => {}, fetchImpl: async () => {
      count++; return new Response(null, { status: 302, headers: { location } })
    } }))
    assert.equal(count, 1)
  }
  await assert.rejects(resolveTikTokUrl('https://vt.tiktok.com/ZTR45GpSF/', { checkHost: async () => { throw Error('Private address') }, fetchImpl: async () => { throw Error('must not fetch') } }), /could not be reached/)
})

test('TikTok share failures, loops and cancellation stay bounded and platform-specific', async () => {
  const url = 'https://vt.tiktok.com/ZTR45GpSF/'
  await assert.rejects(resolveTikTokUrl(url, { checkHost: async () => {}, fetchImpl: async () => new Response(null, { status: 429 }) }), { status: 429 })
  await assert.rejects(resolveTikTokUrl(url, { checkHost: async () => {}, fetchImpl: async () => new Response('login') }), /full @creator\/video link/)
  let requests = 0
  await assert.rejects(resolveTikTokUrl(url, { checkHost: async () => {}, fetchImpl: async () => { requests++; return new Response(null, { status: 302, headers: { location: url } }) } }), /too many/)
  assert.equal(requests, 6)
  await assert.rejects(resolveTikTokUrl(url, { signal: AbortSignal.abort() }), /cancelled/)
  assert.match(socialDownloadError(new URL(url), 'Unable to extract webpage video data').message, /^TikTok/)
  assert.match(socialDownloadError(new URL(url), 'Video not available in your country').message, /this connection/)
  const blocked = socialDownloadError(new URL(url), 'Your IP address is blocked from accessing this post')
  assert.equal(blocked.status, 403); assert.match(blocked.message, /^TikTok blocked access from this connection/)
})

test('accepts supplied Instagram channels, direct reels and direct supported videos', () => {
  for (const url of ['https://www.instagram.com/dreamcode_films/', 'https://www.instagram.com/gdarusa/',
    'https://www.instagram.com/reel/ABC_def-123/', 'https://youtu.be/abcdefghijk',
    'https://www.youtube.com/watch?v=abcdefghijk', 'https://www.youtube.com/shorts/abcdefghijk', 'https://vimeo.com/1234567']) {
    assert.equal(classifyVideoUrl(url).kind, 'social')
  }
  assert.equal(classifyVideoUrl('https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4').kind, 'direct')
  assert.equal(classifyVideoUrl('https://media.w3.org/2010/05/sintel/trailer.mp4').kind, 'direct')
})
test('canonicalizes Instagram reel aliases and creator-prefixed links without tracking data', () => {
  for (const raw of ['https://instagram.com/reel/DepDMxUAQPe?igsh=tracking',
    'https://www.instagram.com/reels/DepDMxUAQPe/',
    'https://www.instagram.com/dreamcode_films/reel/DepDMxUAQPe/?utm_source=test']) {
    assert.equal(classifyVideoUrl(raw).url.href, 'https://www.instagram.com/reel/DepDMxUAQPe/')
  }
  for (const raw of ['https://instagram.com/p/ABC_def-123?img_index=1',
    'https://www.instagram.com/tv/ABC_def-123/', 'https://instagram.com/gdarusa/tv/ABC_def-123/']) {
    assert.equal(classifyVideoUrl(raw).url.href, 'https://www.instagram.com/p/ABC_def-123/')
  }
  assert.equal(classifyVideoUrl('https://instagram.com/dreamcode_films?hl=en').url.href, 'https://www.instagram.com/dreamcode_films/')
  assert.equal(classifyVideoUrl('https://www.youtube.com/watch?v=abcdefghijk&t=3').url.searchParams.get('t'), '3')
})
test('does not mistake Instagram application routes or malformed paths for channels', () => {
  for (const route of ['accounts', 'explore', 'direct', 'reels', 'reel', 'p', 'tv', 'share', 'stories', 'api', 'graphql']) {
    assert.throws(() => classifyVideoUrl(`https://www.instagram.com/${route}/`), Error, route)
  }
  for (const raw of ['https://www.instagram.com/accounts/reel/abc/', 'https://www.instagram.com//reel/abc/',
    'https://www.instagram.com/user/reel/abc/extra/', 'https://www.instagram.com/user/reel/abc%2Fdef/',
    'https://www.instagram.com/user/REEL/abc/', 'https://www.instagram.com/user..name/',
    'https://www.instagram.com/.username/', 'https://www.instagram.com/username./',
    'https://www.instagram.com/reels/audio/abc/', 'https://www.instagram.com/share/reel/abc/']) {
    assert.throws(() => classifyVideoUrl(raw), Error, raw)
  }
})
test('rejects arbitrary hosts, credentials, unsupported paths and trusted-site redirect endpoints', () => {
  for (const url of ['file:///etc/passwd', 'http://www.instagram.com/gdarusa/', 'https://localhost/a.mp4',
    'https://127.0.0.1/a.mp4', 'https://example.com/a.mp4', 'https://youtube.com/redirect?q=https://127.0.0.1',
    'https://vimeo.com/log_in', 'https://user:pass@www.instagram.com/gdarusa/',
    'https://storage.googleapis.com/private-bucket/a.mp4', 'https://www.youtube.com/watch?v=bad',
    'https://www.instagram.com/accounts/login/', 'https://www.instagram.com:8443/gdarusa/']) {
    assert.throws(() => classifyVideoUrl(url), Error, url)
  }
})
test('private and link-local IPs cannot pass download DNS checks', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.9.9', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '0.0.0.0', '224.0.0.1', '::1', '::ffff:127.0.0.1', 'fe80::1', 'fc00::1', 'fd00::1', 'not-an-ip']) assert.equal(isPublicAddress(address), false, address)
  assert.equal(isPublicAddress('8.8.8.8'), true)
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true)
})

test('categorizes social download failures with safe messages and useful status codes', () => {
  const reel = new URL('https://www.instagram.com/reel/DepDMxUAQPe/')
  for (const [diagnostic, status, expected] of [
    ['ERROR: Downloaded file is larger than max-filesize', 413, /150 MiB/],
    ['does not pass filter (duration <= 300 & !is_live)', 422, /five minutes/],
    ['HTTP Error 429: Too Many Requests', 429, /temporarily limited/],
    ['Login required. Use --cookies-from-browser', 401, /authorized signed-in connection/],
    ['This is a private video', 401, /signed-in/],
    ['Unable to download webpage: connection reset', 502, /could not be reached/],
    ['Requested format is not available', 422, /playable video/],
    ['No video formats found', 422, /playable video/],
    ['unknown extractor failure', 422, /public and still available/],
  ]) {
    const result = socialDownloadError(reel, diagnostic)
    assert.equal(result.status, status, diagnostic)
    assert.match(result.message, expected, diagnostic)
  }
  assert.match(socialDownloadError(new URL('https://www.instagram.com/gdarusa/'), 'known broken extractor').message, /channel listing is unavailable/)
  assert.match(socialDownloadError(new URL('https://www.youtube.com/watch?v=abcdefghijk'), 'No video formats found').message, /^The platform/)
})

test('never exposes downloader diagnostics or session details in failure messages', () => {
  const result = socialDownloadError(new URL('https://www.instagram.com/reel/DepDMxUAQPe/'),
    'Login required: C:\\Users\\Private\\cookies.txt sessionid=DO_NOT_EXPOSE https://cdn.example/signed?token=SECRET')
  assert.equal(result.status, 401)
  assert.doesNotMatch(result.message, /Private|cookies\.txt|sessionid|DO_NOT_EXPOSE|SECRET|cdn\.example/)
})
