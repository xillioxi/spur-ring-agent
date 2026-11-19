import { spawn } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { open, readdir, stat, realpath, unlink } from 'node:fs/promises'
import path from 'node:path'
import { discoverInstagramProfile } from './instagram-profile.mjs'
import { discoverTikTokProfile } from './tiktok-profile.mjs'
import { probeImportedVideo } from './imported-media.mjs'
import { channelImageUrl } from './channel-metadata.mjs'
import { discoverInstagramChannelPage } from './instagram-discovery.mjs'
export { validateInstagramConnection } from './instagram-discovery.mjs'

const TIKTOK = new Set(['tiktok.com', 'www.tiktok.com', 'm.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com'])
const SOCIAL = new Set(['instagram.com', 'www.instagram.com', 'youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'vimeo.com', 'www.vimeo.com', ...TIKTOK])
const DIRECT = new Set(['upload.wikimedia.org', 'storage.googleapis.com', 'media.w3.org'])
const LIMIT = 150 * 1024 * 1024
const error = (message, status = 422) => Object.assign(new Error(message), { status })
const INSTAGRAM_ROUTES = new Set(['accounts', 'about', 'api', 'audio', 'challenge', 'developer', 'direct', 'directory', 'emails', 'explore', 'graphql', 'legal', 'oauth', 'p', 'privacy', 'reel', 'reels', 'share', 'stories', 'terms', 'tv', 'web'])
const instagramUsername = value => /^(?!\.)(?!.*\.\.)(?!.*\.$)[A-Za-z0-9_.]{1,30}$/.test(value) && !INSTAGRAM_ROUTES.has(value.toLowerCase())

/** Account PKs are not handles. Prefer the extractor's explicit channel name. */
export function creatorHandleFromMetadata(record, { instagram = false } = {}) {
  for (const value of [record?.channel, record?.uploaderId, record?.uploader]) {
    if (typeof value !== 'string' || value === 'null') continue
    const handle = value.replace(/^@/, '')
    if (/^\d+$/.test(handle)) continue
    if (instagram ? instagramUsername(handle) : /^[A-Za-z0-9_.-]{1,100}$/.test(handle)) return handle
  }
  return undefined
}

function canonicalInstagramUrl(url) {
  const parts = url.pathname.split('/').filter(Boolean)
  // Only a trailing slash is optional. Do not reinterpret malformed paths.
  if (url.pathname.includes('//')) throw error('Paste an Instagram reel or public channel link.')
  let route, shortcode
  if (parts.length === 2) [route, shortcode] = parts
  else if (parts.length === 3 && instagramUsername(parts[0])) [, route, shortcode] = parts
  if (['reel', 'reels', 'p', 'tv'].includes(route) && /^[A-Za-z0-9_-]{1,64}$/.test(shortcode || '')) {
    return new URL(`https://www.instagram.com/${['reel', 'reels'].includes(route) ? 'reel' : 'p'}/${shortcode}/`)
  }
  if (parts.length === 1 && instagramUsername(parts[0])) return new URL(`https://www.instagram.com/${parts[0]}/`)
  throw error('Paste an Instagram reel or public channel link.')
}

function canonicalTikTokUrl(url) {
  const shortHost = ['vm.tiktok.com', 'vt.tiktok.com'].includes(url.hostname)
  if (shortHost && /^\/[A-Za-z0-9]{6,64}\/?$/.test(url.pathname)) return new URL(`https://${url.hostname}${url.pathname.replace(/\/$/, '')}/`)
  if (!shortHost) {
    const profile = url.pathname.match(/^\/@([A-Za-z0-9_.]{1,30})\/?$/)
    if (profile) return new URL(`https://www.tiktok.com/@${profile[1].toLowerCase()}`)
    const video = url.pathname.match(/^\/@([A-Za-z0-9_.-]{1,64})\/video\/(\d{10,25})\/?$/)
    if (video) return new URL(`https://www.tiktok.com/@${video[1]}/video/${video[2]}`)
    const share = url.pathname.match(/^\/t\/([A-Za-z0-9]{6,64})\/?$/)
    if (share) return new URL(`https://www.tiktok.com/t/${share[1]}/`)
  }
  throw error('Paste an individual TikTok video link or its vm.tiktok.com / vt.tiktok.com share link.')
}

export function isPublicAddress(address) {
  const family = isIP(address)
  if (family === 4) {
    const [a, b] = address.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127 || a === 198 && [18, 19].includes(b))
  }
  if (family === 6) {
    const value = address.toLowerCase()
    return !value.startsWith('::') && !value.startsWith('fc') && !value.startsWith('fd') && !/^fe[89ab]/.test(value) && !value.startsWith('ff') && !value.startsWith('2001:db8:')
  }
  return false
}

export function classifyVideoUrl(raw) {
  let url
  try { url = new URL(raw) } catch { throw error('Paste a valid HTTPS video link.') }
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' || url.hash) throw error('Use a public HTTPS video link without credentials.')
  if (SOCIAL.has(url.hostname)) {
    if (url.hostname === 'instagram.com' || url.hostname === 'www.instagram.com') url = canonicalInstagramUrl(url)
    if (TIKTOK.has(url.hostname)) url = canonicalTikTokUrl(url)
    if (url.hostname === 'youtu.be' && !/^\/[A-Za-z0-9_-]{11}\/?$/.test(url.pathname)) throw error('Paste a direct YouTube video link.')
    if (url.hostname.endsWith('youtube.com') && !(url.pathname === '/watch' && /^[A-Za-z0-9_-]{11}$/.test(url.searchParams.get('v') || '') || /^\/(?:shorts|embed)\/[A-Za-z0-9_-]{11}\/?$/.test(url.pathname))) throw error('Paste a direct YouTube video or Shorts link.')
    if (url.hostname.endsWith('vimeo.com') && !/^\/(?:\d+|channels\/[A-Za-z0-9_-]+\/\d+)\/?$/.test(url.pathname)) throw error('Paste a direct Vimeo video link.')
    return { url, kind: 'social' }
  }
  if (DIRECT.has(url.hostname) && /\.(mp4|webm|mov)$/i.test(url.pathname)) {
    if (url.hostname === 'storage.googleapis.com' && !url.pathname.startsWith('/gtv-videos-bucket/sample/')) throw error('That video host is not supported. Upload the file instead.')
    if (url.hostname === 'media.w3.org' && !url.pathname.startsWith('/2010/05/')) throw error('That video host is not supported. Upload the file instead.')
    return { url, kind: 'direct' }
  }
  throw error('Use an Instagram, TikTok, YouTube or Vimeo video link, or upload the video file.')
}

export function socialDownloadError(url, diagnostic = '') {
  // Diagnostics may contain local paths, request headers or session details. Use
  // them only to select a fixed, safe message; never return their contents.
  const detail = String(diagnostic).slice(0, 128 * 1024).toLowerCase()
  const instagram = url.hostname === 'instagram.com' || url.hostname === 'www.instagram.com'
  const site = instagram ? 'Instagram' : TIKTOK.has(url.hostname) ? 'TikTok' : 'The platform'
  if (/max.?filesize|larger than max|file(?:size| size).*(?:exceed|limit|too (?:large|big))/.test(detail)) return error('The video exceeds the 150 MiB import limit.', 413)
  if (/does not pass filter|duration.*(?:exceed|limit|too long)|live stream.*(?:not supported|unsupported)/.test(detail)) return error('Choose a recorded video of five minutes or less.', 422)
  if (/too many requests|rate.?limit|http error 429|temporarily blocked|please wait a few minutes/.test(detail)) return error(`${site} temporarily limited video requests. Try again later or use another reel.`, 429)
  if (/ip address is blocked|blocked from accessing this post|access denied|http error 403/.test(detail)) return error(`${site} blocked access from this connection. Try another public video or upload the video file.`, 403)
  if (/geo.?restrict|not available in your (?:country|region)|not available from your location/.test(detail)) return error(`${site} does not make this video available from this connection. Try another public video or upload its file.`)
  if (/captcha|verify (?:that )?you are human|security check|verification required/.test(detail)) return error(`${site} requires browser verification for this video. Try another public video or upload its file.`)
  if (/login.?required|log(?:ged)?[ -]?in|sign[ -]?in|private (?:post|video|account)|registered users|cookies are no longer valid|challenge_required|checkpoint_required/.test(detail)) return error(`${site} requires an authorized signed-in connection for this video. Public reels may still work.`, 401)
  if (/timed? ?out|timeout|connection (?:reset|refused|aborted)|unable to (?:connect|download)|name or service not known|temporary failure in name resolution|certificate verify failed|http error 50[0234]/.test(detail)) return error(`${site} could not be reached. Try importing this video again.`, 502)
  if (instagram && /^\/[A-Za-z0-9_.]+\/$/.test(url.pathname)) return error('Instagram channel listing is unavailable. Add an individual reel link from this channel.', 422)
  if (/no video|no (?:video )?formats|requested format.*not available|only images|photo(?:graph)? post/.test(detail)) return error(`${site} did not return a playable video. Choose an individual video or reel.`, 422)
  return error(`${site} could not provide this video. Check that the individual reel is public and still available.`, 422)
}

async function checkPublicHost(url, resolver = lookup) {
  const addresses = await resolver(url.hostname, { all: true, verbatim: true })
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw error('Video links must resolve to a public internet address.')
}

/** Expand share links only within TikTok; never hand an arbitrary redirect to an extractor. */
export async function resolveTikTokUrl(initial, { signal, fetchImpl = fetch, checkHost = checkPublicHost } = {}) {
  let url = classifyVideoUrl(initial.href || initial).url
  if (!TIKTOK.has(url.hostname)) throw error('Provide a TikTok video link.')
  if (/^\/@[^/]+$/.test(url.pathname)) throw error('Use a TikTok video or share link for video resolution.')
  const controller = new AbortController(), abort = () => controller.abort()
  if (signal?.aborted) throw error('Video import cancelled.')
  signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, 20_000)
  try {
    for (let hop = 0; hop < 6; hop++) {
      await checkHost(url)
      if (url.pathname.includes('/video/')) return url
      const response = await fetchImpl(url, { redirect: 'manual', signal: controller.signal, headers: { 'user-agent': 'Mozilla/5.0', accept: 'text/html' } })
      await response.body?.cancel()
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        if (response.status === 429) throw socialDownloadError(url, 'HTTP Error 429')
        throw error('TikTok could not expand this share link. Paste the full @creator/video link from the video page.')
      }
      const location = response.headers.get('location')
      if (!location) throw error('TikTok returned an incomplete share link.')
      const next = classifyVideoUrl(new URL(location, url).href).url
      if (!TIKTOK.has(next.hostname)) throw error('The TikTok share link redirected outside TikTok.')
      url = next
    }
    throw error('TikTok returned too many share-link redirects.')
  } catch (cause) {
    if (controller.signal.aborted) throw error(signal?.aborted ? 'Video import cancelled.' : 'TikTok share-link lookup timed out.')
    if (cause?.status) throw cause
    throw error('TikTok could not be reached. Try the full video link again.', 502)
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}

export async function capabilities(config = {}) {
  const binary = config.SPUR_YTDLP_BIN
  const downloadable = typeof binary === 'string' && path.isAbsolute(binary) && await stat(binary).then(info => info.isFile(), () => false)
  const probe = config.SPUR_FFPROBE_BIN || config.SPUR_FFPROBE_PATH
  const verifiable = typeof probe === 'string' && path.isAbsolute(probe) && await stat(probe).then(info => info.isFile(), () => false)
  return { linkImportAvailable: downloadable && verifiable, directSampleImportAvailable: verifiable, supportedSites: ['Instagram', 'TikTok', 'YouTube', 'Vimeo'],
    instagramProfileImportAvailable: downloadable && verifiable,
    notes: ['Public Instagram channel links resolve one video from the public embed preview. Private, unavailable or rate-limited content may still require an authorized connection.'] }
}

async function directDownload(initial, destination, { maxBytes, signal, onProgress }) {
  let url = initial
  for (let redirect = 0; redirect < 4; redirect++) {
    classifyVideoUrl(url.href); await checkPublicHost(url)
    const response = await fetch(url, { redirect: 'manual', signal, headers: { 'user-agent': 'Spur-Reference-Video/1.0' } })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel()
      const location = response.headers.get('location')
      if (!location) throw error('The video host returned an invalid redirect.')
      url = new URL(location, url)
      if (classifyVideoUrl(url.href).kind !== 'direct') throw error('The video redirect is unsupported.')
      continue
    }
    if (!response.ok || !response.body) throw error('The video host did not provide a downloadable video.')
    if (Number(response.headers.get('content-length')) > maxBytes) { await response.body.cancel(); throw error('The video exceeds the 150 MiB limit.', 413) }
    const type = response.headers.get('content-type') || ''
    if (type.includes('text/') || type.includes('application/json')) { await response.body.cancel(); throw error('That link returned a page instead of a video.') }
    const handle = await open(destination, 'wx', 0o600)
    let bytes = 0, last = 0
    try {
      for await (const chunk of response.body) {
        bytes += chunk.length
        if (bytes > maxBytes) throw error('The video exceeds the 150 MiB limit.', 413)
        await handle.writeFile(chunk)
        if (Date.now() - last > 2000) { onProgress?.(`Downloading video · ${(bytes / 1024 / 1024).toFixed(1)} MB`); last = Date.now() }
      }
    } finally { await handle.close() }
    if (!bytes) throw error('The video download was empty.')
    return { filePath: destination, title: decodeURIComponent(path.basename(url.pathname, path.extname(url.pathname))), sourceUrl: url.href }
  }
  throw error('The video host returned too many redirects.')
}

function socialDownload(url, directory, { config, maxBytes, maxDurationSeconds, signal, onProgress }) {
  const binary = config.SPUR_YTDLP_BIN
  if (typeof binary !== 'string' || !path.isAbsolute(binary)) throw error('Link importing is not installed. Upload the video file instead.', 503)
  // Instagram frequently omits dimensions/duration on progressive MP4 entries.
  // Keep these candidates, support portrait 1080x1920, and prefer combined A/V.
  // Split streams are always paired with audio and merged; never select a bare
  // video stream as a fallback. The host probes downloaded media before saving.
  const dimensions = '[width<=?1920][height<=?1920]'
  const format = `best[ext=mp4]${dimensions}/bestvideo[ext=mp4]${dimensions}+bestaudio[ext=m4a]/best${dimensions}/bestvideo${dimensions}+bestaudio`
  const args = ['--ignore-config', '--no-colors', '--no-overwrites', '--no-part', '--output-na-placeholder', 'null', '--use-extractors', 'default,-generic', '--playlist-items', '1', '--playlist-end', '1',
    '--max-downloads', '1', '--max-filesize', String(maxBytes), '--match-filter', `duration <=? ${maxDurationSeconds} & !is_live`,
    '--socket-timeout', '20', '--retries', '1', '--fragment-retries', '1', '--no-continue',
    '--format', format, '--merge-output-format', 'mp4', '--output', path.join(directory, 'reference.%(ext)s'),
    '--print', 'after_move:{"filepath":%(filepath)j,"title":%(title)j,"sourceUrl":%(webpage_url)j,"duration":%(duration)j,"channel":%(channel)j,"uploader":%(uploader)j,"uploaderId":%(uploader_id)j,"thumbnailUrl":%(thumbnail)j}', url.href]
  if (config.SPUR_FFMPEG_BIN || config.SPUR_FFMPEG_PATH) args.unshift('--ffmpeg-location', config.SPUR_FFMPEG_BIN || config.SPUR_FFMPEG_PATH)
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(error('Video import cancelled.'))
    const child = spawn(binary, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', failure, checking = false
    const stop = message => { failure ||= error(message); child.kill() }
    const abort = () => stop('Video import cancelled.')
    signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => stop('The video import timed out. Upload its file instead.'), 240_000)
    const watcher = setInterval(async () => {
      if (checking) return
      checking = true
      try {
        let bytes = 0
        for (const name of await readdir(directory)) { const info = await stat(path.join(directory, name)); if (info.isFile()) bytes += info.size }
        if (bytes > maxBytes + 1024 * 1024) stop('The video exceeds the 150 MiB limit.')
        else onProgress?.(`Importing public video${bytes ? ` · ${(bytes / 1024 / 1024).toFixed(1)} MB` : '…'}`)
      } catch {} finally { checking = false }
    }, 1500)
    const clean = () => { clearTimeout(timer); clearInterval(watcher); signal?.removeEventListener('abort', abort) }
    child.stdout.on('data', chunk => { stdout += chunk.toString(); if (stdout.length > 512 * 1024) stop('The video importer returned too much metadata.') })
    child.stderr.on('data', chunk => { if (stderr.length < 128 * 1024) stderr += chunk.toString() })
    child.once('error', () => { clean(); reject(error('The video importer could not start. Upload the file instead.', 503)) })
    child.once('close', async code => {
      clean()
      if (failure) return reject(failure)
      const records = stdout.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
      const record = records.find(item => typeof item.filepath === 'string')
      // yt-dlp may exit with its max-downloads code after successfully downloading one item.
      if ((!record || ![0, 101].includes(code))) {
        return reject(socialDownloadError(url, stderr))
      }
      try {
        const resolved = await realpath(record.filepath), root = await realpath(directory), relative = path.relative(root, resolved)
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw error('The importer returned an invalid media path.')
        const info = await stat(resolved)
        if (!info.isFile() || info.size > maxBytes || Number(record.duration) > maxDurationSeconds) throw error('The imported video exceeds the file or duration limit.')
        const media = await probeImportedVideo(resolved, { config, signal, maxDurationSeconds })
        const creatorHandle = creatorHandleFromMetadata(record, { instagram: ['www.instagram.com', 'instagram.com'].includes(url.hostname) })
        const thumbnailUrl = channelImageUrl(record.thumbnailUrl)
        resolve({ filePath: resolved, title: String(record.title || 'Imported video').replace(/[\u0000-\u001f]/g, '').slice(0, 240), sourceUrl: record.sourceUrl || url.href, ...(creatorHandle ? { creatorHandle } : {}), ...(thumbnailUrl ? { thumbnailUrl } : {}), ...media })
      } catch (cause) { reject(cause) }
    })
  })
}

export async function importVideo({ url: raw, directory, config = {}, signal, onProgress, maxBytes = LIMIT, maxDurationSeconds = 300 }) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > LIMIT) throw error('Invalid video download limit.')
  if (!path.isAbsolute(directory || '')) throw error('Host-selected import directory is required.')
  let { url, kind } = classifyVideoUrl(raw)
  await checkPublicHost(url)
  let tiktokProfile
  if (TIKTOK.has(url.hostname) && /^\/@[^/]+$/.test(url.pathname)) {
    tiktokProfile = await discoverTikTokProfile({ url, config, signal })
    if (!tiktokProfile.discoveredVideos.length) throw error('No public video was returned in this creator preview. Try an individual video link.')
    url = new URL(tiktokProfile.discoveredVideos[0].url)
  }
  if (TIKTOK.has(url.hostname)) {
    onProgress?.('Resolving TikTok video link…')
    url = await resolveTikTokUrl(url, { signal })
  }
  if (kind === 'direct') {
    const result = await directDownload(url, path.join(directory, 'reference' + path.extname(url.pathname).toLowerCase()), { maxBytes, signal, onProgress })
    return { ...result, ...await probeImportedVideo(result.filePath, { config, signal, maxDurationSeconds }) }
  }
  if (url.hostname === 'www.instagram.com' && /^\/[A-Za-z0-9_.]+\/$/.test(url.pathname)) {
    const profile = await discoverInstagramProfile(url, { signal, onProgress, checkHost: checkPublicHost })
    let lastError
    // Try a bounded number of public candidates when the first is unavailable.
    // Authentication failures and rate limits stop immediately.
    for (const [index, reel] of profile.reels.slice(0, 3).entries()) {
      onProgress?.(`${index ? 'Trying another' : 'Found a'} public reel from @${url.pathname.split('/')[1]}. Downloading…`)
      try {
        const result = await socialDownload(new URL(reel.url), directory, { config, maxBytes, maxDurationSeconds, signal, onProgress })
        if (result.creatorHandle && result.creatorHandle.toLowerCase() !== profile.handle.toLowerCase()) throw error('Instagram returned a video owned by a different channel. Choose an individual reel from this channel.')
        return { ...result, title: reel.title, sourceUrl: classifyVideoUrl(result.sourceUrl || reel.url).url.href, profileUrl: profile.profileUrl, creatorHandle: profile.handle, ...(reel.thumbnailUrl ? { thumbnailUrl: reel.thumbnailUrl } : {}), discoveryMethod: profile.discoveryMethod }
      } catch (cause) {
        if (signal?.aborted || cause?.status !== 422) throw cause
        lastError = cause
        // Remove only this import job's regular downloader files, never trees.
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (!entry.isFile() || !/^reference\./.test(entry.name)) throw cause
          await unlink(path.join(directory, entry.name))
        }
      }
    }
    throw lastError || error('No downloadable reel was found in this public channel preview.')
  }
  const result = await socialDownload(url, directory, { config, maxBytes, maxDurationSeconds, signal, onProgress })
  if (tiktokProfile && result.creatorHandle?.toLowerCase() !== tiktokProfile.handle) throw error('TikTok returned a different creator. Choose an individual video link.')
  if (tiktokProfile) return { ...result, sourceUrl: classifyVideoUrl(result.sourceUrl || url.href).url.href, profileUrl: tiktokProfile.url, discoveryMethod: 'tiktok_public_preview' }
  return { ...result, sourceUrl: classifyVideoUrl(result.sourceUrl || url.href).url.href }
}

/** Discover only the channel preview; downloading videos remains an explicit job. */
export async function discoverChannel({ url: raw, config, signal, onProgress } = {}) {
  const { url } = classifyVideoUrl(raw)
  if (TIKTOK.has(url.hostname) && /^\/@[^/]+$/.test(url.pathname)) { await checkPublicHost(url); return discoverTikTokProfile({ url, config, signal }) }
  if (url.hostname !== 'www.instagram.com' || !/^\/[A-Za-z0-9_.]+\/$/.test(url.pathname)) throw error('Add an Instagram channel profile link.')
  const channel = await discoverInstagramProfile(url, { signal, onProgress, checkHost: checkPublicHost })
  return { handle: channel.handle, name: channel.name, url: channel.url, ...(channel.avatarUrl ? { avatarUrl: channel.avatarUrl } : {}), discoveredVideos: channel.videos, lastSyncedAt: new Date().toISOString(), discoveryMethod: channel.discoveryMethod }
}

/** Full discovery is separate from the bounded public-preview sync. */
export async function discoverChannelPage({ url: raw, config, cursor, signal } = {}) {
  const { url } = classifyVideoUrl(raw)
  if (TIKTOK.has(url.hostname) && /^\/@[^/]+$/.test(url.pathname)) {
    const profile = await discoverChannel({ url: url.href, config, signal })
    return { ...profile, source: 'tiktok_public_preview', authoritative: false }
  }
  if (url.hostname !== 'www.instagram.com' || !/^\/[A-Za-z0-9_.]+\/$/.test(url.pathname)) throw error('Add an Instagram channel profile link.')
  return discoverInstagramChannelPage({ url, config, cursor, signal })
}
