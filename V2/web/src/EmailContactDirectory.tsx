import { useMemo } from 'react'
import type { EmailNetworkNode } from './emailMemoryApi'
import { relationshipOptions } from './EmailContactContext'

export function EmailContactDirectory({ people, selectedEmail, onSelect, onCompany }: { people: EmailNetworkNode[]; selectedEmail: string; onSelect: (email: string) => void; onCompany: (company: string) => void }) {
  const groups = useMemo(() => relationshipOptions.filter(([key]) => key !== 'auto').map(([key, title]) => {
    const companies = new Map<string, EmailNetworkNode[]>()
    for (const person of people) if ((person.relationship || 'other') === key) {
      const company = person.company || ''
      if (!companies.has(company)) companies.set(company, [])
      companies.get(company)!.push(person)
    }
    return { key, title, count:[...companies.values()].reduce((sum, contacts) => sum + contacts.length, 0), companies:[...companies].sort(([a], [b]) => a.localeCompare(b)).map(([company, contacts]) => ({ company, contacts:contacts.sort((a,b) => a.label.localeCompare(b.label)) })) }
  }).filter(group => group.count), [people])
  return <div className="email-contact-directory" aria-label="Contacts grouped by relationship and organization">
    {groups.map(group => <details key={group.key} className="email-directory-group" open={groups.length === 1 || group.companies.length <= 8 || group.companies.some(company => company.contacts.some(person => person.email === selectedEmail))}>
      <summary><h3>{group.title}</h3><span>{group.count} contacts shown · {group.companies.length} {group.companies.length === 1 ? 'organization' : 'organizations'}</span></summary>
      {group.companies.map(({ company, contacts }) => <details key={company} className="email-directory-company" open={people.length <= 20 || contacts.some(person => person.email === selectedEmail)}>
        <summary><span>{company || 'Personal contacts'}</span><small>{contacts.length} {contacts.length === 1 ? 'contact' : 'contacts'}</small></summary>
        {company && <button type="button" className="email-directory-open-company" onClick={() => onCompany(company)}>Focus on this organization ↗</button>}
        <div className="email-directory-columns" aria-hidden="true"><span>Person / contact</span><span>Responsible for</span><span>Context</span></div>
        {contacts.map(person => <button type="button" key={person.id} className={`email-directory-person${person.email === selectedEmail ? ' selected' : ''}`} aria-pressed={person.email === selectedEmail} onClick={() => onSelect(person.email)}>
          <span><strong>{person.label}</strong><small>{person.email}</small></span>
          <span className={person.role ? '' : 'email-directory-unknown'}>{person.role || 'Responsibility unconfirmed'}</span>
          <span className="email-directory-context">{person.contextSource === 'confirmed' ? 'Your saved details' : person.contextSource === 'suggested' ? 'Suggested · review' : 'Needs context'}<small>{person.messageCount.toLocaleString()} {person.messageCount === 1 ? 'email' : 'emails'}</small></span>
        </button>)}
      </details>)}
    </details>)}
  </div>
}
