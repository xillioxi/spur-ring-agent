import { createReadStream, realpath as resolveRealPath } from 'node:fs'
import { mkdir, readdir, readFile, writeFile, stat, lstat, rm } from 'node:fs/promises'
import { promisify } from 'node:util'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { replaceIndex } from './atomic-index.mjs'
import { reconstructionCapability, submitReconstructionClip, getReconstructionClip, downloadReconstructionClip } from './reconstruction-provider.mjs'
import { renderReconstruction } from './reconstruction-render.mjs'

export const RECONSTRUCTION_LIMITS = Object.freeze({ maxClips: 24, maxDurationSeconds: 300, maxBillableSeconds: 360, maxWorkspaceBytes: 2 * 1024 ** 3, maxQueuedJobs: 8 })
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/
// The callback resolver also works in Windows AppContainer environments where
// Node's native realpath binding cannot open ancestor directory handles.
const realpath = promisify(resolveRealPath)
const ACTIVE = new Set(['queued', 'submitting', 'generating', 'rendering', 'importing'])
const FINAL = new Set(['completed', 'failed', 'submission_unknown', 'paused'])
const MAX_CLIP_BYTES = 150 * 1024 ** 2
const clean = (value, max = 8000) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max) : ''
const round = value => Math.round(value * 1000) / 1000
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const copy = value => JSON.parse(JSON.stringify(value))
const fail = (message, status = 422, code = 'reconstruction_invalid_request') => Object.assign(new Error(message), { status, code, definitive: true })
const validId = id => { if (typeof id !== 'string' || !UUID.test(id)) throw fail('Reconstruction or reference not found.', 404, 'not_found'); return id }
const sleep = milliseconds => new Promise(resolve => { const timer = setTimeout(resolve, milliseconds); timer.unref?.() })

function inferRatio(metadata) {
  const aspect = Number(metadata?.width) / Number(metadata?.height)
  const ratios = ['1:1', '3:4', '4:3', '9:16', '16:9', '21:9']
  return Number.isFinite(aspect) && aspect > 0 ? ratios.reduce((best, ratio) => Math.abs(Math.log(aspect / (Number(ratio.split(':')[0]) / Number(ratio.split(':')[1])))) < Math.abs(Math.log(aspect / (Number(best.split(':')[0]) / Number(best.split(':')[1])))) ? ratio : best) : '9:16'
}

function referencePlan(item, capability) {
  const workflowId = item.result?.provenance?.workflow?.id || item.result?.analysisWorkflowId || (item.result?.reaVideo ? 'rea-video' : 'standard')
  // Local technical classifications do not describe the visual actions needed
  // for automatic remake prompts. An explicit authored timeline remains valid.
  if (workflowId === 'rea-video') throw fail('Run a model breakdown before automatic recreation. Rea Video technical reports do not contain reviewed visual actions.', 409, 'reconstruction_analysis_required')
  const shots = item.result?.shots
  if (!Array.isArray(shots) || !shots.length) throw fail('Run a complete shot breakdown before reconstructing this reference.', 409, 'reconstruction_analysis_required')
  const duration = Number(item.result?.metadata?.durationSeconds ?? item.durationSeconds ?? item.result?.durationSeconds)
  if (!Number.isFinite(duration) || duration <= 0 || duration > 300) throw fail('Reconstruction requires a reference of five minutes or less.')
  const clips = [], warnings = ['This recreates the analyzed shot plan with generated footage; it does not promise matching pixels, identity or production quality.']
  let cursor = 0
  for (let shotIndex = 0; shotIndex < shots.length; shotIndex++) {
    const shot = shots[shotIndex], start = shot.startSeconds, end = shot.endSeconds
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > duration + 0.002 || Math.abs(start - cursor) > 0.002) throw fail('The shot breakdown has gaps, overlaps or invalid timing. Run Video + audio again before reconstructing the complete video.', 409, 'reconstruction_incomplete_timeline')
    if (!clean(shot.visual)) throw fail('Every reference shot needs a visual description before reconstruction.', 409, 'reconstruction_analysis_required')
    const description = [['Visual', shot.visual], ['Action', shot.action], ['Framing', shot.framing], ['Camera movement', shot.cameraMovement]].filter(([, value]) => clean(value)).map(([label, value]) => `${label}: ${clean(value, 1600)}`).join('\n')
    for (let from = start; from < end - 0.0005; from += 15) {
      const to = Math.min(from + 15, end), actual = round(to - from)
      if (actual < 1 / 30) throw fail('A shot is shorter than one output frame. Combine very short shots before reconstruction.', 409, 'reconstruction_incomplete_timeline')
      clips.push({ index: clips.length, sourceShotIndex: shotIndex, startSeconds: round(from), endSeconds: round(to), durationSeconds: actual, requestDurationSeconds: Math.max(5, Math.ceil(actual)), prompt: `${description}\nCreate one coherent shot matching this visible action and composition. Do not add captions, logos or a soundtrack. This clip continues shot ${shotIndex + 1}${end - start > 15 ? `, segment ${Math.floor((from - start) / 15) + 1}` : ''}.`.slice(0, 8000) })
      if (clips.length > RECONSTRUCTION_LIMITS.maxClips) throw fail('This breakdown needs more than 24 generated clips. Choose a shorter reference or combine shots.', 409, 'reconstruction_clip_limit')
    }
    cursor = end
  }
  if (Math.abs(cursor - duration) > 0.002) throw fail('The shot breakdown does not cover the end of the reference. Run Video + audio again before reconstruction.', 409, 'reconstruction_incomplete_timeline')
  const billableSeconds = clips.reduce((total, clip) => total + clip.requestDurationSeconds, 0)
  if (billableSeconds > RECONSTRUCTION_LIMITS.maxBillableSeconds) throw fail('This plan exceeds the 360 generated-second limit. Choose a shorter reference or combine shots.', 409, 'reconstruction_clip_limit')
  const hasReferenceAudio = item.result.metadata?.hasAudio === true, ratio = inferRatio(item.result.metadata)
  const content = { referenceId: item.id, referenceDurationSeconds: round(duration), totalDurationSeconds: round(clips.reduce((total, clip) => total + clip.durationSeconds, 0)), ratio, hasReferenceAudio, clips }
  if (billableSeconds > content.totalDurationSeconds) warnings.push(`The model generates at least five seconds per clip: ${billableSeconds} generated seconds are requested, then trimmed to the ${content.totalDurationSeconds} second shot plan.`)
  return { ...content, planRevision: hash(content), billableSeconds, audioMode: hasReferenceAudio ? 'reference' : 'silent', resolution: '480p', warnings, capability: { ...capability, defaultResolution: '480p' }, limits: { ...RECONSTRUCTION_LIMITS } }
}

function authoredTimelinePlan(item, capability, timeline) {
  if (!Array.isArray(timeline) || !timeline.length || timeline.length > RECONSTRUCTION_LIMITS.maxClips) throw fail('Provide one to 24 authored timeline clips.')
  const referenceDuration = Number(item.result?.metadata?.durationSeconds ?? item.durationSeconds ?? item.result?.durationSeconds)
  if (item.hasMedia === false || !Number.isFinite(referenceDuration) || referenceDuration <= 0 || referenceDuration > RECONSTRUCTION_LIMITS.maxDurationSeconds) throw fail('An authored recreation requires a saved reference of five minutes or less.', 409, 'reconstruction_analysis_required')
  let cursor = 0, gapSeconds = 0
  const clips = timeline.map((shot, index) => {
    if (!shot || typeof shot !== 'object' || Array.isArray(shot) || Object.keys(shot).some(key => !['startSeconds', 'endSeconds', 'prompt'].includes(key)) || !Number.isFinite(shot.startSeconds) || !Number.isFinite(shot.endSeconds) || typeof shot.prompt !== 'string') throw fail('Each authored clip needs only numeric startSeconds, endSeconds and a prompt.')
    const start = round(shot.startSeconds), end = round(shot.endSeconds), duration = round(end - start), prompt = shot.prompt.trim()
    if (shot.startSeconds < 0 || shot.endSeconds > RECONSTRUCTION_LIMITS.maxDurationSeconds || start < cursor || duration < 1 / 30 || duration > 15 || !prompt || prompt.length > 8000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(prompt)) throw fail('Authored clips must be ordered without overlap, last one frame to 15 seconds, and have a prompt of 1–8,000 characters. The target must be five minutes or less.')
    gapSeconds += start - cursor; cursor = end
    return { index, startSeconds: start, endSeconds: end, durationSeconds: duration, requestDurationSeconds: Math.max(5, Math.ceil(duration)), prompt }
  })
  const hasReferenceAudio = item.result?.metadata?.hasAudio === true, ratio = inferRatio(item.result?.metadata), billableSeconds = clips.reduce((total, clip) => total + clip.requestDurationSeconds, 0)
  if (billableSeconds > RECONSTRUCTION_LIMITS.maxBillableSeconds) throw fail('This plan exceeds the 360 generated-second limit.', 409, 'reconstruction_clip_limit')
  const content = { source: 'authored_timeline', referenceId: item.id, referenceDurationSeconds: round(referenceDuration), totalDurationSeconds: cursor, ratio, hasReferenceAudio, clips }
  const warnings = ['This recreation uses the authored prompts and timeline. The saved reference analysis is unchanged.', 'The current generation adapter uses text-to-video at 480p or 768p. Image placeholders, first/last-frame conditioning and 2K settings are not applied.', `The model requests ${billableSeconds} generated seconds, then trims each clip to its authored timing.`]
  if (gapSeconds) warnings.push(`${round(gapSeconds)} seconds of authored timeline gaps are rendered as black; gaps do not submit generation requests.`)
  return { ...content, planRevision: hash(content), billableSeconds, audioMode: hasReferenceAudio ? 'reference' : 'silent', resolution: '480p', warnings, capability: { ...capability, defaultResolution: '480p' }, limits: { ...RECONSTRUCTION_LIMITS } }
}

const stageMessage = { queued: 'Waiting to generate the shot plan', submitting: 'Submitting one generated shot', generating: 'Generating and downloading shots', rendering: 'Assembling generated shots', importing: 'Saving the reconstructed video', completed: 'Reconstructed video is ready', failed: 'Reconstruction could not finish', paused: 'Status or download paused; resume the existing generation request', submission_unknown: 'Submission is unconfirmed; generation will not be submitted again automatically' }
function publicJob(job) {
  const fields = ['id', 'requestKey', 'referenceId', 'planRevision', 'source', 'provider', 'model', 'status', 'createdAt', 'updatedAt', 'totalDurationSeconds', 'referenceDurationSeconds', 'billableSeconds', 'ratio', 'audioMode', 'resolution', 'outputItemId', 'error', 'retryable', 'warnings', 'analysisStatus', 'comparison']
  return { ...Object.fromEntries(fields.filter(key => job[key] !== undefined).map(key => [key, copy(job[key])])), stage: job.status, message: stageMessage[job.status], hasMedia: Boolean(job.outputItemId || job.rendered), clips: job.clips.map(clip => Object.fromEntries(['index', 'sourceShotIndex', 'startSeconds', 'endSeconds', 'durationSeconds', 'requestDurationSeconds', 'prompt', 'status', 'error'].filter(key => clip[key] !== undefined).map(key => [key, copy(clip[key])]))) }
}

export function createReconstructionService({ root, referenceService, config = {}, getConfig, provider, render = renderReconstruction, now = Date.now, wait = sleep, pollIntervalMs = 5000, maxPolls = 180, maxReadFailures = 4 } = {}) {
  if (typeof root !== 'string' || !root.trim() || root.includes('\0') || !referenceService?.get || !referenceService?.upload) throw fail('Private reconstruction storage is not configured.', 503, 'reconstruction_configuration')
  const storageRoot = path.resolve(root), jobsRoot = path.join(storageRoot, 'reconstructions')
  const adapter = { capability: reconstructionCapability, submit: submitReconstructionClip, get: getReconstructionClip, download: downloadReconstructionClip, ...provider }
  const jobs = new Map(), pending = []
  let loaded = false, serial = Promise.resolve(), worker = null
  const settings = async () => await getConfig?.() || config
  const exclusive = work => { const result = serial.then(work, work); serial = result.catch(() => {}); return result }
  const date = () => new Date(now()).toISOString()
  const jobRoot = id => path.join(jobsRoot, validId(id))
  const manifest = id => path.join(jobRoot(id), 'manifest.json')
  async function directoryBytes(directory) {
    let total = 0
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw fail('Reconstruction storage contains an unsupported link.', 503, 'reconstruction_storage')
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) total += await directoryBytes(file)
      else if (entry.isFile()) total += (await stat(file)).size
      if (total > RECONSTRUCTION_LIMITS.maxWorkspaceBytes) break
    }
    return total
  }
  async function ensureStorage(extra = 0) {
    if (await directoryBytes(storageRoot) + extra > RECONSTRUCTION_LIMITS.maxWorkspaceBytes) throw fail('The video workspace has reached its 2 GiB limit.', 507, 'reconstruction_storage_full')
  }
  async function persist(job) {
    job.updatedAt = date()
    const target = manifest(job.id), temporary = path.join(jobRoot(job.id), `${randomUUID()}.tmp`)
    const data = JSON.stringify(job)
    if (Buffer.byteLength(data) > 1024 ** 2) throw fail('The reconstruction plan is too large.', 413)
    await mkdir(jobRoot(job.id), { recursive: true })
    try { await writeFile(temporary, data, { flag: 'wx', mode: 0o600 }); await replaceIndex(temporary, target) } finally { await rm(temporary, { force: true }).catch(() => {}) }
  }
  const safeReason = error => error?.code?.startsWith('reconstruction_') ? ({ 401: 'The generation service rejected the server credentials.', 403: 'The generation service denied access.', 429: 'The generation service is rate limited.', 507: 'The video workspace has reached its 2 GiB limit.' }[error.status] || (error.code === 'reconstruction_render_failed' ? 'Generated clips could not be assembled at the planned duration. No reference visuals were substituted.' : 'The video service could not complete this step. Existing generation requests were preserved.')) : 'The reconstruction could not complete this step. Existing generation requests were preserved.'
  async function load() {
    if (loaded) return
    await mkdir(jobsRoot, { recursive: true })
    const rootInfo = await lstat(jobsRoot)
    if (rootInfo.isSymbolicLink() || await realpath(jobsRoot) !== path.resolve(jobsRoot)) throw fail('Reconstruction storage must stay inside its private workspace.', 503, 'reconstruction_storage')
    for (const entry of await readdir(jobsRoot, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw fail('Reconstruction storage contains an unsupported link.', 503, 'reconstruction_storage')
      if (!entry.isDirectory() || !UUID.test(entry.name)) continue
      let job
      try {
        const text = await readFile(manifest(entry.name), 'utf8')
        if (Buffer.byteLength(text) > 1024 ** 2) throw new Error()
        job = JSON.parse(text)
        if (job.schemaVersion !== 1 || job.id !== entry.name || !UUID.test(job.requestKey || '') || !UUID.test(job.referenceId || '') || ![...ACTIVE, ...FINAL].includes(job.status) || !Array.isArray(job.clips) || !job.clips.length || job.clips.length > 24) throw new Error()
      } catch { throw fail('Saved reconstruction progress could not be read. Existing files were preserved.', 503, 'reconstruction_storage') }
      jobs.set(job.id, job)
      if (job.clips.some(clip => clip.status === 'submitting' && !clip.requestId)) {
        for (const clip of job.clips) if (clip.status === 'submitting' && !clip.requestId) clip.status = 'submission_unknown'
        job.status = 'submission_unknown'; job.error = 'A submission was interrupted before its provider receipt was saved. It will not be submitted again automatically.'; job.retryable = false; await persist(job)
      } else if (ACTIVE.has(job.status)) pending.push(job.id)
    }
    loaded = true
    if (pending.length) schedule()
  }
  function schedule() {
    if (worker) return
    worker = new Promise(resolve => setImmediate(resolve)).then(async () => { while (pending.length) { const id = pending.shift(); await work(jobs.get(id)) } }).finally(() => { worker = null; if (pending.length) schedule() })
  }
  async function pollAndDownload(job, clip, currentConfig) {
    const pausedRead = () => Object.assign(fail('Status or download checks paused. Resume this job to check the same generation request without submitting it again.', 503, 'reconstruction_read_paused'), { recoverableRead: true })
    let failures = 0
    for (let attempt = 0; attempt < maxPolls; attempt++) {
      try {
        const value = await adapter.get({ config: currentConfig, requestId: clip.requestId })
        if (value.status === 'failed') throw fail('The generation provider reported a failed shot.', 502, 'reconstruction_generation_failed')
        if (value.status === 'ready') {
          clip.status = 'downloading'; await persist(job)
          await ensureStorage(MAX_CLIP_BYTES)
          const bytes = await adapter.download(value.url, {})
          if (!Buffer.isBuffer(bytes) || bytes.length < 12 || bytes.length > MAX_CLIP_BYTES || bytes.toString('ascii', 4, 8) !== 'ftyp') throw fail('The generation provider did not return a bounded MP4 clip.', 502, 'reconstruction_invalid_media')
          const file = path.join(jobRoot(job.id), `clip-${clip.index}.mp4`)
          await writeFile(file, bytes, { mode: 0o600 })
          clip.status = 'completed'; clip.bytes = bytes.length; delete clip.error; await persist(job)
          return
        }
        if (!['queued', 'generating'].includes(value.status)) throw fail('The generation provider returned an unknown status.', 502, 'reconstruction_generation_failed')
        clip.status = value.status; job.status = 'generating'; await persist(job); failures = 0
      } catch (error) {
        if (['reconstruction_generation_failed', 'reconstruction_invalid_media', 'reconstruction_configuration', 'reconstruction_invalid_request', 'reconstruction_cancelled', 'reconstruction_storage'].includes(error?.code) || [400, 401, 403, 413, 415, 422, 507].includes(error?.status)) throw error
        if (++failures >= maxReadFailures) throw pausedRead()
        clip.error = 'Status or download is temporarily unavailable. Retrying the existing provider request without generating again.'; await persist(job)
      }
      await wait(pollIntervalMs)
    }
    throw pausedRead()
  }
  async function work(job) {
    if (!job || FINAL.has(job.status)) return
    try {
      const currentConfig = await settings(), available = adapter.capability(currentConfig)
      if (!available.available) throw fail(available.reason || 'Video generation is not configured.', 503, 'reconstruction_configuration')
      const source = await referenceService.get(job.referenceId)
      for (const clip of job.clips) {
        if (clip.status === 'completed') continue
        if (clip.status === 'submission_unknown') { job.status = 'submission_unknown'; job.retryable = false; await persist(job); return }
        if (!clip.requestId) {
          await ensureStorage(MAX_CLIP_BYTES)
          clip.status = 'submitting'; job.status = 'submitting'; await persist(job)
          let receipt
          try { receipt = await adapter.submit({ config: currentConfig, prompt: clip.prompt, durationSeconds: clip.requestDurationSeconds, ratio: job.ratio, resolution: job.resolution }) }
          catch (error) {
            if (error?.definitive !== true) { clip.status = 'submission_unknown'; job.status = 'submission_unknown'; job.error = 'The provider may have accepted this shot, but no confirmed receipt was saved. It will not be generated again automatically.'; job.retryable = false; await persist(job); return }
            throw error
          }
          if (typeof receipt?.requestId !== 'string' || !receipt.requestId || receipt.requestId.length > 200) { clip.status = 'submission_unknown'; job.status = 'submission_unknown'; job.error = 'The provider did not return a usable submission receipt. It will not be generated again automatically.'; job.retryable = false; await persist(job); return }
          clip.requestId = receipt.requestId; clip.status = 'queued'; job.status = 'generating'; await persist(job)
        }
        await pollAndDownload(job, clip, currentConfig)
      }
      const outputPath = path.join(jobRoot(job.id), 'output.mp4')
      if (!job.rendered) {
        job.status = 'rendering'; await persist(job)
        const media = job.audioMode === 'reference' ? await referenceService.getMedia(source.id) : null
        const result = await render({ clips: job.clips.map(clip => ({ filePath: path.join(jobRoot(job.id), `clip-${clip.index}.mp4`), durationSeconds: clip.durationSeconds, startSeconds: clip.startSeconds, endSeconds: clip.endSeconds })), totalDurationSeconds: job.totalDurationSeconds, referencePath: media?.filePath, audioMode: job.audioMode, outputPath, ratio: job.ratio, resolution: job.resolution, config: currentConfig, ensureStorage })
        const info = await stat(outputPath)
        if (!info.isFile() || !info.size || info.size > 48 * 1024 ** 2) throw fail('The assembled video exceeds its analysis size limit.', 413, 'reconstruction_invalid_media')
        job.rendered = true; job.outputBytes = info.size; job.warnings.push(...(result?.warnings || []).filter(value => typeof value === 'string').slice(0, 10)); await persist(job)
      }
      if (!job.outputItemId) {
        job.status = 'importing'; await persist(job)
        const existing = referenceService.list ? (await referenceService.list()).find(item => item.source?.kind === 'reconstruction' && item.source.reconstructionId === job.id) : null
        if (existing) job.outputItemId = existing.id
        else {
          await ensureStorage(job.outputBytes)
          const imported = await referenceService.upload(createReadStream(outputPath), { filename: `reconstruction-${job.id}.mp4`, contentLength: job.outputBytes, contentType: 'video/mp4', reconstruction: { referenceId: job.referenceId, jobId: job.id } })
          job.outputItemId = validId(imported.id)
        }
      }
      job.status = 'completed'; job.retryable = false; delete job.error; await persist(job)
      for (const file of [...job.clips.map(clip => `clip-${clip.index}.mp4`), 'output.mp4']) await rm(path.join(jobRoot(job.id), file), { force: true }).catch(() => {})
    } catch (error) {
      const recoverable = error?.recoverableRead === true
      job.status = recoverable ? 'paused' : 'failed'; job.error = recoverable ? 'Status or download checks paused. Resume this job to recover the existing generation request; it will not be submitted again.' : safeReason(error); job.retryable = recoverable
      const clip = job.clips.find(value => !['completed', 'submission_unknown'].includes(value.status))
      if (clip) { clip.status = recoverable ? 'paused' : 'failed'; clip.error = job.error }
      await persist(job).catch(() => {})
    }
  }
  async function refreshComparison(job) {
    if (!job.outputItemId || !job.analysisStatus) return null
    const item = await referenceService.get(job.outputItemId)
    job.analysisStatus = item.status
    if (item.result && ['complete', 'partial'].includes(item.status)) {
      const generated = Number(item.result.metadata?.durationSeconds ?? item.durationSeconds), original = job.sourceSnapshot
      const words = text => new Set(clean(text, 12000).toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || [])
      const referenceWords = words(original.transcript), outputWords = words(item.result.script?.text)
      const union = new Set([...referenceWords, ...outputWords])
      job.comparison = { status: 'ready', referenceShotCount: original.shotCount, outputShotCount: item.result.shots?.length || 0, referenceDurationSeconds: original.durationSeconds, outputDurationSeconds: Number.isFinite(generated) ? round(generated) : null, durationDeltaSeconds: Number.isFinite(generated) ? round(generated - original.durationSeconds) : null, ...(union.size ? { transcriptWordOverlap: round([...referenceWords].filter(word => outputWords.has(word)).length / union.size) } : {}), note: 'Approximate analysis evidence only. Word overlap and detected shot counts do not measure visual similarity, identity or production quality.' }
    } else job.comparison = { status: 'pending', note: item.status === 'failed' ? 'Output analysis failed. The generated video remains available.' : 'The reconstructed output is being analyzed.' }
    await persist(job)
    return item
  }
  const service = {
    async capability() { return { ...adapter.capability(await settings()), defaultResolution: '480p', limits: { ...RECONSTRUCTION_LIMITS } } },
    async plan(referenceId, options = {}) {
      if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'timeline')) throw fail('Only an optional authored timeline is accepted when preparing a plan.')
      const item = await referenceService.get(validId(referenceId)), capability = await service.capability()
      return options.timeline === undefined ? referencePlan(item, capability) : authoredTimelinePlan(item, capability, options.timeline)
    },
    async create(referenceId, options = {}) {
      validId(referenceId)
      if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['requestKey', 'planRevision', 'shots', 'timeline', 'audioMode', 'resolution'].includes(key)) || !UUID.test(options.requestKey || '')) throw fail('Use a unique UUID requestKey and the reviewed plan revision.')
      return exclusive(async () => {
        await load()
        const prior = [...jobs.values()].find(value => value.requestKey === options.requestKey)
        const signature = hash({ referenceId, requestKey: options.requestKey, planRevision: options.planRevision, shots: options.shots, timeline: options.timeline, audioMode: options.audioMode, resolution: options.resolution })
        if (prior) { if (prior.requestSignature !== signature) throw fail('This requestKey already belongs to another reconstruction request.', 409, 'reconstruction_request_conflict'); return publicJob(prior) }
        const plan = await service.plan(referenceId, { timeline: options.timeline })
        if (!plan.capability.available) throw fail(plan.capability.reason || 'Video generation is not configured.', 503, 'reconstruction_configuration')
        if (options.planRevision !== plan.planRevision) throw fail('The reference breakdown changed. Review the current reconstruction plan before generating.', 409, 'reconstruction_stale_plan')
        if ([...jobs.values()].filter(value => ACTIVE.has(value.status)).length >= RECONSTRUCTION_LIMITS.maxQueuedJobs || jobs.size >= 100) throw fail('The reconstruction queue is full. Wait for existing jobs to finish.', 429, 'reconstruction_queue_full')
        const audioMode = options.audioMode ?? plan.audioMode, resolution = options.resolution ?? '480p'
        if (!['reference', 'silent'].includes(audioMode) || audioMode === 'reference' && !plan.hasReferenceAudio || !['480p', '768p'].includes(resolution)) throw fail('Choose an available audio mode and output resolution.')
        const edits = new Map()
        if (options.shots !== undefined) {
          if (!Array.isArray(options.shots) || options.shots.length > plan.clips.length) throw fail('Provide a bounded set of clip prompt edits.')
          for (const edit of options.shots) {
            if (!edit || Object.keys(edit).some(key => !['index', 'prompt'].includes(key)) || !Number.isInteger(edit.index) || edit.index < 0 || edit.index >= plan.clips.length || edits.has(edit.index) || typeof edit.prompt !== 'string' || !edit.prompt.trim() || edit.prompt.length > 8000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(edit.prompt)) throw fail('Each prompt edit needs one valid clip index and at most 8,000 characters.')
            edits.set(edit.index, edit.prompt.trim())
          }
        }
        const item = await referenceService.get(referenceId)
        const job = { schemaVersion: 1, id: randomUUID(), requestKey: options.requestKey, requestSignature: signature, referenceId, planRevision: plan.planRevision, ...(plan.source ? { source: plan.source } : {}), provider: plan.capability.provider, model: plan.capability.model, createdAt: date(), updatedAt: date(), status: 'queued', totalDurationSeconds: plan.totalDurationSeconds, referenceDurationSeconds: plan.referenceDurationSeconds, billableSeconds: plan.billableSeconds, ratio: plan.ratio, audioMode, resolution, warnings: plan.warnings, clips: plan.clips.map(clip => ({ ...clip, prompt: edits.get(clip.index) || clip.prompt, status: 'pending' })), sourceSnapshot: { durationSeconds: plan.referenceDurationSeconds, shotCount: item.result?.shots?.length || 0, transcript: clean(item.result?.script?.text, 12000) } }
        await ensureStorage(1024 ** 2); await persist(job); jobs.set(job.id, job); pending.push(job.id); schedule()
        return publicJob(job)
      })
    },
    async list(referenceId) { if (referenceId !== undefined) await referenceService.get(validId(referenceId)); return exclusive(async () => { await load(); const selected = [...jobs.values()].filter(job => referenceId === undefined || job.referenceId === referenceId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); for (const job of selected) if (job.analysisStatus && job.comparison?.status !== 'ready') await refreshComparison(job); return selected.map(publicJob) }) },
    async get(id) { return exclusive(async () => { await load(); const job = jobs.get(validId(id)); if (!job) throw fail('Reconstruction not found.', 404, 'not_found'); await refreshComparison(job); return publicJob(job) }) },
    async resume(id) {
      return exclusive(async () => {
        await load(); const job = jobs.get(validId(id))
        if (!job) throw fail('Reconstruction not found.', 404, 'not_found')
        if (ACTIVE.has(job.status)) return publicJob(job)
        if (job.status !== 'paused' || !job.retryable || job.clips.some(clip => clip.status === 'submission_unknown' || clip.status === 'submitting' && !clip.requestId) || !job.clips.some(clip => clip.status === 'paused' && typeof clip.requestId === 'string' && clip.requestId)) throw fail('This job has no confirmed paused generation request to resume.', 409, 'reconstruction_not_resumable')
        for (const clip of job.clips) if (clip.status === 'paused') {
          if (!clip.requestId) throw fail('A paused shot has no confirmed provider receipt. It will not be submitted again automatically.', 409, 'reconstruction_not_resumable')
          clip.status = 'queued'; delete clip.error
        }
        job.status = 'queued'; job.retryable = false; delete job.error
        await persist(job); pending.push(job.id); schedule()
        return publicJob(job)
      })
    },
    async getMedia(id) {
      await exclusive(load)
      const job = jobs.get(validId(id))
      if (!job || !job.rendered) throw fail('The reconstructed video is not ready.', 404, 'not_found')
      if (job.outputItemId) return { ...await referenceService.getMedia(job.outputItemId), extension: '.mp4' }
      const filePath = await realpath(path.join(jobRoot(job.id), 'output.mp4')), info = await stat(filePath)
      if (path.dirname(filePath) !== await realpath(jobRoot(job.id)) || !info.isFile()) throw fail('The reconstructed video is unavailable.', 404, 'not_found')
      return { filePath, size: info.size, extension: '.mp4' }
    },
    async analyzeOutput(id) {
      return exclusive(async () => {
        await load(); const job = jobs.get(validId(id))
        if (!job) throw fail('Reconstruction not found.', 404, 'not_found')
        if (!job.outputItemId || job.status !== 'completed') throw fail('Finish reconstruction before analyzing its output.', 409, 'reconstruction_not_ready')
        let item = await referenceService.get(job.outputItemId)
        if (!job.analysisStatus || item.status === 'failed') { item = await referenceService.analyze(job.outputItemId, { mode: 'both' }); job.analysisStatus = item.status; job.comparison = { status: 'pending' }; await persist(job) }
        else await refreshComparison(job)
        return { job: publicJob(job), item }
      })
    },
    async whenIdle() { await exclusive(load); while (worker) await worker; await serial },
  }
  return service
}
