import test from 'node:test'
import assert from 'node:assert/strict'
import { analysisModels, defaultAnalysisModelId, resolveAnalysisSelection, analysisMatchesSelection } from './analysis-providers.mjs'
import { SCRIPT_TEMPLATE_REVISION, SCRIPT_BREAKDOWN_SCHEMA_VERSION } from './script-templates.mjs'

test('selection is a server allowlist and public descriptors exclude credentials and endpoints', () => {
  const config = { POE_API_KEY: 'private-poe-key', POE_BASE_URL: 'https://api.poe.com/v1', SILICONFLOW_API_KEY: 'private-silicon-key', SPUR_VIDEO_ANALYSIS_POE_MODEL: 'other-host-model' }
  const models = analysisModels(config)
  assert.equal(models.find(value => value.id === 'poe-gemini-3.7-flash').model, 'Gemini-3.7-Flash')
  assert.equal(models.some(value => value.id === 'poe-gemini-4-argon'), false)
  assert.equal(models.find(value => value.id === 'siliconflow-qwen3-omni-thinking').model, 'Qwen/Qwen3-Omni-30B-A3B-Thinking')
  assert.doesNotMatch(JSON.stringify(models), /private-|api\.poe|other-host-model/)
  for (const id of ['https://evil.example/v1', 'arbitrary-model', 'poe-gemini-4-argon', null, {}, 'sk-private-key']) assert.throws(() => resolveAnalysisSelection(config, id), { status: 422 })
  assert.throws(() => resolveAnalysisSelection({}, 'siliconflow-qwen3-omni-thinking'), { status: 503 })
  const chosen = resolveAnalysisSelection(config, 'poe-gemini-3.7-flash')
  config.POE_API_KEY = 'changed-after-queue'
  assert.equal(chosen.config.POE_API_KEY, 'private-poe-key')
  assert.equal(chosen.config.SPUR_VIDEO_ANALYSIS_POE_MODEL, 'Gemini-3.7-Flash')
  assert.ok(Object.isFrozen(chosen.config))
  assert.equal(defaultAnalysisModelId({ SPUR_VIDEO_ANALYSIS_PROVIDER: 'poe' }), 'poe-gemini-3.7-flash')
})

test('Flash selection ignores the old Argon refusal and never treats historical Argon results as current Flash analyses', () => {
  const config = { SPUR_VIDEO_ANALYSIS_PROVIDER: 'poe', POE_API_KEY: 'private-key', SPUR_POE_ARGON_API_AVAILABLE: '0' }
  const selection = resolveAnalysisSelection(config)
  assert.equal(selection.id, 'poe-gemini-3.7-flash')
  assert.equal(selection.model, 'Gemini-3.7-Flash')
  assert.equal(analysisModels(config).find(value => value.id === selection.id).available, true)
  const item = { hasResult: true, status: 'complete', result: { mode: 'both', audio: { timelineVersion: 1, semanticStatus: 'analyzed', speechStatus: 'analyzed' }, provenance: { multimodal: { status: 'analyzed', provider: 'poe', model: 'Gemini-4-Argon', mediaTransport: selection.target.mediaTransport } } } }
  assert.equal(analysisMatchesSelection(item, selection), false)
  item.result.provenance.multimodal.model = 'Gemini-3.7-Flash'
  assert.equal(analysisMatchesSelection(item, selection), true)
})

test('freshness requires actual provider, model, transport and complete audiovisual evidence', () => {
  const selection = resolveAnalysisSelection({ SILICONFLOW_API_KEY: 'private-key' }, 'siliconflow-qwen3-omni-thinking')
  const item = { hasResult: true, status: 'complete', result: { mode: 'both', audio: { timelineVersion: 1, semanticStatus: 'analyzed', speechStatus: 'analyzed' }, provenance: { multimodal: { status: 'analyzed', provider: 'siliconflow', model: selection.model, mediaTransport: selection.target.mediaTransport } } } }
  assert.equal(analysisMatchesSelection(item, selection), true)
  for (const change of [{ provider: 'poe' }, { model: 'different-model' }, { mediaTransport: 'frames_and_audio' }, { status: 'partial' }]) {
    const changed = structuredClone(item); Object.assign(changed.result.provenance.multimodal, change)
    assert.equal(analysisMatchesSelection(changed, selection), false)
  }
  assert.equal(analysisMatchesSelection(item, resolveAnalysisSelection({}, 'local')), false)
})

test('unavailable cloud defaults fail before queueing and unchecked local options stay disabled under cloud hosts', () => {
  for (const config of [{ SPUR_VIDEO_ANALYSIS_PROVIDER: 'poe', POE_API_KEY: 'synthetic-key', SPUR_POE_FLASH_API_AVAILABLE: '0' }, { SPUR_VIDEO_ANALYSIS_PROVIDER: 'siliconflow' }]) {
    assert.throws(() => resolveAnalysisSelection(config), { status: 503 })
    const local = analysisModels(config).find(model => model.id === 'local')
    assert.equal(local.available, false); assert.match(local.reason, /readiness has not been checked/)
    assert.throws(() => resolveAnalysisSelection(config, 'local'), { status: 503 })
  }
  const detected = analysisModels({}, { localCapability: { available: false, warnings: ['No local models are ready.'] } }).find(model => model.id === 'local')
  assert.equal(detected.available, false); assert.equal(detected.reason, 'No local models are ready.')
})

test('local freshness rejects retained cloud components even after an audio retry removes the top-level cloud run', () => {
  const selection = resolveAnalysisSelection({}, 'local')
  const item = { hasResult: true, status: 'complete', result: { mode: 'audio', audio: { timelineVersion: 1, speechStatus: 'analyzed', semanticStatus: 'analyzed' }, provenance: {} } }
  assert.equal(analysisMatchesSelection(item, selection), true)
  for (const key of ['vision', 'boundaries', 'ocr', 'speech', 'soundEvents']) {
    const mixed = structuredClone(item); mixed.result.provenance[key] = { provider: 'siliconflow', status: 'analyzed' }
    assert.equal(analysisMatchesSelection(mixed, selection), false)
  }
})

test('production freshness requires the corrected table revision and a complete analysis without an optional narrative', () => {
  const selection = { ...resolveAnalysisSelection({ SILICONFLOW_API_KEY: 'private-key' }, 'siliconflow-qwen3-omni-thinking'), scriptTemplateId: 'none', scriptTemplateRevision: SCRIPT_TEMPLATE_REVISION }
  const item = { hasResult: true, status: 'complete', result: { mode: 'both', scriptBreakdown: { schemaVersion: SCRIPT_BREAKDOWN_SCHEMA_VERSION, revision: SCRIPT_TEMPLATE_REVISION }, audio: { timelineVersion: 1, semanticStatus: 'analyzed', speechStatus: 'analyzed' }, provenance: { multimodal: { status: 'analyzed', provider: selection.provider, model: selection.model, mediaTransport: selection.target.mediaTransport } } } }
  assert.equal(analysisMatchesSelection(item, selection), true)
  for (const patch of [{ scriptBreakdown: { schemaVersion: 1, revision: SCRIPT_TEMPLATE_REVISION } }, { scriptBreakdown: { schemaVersion: SCRIPT_BREAKDOWN_SCHEMA_VERSION, revision: 'old' } }, { mode: 'script' }, { scriptStructure: { requestedTemplateId: 'auto' } }]) {
    const stale = structuredClone(item); Object.assign(stale.result, patch)
    assert.equal(analysisMatchesSelection(stale, selection), false)
  }
})
