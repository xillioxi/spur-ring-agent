import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build, transform } from 'esbuild'

const source = await transform(
  await readFile(new URL('../src/ideaModel.ts', import.meta.url), 'utf8'),
  { loader: 'ts', format: 'esm', target: 'es2020' }
)
const model = await import('data:text/javascript;base64,' + Buffer.from(source.code).toString('base64'))

test('local dates do not use a UTC day boundary', () => {
  const day = new Date(2026, 10, 8, 12)
  assert.equal(model.localDateKey(day), '2026-11-08')
  assert.equal(model.sameLocalDay(new Date(2026, 10, 8, 23, 59).toISOString(), day), true)
  assert.equal(model.sameLocalDay(new Date(2026, 10, 9, 0, 5).toISOString(), day), false)
})

test('counts keep records, tasks, and unlinked ideas separate', () => {
  const day = new Date(2026, 10, 8, 12)
  const captures = [
    { id: 'a', at: new Date(2026, 10, 8, 9).toISOString(), text: '想法', status: '记录', chapterIds: [] },
    { id: 'b', at: new Date(2026, 10, 8, 10).toISOString(), text: '已交给任务', status: '已关联', chapterIds: ['task-1'] },
  ]
  const chapters = model.chaptersForDay([
    { id: 'task-1', source: 'web', at: new Date(2026, 10, 8, 10).toISOString(), title: '分析', status: 'finished', goal: '分析' },
    { id: 'task-2', source: 'ring', at: new Date(2026, 10, 8, 11).toISOString(), title: '整理', status: 'running', goal: '整理今天的想法' },
    { id: 'other-day', source: 'app', at: new Date(2026, 10, 7, 11).toISOString(), title: '昨天', status: 'failed', goal: '昨天的目标' },
  ], day)
  const counts = model.ideaCounts(captures, chapters)
  assert.deepEqual(counts, { records: 2, tasks: 2, ideas: 1 })
  assert.deepEqual(chapters.map((item) => [item.source, item.status]), [
    ['web', 'finished'],
    ['ring', 'running'],
  ])
})

test('chapter status stays specific and unknown status is not completed', () => {
  const day = new Date(2026, 10, 8, 12)
  const chapters = model.chaptersForDay([
    ...model.webTaskChapters([
      { id: '1', title: '执行中的研究', createdAt: new Date(2026, 10, 8, 8).toISOString(), status: 'running' },
      { id: '2', title: '失败的研究', createdAt: new Date(2026, 10, 8, 9).toISOString(), status: 'failed' },
    ]),
    { id: '3', source: 'app', at: new Date(2026, 10, 8, 12).toISOString(), title: '手机任务', status: 'later', goal: '' },
  ], day)
  assert.deepEqual(chapters.map((item) => item.status), ['running', 'failed', 'unknown'])
  assert.equal(chapters[2].goal, '手机任务')
  assert.match(model.taskStatusSentence(chapters), /1 项执行中/)
  assert.match(model.taskStatusSentence(chapters), /1 项执行失败/)
  assert.match(model.taskStatusSentence(chapters), /1 项待核对/)
  assert.doesNotMatch(model.taskStatusSentence(chapters), /3 项已完成/)
})

test('draft keys isolate guests and days', () => {
  assert.equal(model.ideaDraftKey('guest:guest-aaaaaaaaaaaaaaaaaaaaaaaa', '2026-11-08'), 'spur.web.idea.draft.v1:guest:guest-aaaaaaaaaaaaaaaaaaaaaaaa:2026-11-08')
  assert.notEqual(
    model.ideaDraftKey('guest:guest-aaaaaaaaaaaaaaaaaaaaaaaa', '2026-11-08'),
    model.ideaDraftKey('guest:guest-bbbbbbbbbbbbbbbbbbbbbbbb', '2026-11-08')
  )
})

const demoBuilt = await build({
  entryPoints: [fileURLToPath(new URL('../src/ideaDemoData.ts', import.meta.url))],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'neutral',
  target: 'es2020',
})
const demo = await import('data:text/javascript;base64,' + Buffer.from(demoBuilt.outputFiles[0].text).toString('base64'))

function day(key) {
  const [year, month, date] = key.split('-').map(Number)
  return demo.demoOnDay(new Date(year, month - 1, date, 12))
}

test('demo days keep explicit links and do not borrow another day', () => {
  const paris = day('2026-11-06')
  const empty = day('2026-11-07')
  const hardware = day('2026-11-08')
  const tasks = day('2026-11-09')
  assert.deepEqual(paris.counts, { records: 50, tasks: 10, ideas: 40 })
  assert.deepEqual(empty.counts, { records: 0, tasks: 0, ideas: 0 })
  assert.deepEqual(hardware.counts, { records: 30, tasks: 8, ideas: 22 })
  assert.deepEqual(tasks.counts, { records: 7, tasks: 7, ideas: 0 })
  assert.equal(paris.captures.filter((item) => item.chapterIds.length === 0).length, 40)
  assert.equal(hardware.document.split('\n').filter((line) => line.startsWith('### ')).length, 22)
  assert.equal(paris.document.split('\n').filter((line) => line.startsWith('### ')).length, 40)
  assert.match(paris.document, /Paris Travel — Daily Ideas/)
  assert.match(hardware.document, /AI Hardware & Personal Agent — Daily Ideas/)
  assert.equal(empty.document, null)
  assert.equal(tasks.document, null)
  assert.equal(tasks.chapters.filter((item) => item.status === 'finished').length, 3)
  assert.equal(tasks.chapters.filter((item) => item.status === 'running').length, 3)
  assert.equal(tasks.chapters.filter((item) => item.status === 'pending').length, 1)
  assert.equal(paris.chapters.some((item) => item.source === 'web'), false)
  assert.doesNotMatch(paris.document, /AI Ring/)
  assert.doesNotMatch(hardware.document, /埃菲尔|巴黎/)
})

test('demo data does not touch stored tasks', async () => {
  const source = await readFile(new URL('../src/ideaDemoData.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /localStorage|submitTask|spur\.web\.tasks/)
})

test('empty idea document keeps the daily markdown structure', () => {
  const text = model.documentForDay(new Date(2026, 10, 8, 12))
  assert.match(text, /^# 今日想法/)
  assert.match(text, /## 今日概览/)
  assert.match(text, /## 整理后的想法/)
  assert.match(text, /## 后续可展开/)
  assert.doesNotMatch(text, /巴黎/)
})
