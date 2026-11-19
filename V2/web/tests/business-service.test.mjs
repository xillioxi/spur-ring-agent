import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { callBusiness } from '../business-client.mjs'

async function workspace(t) {
  const prefix = join(resolve(tmpdir()), 'spur-business-service-')
  const root = await mkdtemp(prefix)
  t.after(async () => {
    assert.ok(resolve(root).startsWith(prefix) && resolve(root) !== resolve(tmpdir()))
    await rm(root, { recursive: true, force: true })
  })
  return root
}

test('discovers all eleven migrated field schemas without starting another server', async t => {
  const root = await workspace(t)
  const all = await callBusiness(root, 'schema')
  assert.equal(all.kinds.length, 11)
  const schema = await callBusiness(root, 'schema', { kind: 'finances' })
  assert.equal(schema.module, 'finances')
  assert.ok(schema.schema.required.includes('amount'))
  assert.equal(schema.schema.additionalProperties, false)
})

test('separate processes share records, decimal accounting, calendar and provenance', async t => {
  const root = await workspace(t)
  const customer = await callBusiness(root, 'create', { kind: 'clients', data: { name: 'Studio 中文' }, request_id: 'client-request' }, 'harness')
  const project = await callBusiness(root, 'create', { kind: 'projects', data: { name: 'Launch', client_id: customer.id, due_date: '2027-01-20' } })
  await callBusiness(root, 'create', { kind: 'finances', data: { title: 'Income', amount: '10.10', status: 'paid', project_id: project.id, date: '2027-01-10' } })
  await callBusiness(root, 'create', { kind: 'finances', data: { title: 'Expense', amount: '0.20', status: 'paid', type: 'expense', project_id: project.id, date: '2027-01-11' } })
  const dashboard = await callBusiness(root, 'dashboard', { client_id: customer.id, start: '2027-01-01', end: '2027-01-31' })
  assert.equal(dashboard.totals_by_currency[0].net, '9.90')
  const saved = await callBusiness(root, 'get', { kind: 'clients', record_id: customer.id })
  assert.equal(saved.name, 'Studio 中文')
  assert.equal(saved.created_by, 'harness')
  assert.equal((await callBusiness(root, 'calendar', { start: '2027-01-01', end: '2027-01-31' }))[0].record_id, project.id)
  assert.equal((await readFile(join(root, 'business.db'))).subarray(0, 15).toString(), 'SQLite format 3')
})

test('update/archive request receipts replay without duplicate changes after process restart', async t => {
  const root = await workspace(t)
  const item = await callBusiness(root, 'create', { kind: 'clients', data: { name: 'Original' } })
  const args = { kind: 'clients', record_id: item.id, data: { name: 'Updated' }, version: 1, request_id: 'update-request' }
  const [first, retry] = await Promise.all([callBusiness(root, 'update', args, 'harness'), callBusiness(root, 'update', args, 'harness')])
  assert.deepEqual(retry, first)
  assert.equal(first.version, 2)
  await assert.rejects(callBusiness(root, 'update', { ...args, data: { name: 'Different' } }), error => error.status === 409)
  const archive = { kind: 'clients', record_id: item.id, version: 2, request_id: 'archive-request' }
  const archived = await callBusiness(root, 'archive', archive, 'harness')
  assert.deepEqual(await callBusiness(root, 'archive', archive, 'harness'), archived)
  assert.equal((await callBusiness(root, 'activity')).length, 3)
})

test('concurrent lead conversion creates one client in shared SQLite', async t => {
  const root = await workspace(t)
  const lead = await callBusiness(root, 'create', { kind: 'leads', data: { name: 'Future client' } })
  const args = { record_id: lead.id, request_id: 'convert-request' }
  const values = await Promise.all([callBusiness(root, 'convert_lead', args), callBusiness(root, 'convert_lead', args)])
  assert.equal(values[0].client.id, values[1].client.id)
  assert.equal((await callBusiness(root, 'list', { kind: 'clients' })).length, 1)
})

test('host-chosen roots are isolated and request arguments cannot switch storage', async t => {
  const root = await workspace(t), foreign = await workspace(t)
  const item = await callBusiness(root, 'create', { kind: 'clients', data: { name: 'Private' } })
  assert.deepEqual(await callBusiness(foreign, 'list', { kind: 'clients' }), [])
  await assert.rejects(callBusiness(foreign, 'get', { kind: 'clients', record_id: item.id }), error => error.status === 404)
  for (const injected of [{ root }, { database_path: join(root, 'business.db') }, { workspace_id: root }, { actor: 'user' }])
    await assert.rejects(callBusiness(foreign, 'list', { kind: 'clients', ...injected }, 'harness'), error => error.status === 422)
  await assert.rejects(callBusiness(root, '__dict__'), error => error.status === 404)
})

test('schema validation and process adapter reject invalid or excessive requests', async t => {
  const root = await workspace(t)
  for (const amount of ['NaN', 'Infinity', '0', '-1'])
    await assert.rejects(callBusiness(root, 'create', { kind: 'finances', data: { title: 'Bad', amount } }), error => error.status === 422)
  await assert.rejects(callBusiness(root, 'create', { kind: 'finances', data: { title: 'Bad', amount: Infinity } }), error => error.status === 422)
  await assert.rejects(callBusiness(root, 'create', { kind: 'clients', data: { name: 'x'.repeat(300_000) } }), error => error.status === 413)
  assert.deepEqual(await callBusiness(root, 'list', { kind: 'finances' }), [])
})

test('service checks current Harness grants while manual UI records remain usable', async t => {
  const root = await workspace(t)
  await callBusiness(root, 'configure_modules', { value: { modules: [{ id: 'clients', permissions: { ai_write: false } }] } })
  await assert.rejects(callBusiness(root, 'create', { kind: 'clients', data: { name: 'Denied' } }, 'harness'), error => error.status === 403)
  await callBusiness(root, 'create', { kind: 'clients', data: { name: 'Manual' } })
  await callBusiness(root, 'update_settings', { value: { ai_enabled: false } })
  await assert.rejects(callBusiness(root, 'list', { kind: 'clients' }, 'harness'), error => error.status === 403)
  assert.equal((await callBusiness(root, 'list', { kind: 'clients' })).length, 1)
  await assert.rejects(callBusiness(root, 'update_settings', { value: { ai_enabled: true } }, 'harness'), error => error.status === 403)
})

test('missing Python produces actionable dependency status rather than mock data', async t => {
  const root = await workspace(t)
  const original = process.env.SPUR_BUSINESS_PYTHON
  try {
    process.env.SPUR_BUSINESS_PYTHON = join(root, 'missing-python')
    await assert.rejects(callBusiness(root, 'modules'), error => error.status === 503 && error.code === 'dependency_unavailable' && error.message.includes('SPUR_BUSINESS_PYTHON'))
  } finally {
    if (original === undefined) delete process.env.SPUR_BUSINESS_PYTHON
    else process.env.SPUR_BUSINESS_PYTHON = original
  }
})

test('RPC refuses malformed JSON and command-line database injection fields', async t => {
  const root = await workspace(t)
  const python = process.env.SPUR_BUSINESS_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
  const rpc = fileURLToPath(new URL('../business/rpc.py', import.meta.url))
  for (const input of ['not-json', '{"operation":"list","args":{"kind":"clients"},"database_path":"foreign.db"}', '{"operation":"list","args":{"kind":"clients","archived":"false"}}']) {
    const result = spawnSync(python, ['-I', '-X', 'utf8', rpc, join(root, 'business.db')], { input, encoding: 'utf8', windowsHide: true, timeout: 10_000 })
    assert.equal(result.status, 0, result.stderr)
    const response = JSON.parse(result.stdout)
    assert.equal(response.ok, false)
    assert.equal(response.status, 422)
  }
})
