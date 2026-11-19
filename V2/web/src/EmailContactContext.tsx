import { useEffect, useRef, useState, type FormEvent } from 'react'
import { saveEmailContact, type ContactProfile, type EmailNetworkNode } from './emailMemoryApi'

export const relationshipOptions = [['auto','Use suggestion'], ['friends','Friends'], ['family','Family'], ['colleagues','Colleagues'], ['services','Services'], ['company','Companies'], ['other','Other contacts']] as const

export function EmailContactContext({ person, accountId, onSaved, onEvidence }: { person: EmailNetworkNode; accountId: string; onSaved: () => void; onEvidence: (id: string) => void }) {
  const [profile, setProfile] = useState<ContactProfile>(person.profile || { relationship:'auto', company:'', role:'' })
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false)
  const active = useRef(true)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return; setBusy(true); setError(''); setSaved(false)
    try { await saveEmailContact(person.email, accountId, profile); if (active.current) { setSaved(true); onSaved() } }
    catch (e) { if (active.current) setError(e instanceof Error ? e.message : 'Could not save contact details.') }
    finally { if (active.current) setBusy(false) }
  }
  return <section className="email-contact-context" aria-label={`Relationship details for ${person.label}`}>
    <header><div><p className="email-memory-eyebrow">CONTACT CONTEXT</p><h3>{person.label}</h3><p>{person.relationshipLabel || 'Other contacts'}{person.company ? ` · ${person.company}` : ''}</p></div><span>{person.contextSource === 'confirmed' ? 'Your saved details' : person.contextSource === 'suggested' ? 'Suggested · review' : 'Needs context'}</span></header>
    <p><strong>Responsibility: </strong>{person.role || 'Unknown — add what this person handles.'}{person.roleSource === 'address' ? ' (suggested from service address)' : person.roleSource === 'sender_statement' ? ' (stated by sender)' : ''}</p>
    {!!person.evidence?.length && <ul className="email-contact-evidence">{person.evidence.map((item, index) => <li key={index}>{item.reason}{item.messageId && <button type="button" onClick={() => onEvidence(item.messageId!)}>View source email ↗</button>}</li>)}</ul>}
    <form onSubmit={event => void submit(event)}><label>Relationship<select value={profile.relationship} disabled={busy} onChange={event => { setProfile(value => ({ ...value, relationship:event.target.value as ContactProfile['relationship'] })); setSaved(false) }}>{relationshipOptions.map(([value, title]) => <option key={value} value={value}>{title}</option>)}</select></label>
      <label>Company / organization<input value={profile.company} maxLength={120} placeholder={person.company || 'Organization name'} disabled={busy} onChange={event => { setProfile(value => ({ ...value, company:event.target.value })); setSaved(false) }} /></label>
      <label>Role / responsible for<input value={profile.role} maxLength={200} placeholder={person.role || 'e.g. Video production, billing, recruiting'} disabled={busy} onChange={event => { setProfile(value => ({ ...value, role:event.target.value })); setSaved(false) }} /></label>
      <button type="submit" disabled={busy || !accountId}>{busy ? 'Saving…' : 'Save contact details'}</button>
    </form><p className="email-memory-small">Saved details take priority over suggestions. Clear a field and choose “Use suggestion” to restore automatic grouping.</p>
    {saved && <p role="status">Contact details saved.</p>}{error && <p role="alert" className="email-memory-error">{error}</p>}
  </section>
}
