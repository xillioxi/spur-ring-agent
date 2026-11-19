import { lazy, Suspense, useEffect, useState } from 'react'
import { EmailMemoryWorkspace } from './EmailMemoryWorkspace'
import { EmailMemoryModal } from './EmailMemoryModal'
import { isSocialMemoryHash, socialAccountFromHash, SocialAccountOptions, isMediaProvider, type MediaProvider, type SocialAccountId } from './SocialAccounts'
import type { EmailProvider } from './emailMemoryApi'
import {MetaMessages} from './MetaMessages'
import {useSocialDirectory} from './socialDirectory'
import {backendScope} from './taskApi'
import MemoryBank from './MemoryBank'
import './emailMemory.css'

const WhatsAppMemory = lazy(() => import('./WhatsAppMemory'))

export { SocialAccountOptions } from './SocialAccounts'

export function MemoryPage() {
  const [view,setView]=useState<'bank'|'social'>(()=>typeof window!=='undefined'&&isSocialMemoryHash(window.location.hash)?'social':'bank')
  useEffect(()=>{const follow=()=>setView(isSocialMemoryHash(window.location.hash)?'social':'bank');window.addEventListener('hashchange',follow);return()=>window.removeEventListener('hashchange',follow)},[])
  function choose(next:'bank'|'social'){setView(next);window.history.replaceState(null,'',next==='bank'?'#memory':'#memory/social')}
  return <><nav className="email-memory-modebar" aria-label="Memory views"><button type="button" className={view==='bank'?'active':''} aria-pressed={view==='bank'} onClick={()=>choose('bank')}>Memory bank</button><button type="button" className={view==='social'?'active':''} aria-pressed={view==='social'} onClick={()=>choose('social')}>Social network</button></nav>{view==='bank'?<MemoryBank onSocialNetwork={()=>choose('social')}/>:<SocialNetworkWorkspace/>}</>
}

function useSectionPreference(section:string,forceOpen:boolean) {
  const key = 'spur.social.' + (backendScope || 'local') + '.' + section
  const [open,setOpen] = useState(() => {
    try { return forceOpen || localStorage.getItem(key) !== 'closed' } catch { return true }
  })
  function change(value:boolean) {
    setOpen(value)
    try { localStorage.setItem(key,value ? 'open' : 'closed') } catch { /* Storage unavailable. */ }
  }
  return [open,change] as const
}

export function SocialNetworkWorkspace() {
  const initial = typeof window === 'undefined' ? undefined : socialAccountFromHash(window.location.hash)
  const [adding,setAdding] = useState(false)
  const [emailOpen,setEmailOpen] = useSectionPreference('email',!!initial && !isMediaProvider(initial))
  const [mediaOpen,setMediaOpen] = useSectionPreference('media',!!initial && isMediaProvider(initial))
  const [media,setMedia] = useState<MediaProvider>(() => {
    if (initial && isMediaProvider(initial)) return initial
    try { const last=localStorage.getItem('spur.social.provider.'+backendScope); if(last==='instagram'||last==='messenger')return last } catch {}
    return 'whatsapp'
  })
  const [emailRequest,setEmailRequest] = useState<{provider:EmailProvider} | undefined>(initial && !isMediaProvider(initial) ? {provider:initial} : undefined)
  const [whatsappRequest,setWhatsAppRequest] = useState(initial==='whatsapp'?1:0)
  const [revision,setRevision] = useState(0)
  const directory = useSocialDirectory(revision)
  function selectMedia(provider:MediaProvider) {
    setMedia(provider)
    try { localStorage.setItem('spur.social.provider.'+backendScope,provider) } catch {}
  }
  function chooseAccount(id:SocialAccountId) {
    setAdding(false)
    if (isMediaProvider(id)) {
      setMediaOpen(true);selectMedia(id)
      if(id==='whatsapp')setWhatsAppRequest(v=>v+1)
    } else {
      setEmailOpen(true);setEmailRequest({provider:id})
    }
  }
  useEffect(()=>{
    function follow(){
      const id=socialAccountFromHash(window.location.hash)
      if(id){chooseAccount(id);window.history.replaceState(null,'','#memory/social')}
    }
    follow()
    window.addEventListener('hashchange',follow)
    return ()=>window.removeEventListener('hashchange',follow)
  },[])
  function toggleEmail() {setEmailOpen(!emailOpen);setEmailRequest(undefined)}
  function toggleMedia() {setMediaOpen(!mediaOpen);setWhatsAppRequest(0)}
  return <section className="memory-page email-memory-page social-network-page">
    <header className="email-memory-heading"><h1>Social network<span>.</span></h1><button type="button" className="email-memory-primary" aria-haspopup="dialog" aria-expanded={adding} onClick={()=>setAdding(true)}>＋ Add accounts</button></header>
    {adding && <EmailMemoryModal title="Add accounts" onClose={()=>setAdding(false)}><div className="social-account-picker">
      <div className="email-memory-section-head"><h2>Add accounts</h2><button type="button" aria-label="Close add accounts" onClick={()=>setAdding(false)}>×</button></div>
      <SocialAccountOptions onChoose={chooseAccount}/>
    </div></EmailMemoryModal>}
    <div className="social-network-sources">
      <section><button className="social-section-toggle" aria-expanded={emailOpen} aria-controls="social-email" onClick={toggleEmail}>Email</button>
        <div id="social-email">{emailOpen && <EmailMemoryWorkspace embedded addAccountRequest={emailRequest} onAddAccounts={()=>setAdding(true)}/>}</div>
      </section>
      <section><button className="social-section-toggle" aria-expanded={mediaOpen} aria-controls="social-media" onClick={toggleMedia}>Social Media</button>
        <div id="social-media">{mediaOpen && <>
          <nav className="social-provider-list" aria-label="Social media accounts">
            {(['whatsapp','instagram','messenger'] as const).map(id=><button key={id} type="button" aria-pressed={media===id} onClick={()=>{selectMedia(id);setWhatsAppRequest(0)}}><strong>{{whatsapp:'WhatsApp',instagram:'Instagram',messenger:'Messenger'}[id]}</strong><small>{directory.labels[id].join(' · ') || (id==='whatsapp'?'Chats and contacts':'Connect account')}</small></button>)}
            {directory.other.map(account=><a href="#apps" key={account.provider}>{account.label}</a>)}
          </nav>
          {media==='whatsapp'?<Suspense fallback={<p role="status">Opening WhatsApp…</p>}><WhatsAppMemory embedded setupRequest={whatsappRequest}/></Suspense>
            :<MetaMessages key={media} provider={media} onImported={()=>setRevision(v=>v+1)}/>}
        </>}</div>
      </section>
    </div>
  </section>
}
