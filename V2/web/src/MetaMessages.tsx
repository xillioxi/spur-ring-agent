import {useEffect,useState,useRef} from 'react'
import {apiBase} from './taskApi'

type Thread = {id:string;account:string;title:string;count:number}
type Message = {id:string;sender:string;time:number;body:string}
type Provider = 'instagram'|'messenger'
export async function readSocial<T>(path:string, options?:RequestInit):Promise<T>{
  const response=await fetch(apiBase()+'/api/creator-agent/'+path,{cache:'no-store',...options})
  const value=await response.json()
  if(!response.ok)throw new Error(value.error || 'Could not open social messages.')
  return value
}
export function MetaMessages({provider,onImported}:{provider:Provider;onImported:()=>void}){
  type Connection = {configured:boolean;callback:string;accounts:{id:string;label:string}[];syncing:boolean;updated?:number;error?:string}
  const [connection,setConnection]=useState<Connection|null>(null)
  const report=useRef(onImported)
  report.current=onImported
  const endpoint='meta-inbox?provider='+provider
  const [threads,setThreads]=useState<Thread[]>([]),[activeAccount,setActiveAccount]=useState(''),[selected,setSelected]=useState('')
  const [messages,setMessages]=useState<Message[]>([]),[page,setPage]=useState(0)
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[error,setError]=useState(''),[revision,setRevision]=useState(0)
  useEffect(()=>{
    const controller=new AbortController()
    let signature='',timer:ReturnType<typeof setTimeout>
    async function refresh(){
      try{
        const value=await readSocial<Connection>(endpoint,{signal:controller.signal})
        if(controller.signal.aborted)return
        setConnection(value)
        const next=JSON.stringify([value.accounts,value.updated,value.error])
        if(signature && next!==signature){setRevision(v=>v+1);report.current()}
        signature=next
      }catch(e){if(!controller.signal.aborted)setError(e instanceof Error?e.message:'Could not read connection.')}
      if(!controller.signal.aborted)timer=setTimeout(refresh,4000)
    }
    void refresh()
    return ()=>{controller.abort();clearTimeout(timer)}
  },[endpoint])
  const path='social-archives?provider='+provider
  useEffect(()=>{const c=new AbortController()
    readSocial<{threads:Thread[]}>(path,{signal:c.signal}).then(v=>setThreads(v.threads)).catch(e=>{if(!c.signal.aborted)setError(e.message)})
    return ()=>c.abort()
  },[path,revision])
  useEffect(()=>{const c=new AbortController();setMessages([])
    if(selected)readSocial<{messages:Message[]}>(path+'&thread='+selected+'&offset='+page*100,{signal:c.signal}).then(v=>setMessages(v.messages)).catch(e=>{if(!c.signal.aborted)setError(e.message)})
    return ()=>c.abort()
  },[path,selected,page,revision])
  const accounts=[...new Set(threads.map(t=>t.account))]
  const current=threads.find(t=>t.id===selected)
  async function action(kind:'connect'|'sync'|'disconnect'){
    const popup=kind==='connect'?window.open('about:blank','_blank'):null
    if(kind==='connect'&&!popup){setError('Allow the Meta sign-in window and try again.');return}
    if(popup)popup.opener=null
    setBusy(true);setError('');setNotice('')
    try{
      const result=await readSocial<{url?:string}>(endpoint+'&action='+kind,{method:kind==='disconnect'?'DELETE':'POST'})
      if(popup && result.url){popup.location.replace(result.url);setNotice('Finish signing in with Meta to start syncing.')}
      if(kind==='disconnect'){setConnection(await readSocial<Connection>(endpoint));report.current();setNotice('Disconnected. Saved conversations remain available.')}
      if(kind==='sync')setNotice('Sync requested.')
    }catch(e){popup?.close();setError(e instanceof Error?e.message:'Connection failed.')}
    finally{setBusy(false)}
  }
  const name=provider==='instagram'?'Instagram':'Messenger'
  return <section className="social-archive">
    <p>{provider==='instagram'?'Connect a professional Instagram inbox linked to a Facebook Page you manage.':'Connect the Messenger inbox of a Facebook Page you manage.'} Spur syncs available text messages after sign-in and every five minutes while the server runs.</p>
    {connection && !connection.configured && <p role="status">Set META_APP_ID and META_APP_SECRET on the Spur server and restart it to enable sign-in. Register this callback in the Meta app: <code>{connection.callback}</code>.</p>}
    <button disabled={busy||!connection?.configured} onClick={()=>void action('connect')}>{connection?.accounts.length?'Manage authorized accounts':'Connect '+name}</button>
    {!!connection?.accounts.length && <><p>{connection.accounts.map(a=>a.label).join(' · ')}</p><button disabled={busy||connection.syncing} onClick={()=>void action('sync')}>{connection.syncing?'Syncing…':'Sync now'}</button> <button disabled={busy} onClick={()=>void action('disconnect')}>Disconnect</button></>}
    {connection?.error && <p role="alert">{connection.error}</p>}
    {!!connection?.accounts.length && connection.updated && <p>Last synced {new Date(connection.updated).toLocaleString()}</p>}
    {notice&&<p role="status">{notice}</p>}{error&&<p role="alert">{error}</p>}
    {accounts.length>0&&<><label>Saved accounts<select value={activeAccount} onChange={e=>{setActiveAccount(e.target.value);setSelected('')}}><option value="">All accounts</option>{accounts.map(a=><option key={a}>{a}</option>)}</select></label>
    <div className="social-thread-list">{threads.filter(t=>!activeAccount||t.account===activeAccount).map(t=><button key={t.id} aria-pressed={selected===t.id} onClick={()=>{setPage(0);setSelected(t.id)}}>{t.title} · {t.count} messages <small>{t.account}</small></button>)}</div></>}
    {current&&<section><h3>{current.title}</h3>{messages.map(m=><article key={m.id}><strong>{m.sender}</strong> <time>{new Date(m.time).toLocaleString()}</time><p>{m.body}</p></article>)}{page>0&&<button onClick={()=>setPage(v=>v-1)}>Newer messages</button>}{(page+1)*100<current.count&&<button onClick={()=>setPage(v=>v+1)}>Older messages</button>}</section>}
  </section>
}
