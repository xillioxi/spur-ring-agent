import { ApiError, apiBase } from './taskApi'

export type FaceReferenceAngle = 'unspecified' | 'front' | 'left' | 'right' | 'outfit' | 'other'
export type FaceReference = {
  id: string; channelId: string; label: string; angle: FaceReferenceAngle; selected: boolean
  width: number; height: number; createdAt: string; detection: 'face' | 'manual'
  source: { kind: 'photo' | 'video'; filename?: string; sourceItemId?: string; timeSeconds?: number }
  quality?: { sharpness: number; brightness: number }
  asset: { key: string; sha256: string; bytes: number; backend: 'local' }
  contextAsset?: { key: string; sha256: string; bytes: number; backend: 'local' }
}
export type FaceReferenceBank = {
  references: FaceReference[]
  storage: { backend: 'local'; cloudSynced: false; usedBytes: number; maxBytes: number; message?: string }
  generation: { available: false; provider: string; model: string; supportsReferenceImages: false; reason?: string }
  limits: { maxPhotoBytes?: number; maxReferencesPerChannel?: number; maxSelectedReferences?: number; maxCandidatesPerJob?: number; maxStorageBytes?: number; maxPackBytes?: number }
  warnings?: string[]
}
export const FACE_PHOTO_MAX_BYTES = 8 * 1024 * 1024
export const FACE_PACK_MAX_BYTES = 12 * 1024 * 1024
const prefix = '/api/creator-agent/video-analysis'
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/
const channelId = /^(?:instagram|tiktok)-[a-z0-9_.]{1,30}$/
function requireId(value: string) { if (!uuid.test(value)) throw new Error('Choose a saved reference.'); return encodeURIComponent(value) }
function requireChannel(value: string) { if (!channelId.test(value)) throw new Error('Choose a channel for these references.'); return encodeURIComponent(value) }

async function request<T>(route: string, options: RequestInit = {}, read: (response: Response) => Promise<T> = response => response.json(), signal?: AbortSignal) {
  const controller = new AbortController(), cancel = () => controller.abort()
  if (signal?.aborted) controller.abort()
  else signal?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(cancel, 180_000)
  try {
    const response = await fetch(apiBase() + prefix + route, { ...options, cache: 'no-store', signal: controller.signal })
    if (!response.ok) {
      const value = await response.json().catch(() => null)
      throw new ApiError(value?.error || `The reference request could not finish (${response.status}).`, response.status)
    }
    return await read(response)
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel) }
}
async function boundedBlob(response: Response, contentType: string, maxBytes: number) {
  if (!response.headers.get('content-type')?.startsWith(contentType)) throw new Error('The reference service returned an unsupported file.')
  if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('The reference file exceeds its download limit.')
  const reader = response.body?.getReader()
  if (!reader) throw new Error('The reference file is empty.')
  const chunks: Uint8Array[] = []; let size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > maxBytes) { await reader.cancel(); throw new Error('The reference file exceeds its download limit.') }
      chunks.push(part.value)
    }
  } finally { reader.releaseLock() }
  if (!size) throw new Error('The reference file is empty.')
  return new Blob(chunks as BlobPart[], { type: contentType })
}
export const listFaceReferences = (id: string, signal?: AbortSignal) => request<FaceReferenceBank>(`/channels/${requireChannel(id)}/face-references`, {}, undefined, signal)
export function uploadFacePhoto(id: string, file: File, signal?: AbortSignal) {
  if (!['image/jpeg', 'image/png'].includes(file.type) || !/\.(?:jpe?g|png)$/i.test(file.name) || !file.size || file.size > FACE_PHOTO_MAX_BYTES) throw new Error('Choose a JPEG or PNG photo up to 8 MiB.')
  return request<FaceReferenceBank>(`/channels/${requireChannel(id)}/face-references?filename=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': file.type }, body: file }, undefined, signal)
}
export const extractFaceReferences = (id: string, signal?: AbortSignal) => request<FaceReferenceBank>(`/items/${requireId(id)}/face-candidates`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, undefined, signal)
export function updateFaceReference(id: string, value: { selected?: boolean; angle?: FaceReferenceAngle; label?: string }, signal?: AbortSignal) {
  if (!value || Object.keys(value).some(key => !['selected', 'angle', 'label'].includes(key)) || value.selected !== undefined && typeof value.selected !== 'boolean' || value.angle !== undefined && !['unspecified', 'front', 'left', 'right', 'outfit', 'other'].includes(value.angle) || value.label !== undefined && (typeof value.label !== 'string' || value.label.length > 120)) throw new Error('Use a short label, a reference angle or a selection.')
  return request<{ reference: FaceReference }>(`/face-references/${requireId(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }, undefined, signal)
}
export const getFaceReferenceImage = (id: string, context = false, signal?: AbortSignal) => request(`/face-references/${requireId(id)}/image${context ? '?context=1' : ''}`, {}, response => boundedBlob(response, 'image/jpeg', 2 * 1024 * 1024), signal)
export const exportFaceReferencePack = (id: string, signal?: AbortSignal) => request(`/channels/${requireChannel(id)}/face-references/export`, {}, response => boundedBlob(response, 'application/zip', FACE_PACK_MAX_BYTES), signal)
