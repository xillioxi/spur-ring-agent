import { ApiError, apiBase, apiRequest } from './taskApi'

export type AnalysisMode = 'both' | 'breakdown' | 'script' | 'audio'
export type AnalysisWorkflowId = 'standard' | 'rea-video'
export type VideoAnalysisWorkflow = {
  id: AnalysisWorkflowId; label: string; available: boolean; inputMode?: string
  description?: string; reason?: string; revision?: string; usesModel?: boolean; configured?: boolean; modes?: AnalysisMode[]
}
export type ReaVideoResult = {
  schemaVersion: 1; verdict: string; vlmStatus: 'not_requested'; reviewStatus: 'unreviewed'
  technicalShots: Array<{ index: number; startSeconds: number; endSeconds: number; label: string; confidence: number | null; evidence: string[] }>
  limitations: string[]; workflowRevision: string
  sections?: Array<{ id: string; title: string; body: string }>
  soundCandidates?: Array<{ startSeconds: number; endSeconds: number; description: string }>
  assets?: Array<{ id: string; label: string; contentType: string; bytes?: number }>
  capabilities?: Array<{ id: string; label: string; status: 'available' | 'requires_model' | 'requires_download' | 'separate_workflow'; detail: string }>
  reviewNotes?: ReaReviewNotes & { source: 'user'; updatedAt: string }
}
export type ReaReviewNotes = { summary: string; hook: string; payoff: string; characters: string; corrections: string }
export type VideoAnalysisStatus = 'ready' | 'queued' | 'importing' | 'analyzing' | 'complete' | 'partial' | 'failed'
export type TimedText = { startSeconds: number; endSeconds: number; text: string }
export type AudioEvent = { label: string; description?: string; category?: 'music' | 'sfx' | 'ambient' | 'speech'; confidence?: number; startSeconds?: number; endSeconds?: number }
export type AudioSegment = {
  shotIndex: number | null
  startSeconds: number
  endSeconds: number
  status: 'analyzed' | 'silence' | 'no_audio' | 'unavailable' | 'failed'
  description?: string
  spokenText?: string
  meanDb?: number
  peakWindowDb?: number
  audibleFraction?: number
  onsetTimes?: number[]
  events?: AudioEvent[]
}
export type AnalyzedShot = {
  index: number
  startSeconds: number
  endSeconds: number
  visual?: string
  framing?: string
  cameraMovement?: string
  action?: string
  onScreenText?: string[]
  audio?: string
  audioAnalysis?: AudioSegment
  spokenText?: string
  reconstructionPrompt?: string | null
}
export type AnalysisComponentProvenance = { provider?: string; model?: string | null; method?: string; status?: string }
export type ScriptTemplateSource = { id: string; filename: string; displayName: string; sheet: string; headerRange: string }
export type ScriptTemplateStage = { id: string; label: string; goal: string }
export type ScriptTemplate = {
  id: string; label: string; description: string; format: string; familyId: string
  stages: ScriptTemplateStage[]; reusablePattern: string; sources: ScriptTemplateSource[]; notes: string[]
}
export type ScriptStructureEvidence = { source: 'speech' | 'onScreenText' | 'shot'; index: number; text: string; startSeconds: number; endSeconds: number }
export type ScriptStructure = {
  schemaVersion: 1; templateRevision: string; requestedTemplateId: string
  templateId: string | null; templateLabel: string | null
  status: 'matched' | 'partial' | 'unclassified' | 'unavailable'; summary: string
  stages: Array<{ stageId: string; label: string; startSeconds: number; endSeconds: number; interpretation: string; evidence: ScriptStructureEvidence[] }>
  missingStages: Array<{ id: string; label: string }>; reusablePattern: string | null
  sources: ScriptTemplateSource[]; limitations: string[]
}
export type ScriptBreakdownRow = {
  index: number; basis: 'shot' | 'speech' | 'onScreenText'
  startSeconds: number; endSeconds: number; durationSeconds: number
  location: string | null; visual: string | null; dialogue: string | null; camera: string | null
  onScreenText: string | null; effects: string | null; music: string | null; notes: string | null; stageIds: string[]
}
export type ScriptBreakdown = { schemaVersion: 1 | 2; columns?: Array<{ key: string; label: string }>; rows: ScriptBreakdownRow[]; limitations: string[] }
export const SCRIPT_BREAKDOWN_COLUMNS = ['分镜编号', '取景地', '画面', '台词', '镜头运用', '秒数', '花字', '背景特效与滤镜', '备注'] as const
export type VideoAnalysisResult = {
  schemaVersion: number
  analysisWorkflowId?: AnalysisWorkflowId
  mode?: AnalysisMode
  summary?: string
  inversePrompt?: string | null
  language?: string
  shots?: AnalyzedShot[]
  script?: { segments?: TimedText[]; text?: string; onScreenText?: TimedText[] }
  scriptStructure?: ScriptStructure
  scriptBreakdown?: ScriptBreakdown
  reaVideo?: ReaVideoResult
  audio?: {
    status?: 'analyzed' | 'no_audio' | 'unavailable' | 'failed'
    description?: string
    measurementDescription?: string
    semanticDescription?: string
    segments?: AudioSegment[]
    semanticSegments?: AudioSegment[]
    limitations?: string[]
    measurementWindowSeconds?: number
    timelineVersion?: number
    semanticStatus?: 'analyzed' | 'partial' | 'no_audio' | 'unavailable' | 'failed'
    semanticModel?: string
    semanticLimitations?: string[]
    semanticEvents?: AudioEvent[]
  }
  warnings?: string[]
  provenance?: Record<string, unknown> & {
    workflow?: { id: AnalysisWorkflowId; label?: string; revision?: string; status?: string }
    vision?: AnalysisComponentProvenance & {
      error?: string
      failures?: Array<{ startSeconds: number; endSeconds: number; reason: string; code?: string }>
    }
    speech?: AnalysisComponentProvenance
    soundEvents?: AnalysisComponentProvenance
    components?: Record<string, { detail?: AnalysisComponentProvenance; mode?: string; analyzedAt?: string }>
    multimodal?: {
      analysisModelId?: string
      provider?: string
      model?: string
      visionModel?: string
      inputMode?: 'video_and_audio' | 'video' | 'audio' | 'frames_and_audio' | 'frames'
      mediaTransport?: string
      status?: string
      usage?: Record<string, unknown>
    }
  }
}
export type VideoAnalysisItem = {
  id: string
  title: string
  source: { kind: 'upload' | 'url' | 'reconstruction'; url?: string; filename?: string; profileUrl?: string; discoveryMethod?: string; channelId?: string; creatorHandle?: string; thumbnailUrl?: string; referenceId?: string; reconstructionId?: string }
  status: VideoAnalysisStatus
  progress?: string
  error?: string
  createdAt: string
  updatedAt: string
  durationSeconds?: number
  hasMedia?: boolean
  hasResult?: boolean
  result?: VideoAnalysisResult
}
export type VideoAnalysisModel = {
  id: string
  label: string
  provider: string
  model: string
  available: boolean
  inputMode: string
  reason?: string
}
export type VideoAnalysisConfiguration = {
  analysisWorkflows?: VideoAnalysisWorkflow[]
  defaultAnalysisWorkflowId?: AnalysisWorkflowId
  analysisModels?: VideoAnalysisModel[]
  defaultAnalysisModelId?: string
  scriptTemplates?: ScriptTemplate[]
  defaultScriptTemplateId?: string
  scriptTemplateRevision?: string
  capabilities: {
    provider?: string
    cloud?: { provider?: string; model?: string; visionModel?: string; configured?: boolean; available?: boolean; message?: string; inputMode?: string; mediaTransport?: string }
    available?: boolean
    breakdownAvailable?: boolean
    scriptAvailable?: boolean
    media?: { ffmpeg?: boolean; ffprobe?: boolean }
    speech?: { available?: boolean; provider?: string; model?: string }
    audio?: { available?: boolean; semanticAvailable?: boolean; provider?: string; semanticProvider?: string; message?: string; model?: string }
    vision?: { available?: boolean; provider?: string; model?: string }
    [key: string]: unknown
  }
  limits: { maxUploadBytes?: number; maxWorkspaceBytes?: number; maxDurationSeconds?: number; maxItems?: number }
  referenceChannels: ReferenceChannel[]
}
export type ReferenceChannel = { id: string; name: string; url: string; referenceVideoUrl?: string; referenceVideoTitle?: string }
export type ChannelStyle = {
  direction: string; format: string; editing: string; voice: string
  generationMethod: 'auto' | 'ai_video' | 'footage_edit' | 'hybrid'
  generationNotes: string
}
export type ChannelVideo = { url: string; title: string; thumbnailUrl?: string; publishedAt?: string; durationSeconds?: number }
export type ChannelDiscovery = {
  status: 'idle' | 'running' | 'complete' | 'blocked' | 'partial' | 'failed'
  discoveredCount: number; pagesFetched: number; totalCount?: number; hasNextPage?: boolean
  source?: string; message?: string; updatedAt?: string; resumable?: boolean; requiresConnection?: boolean
}
export type InstagramConnection = { connected: boolean; handle?: string; accountId?: string; method: 'meta_business_discovery'; message?: string }
export type ChannelImportJob = { id: string; channelId: string; status: 'running' | 'stopping' | 'cancelled' | 'complete' | 'paused'; total: number; processed: number; imported: number; skipped: number; failed: number; message?: string; coverageComplete: boolean; updatedAt: string; failures: Array<{ url: string; error: string }> }
export type ChannelAnalysisJob = { id: string; channelId: string; status: 'running' | 'stopping' | 'cancelled' | 'complete' | 'paused'; total: number; processed: number; analyzed: number; partial?: number; skipped: number; failed: number; currentItemId?: string; message?: string; updatedAt: string; failures: Array<{ itemId: string; url?: string; error: string }> }
export type VideoChannel = {
  id: string; platform: string; handle: string; name: string; url: string; avatarUrl?: string
  discoveredVideos: ChannelVideo[]; style: ChannelStyle; createdAt: string; updatedAt: string
  lastSyncedAt?: string; syncError?: string
  discovery?: ChannelDiscovery
  bulkImport?: ChannelImportJob | null
  bulkAnalysis?: ChannelAnalysisJob | null
  observations?: { referenceCount: number; analyzedCount: number; partialCount?: number; shotCount: number; medianShotSeconds?: number; commonFraming: string[]; commonCameraMovement: string[]; speechVideoCount: number; onScreenTextVideoCount: number; visualExamples?: { itemId: string; title: string; text: string }[]; sampleBasis?: string }
}

const prefix = '/api/creator-agent/video-analysis'
export const defaultMaxVideoBytes = 150 * 1024 * 1024
export const referenceChannels: ReferenceChannel[] = [
  { id: 'dreamcode_films', name: 'dreamcode_films', url: 'https://www.instagram.com/dreamcode_films/', referenceVideoUrl: 'https://www.instagram.com/reel/DepDMxUAQPe/', referenceVideoTitle: 'The Year 3267' },
  { id: 'gdarusa', name: 'gdarusa', url: 'https://www.instagram.com/gdarusa/', referenceVideoUrl: 'https://www.instagram.com/p/Dc-i1SJERpW/', referenceVideoTitle: 'Feeling at home in Bangkok' },
]
export const isAnalysisRunning = (item: VideoAnalysisItem) => ['queued', 'importing', 'analyzing'].includes(item.status)
export function analysisProviderLabel(provider?: string) {
  return provider === 'poe' ? 'Poe' : provider === 'siliconflow' ? 'SiliconFlow' : provider === 'ollama' ? 'Ollama' : !provider || provider === 'local' ? 'Local analysis' : provider
}
export function availableAnalysisWorkflows(configuration?: VideoAnalysisConfiguration | null): VideoAnalysisWorkflow[] {
  if (!configuration) return []
  return configuration.analysisWorkflows?.length ? configuration.analysisWorkflows : [{ id: 'standard', label: 'Standard breakdown', available: true, inputMode: 'model', description: 'Analyze shots, speech and sound with the selected model.' }]
}
export function selectedAnalysisWorkflow(configuration?: VideoAnalysisConfiguration | null, preferredId = '') {
  const workflows = availableAnalysisWorkflows(configuration)
  return workflows.find(workflow => workflow.id === preferredId && workflow.available)
    || workflows.find(workflow => workflow.id === configuration?.defaultAnalysisWorkflowId && workflow.available)
    || workflows.find(workflow => workflow.id === 'standard' && workflow.available)
    || workflows.find(workflow => workflow.available)
    || workflows.find(workflow => workflow.id === 'standard')
    || workflows[0]
}
export function savedAnalysisWorkflow(result?: VideoAnalysisResult) {
  const saved = result?.provenance?.workflow
  const id = saved?.id || result?.analysisWorkflowId || (result?.reaVideo ? 'rea-video' : 'standard')
  return { id, label: saved?.label || (id === 'rea-video' ? 'Rea-video' : 'Standard breakdown'), revision: saved?.revision || result?.reaVideo?.workflowRevision, status: saved?.status }
}
export function selectedWorkflowCapabilities(configuration?: VideoAnalysisConfiguration | null, workflow = selectedAnalysisWorkflow(configuration), model = selectedAnalysisModel(configuration)) {
  if (workflow?.id !== 'rea-video') {
    const capabilities = selectedAnalysisCapabilities(configuration, model)
    return workflow && !workflow.available ? { available: false, shots: false, vision: false, speech: false, audio: false, semanticAudio: false, reason: workflow.reason || 'The selected analysis workflow is unavailable.' } : capabilities
  }
  const mediaReady = configuration?.capabilities.media?.ffmpeg !== false && configuration?.capabilities.media?.ffprobe !== false
  const available = workflow.available && mediaReady
  return { available, shots: available, vision: false, speech: false, audio: available, semanticAudio: false, reason: !workflow.available ? workflow.reason || 'Rea-video is unavailable.' : !mediaReady ? 'FFmpeg and FFprobe are required for the local technical breakdown.' : '' }
}
export function savedAnalysisPresentation(result?: VideoAnalysisResult) {
  const provenance = result?.provenance
  const multimodal = provenance?.multimodal
  const components = (['vision', 'speech', 'soundEvents'] as const).flatMap(key => {
    const detail = provenance?.[key] || provenance?.components?.[key]?.detail
    if (!detail || detail.status === 'not_requested') return []
    const provider = detail.provider || (detail.method?.startsWith('multimodal_') ? multimodal?.provider : undefined) || 'local'
    const model = detail.model || ''
    const source = `${analysisProviderLabel(provider)} · ${model || `Model not recorded${detail.method ? ` (${detail.method})` : ''}`}`
    const status = ['failed', 'unavailable', 'partial', 'no_audio', 'silence'].includes(detail.status || '') ? detail.status!.replace(/_/g, ' ') : ''
    return [{ key, label: key === 'vision' ? 'Visuals' : key === 'speech' ? 'Speech' : 'Sound labels', provider, model, source, status }]
  })
  const providerGroup = (provider: string) => ['local', 'ollama'].includes(provider) ? 'local' : provider
  const providers = new Set(components.map(component => providerGroup(component.provider)))
  const models = new Set(components.map(component => `${providerGroup(component.provider)}:${component.model || component.source}`))
  const mixed = providers.size > 1 || models.size > 1
  const uniform = components[0]
  const headline = mixed ? providers.size > 1 ? 'Mixed providers and models' : 'Mixed models'
    : `${analysisProviderLabel(uniform?.provider || multimodal?.provider)}${uniform?.model || multimodal?.model ? ` · ${uniform?.model || multimodal?.model}` : ''}${multimodal?.visionModel ? ` + ${multimodal.visionModel}` : ''}`
  return { mixed, headline, components, inputLabel: mixed ? '' : videoAnalysisInputLabel(multimodal) }
}
export function availableAnalysisModels(configuration?: VideoAnalysisConfiguration | null): VideoAnalysisModel[] {
  if (!configuration) return []
  if (configuration.analysisModels?.length) return configuration.analysisModels
  const cloud = configuration.capabilities.cloud
  const provider = cloud?.provider || configuration.capabilities.provider || 'local'
  return [{
    id: configuration.defaultAnalysisModelId || provider,
    label: cloud?.model || analysisProviderLabel(provider), provider,
    model: cloud?.model || configuration.capabilities.vision?.model || '',
    available: cloud ? cloud.available !== false : configuration.capabilities.available !== false,
    inputMode: cloud?.inputMode || 'local', reason: cloud?.message,
  }]
}
export function selectedAnalysisModel(configuration?: VideoAnalysisConfiguration | null, preferredId = '') {
  const models = availableAnalysisModels(configuration)
  return models.find(model => model.id === preferredId && model.available)
    || models.find(model => model.id === configuration?.defaultAnalysisModelId && model.available)
    || models.find(model => model.available)
    || models.find(model => model.id === configuration?.defaultAnalysisModelId)
    || models[0]
}
export function analysisModelSelectionNotice(configuration?: VideoAnalysisConfiguration | null, preferredId = '') {
  const models = availableAnalysisModels(configuration)
  const requested = models.find(model => model.id === preferredId)
    || models.find(model => model.id === configuration?.defaultAnalysisModelId)
  const selected = selectedAnalysisModel(configuration, preferredId)
  const unavailable = requested && !requested.available && selected?.id !== requested.id ? requested
    : models.find(model => model.provider === 'poe' && !model.available)
  const removed = preferredId && models.length && !models.some(model => model.id === preferredId) && selected?.available
    ? `The previously selected analysis model is no longer offered. New analyses will use ${selected.label}. Saved results keep their original model labels.`
    : ''
  const unavailableNotice = unavailable ? `${unavailable.label} is unavailable. ${unavailable.reason || 'The server cannot currently use this model.'} ${selected?.available ? `New analyses will use ${selected.label}.` : ''}`.trim() : ''
  return [removed, unavailableNotice].filter(Boolean).join(' ')
}
export function selectedAnalysisCapabilities(configuration?: VideoAnalysisConfiguration | null, model = selectedAnalysisModel(configuration)) {
  const capabilities = configuration?.capabilities
  const mediaReady = capabilities?.media?.ffmpeg !== false && capabilities?.media?.ffprobe !== false
  const mediaReason = mediaReady ? '' : 'FFmpeg and FFprobe are required to prepare video and audio. Configure the missing media tools on the server.'
  if (!model) return { available: false, shots: false, vision: false, speech: false, audio: false, semanticAudio: false, reason: 'No analysis model is available.' }
  const ready = model.available && mediaReady
  const reason = !model.available ? model.reason || 'The selected model is unavailable.' : mediaReason
  if (model.provider !== 'local') {
    const hasVideo = ['video_and_audio', 'video', 'frames_and_audio', 'frames'].includes(model.inputMode)
    const hasAudio = ['video_and_audio', 'audio', 'frames_and_audio'].includes(model.inputMode)
    return { available: ready, shots: ready && hasVideo, vision: ready && hasVideo, speech: ready && hasAudio, audio: ready && hasAudio, semanticAudio: ready && hasAudio, reason }
  }
  // Status component details belong to its reported provider. A cloud provider's
  // failure does not establish that a local speech or visual model is installed.
  const localStatus = !capabilities?.provider || capabilities.provider === 'local'
  return {
    available: ready && (localStatus ? capabilities?.available !== false : true),
    shots: ready && (localStatus ? capabilities?.breakdownAvailable === true : false),
    vision: ready && localStatus && capabilities?.vision?.available === true,
    speech: ready && localStatus && capabilities?.speech?.available === true,
    audio: ready && (localStatus ? capabilities?.audio?.available === true : capabilities?.media?.ffmpeg === true && capabilities.media.ffprobe === true),
    semanticAudio: ready && localStatus && capabilities?.audio?.semanticAvailable === true,
    reason,
  }
}
export function analysisModelMatchesResult(model: VideoAnalysisModel | undefined, result?: VideoAnalysisResult) {
  if (!model || !result) return false
  const saved = result.provenance?.multimodal
  const components = savedAnalysisPresentation(result).components
  if (model.provider === 'local') return (!saved?.provider || saved.provider === 'local') && components.every(component => ['local', 'ollama'].includes(component.provider))
  if (components.some(component => component.provider !== model.provider || component.model && component.model !== model.model)) return false
  if (saved?.provider !== model.provider || saved.model !== model.model || saved.visionModel) return false
  if (result.mode === 'audio' && saved.inputMode === 'audio') return true
  return !['video', 'video_and_audio'].includes(model.inputMode) || saved.mediaTransport === 'original_video'
}
export function videoAnalysisInputLabel(source?: { inputMode?: string; mediaTransport?: string }) {
  if (source?.inputMode === 'audio') return 'Audio only'
  if (source?.inputMode === 'frames_and_audio') return 'Extracted frames + audio'
  if (source?.inputMode === 'frames') return 'Extracted frames'
  if (source?.inputMode === 'video_and_audio') return source.mediaTransport === 'original_video' ? 'Complete video + audio' : 'Video + audio'
  if (source?.inputMode === 'video') return source.mediaTransport === 'original_video' ? 'Complete video' : 'Video'
  return ''
}
export function videoAnalysisNotes(result?: VideoAnalysisResult) {
  const vision = result?.provenance?.vision
  const notes = [...(result?.warnings || []), vision?.error || '', ...(vision?.failures || []).map(failure => {
    const reason = failure.reason?.trim()
    if (!reason) return ''
    const interval = Number.isFinite(failure.startSeconds) && Number.isFinite(failure.endSeconds)
      ? `${videoTime(failure.startSeconds)}–${videoTime(failure.endSeconds)}: ` : ''
    return `Shot analysis ${interval}${reason}`
  })]
  return [...new Set(notes.filter((note): note is string => typeof note === 'string').map(note => note.trim()).filter(Boolean))]
}
export function shotAnalysisPresentation(item: VideoAnalysisItem, configuration?: VideoAnalysisConfiguration | null, analysisModelId?: string) {
  const result = item.result, vision = result?.provenance?.vision
  const notRequested = vision?.status === 'not_requested' || !vision?.status && ['audio', 'script'].includes(result?.mode || '')
  const running = isAnalysisRunning(item)
  const selectedModel = analysisModelId ? availableAnalysisModels(configuration).find(model => model.id === analysisModelId) : undefined
  const available = selectedModel ? selectedAnalysisCapabilities(configuration, selectedModel).vision : configuration?.capabilities.breakdownAvailable !== false && configuration?.capabilities.vision?.available !== false
  const visualNotes = videoAnalysisNotes(result).filter(note => /visual|vision|shot|frame/i.test(note))
  const reason = vision?.error?.trim() || vision?.failures?.find(failure => failure.reason?.trim())?.reason.trim()
    || visualNotes.find(note => /fail(?:ed|ure)?|error|unavailable|time(?:d?\s*out|out)|could not|unable/i.test(note)) || visualNotes[0]
  return {
    title: running ? 'Analysis is running' : notRequested ? 'Shot analysis was not requested' : 'Shot analysis could not finish',
    description: running ? 'Your saved results remain available while this video is processed.'
      : notRequested ? 'This result contains audio or script analysis. Analyze the shots to add visual descriptions.'
      : 'The visual step did not return any shot descriptions. Your saved script and audio remain available.',
    reason: notRequested ? undefined : reason,
    actionLabel: notRequested ? 'Analyze shots' : 'Retry shot analysis',
    canRun: available && item.hasMedia !== false && !running,
    unavailableReason: item.hasMedia === false ? 'Import or upload the video file to analyze its shots.'
      : !available ? 'Shot analysis is currently unavailable. Check analysis availability above before retrying.' : undefined,
  }
}
export function mergeVideoAnalyses(previous: VideoAnalysisItem[], incoming: VideoAnalysisItem[]) {
  const next = new Map(previous.map(item => [item.id, item]))
  for (const item of incoming) {
    const existing = next.get(item.id)
    if (!existing || existing.updatedAt <= item.updatedAt) {
      next.set(item.id, { ...item, ...(item.result ? {} : existing?.result ? { result: existing.result } : {}) })
    }
  }
  return [...next.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}
export const videoTime = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}${seconds % 1 >= 0.05 ? `.${Math.floor((seconds % 1) * 10 + 1e-7)}` : ''}`
}

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const { data } = await apiRequest(prefix + path, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })
  return data as T
}
export const getVideoAnalysisConfiguration = () => request<VideoAnalysisConfiguration>('/status')
export const listVideoChannels = () => request<{ channels: VideoChannel[] }>('/channels')
// Public discovery and artwork may take longer than ordinary JSON reads.
export const addVideoChannel = (url: string) => binaryRequest<{ channel: VideoChannel }>('/channels', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: normalizeVideoReferenceUrl(url) }) }, response => response.json())
export const syncVideoChannel = (id: string) => binaryRequest<{ channel: VideoChannel }>(`/channels/${encodeURIComponent(id)}/sync`, { method: 'POST' }, response => response.json())
export const discoverVideoChannel = (id: string, resume = true) => request<{ channel: VideoChannel }>(`/channels/${encodeURIComponent(id)}/discover`, 'POST', { resume })
export const importAllChannelVideos = (id: string) => request<{ channel: VideoChannel; job: ChannelImportJob }>(`/channels/${encodeURIComponent(id)}/import-all`, 'POST', {})
export const stopChannelImports = (id: string) => request<{ channel: VideoChannel; job: ChannelImportJob }>(`/channels/${encodeURIComponent(id)}/import-all/stop`, 'POST', {})
export const analyzeAllChannelVideos = (id: string, analysisModelId?: string, scriptTemplateId = 'none', analysisWorkflowId?: AnalysisWorkflowId) => request<{ channel: VideoChannel; job: ChannelAnalysisJob }>(`/channels/${encodeURIComponent(id)}/analyze-all`, 'POST', { ...(analysisModelId && analysisWorkflowId !== 'rea-video' ? { analysisModelId } : {}), scriptTemplateId: analysisWorkflowId === 'rea-video' ? 'none' : scriptTemplateId, ...(analysisWorkflowId ? { analysisWorkflowId } : {}) })
export const stopChannelAnalyses = (id: string) => request<{ channel: VideoChannel; job: ChannelAnalysisJob }>(`/channels/${encodeURIComponent(id)}/analyze-all/stop`, 'POST', {})
export const getInstagramConnection = () => request<{ connection: InstagramConnection }>('/instagram-connection')
export const connectInstagram = (accountId: string, accessToken: string) => request<{ connection: InstagramConnection }>('/instagram-connection', 'PUT', { accountId: accountId.trim(), accessToken: accessToken.trim() })
export const disconnectInstagram = () => request<{ connection: InstagramConnection }>('/instagram-connection', 'DELETE')
export function channelDiscoveryPresentation(channel: VideoChannel) {
  const discovery = channel.discovery
  const count = channel.discoveredVideos.length
  if (channel.platform === 'tiktok') return { complete: false, running: false, count, title: 'Public TikTok videos', action: 'Refresh public videos', message: channel.syncError || 'This preview lists up to 24 public posts. Saved references and style settings stay in this creator workspace. It is not a complete channel archive.' }
  const complete = discovery?.status === 'complete' && discovery.hasNextPage === false
  const running = discovery?.status === 'running'
  const titles = { idle: 'Discover the full channel', running: 'Discovering the channel', complete: 'Channel discovery complete', blocked: 'Instagram access needed', partial: 'Discovery paused', failed: 'Discovery needs attention' }
  return {
    complete, running, count,
    title: complete ? titles.complete : discovery?.status === 'complete' ? 'Discovery is incomplete' : discovery?.status === 'blocked' && !discovery.requiresConnection ? 'Discovery paused' : titles[discovery?.status || 'idle'],
    action: running ? 'Discovering…' : complete ? 'Refresh full channel' : discovery?.resumable ? 'Resume discovery' : discovery?.status === 'blocked' || discovery?.status === 'failed' ? 'Retry full discovery' : 'Discover full channel',
    message: discovery?.message || (complete ? 'The connected source reached the end of the available channel feed.' : running ? 'Videos are added as each page arrives. You can keep using the app.' : 'The public preview is only a sample. Full discovery needs a source that can page through the channel feed.'),
  }
}
export function mergeVideoChannels(previous: VideoChannel[], incoming: VideoChannel[]) {
  const next = new Map(previous.map(channel => [channel.id, channel]))
  for (const channel of incoming) {
    const existing = next.get(channel.id)
    if (!existing || channel.updatedAt >= existing.updatedAt) next.set(channel.id, channel)
  }
  return [...next.values()]
}
export const saveVideoChannelStyle = (id: string, style: ChannelStyle) => request<{ channel: VideoChannel }>(`/channels/${encodeURIComponent(id)}`, 'PATCH', { style })
export function channelImageUrl(value?: string) {
  if (!value) return undefined
  if (value.startsWith(prefix + '/channels/')) return apiBase() + value
  try { const url = new URL(value); return url.protocol === 'https:' ? url.href : undefined } catch { return undefined }
}
export function videoBelongsToChannel(item: VideoAnalysisItem, channel?: VideoChannel, knownChannels: VideoChannel[] = []) {
  if (item.source.kind === 'reconstruction') return !channel
  if (item.source.channelId) return item.source.channelId === channel?.id
  if (item.source.kind === 'upload') return !channel
  let platform = ''
  try { const host = new URL(item.source.url || item.source.profileUrl || '').hostname; platform = ['instagram.com', 'www.instagram.com'].includes(host) ? 'instagram' : ['tiktok.com', 'www.tiktok.com', 'm.tiktok.com'].includes(host) ? 'tiktok' : '' } catch { /* A handle alone is not verified ownership. */ }
  if (!platform) return !channel
  const samePlatform = (value: VideoChannel) => (value.platform || value.id?.split('-')[0] || 'instagram') === platform
  const handle = item.source.creatorHandle?.replace(/^@/, '').toLowerCase()
  if (handle) return channel ? samePlatform(channel) && handle === channel.handle.toLowerCase() : !knownChannels.some(value => samePlatform(value) && value.handle.toLowerCase() === handle)
  let profile = ''
  try {
    const url = new URL(item.source.profileUrl || '')
    if (['instagram.com', 'www.instagram.com', 'tiktok.com', 'www.tiktok.com', 'm.tiktok.com'].includes(url.hostname)) profile = url.pathname.split('/').filter(Boolean)[0]?.replace(/^@/, '').toLowerCase() || ''
  } catch { /* An unverified source remains unassigned. */ }
  return profile ? channel ? samePlatform(channel) && profile === channel.handle.toLowerCase() : !knownChannels.some(value => samePlatform(value) && value.handle.toLowerCase() === profile) : !channel
}
export function videoReferenceKey(value?: string) {
  try {
    const url = new URL(value || '')
    const match = url.pathname.match(/^\/(?:reel|reels|p|tv)\/([^/]+)/)
    if (['instagram.com', 'www.instagram.com'].includes(url.hostname) && match) return `instagram:${match[1]}`
    url.search = ''; url.hash = ''; return url.href.replace(/\/$/, '')
  } catch { return value || '' }
}
export function uniqueChannelReferences(items: VideoAnalysisItem[]) {
  const chosen = new Map<string, VideoAnalysisItem>()
  const priority = (item: VideoAnalysisItem) => item.result || item.hasResult ? 2 : item.status === 'failed' && !item.hasMedia ? 0 : 1
  for (const item of items) {
    const key = item.source.kind === 'upload' ? item.id : videoReferenceKey(item.source.url) || item.id
    const existing = chosen.get(key)
    if (!existing || priority(item) > priority(existing) || priority(item) === priority(existing) && item.updatedAt > existing.updatedAt) chosen.set(key, item)
  }
  return [...chosen.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}
export function channelCreativeBrief(channel: VideoChannel) {
  const style = channel.style
  const methods = { auto: 'Decide per idea', ai_video: 'AI generated shots', footage_edit: 'Recorded or licensed footage and editing', hybrid: 'Footage and generated shots' }
  const count = channel.observations?.analyzedCount || 0
  const lines = [`Channel brief: @${channel.handle}`, channel.url, '', `Evidence: ${count} analyzed reference${count === 1 ? '' : 's'}. Observations are not a trained model.`, '']
  for (const [label, value] of [['Visual direction', style.direction], ['Recurring format', style.format], ['Editing and sound', style.editing], ['Voice and writing', style.voice], ['Preferred production approach', methods[style.generationMethod] || methods.auto], ['Production notes', style.generationNotes]]) if (value) lines.push(`${label}: ${value}`, '')
  lines.push('Use this as a creative brief. No video has been generated from these preferences.')
  return lines.join('\n').trim()
}
export const listVideoAnalyses = () => request<{ items: VideoAnalysisItem[] }>('/items')
export const getVideoAnalysis = (id: string) => request<{ item: VideoAnalysisItem }>(`/items/${encodeURIComponent(id)}`)
export function normalizeVideoReferenceUrl(value: string) {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 2048) throw new Error('Paste a full public HTTPS link to a profile, reel or video.')
  let url: URL
  try { url = new URL(trimmed) } catch { throw new Error('Paste a full public HTTPS link to a profile, reel or video.') }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port && url.port !== '443') {
    throw new Error('Use a public HTTPS link without login details or a fragment.')
  }
  return url.href
}
export const importReferenceVideo = (url: string, channelId?: string) => request<{ item: VideoAnalysisItem }>('/imports', 'POST', { url: normalizeVideoReferenceUrl(url), ...(channelId ? { channelId } : {}) })
export async function addVideoSource(value: string): Promise<{ kind: 'channel'; channel: VideoChannel } | { kind: 'video'; item: VideoAnalysisItem }> {
  const url = new URL(normalizeVideoReferenceUrl(value))
  if (['instagram.com', 'www.instagram.com'].includes(url.hostname) && /^\/[A-Za-z0-9_.]+\/?$/.test(url.pathname) || ['tiktok.com', 'www.tiktok.com', 'm.tiktok.com'].includes(url.hostname) && /^\/@[A-Za-z0-9_.]{1,30}\/?$/.test(url.pathname)) {
    return { kind: 'channel', ...await addVideoChannel(url.href) }
  }
  // A video entered in the channel form must not inherit the selected account.
  // The server may resolve its verified owner; otherwise it stays unassigned.
  return { kind: 'video', ...await importReferenceVideo(url.href) }
}
export const analyzeReferenceVideo = (id: string, mode: AnalysisMode, analysisModelId?: string, scriptTemplateId = 'none', analysisWorkflowId?: AnalysisWorkflowId) => request<{ item: VideoAnalysisItem }>(`/items/${encodeURIComponent(id)}/analyze`, 'POST', { mode, ...(analysisModelId && analysisWorkflowId !== 'rea-video' ? { analysisModelId } : {}), scriptTemplateId: analysisWorkflowId === 'rea-video' ? 'none' : scriptTemplateId, ...(analysisWorkflowId ? { analysisWorkflowId } : {}) })

async function binaryRequest<T>(path: string, options: RequestInit, read: (response: Response) => Promise<T>, signal?: AbortSignal) {
  const controller = new AbortController()
  const cancel = () => controller.abort()
  if (signal?.aborted) controller.abort()
  else signal?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(cancel, 180_000)
  try {
    const response = await fetch(apiBase() + prefix + path, { ...options, cache: 'no-store', signal: controller.signal })
    if (!response.ok) {
      const data = await response.json().catch(() => null)
      throw new ApiError(data?.error || `Could not read the video (${response.status}).`, response.status)
    }
    return await read(response)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
  }
}
export async function uploadReferenceVideo(file: File, signal?: AbortSignal, channelId?: string) {
  return binaryRequest<{ item: VideoAnalysisItem }>(`/uploads?filename=${encodeURIComponent(file.name)}${channelId ? `&channelId=${encodeURIComponent(channelId)}` : ''}`, {
    method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file,
  }, response => response.json(), signal)
}
export async function getReferenceMedia(id: string, signal?: AbortSignal) {
  return binaryRequest(`/items/${encodeURIComponent(id)}/media`, {}, response => response.blob(), signal)
}
export async function getChannelAvatar(id: string, signal?: AbortSignal) {
  return binaryRequest(`/channels/${encodeURIComponent(id)}/avatar`, {}, response => response.blob(), signal)
}
export async function getChannelImage(value: string, signal?: AbortSignal) {
  if (!/^\/api\/creator-agent\/video-analysis\/channels\/[a-z0-9_.-]+\/(?:avatar|thumbnail)(?:\?[^#]*)?$/.test(value)) throw new Error('Invalid channel image.')
  return binaryRequest(value.slice(prefix.length), {}, response => response.blob(), signal)
}
export async function exportVideoAnalysis(id: string, format: 'txt' | 'md' | 'json') {
  return binaryRequest(`/items/${encodeURIComponent(id)}/export?format=${format}`, {}, response => response.blob())
}
export function reaAssetUrl(itemId: string, assetId: string, download = false) {
  if (!itemId || !/^(?:storyboard|audio-chart|shot-\d{3})$/.test(assetId)) throw new Error('Invalid Rea-video image.')
  return `${apiBase()}${prefix}/items/${encodeURIComponent(itemId)}/rea-assets?asset=${encodeURIComponent(assetId)}${download ? '&download=1' : ''}`
}
export function getReaFrameGrid(itemId: string, startSeconds: number, endSeconds: number, signal?: AbortSignal) {
  if (!itemId || !Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || startSeconds < 0 || endSeconds <= startSeconds || endSeconds - startSeconds > 12) throw new Error('Choose a time range of up to 12 seconds.')
  const query = new URLSearchParams({ start: String(startSeconds), end: String(endSeconds) })
  return binaryRequest(`/items/${encodeURIComponent(itemId)}/rea-frames?${query}`, {}, async response => {
    if (!response.headers.get('Content-Type')?.startsWith('image/jpeg')) throw new Error('The frame preview did not return an image.')
    return response.blob()
  }, signal)
}
export function saveReaReviewNotes(id: string, notes: ReaReviewNotes) {
  const fields = ['summary', 'hook', 'payoff', 'characters', 'corrections'] as const
  const body = Object.fromEntries(fields.map(key => {
    const value = notes[key]
    if (typeof value !== 'string' || value.length > 4000) throw new Error('Review notes must be text of up to 4,000 characters per field.')
    return [key, value]
  }))
  return request<{ item: VideoAnalysisItem }>(`/items/${encodeURIComponent(id)}/rea-review`, 'PUT', body)
}

export function audioMeasurementText(segment: AudioSegment) {
  const values: string[] = []
  if (segment.status === 'no_audio') return 'No audio track'
  if (segment.status === 'unavailable' || segment.status === 'failed') return 'Sound timing unavailable'
  if (segment.status === 'silence') values.push('Silent or very quiet')
  if (Number.isFinite(segment.meanDb)) values.push(`Average ${Math.round(segment.meanDb!)} dBFS`)
  if (Number.isFinite(segment.peakWindowDb)) values.push(`Loudest window ${Math.round(segment.peakWindowDb!)} dBFS`)
  if (Number.isFinite(segment.audibleFraction)) values.push(`${Math.round(Math.max(0, Math.min(1, segment.audibleFraction!)) * 100)}% above silence threshold`)
  return values.join(' · ')
}

export function audioEventText(event: AudioEvent) {
  const description = event.description && event.description !== event.label ? `${event.label}: ${event.description}` : event.label
  const label = Number.isFinite(event.confidence) && event.confidence! >= 0 && event.confidence! <= 1
    ? `${description} (model score ${Number((event.confidence! * 100).toFixed(1))}%)`
    : description
  if (!Number.isFinite(event.startSeconds)) return label
  const end = Number.isFinite(event.endSeconds) ? `–${videoTime(event.endSeconds!)}` : ''
  return `${videoTime(event.startSeconds!)}${end}: ${label}`
}

export function analysisText(item: VideoAnalysisItem, section: 'shots' | 'script' | 'audio') {
  const result = item.result
  if (!result) return ''
  const lines = [item.title, '']
  const workflow = savedAnalysisWorkflow(result)
  lines.push(`Analysis workflow: ${workflow.label}${workflow.revision ? ` · ${workflow.revision}` : ''}`, '')
  if (result.reaVideo) {
    const rea = result.reaVideo
    lines.push('Rea-video technical breakdown', `Verdict: ${rea.verdict.replace(/_/g, ' ')}`, 'Review status: Unreviewed', 'Semantic video interpretation: Not run', '')
    for (const shot of rea.technicalShots) {
      lines.push(`Technical interval ${shot.index + 1} · ${videoTime(shot.startSeconds)}–${videoTime(shot.endSeconds)}`, `Classification: ${shot.label.replace(/_/g, ' ')}`, ...(typeof shot.confidence === 'number' && Number.isFinite(shot.confidence) ? [`Heuristic score: ${Math.round(Math.min(1, Math.max(0, shot.confidence)) * 100)}%`] : []), ...shot.evidence.map(evidence => `Measurement: ${evidence}`), '')
    }
    for (const report of rea.sections || []) lines.push(report.title, report.body, '')
    if (rea.soundCandidates?.length) lines.push('Sound-event candidates · unconfirmed signal estimates', ...rea.soundCandidates.map(candidate => `${videoTime(candidate.startSeconds)}–${videoTime(candidate.endSeconds)}: ${candidate.description}`), '')
    if (rea.capabilities?.length) lines.push('Rea-video functions', ...rea.capabilities.map(capability => `${capability.label} · ${capability.status.replace(/_/g, ' ')}: ${capability.detail}`), '')
    if (rea.reviewNotes) {
      lines.push('Your review notes · supplied by user, not automatic model understanding', `Updated: ${rea.reviewNotes.updatedAt}`)
      for (const [key, label] of [['summary', 'What makes it work'], ['hook', 'Opening hook'], ['payoff', 'Payoff'], ['characters', 'People and objects'], ['corrections', 'Corrections']] as const) {
        if (rea.reviewNotes[key]) lines.push(`${label}: ${rea.reviewNotes[key]}`)
      }
      lines.push('')
    }
    if (rea.limitations.length) lines.push('Rea-video limitations', ...rea.limitations, '')
  }
  const saved = savedAnalysisPresentation(result)
  if (saved.mixed) lines.push(`Analysis model: ${saved.headline}`, ...saved.components.map(component => `${component.label}: ${component.source}${component.status ? ` (${component.status})` : ''}`), '')
  else if (result.provenance?.multimodal?.model) lines.push(`Analysis model: ${result.provenance.multimodal.provider || 'Cloud'} · ${result.provenance.multimodal.model}${result.provenance.multimodal.visionModel ? ` + ${result.provenance.multimodal.visionModel}` : ''}`, '')
  const inputLabel = saved.inputLabel
  if (inputLabel) lines.push(`Analysis input: ${inputLabel}`, '')
  if (section === 'shots') {
    if (result.summary) lines.push(result.summary, '')
    if (result.inversePrompt) lines.push('Reconstruction prompt', result.inversePrompt, '')
    for (const [index, shot] of (result.shots || []).entries()) {
      lines.push(`Shot ${index + 1} · ${videoTime(shot.startSeconds)}–${videoTime(shot.endSeconds)}`)
      for (const [label, value] of [['Visual', shot.visual], ['Framing', shot.framing], ['Camera', shot.cameraMovement], ['Action', shot.action], ['Audio', shot.audio], ['Spoken words', shot.spokenText]] as const) {
        if (value) lines.push(`${label}: ${value}`)
      }
      if (shot.audioAnalysis) {
        if (shot.audioAnalysis.description && shot.audioAnalysis.description !== shot.audio) lines.push(`Sound: ${shot.audioAnalysis.description}`)
        if (shot.audioAnalysis.events?.length) lines.push(`Sound label estimates: ${shot.audioAnalysis.events.map(audioEventText).join(' / ')}`)
        const measurements = audioMeasurementText(shot.audioAnalysis)
        if (measurements) lines.push(`Sound measurements: ${measurements}`)
      }
      if (shot.onScreenText?.length) lines.push(`On-screen text: ${shot.onScreenText.join(' / ')}`)
      if (shot.reconstructionPrompt) lines.push(`Reconstruction prompt: ${shot.reconstructionPrompt}`)
      lines.push('')
    }
  } else if (section === 'audio') {
    lines.push('Audio timeline')
    if (result.audio?.semanticDescription || result.audio?.description) lines.push(result.audio.semanticDescription || result.audio.description!)
    if (result.audio?.semanticModel) lines.push(`Sound model: ${result.audio.semanticModel}`)
    const audioSegments = result.audio?.segments?.length ? result.audio.segments : result.audio?.semanticSegments || []
    for (const segment of audioSegments) {
      lines.push('', `[${videoTime(segment.startSeconds)}–${videoTime(segment.endSeconds)}]${segment.shotIndex === null ? '' : ` Shot ${segment.shotIndex + 1}`}`)
      if (segment.description) lines.push(segment.description)
      const measurements = audioMeasurementText(segment)
      if (measurements) lines.push(measurements)
      if (segment.spokenText) lines.push(`Spoken words: ${segment.spokenText}`)
      if (segment.events?.length) lines.push(`Sound label estimates: ${segment.events.map(audioEventText).join(' / ')}`)
      if (segment.onsetTimes?.length) lines.push(`Sound changes (estimated): ${segment.onsetTimes.map(videoTime).join(', ')}`)
    }
    if (!audioSegments.length) lines.push('No aligned audio timeline saved. Analyze this video with Video + audio or Audio only to create one.')
    const limitations = [...new Set([...(result.audio?.limitations || []), ...(result.audio?.semanticLimitations || [])])]
    if (limitations.length) lines.push('', 'Audio limitations', ...limitations)
  } else {
    const breakdown = scriptBreakdownText(result)
    if (breakdown) lines.push(breakdown, '')
    lines.push('Spoken words')
    const segments = result.script?.segments || []
    if (segments.length) for (const segment of segments) lines.push(`[${videoTime(segment.startSeconds)}–${videoTime(segment.endSeconds)}] ${segment.text}`)
    else lines.push(result.script?.text || 'No spoken text returned.')
    lines.push('', 'On-screen text')
    const captions = result.script?.onScreenText || []
    if (captions.length) for (const segment of captions) lines.push(`[${videoTime(segment.startSeconds)}–${videoTime(segment.endSeconds)}] ${segment.text}`)
    else lines.push('No on-screen text returned.')
  }
  const notes = videoAnalysisNotes(result)
  if (notes.length) lines.push('', 'Analysis notes', ...notes)
  return lines.join('\n').trim()
}

export function selectedScriptTemplateId(configuration: VideoAnalysisConfiguration | null, preferredId?: string) {
  const valid = (id?: string) => id === 'none' || id === 'auto' || configuration?.scriptTemplates?.some(template => template.id === id)
  if (valid(preferredId)) return preferredId!
  if (valid(configuration?.defaultScriptTemplateId)) return configuration!.defaultScriptTemplateId!
  return 'none'
}

export function scriptRowLabel(row: Pick<ScriptBreakdownRow, 'index' | 'basis'>) {
  return `${row.basis === 'shot' ? 'Shot' : row.basis === 'speech' ? 'Speech segment' : 'Text interval'} ${row.index + 1}`
}

export function scriptStructureStatusLabel(status: ScriptStructure['status']) {
  return ({ matched: 'Structure matched', partial: 'Partial structure match', unclassified: 'No clear structure match', unavailable: 'Structure analysis unavailable' })[status]
}

function scriptBreakdownText(result: VideoAnalysisResult) {
  const lines: string[] = []
  const breakdown = result.scriptBreakdown
  if (breakdown) {
    lines.push('Script breakdown')
    lines.push(SCRIPT_BREAKDOWN_COLUMNS.join(' | '))
    for (const row of breakdown.rows) {
      lines.push('', `${scriptRowLabel(row)} · ${videoTime(row.startSeconds)}–${videoTime(row.endSeconds)} · ${row.durationSeconds.toFixed(2)}s`)
      for (const [label, value] of [['取景地', row.location], ['画面', row.visual], ['台词', row.dialogue], ['镜头运用', row.camera], ['花字', row.onScreenText], ['背景特效与滤镜', row.effects], ['备注', row.notes]] as const) {
        if (value) lines.push(`${label}: ${value}`)
      }
    }
    if (!breakdown.rows.length) lines.push('No supported breakdown rows were returned.')
    if (breakdown.limitations.length) lines.push('', 'Breakdown limitations', ...breakdown.limitations)
  }
  const structure = result.scriptStructure?.requestedTemplateId === 'none' ? undefined : result.scriptStructure
  if (structure) {
    if (lines.length) lines.push('')
    lines.push('Script structure', scriptStructureStatusLabel(structure.status))
    if (structure.templateLabel) lines.push(`Template: ${structure.templateLabel}`)
    lines.push(`Requested template: ${structure.requestedTemplateId}`, `Template revision: ${structure.templateRevision}`)
    if (structure.summary) lines.push(structure.summary)
    for (const stage of structure.stages) {
      lines.push('', `${stage.label} · ${videoTime(stage.startSeconds)}–${videoTime(stage.endSeconds)}`, `Interpretation: ${stage.interpretation}`)
      for (const evidence of stage.evidence) lines.push(`Evidence (${evidence.source}, ${videoTime(evidence.startSeconds)}–${videoTime(evidence.endSeconds)}): ${evidence.text}`)
    }
    if (structure.missingStages.length) lines.push('', `Stages without supporting evidence: ${structure.missingStages.map(stage => stage.label).join(', ')}`)
    if (structure.reusablePattern) lines.push('', 'Reusable structure', structure.reusablePattern)
    if (structure.sources.length) lines.push('', 'Template sources', ...structure.sources.map(source => `${source.displayName} · ${source.sheet} · ${source.headerRange}`))
    if (structure.limitations.length) lines.push('', 'Structure limitations', ...structure.limitations)
  }
  return lines.join('\n').trim()
}
