import {useEffect,useRef,useState,type FormEvent} from 'react'
import {whatsappRequest,type WhatsAppStatus,type WhatsAppChat,type WhatsAppMessages} from './whatsappApi'
import './emailMemory.css'
import './whatsappMemory.css'
const groups=[['auto','All chats'],['friends','Friends'],['family','Family'],['colleagues','Colleagues'],['services','Services'],['company','Companies'],['other','Ungrouped']]
const date=(stamp?:number)=>stamp?new Date(stamp).toLocaleString():''
export default function WhatsAppMemory({embedded=false,setupRequest=0}:{embedded?:boolean;setupRequest?:number}={}){
  const [status,setStatus]=useState<WhatsAppStatus|null>(null),[chats,setChats]=useState<{accountId:string|null;chats:WhatsAppChat[];counts:Record<string,number>}>({accountId:null,chats:[],counts:{}})
  const [selected,setSelected]=useState(''),[query,setQuery]=useState(''),[group,setGroup]=useState('auto'),[revision,setRevision]=useState(0)
  const [setup,setSetup]=useState(!embedded||setupRequest>0),[acknowledged,setAcknowledged]=useState(false),[busy,setBusy]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState('')
  const [qr,setQR]=useState<{qr:string|null;qrExpiresAt?:number}>({qr:null})
  const [loadError,setLoadError]=useState('')
  const qrPanel=useRef<HTMLDivElement>(null),workspace=useRef<HTMLElement>(null)
  useEffect(()=>{if(setupRequest){setSetup(true);workspace.current?.scrollIntoView({block:'start',behavior:'smooth'})}},[setupRequest])
  useEffect(()=>{if(status?.state==='pairing')setSetup(true)},[status?.state])
  useEffect(()=>{if(setup&&qr.qr)qrPanel.current?.scrollIntoView({block:'center',behavior:'smooth'})},[qr.qr,setup])
  const [messages,setMessages]=useState<WhatsAppMessages|null>(null),[messageError,setMessageError]=useState(''),[messageQuery,setMessageQuery]=useState(''),[loadingMessages,setLoadingMessages]=useState(false),[loadingMore,setLoadingMore]=useState(false)
  const [file,setFile]=useState<File|null>(null),[title,setTitle]=useState(''),[dateOrder,setDateOrder]=useState('DMY'),[timezoneOffset,setTimezoneOffset]=useState(new Date().getTimezoneOffset())
  const alive=useRef(true),messageGeneration=useRef(0),accountRef=useRef<string|null>(null)
  accountRef.current=status?.accountId||null
  useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
  useEffect(()=>{
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>
    async function refresh(){try{
      const [state,list]=await Promise.all([whatsappRequest<WhatsAppStatus>('/status','GET',undefined,controller.signal),whatsappRequest<typeof chats>('/chats?'+new URLSearchParams({query,relationship:group}),'GET',undefined,controller.signal)])
      if(controller.signal.aborted)return
      setStatus(state);if(state.accountId===list.accountId)setChats(list)
      if(setup||['connecting','pairing','reconnecting'].includes(state.state)){const pairing=await whatsappRequest<typeof qr>('/pairing','GET',undefined,controller.signal);if(!controller.signal.aborted)setQR(pairing)}else setQR({qr:null})
      setLoadError('')
    }catch(e){if(!controller.signal.aborted)setLoadError(e instanceof Error?e.message:'Could not load WhatsApp.')}
    if(!controller.signal.aborted)timer=setTimeout(()=>void refresh(),2500)}
    void refresh();return()=>{controller.abort();clearTimeout(timer)}
  },[query,group,revision,setup])
  useEffect(()=>{setSelected('');setMessages(null);setMessageQuery('');setMessageError('')},[status?.accountId])
  useEffect(()=>{
    const controller=new AbortController(),generation=++messageGeneration.current,accountId=status?.accountId
    if(!selected||!accountId){setMessages(null);return}
    setLoadingMessages(true);setMessageError('')
    void whatsappRequest<WhatsAppMessages>('/messages?'+new URLSearchParams({accountId,chatId:selected,query:messageQuery}),'GET',undefined,controller.signal).then(result=>{if(!controller.signal.aborted&&generation===messageGeneration.current&&result.accountId===accountRef.current&&result.chatId===selected)setMessages(result)}).catch(e=>{if(!controller.signal.aborted)setMessageError(e.message)}).finally(()=>{if(!controller.signal.aborted)setLoadingMessages(false)})
    return()=>controller.abort()
  },[selected,status?.accountId,status?.updatedAt,messageQuery,revision])
  async function action(name:string,work:()=>Promise<unknown>){if(busy)return;setBusy(name);setError('');try{await work();if(alive.current)setRevision(value=>value+1)}catch(e){if(alive.current)setError(e instanceof Error?e.message:'WhatsApp action failed.')}finally{if(alive.current)setBusy('')}}
  async function importChat(event:FormEvent){event.preventDefault();if(!file)return;await action('import',async()=>{if(file.size>20*1024*1024||!file.name.toLowerCase().endsWith('.txt'))throw new Error('Choose the exported .txt file, up to 20 MiB. Extract it first if WhatsApp supplied a ZIP.');const result=await whatsappRequest<{imported:number;skippedMessages:number;ignoredLines:number}>('/import','POST',{title,content:await file.text(),dateOrder,timezoneOffset});setNotice(`Imported ${result.imported.toLocaleString()} text messages. ${result.skippedMessages} media/deleted entries and ${result.ignoredLines} unrecognized/system lines skipped.`);setFile(null)})}
  async function loadMore(){if(!messages?.hasMore||loadingMore)return;const expected=messages,generation=messageGeneration.current;setLoadingMore(true);try{const result=await whatsappRequest<WhatsAppMessages>('/messages?'+new URLSearchParams({accountId:expected.accountId,chatId:expected.chatId,query:messageQuery,cursor:expected.nextCursor}));if(alive.current&&generation===messageGeneration.current&&accountRef.current===result.accountId)setMessages(current=>current?{...result,messages:[...new Map([...current.messages,...result.messages].map(message=>[message.id,message])).values()]}:result)}catch(e){if(alive.current&&generation===messageGeneration.current)setMessageError(e instanceof Error?e.message:'Could not load older messages.')}finally{if(alive.current)setLoadingMore(false)}}
  const visibleChats=chats.accountId===status?.accountId?chats.chats:[],chat=visibleChats.find(item=>item.id===selected)
  const visibleMessages=messages?.accountId===status?.accountId&&messages?.chatId===selected?messages:null
  const photoAccount = status?.state === 'connected' && status.accountId === status.linkedAccountId ? status.accountId : null
  return <section ref={workspace} className={embedded ? "email-memory-page whatsapp-memory social-network-workspace" : "memory-page email-memory-page whatsapp-memory"}>
    <header className="email-memory-heading"><div>{!embedded&&<h1>Social network<span>.</span></h1>}<p>Your WhatsApp chats, people and what they handle.</p></div><button type="button" onClick={()=>setSetup(value=>!value)} aria-expanded={setup}>{setup?'Close setup':status?.accountId?'WhatsApp connection settings':'Link WhatsApp'}</button></header>
    <div className="whatsapp-status"><strong>{status?.state||'Loading…'}</strong><span>{status?.messageCount.toLocaleString()||0} messages · {status?.chatCount||0} conversations</span><span>Saved on this computer</span></div>
    {status?.sources.length? <label className="whatsapp-source">Message source<select value={status.accountId||''} disabled={!!busy} onChange={event=>void action('source',()=>whatsappRequest('/account','POST',{accountId:event.target.value}))}>{status.sources.map(id=><option key={id} value={id}>{id==='imported'?'Imported chat exports':id.split('@')[0]}</option>)}</select></label>:null}
    {(error||loadError)&&<p className="email-memory-error" role="alert">{error||loadError}</p>}{notice&&<p className="email-memory-notice" role="status">{notice}</p>}
    {setup&&<section className="whatsapp-setup" aria-label="Add WhatsApp">
      <h2>Link your WhatsApp device</h2><p>On your phone, open WhatsApp → Settings / ⋮ → Linked devices → Link a device, then scan the QR code below.</p>
      <p className="email-memory-small">This uses an unofficial WhatsApp Web connector. Linking grants companion-device access to your account. Spur uses it to read messages and available history; it has no send-message controls and does not send read receipts. Account restrictions and connector changes are possible.</p>
      <label className="whatsapp-consent"><input type="checkbox" checked={acknowledged} onChange={event=>setAcknowledged(event.target.checked)}/>I understand and want to link WhatsApp to this computer.</label>
      <div className="whatsapp-actions"><button type="button" disabled={!!busy||!acknowledged||['connecting','pairing','connected','reconnecting'].includes(status?.state||'')} onClick={()=>void action('connect',()=>whatsappRequest('/connect','POST',{}))}>{busy==='connect'?'Starting…':'Connect / reconnect WhatsApp'}</button><button type="button" disabled={!!busy} onClick={()=>void action('pause',()=>whatsappRequest('/pause','POST',{}))}>Pause connection</button><button type="button" disabled={!!busy} onClick={()=>void action('disconnect',()=>whatsappRequest('/connection','DELETE'))}>Disconnect & remove session</button></div>
      {qr.qr&&qr.qrExpiresAt&&qr.qrExpiresAt>Date.now()&&/^data:image\/png;base64,/.test(qr.qr)&&<div ref={qrPanel} className="whatsapp-pairing-card" role="region" aria-label="Scan to link WhatsApp"><h3>Scan to link WhatsApp</h3><img className="whatsapp-qr" src={qr.qr} alt="WhatsApp linked-device QR code. Scan only with your own WhatsApp phone."/><p>On your phone: WhatsApp → Linked devices → Link a device.</p><small>Scan the code currently displayed here. It refreshes automatically while pairing is active.</small></div>}
      <p role="status">{status?.state==='connected'?'Device connected. Incoming messages and supplied history are being saved.':status?.state==='pairing'?'Scan the current QR code with your phone.':status?.state==='connecting'?'Requesting a QR code…':status?.message}</p>
      <p className="email-memory-small">{status?.historyCoverage} {status?.sessionStorage==='os_protected'?'Session credentials are encrypted using a Windows-protected key.':'On this host the device session lasts until Spur restarts.'} View-once and disappearing messages are excluded from live ingestion. Media files are not downloaded.</p>
      <details className="whatsapp-import"><summary>Import an exported chat instead</summary><p>In WhatsApp, open a conversation → Export chat → Without media. Save its .txt file here. If you receive a ZIP, extract the text file first. <a href="https://faq.whatsapp.com/1180414079177245/" target="_blank" rel="noopener noreferrer">WhatsApp export guide ↗</a></p>
        <form onSubmit={event=>void importChat(event)}><label>Conversation name<input required maxLength={160} value={title} onChange={event=>setTitle(event.target.value)} placeholder="e.g. Studio production team"/></label><p className="email-memory-small">Use a distinct name for each conversation/account. Reimporting the same conversation deduplicates matching messages.</p>
          <label>Chat text export<input type="file" accept=".txt,text/plain" onChange={event=>setFile(event.target.files?.[0]||null)}/></label><label>Date format<select value={dateOrder} onChange={event=>setDateOrder(event.target.value)}><option value="DMY">Day / month / year</option><option value="MDY">Month / day / year</option></select></label>
          <label>Export timezone<select value={timezoneOffset} onChange={event=>setTimezoneOffset(Number(event.target.value))}>{[...new Set([new Date().getTimezoneOffset(),...Array.from({length:57},(_,index)=>840-index*30)])].sort((a,b)=>b-a).map(offset=><option key={offset} value={offset}>UTC{-offset>=0?'+':'−'}{Math.floor(Math.abs(offset)/60)}:{String(Math.abs(offset)%60).padStart(2,'0')}</option>)}</select></label><button type="submit" disabled={!!busy||!file||!title.trim()}>{busy==='import'?'Importing…':'Import chat'}</button></form>
      </details>
    </section>}
    {status?.limited&&<p role="status" className="email-memory-small">The local cache reached 50,000 messages for this source. Only the most recent messages are retained; coverage is incomplete.</p>}
    <div className="email-memory-section-head"><h2>Chats & people</h2><label className="email-memory-contact-search">Find a conversation<input type="search" value={query} onChange={event=>setQuery(event.target.value)} placeholder="Person, group, organization or role…"/></label></div>
    <nav className="email-relationship-filters" aria-label="WhatsApp relationship groups">{groups.map(([id,label])=><button key={id} type="button" aria-pressed={group===id} onClick={()=>{setGroup(id);setSelected('')}}>{label} <small>{chats.counts[id]||0}</small></button>)}</nav>
    {chat&&status?.accountId&&<WhatsAppChatDetails key={status.accountId+chat.id} chat={chat} accountId={status.accountId} linked={photoAccount===status.accountId} onSaved={()=>setRevision(value=>value+1)}/>}
    {visibleChats.length?<div className="whatsapp-chat-list">{visibleChats.map(item=><button type="button" key={item.id} aria-pressed={item.id===selected} onClick={()=>{setSelected(item.id);setMessageQuery('')}}><div className="whatsapp-identity"><WhatsAppAvatar accountId={photoAccount} id={item.id} name={item.name}/><strong>{item.name}<small>{item.kind==='group'?'Group conversation':'Contact'}{item.company?` · ${item.company}`:''}</small></strong></div><span>{item.role||'Responsibility unconfirmed'}<small>{groups.find(([id])=>id===item.relationship)?.[1]||'Ungrouped'}</small></span><span>{item.messageCount||0} messages<small>{date(item.lastMessageAt)}</small></span></button>)}</div>:<p className="email-memory-mail-empty">{query?'No conversations match this search.':group!=='auto'?'No conversations assigned to this group yet.':'Link WhatsApp or import a chat to bring your conversations into your social network.'}</p>}
    {selected&&<section className="whatsapp-messages" aria-label="WhatsApp conversation messages"><div className="email-memory-section-head"><h2>{chat?.name||'Conversation'}</h2><label className="email-memory-contact-search">Search this conversation<input type="search" value={messageQuery} onChange={event=>setMessageQuery(event.target.value)}/></label></div>{messageError&&<p role="alert" className="email-memory-error">{messageError}</p>}{loadingMessages?<p role="status">Loading messages…</p>:<>{[...(visibleMessages?.messages||[])].reverse().map(message=><article key={message.id} className={message.fromMe?'from-me':''}><header><div className="whatsapp-identity"><WhatsAppAvatar accountId={photoAccount} id={message.senderId} name={message.fromMe?'You':message.senderName}/><strong>{message.fromMe?'You':message.senderName||message.senderId.split('@')[0]}</strong></div><time>{date(message.timestamp)}</time></header><p>{message.text}</p></article>)}{visibleMessages?.hasMore&&<button type="button" disabled={loadingMore} onClick={()=>void loadMore()}>{loadingMore?'Loading…':'Load older messages'}</button>}{!visibleMessages?.messages.length&&<p>No saved text messages match.</p>}</>}</section>}
  </section>
}
// One observer serves the whole directory, including large linked accounts.
const visibleAvatars = new WeakMap<Element, (visible: boolean) => void>()
let avatarObserver: IntersectionObserver | undefined

function WhatsAppAvatar({accountId,id,name}:{accountId:string|null;id:string;name:string}) {
  const element = useRef<HTMLSpanElement>(null)
  const [photo,setPhoto] = useState<{key:string;url:string} | null>(null)
  const key = accountId + '/' + id
  useEffect(() => {
    const node = element.current
    if (!node || !accountId) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    let visible = false, loading = false, expires = 0
    async function refresh() {
      if (!visible || loading || controller.signal.aborted) return
      clearTimeout(timer)
      if (expires > Date.now()) { timer = setTimeout(refresh, expires - Date.now()); return }
      loading = true
      try {
        const query = new URLSearchParams({accountId:accountId!,id})
        const {url} = await whatsappRequest<{url:string|null}>('/photo?' + query,'GET',undefined,controller.signal)
        if (!controller.signal.aborted) setPhoto(url ? {key,url} : null)
      } catch { if (!controller.signal.aborted) setPhoto(null) }
      loading = false
      expires = Date.now() + 5*60_000
      if (visible && !controller.signal.aborted) timer = setTimeout(refresh,5*60_000)
    }
    avatarObserver ||= new IntersectionObserver(entries => {
      for (const entry of entries) visibleAvatars.get(entry.target)?.(entry.isIntersecting)
    })
    visibleAvatars.set(node, value => {visible = value; if (visible) void refresh(); else clearTimeout(timer)})
    avatarObserver.observe(node)
    return () => {controller.abort();clearTimeout(timer);avatarObserver?.unobserve(node);visibleAvatars.delete(node)}
  },[accountId,id,key])
  return <span className="whatsapp-avatar" ref={element} aria-hidden="true">{photo?.key === key && accountId
    ? <img src={photo.url} alt="" referrerPolicy="no-referrer" onError={()=>setPhoto(null)}/>
    : Array.from(name.trim())[0]?.toUpperCase() || '�'}</span>
}
function WhatsAppChatDetails({chat,accountId,linked,onSaved}:{chat:WhatsAppChat;accountId:string;linked:boolean;onSaved:()=>void}){
  const canName = chat.kind === 'person' && accountId !== 'imported'
  const [business,setBusiness] = useState<{category:string}|null>(null)
  useEffect(() => {
    setBusiness(null)
    if (!linked || !canName) return
    const controller = new AbortController()
    const query = new URLSearchParams({accountId,id:chat.id})
    void whatsappRequest<{profile:{category:string}|null}>('/business-profile?' + query,'GET',undefined,controller.signal)
      .then(result => { if (!controller.signal.aborted) setBusiness(result.profile) }).catch(() => {})
    return () => controller.abort()
  },[accountId,chat.id,linked,canName])
  const [localName,setLocalName] = useState(chat.localName || '')
  const [relationship,setRelationship]=useState(chat.relationship),[company,setCompany]=useState(chat.company),[role,setRole]=useState(chat.role),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('')
  const alive=useRef(true);useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
  async function save(event:FormEvent){event.preventDefault();if(busy)return;setBusy(true);setError('');try{await whatsappRequest('/chats','PATCH',{accountId,chatId:chat.id,relationship,company,role,...(canName ? {localName} : {})});if(alive.current){setNotice('Contact context saved.');onSaved()}}catch(e){if(alive.current)setError(e instanceof Error?e.message:'Could not save.')}finally{if(alive.current)setBusy(false)}}
  return <section className="email-contact-context"><h3>{chat.name}</h3>{business && <p>WhatsApp business account{business.category && ' � ' + business.category}</p>}<p>Assign the relationship, organization and what this contact or group handles. Group membership alone does not establish friendship or employment.</p><form onSubmit={event=>void save(event)}>{canName && <label>Display name in Spur<input value={localName} placeholder={chat.name} maxLength={160} disabled={busy} onChange={event=>setLocalName(event.target.value)}/></label>}<label>Relationship<select value={relationship} disabled={busy} onChange={event=>setRelationship(event.target.value)}>{groups.filter(([id])=>id!=='auto').map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label><label>Organization<input value={company} maxLength={120} disabled={busy} onChange={event=>setCompany(event.target.value)}/></label><label>Responsible for<input value={role} maxLength={200} disabled={busy} onChange={event=>setRole(event.target.value)}/></label><button type="submit" disabled={busy}>{busy?'Saving…':'Save context'}</button></form>{error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}</section>
}
