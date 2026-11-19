import { ApiError, apiBase } from './taskApi'

export type MailAddress = { email: string; name?: string }
export type EmailProvider = 'gmail' | 'outlook' | 'zoho' | 'imap'
export type EmailProviderOption = { id: EmailProvider; label: string; oauthAvailable?: boolean; appPasswordAvailable?: boolean }
export const emailProviders: EmailProviderOption[] = [
  { id: 'gmail', label: 'Gmail', appPasswordAvailable: true },
  { id: 'outlook', label: 'Outlook & Microsoft 365' },
  { id: 'zoho', label: 'Zoho Mail', appPasswordAvailable: true },
  { id: 'imap', label: 'Other email (IMAP)', appPasswordAvailable: true },
]
export type ZohoAccountType = 'auto' | 'business' | 'personal'
export type EmailMailboxCredentials = { provider: Exclude<EmailProvider, 'outlook'>; email: string; appPassword: string; host?: string; port?: number; region?: string; accountType?: ZohoAccountType }
export type EmailMailbox = { id: string; provider: EmailProvider; providerLabel: string; email: string; accountId: string; connected: boolean }
export type EmailMemoryMessage = {
  id: string; threadId?: string; from: MailAddress | null; to: MailAddress[]; cc: MailAddress[]
  subject: string; date: string | null; snippet?: string; labels?: string[]; text?: string; bodyTruncated?: boolean
}
export type EmailMemoryConnection = {
  connected: boolean; email?: string; method?: string; oauthAvailable?: boolean
  scope?: string; credentialStorage?: string; message?: string; provider?: EmailProvider; providerLabel?: string; accountId?: string; providers?: EmailProviderOption[]
  mailboxes?: EmailMailbox[]; selectedMailboxId?: string | null
}
export type EmailMemorySync = {
  status: 'idle' | 'running' | 'complete' | 'partial' | 'blocked' | 'failed'
  messageCount: number; pagesFetched: number; estimatedTotal?: number; message?: string; updatedAt?: string; resumable?: boolean
}
export type EmailMemoryStatus = {
  connection: EmailMemoryConnection; sync: EmailMemorySync; messageCount: number; peopleCount: number; mailboxEmail?: string | null; mailboxId?: string | null
  mailboxes?: EmailMailbox[]; selectedMailboxId?: string | null; activeSyncMailboxIds?: string[]
}
export type ContactRelationship = 'auto' | 'friends' | 'family' | 'colleagues' | 'services' | 'company' | 'other'
export type ContactProfile = { relationship: ContactRelationship; company: string; role: string }
export type EmailNetworkNode = { id: string; email: string; label: string; kind: 'self' | 'person'; messageCount: number; lastContactAt?: string; relationship?: ContactRelationship; relationshipLabel?: string; company?: string; role?: string; roleSource?: string; contextSource?: string; evidence?: { reason: string; messageId?: string }[]; profile?: ContactProfile }
export type EmailNetworkEdge = { id: string; source: string; target: string; weight: number; lastContactAt?: string; messageIds: string[] }
export type EmailNetwork = {
  nodes: EmailNetworkNode[]; edges: EmailNetworkEdge[]; totalPeople: number; totalMessages: number
  visiblePeople: number; truncated: boolean; matchedPeople?: number; mailboxEmail?: string; scope?: string; edgesTruncated?: boolean; totalVisibleRelationships?: number
  excludedDraftCount?: number; communicationMessageCount?: number
  relationshipCounts?: Record<string, number>
  accountId?: string | null
}
export type EmailMemoryMessages = { messages: EmailMemoryMessage[]; nextCursor?: string; hasMore: boolean; total: number; accountId?: string | null }
const prefix = '/api/creator-agent/email-memory'
export class EmailMemoryApiError extends ApiError {
  constructor(message: string, status: number, public code?: string) { super(message, status) }
}

async function request<T>(path: string, options: RequestInit = {}, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController(), abort = () => controller.abort()
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, 35_000)
  try {
    const response = await fetch(apiBase() + prefix + path, { ...options, cache: 'no-store', signal: controller.signal })
    const value = await response.json().catch(error => { if (controller.signal.aborted) throw error; return null })
    if (!response.ok) throw new EmailMemoryApiError(value?.error || 'Could not read your email memory. Please try again.', response.status, typeof value?.code === 'string' && /^[a-z0-9_]{1,100}$/.test(value.code) ? value.code : undefined)
    if (!value || typeof value !== 'object') throw new ApiError('The email service returned an invalid response.', 502)
    return value
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
export const getEmailMemoryStatus = (signal?: AbortSignal) => request<EmailMemoryStatus>('/status', {}, signal)
export const saveEmailContact = (email: string, accountId: string, profile: ContactProfile) => request<{ profile: ContactProfile; accountId: string }>('/contacts', json('PATCH', { email, accountId, ...profile }))
export const getEmailNetwork = (query = '', signal?: AbortSignal, relationship = 'auto') => { const params = new URLSearchParams(); if (query.trim()) params.set('query', query.trim()); if (relationship !== 'auto') params.set('relationship', relationship); return request<EmailNetwork>('/graph' + (params.size ? `?${params}` : ''), {}, signal) }
export function getEmailMemoryMessages({ person, query, cursor, limit = 50 }: { person?: string; query?: string; cursor?: string; limit?: number } = {}, signal?: AbortSignal) {
  const params = new URLSearchParams({ limit: String(limit) })
  if (person) params.set('person', person)
  if (query?.trim()) params.set('query', query.trim())
  if (cursor) params.set('cursor', cursor)
  return request<EmailMemoryMessages>(`/messages?${params}`, {}, signal)
}
export const getEmailMemoryMessage = (id: string, signal?: AbortSignal) => request<{ message: EmailMemoryMessage; accountId?: string | null }>(`/messages/${encodeURIComponent(id)}`, {}, signal)
export const syncEmailMemory = (resume = true, signal?: AbortSignal) => request<{ status: EmailMemoryStatus }>('/sync', json('POST', { resume }), signal)
export const connectGmailAppPassword = (email: string, appPassword: string, signal?: AbortSignal) => request<{ connection: EmailMemoryConnection }>('/connect', json('POST', { email: email.trim(), appPassword: appPassword.replace(/\s/g, '') }), signal)
export const startGmailOAuth = (signal?: AbortSignal) => request<{ authorizationUrl: string }>('/oauth/start', json('POST', {}), signal)
export const disconnectGmailMemory = (signal?: AbortSignal) => request<{ connection: EmailMemoryConnection }>('/connection', { method: 'DELETE' }, signal)
export const connectEmailMailbox = (credentials: EmailMailboxCredentials, signal?: AbortSignal) => request<{ connection: EmailMemoryConnection }>('/connect', json('POST', {
  provider: credentials.provider, email: credentials.email.trim(), appPassword: credentials.provider === 'gmail' ? credentials.appPassword.replace(/\s/g, '') : credentials.appPassword,
  ...(credentials.provider === 'zoho' ? { region: credentials.region || 'us', accountType: credentials.accountType || 'auto' } : {}),
  ...(credentials.provider === 'imap' ? { host: credentials.host?.trim().toLowerCase(), port: 993 } : {}),
}), signal)
export const startEmailOAuth = (provider: 'gmail' | 'outlook', clientId?: string, signal?: AbortSignal) => request<{ authorizationUrl: string }>('/oauth/start', json('POST', { provider, ...(clientId?.trim() ? { clientId: clientId.trim() } : {}) }), signal)
export const disconnectEmailMemory = disconnectGmailMemory
export const selectEmailMailbox = (mailboxId: string, signal?: AbortSignal) => request<{ status: EmailMemoryStatus }>('/mailboxes/select', json('POST', { mailboxId }), signal)
export function emailAuthorizationUrl(value: string, provider: 'gmail' | 'outlook') {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === (provider === 'outlook' ? 'login.microsoftonline.com' : 'accounts.google.com') && !url.username && !url.password && !url.port ? url.href : undefined } catch { return undefined }
}
export function gmailAuthorizationUrl(value: string) {
  return emailAuthorizationUrl(value, 'gmail')
}
export function emailSyncPresentation(sync?: EmailMemorySync) {
  const running = sync?.status === 'running', complete = sync?.status === 'complete'
  const titles = { idle: 'Your email memory is ready to begin', running: 'Bringing your email into Memory', complete: 'Mailbox scan complete', partial: 'Your scan is paused', blocked: 'Your scan needs attention', failed: 'Your scan could not finish' }
  return { running, complete, title: titles[sync?.status || 'idle'], action: running ? 'Syncing…' : sync?.resumable ? 'Resume sync' : complete ? 'Sync mail again' : 'Sync all mail', message: sync?.message || (running ? 'Each page is saved as it arrives. You can keep using Spur.' : complete ? 'All available messages in the selected mailbox scope were scanned.' : 'Connect your email, then sync your mail to see the people and conversations you already know.') }
}
export const emailSender = (address?: MailAddress | null) => address?.name || address?.email || 'Unknown sender'
const zohoServerMap: Record<string, { personal: string; business: string }> = {
  us: { personal: 'imap.zoho.com', business: 'imappro.zoho.com' }, eu: { personal: 'imap.zoho.eu', business: 'imappro.zoho.eu' },
  in: { personal: 'imap.zoho.in', business: 'imappro.zoho.in' }, au: { personal: 'imap.zoho.com.au', business: 'imap.zoho.com.au' },
  jp: { personal: 'imap.zoho.jp', business: 'imap.zoho.jp' }, cn: { personal: 'imap.zoho.com.cn', business: 'imap.zoho.com.cn' },
}
export function zohoServerPreview({ email = '', region = 'us', accountType = 'auto' }: { email?: string; region?: string; accountType?: ZohoAccountType } = {}) {
  const servers = Object.prototype.hasOwnProperty.call(zohoServerMap, region) ? zohoServerMap[region] : undefined
  if (!servers) return undefined
  const domain = email.trim().toLowerCase().split('@')[1] || ''
  const personal = /^(zoho|zohomail)\.(com|eu|in|jp|com\.au|com\.cn)$/.test(domain)
  const resolvedType = accountType === 'auto' ? personal ? 'personal' : 'business' : accountType
  return { host: servers[resolvedType], accountType: resolvedType, automatic: accountType === 'auto' }
}
export function zohoConnectionGuidance(code?: string) {
  if (code === 'imap_auth_required' || code === 'zoho_auth_required' || code === 'zoho_app_password_required') return 'With Zoho two-factor authentication, use a 12-character Zoho application-specific password, not your usual account password.'
  if (code === 'imap_folders_unavailable' || code === 'zoho_imap_disabled' || code === 'imap_access_disabled') return 'Enable IMAP in Zoho Mail’s account settings and confirm that your mailbox plan includes IMAP access.'
  if (code === 'zoho_region_mismatch') return 'Choose the data centre shown in your own Zoho Mail account, then check its listed incoming server before retrying.'
  if (code === 'zoho_rate_limited' || code === 'zoho_account_blocked') return 'Check your Zoho account’s security or access notice before trying the same connection again.'
  if (code === 'imap_tls_failed' || code === 'imap_dns_failed' || code === 'imap_timeout') return 'Spur could not reach this incoming server securely. Confirm the data centre and server in Zoho Mail’s IMAP settings.'
  return 'Check that this incoming server matches Zoho Mail’s IMAP settings. With two-factor authentication, use a Zoho application-specific password.'
}
export function emailMailboxIdentity(connection?: EmailMemoryConnection, mailboxEmail?: string | null, mailboxId?: string | null) {
  if (connection?.accountId) return connection.accountId
  if (mailboxId) return mailboxId
  const email = connection?.email || mailboxEmail
  return email ? `${connection?.provider || 'gmail'}:${email.toLowerCase()}` : ''
}
export function emailResponseMatchesMailbox(identity: string, response: { accountId?: string | null }) {
  return response.accountId === undefined || (response.accountId || '') === identity
}
export function mergeEmailMessages(previous: EmailMemoryMessage[], incoming: EmailMemoryMessage[]) {
  return [...new Map([...previous, ...incoming].map(message => [message.id, message])).values()]
}
