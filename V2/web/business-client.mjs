// Private process adapter for the existing Node host and Harness plugin.
// Only the caller-selected root determines storage; request args never select a DB.
import { spawn } from 'node:child_process'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const rpcPath = fileURLToPath(new URL('./business/rpc.py', import.meta.url))
const MAX_INPUT_BYTES = 256 * 1024
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
const MAX_STDERR_BYTES = 64 * 1024
const TIMEOUT_MS = 30_000
const operations = new Set(['modules', 'configure_modules', 'settings', 'update_settings', 'list', 'get',
  'create', 'update', 'archive', 'convert_lead', 'dashboard', 'calendar', 'activity', 'export', 'schema'])

export class BusinessServiceError extends Error {
  constructor(message, status = 500, code = 'business_service_error') {
    super(message)
    this.name = 'BusinessServiceError'
    this.status = status
    this.code = code
  }
}

export async function callBusiness(root, operation, args = {}, actor = 'user') {
  if (typeof root !== 'string' || !root.trim() || root.includes('\0'))
    throw new BusinessServiceError('The server has not configured business storage.', 503, 'storage_unavailable')
  if (!operations.has(operation)) throw new BusinessServiceError('Unknown business operation.', 404, 'invalid_operation')
  if (!args || typeof args !== 'object' || Array.isArray(args))
    throw new BusinessServiceError('Business arguments must be an object.', 422, 'invalid_request')
  let input
  try { input = Buffer.from(JSON.stringify({ operation, args, actor }, (_key, value) => {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Non-finite JSON number')
    return value
  })) }
  catch { throw new BusinessServiceError('Business arguments must contain JSON values.', 422, 'invalid_request') }
  if (input.length > MAX_INPUT_BYTES)
    throw new BusinessServiceError('Business request exceeds the size limit.', 413, 'request_too_large')
  const python = process.env.SPUR_BUSINESS_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
  const databasePath = join(resolve(root), 'business.db')
  return new Promise((resolveCall, rejectCall) => {
    let child, timer, settled = false, outputBytes = 0, errorBytes = 0
    const chunks = []
    function settle(error, value) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) rejectCall(error)
      else resolveCall(value)
    }
    function stop(error) {
      child?.kill()
      settle(error)
    }
    try {
      child = spawn(python, ['-I', '-X', 'utf8', rpcPath, databasePath], {
        shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      })
    } catch {
      return settle(new BusinessServiceError('Business storage needs Python with Pydantic 2. Configure SPUR_BUSINESS_PYTHON.', 503, 'dependency_unavailable'))
    }
    timer = setTimeout(() => stop(new BusinessServiceError(
      'Business storage did not finish in time. Check the existing record before retrying a write.', 504, 'service_timeout')), TIMEOUT_MS)
    child.once('error', () => settle(new BusinessServiceError(
      'Business storage needs Python with Pydantic 2. Install business/requirements.txt and configure SPUR_BUSINESS_PYTHON.', 503, 'dependency_unavailable')))
    child.stdout.on('data', chunk => {
      outputBytes += chunk.length
      if (outputBytes > MAX_OUTPUT_BYTES) return stop(new BusinessServiceError('Business result exceeds the size limit. Narrow the request.', 413, 'result_too_large'))
      chunks.push(chunk)
    })
    child.stderr.on('data', chunk => {
      errorBytes += chunk.length
      if (errorBytes > MAX_STDERR_BYTES) stop(new BusinessServiceError('Business storage failed to start cleanly. Check its Python dependencies.', 503, 'dependency_unavailable'))
    })
    child.stdin.on('error', () => { /* Process close/error provides the authoritative outcome. */ })
    child.once('close', code => {
      if (settled) return
      let response
      try { response = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
      catch {
        return settle(new BusinessServiceError('Business storage returned no valid response. Check SPUR_BUSINESS_PYTHON and business/requirements.txt.', 503, 'dependency_unavailable'))
      }
      if (!response || typeof response !== 'object' || typeof response.ok !== 'boolean')
        return settle(new BusinessServiceError('Business storage returned an invalid response.', 502, 'invalid_response'))
      if (response.ok && code === 0) return settle(null, response.result)
      const status = Number.isInteger(response.status) && response.status >= 400 && response.status <= 599 ? response.status : 500
      settle(new BusinessServiceError(typeof response.error === 'string' ? response.error : 'Business storage could not complete the request.', status,
        typeof response.code === 'string' ? response.code : 'service_error'))
    })
    child.stdin.end(input)
  })
}
