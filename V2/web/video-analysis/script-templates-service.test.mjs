import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { createVideoAnalysisService, waitForVideoAnalysisIdle } from './service.mjs'
import { SCRIPT_TEMPLATE_REVISION, SCRIPT_TEMPLATES } from './script-templates.mjs'

const channelId = 'instagram-dreamcode_films'
const model = 'Qwen/Qwen3-Omni-30B-A3B-Instruct'
const modelId = 'siliconflow-qwen3-omni-instruct'
const config = () => ({ SPUR_VIDEO_ANALYSIS_PROVIDER: 'siliconflow', SILICONFLOW_API_KEY: 'synthetic-private-fixture-key' })
const originalLine = 'Look at these two objects.'
const caption = 'TWO OBJECTS'

function resultFor({ mode = 'both', scriptTemplateId = 'xc-1', line = originalLine } = {}) {
  const template = SCRIPT_TEMPLATES.find(value => value.id === scriptTemplateId) || SCRIPT_TEMPLATES[0]
  const spoken = { startSeconds: 0, endSeconds: 2, text: line }
  return {
    schemaVersion: 1, status: 'complete', mode, summary: 'A presenter introduces two objects on a table.', language: 'en',
    metadata: { durationSeconds: 10, hasAudio: true, hasVideo: true, width: 720, height: 1280 },
    shots: mode === 'script' || mode === 'audio' ? [] : [
      { index: 0, startSeconds: 0, endSeconds: 5, visual: 'Two objects on a table.', action: 'A hand points to both objects.', framing: 'Wide shot', cameraMovement: 'Static', location: 'Visible tabletop', effects: 'Visible split-screen overlay', notes: 'The labels are too small to identify.', onScreenText: [caption] },
      { index: 1, startSeconds: 5, endSeconds: 10, visual: 'A hand lifts one object.', action: 'Lifts the nearer object.', framing: 'Close-up', cameraMovement: 'Static', onScreenText: [] },
    ],
    script: { text: line, segments: [spoken], onScreenText: [{ startSeconds: 2, endSeconds: 4, text: caption }] },
    scriptStructure: {
      templateId: template.id, summary: 'The opening directs attention to the objects.',
      stages: [{ stageId: template.stages[0].id, startSeconds: 0, endSeconds: 2, interpretation: 'An immediate invitation opens the demonstration.', evidence: [{ source: 'speech', ...spoken }] }],
    },
    audio: { timelineVersion: 1, status: 'analyzed', speechStatus: 'analyzed', semanticStatus: 'analyzed', windows: [], onsetCandidates: [], semanticEvents: [{ startSeconds: 0, endSeconds: 10, label: 'Music', category: 'music', description: 'Quiet instrumental music.' }] },
    warnings: [],
    provenance: {
      multimodal: { provider: 'siliconflow', model, mediaTransport: 'original_video', status: 'analyzed' },
      vision: { provider: 'siliconflow', model, status: mode === 'script' ? 'not_requested' : 'analyzed' },
      speech: { provider: 'siliconflow', model, status: 'analyzed' },
      ocr: { provider: 'siliconflow', model, status: 'analyzed' },
    },
  }
}

async function fixture(t, { engine, hostConfig = config() } = {}) {
  const root = await mkdtemp(join(process.cwd(), '.spur-script-template-service-test-'))
  t.after(async () => { await waitForVideoAnalysisIdle(); await rm(root, { recursive: true, force: true }) })
  return { root, hostConfig, service: createVideoAnalysisService({ root, config: hostConfig, engine: engine || { analyze: async args => resultFor(args) } }) }
}
const upload = (service, filename = 'reference.mp4', extra = {}) => service.upload(Readable.from(['fixture-video']), { filename, contentType: 'video/mp4', contentLength: 13, ...extra })
async function freshService(root, engine, hostConfig = config()) {
  const module = await import(`./service.mjs?script-templates-restart=${randomUUID()}`)
  return module.createVideoAnalysisService({ root, engine, config: hostConfig })
}

test('service exposes all 11 source templates and validates IDs before changing a saved item or calling an analyzer', async t => {
  let calls = 0
  const { root, service } = await fixture(t, { engine: { analyze: async args => { calls++; return resultFor(args) } } })
  const status = await service.status()
  assert.equal(status.scriptTemplates.length, 11)
  assert.deepEqual(status.scriptTemplates.map(value => value.id).sort(), SCRIPT_TEMPLATES.map(value => value.id).sort())
  assert.equal(status.defaultScriptTemplateId, 'none')
  assert.deepEqual(status.scriptBreakdownColumns.map(column => column.label), ['分镜编号', '取景地', '画面', '台词', '镜头运用', '秒数', '花字', '背景特效与滤镜', '备注'])
  assert.equal(status.scriptTemplateRevision, SCRIPT_TEMPLATE_REVISION)
  assert.ok(status.scriptTemplates.every(value => value.sources.length && value.stages.length))
  assert.doesNotMatch(JSON.stringify(status), /synthetic-private-fixture-key|AppData|Temp[\\/]/)
  const item = await upload(service, 'validation.mp4', { channelId })
  const before = await service.get(item.id)
  for (const scriptTemplateId of ['not-registered', '../../private.xlsx', {}, null]) {
    await assert.rejects(service.analyze(item.id, { scriptTemplateId }), { status: 422, code: 'invalid_script_template' })
    await assert.rejects(service.analyzeAllChannelVideos(channelId, { scriptTemplateId }), { status: 422, code: 'invalid_script_template' })
  }
  assert.equal(calls, 0)
  assert.deepEqual(await service.get(item.id), before)
  assert.equal((await service.getChannel(channelId)).bulkAnalysis, null)
  assert.doesNotMatch(await readFile(join(root, 'reference-library.json'), 'utf8'), /synthetic-private-fixture-key/)
})

test('queued work snapshots each requested template and does not silently replace a waiting item selection', async t => {
  const calls = []
  let release, entered
  const gate = new Promise(resolve => release = resolve), started = new Promise(resolve => entered = resolve)
  const { root, hostConfig, service } = await fixture(t, { engine: { analyze: async args => {
    calls.push({ template: args.scriptTemplateId, provider: args.config.SPUR_VIDEO_ANALYSIS_PROVIDER })
    if (calls.length === 1) { entered(); await gate }
    return resultFor(args)
  } } })
  const first = await upload(service, 'first.mp4'), second = await upload(service, 'second.mp4')
  try {
    await service.analyze(first.id, { scriptTemplateId: 'xc-1', analysisModelId: modelId }); await started
    const request = { scriptTemplateId: 'xc-2', analysisModelId: modelId }
    const receipt = await service.analyze(second.id, request)
    assert.equal(receipt.scriptTemplateId, 'xc-2')
    assert.equal(receipt.scriptTemplateRevision, SCRIPT_TEMPLATE_REVISION)
    request.scriptTemplateId = 'auto'; hostConfig.SPUR_VIDEO_ANALYSIS_PROVIDER = 'poe'
    const repeat = await service.analyze(second.id, { scriptTemplateId: 'auto', analysisModelId: modelId })
    assert.equal(repeat.scriptTemplateId, 'xc-2')
  } finally { release() }
  await service.whenIdle()
  assert.deepEqual(calls, [{ template: 'xc-1', provider: 'siliconflow' }, { template: 'xc-2', provider: 'siliconflow' }])
  assert.equal((await service.get(first.id)).result.scriptStructure.requestedTemplateId, 'xc-1')
  assert.equal((await service.get(second.id)).result.scriptStructure.requestedTemplateId, 'xc-2')
  assert.doesNotMatch(await readFile(join(root, 'reference-library.json'), 'utf8'), /synthetic-private-fixture-key/)
})

test('bulk jobs retain their template, skip current revisions and reanalyze only stale saved template revisions', async t => {
  const calls = []
  let release, entered
  const gate = new Promise(resolve => release = resolve), started = new Promise(resolve => entered = resolve)
  const engine = { analyze: async args => {
    calls.push(args.scriptTemplateId)
    if (calls.length === 1) { entered(); await gate }
    return resultFor(args)
  } }
  const { root, service } = await fixture(t, { engine })
  const saved = []
  for (let index = 0; index < 3; index++) saved.push(await upload(service, `batch-${index}.mp4`, { channelId }))
  const request = { scriptTemplateId: 'xc-1', analysisModelId: modelId }
  try {
    const receipt = await service.analyzeAllChannelVideos(channelId, request); await started
    assert.equal(receipt.job.scriptTemplateId, 'xc-1')
    request.scriptTemplateId = 'xc-2'
    await assert.rejects(service.analyzeAllChannelVideos(channelId, request), { status: 409 })
    assert.equal((await service.analyzeAllChannelVideos(channelId, { scriptTemplateId: 'xc-1', analysisModelId: modelId })).job.id, receipt.job.id)
  } finally { release() }
  await service.whenIdle()
  assert.deepEqual(calls, ['xc-1', 'xc-1', 'xc-1'])
  await service.analyzeAllChannelVideos(channelId, { scriptTemplateId: 'xc-1', analysisModelId: modelId }); await service.whenIdle()
  assert.equal(calls.length, 3)
  assert.equal((await service.getChannel(channelId)).bulkAnalysis.skipped, 3)
  await service.analyzeAllChannelVideos(channelId, { scriptTemplateId: 'xc-2', analysisModelId: modelId }); await service.whenIdle()
  assert.deepEqual(calls, ['xc-1', 'xc-1', 'xc-1', 'xc-2', 'xc-2', 'xc-2'])
  const filename = join(root, 'reference-library.json'), document = JSON.parse(await readFile(filename, 'utf8'))
  document.items.find(value => value.id === saved[0].id).result.scriptStructure.templateRevision = 'obsolete-fixture-revision'
  await writeFile(filename, JSON.stringify(document))
  const restarted = await freshService(root, engine)
  await restarted.analyzeAllChannelVideos(channelId, { scriptTemplateId: 'xc-2', analysisModelId: modelId }); await restarted.whenIdle()
  assert.equal(calls.length, 7)
  assert.equal((await restarted.getChannel(channelId)).bulkAnalysis.skipped, 2)
  assert.equal((await restarted.get(saved[0].id)).result.scriptStructure.templateRevision, SCRIPT_TEMPLATE_REVISION)
  const progress = await readFile(join(root, 'channel-analysis-job.json'), 'utf8')
  assert.equal(JSON.parse(progress).job.scriptTemplateId, 'xc-2')
  assert.doesNotMatch(progress, /synthetic-private-fixture-key|SILICONFLOW_API_KEY/)
})

test('saved structure and production rows remain separate from verbatim speech and survive reload and all export formats', async t => {
  const { root, service } = await fixture(t)
  const item = await upload(service)
  await service.analyze(item.id, { scriptTemplateId: 'xc-1' }); await service.whenIdle()
  const saved = await service.get(item.id), result = saved.result
  assert.equal(result.script.text, originalLine)
  assert.deepEqual(result.script.segments, [{ startSeconds: 0, endSeconds: 2, text: originalLine }])
  assert.equal(result.script.scriptStructure, undefined)
  assert.equal(result.scriptStructure.templateId, 'xc-1')
  assert.equal(result.scriptStructure.stages[0].evidence[0].text, originalLine)
  assert.equal(result.scriptStructure.templateRevision, SCRIPT_TEMPLATE_REVISION)
  assert.equal(result.scriptStructure.provenance.provider, 'siliconflow')
  assert.equal(result.scriptBreakdown.rows.length, 2)
  const row = result.scriptBreakdown.rows[0]
  assert.equal(row.location, 'Visible tabletop')
  assert.equal(row.dialogue, originalLine)
  assert.equal(row.onScreenText, caption)
  assert.equal(row.effects, 'Visible split-screen overlay')
  assert.equal(row.music, 'Quiet instrumental music.')
  assert.match(row.camera, /Wide shot/)
  const restored = await freshService(root)
  assert.deepEqual((await restored.get(item.id)).result.scriptStructure, result.scriptStructure)
  assert.deepEqual((await restored.get(item.id)).result.scriptBreakdown, result.scriptBreakdown)
  for (const format of ['txt', 'md']) {
    const exported = await restored.exportItem(item.id, { format })
    assert.match(exported.body, /Script structure/)
    assert.match(exported.body, /Script production breakdown/)
    assert.match(exported.body, /Reusable template pattern \(adaptation guide, not observed dialogue\)/)
    assert.ok(exported.body.includes(result.scriptStructure.reusablePattern))
    assert.ok(exported.body.includes(originalLine))
    assert.match(exported.body, /Visible tabletop/)
    assert.match(exported.body, /TWO OBJECTS/)
    assert.match(exported.body, /分镜编号/)
    assert.match(exported.body, /Template source:/)
    assert.doesNotMatch(exported.body, /synthetic-private-fixture-key/)
  }
  const exported = JSON.parse((await restored.exportItem(item.id, { format: 'json' })).body)
  assert.deepEqual(exported.result.scriptStructure, result.scriptStructure)
  assert.deepEqual(exported.result.scriptBreakdown, result.scriptBreakdown)
  assert.equal(exported.mediaFile, undefined)
})

test('default single and channel analyses create the fixed nine-column sheet without narrative matching', async t => {
  const calls = []
  const engine = { analyze: async args => { calls.push({ mode: args.mode, template: args.scriptTemplateId }); return resultFor(args) } }
  const { root, service } = await fixture(t, { engine })
  const item = await upload(service, 'production.mp4', { channelId })
  await service.analyze(item.id, { analysisModelId: modelId }); await service.whenIdle()
  const saved = (await service.get(item.id)).result
  assert.deepEqual(calls, [{ mode: 'both', template: 'none' }])
  assert.equal(saved.scriptStructure, undefined)
  assert.equal(saved.scriptBreakdown.schemaVersion, 2)
  assert.equal(saved.scriptBreakdown.columns.length, 9)
  assert.equal(saved.scriptBreakdown.rows[0].dialogue, originalLine)
  const restored = await freshService(root, engine)
  assert.deepEqual((await restored.get(item.id)).result.scriptBreakdown, saved.scriptBreakdown)
  await restored.analyzeAllChannelVideos(channelId, { analysisModelId: modelId }); await restored.whenIdle()
  assert.equal(calls.length, 1)
  assert.equal((await restored.getChannel(channelId)).bulkAnalysis.skipped, 1)
  for (const format of ['md', 'txt']) {
    const output = (await restored.exportItem(item.id, { format })).body
    assert.match(output, /分镜编号/)
    assert.doesNotMatch(output, /Script structure|Reusable template pattern/)
  }
})

test('script refresh revalidates quote evidence against fresh speech and discards stale narrative roles', async t => {
  let calls = 0
  const replacement = 'This is a different opening sentence.'
  const engine = { analyze: async args => {
    const result = resultFor({ ...args, line: calls++ ? replacement : originalLine })
    if (args.mode === 'script') {
      // A provider returned the former classification with its former quote.
      // Retained visual shots cannot make that absent speech quotation valid.
      result.scriptStructure = resultFor().scriptStructure
    }
    return result
  } }
  const { root, service } = await fixture(t, { engine })
  const item = await upload(service)
  await service.analyze(item.id, { scriptTemplateId: 'xc-1' }); await service.whenIdle()
  const before = (await service.get(item.id)).result
  assert.equal(before.scriptStructure.stages.length, 1)
  await service.analyze(item.id, { mode: 'script', scriptTemplateId: 'xc-1' }); await service.whenIdle()
  const after = (await service.get(item.id)).result
  assert.equal(after.script.text, replacement)
  assert.equal(after.shots[0].visual, before.shots[0].visual)
  assert.deepEqual(after.scriptStructure.stages, [])
  assert.equal(after.scriptStructure.status, 'unclassified')
  assert.equal(after.scriptStructure.summary, '')
  assert.ok(after.scriptStructure.limitations.some(value => /discarded/.test(value)))
  assert.equal(after.scriptBreakdown.rows[0].dialogue, replacement)
  assert.deepEqual(after.scriptBreakdown.rows.flatMap(value => value.stageIds), [])
  const restored = await freshService(root)
  assert.deepEqual((await restored.get(item.id)).result.scriptStructure.stages, [])
  for (const format of ['txt', 'md']) {
    const exported = await restored.exportItem(item.id, { format })
    assert.ok(exported.body.includes(replacement))
    assert.equal(exported.body.includes(originalLine), false)
    assert.equal(exported.body.includes('An immediate invitation opens the demonstration.'), false)
  }
})
