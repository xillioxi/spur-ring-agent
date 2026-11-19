import { channelImageUrl } from './channel-metadata.mjs'

const MAX_BYTES = 4 * 1024 * 1024
const fail = (message, status = 422, requiresConnection = false) => Object.assign(new Error(message), { status, ...(requiresConnection ? { requiresConnection: true } : {}) })
const username = value => typeof value === 'string' && /^(?!\.)(?!.*\.\.)(?!.*\.$)[A-Za-z0-9_.]{1,30}$/.test(value)
const cursorIsSafe = value => typeof value === 'string' && /^[A-Za-z0-9_=-]{1,4096}$/.test(value)
const cleanText = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : ''

function connection(config = {}) {
  const token = config.SPUR_INSTAGRAM_ACCESS_TOKEN, accountId = config.SPUR_INSTAGRAM_ACCOUNT_ID
  if (!token || !accountId) return undefined
  if (typeof token !== 'string' || !/^[\x21-\x7e]{1,8192}$/.test(token) || typeof accountId !== 'string' || !/^\d{1,40}$/.test(accountId)) throw fail('Enter a valid Meta access token and your own Instagram professional account ID.')
  const version = config.SPUR_INSTAGRAM_API_VERSION || 'v25.0'
  if (typeof version !== 'string' || !/^v[1-9]\d{0,2}\.\d{1,2}$/.test(version)) throw fail('The configured Instagram API version is invalid.')
  return { token, accountId, version }
}

function channelHandle(raw) {
  let url
  try { url = new URL(raw?.href || raw) } catch { throw fail('Add an Instagram channel profile link.') }
  const handle = url.pathname.match(/^\/([^/]+)\/?$/)?.[1]
  if (url.protocol !== 'https:' || !['instagram.com', 'www.instagram.com'].includes(url.hostname) || url.username || url.password || url.port && url.port !== '443' || url.search || url.hash || !username(handle)) throw fail('Add an Instagram channel profile link.')
  return handle.toLowerCase()
}

function apiFailure(status, data) {
  const code = Number(data?.error?.code)
  if (status === 429 || [4, 17, 32, 613, 80004].includes(code)) return fail('Instagram temporarily limited channel discovery. Resume later; the videos already found are saved.', 429)
  if (status === 401 || [102, 190].includes(code)) return fail('The Instagram connection expired or is invalid. Reconnect with a valid Meta access token.', 401, true)
  if (status === 403 || [10, 200, 294].includes(code)) return fail('The Instagram connection does not have permission for Business Discovery. Check the Meta app permissions and linked professional account.', 403, true)
  if (code === 100 || status === 404) return fail('Instagram Business Discovery could not read this account. It must be a public professional account accessible to your Meta connection.', 422)
  return fail('Instagram could not complete this channel request. Try again later.', 502)
}

/** Credentials stay in the Authorization header, on one fixed host with no redirects. */
async function graphRequest(settings, fields, { signal, fetchImpl = fetch } = {}) {
  if (signal?.aborted) throw fail('Instagram channel discovery cancelled.')
  const controller = new AbortController(), abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, 20_000)
  try {
    const url = new URL(`https://graph.facebook.com/${settings.version}/${settings.accountId}`)
    url.searchParams.set('fields', fields)
    const response = await fetchImpl(url, { method: 'GET', redirect: 'manual', signal: controller.signal, headers: { authorization: `Bearer ${settings.token}`, accept: 'application/json' } })
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw fail('Instagram returned an unsupported API redirect.', 502) }
    if (Number(response.headers.get('content-length')) > MAX_BYTES) { await response.body?.cancel(); throw fail('Instagram returned too much channel metadata.', 502) }
    let size = 0
    const chunks = []
    if (response.body) for await (const chunk of response.body) {
      size += chunk.byteLength
      if (size > MAX_BYTES) throw fail('Instagram returned too much channel metadata.', 502)
      chunks.push(Buffer.from(chunk))
    }
    let data
    try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw apiFailure(response.status) }
    if (!response.ok || data?.error) throw apiFailure(response.status, data)
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw fail('Instagram returned invalid channel metadata.', 502)
    return data
  } catch (cause) {
    if (controller.signal.aborted) throw fail(signal?.aborted ? 'Instagram channel discovery cancelled.' : 'Instagram channel discovery timed out. Resume to continue.', 502)
    if (cause?.status) throw cause
    // Never echo fetch diagnostics, upstream bodies, URLs, tokens or headers.
    throw fail('Instagram could not be reached. Try channel discovery again.', 502)
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}

function mediaVideo(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw fail('Instagram returned invalid media metadata.', 502)
  if (record.media_type === 'IMAGE') return undefined
  if (record.media_type !== 'VIDEO' && record.media_type !== 'CAROUSEL_ALBUM') throw fail('Instagram returned an unrecognized media type. Discovery remains incomplete.', 502)
  if (record.media_type === 'CAROUSEL_ALBUM') {
    if (!Array.isArray(record.children?.data) || !record.children.data.length || record.children.paging?.next) throw fail('Instagram did not provide all carousel types. Discovery remains incomplete.', 502)
    if (record.children.data.some(child => !['IMAGE', 'VIDEO'].includes(child?.media_type))) throw fail('Instagram returned invalid carousel metadata.', 502)
    if (!record.children.data.some(child => child.media_type === 'VIDEO')) return undefined
  }
  let url
  try { url = new URL(record.permalink) } catch { throw fail('Instagram returned an invalid video link.', 502) }
  const path = url.pathname.match(/^\/(reel|reels|p|tv)\/([A-Za-z0-9_-]{1,64})\/?$/)
  if (url.protocol !== 'https:' || !['instagram.com', 'www.instagram.com'].includes(url.hostname) || url.username || url.password || url.port && url.port !== '443' || url.hash || !path) throw fail('Instagram returned an invalid video link.', 502)
  const canonical = `https://www.instagram.com/${['reel', 'reels'].includes(path[1]) ? 'reel' : 'p'}/${path[2]}/`
  const thumbnailUrl = channelImageUrl(record.thumbnail_url)
  const timestamp = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN
  return { url: canonical, title: cleanText(record.caption, 300) || `Instagram video ${path[2]}`, ...(thumbnailUrl ? { thumbnailUrl } : {}), ...(Number.isFinite(timestamp) ? { publishedAt: new Date(timestamp).toISOString() } : {}) }
}

/** Meta Business Discovery supports other public Business/Creator accounts, not personal/private accounts. */
export async function discoverInstagramChannelPage({ url, config = {}, cursor, signal, fetchImpl } = {}) {
  const handle = channelHandle(url)
  if (cursor !== undefined && !cursorIsSafe(cursor)) throw fail('The saved Instagram discovery cursor is invalid. Restart discovery.')
  const settings = connection(config)
  if (!settings) return { handle, source: 'instagram_public', coverage: 'preview', authoritative: false, requiresConnection: true, discoveredVideos: [], message: 'Connect a Meta account with Instagram Business Discovery access to discover the full public professional channel. The public preview alone cannot list all videos.' }
  const fields = `business_discovery.username(${handle}){username,name,profile_picture_url,media_count,media.limit(50)${cursor ? `.after(${cursor})` : ''}{id,caption,media_type,permalink,thumbnail_url,timestamp,children{media_type}}}`
  const data = await graphRequest(settings, fields, { signal, fetchImpl })
  const profile = data.business_discovery, media = profile?.media
  if (!profile || typeof profile !== 'object' || !username(profile.username) || profile.username.toLowerCase() !== handle || !media || !Array.isArray(media.data)) throw fail('Instagram did not return this channel’s complete media page. Discovery remains incomplete.', 502)
  if (media.data.length > 50 || media.paging !== undefined && (!media.paging || typeof media.paging !== 'object' || Array.isArray(media.paging))) throw fail('Instagram returned an invalid media page. Discovery remains incomplete.', 502)
  const next = media.paging?.next
  if (next !== undefined && (typeof next !== 'string' || !next)) throw fail('Instagram returned invalid pagination metadata.', 502)
  const after = media.paging?.cursors?.after
  // The upstream next URL can include credentials. Never follow, return or persist it.
  if (next && (!cursorIsSafe(after) || after === cursor || !media.data.length)) throw fail('Instagram did not provide a usable next-page cursor. Discovery remains incomplete.', 502)
  const videos = media.data.map(mediaVideo).filter(Boolean)
  const discoveredVideos = [...new Map(videos.map(video => [video.url, video])).values()]
  const avatarUrl = channelImageUrl(profile.profile_picture_url)
  const profileTotalPosts = Number.isSafeInteger(profile.media_count) && profile.media_count >= 0 ? profile.media_count : undefined
  return { handle, name: cleanText(profile.name, 100) || handle, url: `https://www.instagram.com/${handle}/`, ...(avatarUrl ? { avatarUrl } : {}), discoveredVideos,
    pageInfo: { hasNextPage: Boolean(next), ...(next ? { endCursor: after } : {}) }, ...(profileTotalPosts === undefined ? {} : { profileTotalPosts }), scannedPosts: media.data.length,
    source: 'instagram_authorized', coverage: 'paginated', authoritative: true, discoveryMethod: 'meta_business_discovery' }
}

/** Validate the user's own linked professional IG account without exposing credentials. */
export async function validateInstagramConnection(config = {}, options = {}) {
  const settings = connection(config)
  if (!settings) throw fail('Enter a Meta access token and your own Instagram professional account ID.', 422, true)
  const result = await graphRequest(settings, 'id,username', options)
  if (result.id !== settings.accountId || !username(result.username)) throw fail('Instagram could not verify your professional account ID. Use the Instagram account ID linked to your Meta access token.', 422, true)
  return { id: settings.accountId, handle: result.username.toLowerCase() }
}
