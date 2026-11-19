import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const built = await build({
  entryPoints: [fileURLToPath(new URL('../src/resultBlocks.ts', import.meta.url))],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'neutral',
  target: 'es2020',
})
const { resultBlocks } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'))

const sample = `# Headline numbers

| Metric | Value | Basis |
|---|---|---|
| Channel created | 2019-02-14 | Data API |
| Views, last 28 days | 0 | Analytics API |

The daily report is a real zero.

## Per-video

| Video | Views |
| --- | --- |
| [connect to spur ring](https://www.youtube.com/watch?v=abc) | 1 |

<script>alert(1)</script>
`

test('markdown tables become rows and raw html stays text', () => {
  const blocks = resultBlocks(sample)
  assert.equal(blocks[0].type, 'heading')
  assert.equal(blocks[0].text, 'Headline numbers')
  assert.equal(blocks[1].type, 'table')
  assert.deepEqual(blocks[1].headers, ['Metric', 'Value', 'Basis'])
  assert.equal(blocks[1].rows.length, 2)
  assert.equal(blocks[1].rows[0][0], 'Channel created')
  assert.equal(blocks[2].type, 'paragraph')
  assert.equal(blocks[3].text, 'Per-video')
  assert.equal(blocks[4].rows[0][0].includes('<script>'), false)
  assert.match(blocks[4].rows[0][0], /youtube\.com/)
  assert.match(blocks.at(-1).text, /<script>/)
})
