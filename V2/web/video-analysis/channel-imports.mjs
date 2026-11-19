import { mkdir, lstat, readFile, writeFile, unlink } from 'node:fs/promises'
import { replaceIndex } from './atomic-index.mjs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const MAX_BYTES = 8 * 1024 * 1024
const now = () => new Date().toISOString()
const fail = (message, status = 422) => Object.assign(new Error(message), { status })
const running = job => job && ['running', 'stopping'].includes(job.status)

/** One durable channel import per workspace. Media still uses the host's bounded queue. */
export function createChannelImportManager({ root, getChannel, importOne }) {
  const filename = join(root, 'channel-import-job.json')
  let job = null, loaded = false, serial = Promise.resolve(), worker = null
  const exclusive = work => { const value = serial.then(work, work); serial = value.catch(() => {}); return value }
  const summary = () => job ? {
    id: job.id, channelId: job.channelId, status: job.status, total: job.entries.length,
    processed: job.entries.filter(entry => entry.status !== 'pending').length,
    imported: job.entries.filter(entry => entry.status === 'imported').length,
    skipped: job.entries.filter(entry => entry.status === 'skipped').length,
    failed: job.entries.filter(entry => entry.status === 'failed').length,
    currentUrl: job.currentUrl, message: job.message, coverageComplete: job.coverageComplete,
    failures: job.entries.filter(entry => entry.status === 'failed').slice(0, 20).map(entry => ({ url: entry.url, error: entry.error })),
    createdAt: job.createdAt, updatedAt: job.updatedAt,
  } : null
  async function checkFile() {
    const info = await lstat(filename).catch(cause => { if (cause.code === 'ENOENT') return null; throw cause })
    if (info && (info.isSymbolicLink() || !info.isFile() || info.size > MAX_BYTES)) throw fail('Channel import progress storage is unavailable. Existing files were preserved.', 503)
    return info
  }
  async function persist() {
    await checkFile()
    const text = JSON.stringify({ schemaVersion: 1, job })
    if (Buffer.byteLength(text) > MAX_BYTES) throw fail('This channel import exceeds its progress storage limit.', 507)
    const temporary = join(root, `.channel-import-${randomUUID()}.tmp`)
    try { await writeFile(temporary, text, { flag: 'wx', mode: 0o600 }); await replaceIndex(temporary, filename) }
    finally { await unlink(temporary).catch(() => {}) }
  }
  async function load() {
    if (loaded) return
    await mkdir(root, { recursive: true })
    if (await checkFile()) {
      let data
      try { data = JSON.parse(await readFile(filename, 'utf8')) } catch { throw fail('Saved channel import progress could not be read. Existing files were preserved.', 503) }
      if (data?.schemaVersion !== 1 || !data.job || !Array.isArray(data.job.entries) || data.job.entries.length > 10000 || !['running', 'stopping', 'cancelled', 'complete', 'paused'].includes(data.job.status)) throw fail('Saved channel import progress is invalid. Existing files were preserved.', 503)
      job = data.job
      if (running(job)) { job.status = 'paused'; job.message = 'Import was interrupted by a server restart. Choose Import all videos to retry the remaining references.'; job.currentUrl = undefined; job.updatedAt = now(); await persist() }
    }
    loaded = true
  }
  async function work(id) {
    try {
      for (;;) {
        const entry = await exclusive(async () => {
          if (job.id !== id) return null
          if (job.status === 'stopping') { job.status = 'cancelled'; job.currentUrl = undefined; job.message = 'Stopped. Saved videos are still available.'; job.updatedAt = now(); await persist(); return null }
          if (job.status !== 'running') return null
          const next = job.entries.find(value => value.status === 'pending')
          if (!next) { job.status = 'complete'; job.currentUrl = undefined; job.message = 'Finished importing the discovered video list. Review any failed videos below.'; job.updatedAt = now(); await persist(); return null }
          job.currentUrl = next.url; job.updatedAt = now(); await persist()
          return { ...next }
        })
        if (!entry) break
        let result, cause
        try {
          if (entry.durationSeconds > 300) throw fail('This video exceeds the five-minute import limit.')
          result = await importOne(entry.url, job.channelId)
        } catch (error) { cause = error }
        await exclusive(async () => {
          if (job.id !== id) return
          const current = job.entries.find(value => value.url === entry.url)
          if ([429, 503, 507].includes(cause?.status)) { job.status = 'paused'; job.message = String(cause.message).slice(0, 400); job.currentUrl = undefined }
          else if (cause || !result || result.status === 'failed') { current.status = 'failed'; current.error = String(cause?.message || result?.error || 'This video could not be imported.').slice(0, 400) }
          else { current.status = result.skipped ? 'skipped' : 'imported'; current.itemId = result.id }
          job.updatedAt = now(); await persist()
        })
      }
    } catch {
      // Do not erase the last durable checkpoint if a write itself failed.
      await exclusive(async () => { if (job?.id === id) { job.status = 'paused'; job.currentUrl = undefined; job.message = 'Import paused because progress could not be saved. Existing videos were preserved.'; job.updatedAt = now(); await persist().catch(() => {}) } })
    }
  }
  return {
    async get(channelId) { return exclusive(async () => { await load(); return channelId === undefined || job?.channelId === channelId ? summary() : null }) },
    async start(channelId) {
      const channel = await getChannel(channelId)
      return exclusive(async () => {
        await load()
        if (running(job) || worker) {
          if (job.channelId === channelId) return summary()
          throw fail('Another channel import is running. Stop it or wait for it to finish.', 409)
        }
        const entries = [...new Map(channel.discoveredVideos.map(video => [video.url, { url: video.url, durationSeconds: video.durationSeconds, status: 'pending' }])).values()]
        if (!entries.length) throw fail('No videos have been discovered for this channel. Refresh its public list first.')
        const previous = job, timestamp = now()
        job = { id: randomUUID(), channelId, status: 'running', entries, coverageComplete: channel.catalogComplete === true, message: 'Importing discovered videos. Existing imports are skipped.', createdAt: timestamp, updatedAt: timestamp }
        try { await persist() } catch (cause) { job = previous; throw cause }
        const id = job.id
        worker = new Promise(resolve => setImmediate(resolve)).then(() => work(id)).finally(() => { worker = null })
        return summary()
      })
    },
    async stop(channelId) { return exclusive(async () => { await load(); if (job?.channelId !== channelId) return null; if (running(job)) { job.status = 'stopping'; job.message = 'Stopping after the current video finishes.'; job.updatedAt = now(); await persist() } return summary() }) },
    async whenIdle() { if (worker) await worker },
  }
}
