import { ApiError, apiBase, apiRequest } from './taskApi'
import type { VideoAnalysisItem } from './inverseVideoApi'

export type RecreationClip = {
  index: number; sourceShotIndex?: number; startSeconds: number; endSeconds: number
  durationSeconds: number; requestDurationSeconds: number; prompt: string
  status?: 'pending' | 'submitting' | 'queued' | 'generating' | 'downloading' | 'completed' | 'failed' | 'submission_unknown'
  error?: string
}
export type RecreationPlan = {
  referenceId: string; planRevision: string; totalDurationSeconds: number; referenceDurationSeconds?: number; billableSeconds: number
  source?: 'authored_timeline' | string
  ratio: '9:16' | '16:9' | '1:1'; hasReferenceAudio: boolean; audioMode: 'reference' | 'silent'; resolution: '480p' | '768p'
  warnings?: string[]; clips: RecreationClip[]
  capability?: { available?: boolean; provider?: string; model?: string; message?: string; reason?: string }
  limits?: { maxClips?: number; maxDurationSeconds?: number; maxBillableSeconds?: number }
}
export type RecreationComparison = { status: 'pending' | 'ready'; referenceShotCount?: number; outputShotCount?: number; referenceDurationSeconds?: number; outputDurationSeconds?: number; durationDeltaSeconds?: number; transcriptWordOverlap?: number; note?: string }
export type RecreationJob = {
  id: string; requestKey: string; referenceId: string; planRevision: string
  source?: 'authored_timeline' | string
  status: 'queued' | 'submitting' | 'generating' | 'rendering' | 'importing' | 'completed' | 'failed' | 'submission_unknown' | 'paused'
  stage: string; message?: string; createdAt: string; updatedAt: string; totalDurationSeconds: number; billableSeconds: number
  ratio: string; audioMode: 'reference' | 'silent'; resolution: '480p' | '768p'; clips: RecreationClip[]
  outputItemId?: string; error?: string; retryable?: boolean; hasMedia: boolean; comparison?: RecreationComparison
}
export type RecreationRequest = {
  requestKey: string; planRevision: string; shots: Array<{ index: number; prompt: string }>
  audioMode: 'reference' | 'silent'; resolution: '480p' | '768p'
  timeline?: RecreationTimelineClip[]
}
export type RecreationTimelineClip = { startSeconds: number; endSeconds: number; prompt: string }
export type RecreationStoryboard = { title?: string; timeline: RecreationTimelineClip[]; warnings: string[] }

export function parseRecreationStoryboard(input: string): RecreationStoryboard {
  if (input.length > 150_000) throw new Error('Keep the storyboard JSON under 150,000 characters.')
  let data: unknown
  try { data = JSON.parse(input.trim().replace(/^```(?:json)?\s*\n([\s\S]*)\n```$/i, '$1')) }
  catch { throw new Error('Paste valid storyboard JSON containing clips with timeline and api_payload.prompt.') }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('The storyboard must be a JSON object containing clips.')
  const root = data as { project_metadata?: { title?: unknown }; clips?: unknown; post_production_sync?: unknown }
  if (!Array.isArray(root.clips) || root.clips.length < 1 || root.clips.length > 24) throw new Error('The storyboard must contain between 1 and 24 clips.')
  const clock = '(\\d{1,2}):([0-5]\\d(?:\\.\\d{1,3})?)'
  const range = new RegExp(`^\\s*${clock}\\s*[-–]\\s*${clock}\\s*$`)
  let previousEnd = 0, gaps = 0, images = false
  const timeline = root.clips.map((value: unknown, index: number) => {
    const clip = value as { timeline?: unknown; mode?: unknown; api_payload?: { prompt?: unknown; images?: unknown } } | null
    const matched = typeof clip?.timeline === 'string' ? clip.timeline.match(range) : null
    if (!matched) throw new Error(`Clip ${index + 1} needs a timeline such as 00:00.0 - 00:03.6.`)
    const startSeconds = Math.round((Number(matched[1]) * 60 + Number(matched[2])) * 1000) / 1000
    const endSeconds = Math.round((Number(matched[3]) * 60 + Number(matched[4])) * 1000) / 1000
    if (endSeconds - startSeconds < 1 / 30 || endSeconds - startSeconds > 15 || endSeconds > 300 || startSeconds < previousEnd) throw new Error(`Clip ${index + 1} needs an increasing, non-overlapping range of one frame to 15 seconds within 5 minutes.`)
    const prompt = clip?.api_payload?.prompt
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 8000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(prompt)) throw new Error(`Clip ${index + 1} needs a prompt between 1 and 8,000 characters without control characters.`)
    gaps += startSeconds - previousEnd; previousEnd = endSeconds
    images ||= Array.isArray(clip?.api_payload?.images) && clip.api_payload.images.length > 0 || typeof clip?.mode === 'string' && clip.mode !== 'text_to_video'
    return { startSeconds, endSeconds, prompt }
  })
  const warnings = ['Custom clips use text-to-video. Prompts and timeline are used; model names, URLs, 2K resolution and watermark settings in the JSON are not sent to the provider. Spur uses the selected generation model and resolution.']
  if (images) warnings.push('Image-conditioned shots will use their text prompts only. The storyboard image URLs are placeholders and are not fetched; matching first/last frames and pixel-perfect continuity are not available in this run.')
  if (gaps > 0.0005) warnings.push(`${Number(gaps.toFixed(3))}s of black gaps preserve your supplied timestamps.`)
  if (root.post_production_sync) warnings.push('Music, voiceover, SFX and editing instructions in post_production_sync are not generated. Choose reference audio to reuse the existing soundtrack, or choose silent video.')
  return { ...(typeof root.project_metadata?.title === 'string' ? { title: root.project_metadata.title.slice(0, 200) } : {}), timeline, warnings }
}
const prefix = '/api/creator-agent/video-analysis'
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const { data } = await apiRequest(prefix + path, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) })
  return data as T
}
export const getRecreationPlan = (id: string) => request<{ plan: RecreationPlan }>(`/items/${encodeURIComponent(id)}/reconstruction-plan`)
export const createCustomRecreationPlan = (id: string, timeline: RecreationTimelineClip[]) => request<{ plan: RecreationPlan }>(`/items/${encodeURIComponent(id)}/reconstruction-plan`, 'POST', { timeline })
export const createRecreation = (id: string, body: RecreationRequest) => request<{ job: RecreationJob }>(`/items/${encodeURIComponent(id)}/reconstructions`, 'POST', body)
export const listRecreations = (referenceId: string) => request<{ jobs: RecreationJob[] }>(`/reconstructions?referenceId=${encodeURIComponent(referenceId)}`)
export const getRecreation = (id: string) => request<{ job: RecreationJob }>(`/reconstructions/${encodeURIComponent(id)}`)
export const resumeRecreation = (id: string) => request<{ job: RecreationJob }>(`/reconstructions/${encodeURIComponent(id)}/resume`, 'POST', {})
export const analyzeRecreation = (id: string) => request<{ job: RecreationJob; item: VideoAnalysisItem; comparison?: RecreationComparison }>(`/reconstructions/${encodeURIComponent(id)}/analyze`, 'POST', {})
export const isRecreationRunning = (job: RecreationJob) => ['queued', 'submitting', 'generating', 'rendering', 'importing'].includes(job.status)
export const recreationStatusLabel = (status?: string) => ({ pending: 'Queued', queued: 'Queued', submitting: 'Submitting', generating: 'Generating', downloading: 'Downloading', rendering: 'Assembling', importing: 'Saving video', completed: 'Completed', failed: 'Failed', submission_unknown: 'Submission needs checking', paused: 'Status checks paused' }[status || ''] || status || 'Queued')
export function recreationTiming(plan: Pick<RecreationPlan, 'totalDurationSeconds' | 'billableSeconds' | 'clips'>) {
  return {
    targetSeconds: plan.totalDurationSeconds,
    billableSeconds: Number.isFinite(plan.billableSeconds) ? plan.billableSeconds : plan.clips.reduce((total, clip) => total + clip.requestDurationSeconds, 0),
    clipCount: plan.clips.length,
  }
}
export function findRecreationReceipt(jobs: RecreationJob[], requestKey: string) {
  return jobs.find(job => job.requestKey === requestKey)
}
export function mergeRecreationJobs(previous: RecreationJob[], incoming: RecreationJob[]) {
  const jobs = new Map(previous.map(job => [job.id, job]))
  for (const job of incoming) if (!jobs.has(job.id) || jobs.get(job.id)!.updatedAt <= job.updatedAt) jobs.set(job.id, job)
  return [...jobs.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}
function snapshotRecreationRequest(body: Omit<RecreationRequest, 'requestKey'>): Omit<RecreationRequest, 'requestKey'> {
  return { ...body, shots: body.shots.map(shot => ({ ...shot })), ...(body.timeline ? { timeline: body.timeline.map(clip => ({ ...clip })) } : {}) }
}
export function createRecreationSubmission(referenceId: string, options: {
  pendingKey?: string; pendingBody?: Omit<RecreationRequest, 'requestKey'>; onPending?: (key: string, body?: Omit<RecreationRequest, 'requestKey'>) => void; newKey?: () => string
  create?: typeof createRecreation; list?: typeof listRecreations
} = {}) {
  let pendingKey = options.pendingKey || '', pendingBody = options.pendingBody ? snapshotRecreationRequest(options.pendingBody) : undefined, inFlight: Promise<{ job: RecreationJob }> | null = null
  const update = (key: string, body?: Omit<RecreationRequest, 'requestKey'>) => { pendingKey = key; pendingBody = body ? snapshotRecreationRequest(body) : undefined; options.onPending?.(key, pendingBody ? snapshotRecreationRequest(pendingBody) : undefined) }
  function send(body: Omit<RecreationRequest, 'requestKey'>, key: string) {
    const snapshot = snapshotRecreationRequest(body)
    update(key, snapshot)
    inFlight = (options.create || createRecreation)(referenceId, { ...snapshot, requestKey: key }).then(response => {
      if (!response.job?.id || response.job.requestKey !== key) throw new ApiError('The generation receipt could not be verified. Check submission status.', 502)
      update('')
      return response
    }).catch(error => {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 409) update('')
      throw error
    }).finally(() => { inFlight = null })
    return inFlight
  }
  return {
    getPendingKey: () => pendingKey,
    canResume: () => !!pendingKey && !!pendingBody,
    submit(body: Omit<RecreationRequest, 'requestKey'>) {
      if (inFlight) return inFlight
      if (pendingKey) return Promise.reject(new Error('Check the existing submission before starting another recreation.'))
      const key = (options.newKey || (() => crypto.randomUUID()))()
      return send(body, key)
    },
    resume() {
      if (inFlight) return inFlight
      if (!pendingKey || !pendingBody) return Promise.reject(new Error('The original submission details are unavailable. Check its receipt before starting another generation.'))
      return send(pendingBody, pendingKey)
    },
    async checkReceipt() {
      if (!pendingKey) return undefined
      const { jobs } = await (options.list || listRecreations)(referenceId)
      const job = findRecreationReceipt(jobs, pendingKey)
      if (job) update('')
      return job
    },
  }
}
export async function getRecreationMedia(id: string, signal?: AbortSignal) {
  const controller = new AbortController(), abort = () => controller.abort()
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, 180_000)
  try {
    const response = await fetch(apiBase() + prefix + `/reconstructions/${encodeURIComponent(id)}/media`, { cache: 'no-store', redirect: 'error', signal: controller.signal })
    if (!response.ok) {
      const data = await response.json().catch(() => null)
      throw new ApiError(data?.error || `Could not load the recreation (${response.status}).`, response.status)
    }
    const type = response.headers.get('content-type')?.split(';')[0].trim()
    if (type !== 'video/mp4') throw new ApiError('The recreation did not return an MP4 video.', 502)
    return await response.blob()
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}
