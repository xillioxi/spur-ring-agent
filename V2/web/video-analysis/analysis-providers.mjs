import { siliconFlowCapability } from './siliconflow.mjs'
import { poeCapability } from './poe.mjs'
import { SCRIPT_BREAKDOWN_SCHEMA_VERSION } from './script-templates.mjs'

const THINKING = 'Qwen/Qwen3-Omni-30B-A3B-Thinking'
const INSTRUCT = 'Qwen/Qwen3-Omni-30B-A3B-Instruct'
const MODELS = Object.freeze([
  { id: 'poe-gemini-3.7-flash', label: 'Gemini 3.7 Flash · Poe', provider: 'poe', model: 'Gemini-3.7-Flash' },
  { id: 'siliconflow-qwen3-omni-thinking', label: 'Qwen3 Omni Thinking · SiliconFlow', provider: 'siliconflow', model: THINKING },
  { id: 'siliconflow-qwen3-omni-instruct', label: 'Qwen3 Omni Instruct · SiliconFlow', provider: 'siliconflow', model: INSTRUCT },
  { id: 'local', label: 'Local video and audio tools', provider: 'local', model: null },
])

export function defaultAnalysisModelId(config = {}) {
  if (config.SPUR_VIDEO_ANALYSIS_PROVIDER === 'poe') return 'poe-gemini-3.7-flash'
  if (config.SPUR_VIDEO_ANALYSIS_PROVIDER === 'siliconflow') return config.SPUR_VIDEO_ANALYSIS_CLOUD_MODEL === THINKING ? 'siliconflow-qwen3-omni-thinking' : 'siliconflow-qwen3-omni-instruct'
  return 'local'
}

function configuredModel(config, entry) {
  const snapshot = { ...config, SPUR_VIDEO_ANALYSIS_PROVIDER: entry.provider }
  if (entry.provider === 'poe') snapshot.SPUR_VIDEO_ANALYSIS_POE_MODEL = entry.model
  if (entry.provider === 'siliconflow') snapshot.SPUR_VIDEO_ANALYSIS_CLOUD_MODEL = entry.model
  return snapshot
}

function describe(config, entry, localCapability) {
  const cloudDefault = ['poe', 'siliconflow'].includes(config.SPUR_VIDEO_ANALYSIS_PROVIDER)
  const local = {
    available: localCapability ? localCapability.available === true : !cloudDefault,
    inputMode: 'local_media', model: localCapability?.vision?.model || config.SPUR_VIDEO_ANALYSIS_MODEL || '',
    ...(cloudDefault && !localCapability ? { reason: 'Local analysis readiness has not been checked while a cloud provider is configured. Start Spur with local analysis enabled to use the local models.' } : {}),
    ...(localCapability && localCapability.available !== true ? { reason: localCapability.warnings?.join(' ') || 'The local video and audio analysis tools are unavailable.' } : {}),
  }
  const capability = entry.provider === 'poe' ? poeCapability(config) : entry.provider === 'siliconflow' ? siliconFlowCapability(config) : local
  return { id: entry.id, label: entry.label, provider: entry.provider, model: capability.model, available: capability.available, inputMode: capability.inputMode, ...(capability.reason ? { reason: capability.reason } : {}) }
}

export function analysisModels(config = {}, { localCapability } = {}) {
  return MODELS.map(entry => describe(entry.provider === 'local' ? config : configuredModel(config, entry), entry, localCapability))
}

/** The client selects an ID only. Credentials, endpoints and models stay host-owned. */
export function resolveAnalysisSelection(config = {}, requestedId) {
  const id = requestedId === undefined ? defaultAnalysisModelId(config) : requestedId
  const entry = MODELS.find(value => value.id === id)
  if (!entry || typeof id !== 'string') throw Object.assign(new Error('Choose an available analysis model from the list.'), { status: 422, code: 'invalid_analysis_model' })
  // Preserve existing host defaults when callers omit a model selection.
  const snapshot = Object.freeze(requestedId === undefined && entry.provider !== 'poe' ? { ...config } : configuredModel(config, entry))
  const model = describe(entry.provider === 'local' ? config : snapshot, entry)
  if (!model.available && (requestedId !== undefined || entry.provider !== 'local')) throw Object.assign(new Error(model.reason || 'This analysis model is unavailable on the server.'), { status: 503, code: 'analysis_model_unavailable' })
  const target = entry.provider === 'poe' ? poeCapability(snapshot) : entry.provider === 'siliconflow' ? siliconFlowCapability(snapshot) : null
  return Object.freeze({ id, provider: entry.provider, model: model.model, config: snapshot, target })
}

export function analysisHasCloudComponents(item) {
  return ['vision', 'boundaries', 'ocr', 'speech', 'soundEvents'].some(key => ['poe', 'siliconflow'].includes(item.result?.provenance?.[key]?.provider))
}

export function analysisMatchesSelection(item, selection) {
  const workflowId = selection.workflowId || 'standard'
  const actualWorkflowId = item.result?.analysisWorkflowId || item.result?.provenance?.workflow?.id || (item.result?.reaVideo ? 'rea-video' : 'standard')
  if (actualWorkflowId !== workflowId) return false
  if (selection.scriptTemplateId !== undefined) {
    const table = item.result?.scriptBreakdown
    if (table?.schemaVersion !== SCRIPT_BREAKDOWN_SCHEMA_VERSION || table?.revision !== selection.scriptTemplateRevision) return false
    if (selection.scriptTemplateId === 'none') {
      if (item.result?.scriptStructure) return false
    } else if (item.result?.scriptStructure?.requestedTemplateId !== selection.scriptTemplateId || item.result?.scriptStructure?.templateRevision !== selection.scriptTemplateRevision) return false
  }
  // This workflow intentionally leaves semantic understanding and transcription
  // unavailable. A finished local report can be current while still unreviewed.
  if (workflowId === 'rea-video') return item.hasResult === true && ['complete', 'partial'].includes(item.status) && item.result?.mode === 'both' && item.result?.reaVideo?.schemaVersion === 1 && item.result.reaVideo.workflowRevision === selection.workflowRevision && Array.isArray(item.result.reaVideo.technicalShots) && item.result.reaVideo.reviewStatus === 'unreviewed'
  const audio = item.result?.audio, ready = ['analyzed', 'no_audio', 'silence']
  if (!item.hasResult || audio?.timelineVersion !== 1 || !ready.includes(audio.semanticStatus) || !ready.includes(audio.speechStatus)) return false
  const actual = item.result.provenance?.multimodal
  if (selection.provider === 'local') return !actual && !analysisHasCloudComponents(item) && ['complete', 'partial'].includes(item.status)
  return item.status === 'complete' && item.result.mode === 'both' && actual?.status === 'analyzed' && actual.provider === selection.provider && actual.model === selection.model && actual.mediaTransport === selection.target?.mediaTransport
}
