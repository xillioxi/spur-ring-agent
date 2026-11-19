import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const built = await build({
  entryPoints: [fileURLToPath(new URL('../src/memoryDemoData.ts', import.meta.url))],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'neutral',
  target: 'es2020',
})
const demo = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'))

test('about me keeps the five profile sections', () => {
  assert.deepEqual(demo.aboutFields.map((field) => field.title), [
    'Who I Am',
    'Work',
    'What I Follow',
    'How I Work',
    'How I Communicate',
  ])
  for (const field of demo.aboutFields) assert.ok(demo.initialAbout[field.key].length > 40)
})

test('jack is a complete fictional person and search stays inside the demo', () => {
  const jack = demo.memoryItems.find((item) => item.id === 'jack')
  assert.equal(jack.kind, 'person')
  assert.equal(jack.facts.find((fact) => fact.label === 'Role').value, 'Photographer')
  assert.match(jack.facts.find((fact) => fact.label === 'Company').value, /Studio Lumière/)
  assert.match(jack.facts.find((fact) => fact.label === 'Email').value, /jack@example.com/)
  assert.match(jack.facts.find((fact) => fact.label === 'Project').value, /Paris Travel Film/)
  assert.equal(jack.nodes.length >= 4 && jack.nodes.length <= 6, true)
  assert.match(jack.history.map((event) => event.text).join(' '), /not sent/)
  const jackHits = demo.searchMemories('Jack', demo.memoryItems, demo.initialAbout)
  assert.ok(jackHits.some((hit) => hit.kind === 'item' && hit.id === 'jack'))
  const aiHits = demo.searchMemories('AI', demo.memoryItems, demo.initialAbout)
  assert.ok(aiHits.some((hit) => hit.id === 'hardware'))
  assert.ok(aiHits.some((hit) => hit.id === 'ring'))
  assert.equal(aiHits.some((hit) => hit.id === 'jack'), false)
  assert.deepEqual(demo.searchMemories('   ', demo.memoryItems, demo.initialAbout), [])
})

test('projects and knowledge are separate examples with local graphs', () => {
  const kinds = demo.memoryItems.map((item) => item.kind)
  assert.equal(kinds.filter((kind) => kind === 'project').length, 3)
  assert.equal(kinds.filter((kind) => kind === 'knowledge').length, 3)
  for (const item of demo.memoryItems) {
    assert.equal(item.nodes.length >= 4 && item.nodes.length <= 6, true)
    assert.doesNotMatch(item.nextAction, /已发送|sent successfully|sync succeeded/i)
  }
})

test('legacy demo fixtures stay isolated from the live centralized Memory bank', async () => {
  const source = await readFile(new URL('../src/memoryDemoData.ts', import.meta.url), 'utf8')
  const page = await readFile(new URL('../src/MemoryPage.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /localStorage|submitTask|fetch\(|spur\.web\.tasks/)
  assert.doesNotMatch(page, /memoryDemoData|initialAbout|Illustrative examples/)
  assert.match(page,/MemoryBank/)
})
