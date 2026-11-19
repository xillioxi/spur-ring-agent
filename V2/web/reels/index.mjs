// Workspace-local reference storage and exact vector search for small reel libraries.
// Analysis and embeddings must come from a caller-selected provider or an import.
// This module does not decode videos, generate embeddings, or estimate views.
import { mkdir, lstat, realpath, readFile, open, rename, unlink, chmod } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'

const SCHEMA_VERSION = 1
const MAX_FILE_BYTES = 64 * 1024 * 1024
const MAX_REFERENCE_BYTES = 10 * 1024 * 1024
const MAX_REFERENCES = 500
const MAX_SEGMENTS = 1000
const queues = new Map()
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key)

export class ReelIndexError extends Error {
  constructor(message, status = 422, code = 'invalid_reference') {
    super(message)
    this.name = 'ReelIndexError'
    this.status = status
    this.code = code
  }
}

function fail(message, status = 422, code = 'invalid_reference') {
  throw new ReelIndexError(message, status, code)
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    fail(`${label} must be a plain object.`)
  return value
}

function keys(value, allowed, label) {
  object(value, label)
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`Unknown ${label} field: ${key}.`)
}

function text(value, label, max = 1000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0'))
    fail(`${label} must be non-empty text of at most ${max} characters.`)
  return value.trim()
}

function identifier(value, label) {
  const result = text(value, label, 128)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(result)) fail(`${label} contains unsupported characters.`)
  return result
}

function number(value, label, min = -Number.MAX_VALUE, max = Number.MAX_VALUE) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    fail(`${label} must be a finite number between ${min} and ${max}.`)
  return value
}

function features(value = {}, label = 'features') {
  object(value, label)
  if (Object.keys(value).length > 64) fail(`${label} may contain at most 64 measurements.`)
  const output = {}
  for (const [key, valueNumber] of Object.entries(value)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key)) fail(`${label} keys must be measurement identifiers.`)
    output[key] = number(valueNumber, `${label}.${key}`, -1e12, 1e12)
  }
  return output
}

function observations(value) {
  object(value, 'observations')
  if (!Object.keys(value).length || Object.keys(value).length > 32) fail('observations must contain 1–32 descriptions.')
  const output = {}
  for (const [key, description] of Object.entries(value)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key)) fail('Observation keys must be identifiers.')
    output[key] = text(description, `observations.${key}`, 20_000)
  }
  return output
}

function embedding(value) {
  keys(value, ['model', 'version', 'dimensions', 'values'], 'embedding')
  const model = text(value.model, 'embedding.model', 256)
  const version = text(value.version, 'embedding.version', 256)
  if (!Number.isInteger(value.dimensions) || value.dimensions < 1 || value.dimensions > 8192)
    fail('embedding.dimensions must be an integer from 1 to 8192.')
  if (!Array.isArray(value.values) || value.values.length !== value.dimensions)
    fail('embedding.values must match its declared dimensions.')
  const values = value.values.map((item, index) => number(item, `embedding.values[${index}]`, -1e12, 1e12))
  if (!values.some(item => item !== 0)) fail('A zero embedding cannot be compared with cosine similarity.')
  return { model, version, dimensions: value.dimensions, values }
}

function descriptor(value) { return { model: value.model, version: value.version, dimensions: value.dimensions } }
function spaceKey(value) { return JSON.stringify([value.model, value.version, value.dimensions]) }

function normalizeReference(value) {
  keys(value, ['id', 'source', 'durationSeconds', 'analysis', 'segments', 'createdAt', 'updatedAt'], 'reference')
  const id = identifier(value.id, 'reference.id')
  keys(value.source, ['url', 'title', 'channelUrl', 'publishedAt'], 'source')
  const source = { url: text(value.source.url, 'source.url', 4096), title: text(value.source.title, 'source.title', 1000) }
  // These are evidence pointers only; the index never fetches them.
  for (const field of ['url', 'channelUrl']) {
    if (field === 'channelUrl' && value.source.channelUrl === undefined) continue
    const pointer = field === 'url' ? source.url : text(value.source[field], `source.${field}`, 4096)
    let parsed
    try { parsed = new URL(pointer) } catch { fail(`source.${field} must be an HTTP(S) URL.`) }
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password)
      fail(`source.${field} must be an HTTP(S) URL without embedded credentials.`)
    source[field] = pointer
  }
  if (value.source.publishedAt !== undefined) source.publishedAt = text(value.source.publishedAt, 'source.publishedAt', 64)
  const durationSeconds = number(value.durationSeconds, 'durationSeconds', 0.001, 86_400)
  keys(value.analysis, ['method', 'model', 'version', 'notes'], 'analysis')
  const analysis = { method: text(value.analysis.method, 'analysis.method', 256), version: text(value.analysis.version, 'analysis.version', 256) }
  if (value.analysis.model !== undefined) analysis.model = text(value.analysis.model, 'analysis.model', 256)
  if (value.analysis.notes !== undefined) analysis.notes = text(value.analysis.notes, 'analysis.notes', 20_000)
  if (!Array.isArray(value.segments) || value.segments.length < 1 || value.segments.length > MAX_SEGMENTS)
    fail(`segments must contain 1–${MAX_SEGMENTS} timed observations.`)
  const segmentIds = new Set()
  let previousStart = -1
  const segments = value.segments.map((segment, index) => {
    keys(segment, ['id', 'startSeconds', 'endSeconds', 'observations', 'features', 'embedding'], `segments[${index}]`)
    const segmentId = identifier(segment.id, 'segment.id')
    if (segmentIds.has(segmentId)) fail('Segment IDs must be unique within a reference.')
    segmentIds.add(segmentId)
    const startSeconds = number(segment.startSeconds, 'segment.startSeconds', 0, durationSeconds)
    const endSeconds = number(segment.endSeconds, 'segment.endSeconds', 0, durationSeconds)
    if (endSeconds <= startSeconds) fail('A segment must end after it starts.')
    if (startSeconds < previousStart) fail('Segments must be supplied in chronological order.')
    previousStart = startSeconds
    const result = { id: segmentId, startSeconds, endSeconds, observations: observations(segment.observations), features: features(segment.features) }
    if (segment.embedding !== undefined) result.embedding = embedding(segment.embedding)
    return result
  })
  const result = { id, source, durationSeconds, analysis, segments }
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_REFERENCE_BYTES) fail('Reference exceeds the 10 MiB size limit.', 413, 'reference_too_large')
  return result
}

function cosine(left, right) {
  // Scaling avoids overflow/underflow for non-zero finite vectors.
  const aScale = Math.max(...left.map(Math.abs)), bScale = Math.max(...right.map(Math.abs))
  let dot = 0, aNorm = 0, bNorm = 0
  for (let i = 0; i < left.length; i++) {
    const a = left[i] / aScale, b = right[i] / bScale
    dot += a * b; aNorm += a * a; bNorm += b * b
  }
  return Math.max(-1, Math.min(1, dot / Math.sqrt(aNorm * bNorm)))
}

function compareFeatures(query, candidate) {
  const distances = {}, missingFeatures = []
  let total = 0, compared = 0
  for (const [key, queryValue] of Object.entries(query)) {
    if (!own(candidate, key)) { missingFeatures.push(key); total += 1; continue }
    // Caller must use consistent units. Each measurement is normalized separately.
    const distance = Math.min(1, Math.abs(queryValue - candidate[key]) / Math.max(1, Math.abs(queryValue), Math.abs(candidate[key])))
    distances[key] = distance
    total += distance; compared++
  }
  return { numericDistance: Object.keys(query).length ? total / Object.keys(query).length : null,
    featureDistances: distances, missingFeatures, comparedFeatures: compared }
}

function summary(reference) {
  const spaces = new Map()
  for (const segment of reference.segments) if (segment.embedding) spaces.set(spaceKey(segment.embedding), descriptor(segment.embedding))
  return { id: reference.id, source: reference.source, durationSeconds: reference.durationSeconds,
    analysis: reference.analysis, segmentCount: reference.segments.length, embeddingSpaces: [...spaces.values()],
    createdAt: reference.createdAt, updatedAt: reference.updatedAt }
}

async function serialize(key, operation) {
  const previous = queues.get(key) || Promise.resolve()
  const current = previous.catch(() => {}).then(operation)
  queues.set(key, current)
  try { return await current } finally { if (queues.get(key) === current) queues.delete(key) }
}

/**
 * The server chooses root; never pass request-provided paths to this constructor.
 * Mutations serialize across instances in this Node process and commit atomically.
 * Use one host process per workspace; this JSON store has no cross-process writer lock.
 */
export function createReelIndex({ root } = {}) {
  if (typeof root !== 'string' || !root.trim() || root.includes('\0'))
    fail('The host must configure reel storage.', 503, 'storage_unavailable')
  const configuredRoot = resolve(root)
  const queueKey = join(configuredRoot, 'reels', 'reference-index.json')

  async function paths() {
    await mkdir(configuredRoot, { recursive: true })
    const workspaceRoot = await realpath(configuredRoot)
    const directory = join(workspaceRoot, 'reels')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const info = await lstat(directory)
    if (info.isSymbolicLink() || !info.isDirectory() || await realpath(directory) !== directory)
      fail('Reel storage must be a directory inside its configured workspace.', 503, 'unsafe_storage')
    await chmod(directory, 0o700)
    return { directory, file: join(directory, 'reference-index.json') }
  }

  async function read(file) {
    let raw
    try {
      const info = await lstat(file)
      if (info.isSymbolicLink() || !info.isFile()) fail('Reel index must be a regular file.', 503, 'unsafe_storage')
      if (info.size > MAX_FILE_BYTES) fail('Reel index exceeds its storage limit.', 413, 'index_too_large')
      raw = await readFile(file, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') return { schemaVersion: SCHEMA_VERSION, references: [] }
      throw error
    }
    try {
      const data = JSON.parse(raw)
      keys(data, ['schemaVersion', 'references'], 'stored index')
      if (data.schemaVersion !== SCHEMA_VERSION || !Array.isArray(data.references) || data.references.length > MAX_REFERENCES)
        throw new Error('Unsupported index')
      const ids = new Set()
      for (const reference of data.references) {
        normalizeReference(reference)
        if (ids.has(reference.id) || !Number.isFinite(Date.parse(reference.createdAt)) || !Number.isFinite(Date.parse(reference.updatedAt)))
          throw new Error('Invalid stored reference')
        ids.add(reference.id)
      }
      return data
    } catch { fail('Reel index is invalid. Restore or repair it before writing; it has not been overwritten.', 503, 'invalid_index') }
  }

  async function save(file, data) {
    const content = JSON.stringify(data)
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) fail('Reel index exceeds the 64 MiB storage limit.', 413, 'index_too_large')
    const temporary = `${file}.${randomUUID()}.tmp`
    let handle
    try {
      handle = await open(temporary, 'wx', 0o600)
      await handle.writeFile(content, 'utf8')
      await handle.sync()
      await handle.close(); handle = undefined
      await rename(temporary, file)
      await chmod(file, 0o600)
    } finally {
      await handle?.close()
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
    }
  }

  async function withIndex(operation) {
    return serialize(queueKey, async () => {
      const { file } = await paths()
      return operation(await read(file), file)
    })
  }

  return {
    async upsertReference(value) {
      const normalized = normalizeReference(value)
      return withIndex(async (data, file) => {
        const position = data.references.findIndex(item => item.id === normalized.id)
        if (position === -1 && data.references.length >= MAX_REFERENCES) fail('Reel index supports at most 500 references.', 413, 'index_full')
        const now = new Date().toISOString()
        const saved = { ...normalized, createdAt: position >= 0 ? data.references[position].createdAt : now, updatedAt: now }
        if (position >= 0) data.references[position] = saved
        else data.references.push(saved)
        await save(file, data)
        return structuredClone(saved)
      })
    },
    async getReference(id) {
      identifier(id, 'reference.id')
      return withIndex(data => {
        const found = data.references.find(item => item.id === id)
        if (!found) fail('Reference was not found in this workspace.', 404, 'reference_not_found')
        return structuredClone(found)
      })
    },
    async listReferences() {
      return withIndex(data => structuredClone([...data.references].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)).map(summary)))
    },
    async listEmbeddingSpaces() {
      return withIndex(data => {
        const spaces = new Map()
        for (const reference of data.references) for (const segment of reference.segments) if (segment.embedding) {
          const key = spaceKey(segment.embedding)
          const current = spaces.get(key) || { ...descriptor(segment.embedding), segmentCount: 0 }
          current.segmentCount++; spaces.set(key, current)
        }
        return [...spaces.values()]
      })
    },
    async search(query) {
      keys(query, ['embedding', 'features', 'limit', 'referenceIds'], 'search')
      const queryEmbedding = query.embedding === undefined ? null : embedding(query.embedding)
      const queryFeatures = features(query.features)
      if (!queryEmbedding && !Object.keys(queryFeatures).length) fail('Search needs a query embedding or numeric measurements.', 422, 'missing_search_features')
      const limit = query.limit === undefined ? 10 : query.limit
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('Search limit must be an integer from 1 to 100.')
      let referenceIds
      if (query.referenceIds !== undefined) {
        if (!Array.isArray(query.referenceIds) || query.referenceIds.length > MAX_REFERENCES) fail('referenceIds must be an array of up to 500 reference IDs.')
        referenceIds = new Set(query.referenceIds.map(id => identifier(id, 'referenceIds entry')))
      }
      const mode = queryEmbedding ? (Object.keys(queryFeatures).length ? 'semantic_with_numeric_diagnostics' : 'semantic') : 'numeric_only'
      return withIndex(data => {
        const results = []
        let eligibleSegments = 0, incompatibleEmbeddingSegments = 0
        for (const reference of data.references) {
          if (referenceIds && !referenceIds.has(reference.id)) continue
          for (const [segmentIndex, segment] of reference.segments.entries()) {
            eligibleSegments++
            if (queryEmbedding && (!segment.embedding || spaceKey(segment.embedding) !== spaceKey(queryEmbedding))) {
              incompatibleEmbeddingSegments++; continue
            }
            const numeric = compareFeatures(queryFeatures, segment.features)
            if (!queryEmbedding && !numeric.comparedFeatures) continue
            const { embedding: _hiddenEmbedding, ...evidence } = segment
            results.push({ referenceId: reference.id, source: reference.source, durationSeconds: reference.durationSeconds,
              analysis: reference.analysis, segmentIndex, segment: evidence,
              semanticCosine: queryEmbedding ? cosine(queryEmbedding.values, segment.embedding.values) : null, ...numeric })
          }
        }
        results.sort((a, b) => queryEmbedding
          ? b.semanticCosine - a.semanticCosine || (a.numericDistance ?? 0) - (b.numericDistance ?? 0) || a.referenceId.localeCompare(b.referenceId) || a.segmentIndex - b.segmentIndex
          : a.numericDistance - b.numericDistance || a.referenceId.localeCompare(b.referenceId) || a.segmentIndex - b.segmentIndex)
        return structuredClone({ mode, ranking: queryEmbedding ? 'semantic_cosine_descending' : 'normalized_numeric_distance_ascending',
          embeddingSpace: queryEmbedding ? descriptor(queryEmbedding) : null, eligibleSegments, incompatibleEmbeddingSegments,
          matchingSegments: results.length, results: results.slice(0, limit),
          notice: 'Scores describe reference similarity, not production quality, view probabilities, or a learned creator model.' })
      })
    },
  }
}
