import { useEffect, useRef, useState, type FormEvent } from 'react'
import { channelCreativeBrief, channelImageUrl, getChannelImage, saveVideoChannelStyle, type ChannelStyle, type VideoChannel } from './inverseVideoApi'

function useChannelImage(value?: string) {
  const [failed, setFailed] = useState(false)
  const [localUrl, setLocalUrl] = useState('')
  const privateImage = value?.startsWith('/api/creator-agent/video-analysis/channels/')
  useEffect(() => {
    setLocalUrl(''); setFailed(false)
    if (!value || !privateImage) return
    const cancellation = new AbortController(); let disposed = false, objectUrl = ''
    void getChannelImage(value, cancellation.signal).then(blob => {
      if (disposed) return
      objectUrl = URL.createObjectURL(blob); setLocalUrl(objectUrl)
    }).catch(() => { if (!disposed) setFailed(true) })
    return () => { disposed = true; cancellation.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [value, privateImage])
  return { url: privateImage ? localUrl : channelImageUrl(value), failed, onError: () => setFailed(true) }
}
export function ChannelAvatar({ channel, size = 'small' }: { channel?: VideoChannel; size?: 'small' | 'large' }) {
  const { url, failed, onError } = useChannelImage(channel?.avatarUrl)
  return <span className={`inverse-account-avatar is-${size}`} aria-hidden="true">
    {url && !failed ? <img src={url} alt="" referrerPolicy="no-referrer" onError={onError}/> : <span>{channel ? channel.handle.slice(0, 1).toUpperCase() : '▤'}</span>}
  </span>
}
export function ReferenceImage({ url: source, label }: { url?: string; label: string }) {
  const { url, failed, onError } = useChannelImage(source)
  return url && !failed ? <img src={url} alt="" loading="lazy" referrerPolicy="no-referrer" onError={onError}/> : <span className="inverse-reference-cover-placeholder"><span aria-hidden="true">▷</span><small>{label}</small></span>
}

const emptyStyle: ChannelStyle = { direction: '', format: '', editing: '', voice: '', generationMethod: 'auto', generationNotes: '' }
export function VideoChannelProfile({ channel, initialDraft, onDraftChange, onSaved }: { channel: VideoChannel; initialDraft?: ChannelStyle; onDraftChange: (draft: ChannelStyle | null, savedDraft?: ChannelStyle) => void; onSaved: (channel: VideoChannel) => void }) {
  const [draft, setDraft] = useState<ChannelStyle>({ ...emptyStyle, ...(initialDraft || channel.style) })
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [error, setError] = useState('')
  const editVersion = useRef(0)
  const dirty = (Object.keys(emptyStyle) as (keyof ChannelStyle)[]).some(key => draft[key] !== (channel.style[key] || emptyStyle[key]))
  const observations = channel.observations
  const evidence = observations?.analyzedCount || 0
  function change(key: keyof ChannelStyle, value: string) {
    const updated = { ...draft, [key]: value }
    setDraft(updated); onDraftChange(updated); editVersion.current += 1; setFeedback('')
  }
  async function save(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError(''); setFeedback('')
    const version = editVersion.current
    try { const { channel: updated } = await saveVideoChannelStyle(channel.id, draft); onSaved(updated); if (version === editVersion.current) { onDraftChange(null, draft); setFeedback('Channel style saved.') } else setFeedback('Earlier changes saved. Your latest edits are still a draft.') }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not save this channel style.') }
    finally { setSaving(false) }
  }
  async function copyBrief() {
    try { await navigator.clipboard.writeText(channelCreativeBrief(channel)); setFeedback('Saved channel brief copied.'); setError('') }
    catch { setError('Copy is unavailable in this browser.') }
  }
  const fields: { key: 'direction' | 'format' | 'editing' | 'voice'; title: string; hint: string; placeholder: string }[] = [
    { key: 'direction', title: 'Visual direction', hint: 'The look and feeling to carry into new ideas.', placeholder: 'Colour, lighting, locations, mood, framing…' },
    { key: 'format', title: 'Recurring format', hint: 'How a typical video opens, develops and ends.', placeholder: 'Opening hook, sequence, reveal, ending…' },
    { key: 'editing', title: 'Editing & sound', hint: 'The rhythm, transitions and audio treatment.', placeholder: 'Cutting pace, music, transitions, captions…' },
    { key: 'voice', title: 'Voice & writing', hint: 'How this account speaks to its audience.', placeholder: 'Tone, narration, vocabulary, point of view…' },
  ]
  return <div className="inverse-style-layout">
    <form className="inverse-style-form" onSubmit={event => void save(event)}>
      <div className="inverse-style-heading"><span className="eyebrow">CHANNEL PLAYBOOK</span><h2>A style of its own.</h2><p>Keep the creative direction and production approach for @{channel.handle} in one place.</p><button type="button" className="inverse-text-button" onClick={() => void copyBrief()}>Copy saved channel brief ↗</button></div>
      <div className="inverse-style-fields">{fields.map(field => <label key={field.key}><strong>{field.title}</strong><span>{field.hint}</span><textarea value={draft[field.key]} onChange={event => change(field.key, event.target.value)} placeholder={field.placeholder} maxLength={1200} rows={4}/></label>)}</div>
      <div className="inverse-method-section"><span className="eyebrow">PRODUCTION APPROACH</span><h3>How should this channel be made?</h3><p>Save your preferred approach. Video generation and rendering are not connected to this workspace yet.</p><div className="inverse-method-options">{([
        ['auto', 'Decide per idea', 'Keep the production approach flexible.'], ['ai_video', 'AI generated', 'Create shots with video models.'], ['footage_edit', 'Footage & editing', 'Work from recorded or licensed clips.'], ['hybrid', 'A mix of both', 'Combine footage and generated shots.'],
      ] as const).map(([value, label, description]) => <label key={value} className={draft.generationMethod === value ? 'is-selected' : ''}><input type="radio" name="channel-generation-method" value={value} checked={draft.generationMethod === value} onChange={() => change('generationMethod', value)}/><span><strong>{label}</strong><small>{description}</small></span></label>)}</div><label className="inverse-production-notes"><strong>Production notes</strong><textarea rows={3} maxLength={4000} value={draft.generationNotes} placeholder="Preferred tools, source footage, shot constraints or things to avoid…" onChange={event => change('generationNotes', event.target.value)}/></label></div>
      <div className="inverse-style-save"><p role={error ? 'alert' : 'status'} className={error ? 'has-error' : ''}>{error || feedback || (dirty ? 'Unsaved changes · your draft stays when switching channels.' : 'These settings belong only to this channel.')}</p><button type="submit" className="inverse-primary" disabled={saving}>{saving ? 'Saving…' : 'Save channel style'}</button></div>
    </form>
    <aside className="inverse-style-evidence"><span className="eyebrow">FROM YOUR REFERENCES</span><h3>{evidence ? 'The patterns so far' : 'Build an evidence base'}</h3><p>{evidence ? `Measured across ${evidence} analyzed reference${evidence === 1 ? '' : 's'}. These are observations, not a trained model.` : 'Analyze this channel’s references to see timing and camera patterns here. Your creative direction stays editable.'}</p><div className="inverse-evidence-numbers"><div><strong>{evidence}</strong><span>Analyzed videos</span></div><div><strong>{observations?.shotCount || 0}</strong><span>Detected shots</span></div>{observations?.medianShotSeconds != null && <div><strong>{observations.medianShotSeconds.toFixed(1)}<small>s</small></strong><span>Median shot</span></div>}</div>{(!!observations?.commonFraming?.length || !!observations?.commonCameraMovement?.length || !!observations?.visualExamples?.length) && <details className="inverse-evidence-details"><summary>View reference observations</summary><div>{!!observations?.commonFraming?.length && <section><h4>Framing observed</h4><div className="inverse-evidence-tags">{observations.commonFraming.slice(0, 5).map(value => <span key={value}>{value}</span>)}</div></section>}{!!observations?.commonCameraMovement?.length && <section><h4>Camera movement</h4><div className="inverse-evidence-tags">{observations.commonCameraMovement.slice(0, 5).map(value => <span key={value}>{value}</span>)}</div></section>}{!!observations?.visualExamples?.length && <section><h4>From analyzed shots</h4>{observations.visualExamples.slice(0, 2).map(example => <blockquote key={example.itemId}><p>{example.text}</p><cite>{example.title}</cite></blockquote>)}</section>}</div></details>}{!!observations?.partialCount && <p className="inverse-evidence-uncertainty">{observations.partialCount} reference{observations.partialCount === 1 ? ' has' : 's have'} partial results. Review the analysis notes before treating a pattern as reliable.</p>}<div className="inverse-evidence-footnote">References → shot & script analysis → channel observations → your creative direction.</div></aside>
  </div>
}
