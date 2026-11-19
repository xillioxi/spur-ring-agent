import { spawn } from 'node:child_process'
import path from 'node:path'
import { videoChannel } from './channels.mjs'
import { channelImageUrl } from './channel-metadata.mjs'

const fail = (message, status = 422) => Object.assign(new Error(message), { status })
export const TIKTOK_PREVIEW_LIMIT = 24
const MAX_PROFILE_BYTES = 2 * 1024 * 1024

/** Read only the requested creator's public profile state, never a video's artwork. */
export function parseTikTokCreatorMetadata(html, profileUrl) {
  const owner = videoChannel(profileUrl)
  if (owner.platform !== 'tiktok' || typeof html !== 'string' || Buffer.byteLength(html) > MAX_PROFILE_BYTES) return {}
  const script = /<script\b[^>]*\sid\s*=\s*(["'])__UNIVERSAL_DATA_FOR_REHYDRATION__\1[^>]*>([\s\S]*?)<\/script\s*>/i.exec(html)
  if (!script) return {}
  try {
    const user = JSON.parse(script[2])?.__DEFAULT_SCOPE__?.['webapp.user-detail']?.userInfo?.user
    if (typeof user?.uniqueId !== 'string' || user.uniqueId.toLowerCase() !== owner.handle) return {}
    const avatarUrl = [user.avatarMedium, user.avatarLarger, user.avatarThumb].map(channelImageUrl).find(Boolean)
    return { ...(typeof user.nickname === 'string' && user.nickname.trim() ? { name: user.nickname.trim().slice(0, 120) } : {}), ...(avatarUrl ? { avatarUrl } : {}) }
  } catch { return {} }
}

/** Optional, bounded public artwork metadata. A blocked profile must not lose its video preview. */
export async function fetchTikTokCreatorMetadata({ url, signal, fetchImpl = fetch } = {}) {
  const owner = videoChannel(url instanceof URL ? url.href : url)
  if (owner.platform !== 'tiktok' || signal?.aborted) return {}
  const controller = new AbortController(), abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(abort, 8_000)
  try {
    // videoChannel creates this canonical official URL; redirects are deliberately not followed.
    const response = await fetchImpl(owner.url, { redirect: 'manual', signal: controller.signal, headers: { 'user-agent': 'Mozilla/5.0', accept: 'text/html' } })
    const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
    if (!response.ok || !response.body || contentType && !['text/html', 'application/xhtml+xml'].includes(contentType) || Number(response.headers.get('content-length')) > MAX_PROFILE_BYTES) {
      await response.body?.cancel()
      return {}
    }
    const chunks = []; let size = 0
    for await (const chunk of response.body) {
      size += chunk.byteLength
      if (size > MAX_PROFILE_BYTES) { await response.body.cancel().catch(() => {}); return {} }
      chunks.push(Buffer.from(chunk))
    }
    return parseTikTokCreatorMetadata(Buffer.concat(chunks).toString('utf8'), owner.url)
  } catch { return {} }
  finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort) }
}

export function parseTikTokProfile(data, profileUrl) {
  const owner = videoChannel(profileUrl)
  if (owner.platform !== 'tiktok' || !data || typeof data !== 'object' || !Array.isArray(data.entries)) throw fail('TikTok did not return a public creator preview.')
  const videos = [], seen = new Set()
  for (const entry of data.entries.slice(0, TIKTOK_PREVIEW_LIMIT)) {
    if (!entry || typeof entry.id !== 'string' || !/^\d{10,25}$/.test(entry.id) || seen.has(entry.id)) continue
    if (typeof entry.uploader !== 'string' || entry.uploader.toLowerCase() !== owner.handle) continue
    const thumbnails = Array.isArray(entry.thumbnails) ? entry.thumbnails : []
    if (thumbnails.length && thumbnails.every(value => typeof value.url === 'string' && value.url.includes('photomode'))) continue
    const item = { url: `${owner.url}/video/${entry.id}`, title: typeof entry.title === 'string' ? entry.title.slice(0, 240) : 'TikTok video' }
    const image = thumbnails.map(value => channelImageUrl(value?.url)).find(Boolean)
    if (image) item.thumbnailUrl = image
    if (Number.isFinite(entry.duration) && entry.duration > 0) item.durationSeconds = entry.duration
    if (Number.isFinite(entry.timestamp) && entry.timestamp > 0 && entry.timestamp < 1e11) item.publishedAt = new Date(entry.timestamp * 1000).toISOString()
    seen.add(entry.id); videos.push(item)
  }
  const named = data.entries.find(entry => typeof entry?.uploader === 'string' && entry.uploader.toLowerCase() === owner.handle && typeof entry.channel === 'string')
  return { ...owner, name: named?.channel?.slice(0, 120) || owner.handle, discoveredVideos: videos, discoveryMethod: 'tiktok_public_preview', coverage: 'preview' }
}

/** Bounded metadata-only discovery. This never downloads the creator's videos. */
export async function discoverTikTokProfile({ url, config = {}, signal } = {}) {
  const owner = videoChannel(url instanceof URL ? url.href : url)
  if (owner.platform !== 'tiktok') throw fail('Paste a TikTok creator profile URL.')
  const binary = config.SPUR_YTDLP_BIN
  if (typeof binary !== 'string' || !path.isAbsolute(binary)) throw fail('Public video discovery is not installed.', 503)
  if (signal?.aborted) throw fail('Creator discovery cancelled.')
  const args = ['--ignore-config', '--no-colors', '--use-extractors', 'default,-generic', '--flat-playlist', '--playlist-end', String(TIKTOK_PREVIEW_LIMIT), '--skip-download', '--dump-single-json', '--socket-timeout', '10', '--retries', '0', '--extractor-retries', '0', owner.url]
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const metadataController = new AbortController()
    const creatorMetadata = fetchTikTokCreatorMetadata({ url: owner.url, signal: metadataController.signal })
    const chunks = []; let size = 0, diagnostic = '', failure, settled = false
    const stop = message => { failure ||= fail(message); metadataController.abort(); child.kill() }
    const abort = () => stop('Creator discovery cancelled.')
    const timer = setTimeout(() => stop('TikTok creator discovery timed out. Your saved references were preserved.'), 40_000)
    signal?.addEventListener('abort', abort, { once: true })
    const finish = (cause, value) => { if (settled) return; settled = true; clearTimeout(timer); metadataController.abort(); signal?.removeEventListener('abort', abort); cause ? reject(cause) : resolve(value) }
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 4 * 1024 * 1024) stop('TikTok returned too much creator metadata.'); else chunks.push(chunk) })
    child.stderr.on('data', chunk => { if (diagnostic.length < 16000) diagnostic += chunk.toString() })
    child.once('error', () => finish(fail('The local creator discovery tool could not start.', 503)))
    child.once('close', async code => {
      if (failure) return finish(failure)
      if (code !== 0) return finish(fail(/private|log.?in/i.test(diagnostic) ? 'TikTok restricted this creator preview. You can still import individual public videos.' : 'TikTok could not list this creator from this connection. Your saved references are still available.'))
      try {
        const profile = parseTikTokProfile(JSON.parse(Buffer.concat(chunks).toString('utf8')), owner.url)
        const metadata = await creatorMetadata
        if (failure) return finish(failure)
        finish(null, { ...profile, ...metadata })
      }
      catch { finish(fail('TikTok did not return a usable public creator preview.')) }
    })
    if (signal?.aborted) abort()
  })
}
