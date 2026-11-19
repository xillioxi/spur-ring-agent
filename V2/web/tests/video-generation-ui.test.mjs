import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = path => readFileSync(new URL('../src/' + path, import.meta.url), 'utf8')

test('Video Generation is a first-class VIDEO navigation page', () => {
  const sidebar = source('Sidebar.tsx'), app = source('App.tsx')
  assert.match(sidebar, /onPage\('video\/generation'\)/)
  assert.match(sidebar, />Video Generation</)
  assert.match(app, /<VideoGeneration/)
  assert.match(app, /#video\/generation/)
})

test('generation UI exposes every current MiniMax H3 control', () => {
  const ui = source('VideoGeneration.tsx'), api = source('videoGenerationApi.ts')
  for (const term of ['Duration', 'Resolution', 'Seed', 'Aspect ratio', 'First frame']) assert.match(ui, new RegExp(term))
  assert.ok(ui.includes('First + last'))
  assert.match(api, /requestKey: crypto\.randomUUID\(\)/)
  assert.match(api, /\/api\/creator-agent\/videos/)
})

test('server capability shape matches the generation form', () => {
  const server = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
  assert.match(server, /durations:Array\.from/)
  assert.match(server, /referenceImages:true/)
  assert.match(server, /model:videoClient\.H3/)
})
