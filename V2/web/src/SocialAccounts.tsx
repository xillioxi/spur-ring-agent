import { useEffect, useState } from 'react'
import { emailProviders, getEmailMemoryStatus, type EmailMemoryStatus, type EmailProvider } from './emailMemoryApi'
import { whatsappRequest, type WhatsAppStatus } from './whatsappApi'
import { useSocialDirectory } from './socialDirectory'
import './emailMemory.css'

export type MediaProvider = 'whatsapp' | 'instagram' | 'messenger'
export type SocialAccountId = EmailProvider | MediaProvider
export function isMediaProvider(id: SocialAccountId): id is MediaProvider {
  return id === 'whatsapp' || id === 'instagram' || id === 'messenger'
}
const socialAccounts = [...emailProviders, { id: 'whatsapp' as const, label: 'WhatsApp' }, {id:'instagram' as const,label:'Instagram'}, {id:'messenger' as const,label:'Messenger'}]

export function socialAccountFromHash(hash: string) {
  return socialAccounts.find(({ id }) => hash === `#memory/${id}`)?.id
}

export function isSocialMemoryHash(hash: string) {
  return hash === '#memory/social' || Boolean(socialAccountFromHash(hash))
}

function emailAccountLabel(status: EmailMemoryStatus | null | undefined, provider: EmailProvider) {
  if (status === undefined) return 'Checking…'
  if (status === null) return 'Status unavailable'
  const { connection } = status
  const mailboxes = connection.mailboxes ?? status.mailboxes
  if (!mailboxes?.length) {
    return connection.provider === provider && connection.connected ? 'Connected' : 'Not connected'
  }
  const matching = mailboxes.filter(mailbox => mailbox.provider === provider)
  const connected = matching.filter(mailbox => mailbox.connected).length
  if (connected) return connected === 1 ? '1 account connected' : `${connected} accounts connected`
  return matching.length ? 'Reconnect available' : 'Not connected'
}

function whatsappAccountLabel(status: WhatsAppStatus | null | undefined) {
  if (status === undefined) return 'Checking…'
  if (status === null) return 'Status unavailable'
  if (status.state === 'connected') return 'Connected'
  if (status.state === 'pairing') return 'Ready to pair'
  if (status.state === 'connecting' || status.state === 'reconnecting') return 'Connecting…'
  return status.sources?.length ? 'Saved chats available' : 'Not connected'
}

export function SocialAccountOptions({ onChoose }: { onChoose?: (id: SocialAccountId) => void }) {
  const directory = useSocialDirectory()
  const [email, setEmail] = useState<EmailMemoryStatus | null>()
  const [whatsapp, setWhatsApp] = useState<WhatsAppStatus | null>()

  useEffect(() => {
    let pending: AbortController | undefined
    function refresh() {
      pending?.abort()
      const controller = new AbortController()
      pending = controller
      void getEmailMemoryStatus(controller.signal).then(status => {
        if (!controller.signal.aborted) setEmail(status)
      }).catch(() => {
        if (!controller.signal.aborted) setEmail(null)
      })
      void whatsappRequest<WhatsAppStatus>('/status', 'GET', undefined, controller.signal).then(status => {
        if (!controller.signal.aborted) setWhatsApp(status)
      }).catch(() => {
        if (!controller.signal.aborted) setWhatsApp(null)
      })
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => {
      pending?.abort()
      window.removeEventListener('focus', refresh)
    }
  }, [])

  return <div className="social-account-options">
    {socialAccounts.map(({ id, label }, index) => {
      const caption = id === 'whatsapp' ? whatsappAccountLabel(whatsapp) : id === 'instagram' || id === 'messenger' ? directory.labels[id].join(' · ') || 'Connect account' : emailAccountLabel(email, id)
      const content = <><SocialAccountMark provider={id}/><strong>{label}</strong><small>{caption}</small></>
      return onChoose
        ? <button key={id} className="social-account-option" type="button" data-mailbox-autofocus={index === 0 ? '' : undefined} onClick={() => onChoose(id)}>{content}</button>
        : <a key={id} className="social-account-option" href={`#memory/${id}`}>{content}</a>
    })}
  </div>
}

export function SocialAccountMark({ provider }: { provider: SocialAccountId }) {
  return <span className={`email-mailbox-provider-mark is-${provider}`} aria-hidden="true">{provider === 'instagram' ? '◎' : provider === 'messenger' ? '↯' : provider === 'whatsapp' ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M20.5 11.8a8.5 8.5 0 0 1-12.6 7.5L4 20l.9-3.8a8.5 8.5 0 1 1 15.6-4.4Z"/><path d="M9 8.5c0 3 3 6 6 6l1-1.5-2-1-1 1a6 6 0 0 1-2.5-2.5l1-1-1-2Z" strokeLinejoin="round"/></svg> : provider === 'gmail' ? <svg viewBox="0 0 24 24"><path d="M3 6v13h4V9l5 4 5-4v10h4V6l-9 6Z" fill="#e8e9de"/><path d="M3 6v13h4V9" fill="none" stroke="#4285f4" strokeWidth="2.7"/><path d="m3 6 9 7 9-7" fill="none" stroke="#d86d62" strokeWidth="3"/><path d="M21 6v13h-4V9" fill="none" stroke="#81a474" strokeWidth="2.7"/></svg> : provider === 'outlook' ? <svg viewBox="0 0 24 24"><path fill="#bd8b75" d="M3 3h8v8H3z"/><path fill="#a2b37c" d="M13 3h8v8h-8z"/><path fill="#8ba9b6" d="M3 13h8v8H3z"/><path fill="#d5c48a" d="M13 13h8v8h-8z"/></svg> : provider === 'zoho' ? 'Z' : <svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" strokeWidth="1.7"/><path d="m4 7 8 6 8-6" fill="none" stroke="currentColor" strokeWidth="1.7"/></svg>}</span>
}
