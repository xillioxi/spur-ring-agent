import path from 'node:path'
import { readFile, mkdir, realpath, stat, writeFile, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createReelIndex } from './index.mjs'
import { analyzeLocalMedia, getMediaCapabilities, validateLocalMediaPath } from './media.mjs'
import { createReelPlan, summarizeReferenceTiming } from './plan.mjs'
import { renderReel } from './render.mjs'

const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value)
const inside = (root, file) => { const relative = path.relative(root, file); return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) }
function measuredMetadata(metadata) {
  if (!metadata) return null
  const { durationSeconds, hasVideo, hasAudio, width, height, fps } = metadata
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || typeof hasVideo !== 'boolean' || typeof hasAudio !== 'boolean') throw new Error('Invalid measured media metadata')
  return { durationSeconds, hasVideo, hasAudio, width, height, fps }
}

/** root and executable paths belong to the local host, never to model/tool arguments. */
export function createReelWorkspace({ root, ffmpegPath, ffprobePath }) {
  if (!path.isAbsolute(root || '')) throw new Error('An absolute workspace root is required')
  const index = createReelIndex({ root })
  const binaries = { ffmpegPath, ffprobePath }
  async function readWorkspaceJson(file) {
    if (typeof file !== 'string' || path.isAbsolute(file) || !inside(root, path.resolve(root, file))) throw new Error('Expected a workspace-relative JSON path')
    const resolved = await realpath(path.resolve(root, file))
    if (!inside(await realpath(root), resolved)) throw new Error('JSON file is outside the workspace')
    if ((await stat(resolved)).size > 8 * 1024 ** 2) throw new Error('JSON file is too large')
    return JSON.parse(await readFile(resolved, 'utf8'))
  }
  async function writeWorkspaceJson(file, value) {
    if (typeof file !== 'string' || path.isAbsolute(file) || !inside(root, path.resolve(root, file)) || path.extname(file).toLowerCase() !== '.json') throw new Error('Expected a workspace-relative JSON output path')
    const parent = await realpath(path.dirname(path.resolve(root, file)))
    const destination = path.join(parent, path.basename(file))
    if (!inside(await realpath(root), destination)) throw new Error('JSON output is outside the workspace')
    await writeFile(destination, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  }
  async function registeredAssets() {
    const project = await readWorkspaceJson('project.json')
    if (project.schemaVersion !== 1 || !Array.isArray(project.assets) || project.assets.length > 200) throw new Error('Invalid reel project manifest')
    const libraryRoot = await realpath(path.join(root, 'media'))
    if (!inside(await realpath(root), libraryRoot)) throw new Error('Media library is outside the workspace')
    const seen = new Set()
    return Promise.all(project.assets.map(async asset => {
      if (!validId(asset.id) || seen.has(asset.id)) throw new Error('Asset IDs must be unique letters, digits, underscores or dashes')
      seen.add(asset.id)
      if (typeof asset.file !== 'string' || path.isAbsolute(asset.file)) throw new Error('Asset files must be relative to media/')
      const filePath = await validateLocalMediaPath(path.resolve(libraryRoot, asset.file), [libraryRoot])
      return { id: asset.id, filePath }
    }))
  }
  async function assetMetadata(ids) {
    return Promise.all((await registeredAssets()).filter(asset => !ids || ids.has(asset.id)).map(async asset => {
      const stored = await readWorkspaceJson(`analysis/${asset.id}.json`)
      const current = await stat(asset.filePath)
      if (stored.assetId !== asset.id || stored.source.filePath !== asset.filePath || stored.source.size !== current.size || stored.source.mtimeMs !== current.mtimeMs) throw new Error(`Asset ${asset.id} changed; analyze it again`)
      if (!stored.analysis.metadata) throw new Error(`Asset ${asset.id} has no measured metadata; configure FFmpeg/FFprobe and analyze again`)
      return { ...measuredMetadata(stored.analysis.metadata), ...asset }
    }))
  }
  async function analyze({ assetId, referenceId, source }) {
    if (!validId(assetId) || (referenceId != null && !validId(referenceId))) throw new Error('Invalid asset or reference ID')
    if (referenceId != null && (!source?.url || !source?.title)) throw new Error('Reference source URL and title are required')
    const asset = (await registeredAssets()).find(item => item.id === assetId)
    if (!asset) throw new Error('Unknown registered asset')
    const before = await stat(asset.filePath)
    const analysis = await analyzeLocalMedia({ filePath: asset.filePath, allowedRoots: [path.join(root, 'media')], ...binaries })
    const after = await stat(asset.filePath)
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('Media changed during analysis')
    await mkdir(path.join(root, 'analysis'), { recursive: true })
    // Reject a symlinked analysis directory before writing private state.
    if (!inside(await realpath(root), await realpath(path.join(root, 'analysis')))) throw new Error('Analysis directory is outside the workspace')
    const stored = { assetId, source: { filePath: asset.filePath, size: after.size, mtimeMs: after.mtimeMs }, analysis }
    const destination = path.join(root, 'analysis', `${assetId}.json`)
    const temporary = `${destination}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(stored, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
      await rename(temporary, destination)
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
    if (referenceId != null && analysis.metadata?.hasVideo && analysis.sections.length && analysis.analyzedDurationSeconds >= analysis.metadata.durationSeconds - .05) {
      await index.upsertReference({ id: referenceId, source, durationSeconds: analysis.metadata.durationSeconds,
        analysis: { method: 'measured_scene_boundaries', version: '1', notes: analysis.limitations.join(' ') || 'No semantic video interpretation performed' },
        segments: analysis.sections.map(section => ({ id: `${referenceId}-${section.index}`, startSeconds: section.startSeconds, endSeconds: section.endSeconds,
          observations: { evidence: 'Measured boundary timing; no visual or speech interpretation performed.' },
          features: { shotDurationSeconds: section.durationSeconds, normalizedPosition: section.startSeconds / analysis.metadata.durationSeconds } })) })
    }
    return stored
  }
  return {
    capabilities: () => getMediaCapabilities(binaries), readWorkspaceJson, writeWorkspaceJson, analyze,
    async assets() {
      return Promise.all((await registeredAssets()).map(async asset => {
        try {
          const stored = await readWorkspaceJson(`analysis/${asset.id}.json`)
          const current = await stat(asset.filePath)
          const changed = stored.assetId !== asset.id || stored.source.filePath !== asset.filePath || stored.source.size !== current.size || stored.source.mtimeMs !== current.mtimeMs
          return { id: asset.id, status: changed ? 'changed' : stored.analysis.status, metadata: changed ? null : measuredMetadata(stored.analysis.metadata) }
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
          return { id: asset.id, status: 'not_analyzed', metadata: null }
        }
      }))
    },
    importReference: reference => index.upsertReference(reference),
    references: () => index.listReferences(), reference: id => index.getReference(id), search: query => index.search(query),
    embeddingSpaces: () => index.listEmbeddingSpaces(),
    async timing({ referenceIds } = {}) {
      const ids = referenceIds ?? (await index.listReferences()).map(reference => reference.id)
      return summarizeReferenceTiming(await Promise.all(ids.map(async id => { const ref = await index.getReference(id); if (!ref) throw new Error('Unknown reference'); return ref })))
    },
    async plan(request) {
      const reference = await index.getReference(request.referenceId)
      const ids = new Set([...(request.shots || []).map(shot => shot.assetId), ...(request.music ? [request.music.assetId] : [])])
      return createReelPlan({ ...request, reference, assets: await assetMetadata(ids) })
    },
    async render({ plan, outputFile }) {
      if (typeof outputFile !== 'string' || path.isAbsolute(outputFile) || !inside(root, path.resolve(root, outputFile))) throw new Error('Output must be a workspace-relative MP4 path')
      const ids = new Set([...(plan?.shots || []).map(shot => shot.assetId), ...(plan?.music ? [plan.music.assetId] : [])])
      return renderReel({ plan, assets: await assetMetadata(ids), outputPath: path.resolve(root, outputFile), allowedRoots: [await realpath(root)], ...binaries })
    },
  }
}
