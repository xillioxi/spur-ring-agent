import { useEffect, useRef, useState, type FormEvent } from 'react'
import { videoBelongsToChannel, videoTime, type VideoAnalysisItem, type VideoChannel } from './inverseVideoApi'
import { exportFaceReferencePack, extractFaceReferences, getFaceReferenceImage, listFaceReferences, updateFaceReference, uploadFacePhoto, type FaceReference, type FaceReferenceAngle, type FaceReferenceBank } from './faceReferencesApi'
import './faceReferences.css'

const message = (error: unknown) => error instanceof Error ? error.message : 'The references could not be loaded. Try again.'
const angles: Array<[FaceReferenceAngle, string]> = [['unspecified', 'Not labelled'], ['front', 'Front'], ['left', 'Left profile'], ['right', 'Right profile'], ['outfit', 'Outfit / full view'], ['other', 'Other']]
export function faceReferenceDisplayLabel(reference: FaceReference) {
  if (reference.label.trim()) return reference.label.trim()
  if (reference.source.kind === 'photo' && reference.source.filename?.trim()) return reference.source.filename.trim()
  const time = reference.source.timeSeconds
  return reference.source.kind === 'video' && typeof time === 'number' && Number.isFinite(time) && time >= 0 ? `Frame ${videoTime(time)}` : 'Reference candidate'
}
export function faceReferenceSourceVideos(items: VideoAnalysisItem[], channel: VideoChannel) {
  return items.filter(item => item.hasMedia !== false && videoBelongsToChannel(item, channel) && !['queued', 'importing'].includes(item.status) && typeof item.durationSeconds === 'number' && Number.isFinite(item.durationSeconds) && item.durationSeconds > 0 && item.durationSeconds <= 300)
}
function smallUnselectedFace(reference: FaceReference) {
  return !reference.selected && reference.detection === 'face' && (reference.width < 256 || reference.height < 256)
}
export function filterFaceReferenceCandidates(references: FaceReference[], includeSmall = false) {
  return includeSmall ? references : references.filter(reference => !smallUnselectedFace(reference))
}
function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob), link = document.createElement('a')
  link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
function ReferencePhoto({ reference, context }: { reference: FaceReference; context: boolean }) {
  const [state, setState] = useState<{ url: string; error: string }>({ url: '', error: '' })
  useEffect(() => {
    const cancellation = new AbortController(); let disposed = false, objectUrl = ''
    setState({ url: '', error: '' })
    void getFaceReferenceImage(reference.id, context, cancellation.signal).then(blob => {
      if (disposed) return
      objectUrl = URL.createObjectURL(blob); setState({ url: objectUrl, error: '' })
    }).catch(error => { if (!disposed) setState({ url: '', error: message(error) }) })
    return () => { disposed = true; cancellation.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [reference.id, context])
  return <div className={`facecap-photo ${context ? 'is-context' : ''}`}>{state.url ? <a href={state.url} target="_blank" rel="noreferrer"><img src={state.url} alt={`${context ? 'Source context' : 'Reference candidate'}: ${faceReferenceDisplayLabel(reference)}`} loading="lazy"/></a> : <p role={state.error ? 'alert' : 'status'}>{state.error || 'Loading image…'}</p>}</div>
}
export function FaceReferenceCard({ reference, selectedCount, maxSelected, disabled, onUpdate, onOpenVideo }: { reference: FaceReference; selectedCount: number; maxSelected: number; disabled: boolean; onUpdate: (id: string, value: { selected?: boolean; angle?: FaceReferenceAngle; label?: string }) => Promise<void>; onOpenVideo?: (id: string, seconds?: number) => void }) {
  const [context, setContext] = useState(false), [label, setLabel] = useState(reference.label)
  const [editing, setEditing] = useState(false)
  async function rename(event: FormEvent) { event.preventDefault(); await onUpdate(reference.id, { label }); setEditing(false) }
  return <article className={`facecap-card ${reference.selected ? 'is-selected' : ''}`}>
    <ReferencePhoto reference={reference} context={context}/>
    <div className="facecap-card-content">
      <label className="facecap-select"><input type="checkbox" checked={reference.selected} disabled={disabled || !reference.selected && selectedCount >= maxSelected} onChange={event => void onUpdate(reference.id, { selected: event.target.checked })}/><span>Use this reference</span></label>
      {editing ? <form className="facecap-rename" onSubmit={event => void rename(event)}><label>Reference label<input value={label} maxLength={120} disabled={disabled} onChange={event => setLabel(event.target.value)} required/></label><button type="submit" className="inverse-text-button" disabled={disabled || !label.trim()}>Save label</button><button type="button" className="inverse-text-button" disabled={disabled} onClick={() => { setLabel(reference.label); setEditing(false) }}>Cancel</button></form> : <div className="facecap-card-label"><h3>{faceReferenceDisplayLabel(reference)}</h3><button type="button" className="inverse-text-button" disabled={disabled} onClick={() => setEditing(true)}>Edit label</button></div>}
      <label className="facecap-angle">Reference angle<select value={reference.angle} disabled={disabled} onChange={event => void onUpdate(reference.id, { angle: event.target.value as FaceReferenceAngle })}>{angles.map(([value, title]) => <option key={value} value={value}>{title}</option>)}</select></label>
      <p className="facecap-source">{reference.source.kind === 'video' ? `Video frame${typeof reference.source.timeSeconds === 'number' ? ` · ${videoTime(reference.source.timeSeconds)}` : ''}` : reference.source.filename || 'Uploaded photo'} · {reference.width} × {reference.height}</p>
      <p className="facecap-detection">{reference.detection === 'face' ? 'Detected face candidate · choose the intended person' : 'Full image · no face crop established'}</p>
      {(reference.width < 256 || reference.height < 256) && <p className="facecap-small-crop">Small crop — use a larger photo or source context.</p>}
      <div className="facecap-card-actions">{reference.contextAsset && <button type="button" className="inverse-text-button" onClick={() => setContext(previous => !previous)}>{context ? 'Show face crop' : 'Show source context'}</button>}{reference.source.sourceItemId && onOpenVideo && <button type="button" className="inverse-text-button" onClick={() => onOpenVideo(reference.source.sourceItemId!, reference.source.timeSeconds)}>Open source video ↗</button>}</div>
    </div>
  </article>
}
export function FacecapProviderOptions() {
  return <details className="facecap-providers"><summary>Video options for these references</summary><p>The current Generate recreation flow sends text prompts only. Selecting photos here does not yet condition its generated video.</p><div>
    <article><span>SUBJECT REFERENCES</span><h3>MiniMax H3 native API</h3><p>Supports up to nine reference images for appearance across new scenes. This needs the native reference adapter.</p><a href="https://platform.minimax.io/docs/api-reference/video-generation-v2-create" target="_blank" rel="noreferrer">API reference ↗</a><small>Not connected</small></article>
    <article><span>REUSABLE CHARACTER</span><h3>Kling Elements</h3><p>A frontal image and additional views can form a reusable character element. A separate provider connection is needed.</p><a href="https://kling.ai/document-api/apiReference/model/element" target="_blank" rel="noreferrer">Element reference ↗</a><small>Not connected</small></article>
    <article><span>STILL → VIDEO</span><h3>Runway References</h3><p>Create and review a still using reference images, then animate it. Performance transfer uses a driving video.</p><a href="https://docs.dev.runwayml.com/api/" target="_blank" rel="noreferrer">API reference ↗</a><small>Not connected</small></article>
  </div><p className="facecap-footnote">Face Cap is a facial motion-capture app for animating 3D characters. This panel collects appearance references. Neither function establishes the story, actions or exact likeness of a new video.</p></details>
}
export function FaceReferenceGallery({ references, selectedCount, maxSelected, disabled, onUpdate, onOpenVideo }: { references: FaceReference[]; selectedCount: number; maxSelected: number; disabled: boolean; onUpdate: (id: string, value: { selected?: boolean; angle?: FaceReferenceAngle; label?: string }) => Promise<void>; onOpenVideo?: (id: string, seconds?: number) => void }) {
  return references.length ? <div className="facecap-gallery">{references.map(reference => <FaceReferenceCard key={reference.id} reference={reference} selectedCount={selectedCount} maxSelected={maxSelected} disabled={disabled} onUpdate={onUpdate} onOpenVideo={onOpenVideo}/>)}</div> : <div className="facecap-empty"><span aria-hidden="true">▧</span><h3>A small, useful reference set.</h3><p>Add any photo, or extract candidates from a saved video. Choose the intended person yourself, then keep front, side and outfit views.</p></div>
}
export function FaceReferences({ channel, items, onOpenVideo }: { channel: VideoChannel; items: VideoAnalysisItem[]; onOpenVideo?: (id: string, seconds?: number) => void }) {
  const [bank, setBank] = useState<FaceReferenceBank | null>(null), [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [videoId, setVideoId] = useState(''), [revision, setRevision] = useState(0), [shownCount, setShownCount] = useState(24), [includeSmall, setIncludeSmall] = useState(false)
  const photoInput = useRef<HTMLInputElement>(null), operations = useRef(new Set<AbortController>()), mounted = useRef(true), actionLocked = useRef(false)
  const videos = faceReferenceSourceVideos(items, channel)
  const selectedVideoId = videos.some(item => item.id === videoId) ? videoId : videos[0]?.id || ''
  const references = bank?.references || [], selectedCount = references.filter(reference => reference.selected).length
  const smallCandidateCount = references.filter(smallUnselectedFace).length
  const visibleReferences = filterFaceReferenceCandidates(references, includeSmall)
  const maxSelected = bank?.limits.maxSelectedReferences || 9
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; for (const operation of operations.current) operation.abort(); operations.current.clear() } }, [])
  useEffect(() => {
    const cancellation = new AbortController(); let disposed = false
    setLoading(true); setError(''); setBank(null)
    void listFaceReferences(channel.id, cancellation.signal).then(value => { if (!disposed) setBank(value) }).catch(reason => { if (!disposed) setError(message(reason)) }).finally(() => { if (!disposed) setLoading(false) })
    return () => { disposed = true; cancellation.abort() }
  }, [channel.id, revision])
  async function action(label: string, work: (signal: AbortSignal) => Promise<void>) {
    if (actionLocked.current) return
    actionLocked.current = true
    const cancellation = new AbortController(); operations.current.add(cancellation)
    setBusy(label); setError(''); setNotice('')
    try { await work(cancellation.signal) } catch (reason) { if (mounted.current && !cancellation.signal.aborted) setError(message(reason)) }
    finally { actionLocked.current = false; operations.current.delete(cancellation); if (mounted.current) setBusy('') }
  }
  async function upload(files: File[]) {
    if (!files.length) return
    await action('uploading', async signal => {
      let completed = 0
      for (const file of files.slice(0, 12)) {
        const value = await uploadFacePhoto(channel.id, file, signal)
        if (!mounted.current) return
        setBank(value); completed++; setNotice(`Prepared ${completed} of ${Math.min(files.length, 12)} photos. Choose which candidates to keep.`)
      }
      if (files.length > 12 && mounted.current) setNotice('Prepared the first 12 photos. Add the remaining photos in another batch.')
    })
  }
  async function extract() {
    await action('extracting', async signal => {
      const value = await extractFaceReferences(selectedVideoId, signal)
      if (!mounted.current) return
      setBank(value); setNotice('Candidates are ready. Select the intended person; detection does not recognize who they are.')
    })
  }
  async function update(id: string, value: { selected?: boolean; angle?: FaceReferenceAngle; label?: string }) {
    await action(id, async signal => {
      const result = await updateFaceReference(id, value, signal)
      if (mounted.current) setBank(previous => previous ? { ...previous, references: previous.references.map(reference => reference.id === id ? result.reference : reference) } : previous)
    })
  }
  async function download() {
    await action('downloading', async signal => {
      const blob = await exportFaceReferencePack(channel.id, signal)
      if (mounted.current) { saveBlob(blob, `facecap-${channel.handle}-references.zip`); setNotice('Reference pack downloaded with selected crops, source context and a provenance manifest.') }
    })
  }
  return <section className="facecap-workspace" aria-labelledby="facecap-heading">
    <header className="facecap-heading"><div><span className="eyebrow">FACE REFERENCES / @{channel.handle}</span><h2 id="facecap-heading">Facecap.</h2><p>Build a reusable appearance reference set from any photo or saved video.</p></div><span className="facecap-storage">Saved locally · cloud storage later</span></header>
    <div className="facecap-inputs"><div><span className="facecap-step">01 / ADD PHOTOS</span><h3>Start with a photo.</h3><p>JPEG or PNG, up to 8 MiB each. Photos are processed locally; no generator receives them.</p><input ref={photoInput} type="file" className="inverse-visually-hidden" accept="image/jpeg,image/png" multiple aria-label="Upload face reference photos" disabled={!!busy || loading} onChange={event => { const files = Array.from(event.target.files || []); event.target.value = ''; void upload(files) }}/><button type="button" className="inverse-primary" disabled={!!busy || loading} onClick={() => photoInput.current?.click()}>{busy === 'uploading' ? 'Preparing photos…' : 'Add photos'}</button></div><div><span className="facecap-step">02 / USE YOUR CLIPS</span><h3>Find useful frames.</h3><p>Extract face candidates and keep their original frame for context. You choose the intended person.</p><label htmlFor="facecap-source-video">Saved video<select id="facecap-source-video" value={selectedVideoId} disabled={!!busy || loading || !videos.length} onChange={event => setVideoId(event.target.value)}>{videos.length ? videos.map(item => <option key={item.id} value={item.id}>{item.title}{item.durationSeconds ? ` · ${videoTime(item.durationSeconds)}` : ''}</option>) : <option value="">Save a video in this channel first</option>}</select></label><button type="button" className="inverse-text-button" disabled={!!busy || loading || !selectedVideoId} onClick={() => void extract()}>{busy === 'extracting' ? 'Extracting local candidates…' : 'Extract references ↗'}</button></div></div>
    {error && <div className="facecap-feedback is-error" role="alert"><p>{error}</p><button type="button" className="inverse-text-button" disabled={!!busy} onClick={() => setRevision(value => value + 1)}>Reload references</button></div>}
    {notice && <p className="facecap-feedback" role="status">{notice}</p>}
    {!!bank?.warnings?.length && <details className="facecap-warnings"><summary>Capture notes</summary><ul>{bank.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
    <div className="facecap-gallery-heading"><div><h3>Your reference set <span>{references.length}</span></h3><p>{selectedCount} of {maxSelected} selected · choose clear, varied views of the same intended person.</p></div><button type="button" className="inverse-primary" disabled={!!busy || loading || !selectedCount} onClick={() => void download()}>{busy === 'downloading' ? 'Preparing pack…' : 'Download selected pack'}</button></div>
    {!!smallCandidateCount && <div className="facecap-gallery-filter"><label><input type="checkbox" checked={includeSmall} onChange={event => { setIncludeSmall(event.target.checked); setShownCount(24) }}/><span>Include small crops ({smallCandidateCount})</span></label><p>{includeSmall ? 'Small crops are shown for inspection. Use source context or a larger photo when possible.' : `${smallCandidateCount} small, unselected face crop${smallCandidateCount === 1 ? ' is' : 's are'} hidden from this view. Selected crops and full photos stay visible.`}</p></div>}
    {loading ? <p className="facecap-loading" role="status">Opening your references…</p> : references.length && !visibleReferences.length ? <div className="facecap-empty"><h3>No larger face crops yet.</h3><p>Include small crops to inspect the candidates, or add a clearer photo. All captured references are still saved.</p></div> : <FaceReferenceGallery references={visibleReferences.slice(0, shownCount)} selectedCount={selectedCount} maxSelected={maxSelected} disabled={!!busy} onUpdate={update} onOpenVideo={onOpenVideo}/>}
    {visibleReferences.length > shownCount && <button type="button" className="inverse-text-button facecap-more" onClick={() => setShownCount(previous => previous + 24)}>Show more references ({visibleReferences.length - shownCount} remaining)</button>}
    <p className="facecap-footnote">Stored in this private workspace. Images and stable asset IDs can later move to cloud storage; cloud sync is not enabled. Reference selection is manual, without automatic person recognition.</p>
    <FacecapProviderOptions/>
  </section>
}
