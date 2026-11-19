import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const bundled = await build({
  entryPoints: [fileURLToPath(new URL('../src/inverseVideoApi.ts', import.meta.url))],
  bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2020',
})
const api = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'))
const uiBundle = await build({
  stdin: { contents: "export { AnalysisModelSelector, AnalysisWorkflowSelector, ReaVideoPanel, ReferenceReconstruction, MissingShotAnalysis, SavedAnalysisProvenance, ScriptTemplateSelector, ScriptBreakdownPanel, ScriptAnalysisActions } from './src/InversePrompting.tsx'; export { renderToStaticMarkup } from 'react-dom/server.browser'", resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2020', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' },
})
const ui = await import('data:text/javascript;base64,' + Buffer.from(uiBundle.outputFiles[0].text).toString('base64'))

const poeModel = { id: 'poe-gemini-3.7-flash', label: 'Gemini 3.7 Flash · Poe', provider: 'poe', model: 'Gemini-3.7-Flash', available: true, inputMode: 'video_and_audio' }
const qwenModel = { id: 'siliconflow-qwen3-omni-thinking', label: 'Qwen3 Omni Thinking · SiliconFlow', provider: 'siliconflow', model: 'Qwen/Qwen3-Omni-30B-A3B-Thinking', available: true, inputMode: 'video_and_audio' }
const standardWorkflow = { id: 'standard', label: 'Standard breakdown', available: true, usesModel: true, modes: ['both', 'breakdown', 'script', 'audio'] }
const reaWorkflow = { id: 'rea-video', label: 'Rea-video', available: true, usesModel: false, revision: 'rea-test-1', modes: ['both', 'breakdown'] }
const reaResult = {
  schemaVersion: 1, analysisWorkflowId: 'rea-video', mode: 'both',
  reaVideo: { schemaVersion: 1, verdict: 'needs_review', vlmStatus: 'not_requested', reviewStatus: 'unreviewed', technicalShots: [{ index: 0, startSeconds: 0, endSeconds: 5, label: 'Static camera candidate', confidence: 0.72, evidence: ['Median optical flow is low.', '<script>measurement</script>'] }], limitations: ['Camera classification does not establish what the objects are doing.'], workflowRevision: 'rea-test-1' },
  provenance: { workflow: { id: 'rea-video', label: 'Rea-video', revision: 'rea-test-1', status: 'analyzed' } },
}
const scriptSource = { id: 'xc-one', filename: 'XC.xlsx', displayName: 'XC production structure', sheet: 'Sheet1', headerRange: 'A1:K3' }
const scriptTemplate = { id: 'xc-one', label: 'XC · question and proof', description: 'Open a question, demonstrate the proof, then resolve it.', format: 'production_sheet', familyId: 'xc', stages: [{ id: 'hook', label: 'Opening question', goal: 'Raise a clear question.' }, { id: 'proof', label: 'Proof', goal: 'Show evidence supporting the answer.' }], reusablePattern: 'Question → proof → resolution', sources: [scriptSource], notes: ['Weights are production guidance, not a required shot count.'] }
const structuredScriptResult = {
  schemaVersion: 1,
  script: { text: 'Can this fit?', segments: [{ startSeconds: 1, endSeconds: 2, text: 'Can this fit?' }], onScreenText: [] },
  scriptBreakdown: { schemaVersion: 1, rows: [{ index: 0, basis: 'speech', startSeconds: 1, endSeconds: 2, durationSeconds: 1, location: null, visual: null, dialogue: 'Can this fit?', camera: null, onScreenText: null, effects: null, music: null, notes: 'Speech timing only.', stageIds: ['hook'] }], limitations: ['No video shot boundaries are available.'] },
  scriptStructure: { schemaVersion: 1, templateRevision: '2026-11-16', requestedTemplateId: 'auto', templateId: 'xc-one', templateLabel: scriptTemplate.label, status: 'partial', summary: 'The opening raises a question; later proof is not supported.', stages: [{ stageId: 'hook', label: 'Opening question', startSeconds: 1, endSeconds: 2, interpretation: 'Introduces the problem the viewer wants answered.', evidence: [{ source: 'speech', index: 0, startSeconds: 1, endSeconds: 2, text: 'Can this fit?' }] }], missingStages: [{ id: 'proof', label: 'Proof' }], reusablePattern: scriptTemplate.reusablePattern, sources: [scriptSource], limitations: ['This interpretation is supported by speech only.'] },
}

test('workflow selection defaults to standard, retains valid Rea preference and works with older configuration', () => {
  const config = { capabilities: {}, analysisWorkflows: [standardWorkflow, reaWorkflow], defaultAnalysisWorkflowId: 'standard' }
  assert.equal(api.selectedAnalysisWorkflow(config).id, 'standard')
  assert.equal(api.selectedAnalysisWorkflow(config, 'rea-video').id, 'rea-video')
  assert.equal(api.selectedAnalysisWorkflow(config, 'unknown').id, 'standard')
  assert.equal(api.selectedAnalysisWorkflow({ ...config, analysisWorkflows: [standardWorkflow, { ...reaWorkflow, available: false }] }, 'rea-video').id, 'standard')
  assert.equal(api.selectedAnalysisWorkflow({ capabilities: {} }).id, 'standard')
  assert.equal(api.selectedAnalysisWorkflow(null), undefined)
})

test('local Rea availability does not inherit cloud readiness or imply semantic understanding', () => {
  const config = { capabilities: { media: { ffmpeg: true, ffprobe: true } }, analysisModels: [{ ...poeModel, available: false }] }
  const ready = api.selectedWorkflowCapabilities(config, reaWorkflow, config.analysisModels[0])
  assert.equal(ready.available, true)
  assert.equal(ready.shots, true)
  assert.equal(ready.audio, true)
  for (const key of ['vision', 'speech', 'semanticAudio']) assert.equal(ready[key], false)
  assert.equal(api.selectedWorkflowCapabilities({ ...config, capabilities: { media: { ffmpeg: false, ffprobe: true } } }, reaWorkflow).available, false)
  assert.equal(api.selectedWorkflowCapabilities(config, { ...reaWorkflow, available: false, reason: 'Install the local runner.' }).reason, 'Install the local runner.')
})

test('workflow selector is distinct from models and marks unavailable options before a run', () => {
  let chosen
  const view = ui.AnalysisWorkflowSelector({ workflows: [standardWorkflow, { ...reaWorkflow, available: false }], selected: standardWorkflow, busy: false, onChange: id => { chosen = id } })
  const html = ui.renderToStaticMarkup(view)
  assert.match(html, /for="inverse-analysis-workflow">Analysis workflow/)
  assert.match(html, /value="standard" selected=""/)
  assert.match(html, /value="rea-video" disabled=""/)
  assert.match(html, /aria-describedby="inverse-analysis-workflow-description"/)
  view.props.children[1].props.onChange({ target: { value: 'rea-video' } })
  assert.equal(chosen, 'rea-video')
  const rea = ui.renderToStaticMarkup(ui.AnalysisWorkflowSelector({ workflows: [standardWorkflow, reaWorkflow], selected: reaWorkflow, busy: false, onChange() {} }))
  assert.match(rea, /does not interpret the story or joke/)
})

test('individual and bulk Rea requests use local workflow without a cloud model or narrative template', async () => {
  const previous = globalThis.fetch, calls = []
  globalThis.fetch = async (_url, options) => { calls.push(JSON.parse(options.body)); return new Response(JSON.stringify({ item: { id: 'saved' }, channel: { id: 'creator' } }), { status: 202 }) }
  try {
    await api.analyzeReferenceVideo('saved', 'both', poeModel.id, 'auto', 'rea-video')
    await api.analyzeAllChannelVideos('creator', qwenModel.id, 'auto', 'rea-video')
    await api.analyzeReferenceVideo('saved', 'both', poeModel.id, 'auto', 'standard')
    assert.deepEqual(calls, [
      { mode: 'both', scriptTemplateId: 'none', analysisWorkflowId: 'rea-video' },
      { scriptTemplateId: 'none', analysisWorkflowId: 'rea-video' },
      { mode: 'both', analysisModelId: poeModel.id, scriptTemplateId: 'auto', analysisWorkflowId: 'standard' },
    ])
  } finally { globalThis.fetch = previous }
})

test('Rea actions run a technical breakdown without offering unsupported transcript or audio modes', () => {
  const calls = []
  const view = ui.ScriptAnalysisActions({ disabled: false, running: false, starting: false, mode: 'audio', workflow: reaWorkflow, onModeChange() {}, onAnalyze: (...args) => calls.push(args) })
  const html = ui.renderToStaticMarkup(view)
  assert.match(html, />Rea-video breakdown<\/button>/)
  assert.match(html, /measured details; meaning, dialogue and uncertain visual details remain unfilled/)
  assert.doesNotMatch(html, /Other analysis modes|Transcript &amp; visible text only|Audio only/)
  view.props.children[0].props.onClick()
  assert.deepEqual(calls, [['both', 'script']])
  const model = ui.renderToStaticMarkup(ui.AnalysisModelSelector({ models: [poeModel], selected: poeModel, busy: true, onChange() {} }))
  assert.match(model, /select id="inverse-analysis-model"[^>]*disabled=""/)
})

test('saved workflow provenance uses the actual result and treats historical results as standard', () => {
  const historical = { schemaVersion: 1, provenance: { multimodal: { provider: 'poe', model: poeModel.model } } }
  const original = structuredClone(historical)
  assert.equal(api.savedAnalysisWorkflow(historical).id, 'standard')
  const old = ui.renderToStaticMarkup(ui.SavedAnalysisProvenance({ result: historical, nextWorkflow: reaWorkflow, nextModel: poeModel }))
  assert.match(old, /Workflow · Standard breakdown/)
  assert.match(old, /Run a new breakdown to use Rea-video/)
  assert.doesNotMatch(old, /Saved analysis · Rea-video/)
  const saved = ui.renderToStaticMarkup(ui.SavedAnalysisProvenance({ result: reaResult, nextWorkflow: standardWorkflow, nextModel: poeModel }))
  assert.match(saved, /Saved analysis · Rea-video · local technical tools/)
  assert.match(saved, /Workflow · Rea-video · rea-test/)
  assert.doesNotMatch(saved, /Gemini|Poe|different model/)
  assert.deepEqual(historical, original)
})

test('Rea report keeps confidence, uncertain evidence, review status and seekable times without invented meaning', () => {
  const times = []
  const view = ui.ReaVideoPanel({ result: reaResult, onSeek: value => times.push(value) })
  const html = ui.renderToStaticMarkup(view)
  assert.match(html, /Rea-video technical breakdown/)
  assert.match(html, /Unreviewed/)
  assert.match(html, /Verdict: needs review/)
  assert.match(html, /Semantic video interpretation was not run/)
  assert.match(html, /Static camera candidate/)
  assert.match(html, /72% heuristic score/)
  assert.match(html, /Uncertainties and limitations/)
  assert.match(html, /&lt;script&gt;measurement&lt;\/script&gt;/)
  assert.doesNotMatch(html, /<script>|pawn|king|promot/i)
  const find = value => {
    if (!value || typeof value !== 'object') return undefined
    if (value.type === 'button') return value
    for (const child of [value.props?.children].flat(Infinity)) { const found = find(child); if (found) return found }
  }
  find(view).props.onClick()
  assert.deepEqual(times, [0])
  assert.equal(ui.ReaVideoPanel({ result: historicalEmpty(), onSeek() {} }), null)
  function historicalEmpty() { return { schemaVersion: 1 } }
})

test('copied Rea results retain actual workflow, classifications and limitations alongside nine columns', () => {
  const result = { ...structuredScriptResult, ...reaResult, scriptBreakdown: structuredScriptResult.scriptBreakdown, scriptStructure: undefined }
  const text = api.analysisText({ title: 'Local reference', result }, 'script')
  assert.match(text, /Analysis workflow: Rea-video · rea-test-1/)
  assert.match(text, /Semantic video interpretation: Not run/)
  assert.match(text, /Review status: Unreviewed/)
  assert.match(text, /Classification: Static camera candidate/)
  assert.match(text, /Heuristic score: 72%/)
  assert.match(text, /Camera classification does not establish what the objects are doing/)
  assert.match(text, /分镜编号 \| 取景地 \| 画面 \| 台词 \| 镜头运用 \| 秒数 \| 花字 \| 背景特效与滤镜 \| 备注/)
  assert.doesNotMatch(text, /Gemini|Poe/)
})

test('Rea null scores stay unknown while labels are readable and UI abbreviates revision without changing exports', () => {
  const revision = '1234567890abcdef1234567890abcdef12345678'
  const result = { ...reaResult, provenance: { workflow: { ...reaResult.provenance.workflow, revision } }, reaVideo: { ...reaResult.reaVideo, workflowRevision: revision, technicalShots: [{ ...reaResult.reaVideo.technicalShots[0], label: 'uncertain_camera_motion', confidence: null }] } }
  const panel = ui.renderToStaticMarkup(ui.ReaVideoPanel({ result, onSeek() {} }))
  assert.match(panel, /uncertain camera motion/)
  assert.doesNotMatch(panel, /heuristic score|confidence|0%/)
  const provenance = ui.renderToStaticMarkup(ui.SavedAnalysisProvenance({ result }))
  assert.match(provenance, /Workflow · Rea-video · 12345678/)
  assert.doesNotMatch(provenance, /1234567890abcdef/)
  const text = api.analysisText({ title: 'Uncertain technical result', result }, 'shots')
  assert.match(text, new RegExp(`Analysis workflow: Rea-video · ${revision}`))
  assert.match(text, /Classification: uncertain camera motion/)
  assert.doesNotMatch(text, /Heuristic score|Confidence:/)
})

test('expanded Rea reports expose local images, readable estimates and gated functions without interpreting raw markup', () => {
  const result = { ...reaResult, reaVideo: { ...reaResult.reaVideo,
    sections: [{ id: 'camera', title: 'Camera_and_lighting', body: '## Camera\nStatic camera estimate.\n\n| Measure | Estimate |\n| --- | --- |\n| Motion | Low |\n\n- **Unreviewed** measurement\n- C:\\private\\report.md\n\n<script>wrong()</script>' }],
    assets: [{ id: 'storyboard', label: 'Storyboard', contentType: 'image/jpeg', bytes: 3200, dataBase64: 'NEVER_RENDER_INLINE' }],
    soundCandidates: [{ startSeconds: 2, endSeconds: 2.5, description: 'Transient · unconfirmed' }],
    capabilities: [
      { id: 'audio', label: 'Audio signal analysis', status: 'available', detail: 'Local tempo and energy estimates.' },
      { id: 'vision', label: 'Visual interpretation', status: 'requires_model', detail: 'Needs a separate vision model.' },
      { id: 'speech', label: 'Speech transcription', status: 'requires_download', detail: 'Speech model is not installed.' },
      { id: 'remake', label: 'Remake', status: 'separate_workflow', detail: 'Separate from this local analysis.' },
    ],
  } }
  const times = []
  const view = ui.ReaVideoPanel({ result, itemId: 'saved-video', durationSeconds: 5, onSeek: value => times.push(value), onSaved() {} })
  const keyedChildren = [view.props.children].flat(Infinity).filter(child => child && typeof child === 'object' && child.key !== null)
  assert.equal(new Set(keyedChildren.map(child => child.key)).size, keyedChildren.length, 'Stateful sibling components need distinct keys to prevent duplicate rows during polling.')
  assert.ok(keyedChildren.some(child => child.key === 'frames-saved-video'))
  assert.ok(keyedChildren.some(child => child.key === 'review-saved-video'))
  const html = ui.renderToStaticMarkup(view)
  assert.match(html, /Camera and lighting/)
  assert.match(html, /Local tool estimates · unreviewed/)
  assert.match(html, /<h3>Camera<\/h3>/)
  assert.match(html, /<th>Measure<\/th>/)
  assert.match(html, /<td>Low<\/td>/)
  assert.match(html, /<strong>Unreviewed<\/strong>/)
  assert.doesNotMatch(html, /href="C:|href="file:/)
  assert.match(html, /&lt;script&gt;wrong\(\)&lt;\/script&gt;/)
  assert.match(html, /src="\/api\/creator-agent\/video-analysis\/items\/saved-video\/rea-assets\?asset=storyboard"/)
  assert.match(html, /asset=storyboard&amp;download=1/)
  assert.match(html, /Inspect a moment frame by frame/)
  assert.match(html, /Generate frame preview/)
  assert.match(html, /It does not interpret the actions/)
  assert.match(html, /Signal changes can suggest a sound effect/)
  assert.match(html, /Available locally/)
  assert.match(html, /Vision model required/)
  assert.match(html, /Extra installation required/)
  assert.match(html, /Separate workflow/)
  assert.match(html, /Your review notes/)
  assert.match(html, /supplied by you/)
  assert.match(html, /maxLength="4000"/i)
  assert.doesNotMatch(html, /NEVER_RENDER_INLINE|data:image|<script>|wrong\(\)<\/script>/)
  const collect = value => {
    if (!value || typeof value !== 'object') return []
    return [value, ...[value.props?.children].flat(Infinity).flatMap(collect)]
  }
  collect(view).find(element => element.type === 'button' && element.props['aria-label']?.startsWith('Listen to sound candidate')).props.onClick()
  assert.deepEqual(times, [2])
})

test('Rea image helpers only construct scoped image URLs and frame previews reject invalid ranges before fetching', async () => {
  assert.equal(api.reaAssetUrl('saved video', 'audio-chart'), '/api/creator-agent/video-analysis/items/saved%20video/rea-assets?asset=audio-chart')
  assert.equal(api.reaAssetUrl('saved', 'storyboard', true), '/api/creator-agent/video-analysis/items/saved/rea-assets?asset=storyboard&download=1')
  assert.match(api.reaAssetUrl('saved', 'shot-001'), /asset=shot-001$/)
  for (const id of ['../secret', 'https://example.com/x', '<svg>', '', 'arbitrary-name', 'shot-1', 'shot-1000', 'a'.repeat(81)]) assert.throws(() => api.reaAssetUrl('saved', id), /Invalid Rea-video image/)
  const previous = globalThis.fetch, requests = []
  globalThis.fetch = async (url, options) => { requests.push({ url, method: options.method }); return new Response('image', { headers: { 'Content-Type': 'image/jpeg' } }) }
  try {
    for (const [start, end] of [[-1, 2], [2, 2], [3, 1], [0, 12.1], [NaN, 1], [0, Infinity]]) assert.throws(() => api.getReaFrameGrid('saved', start, end), /up to 12 seconds/)
    assert.equal(requests.length, 0)
    const blob = await api.getReaFrameGrid('saved video', 14, 22)
    assert.equal(blob.type, 'image/jpeg')
    assert.equal(requests[0].url, '/api/creator-agent/video-analysis/items/saved%20video/rea-frames?start=14&end=22')
    globalThis.fetch = async () => new Response('not an image', { headers: { 'Content-Type': 'text/html' } })
    await assert.rejects(api.getReaFrameGrid('saved', 1, 2), /did not return an image/)
  } finally { globalThis.fetch = previous }
})

test('Rea user review saves only the bounded manual fields and retains their source in copied output', async () => {
  const previous = globalThis.fetch, requests = []
  const notes = { summary: 'A rule-breaking board joke.', hook: 'Players look serious.', payoff: 'The pawn becomes a king.', characters: 'Two players and chess pieces.', corrections: 'Check the final replacement.', source: 'model', updatedAt: 'untrusted' }
  globalThis.fetch = async (url, options) => { requests.push({ url, method: options.method, body: JSON.parse(options.body) }); return new Response(JSON.stringify({ item: { id: 'saved', result: { reaVideo: { reviewNotes: { ...notes, source: 'user' } } } } })) }
  try {
    const response = await api.saveReaReviewNotes('saved video', notes)
    assert.equal(response.item.result.reaVideo.reviewNotes.source, 'user')
    assert.deepEqual(requests[0], { url: '/api/creator-agent/video-analysis/items/saved%20video/rea-review', method: 'PUT', body: { summary: notes.summary, hook: notes.hook, payoff: notes.payoff, characters: notes.characters, corrections: notes.corrections } })
    assert.throws(() => api.saveReaReviewNotes('saved', { ...notes, payoff: 'x'.repeat(4001) }), /4,000 characters/)
    assert.equal(requests.length, 1)
    const result = { ...reaResult, reaVideo: { ...reaResult.reaVideo, sections: [{ id: 'editing', title: 'Editing', body: 'One continuous take.' }], soundCandidates: [{ startSeconds: 2, endSeconds: 3, description: 'Transient' }], capabilities: [{ id: 'ocr', label: 'OCR', status: 'requires_download', detail: 'Not installed.' }], reviewNotes: { ...notes, source: 'user', updatedAt: '2026-11-16T00:00:00Z' } } }
    const text = api.analysisText({ title: 'Local reference', result }, 'shots')
    assert.match(text, /Editing\nOne continuous take/)
    assert.match(text, /unconfirmed signal estimates/)
    assert.match(text, /OCR · requires download: Not installed/)
    assert.match(text, /supplied by user, not automatic model understanding/)
    assert.match(text, /Payoff: The pawn becomes a king/)
    assert.match(text, /Review status: Unreviewed/)
    assert.doesNotMatch(text, /Review status: Reviewed/)
  } finally { globalThis.fetch = previous }
})

test('unreviewed Rea results cannot offer automatic recreation while model results retain the action', () => {
  const base = { id: 'reference', title: 'Reference', hasMedia: true }
  for (const result of [reaResult, { schemaVersion: 1, analysisWorkflowId: 'rea-video' }, { schemaVersion: 1, provenance: { workflow: { id: 'rea-video' } } }]) {
    const html = ui.renderToStaticMarkup(ui.ReferenceReconstruction({ item: { ...base, result }, onOpenOutput() { assert.fail('Rendering cannot start generation.') } }))
    assert.match(html, /Run a model breakdown or review the visual actions before preparing a recreation/)
    assert.doesNotMatch(html, /Prepare recreation|Recreate this reference|PROMPT → VIDEO|<button/)
  }
  const standard = ui.renderToStaticMarkup(ui.ReferenceReconstruction({ item: { ...base, result: structuredScriptResult }, onOpenOutput() {} }))
  assert.match(standard, /Prepare recreation/)
})

test('script template selection retains a valid preference, respects server defaults and falls back to no narrative matching', () => {
  const config = { scriptTemplates: [scriptTemplate], defaultScriptTemplateId: 'none' }
  assert.equal(api.selectedScriptTemplateId(config, scriptTemplate.id), scriptTemplate.id)
  assert.equal(api.selectedScriptTemplateId(config, 'auto'), 'auto')
  assert.equal(api.selectedScriptTemplateId(config, 'removed-template'), 'none')
  assert.equal(api.selectedScriptTemplateId({ ...config, defaultScriptTemplateId: scriptTemplate.id }), scriptTemplate.id)
  assert.equal(api.selectedScriptTemplateId(null, 'removed-template'), 'none')
  assert.equal(api.selectedScriptTemplateId(null), 'none')
})

test('script structure selector previews stages, notes and sources before any analysis', () => {
  let chosen = ''
  const view = ui.ScriptTemplateSelector({ templates: [scriptTemplate], selectedId: scriptTemplate.id, busy: false, onChange: id => { chosen = id } })
  const html = ui.renderToStaticMarkup(view)
  assert.equal(view.type, 'details')
  assert.equal(view.props.open, undefined)
  assert.match(html, /Advanced: optional narrative matching/)
  assert.match(html, /value="none">Off · production sheet only/)
  assert.match(html, /for="inverse-script-template">Narrative pattern/)
  assert.match(html, /value="auto">Auto · find a supported match/)
  assert.match(html, /value="xc-one" selected=""/)
  assert.match(html, /Opening question/)
  assert.match(html, /Raise a clear question/)
  assert.match(html, /not a required shot count/)
  assert.match(html, /XC production structure · Sheet1/)
  const find = value => {
    if (!value || typeof value !== 'object') return undefined
    if (value.type === 'select') return value
    for (const child of [value.props?.children].flat(Infinity)) { const found = find(child); if (found) return found }
  }
  find(view).props.onChange({ target: { value: 'auto' } })
  assert.equal(chosen, 'auto')
  const auto = ui.renderToStaticMarkup(ui.ScriptTemplateSelector({ templates: [scriptTemplate], selectedId: 'auto', busy: true, onChange() {} }))
  assert.match(auto, /select id="inverse-script-template" disabled=""/)
  assert.match(auto, /A video can remain unclassified/)
  assert.match(auto, /Opening question → Proof/)
})

test('script breakdown renders production columns without calling speech segments observed shots', () => {
  const html = ui.renderToStaticMarkup(ui.ScriptBreakdownPanel({ result: structuredScriptResult, onSeek() {} }))
  for (const title of ['分镜编号', '取景地', '画面', '台词', '镜头运用', '秒数', '花字', '背景特效与滤镜', '备注']) assert.ok(html.includes(`>${title}</th>`), title)
  assert.match(html, /Speech segment 1/)
  assert.doesNotMatch(html, />Shot 1</)
  assert.match(html, /1\.00s/)
  assert.match(html, /Partial structure match/)
  assert.match(html, /Introduces the problem/)
  assert.match(html, /Spoken words/)
  assert.match(html, /<q>Can this fit\?<\/q>/)
  assert.match(html, /Stages without supporting evidence: Proof/)
  assert.match(html, /Reusable structure/)
  assert.match(html, /Revision: 2026-11-16/)
  assert.match(html, /role="region" aria-label="Script breakdown production table" tabindex="0"/)
  const table = html.match(/<table\b[\s\S]*?<\/table>/)[0]
  assert.equal((table.match(/scope="col"/g) || []).length, 9)
  assert.doesNotMatch(table, />Time<|>Music<|Notes \/ stages|Opening question|Structure stages/)
  assert.match(table, /<th scope="row"><span>Speech segment 1<\/span><button/)
  assert.equal(ui.ScriptBreakdownPanel({ result: { schemaVersion: 1, script: { text: 'Legacy words.' } }, onSeek() {} }), null)
})

test('primary Script breakdown always requests fresh combined media even when transcript-only mode is selected', () => {
  const requested = []
  const view = ui.ScriptAnalysisActions({ disabled: false, running: false, starting: false, mode: 'script', onModeChange() {}, onAnalyze: (mode, resultView) => requested.push({ mode, resultView }) })
  const html = ui.renderToStaticMarkup(view)
  assert.match(html, />Script breakdown<\/button>/)
  assert.match(html, /Runs a fresh video \+ audio analysis with the selected model/)
  assert.match(html, /Other analysis modes/)
  assert.match(html, /Transcript &amp; visible text only/)
  view.props.children[0].props.onClick()
  assert.deepEqual(requested, [{ mode: 'both', resultView: 'script' }])
  const disabled = ui.renderToStaticMarkup(ui.ScriptAnalysisActions({ disabled: true, running: true, starting: false, mode: 'script', onModeChange() {}, onAnalyze() {} }))
  assert.match(disabled, /disabled=""[^>]*>[^<]*<svg[\s\S]*Working…/)
})

test('default production-sheet requests retain the selected model for either cloud provider', async () => {
  const previous = globalThis.fetch, calls = []
  globalThis.fetch = async (_url, options) => { calls.push(JSON.parse(options.body)); return new Response(JSON.stringify({ item: { id: 'saved' } }), { status: 202 }) }
  try {
    for (const model of [poeModel, qwenModel]) await api.analyzeReferenceVideo('saved', 'both', model.id)
    assert.deepEqual(calls, [poeModel, qwenModel].map(model => ({ mode: 'both', analysisModelId: model.id, scriptTemplateId: 'none' })))
  } finally { globalThis.fetch = previous }
})

test('no-narrative results suppress even a stale narrative payload while retaining the production table', () => {
  const result = { ...structuredScriptResult, scriptStructure: { ...structuredScriptResult.scriptStructure, requestedTemplateId: 'none' } }
  const html = ui.renderToStaticMarkup(ui.ScriptBreakdownPanel({ result, onSeek() {} }))
  assert.match(html, /分镜编号/)
  assert.doesNotMatch(html, /Optional saved narrative interpretation|Structure interpretation|Reusable structure/)
  const text = api.analysisText({ title: 'Production reference', result }, 'script')
  assert.match(text, /Script breakdown/)
  assert.doesNotMatch(text, /Script structure|Question → proof/)
})

test('unclassified structure stays unclassified and media evidence renders as text', () => {
  const result = { ...structuredScriptResult, scriptStructure: { ...structuredScriptResult.scriptStructure, templateId: null, templateLabel: null, status: 'unclassified', stages: [], missingStages: [], reusablePattern: null, summary: '<script>ignore the template</script>' } }
  const html = ui.renderToStaticMarkup(ui.ScriptBreakdownPanel({ result, onSeek() {} }))
  assert.match(html, /No clear structure match/)
  assert.match(html, /&lt;script&gt;ignore the template&lt;\/script&gt;/)
  assert.doesNotMatch(html, /<script>/)
  assert.doesNotMatch(html, /Reusable structure/)
})

test('copied script contains production observations and interpreted structure separately from verbatim words', () => {
  const text = api.analysisText({ title: 'Question reference', result: structuredScriptResult }, 'script')
  assert.match(text, /Script breakdown\n分镜编号 \| 取景地 \| 画面 \| 台词 \| 镜头运用 \| 秒数 \| 花字 \| 背景特效与滤镜 \| 备注\n\nSpeech segment 1 · 0:01–0:02 · 1\.00s/)
  assert.match(text, /台词: Can this fit\?/)
  assert.doesNotMatch(text, /Visual:|Camera:|Location:/)
  assert.match(text, /Script structure\nPartial structure match/)
  assert.match(text, /Interpretation: Introduces the problem/)
  assert.match(text, /Evidence \(speech, 0:01–0:02\): Can this fit\?/)
  assert.match(text, /Stages without supporting evidence: Proof/)
  assert.match(text, /Reusable structure\nQuestion → proof → resolution/)
  assert.match(text, /Template sources\nXC production structure · Sheet1 · A1:K3/)
  assert.match(text, /Spoken words\n\[0:01–0:02\] Can this fit\?/)
})

test('individual and bulk analyses snapshot the chosen script template ID in their request bodies', async () => {
  const previous = globalThis.fetch
  const calls = []
  globalThis.fetch = async (_url, options) => { calls.push(JSON.parse(options.body)); return new Response(JSON.stringify({ item: { id: 'saved' }, channel: { id: 'creator' } }), { status: 202 }) }
  try {
    await api.analyzeReferenceVideo('saved', 'script', poeModel.id, scriptTemplate.id)
    await api.analyzeAllChannelVideos('creator', qwenModel.id, scriptTemplate.id)
    assert.deepEqual(calls, [{ mode: 'script', analysisModelId: poeModel.id, scriptTemplateId: 'xc-one' }, { analysisModelId: qwenModel.id, scriptTemplateId: 'xc-one' }])
  } finally { globalThis.fetch = previous }
})

test('analysis model selection honors server defaults, keeps a valid preference and rejects unavailable or removed preferences', () => {
  const config = { capabilities: {}, analysisModels: [qwenModel, poeModel], defaultAnalysisModelId: poeModel.id }
  assert.equal(api.selectedAnalysisModel(config).id, poeModel.id)
  assert.equal(api.selectedAnalysisModel(config, qwenModel.id).id, qwenModel.id)
  assert.equal(api.selectedAnalysisModel(config, 'removed-model').id, poeModel.id)
  assert.equal(api.selectedAnalysisModel({ ...config, analysisModels: [{ ...qwenModel, available: false }, poeModel] }, qwenModel.id).id, poeModel.id)
  assert.equal(api.selectedAnalysisModel({ ...config, analysisModels: [qwenModel, { ...poeModel, available: false }] }).id, qwenModel.id)
  assert.equal(api.selectedAnalysisModel(null), undefined)
})

test('replacing a removed model explains the new default without overriding a valid Qwen preference', () => {
  const configuration = { capabilities: {}, analysisModels: [poeModel, qwenModel], defaultAnalysisModelId: poeModel.id }
  const previousPreference = 'poe-gemini-4-argon'
  assert.equal(api.selectedAnalysisModel(configuration, previousPreference).id, 'poe-gemini-3.7-flash')
  const notice = api.analysisModelSelectionNotice(configuration, previousPreference)
  assert.match(notice, /previously selected analysis model is no longer offered/)
  assert.match(notice, /New analyses will use Gemini 3\.7 Flash · Poe/)
  assert.match(notice, /Saved results keep their original model labels/)
  assert.equal(api.selectedAnalysisModel(configuration, qwenModel.id).id, qwenModel.id)
  assert.equal(api.analysisModelSelectionNotice(configuration, qwenModel.id), '')
  assert.equal(api.analysisModelSelectionNotice(configuration, poeModel.id), '')
  assert.equal(api.analysisModelSelectionNotice(null, previousPreference), '')
})

test('historical Argon results retain their original provenance after Flash replaces the selectable Poe model', () => {
  const result = { schemaVersion: 1, mode: 'both', script: { text: 'Saved transcript.' }, provenance: { multimodal: { provider: 'poe', model: 'Gemini-4-Argon', inputMode: 'video_and_audio', mediaTransport: 'original_video' }, vision: { provider: 'poe', model: 'Gemini-4-Argon', status: 'analyzed' }, speech: { provider: 'poe', model: 'Gemini-4-Argon', status: 'analyzed' } } }
  const original = structuredClone(result)
  assert.equal(api.analysisModelMatchesResult(poeModel, result), false)
  assert.equal(api.savedAnalysisPresentation(result).headline, 'Poe · Gemini-4-Argon')
  const html = ui.renderToStaticMarkup(ui.SavedAnalysisProvenance({ result, nextModel: poeModel }))
  assert.match(html, /Saved analysis · Poe · Gemini-4-Argon/)
  assert.match(html, /create a result with Gemini 3\.7 Flash · Poe/)
  const copied = api.analysisText({ title: 'Historical reference', result }, 'script')
  assert.match(copied, /Analysis model: poe · Gemini-4-Argon/)
  assert.doesNotMatch(copied, /Gemini-3\.7-Flash/)
  assert.deepEqual(result, original)
})

test('model dropdown labels the selection and makes unavailable providers unselectable', () => {
  let chosen = ''
  const unavailable = { ...qwenModel, available: false, reason: 'No SiliconFlow key configured.' }
  const view = ui.AnalysisModelSelector({ models: [poeModel, unavailable], selected: poeModel, busy: false, onChange: id => { chosen = id } })
  const html = ui.renderToStaticMarkup(view)
  assert.match(html, /for="inverse-analysis-model">Analysis model/)
  assert.match(html, /selected="">Gemini 3.7 Flash/)
  assert.match(html, /value="siliconflow-qwen3-omni-thinking" disabled=""/)
  assert.match(html, /aria-describedby="inverse-analysis-model-description"/)
  view.props.children[1].props.onChange({ target: { value: poeModel.id } })
  assert.equal(chosen, poeModel.id)
})

test('unavailable default or saved model remains visible with its failure reason when a usable model is selected', () => {
  const unavailablePoe = { ...poeModel, available: false, reason: 'This bot does not support API access.' }
  const configuration = { capabilities: {}, analysisModels: [unavailablePoe, qwenModel], defaultAnalysisModelId: poeModel.id }
  const selected = api.selectedAnalysisModel(configuration)
  const notice = api.analysisModelSelectionNotice(configuration)
  assert.equal(selected.id, qwenModel.id)
  assert.match(notice, /Gemini 3.7 Flash.*unavailable/)
  assert.match(notice, /This bot does not support API access/)
  assert.match(notice, /New analyses will use Qwen3 Omni Thinking/)
  assert.equal(api.analysisModelSelectionNotice(configuration, poeModel.id), notice)
  assert.equal(api.analysisModelSelectionNotice(configuration, qwenModel.id), notice)
  const html = ui.renderToStaticMarkup(ui.AnalysisModelSelector({ models: configuration.analysisModels, selected, busy: false, notice, onChange() { assert.fail('No analysis or model change should start automatically.') } }))
  assert.match(html, /value="poe-gemini-3.7-flash" disabled=""/)
  assert.match(html, /role="status">Gemini 3.7 Flash/)
  assert.match(html, /This bot does not support API access/)
  assert.match(html, /aria-describedby="inverse-analysis-model-description inverse-analysis-model-notice"/)
})

test('an unavailable Poe option stays explained when Qwen is both the host default and saved preference', () => {
  const configuration = {
    capabilities: { provider: 'siliconflow' }, defaultAnalysisModelId: qwenModel.id,
    analysisModels: [qwenModel, { ...poeModel, available: false, reason: 'This bot does not support API access.' }],
  }
  const selected = api.selectedAnalysisModel(configuration, qwenModel.id)
  const notice = api.analysisModelSelectionNotice(configuration, qwenModel.id)
  assert.equal(selected.id, qwenModel.id)
  assert.match(notice, /Gemini 3.7 Flash.*unavailable/)
  assert.match(notice, /This bot does not support API access/)
  assert.match(notice, /New analyses will use Qwen3 Omni Thinking/)
  const html = ui.renderToStaticMarkup(ui.AnalysisModelSelector({ models: configuration.analysisModels, selected, notice, busy: false, onChange() { assert.fail('Rendering must not select or run a model.') } }))
  assert.match(html, /role="status">Gemini 3.7 Flash/)
  assert.match(html, /value="poe-gemini-3.7-flash" disabled=""/)
  assert.equal(api.analysisModelSelectionNotice({ ...configuration, analysisModels: [qwenModel, poeModel] }, qwenModel.id), '')
})

test('selected Qwen readiness replaces unavailable default Poe flags and still requires real local media tools', () => {
  const configuration = {
    analysisModels: [{ ...poeModel, available: false, reason: 'This bot does not support API access.' }, qwenModel], defaultAnalysisModelId: poeModel.id,
    capabilities: { provider: 'poe', available: false, breakdownAvailable: false, media: { ffmpeg: true, ffprobe: true }, vision: { available: false }, speech: { available: false }, audio: { available: false, semanticAvailable: false } },
  }
  const selected = api.selectedAnalysisModel(configuration)
  assert.equal(selected.id, qwenModel.id)
  assert.deepEqual(api.selectedAnalysisCapabilities(configuration, selected), { available: true, shots: true, vision: true, speech: true, audio: true, semanticAudio: true, reason: '' })
  for (const missing of ['ffmpeg', 'ffprobe']) {
    const missingTools = { ...configuration, capabilities: { ...configuration.capabilities, media: { ...configuration.capabilities.media, [missing]: false } } }
    const readiness = api.selectedAnalysisCapabilities(missingTools, selected)
    assert.equal(readiness.available, false)
    for (const feature of ['shots', 'vision', 'speech', 'audio', 'semanticAudio']) assert.equal(readiness[feature], false)
    assert.match(readiness.reason, /FFmpeg and FFprobe/)
    assert.equal(api.shotAnalysisPresentation({ status: 'partial', hasMedia: true, result: { shots: [] } }, missingTools, selected.id).canRun, false)
  }
  const blocked = api.selectedAnalysisCapabilities(configuration, configuration.analysisModels[0])
  assert.equal(blocked.available, false)
  assert.match(blocked.reason, /does not support API access/)
})

test('local readiness retains discovered speech and vision limits instead of inheriting cloud support', () => {
  const local = { id: 'local', label: 'Local tools', provider: 'local', model: '', available: true, inputMode: 'local_media' }
  const configuration = { capabilities: { provider: 'local', available: true, breakdownAvailable: true, media: { ffmpeg: true, ffprobe: true }, vision: { available: false }, speech: { available: true }, audio: { available: true, semanticAvailable: false } } }
  assert.deepEqual(api.selectedAnalysisCapabilities(configuration, local), { available: true, shots: true, vision: false, speech: true, audio: true, semanticAudio: false, reason: '' })
  const statusFromCloud = { capabilities: { ...configuration.capabilities, provider: 'poe', vision: { available: true }, speech: { available: true }, audio: { available: true, semanticAvailable: true } } }
  const localReadiness = api.selectedAnalysisCapabilities(statusFromCloud, local)
  assert.equal(localReadiness.audio, true)
  assert.equal(localReadiness.vision, false)
  assert.equal(localReadiness.speech, false)
  assert.equal(localReadiness.semanticAudio, false)
})

test('saved provider matching distinguishes model switches and historical frame analysis, while accepting same-model audio-only results', () => {
  const result = { mode: 'both', provenance: { multimodal: { provider: 'poe', model: 'Gemini-3.7-Flash', inputMode: 'video_and_audio', mediaTransport: 'original_video' } } }
  assert.equal(api.analysisModelMatchesResult(poeModel, result), true)
  assert.equal(api.analysisModelMatchesResult(qwenModel, result), false)
  assert.equal(api.analysisModelMatchesResult(poeModel, { ...result, provenance: { multimodal: { ...result.provenance.multimodal, mediaTransport: 'extracted_frames' } } }), false)
  assert.equal(api.analysisModelMatchesResult(poeModel, { mode: 'audio', provenance: { multimodal: { provider: 'poe', model: 'Gemini-3.7-Flash', inputMode: 'audio', mediaTransport: 'extracted_audio' } } }), true)
  assert.equal(api.analysisProviderLabel('poe'), 'Poe')
  assert.equal(api.analysisProviderLabel('siliconflow'), 'SiliconFlow')
})

test('local audio refresh labels retained cloud visuals and actual speech and sound models as mixed provenance', () => {
  const local = { id: 'local', label: 'Local video and audio tools', provider: 'local', model: '', available: true, inputMode: 'local_media' }
  const result = { mode: 'audio', provenance: {
    vision: { provider: 'siliconflow', model: qwenModel.model, method: 'multimodal_video_understanding', status: 'analyzed' },
    speech: { model: 'ggml-large-v3.bin', method: 'whisper.cpp', status: 'analyzed' },
    soundEvents: { model: 'Google YAMNet / AudioSet 521 classes', method: 'yamnet_waveform_classification', status: 'analyzed' },
    audio: { method: 'ffmpeg_rms_energy_onsets', status: 'analyzed' },
    components: { multimodal: { detail: { provider: 'siliconflow', model: qwenModel.model } } },
  } }
  const saved = api.savedAnalysisPresentation(result)
  assert.equal(saved.headline, 'Mixed providers and models')
  assert.deepEqual(saved.components.map(component => component.label), ['Visuals', 'Speech', 'Sound labels'])
  const html = ui.renderToStaticMarkup(ui.SavedAnalysisProvenance({ result, nextModel: local }))
  assert.match(html, /Saved analysis · Mixed providers and models/)
  assert.match(html, /Visuals<\/dt><dd>SiliconFlow · Qwen\/Qwen3-Omni/)
  assert.match(html, /Speech<\/dt><dd>Local analysis · ggml-large-v3\.bin/)
  assert.match(html, /Sound labels<\/dt><dd>Local analysis · Google YAMNet/)
  assert.match(html, /Analyze again to create a result with Local video and audio tools/)
  assert.doesNotMatch(html, /Saved analysis · Local analysis|ffmpeg|Complete video \+ audio/)
  assert.equal(api.analysisModelMatchesResult(local, result), false)
  const copied = api.analysisText({ title: 'Mixed result', result }, 'shots')
  assert.match(copied, /Analysis model: Mixed providers and models\nVisuals: SiliconFlow/)
  assert.match(copied, /Speech: Local analysis · ggml-large-v3\.bin/)
})

test('two cloud models remain explicitly mixed after an audio-only update and a uniform result keeps its simple headline', () => {
  const instruct = 'Qwen/Qwen3-Omni-30B-A3B-Instruct'
  const cloud = model => ({ provider: 'siliconflow', model, status: 'analyzed', method: 'multimodal_audio_understanding' })
  const result = { mode: 'audio', provenance: {
    multimodal: { ...cloud(instruct), inputMode: 'audio', mediaTransport: 'audio_track' },
    vision: cloud(qwenModel.model), speech: cloud(instruct), soundEvents: cloud(instruct),
    audio: { method: 'ffmpeg_rms_energy_onsets' },
  } }
  const next = { ...qwenModel, id: 'siliconflow-qwen3-omni-instruct', label: 'Qwen3 Omni Instruct · SiliconFlow', model: instruct }
  assert.equal(api.savedAnalysisPresentation(result).headline, 'Mixed models')
  assert.equal(api.analysisModelMatchesResult(next, result), false)
  const html = ui.renderToStaticMarkup(ui.SavedAnalysisProvenance({ result, nextModel: next }))
  assert.match(html, /Saved analysis · Mixed models/)
  assert.match(html, /Visuals<\/dt><dd>SiliconFlow · Qwen\/Qwen3-Omni-30B-A3B-Thinking/)
  assert.match(html, /Speech<\/dt><dd>SiliconFlow · Qwen\/Qwen3-Omni-30B-A3B-Instruct/)
  assert.match(html, /Analyze again to create a result with Qwen3 Omni Instruct/)
  const uniform = { mode: 'both', provenance: { multimodal: { ...cloud(qwenModel.model), inputMode: 'video_and_audio', mediaTransport: 'original_video' }, vision: cloud(qwenModel.model), speech: cloud(qwenModel.model), soundEvents: cloud(qwenModel.model), audio: { method: 'ffmpeg_rms_energy_onsets' } } }
  const uniformHtml = ui.renderToStaticMarkup(ui.SavedAnalysisProvenance({ result: uniform, nextModel: qwenModel }))
  assert.match(uniformHtml, /Saved analysis · SiliconFlow · Qwen\/Qwen3-Omni-30B-A3B-Thinking · Complete video \+ audio/)
  assert.doesNotMatch(uniformHtml, /Mixed|component models|Analyze again/)
  assert.equal(api.analysisModelMatchesResult(qwenModel, uniform), true)
})

test('selected cloud model enables shot recovery even when the local default has no visual model', () => {
  const item = { status: 'partial', hasMedia: true, result: { shots: [], mode: 'audio' } }
  const configuration = { capabilities: { breakdownAvailable: false, vision: { available: false } }, analysisModels: [poeModel] }
  assert.equal(api.shotAnalysisPresentation(item, configuration).canRun, false)
  assert.equal(api.shotAnalysisPresentation(item, configuration, poeModel.id).canRun, true)
})

test('individual shot retries and bulk channel analyses send the exact selected model ID', async () => {
  const previous = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) })
    return new Response(JSON.stringify({ item: { id: 'saved', status: 'queued' }, channel: { id: 'creator' } }), { status: 202 })
  }
  try {
    await api.analyzeReferenceVideo('saved', 'breakdown', poeModel.id)
    await api.analyzeAllChannelVideos('creator', qwenModel.id)
    assert.deepEqual(calls, [
      { url: '/api/creator-agent/video-analysis/items/saved/analyze', body: { mode: 'breakdown', analysisModelId: poeModel.id, scriptTemplateId: 'none' } },
      { url: '/api/creator-agent/video-analysis/channels/creator/analyze-all', body: { analysisModelId: qwenModel.id, scriptTemplateId: 'none' } },
    ])
  } finally { globalThis.fetch = previous }
})

test('failed visual analysis explains the real failure, retains audio and offers a working shot retry', () => {
  const item = { status: 'partial', hasMedia: true, result: { mode: 'both', shots: [], script: { text: 'Saved speech' }, audio: { description: 'Saved music' }, provenance: { vision: { status: 'failed', error: 'Video frames could not be prepared. Please retry shot analysis.' } } } }
  let retried = false
  const view = ui.MissingShotAnalysis({ item, configuration: { capabilities: { breakdownAvailable: true, vision: { available: true } } }, busy: false, onRetry: () => { retried = true } })
  const html = ui.renderToStaticMarkup(view)
  assert.match(html, /Shot analysis could not finish/)
  assert.match(html, /Video frames could not be prepared/)
  assert.match(html, /Your saved script and audio remain available/)
  assert.match(html, /Retry shot analysis/)
  assert.doesNotMatch(html, /disabled|when video analysis is available|Read the analysis notes/)
  const retry = view.props.children.find(child => child?.type === 'button')
  retry.props.onClick()
  assert.equal(retried, true)
  assert.equal(item.result.script.text, 'Saved speech')
  assert.equal(item.result.audio.description, 'Saved music')
})

test('audio-only results request shots explicitly and never imply that visual analysis failed', () => {
  const item = { status: 'complete', hasMedia: true, result: { mode: 'audio', shots: [], provenance: { vision: { status: 'not_requested' } } } }
  const html = ui.renderToStaticMarkup(ui.MissingShotAnalysis({ item, configuration: null, busy: false, onRetry() {} }))
  assert.match(html, /Shot analysis was not requested/)
  assert.match(html, /Analyze shots/)
  assert.doesNotMatch(html, /could not finish|Retry shot analysis|disabled/)
  assert.equal(api.shotAnalysisPresentation({ ...item, result: { mode: 'script', shots: [] } }).actionLabel, 'Analyze shots')
})

test('queued shot retries retain saved results and prevent a duplicate retry', () => {
  const old = { id: 'one', status: 'partial', updatedAt: '2026-11-12T00:00:00Z', createdAt: '2026-11-12T00:00:00Z', result: { mode: 'both', script: { text: 'Keep this transcript' }, audio: { description: 'Keep these audio notes' }, shots: [] } }
  const queued = api.mergeVideoAnalyses([old], [{ ...old, status: 'queued', updatedAt: '2026-11-12T00:00:01Z', result: undefined }])[0]
  assert.equal(queued.result.script.text, 'Keep this transcript')
  assert.equal(queued.result.audio.description, 'Keep these audio notes')
  const html = ui.renderToStaticMarkup(ui.MissingShotAnalysis({ item: queued, configuration: null, busy: false, onRetry() {} }))
  assert.match(html, /Analysis is running/)
  assert.match(html, /disabled/)
  assert.doesNotMatch(html, /could not finish/)
})

test('failure intervals and meaningful notes remain visible without a blank notes heading', () => {
  const result = { warnings: ['', '   ', 'Visual analysis failed for 2 intervals.', 'Visual analysis failed for 2 intervals.'], provenance: { vision: { status: 'failed', failures: [{ startSeconds: 0, endSeconds: 15, reason: 'Frame extraction timed out.' }, { startSeconds: 15, endSeconds: 26.7, reason: 'Frame extraction timed out.' }] } } }
  const notes = api.videoAnalysisNotes(result)
  assert.deepEqual(notes, ['Visual analysis failed for 2 intervals.', 'Shot analysis 0:00–0:15: Frame extraction timed out.', 'Shot analysis 0:15–0:26.7: Frame extraction timed out.'])
  assert.equal(api.shotAnalysisPresentation({ status: 'partial', result }).reason, 'Frame extraction timed out.')
  assert.match(api.analysisText({ title: 'Reference', result }, 'shots'), /Analysis notes\nVisual analysis failed for 2 intervals\.\nShot analysis 0:00–0:15: Frame extraction timed out\./)
  assert.doesNotMatch(api.analysisText({ title: 'Reference', result: { warnings: ['', '  '] } }, 'script'), /Analysis notes/)
  const unavailable = api.shotAnalysisPresentation({ status: 'partial', hasMedia: true, result }, { capabilities: { vision: { available: false } } })
  assert.equal(unavailable.canRun, false)
  assert.match(unavailable.unavailableReason, /currently unavailable/)
})

test('shot-only retry sends the breakdown mode without asking to replace speech', async () => {
  const previous = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/creator-agent/video-analysis/items/saved/analyze')
    assert.equal(options.method, 'POST')
    assert.deepEqual(JSON.parse(options.body), { mode: 'breakdown', scriptTemplateId: 'none' })
    return new Response(JSON.stringify({ item: { id: 'saved', status: 'queued' } }), { status: 202 })
  }
  try { assert.equal((await api.analyzeReferenceVideo('saved', 'breakdown')).item.status, 'queued') }
  finally { globalThis.fetch = previous }
})

test('legacy visual failures take priority over generic frame-sampling warnings in the recovery reason', () => {
  const sampling = 'Cloud observations use sparse 2 fps frames. Shot sections may miss fast movements.'
  const failure = 'Interval 1 needs review: visual verification failed because video frames could not be prepared.'
  const item = { status: 'partial', hasMedia: true, result: { mode: 'both', shots: [], warnings: [sampling, failure] } }
  assert.equal(api.shotAnalysisPresentation(item).reason, failure)
  const html = ui.renderToStaticMarkup(ui.MissingShotAnalysis({ item, configuration: null, busy: false, onRetry() {} }))
  assert.match(html, /visual verification failed because video frames could not be prepared/)
  assert.doesNotMatch(html, /sparse 2 fps/)
  assert.deepEqual(api.videoAnalysisNotes(item.result), [sampling, failure])
  assert.equal(api.shotAnalysisPresentation({ ...item, result: { ...item.result, provenance: { vision: { error: 'A newer specific preparation error.' } } } }).reason, 'A newer specific preparation error.')
})

test('analysis input labels distinguish complete video transport from historical frames and interval video', () => {
  const direct = { provider: 'siliconflow', model: 'Qwen/Qwen3-Omni-30B-A3B-Instruct', inputMode: 'video_and_audio', mediaTransport: 'original_video' }
  assert.equal(api.videoAnalysisInputLabel(direct), 'Complete video + audio')
  assert.equal(api.videoAnalysisInputLabel({ inputMode: 'video', mediaTransport: 'original_video' }), 'Complete video')
  assert.equal(api.videoAnalysisInputLabel({ inputMode: 'frames_and_audio' }), 'Extracted frames + audio')
  assert.equal(api.videoAnalysisInputLabel({ inputMode: 'video_and_audio' }), 'Video + audio')
  assert.equal(api.videoAnalysisInputLabel({ ...direct, inputMode: 'audio' }), 'Audio only')
  assert.equal(api.videoAnalysisInputLabel(undefined), '')
  const copied = api.analysisText({ title: 'Direct video', result: { provenance: { multimodal: direct }, shots: [] } }, 'shots')
  assert.match(copied, /Analysis input: Complete video \+ audio/)
  assert.doesNotMatch(copied, /Extracted frames|2 fps|visual verification/)
})

test('summary polls retain opened results and stale detail responses cannot rewind progress', () => {
  const result = { schemaVersion: 1, shots: [], script: { text: 'Real transcript' } }
  const complete = { id: 'one', title: 'Reference', createdAt: '2026-11-12T00:00:00Z', updatedAt: '2026-11-12T00:02:00Z', status: 'complete', result }
  const summary = { ...complete, hasResult: true }
  delete summary.result
  const merged = api.mergeVideoAnalyses([complete], [summary])
  assert.equal(merged[0].result, result)
  assert.equal(api.mergeVideoAnalyses(merged, [{ ...summary, updatedAt: '2026-11-12T00:01:00Z', status: 'analyzing' }])[0].status, 'complete')
  assert.equal(api.mergeVideoAnalyses(merged, [{ ...summary, updatedAt: '2026-11-12T00:03:00Z', status: 'queued' }])[0].status, 'queued')
})

test('copied script keeps spoken words separate from visible text and retains real timestamps', () => {
  const text = api.analysisText({ title: 'Reference', result: {
    script: {
      segments: [{ startSeconds: 1.25, endSeconds: 3.5, text: 'Here is the room.' }],
      onScreenText: [{ startSeconds: 0, endSeconds: 4, text: 'Summer stay' }],
    },
    warnings: ['Machine transcript: verify names.'],
  } }, 'script')
  assert.match(text, /Spoken words\n\[0:01\.2–0:03\.5\] Here is the room\./)
  assert.match(text, /On-screen text\n\[0:00–0:04\] Summer stay/)
  assert.match(text, /Analysis notes\nMachine transcript: verify names\./)
  assert.ok(text.indexOf('Here is the room.') < text.indexOf('On-screen text'))
})

test('copied analysis retains reconstruction prompts without supplying absent speech', () => {
  const item = { title: 'Music reel', result: {
    inversePrompt: 'Three straight cuts over a continuous soundtrack.',
    shots: [{ startSeconds: 0, endSeconds: 2, visual: 'Wide view of a mountain.', reconstructionPrompt: 'Wide static mountain view.' }],
    script: { text: '', segments: [], onScreenText: [] },
  } }
  const shots = api.analysisText(item, 'shots')
  assert.match(shots, /Reconstruction prompt\nThree straight cuts/)
  assert.match(shots, /Reconstruction prompt: Wide static mountain view\./)
  assert.doesNotMatch(shots, /Spoken words:/)
  assert.match(api.analysisText(item, 'script'), /No spoken text returned\./)
})

test('copied audio timeline keeps speech, sound evidence and energy changes aligned to the original video', () => {
  const segment = { shotIndex: 0, startSeconds: 1.25, endSeconds: 3.5, status: 'analyzed', spokenText: 'Open the door.', meanDb: -23.4, peakWindowDb: -10.8, audibleFraction: 0.82, onsetTimes: [1.5, 2.75], events: [{ label: 'Door', confidence: 0.7 }] }
  const item = { title: 'Door reel', result: { audio: { description: 'Sound timing measured from the original audio.', segments: [segment], limitations: ['Energy changes are not musical beat detections.'] }, shots: [{ startSeconds: 1.25, endSeconds: 3.5, visual: 'A hand opens a door.', audioAnalysis: segment, spokenText: segment.spokenText }] } }
  const audio = api.analysisText(item, 'audio')
  assert.match(audio, /\[0:01\.2–0:03\.5\] Shot 1/)
  assert.match(audio, /Spoken words: Open the door\./)
  assert.match(audio, /Average -23 dBFS · Loudest window -11 dBFS · 82% above silence threshold/)
  assert.match(audio, /Sound label estimates: Door \(model score 70%\)/)
  assert.match(audio, /Sound changes \(estimated\): 0:01\.5, 0:02\.7/)
  assert.match(audio, /Energy changes are not musical beat detections\./)
  assert.match(api.analysisText(item, 'shots'), /Sound measurements: Average -23 dBFS/)
  assert.doesNotMatch(api.analysisText({ ...item, result: { audio: { segments: [{ ...segment, events: [] }] } } }, 'audio'), /Sound label estimates|music track|sound effect:/i)
  assert.equal(api.audioEventText({ label: 'Music', confidence: 0.996 }), 'Music (model score 99.6%)')
  assert.equal(api.audioEventText({ label: 'Rapping', confidence: 0.262 }), 'Rapping (model score 26.2%)')
  assert.equal(api.audioEventText({ label: 'Unscored', confidence: NaN }), 'Unscored')
})

test('audio timing distinguishes absent audio, silence and unavailable measurements without invented values', () => {
  assert.equal(api.audioMeasurementText({ status: 'no_audio' }), 'No audio track')
  assert.equal(api.audioMeasurementText({ status: 'failed', meanDb: -9 }), 'Sound timing unavailable')
  assert.equal(api.audioMeasurementText({ status: 'silence', meanDb: NaN }), 'Silent or very quiet')
  assert.equal(api.audioMeasurementText({ status: 'analyzed', audibleFraction: 2 }), '100% above silence threshold')
  const legacy = api.analysisText({ title: 'Older reference', result: { audio: { description: 'Older sound notes.' } } }, 'audio')
  assert.match(legacy, /Older sound notes\./)
  assert.match(legacy, /No aligned audio timeline saved/)
  assert.doesNotMatch(api.analysisText({ title: 'No shots', result: { audio: { segments: [{ startSeconds: 0, endSeconds: 1, shotIndex: null, status: 'no_audio' }] } } }, 'audio'), /Shot /)
})

test('cloud analysis copy preserves semantic audio, timed sound events and the model source', () => {
  const segment = { shotIndex: 0, startSeconds: 0, endSeconds: 3, status: 'analyzed', description: 'Soft instrumental music under a metallic click.', spokenText: 'Here it is.', events: [{ label: 'Metallic click', startSeconds: 1.2, endSeconds: 1.4 }] }
  const item = { title: 'Cloud reference', result: {
    provenance: { multimodal: { provider: 'siliconflow', model: 'Qwen/Qwen3-Omni-30B-A3B-Instruct', status: 'analyzed' } },
    audio: { description: 'Local timing evidence.', semanticDescription: 'Music continues while the tool opens.', segments: [segment] },
    shots: [{ startSeconds: 0, endSeconds: 3, visual: 'A tool opens.', audioAnalysis: segment }],
  } }
  const audio = api.analysisText(item, 'audio')
  assert.match(audio, /Analysis model: siliconflow · Qwen\/Qwen3-Omni-30B-A3B-Instruct/)
  assert.match(audio, /Music continues while the tool opens\./)
  assert.match(audio, /Soft instrumental music under a metallic click\./)
  assert.match(audio, /0:01\.2–0:01\.4: Metallic click/)
  assert.match(audio, /Spoken words: Here it is\./)
  assert.doesNotMatch(audio, /Average|model score|Local timing evidence/)
  assert.match(api.analysisText(item, 'shots'), /Sound: Soft instrumental music under a metallic click\./)
  const fallback = api.analysisText({ ...item, result: { audio: { semanticSegments: [segment] } } }, 'audio')
  assert.match(fallback, /Soft instrumental music under a metallic click\./)
  assert.doesNotMatch(fallback, /No aligned audio timeline saved/)
})

test('audio-only refresh asks the existing private analysis endpoint to preserve the saved visuals', async () => {
  const previous = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/creator-agent/video-analysis/items/saved/analyze')
    assert.equal(options.method, 'POST')
    assert.deepEqual(JSON.parse(options.body), { mode: 'audio', scriptTemplateId: 'none' })
    return new Response(JSON.stringify({ item: { id: 'saved', status: 'queued' } }), { status: 202 })
  }
  try { assert.equal((await api.analyzeReferenceVideo('saved', 'audio')).item.status, 'queued') }
  finally { globalThis.fetch = previous }
})

test('video upload sends the original bytes and an encoded filename, then returns the saved item', async () => {
  const previous = globalThis.fetch
  const file = new File([new Uint8Array([1, 2, 3])], 'room & beach.mp4', { type: 'video/mp4' })
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/creator-agent/video-analysis/uploads?filename=room%20%26%20beach.mp4')
    assert.equal(options.method, 'POST')
    assert.equal(options.headers['Content-Type'], 'video/mp4')
    assert.equal(options.body, file)
    assert.deepEqual([...new Uint8Array(await options.body.arrayBuffer())], [1, 2, 3])
    return new Response(JSON.stringify({ item: { id: 'saved', status: 'ready' } }), { status: 201 })
  }
  try { assert.equal((await api.uploadReferenceVideo(file)).item.id, 'saved') }
  finally { globalThis.fetch = previous }
})

test('media retrieval stays cancellable while its response body is being read', async () => {
  const previous = globalThis.fetch
  const cancellation = new AbortController()
  let started
  const reading = new Promise(resolve => { started = resolve })
  globalThis.fetch = async (_url, options) => ({
    ok: true,
    blob: () => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      started()
    }),
  })
  try {
    const result = api.getReferenceMedia('saved', cancellation.signal)
    await reading
    cancellation.abort()
    await assert.rejects(result, { name: 'AbortError' })
  } finally { globalThis.fetch = previous }
})

test('binary errors remain errors instead of becoming a playable or downloadable blob', async () => {
  const previous = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Video belongs to a different workspace.' }), { status: 404 })
  try { await assert.rejects(api.getReferenceMedia('private'), /Video belongs to a different workspace\./) }
  finally { globalThis.fetch = previous }
})

test('the same import action accepts public profile links and individual reel links', async () => {
  const previous = globalThis.fetch
  const received = []
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/creator-agent/video-analysis/imports')
    assert.equal(options.method, 'POST')
    received.push(JSON.parse(options.body).url)
    return new Response(JSON.stringify({ item: { id: 'imported', status: 'queued' } }), { status: 202 })
  }
  try {
    assert.equal((await api.importReferenceVideo('  https://www.instagram.com/dreamcode_films/  ')).item.status, 'queued')
    await api.importReferenceVideo('https://www.instagram.com/reel/DepDMxUAQPe/')
    assert.deepEqual(received, ['https://www.instagram.com/dreamcode_films/', 'https://www.instagram.com/reel/DepDMxUAQPe/'])
  } finally { globalThis.fetch = previous }
})

test('import links reject credentials, insecure schemes and fragments before making a request', async () => {
  const previous = globalThis.fetch
  let called = false
  globalThis.fetch = async () => { called = true; throw new Error('Unexpected request') }
  try {
    for (const url of ['javascript:alert(1)', 'http://www.instagram.com/dreamcode_films/', 'https://name:secret@example.com/reel', 'https://www.instagram.com/gdarusa/#fragment']) {
      assert.throws(() => api.importReferenceVideo(url), /public HTTPS link/)
    }
    assert.equal(called, false)
  } finally { globalThis.fetch = previous }
})

test('channel libraries isolate verified owners and keep unrelated uploads unassigned', () => {
  const dream = { id: 'instagram-dreamcode_films', handle: 'dreamcode_films' }
  const travel = { id: 'instagram-gdarusa', handle: 'gdarusa' }
  const imported = { source: { kind: 'url', channelId: dream.id, creatorHandle: 'gdarusa' } }
  assert.equal(api.videoBelongsToChannel(imported, dream), true)
  assert.equal(api.videoBelongsToChannel(imported, travel), false)
  assert.equal(api.videoBelongsToChannel(imported), false)
  const profile = { source: { kind: 'url', profileUrl: 'https://www.instagram.com/gdarusa/' } }
  assert.equal(api.videoBelongsToChannel(profile, travel), true)
  assert.equal(api.videoBelongsToChannel(profile, dream), false)
  const loose = { title: 'dreamcode_films reference', source: { kind: 'upload', filename: 'dreamcode.mp4' } }
  assert.equal(api.videoBelongsToChannel(loose), true)
  assert.equal(api.videoBelongsToChannel(loose, dream), false)
  assert.equal(api.videoBelongsToChannel({ source: { kind: 'url', creatorHandle: 'DifferentAccount' } }, dream), false)
  assert.equal(api.videoBelongsToChannel({ source: { kind: 'url', creatorHandle: 'tiktok_creator' } }, undefined, [dream, travel]), true)
  assert.equal(api.videoBelongsToChannel(profile, undefined, [dream, travel]), false)
  const tiktok = { source: { kind: 'url', url: 'https://www.tiktok.com/@gdarusa/video/1234567890', creatorHandle: 'gdarusa' } }
  assert.equal(api.videoBelongsToChannel(tiktok, undefined, [dream, travel]), true)
  assert.equal(api.videoBelongsToChannel(tiktok, travel, [dream, travel]), false)
  const known = { source: { kind: 'url', url: 'https://www.instagram.com/reel/ABC/', creatorHandle: 'gdarusa' } }
  assert.equal(api.videoBelongsToChannel(known, travel, [dream, travel]), true)
  assert.equal(api.videoBelongsToChannel(known, undefined, [dream, travel]), false)
})

test('canonical reel cards retain analyzed results and suppress duplicate failed imports', () => {
  const failed = { id: 'failed', source: { kind: 'url', url: 'https://www.instagram.com/p/ABC123/?utm_source=old' }, status: 'failed', updatedAt: '2026-11-12T00:10:00Z', createdAt: '2026-11-12T00:10:00Z' }
  const analyzed = { ...failed, id: 'analyzed', source: { kind: 'url', url: 'https://instagram.com/reel/ABC123/' }, status: 'partial', hasResult: true, updatedAt: '2026-11-12T00:02:00Z' }
  const duplicate = { ...failed, id: 'duplicate', status: 'ready' }
  assert.equal(api.uniqueChannelReferences([failed, duplicate, analyzed]).length, 1)
  assert.equal(api.uniqueChannelReferences([failed, duplicate, analyzed])[0].id, 'analyzed')
  const freshFailure = { ...failed, id: 'fresh', source: { kind: 'url', url: 'https://www.instagram.com/reel/NEW/' } }
  assert.deepEqual(api.uniqueChannelReferences([failed, analyzed, freshFailure]).map(item => item.id).sort(), ['analyzed', 'fresh'])
  const upload = { ...failed, source: { kind: 'upload' } }
  assert.equal(api.uniqueChannelReferences([{ ...upload, id: 'upload-1' }, { ...upload, id: 'upload-2' }]).length, 2)
  const failedRefresh = { ...analyzed, id: 'failed-refresh', status: 'failed', updatedAt: '2026-11-12T01:00:00Z' }
  assert.equal(api.uniqueChannelReferences([duplicate, failedRefresh])[0].id, 'failed-refresh')
})

test('channel imports and uploads preserve the selected account in the API request', async () => {
  const previous = globalThis.fetch
  const received = []
  globalThis.fetch = async (url, options) => {
    received.push([url, options.method, options.body instanceof File ? 'video' : JSON.parse(options.body)])
    return new Response(JSON.stringify({ item: { id: 'reference' } }), { status: 201 })
  }
  try {
    await api.importReferenceVideo('https://www.instagram.com/reel/ABC123/', 'instagram-gdarusa')
    await api.uploadReferenceVideo(new File(['video'], 'stay.mp4', { type: 'video/mp4' }), undefined, 'instagram-gdarusa')
    assert.deepEqual(received[0], ['/api/creator-agent/video-analysis/imports', 'POST', { url: 'https://www.instagram.com/reel/ABC123/', channelId: 'instagram-gdarusa' }])
    assert.deepEqual(received[1], ['/api/creator-agent/video-analysis/uploads?filename=stay.mp4&channelId=instagram-gdarusa', 'POST', 'video'])
  } finally { globalThis.fetch = previous }
})

test('channel settings persist through the scoped endpoint and briefs contain only that saved channel', async () => {
  const previous = globalThis.fetch
  const style = { direction: 'Amber light over mountains', format: 'Quiet opening, journey, final reveal', editing: 'Cut on the percussion', voice: '', generationMethod: 'footage_edit', generationNotes: 'Use my recorded footage' }
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/creator-agent/video-analysis/channels/instagram-gdarusa')
    assert.equal(options.method, 'PATCH')
    assert.deepEqual(JSON.parse(options.body), { style })
    return new Response(JSON.stringify({ channel: { id: 'instagram-gdarusa', handle: 'gdarusa', url: 'https://www.instagram.com/gdarusa/', style, observations: { analyzedCount: 3 } } }), { status: 200 })
  }
  try {
    const { channel } = await api.saveVideoChannelStyle('instagram-gdarusa', style)
    const brief = api.channelCreativeBrief(channel)
    assert.match(brief, /Channel brief: @gdarusa/)
    assert.match(brief, /3 analyzed references/)
    assert.match(brief, /Amber light over mountains/)
    assert.match(brief, /Recorded or licensed footage and editing/)
    assert.doesNotMatch(brief, /dreamcode|trained on your channel|Video generated/)
    assert.match(api.channelCreativeBrief({ ...channel, observations: { analyzedCount: 1 } }), /1 analyzed reference\./)
  } finally { globalThis.fetch = previous }
})

test('private channel images remain scoped to supported image endpoints', async () => {
  const previous = globalThis.fetch
  const urls = []
  globalThis.fetch = async url => { urls.push(url); return new Response('image', { headers: { 'Content-Type': 'image/jpeg' } }) }
  try {
    await api.getChannelImage('/api/creator-agent/video-analysis/channels/instagram-gdarusa/avatar?v=1')
    await api.getChannelImage('/api/creator-agent/video-analysis/channels/instagram-gdarusa/thumbnail?video=ABC123')
    await assert.rejects(api.getChannelImage('https://untrusted.example/image.jpg'), /Invalid channel image/)
    await assert.rejects(api.getChannelImage('/api/creator-agent/video-analysis/items/private/media'), /Invalid channel image/)
    assert.equal(urls.length, 2)
  } finally { globalThis.fetch = previous }
})

test('full channel discovery starts a resumable job without changing the metadata sync action', async () => {
  const previous = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, options) => {
    requests.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : undefined })
    return new Response(JSON.stringify({ channel: { id: 'instagram-gdarusa', discovery: { status: 'running' } } }), { status: 202 })
  }
  try {
    assert.equal((await api.discoverVideoChannel('instagram-gdarusa')).channel.discovery.status, 'running')
    await api.discoverVideoChannel('instagram-gdarusa', false)
    await api.syncVideoChannel('instagram-gdarusa')
    assert.deepEqual(requests, [
      { url: '/api/creator-agent/video-analysis/channels/instagram-gdarusa/discover', method: 'POST', body: { resume: true } },
      { url: '/api/creator-agent/video-analysis/channels/instagram-gdarusa/discover', method: 'POST', body: { resume: false } },
      { url: '/api/creator-agent/video-analysis/channels/instagram-gdarusa/sync', method: 'POST', body: undefined },
    ])
  } finally { globalThis.fetch = previous }
})

test('discovery labels require an explicit feed end before claiming completion', () => {
  const channel = { discoveredVideos: Array.from({ length: 6 }, (_, index) => ({ url: `https://www.instagram.com/reel/ABC${index}/` })) }
  assert.equal(api.channelDiscoveryPresentation(channel).complete, false)
  assert.match(api.channelDiscoveryPresentation(channel).message, /only a sample/)
  const blocked = api.channelDiscoveryPresentation({ ...channel, discovery: { status: 'blocked', requiresConnection: true, message: 'Connection required.' } })
  assert.equal(blocked.title, 'Instagram access needed')
  assert.equal(blocked.count, 6)
  assert.equal(blocked.complete, false)
  assert.equal(api.channelDiscoveryPresentation({ ...channel, discovery: { status: 'blocked', requiresConnection: false, message: 'Rate limit reached.' } }).title, 'Discovery paused')
  const falseComplete = api.channelDiscoveryPresentation({ ...channel, discovery: { status: 'complete' } })
  assert.equal(falseComplete.complete, false)
  assert.equal(falseComplete.title, 'Discovery is incomplete')
  assert.equal(api.channelDiscoveryPresentation({ ...channel, discovery: { status: 'complete', hasNextPage: true } }).complete, false)
  assert.equal(api.channelDiscoveryPresentation({ ...channel, discovery: { status: 'complete', hasNextPage: false } }).complete, true)
  assert.equal(api.channelDiscoveryPresentation({ ...channel, discovery: { status: 'partial', resumable: true } }).action, 'Resume discovery')
  assert.equal(api.channelDiscoveryPresentation({ ...channel, discovery: { status: 'running' } }).running, true)
})

test('Instagram credentials use a private request body and connection reads never return a token', async () => {
  const previous = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, options) => {
    requests.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : undefined })
    return new Response(JSON.stringify({ connection: { connected: options.method !== 'DELETE', method: 'meta_business_discovery', accountId: '12345' } }), { status: 200 })
  }
  try {
    const response = await api.connectInstagram(' 12345 ', ' private-token ')
    await api.getInstagramConnection()
    await api.disconnectInstagram()
    assert.deepEqual(requests, [
      { url: '/api/creator-agent/video-analysis/instagram-connection', method: 'PUT', body: { accountId: '12345', accessToken: 'private-token' } },
      { url: '/api/creator-agent/video-analysis/instagram-connection', method: 'GET', body: undefined },
      { url: '/api/creator-agent/video-analysis/instagram-connection', method: 'DELETE', body: undefined },
    ])
    assert.equal(response.connection.accessToken, undefined)
    assert.ok(requests.every(request => !request.url.includes('private-token')))
  } finally { globalThis.fetch = previous }
})

test('late channel polls cannot rewind discovery or overwrite newly saved production settings', () => {
  const saved = { id: 'instagram-gdarusa', updatedAt: '2026-11-12T00:02:00Z', style: { direction: 'Latest saved direction' }, discovery: { status: 'complete', hasNextPage: false } }
  const stale = { ...saved, updatedAt: '2026-11-12T00:01:00Z', style: { direction: '' }, discovery: { status: 'running' } }
  assert.equal(api.mergeVideoChannels([saved], [stale])[0], saved)
  const nextPage = { ...saved, updatedAt: '2026-11-12T00:03:00Z', discovery: { status: 'running' } }
  assert.equal(api.mergeVideoChannels([saved], [nextPage])[0], nextPage)
})

test('the channel entry form routes the supplied TikTok video to imports without assigning the selected Instagram channel', async () => {
  const previous = globalThis.fetch, requests = []
  globalThis.fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) })
    return new Response(JSON.stringify(url.endsWith('/channels') ? { channel: { id: 'instagram-ez_home' } } : { item: { id: 'video', source: {}, status: 'queued' } }))
  }
  try {
    const video = await api.addVideoSource('https://www.tiktok.com/@ez_home/video/7014215295795498245?lang=en')
    assert.equal(video.kind, 'video'); assert.equal(video.item.id, 'video')
    const channel = await api.addVideoSource('https://www.instagram.com/ez_home/')
    assert.equal(channel.kind, 'channel')
    assert.deepEqual(requests, [
      { url: '/api/creator-agent/video-analysis/imports', body: { url: 'https://www.tiktok.com/@ez_home/video/7014215295795498245?lang=en' } },
      { url: '/api/creator-agent/video-analysis/channels', body: { url: 'https://www.instagram.com/ez_home/' } },
    ])
    await assert.rejects(api.addVideoSource('https://user:secret@www.tiktok.com/@ez_home/video/7014215295795498245'))
    assert.equal(requests.length, 2)
  } finally { globalThis.fetch = previous }
})

test('TikTok creator profiles create channels and preserve cross-platform separation in the library', async () => {
  const previous = globalThis.fetch; let sent
  globalThis.fetch = async (url, options) => { sent = { url, body: JSON.parse(options.body) }; return new Response(JSON.stringify({ channel: { id: 'tiktok-ez_home' } })) }
  try {
    const result = await api.addVideoSource('https://www.tiktok.com/@ez_home?lang=en')
    assert.equal(result.kind, 'channel'); assert.ok(sent.url.endsWith('/channels'))
    const tiktok = { id: 'tiktok-ez_home', handle: 'ez_home', platform: 'tiktok' }, instagram = { id: 'instagram-ez_home', handle: 'ez_home', platform: 'instagram' }
    const video = { source: { url: 'https://www.tiktok.com/@ez_home/video/7014215295795498245', creatorHandle: 'ez_home' } }
    assert.equal(api.videoBelongsToChannel(video, tiktok, [tiktok, instagram]), true)
    assert.equal(api.videoBelongsToChannel(video, instagram, [tiktok, instagram]), false)
    assert.equal(api.videoBelongsToChannel(video, undefined, [tiktok, instagram]), false)
    const discovery = api.channelDiscoveryPresentation({ ...tiktok, discoveredVideos: [], discovery: { status: 'partial' } })
    assert.equal(discovery.complete, false); assert.equal(discovery.action, 'Refresh public videos'); assert.doesNotMatch(discovery.message, /Instagram connection/)
  } finally { globalThis.fetch = previous }
})

test('bulk imports and stopping are scoped to the selected channel without sending arbitrary video URLs', async () => {
  const previous=globalThis.fetch, requests=[]
  globalThis.fetch=async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return new Response(JSON.stringify({channel:{id:'tiktok-ez_home'},job:{status:'running'}}))}
  try{
    await api.importAllChannelVideos('tiktok-ez_home');await api.stopChannelImports('tiktok-ez_home')
    assert.deepEqual(requests,[{url:'/api/creator-agent/video-analysis/channels/tiktok-ez_home/import-all',body:{}},{url:'/api/creator-agent/video-analysis/channels/tiktok-ez_home/import-all/stop',body:{}}])
  }finally{globalThis.fetch=previous}
})

test('bulk analysis and stopping use the selected channel and a server-owned saved video list', async () => {
  const previous = globalThis.fetch, requests = []
  const job = { id: 'batch', channelId: 'tiktok-ez_home', status: 'running', total: 3, processed: 1, analyzed: 1, skipped: 0, failed: 0, failures: [] }
  globalThis.fetch = async (url, options) => {
    requests.push({ url, method: options.method, body: JSON.parse(options.body) })
    return new Response(JSON.stringify({ channel: { id: job.channelId, bulkAnalysis: job }, job }))
  }
  try {
    const started = await api.analyzeAllChannelVideos('tiktok-ez_home')
    assert.equal(started.channel.bulkAnalysis.analyzed, 1)
    assert.equal((await api.stopChannelAnalyses('tiktok-ez_home')).job.id, 'batch')
    assert.deepEqual(requests, [
      { url: '/api/creator-agent/video-analysis/channels/tiktok-ez_home/analyze-all', method: 'POST', body: { scriptTemplateId: 'none' } },
      { url: '/api/creator-agent/video-analysis/channels/tiktok-ez_home/analyze-all/stop', method: 'POST', body: {} },
    ])
  } finally { globalThis.fetch = previous }
})

test('channel polls retain the newer bulk analysis progress and apply its completion', () => {
  const running = { id: 'tiktok-ez_home', updatedAt: '2026-11-12T01:00:00Z', bulkAnalysis: { status: 'running', processed: 2, analyzed: 2 } }
  const stale = { ...running, updatedAt: '2026-11-12T00:59:59Z', bulkAnalysis: { status: 'running', processed: 1, analyzed: 1 } }
  const completed = { ...running, updatedAt: '2026-11-12T01:01:00Z', bulkAnalysis: { status: 'complete', processed: 3, analyzed: 3 } }
  assert.equal(api.mergeVideoChannels([running], [stale])[0].bulkAnalysis.processed, 2)
  assert.equal(api.mergeVideoChannels([running], [completed])[0].bulkAnalysis.status, 'complete')
})
