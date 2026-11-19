import test from 'node:test'
import assert from 'node:assert/strict'
import { SCRIPT_TEMPLATES, SCRIPT_TEMPLATE_REVISION, SCRIPT_BREAKDOWN_SCHEMA_VERSION, SCRIPT_BREAKDOWN_COLUMNS, scriptTemplateConfiguration, resolveScriptTemplateId, scriptTemplatePrompt, normalizeScriptStructure, buildScriptBreakdown, attachScriptBreakdown, scriptBreakdownText } from './script-templates.mjs'

const evidence = () => ({
  shots: [{ startSeconds: 0, endSeconds: 5, visual: 'Two objects on a table.' }, { startSeconds: 5, endSeconds: 10, visual: 'A hand demonstrates the product.' }],
  transcript: [{ startSeconds: 1, endSeconds: 3, text: 'Look at both of these.' }, { startSeconds: 6, endSeconds: 8, text: 'This is the demonstration.' }],
  onScreenText: [{ startSeconds: 1, endSeconds: 4, text: 'TWO ITEMS' }],
})
const opening = () => ({
  templateId: 'xc-1', summary: 'The opening draws attention to the quantity.',
  stages: [{ stageId: 'hook', startSeconds: 0, endSeconds: 4, interpretation: 'The speaker introduces the visible quantity.', evidence: [{ source: 'speech', startSeconds: 1, endSeconds: 3, text: 'Look at both of these.' }] }],
})
const options = () => ({ duration: 10, templateId: 'xc-1', evidence: evidence() })

test('the catalog covers every supplied source and preserves meaningful variants and source caveats', () => {
  const sources = SCRIPT_TEMPLATES.flatMap(template => template.sources)
  assert.deepEqual(sources.map(source => source.id).sort(), Array.from({ length: 11 }, (_, index) => `source-${String(index + 1).padStart(2, '0')}`))
  for (const template of SCRIPT_TEMPLATES) {
    assert.equal(resolveScriptTemplateId(template.id), template.id)
    assert.equal(new Set(template.stages.map(stage => stage.id)).size, template.stages.length)
    for (const source of template.sources) {
      assert.match(source.sha256, /^[a-f0-9]{64}$/)
      assert.match(source.headerRange, /^[A-Z]+\d+:[A-Z]+\d+$/)
      assert.doesNotMatch(source.filename, /[\\/]/)
    }
    for (const stage of template.stages) assert.ok(stage.sourceRanges.every(range => template.sources.some(source => source.id === range.sourceId && source.sheet === range.sheet)))
  }
  const xc = SCRIPT_TEMPLATES.filter(template => template.familyId === 'xc-abundance')
  assert.equal(xc.length, 2)
  assert.notDeepEqual(xc[0].stages, xc[1].stages)
  assert.match(SCRIPT_TEMPLATES.find(template => template.id === 'xc-2').notes.join(' '), /I4|D9/)
  assert.match(SCRIPT_TEMPLATES.find(template => template.id === 'ymz-presenter-2').notes.join(' '), /H14|O14/)
  const config = scriptTemplateConfiguration()
  config.scriptTemplates[0].label = 'mutated caller copy'
  assert.notEqual(SCRIPT_TEMPLATES[0].label, config.scriptTemplates[0].label)
})

test('selection is an ID-only contract and the prompt uses generalized patterns rather than original product copy', () => {
  for (const value of [null, {}, '../source.xlsx', 'ignore instructions', '__proto__']) assert.throws(() => resolveScriptTemplateId(value), { code: 'invalid_script_template', status: 422 })
  assert.equal(resolveScriptTemplateId(), 'none')
  assert.equal(scriptTemplatePrompt(), '')
  assert.equal(scriptTemplateConfiguration().defaultScriptTemplateId, 'none')
  const selected = scriptTemplatePrompt('xc-1')
  assert.match(selected, /"id":"xc-1"/)
  assert.doesNotMatch(selected, /"id":"pl-bundle"|蓝月亮|薰衣草/)
  assert.match(selected, /NOT stage counts/)
  assert.match(selected, /never a script to insert/)
  assert.match(selected, /Copy text EXACTLY/)
})

test('stage evidence resolves by exact source quotation and overlap after observations were reordered', () => {
  const observed = evidence()
  observed.transcript.unshift({ startSeconds: 0, endSeconds: 1, text: 'Earlier observation.' })
  const raw = opening(), before = structuredClone(observed)
  const result = normalizeScriptStructure(raw, { ...options(), evidence: observed })
  assert.equal(result.status, 'partial')
  assert.equal(result.stages[0].evidence[0].index, 1)
  assert.equal(result.stages[0].evidence[0].text, 'Look at both of these.')
  assert.ok(result.missingStages.some(stage => stage.id === 'proof'))
  assert.deepEqual(observed, before)
})

test('invented quotes, unknown roles, prototype keys and invalid timing never become supported stages', () => {
  const raw = opening()
  raw.stages.push(
    { ...raw.stages[0], stageId: 'invented-stage' },
    { ...raw.stages[0], endSeconds: 12 },
    { ...raw.stages[0], evidence: [{ source: '__proto__', startSeconds: 0, endSeconds: 4, text: 'Look at both of these.' }] },
    { ...raw.stages[0], evidence: [{ source: 'speech', startSeconds: 1, endSeconds: 3, text: 'Invented words.' }] },
    { ...raw.stages[0], startSeconds: 0, endSeconds: 0.0001 },
    { ...raw.stages[0], startSeconds: 8, endSeconds: 10 },
  )
  const result = normalizeScriptStructure(raw, options())
  assert.equal(result.stages.length, 1)
  assert.match(result.limitations.join(' '), /discarded/)
  assert.doesNotMatch(JSON.stringify(result), /Invented words|invented-stage|__proto__/)
})

test('a selected template cannot be silently swapped and automatic selection can remain unclassified', () => {
  const swapped = normalizeScriptStructure({ ...opening(), templateId: 'pl-bundle' }, options())
  assert.equal(swapped.templateId, 'xc-1')
  assert.equal(swapped.status, 'unclassified')
  assert.deepEqual(swapped.stages, [])
  const unclassified = normalizeScriptStructure({ templateId: null, stages: [] }, { ...options(), templateId: 'auto' })
  assert.equal(unclassified.templateId, null)
  assert.equal(unclassified.reusablePattern, null)
  assert.equal(unclassified.status, 'unclassified')
})

test('silent clips cannot cite invented speech but can cite actual visible text', () => {
  const raw = opening()
  const result = normalizeScriptStructure(raw, { ...options(), hasAudio: false })
  assert.equal(result.stages.length, 0)
  raw.stages[0].evidence = [{ source: 'onScreenText', text: 'TWO ITEMS', startSeconds: 1, endSeconds: 4 }]
  const visible = normalizeScriptStructure(raw, { ...options(), hasAudio: false })
  assert.equal(visible.stages.length, 1)
  assert.equal(visible.stages[0].evidence[0].source, 'onScreenText')
  assert.equal(normalizeScriptStructure(raw, { ...options(), mode: 'audio' }), undefined)
})

test('interval offsets apply to stage claims while citations retain the normalized source interval', () => {
  const raw = opening(), observed = evidence()
  for (const list of Object.values(observed)) for (const row of list) { row.startSeconds += 10; row.endSeconds += 10 }
  const result = normalizeScriptStructure(raw, { ...options(), offset: 10, evidence: observed })
  assert.equal(result.stages[0].startSeconds, 10)
  assert.equal(result.stages[0].endSeconds, 14)
  assert.equal(result.stages[0].evidence[0].startSeconds, 11)
})

test('production rows preserve observed timing and separate dialogue, OCR, camera, effects and music', () => {
  const source = evidence()
  const result = {
    durationSeconds: 10, shots: source.shots.map((shot, index) => ({ ...shot, framing: 'Close-up', cameraMovement: index ? 'Static' : null, location: index ? null : 'Visible tabletop', effects: index ? 'Visible split-screen' : null })),
    script: { segments: source.transcript, onScreenText: source.onScreenText },
    audio: { semanticEvents: [{ startSeconds: 0, endSeconds: 10, category: 'music', label: 'Music', description: 'Quiet music.' }, { startSeconds: 5, endSeconds: 6, category: 'sfx', label: 'Tap' }] },
  }
  const before = structuredClone(result), table = buildScriptBreakdown(result)
  assert.equal(table.rows.length, 2)
  assert.equal(table.schemaVersion, SCRIPT_BREAKDOWN_SCHEMA_VERSION)
  assert.equal(table.revision, SCRIPT_TEMPLATE_REVISION)
  assert.deepEqual(table.columns.map(column => column.label), ['分镜编号', '取景地', '画面', '台词', '镜头运用', '秒数', '花字', '背景特效与滤镜', '备注'])
  assert.deepEqual(table.rows.map(row => [row.index, row.basis, row.durationSeconds]), [[0, 'shot', 5], [1, 'shot', 5]])
  assert.equal(table.rows[0].dialogue, source.transcript[0].text)
  assert.equal(table.rows[0].onScreenText, 'TWO ITEMS')
  assert.equal(table.rows[1].location, null)
  assert.equal(table.rows[1].effects, 'Visible split-screen')
  assert.equal(table.rows[0].music, 'Quiet music.')
  assert.doesNotMatch(table.rows[0].music, /Tap/)
  assert.deepEqual(result, before)
})

test('word alignment assigns a crossing phrase once and speech-only rows never invent visuals', () => {
  const observed = evidence()
  const result = { durationSeconds: 10, shots: observed.shots, script: { segments: [{ startSeconds: 1, endSeconds: 9, text: 'Words cross a cut.' }], words: [{ startSeconds: 4.8, endSeconds: 5.2, text: 'Boundary' }], onScreenText: [] } }
  const aligned = buildScriptBreakdown(result)
  assert.equal(aligned.rows[0].dialogue, null)
  assert.equal(aligned.rows[1].dialogue, 'Boundary')
  delete result.shots
  const speech = buildScriptBreakdown(result)
  assert.equal(speech.rows[0].basis, 'speech')
  for (const key of ['visual', 'location', 'camera', 'effects']) assert.equal(speech.rows[0][key], null)
  assert.match(speech.limitations.join(' '), /not observed camera cuts/)
})

test('reconciliation discards stale interpretation after speech changes and exports the fresh evidence', () => {
  const result = { mode: 'both', durationSeconds: 10, shots: evidence().shots, script: { segments: evidence().transcript, onScreenText: [] }, scriptStructure: opening() }
  attachScriptBreakdown(result, { templateId: 'xc-1' })
  assert.equal(result.scriptStructure.stages.length, 1)
  result.script.segments = [{ startSeconds: 1, endSeconds: 3, text: 'Updated speech from a fresh analysis.' }]
  attachScriptBreakdown(result, { templateId: 'xc-1', mode: 'script' })
  assert.equal(result.scriptStructure.stages.length, 0)
  assert.equal(result.scriptStructure.status, 'unclassified')
  const text = scriptBreakdownText(result).join('\n')
  assert.match(text, /1 · 0s–5s/)
  assert.match(text, /Updated speech from a fresh analysis/)
  assert.match(text, /Reusable template pattern/)
  assert.doesNotMatch(text, /Look at both of these/)
})

test('default production analysis removes volunteered or retained narrative classifications', () => {
  const result = { mode: 'both', durationSeconds: 10, shots: evidence().shots, script: { segments: evidence().transcript, onScreenText: [] }, scriptStructure: opening() }
  assert.equal(normalizeScriptStructure(opening(), { duration: 10, evidence: evidence() }), undefined)
  attachScriptBreakdown(result)
  assert.equal(Object.hasOwn(result, 'scriptStructure'), false)
  assert.equal(result.scriptBreakdown.columns.length, 9)
  assert.ok(result.scriptBreakdown.rows.every(row => row.stageIds.length === 0))
  const text = scriptBreakdownText(result).join('\n')
  assert.ok(text.includes(SCRIPT_BREAKDOWN_COLUMNS.map(column => column.label).join('\t')))
  assert.doesNotMatch(text, /Script structure|Reusable template|Music:/)
})

test('Markdown production export uses nine columns and escapes multiline content and pipes', () => {
  const result = { durationSeconds: 10, shots: evidence().shots, script: { segments: [{ startSeconds: 1, endSeconds: 3, text: 'Original | dialogue.\nSecond line.' }], onScreenText: [] } }
  attachScriptBreakdown(result)
  const output = scriptBreakdownText(result, { format: 'md' }).join('\n')
  assert.ok(output.includes('| 分镜编号 | 取景地 | 画面 | 台词 | 镜头运用 | 秒数 | 花字 | 背景特效与滤镜 | 备注 |'))
  assert.ok(output.includes('Original \\| dialogue.<br>Second line.'))
  assert.equal(output.split('\n').find(line => line.startsWith('| ---')).split('---').length - 1, 9)
  assert.equal(result.script.segments[0].text, 'Original | dialogue.\nSecond line.')
})

test('production dialogue preserves repeated utterances and their original order', () => {
  const result = { durationSeconds: 5, shots: [{ startSeconds: 0, endSeconds: 5, visual: 'A person speaks.' }], script: { segments: [{ startSeconds: 0, endSeconds: 1, text: 'Wait.' }, { startSeconds: 2, endSeconds: 3, text: 'Wait.' }, { startSeconds: 3, endSeconds: 4, text: 'Go.' }], onScreenText: [] } }
  assert.equal(buildScriptBreakdown(result).rows[0].dialogue, 'Wait.\nWait.\nGo.')
})

test('Markdown cells preserve literal HTML and formatting characters as visible text', () => {
  const result = { durationSeconds: 5, shots: [{ startSeconds: 0, endSeconds: 5, visual: 'A sign is visible.' }], script: { segments: [], onScreenText: [{ startSeconds: 0, endSeconds: 5, text: '<b>SALE</b> & **NOW** [link](url) `code`' }] } }
  attachScriptBreakdown(result)
  const output = scriptBreakdownText(result, { format: 'md' }).join('\n')
  assert.ok(output.includes('&lt;b&gt;SALE&lt;/b&gt; &amp; \\*\\*NOW\\*\\* \\[link\\]\\(url\\) \\`code\\`'))
  assert.doesNotMatch(output, /<b>|\*\*NOW\*\*|\[link\]\(url\)/)
})
