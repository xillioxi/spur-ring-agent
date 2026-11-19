import { channelImageUrl } from './channel-metadata.mjs'

const MAX_PAGE_BYTES = 4 * 1024 * 1024
const fail = (message, status = 422) => Object.assign(new Error(message), { status })
const validUsername = value => typeof value === 'string' && /^(?!\.)(?!.*\.\.)(?!.*\.$)[A-Za-z0-9_.]{1,30}$/.test(value)
const validCode = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)

/** Parse public embed data only. No scripts are executed and no account session is read. */
function profileContext(html, username) {
  if (!validUsername(username)) throw fail('Provide a valid Instagram channel name.')
  if (typeof html !== 'string' || Buffer.byteLength(html) > MAX_PAGE_BYTES) throw fail('Instagram returned too much channel data.')
  const contexts = []
  const pattern = /"contextJSON"\s*:\s*("(?:\\.|[^"\\])*")/g
  for (const match of html.matchAll(pattern)) {
    if (contexts.length >= 8) break
    try {
      const outer = JSON.parse(match[1])
      const value = JSON.parse(outer)
      if (value?.context && typeof value.context === 'object') contexts.push(value.context)
    } catch { /* An incomplete or unrelated embed cannot provide a video. */ }
  }
  const context = contexts.find(value => typeof value.username === 'string' && value.username.toLowerCase() === username.toLowerCase())
  if (!context) throw fail('Instagram did not expose a public reel list for this channel. Try an individual reel link.')
  if (context.is_private === true) throw fail('This Instagram channel is private. Choose a public reel.', 401)
  return context
}

/** The public embed preview is a bounded catalogue, not an account's full archive. */
export function parseInstagramChannelProfile(html, username) {
  const context = profileContext(html, username)
  const handle = context.username
  const reels = [], seen = new Set()
  for (const entry of (Array.isArray(context.graphql_media) ? context.graphql_media : []).slice(0, 24)) {
    const media = entry?.shortcode_media
    if (!media || !validCode(media.shortcode) || seen.has(media.shortcode)) continue
    if (media.owner?.is_private === true) continue
    if (typeof media.owner?.username !== 'string' || media.owner.username.toLowerCase() !== username.toLowerCase()) continue
    const isVideo = media.is_video === true || media.__typename === 'GraphVideo'
    const hasVideoChild = media.__typename === 'GraphSidecar' && (media.edge_sidecar_to_children?.edges || []).slice(0, 20).some(child => child?.node?.is_video === true || child?.node?.__typename === 'GraphVideo')
    if (!isVideo && !hasVideoChild) continue
    const caption = media.edge_media_to_caption?.edges?.[0]?.node?.text
    const title = typeof caption === 'string' ? caption.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 160) : ''
    seen.add(media.shortcode)
    const thumbnailUrl = channelImageUrl(media.thumbnail_src) || channelImageUrl(media.display_url)
    const timestamp = Number(media.taken_at_timestamp)
    const publishedAt = Number.isFinite(timestamp) && timestamp > 0 && timestamp < 4102444800 ? new Date(timestamp * 1000).toISOString() : undefined
    reels.push({ url: `https://www.instagram.com/${isVideo ? 'reel' : 'p'}/${media.shortcode}/`, title: title || `Video by @${handle}`, ...(thumbnailUrl ? { thumbnailUrl } : {}), ...(publishedAt ? { publishedAt } : {}) })
    if (reels.length === 24) break
  }
  const name = typeof context.full_name === 'string' ? context.full_name.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 160) : ''
  const avatarUrl = channelImageUrl(context.profile_pic_url_hd) || channelImageUrl(context.profile_pic_url)
  return { handle, name: name || handle, url: `https://www.instagram.com/${handle}/`, ...(avatarUrl ? { avatarUrl } : {}), videos: reels }
}

/** Backwards-compatible video-only discovery for the original import flow. */
export function parseInstagramProfile(html, username) {
  const reels = parseInstagramChannelProfile(html, username).videos.slice(0, 12).map(({ url, title }) => ({ url, title }))
  if (!reels.length) throw fail('No public video was listed in this Instagram channel preview. Try an individual reel link.')
  return reels
}

export async function discoverInstagramProfile(url, { signal, onProgress, checkHost, fetchImpl = fetch } = {}) {
  const username = url.pathname.split('/').filter(Boolean)[0]
  if (!['www.instagram.com', 'instagram.com'].includes(url.hostname) || url.protocol !== 'https:' || url.pathname.split('/').filter(Boolean).length !== 1 || !validUsername(username)) throw fail('Provide an Instagram channel link.')
  const endpoint = new URL(`https://www.instagram.com/${username}/embed/`)
  await checkHost?.(endpoint)
  onProgress?.(`Finding public reels from @${username}…`)
  const controller = new AbortController(), abort = () => controller.abort()
  if (signal?.aborted) throw fail('Video import cancelled.')
  signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, 20_000)
  try {
    const response = await fetchImpl(endpoint, { redirect: 'manual', signal: controller.signal, headers: {
      'user-agent': 'Spur-Reference-Video/1.0',
      'accept': 'text/html', 'accept-language': 'en-US,en;q=0.9',
    } })
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      if (response.status === 429) throw fail('Instagram temporarily limited channel requests. Try again later or add an individual reel link.', 429)
      throw fail('Instagram did not expose this public channel preview. Try an individual reel link.')
    }
    if (Number(response.headers.get('content-length')) > MAX_PAGE_BYTES) { await response.body.cancel(); throw fail('Instagram returned too much channel data.') }
    const chunks = []; let bytes = 0
    for await (const chunk of response.body) {
      bytes += chunk.byteLength
      if (bytes > MAX_PAGE_BYTES) { await response.body.cancel().catch(() => {}); throw fail('Instagram returned too much channel data.') }
      chunks.push(Buffer.from(chunk))
    }
    const channel = parseInstagramChannelProfile(Buffer.concat(chunks).toString('utf8'), username)
    return { ...channel, profileUrl: channel.url, reels: channel.videos, discoveryMethod: 'public_profile_embed' }
  } catch (cause) {
    if (controller.signal.aborted) throw fail(signal?.aborted ? 'Video import cancelled.' : 'Instagram channel lookup timed out. Try an individual reel link.')
    if (cause?.status) throw cause
    throw fail('Instagram channel preview could not be reached. Try an individual reel link.', 502)
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}
