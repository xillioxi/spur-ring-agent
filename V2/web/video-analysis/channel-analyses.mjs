import { mkdir, lstat, readFile, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { replaceIndex } from './atomic-index.mjs'

const MAX_BYTES = 1024 * 1024
const now = () => new Date().toISOString()
const fail = (message, status = 422) => Object.assign(new Error(message), { status })
const running = job => job && ['running', 'stopping'].includes(job.status)

export function uniqueSavedChannelVideos(items) {
  const chosen = new Map()
  const priority = item => item.result || item.hasResult ? 2 : item.status === 'failed' && !item.hasMedia ? 0 : 1
  for (const item of items) {
    let key = item.id
    if (item.source?.kind !== 'upload' && item.source?.url) {
      try {
        const url = new URL(item.source.url), match = url.pathname.match(/^\/(?:reel|reels|p|tv)\/([^/]+)/)
        if (['instagram.com', 'www.instagram.com'].includes(url.hostname) && match) key = `instagram:${match[1]}`
        else { url.search = ''; url.hash = ''; key = url.href.replace(/\/$/, '') }
      } catch { key = item.source.url }
    }
    const previous = chosen.get(key)
    if (!previous || priority(item) > priority(previous) || priority(item) === priority(previous) && item.updatedAt > previous.updatedAt) chosen.set(key, item)
  }
  return [...chosen.values()].filter(item => item.hasMedia)
}

// A durable snapshot of saved media, feeding the existing bounded analysis queue.
export function createChannelAnalysisManager({ root, getItems, analyzeOne }) {
  const filename = join(root, 'channel-analysis-job.json')
  let job = null, loaded = false, serial = Promise.resolve(), worker = null
  const exclusive = work => { const result = serial.then(work, work); serial = result.catch(() => {}); return result }
  const summary = () => job ? {
    id: job.id, channelId: job.channelId, analysisModelId: job.analysisModelId, analysisWorkflowId: job.analysisWorkflowId || 'standard', scriptTemplateId: job.scriptTemplateId || 'none', status: job.status, total: job.entries.length,
    processed: job.entries.filter(entry => entry.status !== 'pending').length,
    analyzed: job.entries.filter(entry => entry.status === 'analyzed').length,
    partial: job.entries.filter(entry => entry.status === 'analyzed' && entry.partial).length,
    skipped: job.entries.filter(entry => entry.status === 'skipped').length,
    failed: job.entries.filter(entry => entry.status === 'failed').length,
    currentItemId: job.currentItemId, message: job.message,
    failures: job.entries.filter(entry => entry.status === 'failed').slice(0, 20).map(entry => ({ itemId: entry.itemId, url: entry.url, error: entry.error })),
    createdAt: job.createdAt, updatedAt: job.updatedAt,
  } : null
  async function checkFile() {
    const info = await lstat(filename).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (info && (info.isSymbolicLink() || !info.isFile() || info.size > MAX_BYTES)) throw fail('Channel analysis progress storage is unavailable. Existing files were preserved.', 503)
    return info
  }
  async function persist() {
    await checkFile()
    const text = JSON.stringify({ schemaVersion: 1, job })
    if (Buffer.byteLength(text) > MAX_BYTES) throw fail('This channel analysis exceeds its progress storage limit.', 507)
    const temporary = join(root, `.channel-analysis-${randomUUID()}.tmp`)
    try { await writeFile(temporary, text, { flag: 'wx', mode: 0o600 }); await replaceIndex(temporary, filename) }
    finally { await unlink(temporary).catch(() => {}) }
  }
  async function load() {
    if (loaded) return
    await mkdir(root, { recursive: true })
    if (await checkFile()) {
      let data
      try { data = JSON.parse(await readFile(filename, 'utf8')) } catch { throw fail('Saved channel analysis progress could not be read. Existing files were preserved.', 503) }
      if (data?.schemaVersion !== 1 || !data.job || !Array.isArray(data.job.entries) || data.job.entries.length > 200 || !['running', 'stopping', 'cancelled', 'complete', 'paused'].includes(data.job.status) || data.job.entries.some(entry => !entry || !/^[a-f0-9-]{36}$/.test(entry.itemId) || !['pending', 'analyzed', 'skipped', 'failed'].includes(entry.status))) throw fail('Saved channel analysis progress is invalid. Existing files were preserved.', 503)
      job = data.job
      if (running(job)) { job.status = 'paused'; job.currentItemId = undefined; job.message = 'Analysis was interrupted by a server restart. Choose Analyze all videos to continue; completed results will be skipped.'; job.updatedAt = now(); await persist() }
    }
    loaded = true
  }
  async function work(id,context) {
    try {
      for (;;) {
        const entry = await exclusive(async () => {
          if (job.id !== id) return null
          if (job.status === 'stopping') { job.status = 'cancelled'; job.currentItemId = undefined; job.message = 'Stopped. Saved videos and analysis results are still available.'; job.updatedAt = now(); await persist(); return null }
          if (job.status !== 'running') return null
          const next = job.entries.find(value => value.status === 'pending')
          if (!next) { job.status = 'complete'; job.currentItemId = undefined; job.message = 'Finished analyzing saved videos. Review any partial results or failures below.'; job.updatedAt = now(); await persist(); return null }
          job.currentItemId = next.itemId; job.updatedAt = now(); await persist()
          return { ...next }
        })
        if (!entry) break
        let result, cause
        try { result = await analyzeOne(entry.itemId, job.channelId, context) } catch (error) { cause = error }
        await exclusive(async () => {
          if (job.id !== id) return
          const current = job.entries.find(value => value.itemId === entry.itemId)
          if ([429, 503, 507].includes(cause?.status)) { job.status = 'paused'; job.message = String(cause.message).slice(0, 400); job.currentItemId = undefined }
          else if (cause || !result?.hasResult || !['complete', 'partial'].includes(result.status)) { current.status = 'failed'; current.error = String(cause?.message || result?.error || 'This video could not be analyzed.').slice(0, 400) }
          else { current.status = result.skipped ? 'skipped' : 'analyzed'; current.partial = result.status === 'partial' }
          job.updatedAt = now(); await persist()
        })
      }
    } catch {
      await exclusive(async () => { if (job?.id === id) { job.status = 'paused'; job.currentItemId = undefined; job.message = 'Analysis paused because progress could not be saved. Existing results were preserved.'; job.updatedAt = now(); await persist().catch(() => {}) } })
    }
  }
  return {
    async get(channelId) { return exclusive(async () => { await load(); return channelId === undefined || job?.channelId === channelId ? summary() : null }) },
    async start(channelId,{analysisModelId,analysisWorkflowId='standard',scriptTemplateId='none',context}={}) {
      const items = await getItems(channelId)
      return exclusive(async () => {
        await load()
        if (running(job) || worker) {
          if (job.channelId === channelId && job.analysisModelId === analysisModelId && (job.analysisWorkflowId || 'standard') === analysisWorkflowId && (job.scriptTemplateId || 'none') === scriptTemplateId) return summary()
          throw fail('Another channel analysis is running. Stop it or wait for it to finish.', 409)
        }
        const entries = uniqueSavedChannelVideos(items).map(item => ({ itemId: item.id, url: item.source?.url, status: 'pending' }))
        if (!entries.length) throw fail('No saved videos are available in this channel. Import or upload videos first.')
        const previous = job, timestamp = now()
        job = { id: randomUUID(), channelId, analysisModelId, analysisWorkflowId, scriptTemplateId, status: 'running', entries, message: 'Analyzing saved videos with the selected workflow and script structure. Up-to-date analyses are skipped.', createdAt: timestamp, updatedAt: timestamp }
        try { await persist() } catch (error) { job = previous; throw error }
        const id = job.id
        const snapshot = context && typeof context === 'object' ? Object.freeze({ ...context, scriptTemplateId, workflowId: analysisWorkflowId }) : context
        worker = new Promise(resolve => setImmediate(resolve)).then(() => work(id,snapshot)).finally(() => { worker = null })
        return summary()
      })
    },
    async stop(channelId) { return exclusive(async () => { await load(); if (job?.channelId !== channelId) return null; if (running(job)) { job.status = 'stopping'; job.message = 'Stopping analysis after the current video finishes.'; job.updatedAt = now(); await persist() } return summary() }) },
    async whenIdle() { if (worker) await worker },
  }
}
