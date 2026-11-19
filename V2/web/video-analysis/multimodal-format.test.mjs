import test from 'node:test'
import assert from 'node:assert/strict'
import { analysisPrompt, normalizeAnalysis } from './multimodal-format.mjs'
import { scriptTemplatePrompt } from './script-templates.mjs'

const options = { duration: 10, hasAudio: true, mode: 'both', scriptTemplateId: 'xc-1' }
const observed = () => ({
  summary: 'A person presents two visible objects before a cut.', language: 'en',
  shots: [{ startSeconds: 0, endSeconds: 10, visual: 'Two objects on a table.', location: 'A visible tabletop', effects: 'A visible split-screen', notes: 'The object labels are too small to read.' }],
  transcript: [{ startSeconds: 0, endSeconds: 2, text: 'Look at these two objects.' }],
  onScreenText: [{ startSeconds: 2, endSeconds: 4, text: 'TWO OBJECTS' }],
  audio: { description: 'A short spoken sentence.', segments: [], events: [] },
  scriptStructure: {
    templateId: 'xc-1', summary: 'The opening introduces the objects.',
    stages: [{ stageId: 'hook', startSeconds: 0, endSeconds: 2, interpretation: 'The opening directs attention to the visible objects.', evidence: [{ source: 'speech', startSeconds: 0, endSeconds: 2, text: 'Look at these two objects.' }] }],
  },
})

test('default analysis requests exactly the nine observed production fields without a narrative template', () => {
  const defaults = { duration: 10, hasAudio: true, mode: 'both' }
  const prompt = analysisPrompt(defaults)
  assert.ok(prompt.includes('分镜编号 | 取景地 | 画面 | 台词 | 镜头运用 | 秒数 | 花字 | 背景特效与滤镜 | 备注'))
  assert.match(prompt, /derives each section's seconds from endSeconds minus startSeconds/)
  assert.match(prompt, /Keep clearly audible dialogue or voiceover verbatim/)
  assert.match(prompt, /Do not guess a named location/)
  assert.match(prompt, /OPTIONAL NARRATIVE MATCHING IS DISABLED/)
  assert.equal(prompt.includes('Template catalog:'), false)
  assert.equal(prompt.includes('Requested template:'), false)
  const raw = observed()
  const result = normalizeAnalysis(JSON.stringify(raw), defaults)
  assert.equal(result.scriptStructure, undefined, 'an unsolicited narrative classification is ignored by default')
  assert.deepEqual(result.transcript, raw.transcript)
  assert.deepEqual(result.onScreenText.map(({ evidence, ...value }) => value), raw.onScreenText)
  assert.equal(result.shots[0].location, raw.shots[0].location)
})

test('workbook lens is requested separately from verbatim extraction and omitted from audio-only prompts', () => {
  const prompt = analysisPrompt(options)
  assert.ok(prompt.includes(scriptTemplatePrompt('xc-1')))
  assert.match(prompt, /Transcribe only clearly audible spoken words, verbatim/)
  assert.match(prompt, /Location is only the visible setting/)
  const audio = analysisPrompt({ ...options, mode: 'audio' })
  assert.equal(audio.includes(scriptTemplatePrompt('xc-1')), false)
  assert.match(audio, /shots and onScreenText must be empty arrays/)
  assert.equal(audio.includes('PRODUCTION BREAKDOWN:'), false)
})

test('normalized structure remains a separate interpretation and never changes original speech or visible wording', () => {
  const raw = observed()
  const result = normalizeAnalysis(JSON.stringify(raw), options)
  assert.deepEqual(result.transcript, raw.transcript)
  assert.deepEqual(result.onScreenText.map(({ evidence, ...value }) => value), raw.onScreenText)
  assert.equal(result.scriptStructure.templateId, 'xc-1')
  assert.equal(result.scriptStructure.stages[0].stageId, 'hook')
  assert.equal(result.shots[0].location, raw.shots[0].location)
  assert.equal(result.shots[0].effects, raw.shots[0].effects)
  assert.equal(result.shots[0].notes, raw.shots[0].notes)
})

test('production observation fields are bounded strings and script-only analysis never acquires visual shots', () => {
  const raw = observed()
  Object.assign(raw.shots[0], { location: ['not a string'], effects: 'x'.repeat(3000), notes: '\u0000  Qualified note.  ', productionSoftware: 'invented' })
  const result = normalizeAnalysis(JSON.stringify(raw), options)
  assert.equal(result.shots[0].location, null)
  assert.equal(result.shots[0].effects.length, 2000)
  assert.equal(result.shots[0].notes, 'Qualified note.')
  assert.equal(result.shots[0].productionSoftware, undefined)
  const script = normalizeAnalysis(JSON.stringify(raw), { ...options, mode: 'script' })
  assert.deepEqual(script.shots, [])
  assert.deepEqual(script.transcript, raw.transcript)
  assert.equal(script.scriptStructure.templateId, 'xc-1')
  const audio = normalizeAnalysis(JSON.stringify(raw), { ...options, mode: 'audio' })
  assert.deepEqual(audio.shots, [])
  assert.deepEqual(audio.onScreenText, [])
  assert.equal(audio.scriptStructure, undefined)
})
