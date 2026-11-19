import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Icon } from './Icon'
import {
  addVideoSource, analysisModelMatchesResult, analysisModelSelectionNotice, analysisProviderLabel, analysisText, analyzeAllChannelVideos, analyzeReferenceVideo, audioEventText, audioMeasurementText, availableAnalysisModels, availableAnalysisWorkflows, channelDiscoveryPresentation, connectInstagram, defaultMaxVideoBytes, discoverVideoChannel, disconnectInstagram, exportVideoAnalysis,
  getInstagramConnection, getReaFrameGrid, getReferenceMedia, getVideoAnalysis, getVideoAnalysisConfiguration, importReferenceVideo,
  importAllChannelVideos, stopChannelImports, stopChannelAnalyses, isAnalysisRunning, listVideoAnalyses, listVideoChannels, mergeVideoAnalyses, mergeVideoChannels, reaAssetUrl, saveReaReviewNotes, savedAnalysisPresentation, savedAnalysisWorkflow, SCRIPT_BREAKDOWN_COLUMNS, scriptRowLabel, scriptStructureStatusLabel, selectedWorkflowCapabilities, selectedAnalysisModel, selectedAnalysisWorkflow, selectedScriptTemplateId, shotAnalysisPresentation, syncVideoChannel, uniqueChannelReferences, uploadReferenceVideo, videoAnalysisNotes, videoBelongsToChannel, videoReferenceKey, videoTime,
  type AnalysisMode, type AudioSegment, type ChannelStyle, type InstagramConnection, type ReaReviewNotes, type ReaVideoResult, type ScriptTemplate, type TimedText, type VideoAnalysisConfiguration, type VideoAnalysisItem, type VideoAnalysisModel, type VideoAnalysisResult, type VideoAnalysisWorkflow, type VideoChannel,
} from './inverseVideoApi'
import { ChannelAvatar, ReferenceImage, VideoChannelProfile } from './VideoChannelProfile'
import { VideoReconstruction } from './VideoReconstruction'
import { FaceReferences } from './FaceReferences'
import { ResultContent } from './ResultContent'
import './inverseVideo.css'

const stateLabels: Record<string, string> = {
  ready: 'Ready to analyze', queued: 'Waiting', importing: 'Importing', analyzing: 'Analyzing',
  complete: 'Complete', partial: 'Partial result', failed: 'Needs attention',
}
const analysisModelStorageKey = 'spur.video-analysis.model.v1'
const analysisWorkflowStorageKey = 'spur.video-analysis.workflow.v1'
const scriptTemplateStorageKey = 'spur.video-analysis.script-template.v2'
function savedAnalysisModelId() {
  try { return localStorage.getItem(analysisModelStorageKey) || '' } catch { return '' }
}
function savedAnalysisWorkflowId() {
  try { return localStorage.getItem(analysisWorkflowStorageKey) || '' } catch { return '' }
}
function savedScriptTemplateId() {
  try { return localStorage.getItem(scriptTemplateStorageKey) || '' } catch { return '' }
}
const message = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback
function readableNote(note: string) {
  if (note.startsWith('Scene-change candidates use')) return 'Shot boundaries are estimates. Fades and rapid cuts may be missed.'
  if (note.startsWith('100ms mono RMS')) return 'Sound levels and energy changes were measured separately from sound-label predictions.'
  if (note.startsWith('A supplemental scene-change pass')) return 'Fast camera movement or flashes can occasionally look like cuts.'
  return note
}
const fileSize = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`
function sourceUrl(value?: string) {
  try { const url = new URL(value || ''); return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined }
  catch { return undefined }
}
function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob), anchor = document.createElement('a')
  anchor.href = url; anchor.download = filename; document.body.appendChild(anchor); anchor.click(); anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
function readableDate(value: string) {
  const date = new Date(value)
  return Number.isFinite(date.valueOf()) ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''
}

export function AnalysisModelSelector({ models, selected, busy, notice, onChange }: { models: VideoAnalysisModel[]; selected?: VideoAnalysisModel; busy: boolean; notice?: string; onChange: (id: string) => void }) {
  return <div className="inverse-model-selector"><label htmlFor="inverse-analysis-model">Analysis model</label><select id="inverse-analysis-model" value={selected?.id || ''} disabled={busy || !models.length} aria-describedby={`inverse-analysis-model-description${notice ? ' inverse-analysis-model-notice' : ''}`} onChange={event => onChange(event.target.value)}>{models.length ? models.map(model => <option key={model.id} value={model.id} disabled={!model.available}>{model.label}{!model.available ? ' — unavailable' : ''}</option>) : <option value="">No analysis models configured</option>}</select>{notice && <p id="inverse-analysis-model-notice" className="inverse-model-unavailable" role="status">{notice}</p>}</div>
}

export function AnalysisWorkflowSelector({ workflows, selected, busy, onChange }: { workflows: VideoAnalysisWorkflow[]; selected?: VideoAnalysisWorkflow; busy: boolean; onChange: (id: string) => void }) {
  const description = selected?.description || (selected?.id === 'rea-video' ? 'Local technical measurements of shots, editing and camera movement. This pass does not interpret the story or joke.' : 'Analyze shots, speech and sound with the selected model.')
  return <div className="inverse-workflow-selector"><label htmlFor="inverse-analysis-workflow">Analysis workflow</label><select id="inverse-analysis-workflow" value={selected?.id || ''} disabled={busy || !workflows.length} aria-describedby="inverse-analysis-workflow-description" onChange={event => onChange(event.target.value)}>{workflows.length ? workflows.map(workflow => <option key={workflow.id} value={workflow.id} disabled={!workflow.available}>{workflow.label}{!workflow.available ? ' — unavailable' : ''}</option>) : <option value="">No workflows configured</option>}</select><p id="inverse-analysis-workflow-description">{description}{selected && !selected.available && selected.reason ? ` ${selected.reason}` : ''}</p></div>
}

export function SavedAnalysisProvenance({ result, nextModel, nextWorkflow }: { result: VideoAnalysisResult; nextModel?: VideoAnalysisModel; nextWorkflow?: VideoAnalysisWorkflow }) {
  const saved = savedAnalysisPresentation(result)
  const workflow = savedAnalysisWorkflow(result)
  const technical = workflow.id === 'rea-video'
  return <div className="inverse-result-provider"><span>Saved analysis · {technical ? `${workflow.label} · local technical tools` : saved.headline}{!technical && saved.inputLabel ? ` · ${saved.inputLabel}` : ''}</span><div>Workflow · {workflow.label}{workflow.revision ? ` · ${technical ? workflow.revision.slice(0, 8) : workflow.revision}` : ''}</div>{!technical && saved.mixed && <dl className="inverse-result-components" aria-label="Saved analysis component models">{saved.components.map(component => <div key={component.key}><dt>{component.label}</dt><dd>{component.source}{component.status ? ` (${component.status})` : ''}</dd></div>)}</dl>}{nextWorkflow && nextWorkflow.id !== workflow.id ? <p>This saved result uses {workflow.label}. Run a new breakdown to use {nextWorkflow.label}.</p> : !technical && nextModel && !analysisModelMatchesResult(nextModel, result) && <p>This saved result uses a different model or input route. Analyze again to create a result with {nextModel.label}.</p>}</div>
}

const reaCapabilityLabels = { available: 'Available locally', requires_model: 'Vision model required', requires_download: 'Extra installation required', separate_workflow: 'Separate workflow' }
const emptyReaReview: ReaReviewNotes = { summary: '', hook: '', payoff: '', characters: '', corrections: '' }
const reaReviewFields: Array<{ key: keyof ReaReviewNotes; label: string; hint: string }> = [
  { key: 'summary', label: 'What makes it work', hint: 'The idea, contrast or audience reaction that matters.' },
  { key: 'hook', label: 'Opening hook', hint: 'What earns attention at the beginning?' },
  { key: 'payoff', label: 'Payoff', hint: 'The precise reveal, joke or resolution, with timestamps if useful.' },
  { key: 'characters', label: 'People and objects', hint: 'Track the specific people, objects and changes that matter.' },
  { key: 'corrections', label: 'Corrections', hint: 'Any wrong measurements or missing actions to check.' },
]
function ReaReviewForm({ itemId, notes, disabled, onSaved }: { itemId: string; notes?: ReaVideoResult['reviewNotes']; disabled: boolean; onSaved: (item: VideoAnalysisItem) => void }) {
  const [draft, setDraft] = useState<ReaReviewNotes>({ ...emptyReaReview, ...notes })
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [error, setError] = useState('')
  const dirty = reaReviewFields.some(field => draft[field.key] !== (notes?.[field.key] || ''))
  async function save(event: FormEvent) {
    event.preventDefault(); setSaving(true); setFeedback(''); setError('')
    try {
      const { item } = await saveReaReviewNotes(itemId, draft)
      setDraft({ ...emptyReaReview, ...item.result?.reaVideo?.reviewNotes })
      onSaved(item); setFeedback('Your notes are saved. The technical analysis remains unreviewed.')
    } catch (reason) { setError(message(reason, 'Could not save your review notes.')) }
    finally { setSaving(false) }
  }
  return <details className="inverse-rea-review"><summary>Your review notes{notes ? ' · saved' : ''}</summary><p>Record the hook, payoff and corrections you observed. These notes are supplied by you; they do not establish automatic model understanding or change the technical review status.</p><form onSubmit={event => void save(event)} aria-label="Your Rea-video review notes"><fieldset disabled={disabled || saving}>{reaReviewFields.map(field => <label key={field.key}><strong>{field.label}</strong><span>{field.hint}</span><textarea rows={3} maxLength={4000} value={draft[field.key]} onChange={event => { setDraft(previous => ({ ...previous, [field.key]: event.target.value })); setFeedback('') }}/></label>)}</fieldset><div className="inverse-rea-review-save"><p role={error ? 'alert' : 'status'}>{error || feedback || (dirty ? 'You have unsaved notes.' : notes ? 'Saved separately from the unreviewed technical report.' : 'Your notes stay with this video and are included in its exports.')}</p><button type="submit" className="inverse-primary" disabled={disabled || saving || !dirty}>{saving ? 'Saving…' : 'Save review notes'}</button></div></form></details>
}
function ReaReportImage({ itemId, asset }: { itemId: string; asset: NonNullable<ReaVideoResult['assets']>[number] }) {
  const [failed, setFailed] = useState(false)
  const url = reaAssetUrl(itemId, asset.id)
  return <figure className="inverse-rea-image"><figcaption>{asset.label}</figcaption>{failed ? <p role="status">This image could not be loaded. Run a new Rea-video breakdown to regenerate it.</p> : <a href={url} target="_blank" rel="noreferrer"><img src={url} alt={asset.label} loading="lazy" onError={() => setFailed(true)}/></a>}<a className="inverse-text-button" href={reaAssetUrl(itemId, asset.id, true)} download>Download image</a></figure>
}
function ReaFrameInspector({ itemId, durationSeconds, disabled }: { itemId: string; durationSeconds: number; disabled: boolean }) {
  const end = Math.max(0.1, Number.isFinite(durationSeconds) ? durationSeconds : 8)
  const [startInput, setStartInput] = useState(Math.max(0, end - 8).toFixed(2))
  const [endInput, setEndInput] = useState(end.toFixed(2))
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<{ url: string; blob: Blob; start: number; end: number } | null>(null)
  const previewUrl = useRef('')
  const operation = useRef<AbortController | null>(null)
  useEffect(() => () => { operation.current?.abort(); if (previewUrl.current) URL.revokeObjectURL(previewUrl.current) }, [])
  async function generate(event: FormEvent) {
    event.preventDefault(); setError('')
    const start = Number(startInput), finish = Number(endInput)
    if (!startInput.trim() || !endInput.trim() || finish > end + 0.02) { setError('Choose a range inside this video.'); return }
    operation.current?.abort()
    const cancellation = new AbortController(); operation.current = cancellation; setPending(true)
    try {
      const blob = await getReaFrameGrid(itemId, start, finish, cancellation.signal)
      if (cancellation.signal.aborted) return
      const url = URL.createObjectURL(blob)
      if (previewUrl.current) URL.revokeObjectURL(previewUrl.current)
      previewUrl.current = url; setPreview({ url, blob, start, end: finish })
    } catch (reason) { if (!cancellation.signal.aborted) setError(message(reason, 'Could not generate this frame preview.')) }
    finally { if (!cancellation.signal.aborted) setPending(false) }
  }
  return <details className="inverse-rea-section inverse-rea-frame-inspector"><summary>Inspect a moment frame by frame</summary><p>Generate up to 24 timestamped full-frame samples over a range of up to 12 seconds. This runs locally and helps you inspect changes within a continuous shot. It does not interpret the actions.</p><form onSubmit={event => void generate(event)} aria-label="Dense frame inspection"><label>Start (seconds)<input type="number" min={0} max={end} step="0.01" value={startInput} disabled={disabled || pending} onChange={event => setStartInput(event.target.value)} required/></label><label>End (seconds)<input type="number" min={0} max={end} step="0.01" value={endInput} disabled={disabled || pending} onChange={event => setEndInput(event.target.value)} required/></label><button type="submit" className="inverse-primary" disabled={disabled || pending}>{pending ? 'Generating preview…' : 'Generate frame preview'}</button></form>{error && <p role="alert">{error}</p>}{pending && <p role="status">Sampling frames locally…</p>}{preview && <figure className="inverse-rea-image"><figcaption>{videoTime(preview.start)}–{videoTime(preview.end)} · timestamped frame grid</figcaption><a href={preview.url} target="_blank" rel="noreferrer"><img src={preview.url} alt={`Timestamped full-frame samples from ${videoTime(preview.start)} to ${videoTime(preview.end)}`}/></a><button type="button" className="inverse-text-button" onClick={() => saveBlob(preview.blob, `rea-frames-${preview.start.toFixed(2)}-${preview.end.toFixed(2)}.jpg`)}>Download frame grid</button></figure>}</details>
}
export function ReaVideoPanel({ result, itemId, durationSeconds, busy = false, onSeek, onSaved }: { result: VideoAnalysisResult; itemId?: string; durationSeconds?: number; busy?: boolean; onSeek: (seconds: number) => void; onSaved?: (item: VideoAnalysisItem) => void }) {
  const rea = result.reaVideo
  if (!rea) return null
  return <section className="inverse-rea-panel" aria-labelledby="inverse-rea-heading">
    <div className="inverse-rea-heading"><h4 id="inverse-rea-heading">Rea-video technical breakdown</h4><span>Unreviewed</span></div>
    <p className="inverse-rea-verdict">Verdict: {rea.verdict.replace(/_/g, ' ')}</p>
    <p>This pass measures editing and camera characteristics locally. Semantic video interpretation was not run: it does not identify the joke, track specific objects or transcribe speech.</p>
    {rea.technicalShots.length ? <ol className="inverse-rea-intervals">{rea.technicalShots.map(shot => <li key={`${shot.index}-${shot.startSeconds}`}><div><button type="button" className="inverse-evidence-time" onClick={() => onSeek(shot.startSeconds)} aria-label={`Jump to technical interval ${shot.index + 1} at ${videoTime(shot.startSeconds)}`}>{videoTime(shot.startSeconds)}–{videoTime(shot.endSeconds)}</button><strong>{shot.label.replace(/_/g, ' ')}</strong>{typeof shot.confidence === 'number' && Number.isFinite(shot.confidence) && <span>{Math.round(Math.min(1, Math.max(0, shot.confidence)) * 100)}% heuristic score</span>}</div>{shot.evidence.length > 0 && <ul>{shot.evidence.map((evidence, index) => <li key={index}>{evidence}</li>)}</ul>}</li>)}</ol> : <p>No technical intervals were returned.</p>}
    {!!rea.assets?.length && itemId && <details className="inverse-rea-section inverse-rea-assets"><summary>Storyboard, contact sheets & audio chart <span>{rea.assets.length} images</span></summary><p>Review the sampled frames and measured audio. A contact sheet can miss a brief action between samples.</p><div>{rea.assets.map(asset => <ReaReportImage key={`${itemId}-${asset.id}`} itemId={itemId} asset={asset}/>)}</div></details>}
    {itemId && <ReaFrameInspector key={`frames-${itemId}`} itemId={itemId} durationSeconds={durationSeconds || Math.max(0, ...rea.technicalShots.map(shot => shot.endSeconds))} disabled={busy}/>}
    {!!rea.sections?.length && <div className="inverse-rea-sections">{rea.sections.map(section => <details className="inverse-rea-section" key={section.id}><summary>{section.title.replace(/_/g, ' ')}</summary><p className="inverse-rea-section-caution">Local tool estimates · unreviewed</p><div className="inverse-rea-report-text"><ResultContent text={section.body}/></div></details>)}</div>}
    {!!rea.soundCandidates?.length && <details className="inverse-rea-section"><summary>Sound-event candidates <span>{rea.soundCandidates.length} moments</span></summary><p>Signal changes can suggest a sound effect. The source and meaning have not been confirmed; listen to each moment.</p><ol className="inverse-rea-sound-candidates">{rea.soundCandidates.map((candidate, index) => <li key={`${candidate.startSeconds}-${index}`}><button type="button" className="inverse-evidence-time" onClick={() => onSeek(candidate.startSeconds)} aria-label={`Listen to sound candidate ${index + 1} at ${videoTime(candidate.startSeconds)}`}>{videoTime(candidate.startSeconds)}–{videoTime(candidate.endSeconds)}</button><span>{candidate.description}</span></li>)}</ol></details>}
    {itemId && onSaved && <ReaReviewForm key={`review-${itemId}`} itemId={itemId} notes={rea.reviewNotes} disabled={busy} onSaved={onSaved}/>}
    {!!rea.capabilities?.length && <details className="inverse-rea-section inverse-rea-capabilities"><summary>Rea-video functions & availability</summary><p>Availability describes this installation. Optional models and generation are separate from this local analysis.</p><dl>{rea.capabilities.map(capability => <div key={capability.id}><dt>{capability.label}<span className={`is-${capability.status}`}>{reaCapabilityLabels[capability.status]}</span></dt><dd>{capability.detail}</dd></div>)}</dl></details>}
    {rea.limitations.length > 0 && <details className="inverse-rea-limitations"><summary>Uncertainties and limitations</summary><ul>{rea.limitations.map((note, index) => <li key={index}>{note}</li>)}</ul></details>}
  </section>
}

export function ReferenceReconstruction({ item, onOpenOutput }: { item: VideoAnalysisItem; onOpenOutput: (item: VideoAnalysisItem) => void }) {
  if (item.result?.reaVideo || item.result?.analysisWorkflowId === 'rea-video' || item.result?.provenance?.workflow?.id === 'rea-video') return <section className="video-recreation" aria-label="Recreation preparation"><p className="recreation-note">Run a model breakdown or review the visual actions before preparing a recreation.</p></section>
  return <VideoReconstruction item={item} onOpenOutput={onOpenOutput}/>
}

export function MissingShotAnalysis({ item, configuration, analysisModelId, busy, onRetry }: { item: VideoAnalysisItem; configuration: VideoAnalysisConfiguration | null; analysisModelId?: string; busy: boolean; onRetry: () => void }) {
  const state = shotAnalysisPresentation(item, configuration, analysisModelId)
  return <div className="inverse-empty inverse-result-empty inverse-shot-recovery" role="status">
    <h3>{state.title}</h3>
    <p>{state.description}</p>
    {state.reason && <p className="inverse-shot-failure-reason">{readableNote(state.reason)}</p>}
    {state.unavailableReason && <p>{state.unavailableReason}</p>}
    <button type="button" className="inverse-primary" disabled={busy || !state.canRun} onClick={onRetry}>{isAnalysisRunning(item) ? 'Working…' : state.actionLabel}</button>
  </div>
}

export function ScriptTemplateSelector({ templates, selectedId, busy, onChange }: { templates: ScriptTemplate[]; selectedId: string; busy: boolean; onChange: (id: string) => void }) {
  const selected = templates.find(template => template.id === selectedId)
  return <details className="inverse-script-advanced">
    <summary>Advanced: optional narrative matching</summary>
    <section className="inverse-template-selector" aria-labelledby="inverse-template-heading">
      <div className="inverse-template-heading"><div><h3 id="inverse-template-heading">Optional narrative matching</h3><p id="inverse-template-description">The fixed nine-column production sheet is always used. This optional analysis adds a separate interpretation; it does not change the table format.</p></div><label htmlFor="inverse-script-template">Narrative pattern<select id="inverse-script-template" value={selectedId} disabled={busy} aria-describedby="inverse-template-description" onChange={event => onChange(event.target.value)}><option value="none">Off · production sheet only</option><option value="auto">Auto · find a supported match</option>{templates.map(template => <option key={template.id} value={template.id}>{template.label}</option>)}</select></label></div>
      {selectedId === 'none' ? <p className="inverse-narrative-off">Narrative matching is off. The model breaks down the actual video's shots, dialogue and production details.</p> : <details className="inverse-template-preview"><summary>{selected ? `Preview ${selected.label}` : `Preview the ${templates.length} optional patterns`}</summary>{selected ? <>
        <p>{selected.description}</p><ol>{selected.stages.map(stage => <li key={stage.id}><strong>{stage.label}</strong><span>{stage.goal}</span></li>)}</ol>{selected.reusablePattern && <p className="inverse-template-formula">{selected.reusablePattern}</p>}{selected.notes.length > 0 && <ul className="inverse-template-notes">{selected.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>}<p className="inverse-template-source">Based on {selected.sources.map(source => `${source.displayName} · ${source.sheet}`).join('; ')}.</p>
      </> : <><p>Auto compares optional narrative patterns with the video. A video can remain unclassified; product quantities and bundle names do not prescribe a shot count.</p><div className="inverse-template-catalog">{templates.map(template => <article key={template.id}><h4>{template.label}</h4><p>{template.stages.map(stage => stage.label).join(' → ')}</p>{template.notes.map((note, index) => <small key={index}>{note}</small>)}</article>)}</div></>}</details>}
    </section>
  </details>
}

export function ScriptAnalysisActions({ disabled, running, starting, mode, workflow, onModeChange, onAnalyze }: { disabled: boolean; running: boolean; starting: boolean; mode: AnalysisMode; workflow?: VideoAnalysisWorkflow; onModeChange: (mode: AnalysisMode) => void; onAnalyze: (mode: AnalysisMode, view?: 'script') => void }) {
  const technical = workflow?.id === 'rea-video'
  return <div className="inverse-production-actions">
    <button type="button" className="inverse-primary" disabled={disabled} onClick={() => onAnalyze('both', 'script')}><Icon name="spark" size={15}/>{running ? 'Working…' : starting ? 'Starting…' : technical ? 'Rea-video breakdown' : 'Script breakdown'}</button>
    <p>{technical ? 'Runs a local technical breakdown. The nine-column sheet contains measured details; meaning, dialogue and uncertain visual details remain unfilled.' : 'Runs a fresh video + audio analysis with the selected model and fills the nine-column production sheet from the media.'}</p>
    {!technical && <details className="inverse-other-analysis"><summary>Other analysis modes</summary><div className="inverse-analyze-actions"><label className="inverse-visually-hidden" htmlFor="inverse-analysis-mode">Other analysis to run</label><select id="inverse-analysis-mode" value={mode} disabled={disabled} onChange={event => onModeChange(event.target.value as AnalysisMode)}><option value="breakdown">Shots + sound timing</option><option value="script">Transcript & visible text only</option><option value="audio">Audio only</option></select><button type="button" className="inverse-text-button" disabled={disabled} onClick={() => onAnalyze(mode)}>Run selected analysis</button></div></details>}
  </div>
}

export function ScriptBreakdownPanel({ result, onSeek }: { result: VideoAnalysisResult; onSeek: (seconds: number) => void }) {
  const breakdown = result.scriptBreakdown
  const structure = result.scriptStructure?.requestedTemplateId === 'none' ? undefined : result.scriptStructure
  if (!breakdown && !structure) return null
  const evidenceLabel = { speech: 'Spoken words', onScreenText: 'On-screen text', shot: 'Shot observation' }
  return <div className="inverse-script-analysis">
    {breakdown && <section className="inverse-script-breakdown">
      <div className="inverse-script-heading"><h4>Script breakdown</h4><span>分镜脚本 · nine-column production sheet</span></div>
      <p className="inverse-script-explanation">{result.reaVideo ? 'Local measurements fill the supported timing and camera fields. Visual meaning, speech and on-screen text were not analyzed. — means the detail was not established from the media.' : "The model describes this video's observed production details. Timed sections can occur within a continuous take; speech/text-only sections do not establish camera cuts. — means the detail was not established from the media."}</p>
      {breakdown.rows.length ? <div className="inverse-script-table-scroll" role="region" aria-label="Script breakdown production table" tabIndex={0}>
        <table className="inverse-script-table"><caption>分镜编号 | 取景地 | 画面 | 台词 | 镜头运用 | 秒数 | 花字 | 背景特效与滤镜 | 备注</caption>
          <thead><tr>{SCRIPT_BREAKDOWN_COLUMNS.map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
          <tbody>{breakdown.rows.map(row => <tr key={`${row.basis}-${row.index}-${row.startSeconds}`}>
            <th scope="row"><span>{scriptRowLabel(row)}</span><button type="button" className="inverse-evidence-time" onClick={() => onSeek(row.startSeconds)} aria-label={`Jump to ${scriptRowLabel(row).toLowerCase()} at ${videoTime(row.startSeconds)}`}>{videoTime(row.startSeconds)}–{videoTime(row.endSeconds)}</button></th>
            <td>{row.location || '—'}</td><td>{row.visual || '—'}</td><td>{row.dialogue || '—'}</td><td>{row.camera || '—'}</td><td>{row.durationSeconds.toFixed(2)}s</td><td>{row.onScreenText || '—'}</td><td>{row.effects || '—'}</td><td>{row.notes || '—'}</td>
          </tr>)}</tbody>
        </table>
      </div> : <p className="inverse-no-text">No supported breakdown rows were returned. Run Script breakdown to analyze the actual video and audio.</p>}
      {breakdown.limitations.length > 0 && <ul className="inverse-script-limitations">{breakdown.limitations.map((note, index) => <li key={index}>{note}</li>)}</ul>}
    </section>}
    {structure && <details className="inverse-saved-narrative"><summary>Optional saved narrative interpretation</summary><section className="inverse-script-structure"><div className="inverse-script-heading"><h4>Structure interpretation</h4><span>{scriptStructureStatusLabel(structure.status)}</span></div>{structure.templateLabel && <p className="inverse-structure-template">{structure.templateLabel}</p>}{structure.summary && <p className="inverse-script-explanation">{structure.summary}</p>}{structure.stages.length > 0 && <ol className="inverse-structure-stages">{structure.stages.map((stage, index) => <li key={`${stage.stageId}-${index}`}><div><h5>{stage.label}</h5><button type="button" className="inverse-evidence-time" onClick={() => onSeek(stage.startSeconds)}>{videoTime(stage.startSeconds)}–{videoTime(stage.endSeconds)}</button></div><p>{stage.interpretation}</p><ul>{stage.evidence.map((evidence, evidenceIndex) => <li key={evidenceIndex}><span>{evidenceLabel[evidence.source]}</span><button type="button" className="inverse-evidence-time" onClick={() => onSeek(evidence.startSeconds)}>{videoTime(evidence.startSeconds)}–{videoTime(evidence.endSeconds)}</button><q>{evidence.text}</q></li>)}</ul></li>)}</ol>}{structure.missingStages.length > 0 && <p className="inverse-structure-missing">Stages without supporting evidence: {structure.missingStages.map(stage => stage.label).join(' · ')}.</p>}{structure.reusablePattern && <div className="inverse-reusable-pattern"><h5>Reusable structure</h5><p>{structure.reusablePattern}</p></div>}{structure.sources.length > 0 && <details className="inverse-template-provenance"><summary>Template sources and revision</summary><p>Requested: {structure.requestedTemplateId} · Revision: {structure.templateRevision}</p>{structure.sources.map(source => <p key={source.id}>{source.displayName} · {source.sheet} · {source.headerRange}</p>)}</details>}{structure.limitations.length > 0 && <ul className="inverse-script-limitations">{structure.limitations.map((note, index) => <li key={index}>{note}</li>)}</ul>}</section></details>}
  </div>
}

export function InversePrompting() {
  const [configuration, setConfiguration] = useState<VideoAnalysisConfiguration | null>(null)
  const [preferredAnalysisModelId, setPreferredAnalysisModelId] = useState(savedAnalysisModelId)
  const [preferredAnalysisWorkflowId, setPreferredAnalysisWorkflowId] = useState(savedAnalysisWorkflowId)
  const [preferredScriptTemplateId, setPreferredScriptTemplateId] = useState(savedScriptTemplateId)
  const [items, setItems] = useState<VideoAnalysisItem[]>([])
  const [channels, setChannels] = useState<VideoChannel[]>([])
  const [channelId, setChannelId] = useState('')
  const [channelTab, setChannelTab] = useState<'library' | 'style' | 'faces'>('library')
  const [showAddChannel, setShowAddChannel] = useState(false)
  const [channelLink, setChannelLink] = useState('')
  const [instagramConnection, setInstagramConnection] = useState<InstagramConnection | null>(null)
  const [connectionError, setConnectionError] = useState('')
  const [showConnection, setShowConnection] = useState(false)
  const [connectionBusy, setConnectionBusy] = useState(false)
  const [accountId, setAccountId] = useState('')
  const [accessToken, setAccessToken] = useState('')
  const [referenceSearch, setReferenceSearch] = useState('')
  const [visibleReferences, setVisibleReferences] = useState(24)
  const [showAddVideo, setShowAddVideo] = useState(false)
  const [selectedId, setSelectedId] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [pollError, setPollError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState('')
  const [link, setLink] = useState('')
  const [dragging, setDragging] = useState(false)
  const [tab, setTab] = useState<'shots' | 'script' | 'audio'>('script')
  const [mode, setMode] = useState<AnalysisMode>('script')
  const [media, setMedia] = useState('')
  const [mediaError, setMediaError] = useState('')
  const [currentTime, setCurrentTime] = useState(0)
  const [revision, setRevision] = useState(0)
  const fileInput = useRef<HTMLInputElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const mounted = useRef(true)
  const operation = useRef<AbortController | null>(null)
  const previousSelections = useRef<Record<string, string>>({})
  const styleDrafts = useRef<Record<string, ChannelStyle>>({})
  const activeChannelId = useRef(channelId)
  activeChannelId.current = channelId
  const channel = channels.find(value => value.id === channelId)
  const channelItems = uniqueChannelReferences(items.filter(item => videoBelongsToChannel(item, channel, channels)))
  const importIssues = channelItems.filter(item => item.status === 'failed' && !item.hasMedia && !item.hasResult && !item.result)
  const libraryItems = channelItems.filter(item => !importIssues.includes(item))
  const savedVideoCount = libraryItems.filter(item => item.hasMedia === true).length
  const selected = channelItems.find(item => item.id === selectedId)
  const importedUrls = new Set(libraryItems.map(item => videoReferenceKey(item.source.url)))
  const catalog = (channel?.discoveredVideos || []).filter(value => !importedUrls.has(videoReferenceKey(value.url)))
  const bulkRunning = channels.some(value => ['running', 'stopping'].includes(value.bulkImport?.status || '') || ['running', 'stopping'].includes(value.bulkAnalysis?.status || ''))
  const channelBulkRunning = ['running', 'stopping'].includes(channel?.bulkImport?.status || '')
  const channelAnalysisRunning = ['running', 'stopping'].includes(channel?.bulkAnalysis?.status || '')
  const currentChannelAnalysis = channelAnalysisRunning ? channelItems.find(item => item.id === channel?.bulkAnalysis?.currentItemId) : undefined
  const active = items.some(isAnalysisRunning) || bulkRunning
  const discovering = channels.some(value => value.discovery?.status === 'running')
  const discovery = channel ? channelDiscoveryPresentation(channel) : null
  const search = referenceSearch.trim().toLocaleLowerCase()
  const matchingItems = search ? libraryItems.filter(item => `${item.title} ${item.source.url || ''}`.toLocaleLowerCase().includes(search)) : libraryItems
  const matchingCatalog = search ? catalog.filter(entry => `${entry.title} ${entry.url}`.toLocaleLowerCase().includes(search)) : catalog
  const visibleItems = matchingItems.slice(0, visibleReferences)
  const visibleCatalog = matchingCatalog.slice(0, Math.max(0, visibleReferences - visibleItems.length))
  const matchingCount = matchingItems.length + matchingCatalog.length
  const shownCount = visibleItems.length + visibleCatalog.length
  const channelThumbnails = new Map((channel?.discoveredVideos || []).map(entry => [videoReferenceKey(entry.url), entry.thumbnailUrl]))
  const maxBytes = configuration?.limits?.maxUploadBytes || defaultMaxVideoBytes
  const analysisModels = availableAnalysisModels(configuration)
  const analysisWorkflows = availableAnalysisWorkflows(configuration)
  const analysisWorkflow = selectedAnalysisWorkflow(configuration, preferredAnalysisWorkflowId)
  const technicalWorkflow = analysisWorkflow?.id === 'rea-video'
  const analysisModel = selectedAnalysisModel(configuration, preferredAnalysisModelId)
  const analysisModelNotice = analysisModelSelectionNotice(configuration, preferredAnalysisModelId)
  const selectedCapabilities = selectedWorkflowCapabilities(configuration, analysisWorkflow, analysisModel)
  const analysisAvailable = selectedCapabilities.available
  const cloudSelected = !!analysisModel && analysisModel.provider !== 'local'
  const providerLabel = analysisProviderLabel(analysisModel?.provider)
  const scriptTemplates = configuration?.scriptTemplates || []
  const scriptTemplateId = selectedScriptTemplateId(configuration, preferredScriptTemplateId)
  const analysisSelectionLabel = technicalWorkflow ? analysisWorkflow.label : analysisModel?.label || providerLabel

  function changeAnalysisWorkflow(id: string) {
    if (!analysisWorkflows.some(workflow => workflow.id === id && workflow.available)) return
    setPreferredAnalysisWorkflowId(id)
    try { localStorage.setItem(analysisWorkflowStorageKey, id) } catch { /* The selection still works when browser storage is unavailable. */ }
  }

  function changeAnalysisModel(id: string) {
    if (!analysisModels.some(model => model.id === id && model.available)) return
    setPreferredAnalysisModelId(id)
    try { localStorage.setItem(analysisModelStorageKey, id) } catch { /* The selection still works when browser storage is unavailable. */ }
  }
  function changeScriptTemplate(id: string) {
    if (id !== 'none' && id !== 'auto' && !scriptTemplates.some(template => template.id === id)) return
    setPreferredScriptTemplateId(id)
    try { localStorage.setItem(scriptTemplateStorageKey, id) } catch { /* The selection still works when browser storage is unavailable. */ }
  }

  function upsert(item: VideoAnalysisItem) {
    setItems(previous => mergeVideoAnalyses(previous, [item]))
  }
  function upsertChannel(updated: VideoChannel) {
    setChannels(previous => mergeVideoChannels(previous, [updated]))
  }
  function selectChannel(id: string, available = channels) {
    previousSelections.current[channelId] = selectedId
    const next = available.find(value => value.id === id)
    const references = items.filter(item => videoBelongsToChannel(item, next, available))
    setChannelId(id); setSelectedId(previousSelections.current[id] || references[0]?.id || '')
    setReferenceSearch(''); setVisibleReferences(24)
    setAccessToken(''); setShowConnection(false)
    setChannelTab('library'); setShowAddVideo(false); setNotice(''); setError('')
  }
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; operation.current?.abort() }
  }, [])
  useEffect(() => {
    let stopped = false
    void getInstagramConnection().then(({ connection }) => {
      if (stopped) return
      setInstagramConnection(connection); setAccountId(connection.accountId || '')
    }).catch(() => { if (!stopped) setConnectionError('Could not check the Instagram connection. Open connection settings to try again.') })
    return () => { stopped = true }
  }, [])
  useEffect(() => {
    let stopped = false
    setLoading(true); setError('')
    void Promise.allSettled([getVideoAnalysisConfiguration(), listVideoAnalyses(), listVideoChannels()]).then(([status, library, accounts]) => {
      if (stopped) return
      if (status.status === 'fulfilled') setConfiguration(status.value)
      const available = accounts.status === 'fulfilled' ? accounts.value.channels || [] : []
      if (accounts.status === 'fulfilled') setChannels(previous => mergeVideoChannels(previous, available))
      else setError(message(accounts.reason, 'Could not open your channels.'))
      if (library.status === 'fulfilled') {
        const rows = library.value.items || []
        setItems(previous => mergeVideoAnalyses(previous, rows))
        const nextId = activeChannelId.current || available[0]?.id || 'unassigned'
        if (!activeChannelId.current) setChannelId(nextId)
        const nextChannel = available.find(value => value.id === nextId)
        setSelectedId(previous => rows.some(row => row.id === previous && videoBelongsToChannel(row, nextChannel, available)) ? previous : rows.find(row => videoBelongsToChannel(row, nextChannel, available))?.id || '')
      } else setError(message(library.reason, 'Could not open your reference library.'))
      if (status.status === 'rejected' && library.status === 'fulfilled') setError(message(status.reason, 'Could not check analysis availability.'))
      setLoading(false)
    })
    return () => { stopped = true }
  }, [revision])
  useEffect(() => {
    if (!active && !discovering) return
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined
    async function poll() {
      try {
        const [response, accountResponse] = await Promise.all([active ? listVideoAnalyses() : Promise.resolve(null), listVideoChannels()])
        if (stopped) return
        if (response) setItems(previous => mergeVideoAnalyses(previous, response.items || []))
        setPollError('')
        if (accountResponse) setChannels(previous => mergeVideoChannels(previous, accountResponse.channels))
      } catch (e) { if (!stopped) setPollError(message(e, 'Progress is temporarily unavailable. Retrying…')) }
      if (!stopped) timer = setTimeout(() => void poll(), 3500)
    }
    timer = setTimeout(() => void poll(), 2500)
    return () => { stopped = true; if (timer) clearTimeout(timer) }
  }, [active, discovering])
  useEffect(() => {
    if (!selectedId || !selected) return
    let stopped = false
    void getVideoAnalysis(selectedId).then(({ item }) => { if (!stopped) upsert(item) }).catch(e => { if (!stopped) setError(message(e, 'Could not open this video.')) })
    return () => { stopped = true }
  }, [selectedId, selected?.updatedAt])
  // Fetch through the same authenticated API origin; never use a supplied remote URL as a player source.
  useEffect(() => {
    setMedia(''); setMediaError(''); setCurrentTime(0)
    if (!selectedId || !selected || selected.hasMedia === false) return
    const controller = new AbortController()
    let stopped = false, objectUrl = ''
    void getReferenceMedia(selectedId, controller.signal).then(blob => {
      if (stopped) return
      objectUrl = URL.createObjectURL(blob); setMedia(objectUrl)
    }).catch(e => { if (!stopped && !controller.signal.aborted) setMediaError(message(e, 'The video preview could not be loaded.')) })
    return () => { stopped = true; controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [selectedId, selected?.hasMedia])

  async function upload(file?: File) {
    if (!file || busy) return
    setError(''); setNotice('')
    if (file.size > maxBytes) { setError(`Choose a video smaller than ${fileSize(maxBytes)}.`); return }
    if (!file.size) { setError('This file is empty. Choose another video.'); return }
    if (!file.type.startsWith('video/') && !/\.(mp4|mov|webm|mkv|m4v|avi)$/i.test(file.name)) { setError('Choose a video file such as MP4, MOV or WebM.'); return }
    setBusy('uploading'); operation.current = new AbortController()
    try {
      const targetChannel = channel?.id
      const { item } = await uploadReferenceVideo(file, operation.current.signal, targetChannel)
      if (!mounted.current) return
      upsert(item); if (activeChannelId.current === (targetChannel || 'unassigned')) setSelectedId(item.id)
      setShowAddVideo(false); setNotice('Video saved. Choose Script breakdown to create your breakdown and script.')
    } catch (e) { if (mounted.current) setError(message(e, 'Could not upload this video.')) }
    finally { if (mounted.current) setBusy(''); operation.current = null }
  }
  async function queueImport(url: string, fromForm = false) {
    if (busy || !url.trim()) return
    setBusy('importing'); setError(''); setNotice('')
    try {
      const targetChannel = channel?.id
      const { item } = await importReferenceVideo(url, targetChannel)
      if (!mounted.current) return
      upsert(item); if (activeChannelId.current === (targetChannel || 'unassigned')) setSelectedId(item.id)
      if (fromForm) { setLink(''); setShowAddVideo(false) }
      setNotice('Import started. When the video is ready, choose Script breakdown.')
    } catch (e) { if (mounted.current) setError(message(e, 'Could not import this video. You can upload the video file instead.')) }
    finally { if (mounted.current) setBusy('') }
  }
  async function importVideo(event: FormEvent) {
    event.preventDefault()
    await queueImport(link, true)
  }
  async function addChannel(event: FormEvent) {
    event.preventDefault(); if (busy || !channelLink.trim()) return
    setBusy('channel'); setError('')
    try {
      const addedSource = await addVideoSource(channelLink)
      if (!mounted.current) return
      if (addedSource.kind === 'video') {
        const item = addedSource.item
        upsert(item); selectChannel(item.source.channelId || 'unassigned'); setSelectedId(item.id)
        setChannelLink(''); setShowAddChannel(false)
        setNotice(item.hasMedia ? 'Video imported and ready. Choose Script breakdown for the shot list and script.' : 'Video import started. It will appear here when ready.')
        return
      }
      const added = addedSource.channel
      upsertChannel(added); selectChannel(added.id, [...channels.filter(value => value.id !== added.id), added]); setChannelLink(''); setShowAddChannel(false)
      setNotice(added.syncError ? 'Channel added. Its public video list needs another sync.' : 'Channel added. Its public references are ready to explore.')
    } catch (e) { if (mounted.current) setError(message(e, 'Could not add this channel.')) }
    finally { if (mounted.current) setBusy('') }
  }
  async function syncChannel() {
    if (!channel || busy) return
    const id = channel.id; setBusy('syncing'); setError('')
    try {
      const { channel: updated } = await syncVideoChannel(id)
      if (!mounted.current) return
      upsertChannel(updated); setNotice(updated.syncError ? 'Saved references are available. The public list could not be refreshed.' : 'Channel refreshed. Available public videos are listed below.')
    } catch (e) { if (mounted.current) setError(message(e, 'Could not refresh this channel.')) }
    finally { if (mounted.current) setBusy('') }
  }
  async function importChannelVideos(stop = false) {
    if (!channel || busy || !stop && bulkRunning) return
    setBusy('bulk'); setError(''); setNotice('')
    try {
      const { channel: updated } = await (stop ? stopChannelImports(channel.id) : importAllChannelVideos(channel.id))
      if (!mounted.current) return
      upsertChannel(updated)
      setNotice(stop ? 'Stopping after the current video. Imported videos will stay saved.' : 'Channel import started. You can leave this page; progress is saved on the server.')
    } catch (e) { if (mounted.current) setError(message(e, 'Could not update the channel import.')) }
    finally { if (mounted.current) setBusy('') }
  }
  async function analyzeChannelVideos(stop = false) {
    if (!channel || busy || !stop && bulkRunning) return
    if (!stop && !analysisAvailable) { setError(selectedCapabilities.reason || 'Choose an available analysis workflow first.'); return }
    const selectedTemplateId = scriptTemplateId
    setBusy('bulk-analysis'); setError(''); setNotice('')
    try {
      const { channel: updated } = await (stop ? stopChannelAnalyses(channel.id) : analyzeAllChannelVideos(channel.id, analysisModel?.id, selectedTemplateId, analysisWorkflow?.id))
      if (!mounted.current) return
      upsertChannel(updated)
      setNotice(stop ? 'Analysis will stop after the current video. Finished results stay saved.' : `Analyzing this channel’s saved videos with ${analysisSelectionLabel}, one at a time. Up-to-date results with this workflow are skipped.`)
    } catch (e) { if (mounted.current) setError(message(e, 'Could not update the channel analysis.')) }
    finally { if (mounted.current) setBusy('') }
  }
  async function discoverChannel() {
    if (!channel || busy || discovery?.running || connectionBusy) return
    const id = channel.id; setBusy('discovering'); setError(''); setNotice('')
    try {
      const { channel: updated } = await discoverVideoChannel(id)
      if (!mounted.current) return
      upsertChannel(updated)
    } catch (e) { if (mounted.current) setError(message(e, 'Could not start channel discovery.')) }
    finally { if (mounted.current) setBusy('') }
  }
  async function saveInstagramConnection(event: FormEvent) {
    event.preventDefault()
    if (connectionBusy || discovering || !accountId.trim() || !accessToken.trim()) return
    setConnectionBusy(true); setConnectionError('')
    try {
      const { connection } = await connectInstagram(accountId, accessToken)
      if (!mounted.current) return
      setInstagramConnection(connection); setAccountId(connection.accountId || accountId.trim()); setShowConnection(false)
      setNotice('Instagram connection verified. Choose Discover full channel to find available videos.')
    } catch {
      if (mounted.current) setConnectionError('Instagram could not verify this connection. Check your professional account ID, token and required permissions, then try again.')
    } finally { if (mounted.current) { setAccessToken(''); setConnectionBusy(false) } }
  }
  async function removeInstagramConnection() {
    if (connectionBusy || discovering) return
    setConnectionBusy(true); setConnectionError('')
    try {
      const { connection } = await disconnectInstagram()
      if (!mounted.current) return
      setInstagramConnection(connection); setAccessToken(''); setAccountId(''); setNotice('Instagram disconnected. Discovered references are still in your library.')
    } catch { if (mounted.current) setConnectionError('Could not disconnect Instagram. Try again.') }
    finally { if (mounted.current) setConnectionBusy(false) }
  }
  async function analyze(requestedMode: AnalysisMode = mode, requestedView?: 'script') {
    if (!selected || busy || isAnalysisRunning(selected) || selected.hasMedia === false) return
    if (!analysisAvailable) { setError(selectedCapabilities.reason || 'Choose an available analysis workflow first.'); return }
    const id = selected.id
    const selectedTemplateId = scriptTemplateId
    setBusy('analyzing'); setError(''); setNotice('')
    try {
      const { item } = await analyzeReferenceVideo(id, technicalWorkflow ? 'both' : requestedMode, analysisModel?.id, selectedTemplateId, analysisWorkflow?.id)
      if (!mounted.current) return
      upsert(item); setNotice(`Analysis started with ${analysisSelectionLabel}. Your results will appear here automatically.`)
      if (requestedView === 'script') setTab('script')
      else if (requestedMode === 'audio') setTab('audio')
      else if (requestedMode === 'breakdown') setTab('shots')
      else if (requestedMode === 'script') setTab('script')
    } catch (e) { if (mounted.current) setError(message(e, 'Could not start analysis.')) }
    finally { if (mounted.current) setBusy('') }
  }
  async function copy() {
    if (!selected) return
    try { await navigator.clipboard.writeText(analysisText(selected, tab)); setNotice(`${tab === 'shots' ? 'Shot breakdown' : tab === 'audio' ? 'Audio timeline' : 'Script and text'} copied.`) }
    catch { setError('Copy is unavailable in this browser. Use Download to save the text.') }
  }
  async function copyPrompt(value: string) {
    try { await navigator.clipboard.writeText(value); setNotice('Reconstruction prompt copied.') }
    catch { setError('Copy is unavailable in this browser. Download the analysis to save the prompt.') }
  }
  async function download(format: 'txt' | 'md' | 'json') {
    if (!selected || busy) return
    const id = selected.id, title = selected.title.replace(/[^\p{L}\p{N} _.-]/gu, '').slice(0, 80) || 'video-analysis'
    setBusy('exporting'); setError('')
    try { const blob = await exportVideoAnalysis(id, format); if (mounted.current) saveBlob(blob, `${title}.${format}`) }
    catch (e) { if (mounted.current) setError(message(e, 'Could not download the analysis.')) }
    finally { if (mounted.current) setBusy('') }
  }
  function seek(seconds: number) { if (video.current) { video.current.currentTime = seconds; video.current.focus() } }
  const result = selected?.result
  const resultNotes = videoAnalysisNotes(result)
  const shots = result?.shots || []
  const speech = result?.script?.segments || []
  const overlay = result?.script?.onScreenText || []
  const audioSegments = result?.audio?.segments?.length ? result.audio.segments : result?.audio?.semanticSegments || []
  const audioDescription = result?.audio?.semanticDescription || result?.audio?.description
  const audioNotes = [...new Set([...(result?.audio?.limitations || []), ...(result?.audio?.semanticLimitations || [])])]
  const modelDescription = !analysisAvailable ? selectedCapabilities.reason || 'No analysis workflow is available. Check the server connection before analyzing.'
    : technicalWorkflow ? 'Rea-video runs local technical measurements without using the selected cloud model. This version does not explain meaning, recognize individual objects or transcribe speech. Model and narrative-pattern selections apply when you return to Standard breakdown.'
    : analysisModel?.inputMode === 'video_and_audio' ? `Script breakdown sends the complete video with its audio to ${providerLabel} for a joint shot, speech and sound breakdown. Audio only sends the audio track. The same model is used for channel analysis and shot retries.`
    : cloudSelected ? `New analyses use ${analysisModel?.label || providerLabel}. The same selection applies to individual videos, shot retries and Analyze all videos.`
    : 'Analysis runs with the locally configured video and audio models.'
  const capabilityFeatures = [
    ['Shot timing', selectedCapabilities.shots],
    ['Visual descriptions', selectedCapabilities.vision],
    ['Spoken script', selectedCapabilities.speech],
    ['Sound timing', selectedCapabilities.audio],
    ['Music & sound labels', selectedCapabilities.semanticAudio],
  ] as const
  const capabilityNotes = ['warnings', 'limitations', 'notes'].flatMap(key => {
    const value = configuration?.capabilities?.[key]
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : typeof value === 'string' ? [value] : []
  }).filter(note => !technicalWorkflow && configuration?.capabilities.provider === analysisModel?.provider || /ffmpeg|ffprobe|media tools?|duration|storage/i.test(note))
  if (selectedCapabilities.reason && !capabilityNotes.includes(selectedCapabilities.reason)) capabilityNotes.unshift(selectedCapabilities.reason)

  function timedText(rows: TimedText[], empty: string) {
    return rows.length ? <div className="inverse-transcript">{rows.map((entry, index) => <div key={`${entry.startSeconds}-${index}`}><button type="button" onClick={() => seek(entry.startSeconds)} title="Jump to this moment">{videoTime(entry.startSeconds)}</button><p>{entry.text}</p></div>)}</div> : <p className="inverse-no-text">{empty}</p>
  }
  function soundDetails(segment: AudioSegment) {
    const measurements = audioMeasurementText(segment)
    return <div className="inverse-sound-details">
      {segment.description && <p>{segment.description}</p>}
      {!!segment.events?.length && <p>Sound label estimates: {segment.events.map(audioEventText).join(' · ')}</p>}
      {(measurements || !!segment.onsetTimes?.length) && <details><summary>Sound measurements</summary>{measurements && <p>{measurements}</p>}{!!segment.onsetTimes?.length && <><p>{segment.onsetTimes.length} changes in audio energy; these are not confirmed musical beats or sound effects.</p><div>{segment.onsetTimes.map((time, index) => <button type="button" key={`${time}-${index}`} onClick={() => seek(time)} title="Play from this sound change">{videoTime(time)}</button>)}</div></>}</details>}
    </div>
  }
  return <div className="inverse-workspace">
    <div className="inverse-channel-topbar"><span className="inverse-channel-topbar-label">YOUR CHANNELS</span><nav aria-label="Video channels">{channels.map(account => <button key={account.id} type="button" className={`inverse-account-pill ${channelId === account.id ? 'is-active' : ''}`} aria-pressed={channelId === account.id} onClick={() => selectChannel(account.id)}><ChannelAvatar key={`${account.id}-${account.avatarUrl}`} channel={account}/><span>@{account.handle}</span></button>)}<button type="button" className={`inverse-account-pill inverse-unassigned-pill ${channelId === 'unassigned' ? 'is-active' : ''}`} aria-pressed={channelId === 'unassigned'} onClick={() => selectChannel('unassigned')}><ChannelAvatar/><span>Unassigned</span></button></nav><button type="button" className="inverse-add-channel" aria-expanded={showAddChannel} onClick={() => setShowAddChannel(previous => !previous)}><span aria-hidden="true">＋</span>Add channel</button></div>
    {showAddChannel && <form className="inverse-add-channel-form" onSubmit={event => void addChannel(event)}><div><strong>Add a channel or video</strong><p>Instagram and TikTok profile links create a channel. Individual video links import a reference.</p></div><label className="inverse-visually-hidden" htmlFor="inverse-channel-link">Channel or video URL</label><input id="inverse-channel-link" type="url" placeholder="Paste an Instagram or TikTok profile, or a video link" value={channelLink} onChange={event => setChannelLink(event.target.value)} required autoFocus/><button className="inverse-primary" type="submit" disabled={!!busy || !channelLink.trim()}>{busy === 'channel' ? 'Adding…' : 'Add reference'}</button><button type="button" className="inverse-text-button" onClick={() => setShowAddChannel(false)}>Cancel</button></form>}
    <header className="inverse-heading inverse-account-heading"><div className="inverse-account-identity"><ChannelAvatar key={`${channelId}-${channel?.avatarUrl}`} channel={channel} size="large"/><div><span className="eyebrow">VIDEO / INVERSE PROMPTING</span><h1>{channel?.name || (loading ? 'Your channels' : 'Unassigned references')}<span>.</span></h1>{channel ? <a href={sourceUrl(channel.url)} target="_blank" rel="noopener noreferrer">@{channel.handle}<span>{channel.platform === 'tiktok' ? 'TikTok' : 'Instagram'} ↗</span></a> : <p>Files and references without a verified channel. Add an account above to create its own workspace.</p>}</div></div><div className="inverse-account-stats"><div><strong>{libraryItems.length}</strong><span>Saved references</span></div><div><strong>{channel?.observations?.analyzedCount ?? channelItems.filter(item => item.hasResult || item.result).length}</strong><span>Analyzed</span></div></div></header>
    <div className="inverse-channel-tabs" aria-label="Channel workspace"><button type="button" aria-pressed={channelTab === 'library'} className={channelTab === 'library' ? 'is-active' : ''} onClick={() => setChannelTab('library')}>Reference library<span>{libraryItems.length + catalog.length}</span></button><button type="button" aria-pressed={channelTab === 'faces'} className={channelTab === 'faces' ? 'is-active' : ''} disabled={!channel} onClick={() => setChannelTab('faces')}>Facecap references</button><button type="button" aria-pressed={channelTab === 'style'} className={channelTab === 'style' ? 'is-active' : ''} disabled={!channel} onClick={() => setChannelTab('style')}>Style & production<span aria-hidden="true">↗</span></button></div>
    {channelTab === 'library' && <div className="inverse-library-introduction"><div><h2>The references behind the style.</h2><p>Explore shots, speech and sound together, then keep what matters for this channel.</p></div><div className="inverse-bulk-actions">{channel && <><button type="button" className="inverse-primary" disabled={!!busy || !channel.discoveredVideos.length || bulkRunning} onClick={() => void importChannelVideos()}>Import all videos <span>{channel.discoveredVideos.length}</span></button><button type="button" className="inverse-primary" disabled={!!busy || !savedVideoCount || bulkRunning || !analysisAvailable} onClick={() => void analyzeChannelVideos()}><Icon name="spark" size={15}/>Analyze all videos <span>{savedVideoCount}</span></button></>}<button type="button" className="inverse-primary" onClick={() => setShowAddVideo(previous => !previous)} aria-expanded={showAddVideo}><span aria-hidden="true">＋</span>Add video</button></div></div>}
    {channelTab === 'library' && configuration && <div className="inverse-provider-status" aria-label="Analysis settings"><AnalysisWorkflowSelector workflows={analysisWorkflows} selected={analysisWorkflow} busy={!!busy} onChange={changeAnalysisWorkflow}/><div className="inverse-provider-heading"><AnalysisModelSelector models={analysisModels} selected={analysisModel} busy={!!busy || technicalWorkflow} notice={technicalWorkflow ? undefined : analysisModelNotice} onChange={changeAnalysisModel}/><strong>{technicalWorkflow ? 'Local technical tools' : providerLabel}{!technicalWorkflow && analysisModel?.model && <span>{analysisModel.model}</span>}</strong></div><p id="inverse-analysis-model-description">{modelDescription}</p></div>}
    {channelTab === 'library' && !technicalWorkflow && scriptTemplates.length > 0 && <ScriptTemplateSelector templates={scriptTemplates} selectedId={scriptTemplateId} busy={!!busy} onChange={changeScriptTemplate}/>}
    {channelTab === 'library' && channel && <section className="inverse-bulk-status" aria-label="Channel video import"><p>{channel.bulkImport ? channel.bulkImport.message : `Import all videos saves the ${channel.discoveredVideos.length} currently discovered references and skips saved videos. The existing file, duration and storage limits apply.`}</p>{!discovery?.complete && <small>This channel list may be a public preview. Only videos discovered so far can be imported.</small>}{channel.bulkImport && <><div className="inverse-bulk-progress"><progress max={Math.max(1, channel.bulkImport.total)} value={channel.bulkImport.processed} aria-label="Channel import progress"/><span>{channel.bulkImport.processed} / {channel.bulkImport.total} processed · {channel.bulkImport.imported} imported · {channel.bulkImport.skipped} already saved · {channel.bulkImport.failed} failed</span>{channelBulkRunning && <button type="button" className="inverse-text-button" disabled={!!busy || channel.bulkImport.status === 'stopping'} onClick={() => void importChannelVideos(true)}>{channel.bulkImport.status === 'stopping' ? 'Stopping…' : 'Stop after current'}</button>}</div>{!!channel.bulkImport.failures?.length && <details><summary>Import failures ({channel.bulkImport.failed})</summary>{channel.bulkImport.failures.map(entry => <p key={entry.url}><a href={sourceUrl(entry.url)} target="_blank" rel="noopener noreferrer">Open video ↗</a> · {entry.error}</p>)}</details>}</>}</section>}
    {channelTab === 'library' && channel && <section className="inverse-bulk-status inverse-analysis-status" aria-label="Channel video analysis">
      <p>{channel.bulkAnalysis?.message || (technicalWorkflow ? `Analyze all videos runs the Rea-video technical workflow on this channel’s ${savedVideoCount} saved video${savedVideoCount === 1 ? '' : 's'}.` : `Analyze all videos creates aligned shots, audio timing, scripts and on-screen text for this channel’s ${savedVideoCount} saved video${savedVideoCount === 1 ? '' : 's'}.`)}</p>
      {currentChannelAnalysis && <p><strong>{currentChannelAnalysis.title}</strong><br/>{currentChannelAnalysis.progress || 'Preparing this video…'}</p>}
      <small>Uses saved videos, one at a time, with {analysisSelectionLabel}. Up-to-date results from this workflow are skipped. Import channel videos first to include them.</small>
      {channel.bulkAnalysis && <>
        <div className="inverse-bulk-progress"><progress max={Math.max(1, channel.bulkAnalysis.total)} value={channel.bulkAnalysis.processed} aria-label="Channel analysis progress"/><span>{channel.bulkAnalysis.processed} / {channel.bulkAnalysis.total} processed · {channel.bulkAnalysis.analyzed} analyzed{channel.bulkAnalysis.partial ? ` (${channel.bulkAnalysis.partial} partial)` : ''} · {channel.bulkAnalysis.skipped} already analyzed · {channel.bulkAnalysis.failed} failed</span>{channelAnalysisRunning && <button type="button" className="inverse-text-button" disabled={!!busy || channel.bulkAnalysis.status === 'stopping'} onClick={() => void analyzeChannelVideos(true)}>{channel.bulkAnalysis.status === 'stopping' ? 'Stopping analysis…' : 'Stop analysis after current'}</button>}</div>
        {!!channel.bulkAnalysis.failures?.length && <details><summary>Analysis failures ({channel.bulkAnalysis.failed})</summary>{channel.bulkAnalysis.failures.map(entry => <p key={entry.itemId}><button type="button" className="inverse-text-button" onClick={() => { setSelectedId(entry.itemId); setNotice('') }}>Open saved video ↗</button>{sourceUrl(entry.url) && <> · <a href={sourceUrl(entry.url)} target="_blank" rel="noopener noreferrer">Original video ↗</a></>} · {entry.error}</p>)}</details>}
      </>}
      {pollError && channelAnalysisRunning && <p className="inverse-discovery-poll-error" role="status">{pollError}</p>}
    </section>}
    {channelTab === 'library' && showAddVideo && <section className="inverse-add-panel inverse-compact-add" aria-labelledby="inverse-add-title"><div className="inverse-section-heading"><span className="inverse-step">＋</span><div><h2 id="inverse-add-title">Add a reference{channel ? ` to @${channel.handle}` : ''}</h2><p>Paste a public video link, or upload a file from your device.</p></div></div><div className="inverse-add-options"><input ref={fileInput} type="file" accept="video/*,.mkv,.m4v" className="inverse-visually-hidden" aria-label="Upload a reference video" disabled={!!busy} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void upload(file) }}/><button type="button" className={`inverse-upload-zone ${dragging ? 'is-dragging' : ''}`} disabled={!!busy} onClick={() => fileInput.current?.click()} onDragOver={event => { event.preventDefault(); setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); void upload(event.dataTransfer.files[0]) }}><Icon name="clip" size={19}/><strong>{busy === 'uploading' ? 'Saving your video…' : 'Drop a video or browse files'}</strong><small>Up to {fileSize(maxBytes)}{configuration?.limits.maxDurationSeconds ? ` · ${Math.round(configuration.limits.maxDurationSeconds / 60)} minutes` : ''}</small></button><div><form className="inverse-link-form" onSubmit={event => void importVideo(event)}><label htmlFor="inverse-video-link" className="inverse-visually-hidden">Profile, reel or video URL</label><Icon name="link" size={17}/><input id="inverse-video-link" type="url" placeholder="Paste an Instagram, TikTok or video link" value={link} disabled={!!busy} onChange={event => setLink(event.target.value)} required/><button type="submit" disabled={!!busy || !link.trim()}>{busy === 'importing' ? 'Adding…' : 'Add video'}<span aria-hidden="true">↗</span></button></form><p className="inverse-import-note">Videos are saved in this account’s library. Public access depends on the platform; private or restricted videos may require an upload.</p></div></div></section>}
    {error && <div className="inverse-alert inverse-error" role="alert"><p>{error}</p><button type="button" onClick={() => setError('')} aria-label="Dismiss error"><Icon name="close" size={14}/></button></div>}
    {notice && <p className="inverse-alert inverse-notice" role="status">{notice}</p>}
    {configuration && <div className="inverse-capability-status" aria-label="Analysis availability">{capabilityFeatures.map(([label, ready]) => <span className={ready ? 'is-ready' : 'is-unavailable'} key={label}><i aria-hidden="true"/>{label}<small>{ready ? 'Ready' : 'Unavailable'}</small></span>)}</div>}
    {capabilityNotes.length > 0 && <details className="inverse-capability-notes"><summary>Analysis availability</summary>{capabilityNotes.map((note, index) => <p key={index}>{note}</p>)}</details>}
    {channelTab === 'style' && channel && <VideoChannelProfile key={channel.id} channel={channel} initialDraft={styleDrafts.current[channel.id]} onDraftChange={(draft, savedDraft) => { if (draft) styleDrafts.current[channel.id] = draft; else if (styleDrafts.current[channel.id] === savedDraft) delete styleDrafts.current[channel.id] }} onSaved={upsertChannel}/>}
    {channelTab === 'faces' && channel && <FaceReferences key={channel.id} channel={channel} items={libraryItems} onOpenVideo={itemId=>{setSelectedId(itemId);setChannelTab('library')}}/>}
    {channelTab === 'library' && <section className="inverse-library" aria-labelledby="inverse-library-title"><div className="inverse-library-heading"><div><span className="eyebrow">{channel ? `@${channel.handle} / REFERENCES` : 'YOUR REFERENCES'}</span><h2 id="inverse-library-title">Reference library <span>{libraryItems.length + catalog.length}</span></h2></div><div className="inverse-library-heading-actions">{channel && <span className="inverse-sync-date">{channel.lastSyncedAt ? `Synced ${readableDate(channel.lastSyncedAt)}` : 'Public preview not synced'}</span>}<button className="inverse-text-button" type="button" disabled={loading || !!busy || !!discovery?.running} onClick={() => channel ? void syncChannel() : setRevision(value => value + 1)}><Icon name="refresh" size={14}/>{loading ? 'Loading…' : busy === 'syncing' ? 'Syncing…' : channel ? 'Refresh profile' : 'Refresh'}</button></div></div>
      {channel && discovery && <section className={`inverse-discovery-panel ${discovery.running ? 'is-running' : discovery.complete ? 'is-complete' : channel.discovery?.status === 'blocked' ? 'is-blocked' : ''}`} aria-labelledby="inverse-discovery-title">
        <div className="inverse-discovery-summary"><div><span className="eyebrow">CHANNEL DISCOVERY</span><h3 id="inverse-discovery-title">{discovery.running && <span className="inverse-progress-dot" aria-hidden="true"/>}{discovery.title}</h3><p>{discovery.message}</p></div><button type="button" className="inverse-primary" disabled={loading || !!busy || discovery.running || connectionBusy} onClick={() => channel.platform === 'tiktok' ? void syncChannel() : void discoverChannel()}>{busy === 'discovering' ? 'Starting…' : discovery.action}</button></div>
        <div className="inverse-discovery-coverage" role="status"><strong>{discovery.count.toLocaleString()} video{discovery.count === 1 ? '' : 's'} discovered</strong><span>{discovery.complete ? 'Reached the end of the available feed' : discovery.running ? 'Feed discovery in progress' : 'Full channel coverage not verified'}</span>{!!channel.discovery?.pagesFetched && <span>{channel.discovery.pagesFetched.toLocaleString()} page{channel.discovery.pagesFetched === 1 ? '' : 's'} checked</span>}</div>
        {discovery.running && <div className="inverse-discovery-indicator" aria-hidden="true"><span/></div>}
        {pollError && discovering && <p className="inverse-discovery-poll-error">{pollError}</p>}
        {channel.platform !== 'tiktok' && <>
        <div className="inverse-discovery-connection"><span>{instagramConnection?.connected ? `Instagram connected${instagramConnection.handle ? ` · @${instagramConnection.handle}` : ''}` : 'Full feed access requires an Instagram connection'}</span><button type="button" className="inverse-text-button" aria-expanded={showConnection} aria-controls="inverse-instagram-connection" onClick={() => { setShowConnection(previous => !previous); setAccessToken('') }}>{instagramConnection?.connected ? 'Connection settings' : 'Connect Instagram'} ↗</button></div>
        {showConnection && <form id="inverse-instagram-connection" className="inverse-instagram-connection-form" onSubmit={event => void saveInstagramConnection(event)}>
          <div><h4>Connect through Meta’s official API</h4><p>Use your own Instagram professional account and a Meta access token. This can discover public business and creator accounts that Meta makes available through Business Discovery. Personal and private accounts may be unavailable.</p></div>
          <p className="inverse-instagram-connection-help">Create a token with <code>instagram_basic</code>, <code>instagram_manage_insights</code> and <code>pages_read_engagement</code>. Your connected professional account ID is different from the channel you want to discover. <a href="https://developers.facebook.com/tools/explorer/" target="_blank" rel="noopener noreferrer">Open Meta’s token tool ↗</a> <a href="https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api" target="_blank" rel="noopener noreferrer">Setup and permissions ↗</a></p>
          <label htmlFor="inverse-instagram-account-id">Your Instagram professional account ID<input id="inverse-instagram-account-id" type="text" inputMode="numeric" autoComplete="off" value={accountId} maxLength={64} required disabled={connectionBusy || discovering} onChange={event => setAccountId(event.target.value)} placeholder="Your connected Instagram account ID"/></label>
          <label htmlFor="inverse-instagram-access-token">Meta access token<input id="inverse-instagram-access-token" name="instagram-access-token" type="password" autoComplete="off" spellCheck={false} value={accessToken} required maxLength={4096} disabled={connectionBusy || discovering} onChange={event => setAccessToken(event.target.value)} placeholder="Paste your token to verify the connection"/></label>
          <p className="inverse-instagram-token-note">The token is sent to your Spur server and stored privately there. It is cleared from this form after each connection attempt.</p>
          {connectionError && <p className="inverse-connection-error" role="alert">{connectionError}</p>}
          <div className="inverse-instagram-connection-actions">{instagramConnection?.connected && <button type="button" className="inverse-text-button" disabled={connectionBusy || discovering} onClick={() => void removeInstagramConnection()}>Disconnect Instagram</button>}<button type="button" className="inverse-text-button" onClick={() => { setShowConnection(false); setAccessToken('') }}>Cancel</button><button type="submit" className="inverse-primary" disabled={connectionBusy || discovering || !accountId.trim() || !accessToken.trim()}>{connectionBusy ? 'Checking…' : 'Verify & connect'}</button></div>
          {discovering && <p className="inverse-instagram-token-note">Connection changes are available when active discovery finishes.</p>}
        </form>}
        {connectionError && !showConnection && <p className="inverse-connection-error" role="alert">{connectionError}</p>}
        </>}
      </section>}
      {!!importIssues.length && <details className="inverse-import-issues"><summary>Import issues <span>{importIssues.length}</span></summary><div>{importIssues.map(item => <div className="inverse-import-issue" key={item.id}><div><button type="button" onClick={() => { setSelectedId(item.id); setNotice('') }}>{item.source.url || item.title || 'Failed import'} ↗</button><p>{item.error || 'This import could not finish. Try again or upload the video file.'}</p></div>{item.source.url && <button type="button" className="inverse-text-button" disabled={!!busy} onClick={() => void queueImport(item.source.url!)}>Retry import ↗</button>}</div>)}</div></details>}
      {channel?.syncError && <p className="inverse-channel-sync-note">The public video list could not fully refresh. Your saved references are still available. {channel.syncError}</p>}
      {(libraryItems.length + catalog.length > 0 || referenceSearch) && <div className="inverse-reference-browser"><label htmlFor="inverse-reference-search"><Icon name="search" size={14}/><span className="inverse-visually-hidden">Search channel reference videos</span><input id="inverse-reference-search" type="search" placeholder="Search videos in this library…" value={referenceSearch} onChange={event => { setReferenceSearch(event.target.value); setVisibleReferences(24) }}/></label><span>{search ? `${matchingCount.toLocaleString()} matching video${matchingCount === 1 ? '' : 's'}` : `${shownCount.toLocaleString()} of ${matchingCount.toLocaleString()} videos shown`}</span></div>}
      {loading && !libraryItems.length && !catalog.length ? <div className="inverse-empty" role="status"><span aria-hidden="true">◌</span><h3>Opening your library…</h3></div> : !libraryItems.length && !catalog.length && !selected ? <div className="inverse-empty"><span aria-hidden="true">▤</span><h3>{channel ? 'Start this channel’s reference library' : 'Your first reference starts here'}</h3><p>{channel ? 'Sync the channel to find public videos, or add a reel link or video file.' : 'Add a video or choose a channel above. References stay separate for every account.'}</p><button type="button" className="inverse-text-button" onClick={() => setShowAddVideo(true)}>＋ Add a reference</button></div> : <div className="inverse-channel-library-content">
        <div className="inverse-reference-grid" aria-label="Channel reference videos">{visibleItems.map(item => <button type="button" key={item.id} className={`inverse-reference-card ${selectedId === item.id ? 'is-selected' : ''}`} aria-pressed={selectedId === item.id} onClick={() => { setSelectedId(item.id); setNotice('') }}><span className="inverse-reference-cover"><ReferenceImage url={channelThumbnails.get(videoReferenceKey(item.source.url)) || item.source.thumbnailUrl} label={item.source.kind === 'upload' ? 'Uploaded video' : 'Saved reference'}/><span className="inverse-reference-play" aria-hidden="true">▷</span>{item.durationSeconds != null && <span className="inverse-reference-duration">{videoTime(item.durationSeconds)}</span>}<em className={`inverse-state state-${item.status}`}>{stateLabels[item.status] || item.status}</em></span><span className="inverse-reference-card-info"><strong>{item.title || 'Untitled video'}</strong><small>{readableDate(item.createdAt)}<span>{item.hasResult || item.result ? 'Open analysis ↗' : isAnalysisRunning(item) ? 'Working…' : 'Open reference ↗'}</span></small></span></button>)}{visibleCatalog.map(entry => <article key={entry.url} className="inverse-reference-card inverse-catalog-card"><div className="inverse-reference-cover"><ReferenceImage url={entry.thumbnailUrl} label="Channel video"/>{entry.durationSeconds != null && <span className="inverse-reference-duration">{videoTime(entry.durationSeconds)}</span>}<span className="inverse-state">{channel?.discovery?.source ? 'Channel video' : 'Public preview'}</span><a className="inverse-catalog-original" href={sourceUrl(entry.url)} target="_blank" rel="noopener noreferrer" aria-label={`Open original: ${entry.title}`}>↗</a></div><div className="inverse-reference-card-info"><strong>{entry.title || 'Instagram reel'}</strong><div className="inverse-catalog-actions"><small>{entry.publishedAt ? readableDate(entry.publishedAt) : 'From channel'}</small><button type="button" disabled={!!busy} onClick={() => void queueImport(entry.url)}>Import video <span aria-hidden="true">↓</span></button></div></div></article>)}</div>
        {matchingCount === 0 && <p className="inverse-reference-no-matches" role="status">No videos match this search.</p>}
        {shownCount < matchingCount && <div className="inverse-reference-pagination"><span>{shownCount.toLocaleString()} of {matchingCount.toLocaleString()} videos shown</span><button type="button" className="inverse-text-button" onClick={() => setVisibleReferences(previous => previous + 24)}>Show 24 more videos ↓</button></div>}
        {selected && <article className="inverse-detail" aria-labelledby="inverse-video-title"><div className="inverse-detail-heading"><div><span className={`inverse-state state-${selected.status}`}>{stateLabels[selected.status] || selected.status}</span><h3 id="inverse-video-title">{selected.title}</h3><div className="inverse-source-links">{sourceUrl(selected.source.url) && <a href={sourceUrl(selected.source.url)} target="_blank" rel="noopener noreferrer">{selected.source.profileUrl ? 'Original reel' : 'Open original'} <span aria-hidden="true">↗</span></a>}{sourceUrl(selected.source.profileUrl) && selected.source.profileUrl !== selected.source.url && <a href={sourceUrl(selected.source.profileUrl)} target="_blank" rel="noopener noreferrer">Source profile <span aria-hidden="true">↗</span></a>}{selected.source.discoveryMethod === 'public_profile_embed' ? <small>Found on public profile</small> : selected.source.profileUrl ? <small>Imported from this profile</small> : null}</div></div><ScriptAnalysisActions disabled={!!busy || isAnalysisRunning(selected) || selected.hasMedia === false || !analysisAvailable} running={isAnalysisRunning(selected)} starting={busy === 'analyzing'} mode={mode} workflow={analysisWorkflow} onModeChange={setMode} onAnalyze={(value, view) => void analyze(value, view)}/></div>
          {(isAnalysisRunning(selected) || selected.error || pollError) && <div className={`inverse-progress ${selected.error ? 'has-error' : ''}`} role="status">{isAnalysisRunning(selected) && <span className="inverse-progress-dot"/>}<div><strong>{selected.error ? 'This video needs attention' : stateLabels[selected.status]}</strong><p>{selected.error || selected.progress || 'Your video is being processed. You can leave this section and return later.'}</p>{selected.status === 'failed' && selected.source.url && <button className="inverse-text-button" type="button" disabled={!!busy} onClick={() => void queueImport(selected.source.url!)}>Retry import ↗</button>}{pollError && <p>{pollError}</p>}</div></div>}
          <div className="inverse-player-wrap">{media ? <video ref={video} src={media} controls playsInline preload="metadata" aria-label={`Preview of ${selected.title}`} onTimeUpdate={() => setCurrentTime(video.current?.currentTime || 0)} onError={() => setMediaError('This browser cannot play this video format. You can still read its analysis.')}/> : <div className="inverse-player-placeholder"><span aria-hidden="true">▷</span><p>{mediaError || (selected.hasMedia === false ? selected.status === 'failed' ? 'This reference has no video file. Upload the file or add another link.' : 'Your video preview will appear after import.' : 'Loading video preview…')}</p></div>}{media && mediaError && <p className="inverse-player-error">{mediaError}</p>}</div>
          {result && <SavedAnalysisProvenance result={result} nextModel={analysisModel} nextWorkflow={analysisWorkflow}/>}
          {result?.summary && <p className="inverse-summary">{result.summary}</p>}
          {result?.reaVideo && <ReaVideoPanel result={result} itemId={selected.id} durationSeconds={selected.durationSeconds} busy={isAnalysisRunning(selected)} onSeek={seek} onSaved={upsert}/>}
          <div className="inverse-result-toolbar"><div className="inverse-tabs" aria-label="Analysis views"><button type="button" aria-pressed={tab === 'shots'} className={tab === 'shots' ? 'is-active' : ''} onClick={() => setTab('shots')}>Shot breakdown{shots.length > 0 && <span>{shots.length}</span>}</button><button type="button" aria-pressed={tab === 'script'} className={tab === 'script' ? 'is-active' : ''} onClick={() => setTab('script')}>Script breakdown</button><button type="button" aria-pressed={tab === 'audio'} className={tab === 'audio' ? 'is-active' : ''} onClick={() => setTab('audio')}>Audio timeline{audioSegments.length > 0 && <span>{audioSegments.length}</span>}</button></div>{result && <div className="inverse-export-actions"><button type="button" className="inverse-text-button" onClick={() => void copy()}>Copy text</button><label><span className="inverse-visually-hidden">Download analysis format</span><select value="" disabled={!!busy} onChange={event => { const value = event.target.value; if (value) void download(value as 'txt' | 'md' | 'json') }}><option value="">{busy === 'exporting' ? 'Saving…' : 'Download ↓'}</option><option value="txt">Text (.txt)</option><option value="md">Markdown (.md)</option><option value="json">JSON (.json)</option></select></label></div>}</div>
          {!result ? <div className="inverse-empty inverse-result-empty"><span aria-hidden="true">{tab === 'shots' ? '▤' : '≋'}</span><h3>{isAnalysisRunning(selected) ? 'Your analysis is on its way' : tab === 'shots' ? 'See the structure behind the video' : tab === 'script' ? 'Build a production script from this video' : 'Get the words behind the video'}</h3><p>{isAnalysisRunning(selected) ? 'Shots, speech and audio timing will appear together when ready.' : technicalWorkflow ? 'Choose Rea-video breakdown above to measure this video locally.' : 'Choose Script breakdown above to begin. Only content found in the reference will appear here.'}</p></div> : tab === 'shots' ? <div className="inverse-shots">{shots.length ? shots.map((shot, index) => <section className={`inverse-shot ${currentTime >= shot.startSeconds && currentTime < shot.endSeconds ? 'is-playing' : ''}`} key={`${shot.startSeconds}-${index}`}><div className="inverse-shot-number"><span>{String(index + 1).padStart(2, '0')}</span><button type="button" title="Jump to this shot" onClick={() => seek(shot.startSeconds)}>{videoTime(shot.startSeconds)}<span>— {videoTime(shot.endSeconds)}</span></button></div><div className="inverse-shot-content"><h4>{shot.visual || 'Visual description not available'}</h4>{shot.action && <p>{shot.action}</p>}{(shot.framing || shot.cameraMovement) && <div className="inverse-shot-tags">{shot.framing && <span>{shot.framing}</span>}{shot.cameraMovement && <span>{shot.cameraMovement}</span>}</div>}<dl>{shot.audio && <><dt>Audio</dt><dd>{shot.audio}</dd></>}{shot.spokenText && <><dt>Spoken</dt><dd>“{shot.spokenText}”</dd></>}{!!shot.onScreenText?.length && <><dt>On-screen</dt><dd>{shot.onScreenText.join(' · ')}</dd></>}</dl>{shot.audioAnalysis && soundDetails(shot.audioAnalysis)}{shot.reconstructionPrompt && <details className="inverse-shot-prompt"><summary>Recreate this shot</summary><p>{shot.reconstructionPrompt}</p><button type="button" className="inverse-text-button" onClick={() => void copyPrompt(shot.reconstructionPrompt!)}>Copy shot prompt</button></details>}</div></section>) : result.reaVideo ? <p className="inverse-no-text">Technical intervals and their uncertainty are shown above. This workflow did not request visual descriptions.</p> : <MissingShotAnalysis item={selected} configuration={configuration} analysisModelId={analysisModel?.id} busy={!!busy} onRetry={() => void analyze('breakdown')}/>}</div> : tab === 'audio' ? <div className="inverse-audio-timeline">
            <section className="inverse-audio-introduction"><h4>Sound on the same timeline</h4><p>{audioDescription || 'Speech, sound descriptions and shot boundaries share the original video’s timestamps.'}</p><p>Choose a time below to listen in the video above.</p>{result.audio?.semanticModel && <p>Sound model: {result.audio.semanticModel}. Sound labels are model estimates; verify uncertain events against the original audio.</p>}{result.audio?.semanticStatus === 'unavailable' && <p>Music and sound-effect identification is unavailable. Energy changes are measured from the audio.</p>}</section>
            {audioSegments.length ? audioSegments.map((segment, index) => <section key={`${segment.startSeconds}-${index}`} className={`inverse-audio-segment ${currentTime >= segment.startSeconds && currentTime < segment.endSeconds ? 'is-playing' : ''}`}>
              <div className="inverse-audio-segment-heading"><button type="button" onClick={() => seek(segment.startSeconds)} title="Play from this audio segment">{videoTime(segment.startSeconds)} — {videoTime(segment.endSeconds)}</button><span>{segment.shotIndex == null ? 'Audio segment' : `Shot ${segment.shotIndex + 1}`}</span></div>
              {segment.spokenText && <p className="inverse-audio-speech">“{segment.spokenText}”</p>}
              {soundDetails(segment)}
            </section>) : <div className="inverse-empty inverse-result-empty"><h3>{result.audio?.status === 'no_audio' ? 'This video has no audio track' : 'No aligned audio timeline saved yet'}</h3><p>{result.reaVideo ? 'This workflow reports technical video measurements. Speech and semantic sound analysis were not run.' : result.audio?.status === 'no_audio' ? 'The shot breakdown is still available.' : 'Use Other analysis modes → Audio only to refresh speech and sound timing, or Script breakdown for a fresh video + audio analysis.'}</p></div>}
            {audioNotes.length > 0 && <aside className="inverse-audio-limitations"><h4>Audio notes</h4>{audioNotes.map((note, index) => <p key={index}>{readableNote(note)}</p>)}</aside>}
          </div> : <div className="inverse-script"><ScriptBreakdownPanel result={result} onSeek={seek}/><section><div className="inverse-script-heading"><h4>Spoken words</h4><span>{result.language || 'Transcript'}</span></div>{speech.length ? timedText(speech, '') : result.script?.text ? <p className="inverse-plain-transcript">{result.script.text}</p> : <p className="inverse-no-text">{result.reaVideo ? 'Speech transcription was not requested by this workflow.' : 'No spoken text was returned. Check the analysis notes for any unavailable audio or transcription.'}</p>}</section><section><div className="inverse-script-heading"><h4>On-screen text</h4><span>Visible in the video</span></div>{timedText(overlay, result.reaVideo ? 'On-screen text recognition was not requested by this workflow.' : 'No on-screen text was returned.')}</section>{audioDescription && <section><div className="inverse-script-heading"><h4>Audio notes</h4></div><p className="inverse-no-text">{audioDescription}</p></section>}</div>}
          {tab === 'shots' && result?.inversePrompt && <section className="inverse-reconstruction"><div><span className="eyebrow">VIDEO → PROMPT</span><h4>Reconstruction prompt</h4><p>A description to guide recreation, extracted from this reference.</p></div><button type="button" className="inverse-text-button" onClick={() => void copyPrompt(result.inversePrompt!)}>Copy prompt</button><pre>{result.inversePrompt}</pre></section>}
          {resultNotes.length > 0 && <aside className="inverse-result-notes"><h4>Analysis notes</h4><ul>{resultNotes.map((warning, index) => <li key={index}>{readableNote(warning)}</li>)}</ul></aside>}
          <ReferenceReconstruction key={selected.id} item={selected} onOpenOutput={output => { upsert(output); selectChannel('unassigned'); setSelectedId(output.id); setTab('shots') }}/>
        </article>}
      </div>}
    </section>}
  </div>
}
