import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { resourceUrl } from './taskApi'
import { generateVideo, readVideoGeneration, resumeVideo, type GeneratedVideo, type VideoOverview } from './videoGenerationApi'
import './videoGeneration.css'

const active = new Set(['submitting', 'queued', 'generating', 'downloading'])
const labels: Record<GeneratedVideo['status'], string> = {
  submitting: 'Submitting', submission_unknown: 'Check required', queued: 'Queued', generating: 'Generating',
  downloading: 'Saving video', completed: 'Completed', failed: 'Failed', paused: 'Paused',
}
const fallbackCapability = { available: false, provider: 'SiliconFlow', model: 'MiniMaxAI/MiniMax-H3', durations: Array.from({length: 11}, (_, i) => i + 5), resolutions: ['480p', '768p'], ratios: ['1:1', '3:4', '4:3', '9:16', '16:9', '21:9'], referenceImages: true, watermark: 'AI-generated watermark', reason: 'Checking configuration…' }

export function VideoGeneration() {
  const [overview, setOverview] = useState<VideoOverview>({ capability: fallbackCapability, jobs: [] })
  const [prompt, setPrompt] = useState('')
  const [duration, setDuration] = useState(5)
  const [resolution, setResolution] = useState('768p')
  const [ratio, setRatio] = useState('16:9')
  const [seed, setSeed] = useState('')
  const [mode, setMode] = useState<'text'|'first'|'first-last'>('text')
  const [firstFrame, setFirstFrame] = useState('')
  const [lastFrame, setLastFrame] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const latest = overview.jobs[0]

  async function refresh(silent = false) {
    try { setOverview(await readVideoGeneration()); if (!silent) setError('') }
    catch (e) { if (!silent) setError(e instanceof Error ? e.message : 'Could not load video generation.') }
  }
  useEffect(() => { void refresh(); const timer = window.setInterval(() => { if (overview.jobs.some(j => active.has(j.status))) void refresh(true) }, 5000); return () => clearInterval(timer) }, [overview.jobs.map(j => j.id + j.status).join('|')])

  const images = useMemo(() => {
    const values: GeneratedVideo['images'] = []
    if (mode !== 'text' && firstFrame.trim()) values.push({ role: 'first_frame', url: firstFrame.trim() })
    if (mode === 'first-last' && lastFrame.trim()) values.push({ role: 'last_frame', url: lastFrame.trim() })
    return values
  }, [mode, firstFrame, lastFrame])

  async function submit(e: FormEvent) {
    e.preventDefault(); setError('')
    if (!prompt.trim()) return setError('Describe the video you want to create.')
    if (mode !== 'text' && !firstFrame.trim()) return setError('Add a public HTTPS URL for the first frame.')
    if (mode === 'first-last' && !lastFrame.trim()) return setError('Add a public HTTPS URL for the last frame.')
    setBusy(true)
    try {
      const job = await generateVideo({ prompt: prompt.trim(), duration, resolution, ratio, ...(seed.trim() ? { seed: Number(seed) } : {}), ...(images.length ? { images } : {}) })
      setOverview(value => ({ ...value, jobs: [job, ...value.jobs.filter(item => item.id !== job.id)] }))
    } catch (e) { setError(e instanceof Error ? e.message : 'Video submission failed.') }
    finally { setBusy(false) }
  }

  return <section className="video-generation">
    <header className="vg-header"><div><span className="eyebrow">SILICONFLOW · MINIMAX H3</span><h1>Video Generation</h1><p>Turn a prompt—or a first and last frame—into a finished video without leaving Spur.</p></div><span className={`vg-availability ${overview.capability.available ? 'ready' : ''}`}>{overview.capability.available ? 'Ready' : 'Setup needed'}</span></header>
    {!overview.capability.available && <div className="vg-notice" role="status"><strong>Connect SiliconFlow to generate.</strong><span>{overview.capability.reason || 'Add SILICONFLOW_API_KEY to the private agent service. The key never belongs in the browser.'}</span></div>}
    <div className="vg-layout">
      <form className="vg-card vg-form" onSubmit={submit}>
        <label className="vg-field"><span>What should H3 create?</span><textarea value={prompt} onChange={e => setPrompt(e.target.value)} maxLength={4000} rows={7} placeholder="A cinematic close-up of a silver ring catching morning light, slow camera orbit, soft reflections…"/><small>{prompt.length}/4000</small></label>
        <fieldset><legend>Generation mode</legend><div className="vg-segmented">{([['text','Text only'],['first','First frame'],['first-last','First + last']] as const).map(([value,label]) => <button key={value} type="button" className={mode === value ? 'selected' : ''} onClick={() => setMode(value)}>{label}</button>)}</div></fieldset>
        {mode !== 'text' && <div className="vg-reference-fields"><label className="vg-field"><span>First-frame image URL</span><input type="url" value={firstFrame} onChange={e => setFirstFrame(e.target.value)} placeholder="https://…" required /></label>{mode === 'first-last' && <label className="vg-field"><span>Last-frame image URL</span><input type="url" value={lastFrame} onChange={e => setLastFrame(e.target.value)} placeholder="https://…" required /></label>}<small>Use a publicly reachable HTTPS image. Local image upload needs a private media host and is not enabled yet.</small></div>}
        <div className="vg-controls"><label><span>Duration</span><select value={duration} onChange={e => setDuration(Number(e.target.value))}>{overview.capability.durations.map(value => <option key={value} value={value}>{value} seconds</option>)}</select></label><label><span>Resolution</span><select value={resolution} onChange={e => setResolution(e.target.value)}>{overview.capability.resolutions.map(value => <option key={value}>{value}</option>)}</select></label><label><span>Seed (optional)</span><input type="number" min="0" step="1" value={seed} onChange={e => setSeed(e.target.value)} placeholder="Random" /></label></div>
        <fieldset><legend>Aspect ratio</legend><div className="vg-ratios">{overview.capability.ratios.map(value => <button key={value} type="button" className={ratio === value ? 'selected' : ''} onClick={() => setRatio(value)}><i style={{aspectRatio:value.replace(':',' / ')}} />{value}</button>)}</div></fieldset>
        {error && <p className="vg-error" role="alert">{error}</p>}
        <div className="vg-submit-row"><span>Output includes the provider’s AI-generated watermark.</span><button className="vg-generate" disabled={busy || !overview.capability.available || !prompt.trim()}>{busy ? 'Submitting…' : 'Generate video'}<b>↗</b></button></div>
      </form>
      <aside className="vg-card vg-preview"><div className="vg-card-title"><span>Latest generation</span>{latest && <em className={`vg-status status-${latest.status}`}>{labels[latest.status]}</em>}</div>{!latest ? <div className="vg-empty"><span>▶</span><strong>Your video will appear here</strong><p>Choose your settings and submit a generation.</p></div> : latest.status === 'completed' && latest.url ? <video src={resourceUrl(latest.url)} controls playsInline preload="metadata" /> : <div className="vg-progress"><span className="vg-spinner">✦</span><strong>{labels[latest.status]}</strong><p>{latest.error || 'Spur is tracking this job. You can leave this page and return later.'}</p></div>}{latest && <JobDetails job={latest} />}</aside>
    </div>
    <section className="vg-history"><div className="vg-history-title"><div><span className="eyebrow">GENERATION HISTORY</span><h2>Your videos</h2></div><button type="button" onClick={() => void refresh()}>Refresh</button></div>{overview.jobs.length ? <div className="vg-job-grid">{overview.jobs.map(job => <article className="vg-job" key={job.id}>{job.status === 'completed' && job.url ? <video src={resourceUrl(job.url)} controls playsInline preload="metadata" /> : <div className="vg-job-placeholder"><span>▶</span>{labels[job.status]}</div>}<div><p>{job.prompt}</p><JobDetails job={job} />{job.status === 'paused' && <button type="button" onClick={async () => { try { await resumeVideo(job.id); await refresh() } catch(e) { setError(e instanceof Error ? e.message : 'Could not resume.') } }}>Resume</button>}</div></article>)}</div> : <p className="vg-history-empty">No generations yet.</p>}</section>
  </section>
}

function JobDetails({job}:{job:GeneratedVideo}) {
  return <div className="vg-meta"><span>{job.duration}s</span><span>{job.resolution}</span><span>{job.ratio}</span>{(job.actualSeed ?? job.seed) !== undefined && <span>Seed {job.actualSeed ?? job.seed}</span>}<time>{new Date(job.createdAt).toLocaleString()}</time></div>
}
