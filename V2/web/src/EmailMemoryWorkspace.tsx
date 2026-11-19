import { lazy, Suspense, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { DetailDrawer } from './DetailDrawer'
import { SocialAccountMark } from './SocialAccounts'
import { EmailMemoryModal } from './EmailMemoryModal'
import { EmailContactContext, relationshipOptions } from './EmailContactContext'
import { EmailContactDirectory } from './EmailContactDirectory'
import {
  connectEmailMailbox, disconnectEmailMemory, emailSender, emailSyncPresentation, emailProviders,
  getEmailMemoryMessage, getEmailMemoryMessages, getEmailMemoryStatus, getEmailNetwork,
  EmailMemoryApiError, emailAuthorizationUrl, emailMailboxIdentity, emailResponseMatchesMailbox, mergeEmailMessages, selectEmailMailbox, startEmailOAuth, syncEmailMemory, zohoConnectionGuidance, zohoServerPreview,
  type EmailMailbox, type EmailMailboxCredentials, type EmailMemoryConnection, type EmailMemoryMessage, type EmailMemoryMessages, type EmailMemoryStatus, type EmailNetwork, type EmailProvider, type ZohoAccountType,
} from './emailMemoryApi'
import './emailMemory.css'

const EmailNetworkGraph = lazy(() => import('./EmailRelationshipGraph'))
const dateLabel = (value?: string | null) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'Date unavailable'
const errorText = (value: unknown, fallback: string) => value instanceof Error && value.message ? value.message : fallback
function useDebounced(value: string) {
  const [result, setResult] = useState(value)
  useEffect(() => { const timer = setTimeout(() => setResult(value), 250); return () => clearTimeout(timer) }, [value])
  return result
}

export function EmailMemoryWorkspace({ embedded = false, addAccountRequest, onAddAccounts }: { embedded?: boolean; addAccountRequest?: { provider: EmailProvider }; onAddAccounts?: () => void } = {}) {
  const [status, setStatus] = useState<EmailMemoryStatus | null>(null), [networkState, setNetwork] = useState<EmailNetwork | null>(null)
  const [networkIdentity, setNetworkIdentity] = useState(''), [mailIdentity, setMailIdentity] = useState(''), [messageIdentity, setMessageIdentity] = useState('')
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [revision, setRevision] = useState(0), [selectedEmail, setSelectedEmail] = useState('')
  const [contactQuery, setContactQuery] = useState(''), [query, setQuery] = useState('')
  const [relationshipFilter, setRelationshipFilter] = useState('auto')
  const [showGraph, setShowGraph] = useState(false)
  const contactSearch = useDebounced(contactQuery), messageSearch = useDebounced(query)
  const [mailState, setMail] = useState<EmailMemoryMessages>({ messages: [], hasMore: false, total: 0 })
  const [mailLoading, setMailLoading] = useState(false), [mailError, setMailError] = useState(''), [loadingMore, setLoadingMore] = useState(false)
  const [messageState, setSelectedMessage] = useState<EmailMemoryMessage | null>(null), [messageLoading, setMessageLoading] = useState(false), [messageError, setMessageError] = useState('')
  const [showConnection, setShowConnection] = useState(false), [connectionMode, setConnectionMode] = useState<'add' | 'manage'>('add')
  const [busy, setBusy] = useState(''), [connectionError, setConnectionError] = useState(''), [authorizationUrl, setAuthorizationUrl] = useState('')
  const [connectionErrorCode, setConnectionErrorCode] = useState<string | undefined>()
  useEffect(() => {
    if (!addAccountRequest) return
    setConnectionMode('add'); setShowConnection(true); setConnectionError(''); setConnectionErrorCode(undefined); setAuthorizationUrl('')
  }, [addAccountRequest])
  const mounted = useRef(true), actions = useRef<AbortController | null>(null), moreRequest = useRef<AbortController | null>(null), mailGeneration = useRef(0)
  const mailboxKey = emailMailboxIdentity(status?.connection, status?.mailboxEmail, status?.mailboxId), currentMailbox = useRef(mailboxKey)
  currentMailbox.current = mailboxKey
  const network = networkIdentity === mailboxKey ? networkState : null
  const mail = mailIdentity === mailboxKey ? mailState : { messages: [], hasMore: false, total: 0 }
  const selectedMessage = messageIdentity === mailboxKey ? messageState : null
  const sync = emailSyncPresentation(status?.sync)
  const allPeople = useMemo(() => network?.nodes.filter(node => node.kind !== 'self') || [], [network])
  const people = useMemo(() => allPeople.filter(node => relationshipFilter === 'auto' || (node.relationship || 'other') === relationshipFilter), [allPeople, relationshipFilter])
  const graphNetwork = useMemo(() => {
    if (!network || relationshipFilter === 'auto') return network
    const nodes = network.nodes.filter(node => node.kind === 'self' || people.some(person => person.id === node.id)), ids = new Set(nodes.map(node => node.id))
    return { ...network, nodes, edges:network.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)) }
  }, [network, relationshipFilter, people])
  const selectedPerson = network?.nodes.find(node => node.email === selectedEmail)
  const connected = !!status?.connection.connected
  const mailboxes = status?.connection.mailboxes ?? status?.mailboxes ?? []
  const selectedMailboxId = status?.connection.selectedMailboxId ?? status?.selectedMailboxId

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; actions.current?.abort(); moreRequest.current?.abort() } }, [])
  useEffect(() => {
    const controller = new AbortController(), requestedKey = mailboxKey
    setError('')
    void Promise.allSettled([getEmailMemoryStatus(controller.signal), getEmailNetwork(contactSearch, controller.signal, relationshipFilter)]).then(([state, graph]) => {
      if (controller.signal.aborted || currentMailbox.current !== requestedKey) return
      if (state.status === 'fulfilled') setStatus(state.value)
      else setError(errorText(state.reason, 'Could not open your email memory.'))
      const incomingKey = state.status === 'fulfilled' ? emailMailboxIdentity(state.value.connection, state.value.mailboxEmail, state.value.mailboxId) : requestedKey
      if (graph.status === 'fulfilled') {
        if (emailResponseMatchesMailbox(incomingKey, graph.value)) { setNetwork(graph.value); setNetworkIdentity(incomingKey) }
        else setError('The mailbox changed while loading its network. Refresh to read the current account.')
      } else setError(errorText(graph.reason, 'Could not open your network.'))
      setLoading(false)
    })
    return () => controller.abort()
  }, [revision, contactSearch, mailboxKey, relationshipFilter])
  useEffect(() => {
    if (!sync.running) return
    const controller = new AbortController(), requestedKey = mailboxKey
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      try {
        const [state, graph] = await Promise.all([getEmailMemoryStatus(controller.signal), getEmailNetwork(contactSearch, controller.signal, relationshipFilter)])
        if (controller.signal.aborted || currentMailbox.current !== requestedKey) return
        const incomingKey = emailMailboxIdentity(state.connection, state.mailboxEmail, state.mailboxId)
        setStatus(state)
        if (incomingKey !== requestedKey) { setRevision(value => value + 1); return }
        if (emailResponseMatchesMailbox(requestedKey, graph)) { setNetwork(graph); setNetworkIdentity(requestedKey) }
        setError('')
        if (state.sync.status !== 'running') return
      } catch (e) { if (!controller.signal.aborted) setError(errorText(e, 'Sync progress is temporarily unavailable. Retrying…')) }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 3000)
    }
    timer = setTimeout(() => void poll(), 1500)
    return () => { controller.abort(); clearTimeout(timer) }
  }, [sync.running, contactSearch, mailboxKey, relationshipFilter])
  useEffect(() => {
    actions.current?.abort(); moreRequest.current?.abort(); mailGeneration.current++
    setSelectedEmail(''); setSelectedMessage(null); setContactQuery(''); setQuery(''); setNotice(''); setRelationshipFilter('auto'); setShowGraph(false)
    setMailError(''); setMessageError(''); setMessageLoading(false); setLoadingMore(false)
  }, [mailboxKey])
  useEffect(() => {
    const refresh = () => setRevision(value => value + 1)
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])
  useEffect(() => {
    const controller = new AbortController(), generation = ++mailGeneration.current, requestedKey = mailboxKey
    moreRequest.current?.abort(); setLoadingMore(false); setMailLoading(true); setMailError('')
    void getEmailMemoryMessages({ person: selectedEmail || undefined, query: messageSearch }, controller.signal).then(value => {
      if (!controller.signal.aborted && generation === mailGeneration.current && currentMailbox.current === requestedKey && emailResponseMatchesMailbox(requestedKey, value)) { setMail(value); setMailIdentity(requestedKey) }
    }).catch(e => { if (!controller.signal.aborted) setMailError(errorText(e, 'Could not open these emails.')) }).finally(() => { if (!controller.signal.aborted) setMailLoading(false) })
    return () => controller.abort()
  }, [selectedEmail, messageSearch, status?.messageCount, mailboxKey, revision])
  useEffect(() => { actions.current?.abort(); setSelectedMessage(null); setMessageLoading(false); setMessageError('') }, [selectedEmail, messageSearch, mailboxKey])

  async function loadMore() {
    if (!mail.hasMore || !mail.nextCursor || loadingMore) return
    const generation = mailGeneration.current, controller = new AbortController(), requestedKey = mailboxKey
    moreRequest.current = controller; setLoadingMore(true); setMailError('')
    try {
      const result = await getEmailMemoryMessages({ person: selectedEmail || undefined, query: messageSearch, cursor: mail.nextCursor }, controller.signal)
      if (mounted.current && !controller.signal.aborted && generation === mailGeneration.current && currentMailbox.current === requestedKey && emailResponseMatchesMailbox(requestedKey, result)) { setMail(previous => ({ ...result, messages: mergeEmailMessages(previous.messages, result.messages) })); setMailIdentity(requestedKey) }
    } catch (e) { if (mounted.current && !controller.signal.aborted) setMailError(errorText(e, 'Could not load the next emails.')) }
    finally { if (mounted.current && generation === mailGeneration.current) setLoadingMore(false) }
  }
  function choosePerson(value: string) { setSelectedEmail(value); setSelectedMessage(null) }
  function chooseCompany(value: string) { setContactQuery(value); choosePerson('') }
  const groupedGraph = showGraph && graphNetwork && <EmailNetworkGraph network={graphNetwork} selectedEmail={selectedEmail} onSelect={choosePerson} onCompany={chooseCompany} />
  async function openMessage(message: EmailMemoryMessage) {
    actions.current?.abort(); const controller = new AbortController(), requestedKey = mailboxKey; actions.current = controller
    setSelectedMessage(message); setMessageIdentity(requestedKey); setMessageLoading(true); setMessageError('')
    try { const result = await getEmailMemoryMessage(message.id, controller.signal); if (mounted.current && !controller.signal.aborted && currentMailbox.current === requestedKey && emailResponseMatchesMailbox(requestedKey, result)) setSelectedMessage(result.message) }
    catch (e) { if (mounted.current && !controller.signal.aborted) setMessageError(errorText(e, 'Could not read this email.')) }
    finally { if (mounted.current && !controller.signal.aborted) setMessageLoading(false) }
  }
  async function runSync(resume = true) {
    if (busy || sync.running || !connected) return
    setBusy('sync'); setError(''); setNotice('')
    try { const result = await syncEmailMemory(resume); if (mounted.current) { setStatus(result.status); setRevision(value => value + 1) } }
    catch (e) { if (mounted.current) setError(errorText(e, 'Could not start your mailbox scan.')) }
    finally { if (mounted.current) setBusy('') }
  }
  function closeConnection() { setShowConnection(false); setConnectionError(''); setConnectionErrorCode(undefined); setAuthorizationUrl('') }
  function addMailbox() { setConnectionMode('add'); setShowConnection(value => connectionMode === 'add' ? !value : true); setConnectionError(''); setConnectionErrorCode(undefined); setAuthorizationUrl('') }
  async function chooseMailbox(id: string) {
    if (busy || id === selectedMailboxId) return
    setBusy('select'); setError(''); setNotice(''); actions.current?.abort(); moreRequest.current?.abort(); setSelectedMessage(null)
    try {
      const result = await selectEmailMailbox(id)
      if (!mounted.current) return
      setStatus(result.status); closeConnection(); setRevision(value => value + 1)
    } catch (e) { if (mounted.current) setError(errorText(e, 'Could not switch to that mailbox.')) }
    finally { if (mounted.current) setBusy('') }
  }
  async function connect(credentials: EmailMailboxCredentials) {
    if (busy) return
    setBusy('connect'); setConnectionError(''); setConnectionErrorCode(undefined); setNotice('')
    try {
      const result = await connectEmailMailbox(credentials)
      if (!mounted.current) return
      setStatus(previous => previous ? { ...previous, connection: result.connection } : previous)
      closeConnection(); setSelectedEmail(''); setMail({ messages: [], hasMore: false, total: 0 }); setNetwork(null)
      setNotice('Email connected. Choose Sync all mail to build your network.'); setRevision(value => value + 1)
    } catch (e) { if (mounted.current) { setConnectionError(errorText(e, 'Could not connect this mailbox. Check its settings and application password.')); setConnectionErrorCode(e instanceof EmailMemoryApiError ? e.code : undefined) } }
    finally { if (mounted.current) setBusy('') }
  }
  async function authorizeEmail(provider: 'gmail' | 'outlook', clientId?: string) {
    if (busy) return
    setBusy('oauth'); setConnectionError('')
    try {
      const result = await startEmailOAuth(provider, clientId), url = emailAuthorizationUrl(result.authorizationUrl, provider)
      if (!url) throw new Error('The email provider returned an invalid sign-in address. Please try again.')
      if (!mounted.current) return
      setAuthorizationUrl(url); window.open(url, '_blank', 'noopener,noreferrer')
    } catch (e) { if (mounted.current) setConnectionError(errorText(e, 'Could not start email sign-in.')) }
    finally { if (mounted.current) setBusy('') }
  }
  async function disconnect() {
    if (busy || sync.running) return
    setBusy('disconnect'); setConnectionError('')
    try {
      const result = await disconnectEmailMemory()
      if (!mounted.current) return
      setStatus(previous => previous ? { ...previous, connection: result.connection } : previous); closeConnection()
      setNotice('Email disconnected. Your saved email memory is still available on this computer.'); setRevision(value => value + 1)
    } catch (e) { if (mounted.current) setConnectionError(errorText(e, 'Could not disconnect email.')) }
    finally { if (mounted.current) setBusy('') }
  }

  return <section className={embedded ? 'email-memory-page social-network-workspace' : 'memory-page email-memory-page'}>
    <EmailMailboxSwitcher mailboxes={mailboxes} selectedMailboxId={selectedMailboxId} selecting={busy === 'select'} adding={showConnection && connectionMode === 'add'} onSelect={id => void chooseMailbox(id)} onAdd={embedded ? undefined : onAddAccounts || addMailbox} />
    {!embedded && <p className="memory-crumb">PEOPLE & CONVERSATIONS</p>}
    <header className="email-memory-heading"><div>{!embedded && <h1>Social network<span>.</span></h1>}<p>{status?.connection.email || status?.mailboxEmail ? `The people and conversations in ${status?.connection.email || status?.mailboxEmail}.` : 'The people you know. The conversations that connect you.'}</p></div>{mailboxes.length > 0 && <button type="button" onClick={() => { setConnectionMode('manage'); setShowConnection(value => connectionMode === 'manage' ? !value : true); setConnectionError(''); setAuthorizationUrl('') }} aria-expanded={showConnection && connectionMode === 'manage'}>Email connection settings</button>}</header>
    <div className="email-memory-source"><span className={connected ? 'email-memory-dot connected' : 'email-memory-dot'} />{connected ? `${status?.connection.providerLabel || emailProviders.find(item => item.id === status?.connection.provider)?.label || 'Email'} · ${status?.connection.email || 'connected'}` : status?.messageCount ? 'Disconnected · saved mailbox' : 'No mailbox connected'}<span>Private on this computer</span></div>
    {showConnection && <EmailMemoryModal title={connectionMode === 'add' ? 'Add email account' : 'Connection settings'} busy={!!busy} onClose={closeConnection}><EmailConnectionPanel key={connectionMode === 'add' ? `add:${addAccountRequest?.provider || ''}` : `manage:${selectedMailboxId || ''}`} mode={connectionMode} initialProvider={connectionMode === 'add' ? addAccountRequest?.provider : undefined} connection={status?.connection} busy={busy} syncing={sync.running} error={connectionError} errorCode={connectionErrorCode} authorizationUrl={authorizationUrl} onClose={() => { if (!busy) closeConnection() }} onConnect={connect} onAuthorize={authorizeEmail} onDisconnect={disconnect} onCheck={() => setRevision(value => value + 1)} onProviderChange={() => { setConnectionError(''); setConnectionErrorCode(undefined); setAuthorizationUrl('') }} /></EmailMemoryModal>}
    {loading ? <div className="email-memory-loading" role="status">Opening your email memory…</div> : <>
      <section className="email-memory-sync" aria-labelledby="email-sync-title">
        <div><p className="email-memory-eyebrow">MAILBOX SYNC</p><h2 id="email-sync-title">{sync.title}</h2><p>{sync.message}</p></div>
        <div className="email-memory-sync-actions"><button type="button" disabled={!!busy || sync.running || !connected} onClick={() => void runSync()}>{busy === 'sync' ? 'Starting…' : sync.action} <span aria-hidden="true">↻</span></button>{status?.sync.resumable && !sync.running && <button type="button" disabled={!!busy || !connected} className="email-memory-text-button" onClick={() => void runSync(false)}>Start a fresh sync</button>}</div>
        <div className="email-memory-sync-stats" role="status"><span><strong>{(status?.messageCount || 0).toLocaleString()}</strong> emails saved</span><span><strong>{(status?.peopleCount || 0).toLocaleString()}</strong> people</span><span>{status?.sync.pagesFetched || 0} pages scanned</span>{status?.sync.updatedAt && <span>Updated {dateLabel(status.sync.updatedAt)}</span>}</div>
        <p className="email-memory-small">{(!connected ? network?.scope : status?.connection.scope) || status?.connection.scope || 'Mail folders made available by your provider'}. Message headers build the network; email text is fetched when you open it. Attachments are not indexed or saved.</p>
      </section>
      {notice && <p className="email-memory-notice" role="status">{notice}</p>}
      {error && <p className="email-memory-error" role="alert">{error} <button type="button" onClick={() => setRevision(value => value + 1)}>Try again</button></p>}
      <section className="email-memory-network" aria-labelledby="email-network-title">
        <div className="email-memory-section-head"><div><p className="email-memory-eyebrow">PEOPLE & ORGANIZATIONS</p><h2 id="email-network-title">Who you know. What they handle.</h2></div><label className="email-memory-contact-search">Find people & organizations<input type="search" aria-label="Find a person in your email network" placeholder="Person, company, role or group…" value={contactQuery} onChange={event => setContactQuery(event.target.value)} /></label></div>
        {!!network?.totalPeople && <nav className="email-relationship-filters" aria-label="Relationship groups">{relationshipOptions.map(([value, title]) => <button key={value} type="button" aria-pressed={relationshipFilter === value} onClick={() => { setRelationshipFilter(value); choosePerson('') }}>{value === 'auto' ? 'All groups' : title} <small>{network?.relationshipCounts?.[value] ?? allPeople.filter(person => value === 'auto' || (person.relationship || 'other') === value).length}</small></button>)}</nav>}
        {graphNetwork && (people.length > 0 || network!.totalMessages > 0 && !contactSearch) ? <><div className="email-directory-toolbar"><p className="email-memory-small">Browse relationships and organizations, then select someone to review what they handle.{network!.truncated ? ` Showing ${network!.visiblePeople.toLocaleString()} of ${(network!.matchedPeople ?? network!.totalPeople).toLocaleString()} matching contacts. Search or choose a group to find more.` : ''}</p><button type="button" aria-expanded={showGraph} aria-controls="email-optional-graph" onClick={() => setShowGraph(value => !value)}>{showGraph ? 'Hide visual graph' : 'Show visual graph'}</button></div>{showGraph && <div id="email-optional-graph"><Suspense fallback={<p className="email-memory-loading">Drawing your email network…</p>}>{groupedGraph}</Suspense></div>}{!people.length && <p className="email-memory-small">No contacts in this group yet. Select a person in All groups to assign their relationship.</p>}</> : <div className="email-memory-network-empty"><h3>{contactSearch ? 'No matching contacts' : 'Your contacts start with a conversation.'}</h3><p>{contactSearch ? 'Try another person, company or role, or sync more messages.' : 'Add your email and sync your mailbox to organize your people and services.'}</p>{!connected && <button type="button" onClick={onAddAccounts || addMailbox}>Add accounts ↗</button>}</div>}
        {selectedPerson && selectedPerson.kind !== 'self' && <EmailContactContext key={`${mailboxKey}:${selectedEmail}`} person={selectedPerson} accountId={network?.accountId || ''} onSaved={() => setRevision(value => value + 1)} onEvidence={id => { void openMessage({ id, from:null, to:[], cc:[], subject:'Source email', date:null }) }} />}
        {!!network?.excludedDraftCount && <p className="email-memory-small">{network.excludedDraftCount.toLocaleString()} unsent drafts are kept in your email list and do not create connections.</p>}
        {!!people.length && <EmailContactDirectory people={people} selectedEmail={selectedEmail} onSelect={choosePerson} onCompany={chooseCompany} />}
      </section>
      <section className="email-memory-mail" aria-labelledby="email-memory-mail-title">
        <div className="email-memory-section-head"><div><p className="email-memory-eyebrow">THE SOURCE</p><h2 id="email-memory-mail-title">{selectedEmail ? `Emails with ${selectedPerson?.label || selectedEmail}` : 'Your emails'}</h2><p>{selectedEmail && <button type="button" className="email-memory-text-button" onClick={() => choosePerson('')}>← All conversations</button>} {mail.total.toLocaleString()} matching emails in your saved mailbox</p></div><label className="email-memory-contact-search">Search emails<input type="search" aria-label="Search all saved emails" placeholder="Subject, person, or snippet…" value={query} onChange={event => setQuery(event.target.value)} /></label></div>
        {mailLoading ? <p className="email-memory-loading" role="status">Finding your emails…</p> : <>{mailError && <p className="email-memory-error" role="alert">{mailError}</p>}{mail.messages.length ? <div className="email-memory-message-list">{mail.messages.map(message => <button type="button" key={message.id} onClick={() => void openMessage(message)} className={selectedMessage?.id === message.id ? 'selected' : ''}><span className="email-memory-message-from">{emailSender(message.from)}<small>{dateLabel(message.date)}</small></span><span><strong>{message.subject || '(No subject)'}</strong><small>{message.snippet || message.to.map(address => address.email).join(', ')}</small></span><span aria-hidden="true">↗</span></button>)}</div> : <p className="email-memory-mail-empty">{messageSearch || selectedEmail ? 'No emails match this search in the saved mailbox.' : 'Your emails will appear as the mailbox scan progresses.'}</p>}{mail.hasMore && <button type="button" className="email-memory-load-more" onClick={() => void loadMore()} disabled={loadingMore}>{loadingMore ? 'Loading…' : 'Load more emails'}</button>}</>}
      </section>
    </>}
    {selectedMessage && <DetailDrawer title="Original email" onClose={() => { actions.current?.abort(); setSelectedMessage(null) }}><section className="email-memory-reader" aria-labelledby="email-message-subject">
      <p className="email-memory-eyebrow">YOUR MESSAGE, IN PLAIN TEXT</p>
      <h2 id="email-message-subject">{selectedMessage.subject || '(No subject)'}</h2><dl><div><dt>From</dt><dd>{emailSender(selectedMessage.from)} {selectedMessage.from?.name ? `<${selectedMessage.from.email}>` : ''}</dd></div><div><dt>To</dt><dd>{selectedMessage.to.map(address => address.name ? `${address.name} <${address.email}>` : address.email).join(', ') || 'Not listed'}</dd></div>{!!selectedMessage.cc.length && <div><dt>Cc</dt><dd>{selectedMessage.cc.map(address => address.email).join(', ')}</dd></div>}<div><dt>Date</dt><dd>{dateLabel(selectedMessage.date)}</dd></div></dl>
      {messageLoading ? <p role="status">Opening this email…</p> : messageError ? <p role="alert" className="email-memory-error">{messageError}</p> : <><pre>{selectedMessage.text || 'No readable message text was returned.'}</pre>{selectedMessage.bodyTruncated && <p className="email-memory-small">This message is too large to display in full. The text shown here is limited.</p>}</>}
    </section></DetailDrawer>}
    <p className="email-memory-footnote">Email Memory uses your saved message evidence. Building this network does not send email content to an AI model or infer friendships from shared recipients.</p>
  </section>
}

export function EmailMailboxSwitcher({ mailboxes, selectedMailboxId, selecting, adding, onSelect, onAdd }: { mailboxes: EmailMailbox[]; selectedMailboxId?: string | null; selecting: boolean; adding: boolean; onSelect: (id: string) => void; onAdd?: () => void }) {
  return <div className="email-mailbox-topbar"><span className="email-mailbox-topbar-label">EMAIL ACCOUNTS</span><nav aria-label="Email accounts">{mailboxes.length ? mailboxes.map(mailbox => <button key={mailbox.id} type="button" className={`email-mailbox-pill ${mailbox.id === selectedMailboxId ? 'is-active' : ''}`} disabled={selecting} aria-pressed={mailbox.id === selectedMailboxId} title={`${mailbox.providerLabel} · ${mailbox.email}${mailbox.connected ? '' : ' · disconnected'}`} onClick={() => onSelect(mailbox.id)}><SocialAccountMark provider={mailbox.provider}/><span>{mailbox.email}<small>{mailbox.providerLabel}{mailbox.connected ? '' : ' · reconnect'}</small></span></button>) : <span className="email-mailbox-placeholder">Your email accounts will appear here</span>}</nav>{onAdd && <button type="button" className="email-add-mailbox" aria-expanded={adding} onClick={onAdd}><span aria-hidden="true">＋</span>Add accounts</button>}</div>
}

type EmailConnectionPanelProps = {
  mode?: 'add' | 'manage'
  initialProvider?: EmailProvider
  connection?: EmailMemoryConnection; busy: string; syncing: boolean; error: string; errorCode?: string; authorizationUrl: string
  onClose: () => void; onConnect: (credentials: EmailMailboxCredentials) => Promise<void>
  onAuthorize: (provider: 'gmail' | 'outlook', clientId?: string) => Promise<void>
  onDisconnect: () => Promise<void>; onCheck: () => void; onProviderChange: () => void
}
export function EmailConnectionPanel({ mode, initialProvider, connection, busy, syncing, error, errorCode, authorizationUrl, onClose, onConnect, onAuthorize, onDisconnect, onCheck, onProviderChange }: EmailConnectionPanelProps) {
  const [provider, setProvider] = useState<EmailProvider>(initialProvider || connection?.provider || 'gmail')
  const [email, setEmail] = useState(mode === 'add' ? '' : connection?.email || ''), [password, setPassword] = useState('')
  const [region, setRegion] = useState('us'), [accountType, setAccountType] = useState<ZohoAccountType>('auto')
  const [host, setHost] = useState(''), [clientId, setClientId] = useState('')
  const providerOption = connection?.providers?.find(item => item.id === provider)
  const oauthAvailable = providerOption?.oauthAvailable ?? (provider === 'gmail' ? connection?.oauthAvailable : false)
  const providerName = emailProviders.find(item => item.id === provider)?.label || 'Email'
  const zohoServer = provider === 'zoho' ? zohoServerPreview({ email, region, accountType }) : undefined
  const validClientId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(clientId.trim())
  const canAuthorize = !!oauthAvailable && !clientId.trim() || validClientId
  function chooseProvider(value: EmailProvider) { setProvider(value); setPassword(''); setClientId(''); onProviderChange() }
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (provider === 'outlook' || busy) return
    try { await onConnect({ provider, email, appPassword: password, ...(provider === 'zoho' ? { region, accountType } : {}), ...(provider === 'imap' ? { host, port: 993 } : {}) }) }
    finally { setPassword('') }
  }
  async function authorize() {
    if (provider !== 'gmail' && provider !== 'outlook') return
    setPassword(''); await onAuthorize(provider, provider === 'outlook' && clientId.trim() ? clientId.trim() : undefined)
  }
  const passwordForm = <form onSubmit={event => void submit(event)}>
    <h3>{provider === 'gmail' ? 'Connect with a Google app password' : provider === 'zoho' ? 'Connect Zoho Mail' : 'Connect an IMAP mailbox'}</h3>
    {provider === 'gmail' ? <p>A Google app password is different from your usual password and requires 2-Step Verification. <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener noreferrer">Create an app password ↗</a> · <a href="https://support.google.com/accounts/answer/185833" target="_blank" rel="noopener noreferrer">Google’s guide ↗</a></p> : provider === 'zoho' ? <p>Enable IMAP for your mailbox in Zoho Mail. With two-factor authentication, use a 12-character Zoho application-specific password. Your plan must include IMAP access. <a href="https://www.zoho.com/mail/help/imap-access.html" target="_blank" rel="noopener noreferrer">Zoho’s mailbox settings ↗</a></p> : <p>Use your provider’s secure IMAP settings and an application password if required. The connection uses TLS on port 993. Password-only Outlook and Microsoft 365 connections are not supported; choose Outlook above.</p>}
    {provider === 'zoho' && <div className="email-memory-form-fields"><label htmlFor="memory-zoho-region">Zoho data centre<select id="memory-zoho-region" aria-label="Zoho data centre" value={region} onChange={event => setRegion(event.target.value)} disabled={!!busy}><option value="us">United States (.com)</option><option value="eu">Europe (.eu)</option><option value="in">India (.in)</option><option value="au">Australia (.com.au)</option><option value="jp">Japan (.jp)</option><option value="cn">China (.com.cn)</option></select></label><label htmlFor="memory-zoho-account-type">Zoho account type<select id="memory-zoho-account-type" aria-label="Zoho account type" value={accountType} onChange={event => setAccountType(event.target.value as ZohoAccountType)} disabled={!!busy}><option value="auto">Auto-detect from email</option><option value="business">Paid organization / custom domain</option><option value="personal">Personal / free organization</option></select></label></div>}
    <div className="email-memory-form-fields"><label htmlFor="memory-email-address">{provider === 'gmail' ? 'Gmail address' : 'Email address'}<input id="memory-email-address" type="email" autoComplete="email" placeholder={provider === 'gmail' ? 'you@gmail.com' : provider === 'zoho' ? 'you@your-company.com' : 'you@example.com'} value={email} onChange={event => setEmail(event.target.value)} required disabled={!!busy} /></label><label htmlFor="memory-email-password">{provider === 'gmail' ? 'Google app password' : provider === 'zoho' ? 'Zoho mail or app password' : 'Mailbox or app password'}<input id="memory-email-password" type="password" autoComplete="off" placeholder={provider === 'gmail' ? 'Your 16-character app password' : provider === 'zoho' ? 'Zoho app password, if required (12 characters)' : 'Your mailbox application password'} value={password} onChange={event => setPassword(event.target.value)} required disabled={!!busy} /></label></div>
    {zohoServer && <div className="email-memory-server-preview"><span>Incoming server</span><output aria-label="Zoho incoming server">{zohoServer.host} · 993 · TLS</output><small>{zohoServer.automatic ? 'Suggested from email' : 'Selected'}: {zohoServer.accountType === 'personal' ? 'personal / free organization' : 'paid organization / custom domain'}. Use the incoming server listed in your own Zoho Mail account; you can override this suggestion above.</small></div>}
    {provider === 'imap' && <div className="email-memory-form-fields"><label htmlFor="memory-imap-host">IMAP server<input id="memory-imap-host" type="text" autoComplete="off" placeholder="imap.your-provider.com" value={host} onChange={event => setHost(event.target.value)} required disabled={!!busy} /></label><label htmlFor="memory-imap-port">Secure IMAP port<input id="memory-imap-port" type="text" value="993 · TLS" readOnly /></label></div>}
    <p className="email-memory-small">The credential stays with your local Spur server and is cleared from this form after a connection attempt.</p>
    <div className="email-memory-form-actions"><button type="button" onClick={onClose} disabled={!!busy}>Cancel</button><button type="submit" className="email-memory-primary" disabled={!!busy || !email.trim() || !password || provider === 'imap' && !host.trim()}>{busy === 'connect' ? 'Connecting…' : `Connect ${provider === 'gmail' ? 'Gmail' : provider === 'zoho' ? 'Zoho' : 'email'} securely`}</button></div>
  </form>
  return <section className="email-memory-connection" aria-labelledby="email-connect-title">
    <div className="email-memory-section-head"><div><h2 id="email-connect-title">{mode === 'add' ? 'Add email account' : mode === 'manage' ? 'Connection settings' : 'Connect your email'}</h2><p>Spur reads your mail to connect people and conversations. It does not send mail or change your inbox.</p></div><button type="button" onClick={onClose} aria-label="Close email connection" disabled={!!busy}>×</button></div>
    {connection?.connected && mode !== 'add' ? <><p>Connected to {connection.providerLabel || providerName} as <strong>{connection.email}</strong>. Disconnecting stops access to this mailbox and keeps its saved email memory. Your other mailboxes remain connected.</p><button type="button" disabled={!!busy || syncing} onClick={() => void onDisconnect()}>{busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect this mailbox'}</button></> : <>
      <label className="email-memory-provider-select" htmlFor="memory-email-provider">Email provider<select id="memory-email-provider" data-mailbox-autofocus="true" aria-label="Email provider" value={provider} disabled={!!busy} onChange={event => chooseProvider(event.target.value as EmailProvider)}>{emailProviders.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      {provider === 'outlook' ? <div className="email-memory-microsoft">
        <h3>Sign in with Microsoft</h3><p>Connect Outlook.com, Hotmail or Microsoft 365 in Microsoft’s own sign-in window. Spur requests read-only mail access. Your Microsoft password is never entered here.</p>
        <details open={!oauthAvailable}><summary>{oauthAvailable ? 'Use your own Microsoft application ID' : 'One-time Microsoft sign-in setup'}</summary><p>Microsoft sign-in needs a registered application ID. If your Spur host is not configured, register a public desktop application and enter its Application (client) ID below. No client secret is needed. <a href="https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app" target="_blank" rel="noopener noreferrer">Microsoft’s setup guide ↗</a></p><p>Use this desktop callback address: <code>http://127.0.0.1:4173/api/email-memory/outlook/callback</code></p><label htmlFor="memory-microsoft-client-id">Microsoft application ID<input id="memory-microsoft-client-id" type="text" autoComplete="off" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" value={clientId} onChange={event => setClientId(event.target.value)} disabled={!!busy} maxLength={36} /></label>{clientId.trim() && !validClientId && <p className="email-memory-small">Enter the complete Application (client) ID from your Microsoft app registration.</p>}</details>
        <button type="button" className="email-memory-primary" disabled={!!busy || !canAuthorize} onClick={() => void authorize()}>{busy === 'oauth' ? 'Opening Microsoft…' : 'Sign in with Microsoft ↗'}</button>
      </div> : <>
        {provider === 'gmail' && <div className="email-memory-google"><button type="button" className="email-memory-primary" disabled={!!busy || !oauthAvailable} onClick={() => void authorize()}>{busy === 'oauth' ? 'Opening Google…' : 'Sign in with Google ↗'}</button><p>{oauthAvailable ? 'Grant read-only Gmail access in Google’s own sign-in window.' : 'Google sign-in has not been configured for this Spur installation. The Spur owner can reuse an existing Google app registration; each mailbox only needs to sign in and approve access.'}</p></div>}
        {provider === 'gmail' ? <details><summary>Use an app password instead</summary>{passwordForm}</details> : passwordForm}
      </>}
      {authorizationUrl && <p><a href={authorizationUrl} target="_blank" rel="noopener noreferrer">Continue to {provider === 'outlook' ? 'Microsoft' : 'Google'} ↗</a> <button type="button" onClick={onCheck}>Check connection</button></p>}
    </>}
    {error && <div className="email-memory-error" role="alert"><p>{error}</p>{provider === 'zoho' && <p>{zohoConnectionGuidance(errorCode)} <a href="https://www.zoho.com/mail/help/imap-access.html" target="_blank" rel="noopener noreferrer">Open Zoho IMAP settings guide ↗</a></p>}</div>}
  </section>
}
