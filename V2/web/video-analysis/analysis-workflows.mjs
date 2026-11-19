import { reaVideoCapability } from './rea-video.mjs'

export const DEFAULT_ANALYSIS_WORKFLOW_ID = 'standard'
export const STANDARD_ANALYSIS_WORKFLOW_REVISION = '1'

export function analysisWorkflowConfiguration(config = {}) {
  const rea = reaVideoCapability(config)
  return {
    defaultAnalysisWorkflowId: DEFAULT_ANALYSIS_WORKFLOW_ID,
    analysisWorkflows: [
      { id: 'standard', label: 'Model video breakdown', available: true, usesModel: true, revision: STANDARD_ANALYSIS_WORKFLOW_REVISION, modes: ['both', 'breakdown', 'script', 'audio'] },
      { id: 'rea-video', label: 'Rea Video · local technical analysis', description: 'Measures shots, motion and production evidence locally. Story, object actions and meaning remain unreviewed.', available: rea.available === true, configured: rea.configured === true, usesModel: false, revision: rea.revision, modes: ['both', 'breakdown'], ...(rea.reason ? { reason: rea.reason } : {}) },
    ],
  }
}

/** Requests choose a workflow ID, never a command, path, provider or API key. */
export function resolveAnalysisWorkflow(config = {}, requestedId = DEFAULT_ANALYSIS_WORKFLOW_ID) {
  if (typeof requestedId !== 'string' || !['standard', 'rea-video'].includes(requestedId)) throw Object.assign(new Error('Choose an available video breakdown workflow from the list.'), { status: 422, code: 'invalid_analysis_workflow' })
  if (requestedId === 'standard') return { workflowId: requestedId, workflowRevision: STANDARD_ANALYSIS_WORKFLOW_REVISION }
  const capability = reaVideoCapability(config)
  if (!capability.available) throw Object.assign(new Error(capability.reason || 'Rea Video is not configured on this server.'), { status: 503, code: 'analysis_workflow_unavailable' })
  return { workflowId: requestedId, workflowRevision: capability.revision }
}
