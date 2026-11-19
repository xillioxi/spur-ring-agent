import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { analysisWorkflowConfiguration, resolveAnalysisWorkflow } from './analysis-workflows.mjs'
import { analysisMatchesSelection } from './analysis-providers.mjs'
import { createVideoAnalysisService, waitForVideoAnalysisIdle } from './service.mjs'
import { REA_VIDEO_REVISION, REA_VIDEO_UPSTREAM_REVISION } from './rea-video.mjs'

const revision = REA_VIDEO_REVISION
async function fixture(t, engine) {
  const root = await mkdtemp(join(process.cwd(), '.spur-analysis-workflow-test-'))
  t.after(async () => { await waitForVideoAnalysisIdle(); await rm(root, { recursive: true, force: true }) })
  const source = join(root, 'rea-source'), python = join(root, 'python.exe')
  await mkdir(join(source, 'rea_video'), { recursive: true })
  await Promise.all([writeFile(join(source, 'rea_video', 'pipeline.py'), '# readiness fixture only'), writeFile(python, 'not executed')])
  const config = { SPUR_REA_VIDEO_PYTHON: python, SPUR_REA_VIDEO_SOURCE: source, SPUR_VIDEO_ANALYSIS_PROVIDER: 'poe', SPUR_POE_FLASH_API_AVAILABLE: '0', POE_API_KEY: 'synthetic-private-poe-key', SILICONFLOW_API_KEY: 'synthetic-private-silicon-key' }
  return { root, config, service: createVideoAnalysisService({ root, config, engine }) }
}
const upload = (service, channelId) => service.upload(Readable.from(['saved video']), { filename: 'reference.mp4', channelId })
const reaResult = (mode = 'both') => ({
  schemaVersion: 1, status: 'partial', mode, summary: 'Unreviewed local technical analysis.', metadata: { durationSeconds: 8, hasAudio: true },
  shots: [{ index: 0, startSeconds: 0, endSeconds: 8, visual: 'Camera motion estimate; semantic content not reviewed.', framing: null, cameraMovement: 'Static estimate', action: null, onScreenText: [] }],
  script: { segments: [], text: '', onScreenText: [] }, audio: { timelineVersion: 1, status: 'analyzed', windows: [], onsetCandidates: [], semanticStatus: 'unavailable', speechStatus: 'not_requested', semanticEvents: [] }, warnings: ['No semantic review, speech transcription or OCR was performed.'],
  provenance: { vision: { provider: 'rea-video', status: 'unavailable' }, speech: { provider: 'local', status: 'unavailable' }, ocr: { provider: 'local', status: 'unavailable' }, boundaries: { provider: 'local', status: 'analyzed', method: 'scene detection' } },
  reaVideo: { schemaVersion: 1, verdict: 'Technical estimates only.', vlmStatus: 'not_requested', reviewStatus: 'unreviewed', technicalShots: [{ index: 0, startSeconds: 0, endSeconds: 8, label: 'Static', confidence: 0.7, evidence: ['Low optical flow'] }], limitations: ['This report does not identify the joke.'], workflowRevision: revision },
})
const standardResult = mode => ({ schemaVersion: 1, status: 'complete', mode, summary: 'Fresh model analysis.', metadata: { durationSeconds: 8, hasAudio: true }, shots: [{ index: 0, startSeconds: 0, endSeconds: 8, visual: 'Fresh visible action', onScreenText: [] }], script: { segments: [], text: '', onScreenText: [] }, warnings: [], provenance: { vision: { provider: 'local', status: 'analyzed' }, speech: { provider: 'local', status: 'analyzed' } } })

test('workflow readiness exposes no private paths or keys and never requires a cloud model', async t => {
  const { config } = await fixture(t)
  const publicConfig = analysisWorkflowConfiguration(config)
  assert.equal(publicConfig.defaultAnalysisWorkflowId, 'standard')
  assert.equal(publicConfig.analysisWorkflows.find(value => value.id === 'rea-video').available, true)
  assert.equal(publicConfig.analysisWorkflows.find(value => value.id === 'rea-video').usesModel, false)
  assert.doesNotMatch(JSON.stringify(publicConfig), /synthetic-private|python\.exe|rea-source/)
  assert.deepEqual(resolveAnalysisWorkflow(config, 'rea-video'), { workflowId: 'rea-video', workflowRevision: revision })
  for (const id of [null, {}, 'C:/run.py', 'https://example.com', 'unregistered']) assert.throws(() => resolveAnalysisWorkflow(config, id), { status: 422 })
  assert.throws(() => resolveAnalysisWorkflow({}, 'rea-video'), { status: 503 })
})

test('local Rea jobs bypass unavailable cloud models, exclude credentials and retain explicit partial status', async t => {
  const calls = [], { root, config, service } = await fixture(t, { analyze: async args => { calls.push(args); return reaResult(args.mode) } })
  const item = await upload(service)
  await assert.rejects(service.analyze(item.id), { status: 503, code: 'analysis_model_unavailable' })
  for (const mode of ['script', 'audio']) await assert.rejects(service.analyze(item.id, { analysisWorkflowId: 'rea-video', mode }), { status: 422, code: 'unsupported_analysis_workflow_mode' })
  const receipt = await service.analyze(item.id, { analysisWorkflowId: 'rea-video' })
  assert.equal(receipt.analysisWorkflowId, 'rea-video'); assert.equal(receipt.analysisModelId, null)
  config.SPUR_REA_VIDEO_SOURCE = 'changed-after-queue'
  await service.whenIdle()
  assert.equal(calls.length, 1); assert.equal(calls[0].analysisWorkflowId, 'rea-video')
  assert.match(calls[0].config.SPUR_REA_VIDEO_SOURCE, /rea-source$/)
  assert.doesNotMatch(JSON.stringify(calls[0].config), /API_KEY|synthetic-private|POE/)
  const saved = await service.get(item.id)
  assert.equal(saved.status, 'partial'); assert.equal(saved.result.analysisWorkflowId, 'rea-video')
  assert.equal(saved.result.reaVideo.reviewStatus, 'unreviewed'); assert.equal(saved.result.reaVideo.vlmStatus, 'not_requested')
  assert.equal(saved.result.scriptBreakdown.columns.length, 9)
  assert.equal(saved.result.inversePrompt, null); assert.ok(saved.result.shots.every(shot => shot.reconstructionPrompt === null))
  assert.equal(saved.result.provenance.workflow.revision, revision)
  const text = await service.exportItem(item.id, { format: 'txt' })
  assert.match(text.body, /Rea Video local technical analysis/); assert.match(text.body, /unreviewed/); assert.match(text.body, /does not identify the joke/)
  assert.doesNotMatch(await readFile(join(root, 'reference-library.json'), 'utf8'), /synthetic-private|python\.exe|rea-source/)
})

test('switching workflows never merges old Rea technical data or model descriptions into a fresh partial run', async t => {
  const { config, service } = await fixture(t, { analyze: async args => args.analysisWorkflowId === 'rea-video' ? reaResult(args.mode) : standardResult(args.mode) })
  config.SPUR_VIDEO_ANALYSIS_PROVIDER = 'local'
  const item = await upload(service)
  await service.analyze(item.id, { analysisWorkflowId: 'rea-video' }); await service.whenIdle()
  await service.analyze(item.id, { mode: 'audio' }); await service.whenIdle()
  let saved = await service.get(item.id)
  assert.equal(saved.result.analysisWorkflowId, 'standard'); assert.equal(saved.result.reaVideo, undefined)
  assert.equal(saved.result.shots[0].visual, 'Fresh visible action')
  assert.doesNotMatch(JSON.stringify(saved.result.provenance.components), /scene detection|rea-video/)
  await service.analyze(item.id, { analysisWorkflowId: 'rea-video', mode: 'breakdown' }); await service.whenIdle()
  saved = await service.get(item.id)
  assert.equal(saved.status, 'partial'); assert.equal(saved.result.script.text, '')
  assert.equal(saved.result.shots[0].visual, 'Camera motion estimate; semantic content not reviewed.')
  assert.doesNotMatch(JSON.stringify(saved.result), /Fresh visible action/)
})

test('bulk Rea selection propagates and skips only reports from the same completed technical workflow revision', async t => {
  const calls = [], channelId = 'instagram-dreamcode_films'
  const { service } = await fixture(t, { analyze: async args => { calls.push(args.analysisWorkflowId); return reaResult(args.mode) } })
  await upload(service, channelId); await upload(service, channelId)
  const first = await service.analyzeAllChannelVideos(channelId, { analysisWorkflowId: 'rea-video' })
  assert.equal(first.job.analysisWorkflowId, 'rea-video'); assert.equal(first.job.analysisModelId, null)
  await service.whenIdle(); assert.deepEqual(calls, ['rea-video', 'rea-video'])
  await service.analyzeAllChannelVideos(channelId, { analysisWorkflowId: 'rea-video' }); await service.whenIdle()
  const job = (await service.getChannel(channelId)).bulkAnalysis
  assert.equal(job.skipped, 2); assert.equal(calls.length, 2)
  const saved = await service.get((await service.list({ channelId }))[0].id)
  const selection = { workflowId: 'rea-video', workflowRevision: revision }
  assert.equal(analysisMatchesSelection(saved, selection), true)
  assert.equal(analysisMatchesSelection(saved, { ...selection, workflowRevision: REA_VIDEO_UPSTREAM_REVISION }), false)
  const oldReport = { ...saved, result: { ...saved.result, provenance: { ...saved.result.provenance, workflow: { ...saved.result.provenance.workflow, revision: REA_VIDEO_UPSTREAM_REVISION } }, reaVideo: { ...saved.result.reaVideo, workflowRevision: REA_VIDEO_UPSTREAM_REVISION } } }
  assert.equal(analysisMatchesSelection(oldReport, selection), false)
  assert.equal(analysisMatchesSelection(saved, { ...selection, workflowRevision: 'changed' }), false)
  assert.equal(analysisMatchesSelection(saved, { provider: 'local' }), false)
  assert.equal(analysisMatchesSelection({ ...saved, status: 'failed' }, selection), false)
})
