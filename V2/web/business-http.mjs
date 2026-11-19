// Same-origin adapters for the original Spur web shell and its scoped Harness.
import {join} from 'node:path'
import {callBusiness} from './business-client.mjs'
import {catalog, execute} from './business-tools.mjs'
import {PREFIX,recordPath,conversionPath,csvPath,allowedBusinessRoute} from './business-routes.mjs'
const fail = (message, status = 422) => Object.assign(new Error(message), {status})

export function businessWorkspaceRoot(runtimeRoot, profile = null) {
  if (profile && !/^[a-f0-9]{64}$/.test(profile.id || '')) throw fail('Invalid workspace identity.', 401)
  return profile ? join(runtimeRoot, 'business', 'profiles', profile.id) : join(runtimeRoot, 'business', 'owner')
}

function respond(res, status, value, method = 'GET') {
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff'})
  res.end(method === 'HEAD' ? undefined : JSON.stringify(value))
}

async function readBody(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw fail('Use a JSON request body.', 415)
  const chunks = []; let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 48 * 1024) throw fail('Request body is too large.', 413)
    chunks.push(chunk)
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error()
    return value
  } catch { throw fail('Provide a JSON object.', 400) }
}

function shape(body, fields) {
  if (Object.keys(body).some(key => !fields.includes(key))) throw fail('Unexpected request fields.')
  return body
}
function integer(params, name, fallback, min, max) {
  const raw = params.get(name)
  if (raw === null) return fallback
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < min || Number(raw) > max) throw fail(`Invalid ${name}.`)
  return Number(raw)
}

export async function handleBusinessRequest(req, res, {root}) {
  const raw = req.url || '/', url = new URL(raw, 'http://localhost'), path = url.pathname, method = req.method
  const rawPath = raw.split('?')[0]
  if (!path.startsWith(PREFIX + '/')) return false
  if (rawPath.includes('\\') || /%2f|%5c|%2e/i.test(rawPath) || path !== rawPath || !allowedBusinessRoute(path, method)) {
    respond(res, 404, {error:'Business endpoint not found.'}, method); return true
  }
  const call = (operation, args = {}) => callBusiness(root, operation, args, 'user')
  try {
    let result, status = 200
    const query = Object.fromEntries(url.searchParams), record = recordPath.exec(path), conversion = conversionPath.exec(path)
    if (record) {
      const [,kind,record_id,archive] = record
      if (['GET','HEAD'].includes(method)) {
        if (record_id) result = await call('get', {kind,record_id})
        else {
          const offset = integer(url.searchParams,'offset',0,0,1000000), limit = integer(url.searchParams,'limit',200,1,500)
          if (query.archived && !['true','false'].includes(query.archived)) throw fail('Invalid archived filter.')
          if ((query.query || '').length > 200) throw fail('Search is too long.')
          const rows = await call('list', {kind,query:query.query || '',archived:query.archived === 'true'})
          result = {items:rows.slice(offset,offset+limit),total:rows.length,offset,next_offset:offset+limit<rows.length?offset+limit:null}
        }
      } else {
        const body = await readBody(req)
        if (archive) { shape(body,['version','request_id']); result = await call('archive',{kind,record_id,...body}) }
        else if (record_id) { shape(body,['data','version','request_id']); result = await call('update',{kind,record_id,...body}) }
        else { shape(body,['data','request_id']); result = await call('create',{kind,...body}); status = 201 }
      }
    } else if (conversion) {
      const body = shape(await readBody(req), ['request_id'])
      result = await call('convert_lead',{record_id:conversion[1],...body})
    } else if (path === `${PREFIX}/modules`) {
      result = await call(method === 'PUT' ? 'configure_modules' : 'modules', method === 'PUT' ? {value:shape(await readBody(req),['modules','version'])} : {})
    } else if (path === `${PREFIX}/settings`) {
      result = await call(method === 'PUT' ? 'update_settings' : 'settings', method === 'PUT' ? {value:await readBody(req)} : {})
    } else if (path === `${PREFIX}/schemas`) {
      result = await call('schema',query.kind ? {kind:query.kind} : {})
    } else if (path === `${PREFIX}/dashboard` || path === `${PREFIX}/action-center`) {
      shape(query,['start','end','currency','client_id','project_id'])
      result = await call('dashboard',query)
      if (path.endsWith('/action-center')) result = {items:result.action_center}
    } else if (path === `${PREFIX}/calendar`) {
      shape(query,['start','end']); result = await call('calendar',query)
    } else if (path === `${PREFIX}/activity`) {
      result = {items:await call('activity',{limit:integer(url.searchParams,'limit',50,1,200)})}
    } else if (path === `${PREFIX}/tools`) {
      result = {version:'1.0',tools:await catalog(root),execution_endpoint:`${PREFIX}/execute`}
    } else if (path === `${PREFIX}/execute`) {
      const body = shape(await readBody(req), ['name','arguments','request_id'])
      if (typeof body.name !== 'string' || !body.arguments || typeof body.arguments !== 'object' || Array.isArray(body.arguments) || typeof body.request_id !== 'string') throw fail('Provide name, arguments and a stable request_id.')
      result = await execute(root,body.name,body.arguments,body.request_id)
      status = result.ok === false ? result.error.status : 200
    } else if (path === `${PREFIX}/export`) {
      result = await call('export')
      res.setHeader('Content-Disposition','attachment; filename="spur-business-workspace.json"')
    } else if (csvPath.test(path)) {
      const kind = csvPath.exec(path)[1], rows = await call('list',{kind})
      const columns = [...new Set(rows.flatMap(row=>Object.keys(row)))].sort()
      if (!columns.length) columns.push('id')
      const cell = value => {
        let text = value && typeof value === 'object' ? JSON.stringify(value) : String(value ?? '')
        if (/^[\s]*[=+\-@]/.test(text)) text = "'" + text
        return '"' + text.replaceAll('"','""') + '"'
      }
      const csv = [columns,...rows.map(row=>columns.map(key=>row[key]))].map(row=>row.map(cell).join(',')).join('\r\n') + '\r\n'
      res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="spur-${kind}.csv"`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'})
      res.end(method === 'HEAD' ? undefined : csv); return true
    }
    respond(res,status,result,method)
  } catch (error) {
    respond(res,error.status || 503,{error:error.status ? error.message : 'Business workspace is temporarily unavailable.'},method)
  }
  return true
}
