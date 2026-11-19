import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

const MAX_IMAGE_BYTES = 2 * 1024 * 1024
const fail = (message, status = 422) => Object.assign(new Error(message), { status })

/** Only official Instagram image CDNs can supply channel artwork. */
export function channelImageUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port && url.port !== '443') return undefined
    if (!['cdninstagram.com', 'fbcdn.net', 'tiktokcdn.com', 'tiktokcdn-us.com', 'tiktokcdn-eu.com'].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) return undefined
    return url.href
  } catch { return undefined }
}

function publicAddress(address) {
  const family = isIP(address)
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 && [0, 2].includes(c)) || a === 100 && b >= 64 && b <= 127 || a === 198 && [18, 19].includes(b) || a === 198 && b === 51 && c === 100 || a === 203 && b === 0 && c === 113)
  }
  if (family === 6) {
    const value = address.toLowerCase(), first = parseInt(value.split(':')[0], 16)
    return first >= 0x2000 && first <= 0x3fff && !value.startsWith('2001:db8:')
  }
  return false
}

function imageType(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp'
  return undefined
}

/** Bounded server-side artwork download; never proxy an arbitrary client URL. */
export async function fetchChannelImage(value, { signal, fetchImpl = fetch, resolver = lookup } = {}) {
  let accepted = channelImageUrl(value)
  if (!accepted) throw fail('The channel artwork URL is not supported.')
  if (signal?.aborted) throw fail('Channel artwork download cancelled.')
  const controller = new AbortController(), abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(abort, 20_000)
  try {
    for (let hop = 0; hop < 4; hop++) {
      const url = new URL(accepted)
      const addresses = await resolver(url.hostname, { all: true, verbatim: true })
      if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw fail('Channel artwork must resolve to a public internet address.')
      const response = await fetchImpl(url, { redirect: 'manual', signal: controller.signal, headers: { 'user-agent': 'Spur-Reference-Video/1.0', accept: 'image/jpeg,image/png,image/webp' } })
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel()
        const location = response.headers.get('location')
        accepted = location ? channelImageUrl(new URL(location, url).href) : undefined
        if (!accepted) throw fail('The channel artwork redirected to an unsupported host.')
        continue
      }
      if (!response.ok || !response.body) { await response.body?.cancel(); throw fail('The channel artwork is currently unavailable.', 502) }
      const declaredType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(declaredType)) { await response.body.cancel(); throw fail('The channel artwork did not return a supported image.') }
      if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) { await response.body.cancel(); throw fail('The channel artwork exceeds the 2 MiB limit.', 413) }
      const chunks = []; let size = 0
      for await (const chunk of response.body) {
        size += chunk.byteLength
        if (size > MAX_IMAGE_BYTES) { await response.body.cancel().catch(() => {}); throw fail('The channel artwork exceeds the 2 MiB limit.', 413) }
        chunks.push(Buffer.from(chunk))
      }
      const bytes = Buffer.concat(chunks), contentType = imageType(bytes)
      if (!contentType || contentType !== declaredType) throw fail('The channel artwork did not contain a valid supported image.')
      return { bytes, contentType }
    }
    throw fail('The channel artwork returned too many redirects.')
  } catch (cause) {
    if (controller.signal.aborted) throw fail(signal?.aborted ? 'Channel artwork download cancelled.' : 'Channel artwork download timed out.', 502)
    if (cause?.status) throw cause
    throw fail('The channel artwork could not be reached.', 502)
  } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort) }
}
