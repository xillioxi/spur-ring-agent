import { useEffect, useRef, useState } from 'react'
import { getVideoAnalysis, isAnalysisRunning, videoTime, type VideoAnalysisItem } from './inverseVideoApi'
import { analyzeRecreation, createCustomRecreationPlan, createRecreationSubmission, getRecreation, getRecreationMedia, getRecreationPlan, isRecreationRunning, listRecreations, mergeRecreationJobs, parseRecreationStoryboard, recreationStatusLabel, recreationTiming, resumeRecreation, type RecreationJob, type RecreationPlan, type RecreationRequest, type RecreationStoryboard } from './videoReconstructionApi'
import './videoReconstruction.css'

const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'The recreation could not be loaded. Try checking its status again.'
const seconds = (value: number) => `${Number(value.toFixed(3))}s`
const timelineTime = (value: number) => Number.isInteger(value) ? videoTime(value) : `${Math.floor(value / 60)}:${(value % 60).toFixed(3).replace(/0+$/, '').padStart(4, '0')}`
const storageKey = (id: string) => `spur-recreation-pending:${id}`
type PendingRequest = { key: string; body?: Omit<RecreationRequest, 'requestKey'> }
function storedRequest(id: string): PendingRequest {
  try {
    const raw = sessionStorage.getItem(storageKey(id))
    if (!raw) return { key: '' }
    try { const saved = JSON.parse(raw); return typeof saved?.key === 'string' ? saved : { key: '' } }
    catch { return { key: raw } }
  } catch { return { key: '' } }
}
function saveRequest(id: string, key: string, body?: PendingRequest['body']) { try { if (key) sessionStorage.setItem(storageKey(id), JSON.stringify({ key, body })); else sessionStorage.removeItem(storageKey(id)) } catch { /* In-memory deduplication remains active. */ } }
const storyboardKey = (id: string) => `spur-recreation-storyboard:${id}`
function storedStoryboard(id: string): { draft: string; parsed: RecreationStoryboard | null } {
  try { const draft = sessionStorage.getItem(storyboardKey(id)) || ''; return { draft, parsed: draft ? parseRecreationStoryboard(draft) : null } }
  catch { return { draft: '', parsed: null } }
}
function saveStoryboard(id: string, draft: string) { try { if (draft) sessionStorage.setItem(storyboardKey(id), draft); else sessionStorage.removeItem(storyboardKey(id)) } catch { /* The applied storyboard remains available in memory. */ } }

export function CustomStoryboardEditor({ value, onChange, onApply, onReset, disabled, active, changed }: { value: string; onChange: (value: string) => void; onApply: () => void; onReset: () => void; disabled: boolean; active: boolean; changed: boolean }) {
  return <details className="recreation-storyboard" open={active || undefined}><summary>Use a custom prompt / storyboard</summary><p className="recreation-note">Paste a storyboard JSON containing clips, timeline and api_payload.prompt. Apply prepares a plan for review; generation starts only when you choose Generate recreation.</p><label htmlFor="recreation-storyboard-json">Storyboard JSON<textarea id="recreation-storyboard-json" value={value} onChange={event => onChange(event.target.value)} rows={9} maxLength={150000} spellCheck={false} disabled={disabled} placeholder={'{"clips":[{"timeline":"00:00.0 - 00:03.6","api_payload":{"prompt":"Describe the shot…"}}]}'}/></label><div className="recreation-storyboard-actions"><button type="button" className="inverse-primary" disabled={disabled || !value.trim()} onClick={onApply}>Apply storyboard</button>{active && <button type="button" className="inverse-text-button" disabled={disabled} onClick={onReset}>Use analyzed shots</button>}</div>{active && <p className="recreation-note" role="status">{changed ? 'The JSON has changed. Apply it to update the reviewed plan before generation.' : 'Custom storyboard applied. Its prompts and exact timestamps will be used for this plan.'}</p>}</details>
}

export function RecreationPlanEditor({ plan, prompts, onPrompt, disabled }: { plan: RecreationPlan; prompts: Record<number, string>; onPrompt: (index: number, prompt: string) => void; disabled: boolean }) {
  const timing = recreationTiming(plan)
  return <div className="recreation-plan">
    <div className="recreation-timing"><span><strong>{seconds(timing.targetSeconds)}</strong> Final target length</span><span><strong>{seconds(timing.billableSeconds)}</strong> Billable generation</span><span><strong>{timing.clipCount}</strong> Generated clips</span></div>
    <p className="recreation-note">MiniMax generates 5–15 seconds per clip. Clips are trimmed and assembled to the target timeline; short shots can cost more generated seconds than their final length.</p>
    <div className="recreation-prompt-list">{plan.clips.map(clip => <label key={clip.index} htmlFor={`recreation-prompt-${clip.index}`}><span><strong>Clip {clip.index + 1}</strong><span>{timelineTime(clip.startSeconds)}–{timelineTime(clip.endSeconds)} · {seconds(clip.requestDurationSeconds)} generated</span></span><textarea id={`recreation-prompt-${clip.index}`} rows={4} value={prompts[clip.index] ?? clip.prompt} disabled={disabled} onChange={event => onPrompt(clip.index, event.target.value)} maxLength={8000}/></label>)}</div>
  </div>
}

export function RecreationJobProgress({ job }: { job: RecreationJob }) {
  const finished = job.clips.filter(clip => clip.status === 'completed').length
  return <section className="recreation-job" aria-label="Recreation progress">
    <div className="recreation-job-heading"><strong>{recreationStatusLabel(job.status)}</strong><span>{finished} / {job.clips.length} clips ready</span></div>
    <progress max={Math.max(1, job.clips.length)} value={finished} aria-label="Generated clips completed"/>
    <p>{job.message || recreationStatusLabel(job.stage)}</p>
    {job.source === 'authored_timeline' && <p>Source: authored storyboard. This saved recreation uses the custom timeline and submitted prompts below.</p>}
    {job.error && <p className="recreation-error">{job.error}</p>}
    {job.status === 'submission_unknown' && <p className="recreation-error">The provider submission could not be confirmed. This job will not be submitted again automatically. Check its status before starting another generation.</p>}
    {job.status === 'paused' && <p>Status checks paused after a connection problem. Resume this recreation to check its existing clips and continue the original plan.</p>}
    <ol>{job.clips.map(clip => <li key={clip.index}><span>Clip {clip.index + 1} <small>{timelineTime(clip.startSeconds)}–{timelineTime(clip.endSeconds)}</small></span><span>{recreationStatusLabel(clip.status)}</span>{clip.error && <p className="recreation-error">{clip.error}</p>}</li>)}</ol>
    <details className="recreation-submitted-prompts"><summary>View submitted prompts</summary>{job.clips.map(clip => <article key={clip.index}><strong>Clip {clip.index + 1} · {timelineTime(clip.startSeconds)}–{timelineTime(clip.endSeconds)}</strong><p>{clip.prompt}</p></article>)}</details>
  </section>
}

export function VideoReconstruction({ item, onOpenOutput }: { item: VideoAnalysisItem; onOpenOutput: (item: VideoAnalysisItem) => void }) {
  const [opened, setOpened] = useState(false)
  const [plan, setPlan] = useState<RecreationPlan | null>(null)
  const [prompts, setPrompts] = useState<Record<number, string>>({})
  const [audioMode, setAudioMode] = useState<'reference' | 'silent'>('reference')
  const [resolution, setResolution] = useState<'480p' | '768p'>('480p')
  const [jobs, setJobs] = useState<RecreationJob[]>([])
  const [jobId, setJobId] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [initialStoryboard] = useState(() => storedStoryboard(item.id))
  const [storyboardDraft, setStoryboardDraft] = useState(initialStoryboard.draft)
  const [appliedStoryboard, setAppliedStoryboard] = useState(initialStoryboard.draft)
  const [customStoryboard, setCustomStoryboard] = useState<RecreationStoryboard | null>(initialStoryboard.parsed)
  const [media, setMedia] = useState('')
  const [mediaError, setMediaError] = useState('')
  const [output, setOutput] = useState<VideoAnalysisItem | null>(null)
  const [initialRequest] = useState(() => storedRequest(item.id))
  const [pendingKey, setPendingKey] = useState(initialRequest.key)
  const mounted = useRef(true)
  const actionBusy = useRef(false)
  const submission = useRef<ReturnType<typeof createRecreationSubmission> | null>(null)
  if (!submission.current) submission.current = createRecreationSubmission(item.id, { pendingKey, pendingBody: initialRequest.body, onPending: (key, body) => { saveRequest(item.id, key, body); if (mounted.current) setPendingKey(key) } })
  const job = jobs.find(value => value.id === jobId) || jobs[0]
  const running = jobs.some(isRecreationRunning)
  const uncertain = jobs.some(value => value.status === 'submission_unknown')
  const paused = jobs.some(value => value.status === 'paused')
  const outputRunning = !!output && isAnalysisRunning(output)
  const comparisonPending = job?.comparison?.status === 'pending'
  const blocked = !!busy || running || uncertain || paused || !!pendingKey
  const storyboardChanged = !!customStoryboard && storyboardDraft !== appliedStoryboard
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  function upsertJobs(incoming: RecreationJob[]) { setJobs(previous => mergeRecreationJobs(previous, incoming)) }
  async function prepare() {
    if (actionBusy.current) return
    actionBusy.current = true; setBusy('preparing'); setError('')
    try {
      const [planning, existing] = await Promise.allSettled([customStoryboard ? createCustomRecreationPlan(item.id, customStoryboard.timeline) : item.result?.shots?.length ? getRecreationPlan(item.id) : Promise.resolve(null), listRecreations(item.id)])
      if (!mounted.current) return
      if (existing.status === 'fulfilled') upsertJobs(existing.value.jobs)
      if (planning.status === 'fulfilled' && planning.value) {
        setPlan(planning.value.plan); setPrompts({}); setAudioMode(planning.value.plan.hasReferenceAudio ? 'reference' : 'silent'); if (customStoryboard) setResolution('768p')
      } else if (planning.status === 'rejected') setError(errorMessage(planning.reason))
      if (existing.status === 'rejected') setError(errorMessage(existing.reason))
    } finally { actionBusy.current = false; if (mounted.current) setBusy('') }
  }
  useEffect(() => { if (opened) void prepare() }, [opened])
  useEffect(() => {
    if (!opened || !running && !pendingKey && !outputRunning && !comparisonPending) return
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined
    async function poll() {
      try {
        const [status, analysis, current] = await Promise.all([listRecreations(item.id), outputRunning && output ? getVideoAnalysis(output.id) : Promise.resolve(null), job ? getRecreation(job.id) : Promise.resolve(null)])
        if (stopped) return
        upsertJobs(status.jobs)
        if (current) upsertJobs([current.job])
        if (analysis) setOutput(analysis.item)
        if (submission.current?.getPendingKey()) {
          const receipt = await submission.current.checkReceipt()
          if (!stopped && receipt) { upsertJobs([receipt]); setJobId(receipt.id); setNotice('The original generation receipt was recovered. No new generation was submitted.') }
        }
      } catch (failure) { if (!stopped) setNotice(`${errorMessage(failure)} Status checks will continue without resubmitting generation.`) }
      if (!stopped) timer = setTimeout(() => void poll(), 3500)
    }
    timer = setTimeout(() => void poll(), 2500)
    return () => { stopped = true; if (timer) clearTimeout(timer) }
  }, [opened, running, pendingKey, outputRunning, comparisonPending, output?.id, job?.id, item.id])
  useEffect(() => {
    if (!job?.id || !output?.result || isAnalysisRunning(output)) return
    let stopped = false
    void getRecreation(job.id).then(response => { if (!stopped) upsertJobs([response.job]) }).catch(failure => { if (!stopped) setNotice(errorMessage(failure)) })
    return () => { stopped = true }
  }, [job?.id, output?.updatedAt, output?.status])
  useEffect(() => {
    let stopped = false
    setOutput(null)
    if (!job?.outputItemId) return
    void getVideoAnalysis(job.outputItemId).then(response => { if (!stopped) setOutput(response.item) }).catch(failure => { if (!stopped) setNotice(errorMessage(failure)) })
    return () => { stopped = true }
  }, [job?.outputItemId])
  useEffect(() => {
    const controller = new AbortController()
    let stopped = false, objectUrl = ''
    setMedia(''); setMediaError('')
    if (job?.status === 'completed' && job.hasMedia) void getRecreationMedia(job.id, controller.signal).then(blob => {
      if (stopped) return
      objectUrl = URL.createObjectURL(blob); setMedia(objectUrl)
    }).catch(failure => { if (!stopped && !controller.signal.aborted) setMediaError(errorMessage(failure)) })
    return () => { stopped = true; controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [job?.id, job?.status, job?.hasMedia])

  async function applyStoryboard() {
    if (blocked || actionBusy.current) return
    actionBusy.current = true; setBusy('preparing'); setError(''); setNotice('')
    try {
      const parsed = parseRecreationStoryboard(storyboardDraft)
      const { plan: prepared } = await createCustomRecreationPlan(item.id, parsed.timeline)
      if (!mounted.current) return
      setCustomStoryboard(parsed); setAppliedStoryboard(storyboardDraft); saveStoryboard(item.id, storyboardDraft)
      setPlan(prepared); setPrompts({}); setResolution('768p'); setAudioMode(prepared.hasReferenceAudio ? 'reference' : 'silent')
      setNotice(`Custom storyboard prepared: ${parsed.timeline.length} clips. Review the prompts, timeline and generation settings below.`)
    } catch (failure) { if (mounted.current) setError(errorMessage(failure)) }
    finally { actionBusy.current = false; if (mounted.current) setBusy('') }
  }
  async function resetStoryboard() {
    if (blocked || actionBusy.current) return
    actionBusy.current = true; setBusy('preparing'); setError(''); setNotice('')
    try {
      const { plan: prepared } = await getRecreationPlan(item.id)
      if (!mounted.current) return
      setPlan(prepared); setPrompts({}); setCustomStoryboard(null); setAppliedStoryboard(''); saveStoryboard(item.id, '')
      setAudioMode(prepared.hasReferenceAudio ? 'reference' : 'silent'); setNotice('The recreation plan now uses the analyzed shots.')
    } catch (failure) { if (mounted.current) setError(errorMessage(failure)) }
    finally { actionBusy.current = false; if (mounted.current) setBusy('') }
  }

  async function generate() {
    if (!plan || blocked || storyboardChanged || actionBusy.current) return
    actionBusy.current = true; setBusy('generating'); setError(''); setNotice('')
    try {
      const { job: created } = await submission.current!.submit({ planRevision: plan.planRevision, shots: plan.clips.map(clip => ({ index: clip.index, prompt: prompts[clip.index] ?? clip.prompt })), audioMode, resolution, ...(customStoryboard ? { timeline: customStoryboard.timeline } : {}) })
      if (mounted.current) { upsertJobs([created]); setJobId(created.id); setNotice('Generation queued. You can leave this reference and return to check progress.') }
    } catch (failure) { if (mounted.current) setError(`${errorMessage(failure)}${submission.current?.getPendingKey() ? ' The receipt is uncertain. Check submission status; no generation will be submitted again automatically.' : ''}`) }
    finally { actionBusy.current = false; if (mounted.current) setBusy('') }
  }
  async function checkStatus() {
    if (actionBusy.current) return
    actionBusy.current = true; setBusy('checking'); setError('')
    try {
      const receipt = await submission.current?.checkReceipt()
      const [response, current, analysis] = await Promise.all([listRecreations(item.id), job ? getRecreation(job.id) : Promise.resolve(null), output ? getVideoAnalysis(output.id) : Promise.resolve(null)])
      if (!mounted.current) return
      upsertJobs(response.jobs)
      if (current) upsertJobs([current.job])
      if (analysis) setOutput(analysis.item)
      if (receipt) { setJobId(receipt.id); setNotice('Generation receipt recovered. No new generation was submitted.') }
      else if (pendingKey) setNotice('No receipt was found yet. Keep this request pending and check again; do not start a duplicate generation.')
    } catch (failure) { if (mounted.current) setError(errorMessage(failure)) }
    finally { actionBusy.current = false; if (mounted.current) setBusy('') }
  }
  async function resumeSubmission() {
    if (actionBusy.current || !submission.current?.canResume()) return
    actionBusy.current = true; setBusy('generating'); setError(''); setNotice('')
    try {
      const { job: receipt } = await submission.current.resume()
      if (mounted.current) { upsertJobs([receipt]); setJobId(receipt.id); setNotice('The same request was submitted using its original request key and prompts.') }
    } catch (failure) { if (mounted.current) setError(errorMessage(failure)) }
    finally { actionBusy.current = false; if (mounted.current) setBusy('') }
  }
  async function analyze() {
    if (!job || actionBusy.current || outputRunning) return
    actionBusy.current = true; setBusy('analyzing'); setError(''); setNotice('')
    try {
      const response = await analyzeRecreation(job.id)
      if (mounted.current) { upsertJobs([response.job]); setOutput(response.item); setNotice('Recreation analysis started. The comparison will use the generated file.') }
    } catch (failure) { if (mounted.current) setError(`${errorMessage(failure)} Check status before submitting another analysis.`) }
    finally { actionBusy.current = false; if (mounted.current) setBusy('') }
  }
  async function resumeJob() {
    if (!job || job.status !== 'paused' || !job.retryable || actionBusy.current) return
    actionBusy.current = true; setBusy('resuming'); setError(''); setNotice('')
    try {
      const response = await resumeRecreation(job.id)
      if (mounted.current) { upsertJobs([response.job]); setNotice('Resumed the existing recreation. Previously submitted clips are checked using their saved receipts.') }
    } catch (failure) { if (mounted.current) setError(`${errorMessage(failure)} Check this job’s status before trying Resume again.`) }
    finally { actionBusy.current = false; if (mounted.current) setBusy('') }
  }
  function download() {
    if (!media || !job) return
    const anchor = document.createElement('a')
    anchor.href = media; anchor.download = `spur-recreation-${job.id}.mp4`; document.body.appendChild(anchor); anchor.click(); anchor.remove()
  }
  const comparison = job?.comparison
  return <section className="video-recreation" aria-label="Recreate reference video">
    <div className="recreation-heading"><div><span className="eyebrow">PROMPT → VIDEO</span><h4>Recreate this reference</h4><p>Review the shot prompts, generate new footage with MiniMax H3, then compare the result with the reference. Prompt recreation is approximate; matching visual quality or an identical video is not guaranteed.</p></div><button type="button" className="inverse-primary" disabled={!!busy || item.hasMedia === false || opened && blocked} onClick={() => { if (opened) void prepare(); else setOpened(true) }}>{busy === 'preparing' ? 'Preparing…' : opened ? 'Refresh recreation plan' : 'Prepare recreation'}</button></div>
    {!item.result?.shots?.length && <p className="recreation-note">Supply a custom storyboard, or complete shot analysis to prepare a plan from the reference.</p>}
    {opened && <div className="recreation-content">
      {error && <p className="recreation-error" role="alert">{error}</p>}{notice && <p className="recreation-note" role="status">{notice}</p>}
      <CustomStoryboardEditor value={storyboardDraft} onChange={setStoryboardDraft} onApply={() => void applyStoryboard()} onReset={() => void resetStoryboard()} disabled={blocked} active={!!customStoryboard} changed={storyboardChanged}/>
      {customStoryboard && <div className="recreation-custom-summary"><strong>{customStoryboard.title || 'Custom storyboard'} · {customStoryboard.timeline.length} authored clips</strong><ul className="recreation-warnings">{customStoryboard.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}
      {!!pendingKey && busy !== 'generating' && <div className="recreation-uncertain" role="status"><strong>Generation receipt needs checking</strong><p>Spur kept this request pending to prevent duplicate charges. Status checks do not submit another generation.</p><button type="button" className="inverse-text-button" disabled={!!busy} onClick={() => void checkStatus()}>Check submission status</button>{submission.current?.canResume() && <><p>If submission was blocked before a job was saved, you can submit the original request again. It uses the same request key and prompts; an existing job is reused.</p><button type="button" className="inverse-text-button" disabled={!!busy} onClick={() => void resumeSubmission()}>Resubmit same request</button></>}</div>}
      {plan && <><RecreationPlanEditor plan={plan} prompts={prompts} onPrompt={(index, prompt) => setPrompts(previous => ({ ...previous, [index]: prompt }))} disabled={blocked}/>
        {!!plan.warnings?.length && <ul className="recreation-warnings">{plan.warnings.filter(Boolean).map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
        <div className="recreation-options"><label>Audio<select value={audioMode} disabled={blocked} onChange={event => setAudioMode(event.target.value as 'reference' | 'silent')}><option value="reference" disabled={!plan.hasReferenceAudio}>Use reference audio</option><option value="silent">Silent video</option></select></label><label>Resolution<select value={resolution} disabled={blocked} onChange={event => setResolution(event.target.value as '480p' | '768p')}><option value="480p">480p</option><option value="768p">768p</option></select></label><button type="button" className="inverse-primary" disabled={blocked || storyboardChanged || plan.capability?.available === false || plan.clips.some(clip => !(prompts[clip.index] ?? clip.prompt).trim())} onClick={() => void generate()}>{busy === 'generating' ? 'Submitting…' : 'Generate recreation'}</button></div>
        <p className="recreation-note">Generation uses paid MiniMax H3 requests. {plan.capability?.model ? `Model: ${plan.capability.model}. ` : ''}{audioMode === 'reference' ? 'The final video reuses the reference soundtrack.' : 'The final video has no audio.'} {plan.capability?.available === false ? plan.capability.message || plan.capability.reason || 'Video generation is unavailable.' : ''}</p>
      </>}
      {jobs.length > 1 && <label className="recreation-history">Saved recreations<select value={job?.id || ''} onChange={event => setJobId(event.target.value)}>{jobs.map(value => <option key={value.id} value={value.id}>{new Date(value.createdAt).toLocaleString()} · {recreationStatusLabel(value.status)}</option>)}</select></label>}
      {job && <><RecreationJobProgress job={job}/><div className="recreation-output-actions"><button type="button" className="inverse-text-button" disabled={!!busy} onClick={() => void checkStatus()}>Check status</button>{job.status === 'paused' && job.retryable && <button type="button" className="inverse-primary" disabled={!!busy} onClick={() => void resumeJob()}>{busy === 'resuming' ? 'Resuming…' : 'Resume recreation'}</button>}</div>
        {job.status === 'completed' && <div className="recreation-output">{media ? <video src={media} controls playsInline preload="metadata" aria-label="Generated recreation"/> : <p className="recreation-note">{mediaError || 'Loading the generated video…'}</p>}<div className="recreation-output-actions"><button type="button" className="inverse-text-button" disabled={!media} onClick={download}>Download MP4</button><button type="button" className="inverse-primary" disabled={!!busy || outputRunning} onClick={() => { if (output?.hasResult || output?.result) void checkStatus(); else void analyze() }}>{outputRunning ? 'Analyzing recreation…' : busy === 'analyzing' ? 'Starting analysis…' : output?.hasResult || output?.result ? 'Check recreation analysis' : 'Analyze recreation'}</button>{output && <button type="button" className="inverse-text-button" onClick={() => onOpenOutput(output)}>Open recreation analysis ↗</button>}</div><p className="recreation-note">Analyze recreation sends the actual generated video to the configured analysis model.</p>
          {(output?.result || comparison) && <section className="recreation-comparison" aria-label="Reference and recreation comparison"><h4>Compare the actual output</h4><div><article><strong>Reference</strong><p>{item.result?.summary || item.title}</p><small>{item.result?.shots?.length || 0} analyzed shots · {seconds(comparison?.referenceDurationSeconds ?? item.durationSeconds ?? plan?.totalDurationSeconds ?? 0)}</small></article><article><strong>Generated recreation</strong><p>{output?.result?.summary || (comparison?.status === 'pending' ? 'Analysis is still running.' : 'Open the recreation analysis to inspect its shots and sound.')}</p><small>{comparison?.outputShotCount ?? output?.result?.shots?.length ?? 0} analyzed shots{Number.isFinite(comparison?.outputDurationSeconds ?? output?.durationSeconds) ? ` · ${seconds((comparison?.outputDurationSeconds ?? output?.durationSeconds)!)}` : ''}</small></article></div>{Number.isFinite(comparison?.durationDeltaSeconds) && <p>Duration difference: {seconds(comparison!.durationDeltaSeconds!)}.</p>}<p>Shot counts and timing are descriptive checks. They do not establish matching visual quality.</p></section>}
        </div>}
      </>}
    </div>}
  </section>
}
