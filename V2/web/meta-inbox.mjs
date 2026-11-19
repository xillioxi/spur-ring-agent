import {randomBytes, createHash} from 'node:crypto'
import {join} from 'node:path'
import {createCredentialStore} from './email-memory/credential-store.mjs'
import {openSocialArchive} from './social-archives.mjs'

const version='v27.0'
const graph='https://graph.facebook.com/'+version+'/'
const providers=['instagram','messenger']
const nonce=()=>randomBytes(32).toString('hex')
const failure=(message,status=400)=>Object.assign(new Error(message),{status})
const digest=(...parts)=>createHash('sha256').update(JSON.stringify(parts)).digest('hex')
const pending=new Map()
const instances=new Map()
const interval=5*60_000
const scopes={
  instagram:'pages_show_list,pages_manage_metadata,pages_read_engagement,instagram_basic,instagram_manage_messages',
  messenger:'pages_show_list,pages_manage_metadata,pages_read_engagement,pages_messaging',
}

export function createMetaInbox(root,config,{fetcher=fetch,storeFor=provider=>createCredentialStore({root:join(root,'meta-'+provider)})}={}){
  const stores=Object.fromEntries(providers.map(p=>[p,storeFor(p)]))
  const jobs=new Map(), outcomes=new Map(), generations=new Map()
  const callback=config.META_REDIRECT_URI || 'http://127.0.0.1:4173/api/meta-login/callback'
  const configured=Boolean(config.META_APP_ID && config.META_APP_SECRET)
  async function api(path,params,token,method='GET'){
    const url=new URL(graph+path)
    const body=new URLSearchParams(params)
    if(method==='GET')url.search=body.toString()
    const response=await fetcher(url,{method,redirect:'error',signal:AbortSignal.timeout(30000),
      headers:token?{Authorization:'Bearer '+token}:{},...(method==='POST'?{body}:{})})
    const result=await response.json()
    if(!response.ok || result.error)throw failure(result.error?.code===190?'Meta authorization expired. Sign in again.':'Meta could not complete the request. Check messaging permissions and try again.',502)
    return result
  }
  async function* rows(path,params,token){
    let after
    const seen=new Set()
    do{
      const page=await api(path,{...params,...(after?{after}:{})},token)
      if(!Array.isArray(page.data))throw failure('Meta returned an unreadable inbox response.',502)
      yield* page.data
      after=page.paging?.next && page.paging.cursors?.after
      if(after && seen.has(after))throw failure('Meta repeated a page. Retry sync.',502)
      seen.add(after)
    }while(after)
  }
  async function sync(provider){
    const generation=generations.get(provider)||0
    const grants=(await stores[provider].get())?.accounts || []
    if(!grants.length || generation!==(generations.get(provider)||0))return false
    const db=await openSocialArchive(root)
    try{
      for(const grant of grants){
        for await(const thread of rows(encodeURIComponent(grant.page)+'/conversations',{platform:provider,fields:'id,participants,updated_time'},grant.token)){
          if((generations.get(provider)||0)!==generation)return false
          const key=digest('meta',provider,grant.page,thread.id)
          if(thread.updated_time && db.prepare('SELECT updated FROM meta_checkpoints WHERE thread=?').get(key)?.updated===thread.updated_time)continue
          const people=(thread.participants?.data||[]).filter(p=>p.id!==grant.page && p.id!==grant.id)
          const title=people.map(p=>p.name||p.username||p.id).join(', ') || 'Conversation'
          let count=0
          for await(const msg of rows(encodeURIComponent(thread.id)+'/messages',{fields:'id,created_time,from,message',limit:provider==='instagram'?'20':'100'},grant.token)){
            if((generations.get(provider)||0)!==generation)return false
            const time=Date.parse(msg.created_time)
            if(msg.id && Number.isFinite(time) && msg.message){
              db.prepare('INSERT INTO threads VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET account=excluded.account,title=excluded.title').run(key,provider,grant.label,title)
              db.prepare('INSERT OR IGNORE INTO messages VALUES(?,?,?,?,?)').run(digest(key,msg.id),key,time,msg.from?.name||msg.from?.username||msg.from?.id||'Unknown sender',msg.message)
            }
            if(provider==='instagram' && ++count>=20)break
          }
          if(thread.updated_time)db.prepare('INSERT OR REPLACE INTO meta_checkpoints VALUES(?,?)').run(key,thread.updated_time)
        }
      }
      return true
    }finally{db.close()}
  }
  function schedule(provider){
    if(jobs.has(provider))return jobs.get(provider)
    const work=sync(provider).then(completed=>{if(completed)outcomes.set(provider,{updated:Date.now()})}).catch(e=>outcomes.set(provider,{error:e.status?e.message:'Sync interrupted. Spur will retry.'})).finally(()=>jobs.delete(provider))
    jobs.set(provider,work)
    return work
  }
  const timer=setInterval(()=>{for(const provider of providers)schedule(provider)},interval)
  timer.unref()
  return {
    stop(){clearInterval(timer)},
    schedule,
    async status(provider){
      const accounts=(await stores[provider].get())?.accounts || []
      return {configured,callback,accounts:accounts.map(({id,label})=>({id,label})),syncing:jobs.has(provider),...outcomes.get(provider)}
    },
    start(provider){
      if(!configured)throw failure('Configure META_APP_ID and META_APP_SECRET on the Spur server to enable Meta login.',503)
      const state=nonce()
      for(const [key,entry] of pending)if(entry.until<Date.now())pending.delete(key)
      pending.set(state,{until:Date.now()+600000,provider,inbox:this,callback,config})
      const start=new URL('/api/meta-login/authorize',callback)
      start.searchParams.set('ticket',state)
      return {url:start.href}
    },
    async finish(provider,code){
      const result=await api('oauth/access_token',{client_id:config.META_APP_ID,client_secret:config.META_APP_SECRET,redirect_uri:callback,code},null,'POST')
      if(!result.access_token)throw failure('Meta did not grant access. Try connecting again.')
      const extended=await api('oauth/access_token',{grant_type:'fb_exchange_token',client_id:config.META_APP_ID,
        client_secret:config.META_APP_SECRET,fb_exchange_token:result.access_token},null,'POST')
      if(!extended.access_token)throw failure('Could not extend the Meta authorization. Sign in again.',502)
      const accounts=[]
      const fields='id,name,access_token,tasks'+(provider==='instagram'?',instagram_business_account{id,username}':'')
      for await(const page of rows('me/accounts',{fields},extended.access_token)){
        if(!page.access_token || !page.tasks?.some(t=>['MESSAGING','MANAGE','PROFILE_PLUS_MESSAGING','PROFILE_PLUS_FULL_CONTROL'].includes(t)))continue
        const account=provider==='instagram'?page.instagram_business_account:page
        if(account?.id)accounts.push({id:account.id,page:page.id,label:account.username||page.name||page.id,token:page.access_token})
      }
      if(!accounts.length)throw failure('No eligible inbox was authorized. Select a Facebook Page you manage with messaging access'+(provider==='instagram'?' and a linked professional Instagram account.':'.'))
      await stores[provider].set({accounts})
      generations.set(provider,(generations.get(provider)||0)+1)
      await jobs.get(provider)
      schedule(provider)
    },
    async disconnect(provider){
      generations.set(provider,(generations.get(provider)||0)+1)
      await stores[provider].clear()
      for(const [key,entry] of pending)if(entry.inbox===this && entry.provider===provider)pending.delete(key)
      await jobs.get(provider)
      outcomes.delete(provider)
    },
  }
}

export function metaInbox(root,config){
  if(!instances.has(root))instances.set(root,createMetaInbox(root,config))
  return instances.get(root)
}

export async function handleMetaLogin(req,res,url){
  const authorize=url.pathname==='/api/meta-login/authorize'
  const key=url.searchParams.get(authorize?'ticket':'state')
  const entry=pending.get(key)
  const headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Type':'text/plain; charset=utf-8'}
  try{
    if(req.method!=='GET'||!entry||entry.until<Date.now())throw failure('This sign-in link expired. Connect again in Spur.')
    const cookie='spur_meta_'+key.slice(0,16)
    const flags='; Path=/api/meta-login; HttpOnly; SameSite=Lax'+(entry.callback.startsWith('https:')?'; Secure':'')
    if(authorize){
      if(entry.browser)throw failure('This sign-in link has already been opened.')
      entry.browser=nonce()
      const login=new URL('https://www.facebook.com/'+version+'/dialog/oauth')
      login.search=new URLSearchParams({client_id:entry.config.META_APP_ID,redirect_uri:entry.callback,response_type:'code',state:key,scope:scopes[entry.provider]}).toString()
      const configId=entry.config['META_'+entry.provider.toUpperCase()+'_LOGIN_CONFIG_ID']
      if(configId)login.searchParams.set('config_id',configId)
      res.writeHead(302,{...headers,'Set-Cookie':cookie+'='+entry.browser+'; Max-Age=600'+flags,Location:login.href});return res.end()
    }
    if(!entry.browser || !(req.headers.cookie||'').split(/;\s*/).includes(cookie+'='+entry.browser))throw failure('Complete sign-in in the same browser.')
    pending.delete(key)
    headers['Set-Cookie']=cookie+'=; Max-Age=0'+flags
    if(!url.searchParams.get('code'))throw failure('Meta sign-in was cancelled. You can close this window.')
    await entry.inbox.finish(entry.provider,url.searchParams.get('code'))
    res.writeHead(200,headers);res.end('Connected. Spur is syncing your inbox. You can close this window.')
  }catch(e){res.writeHead(e.status||502,headers);res.end(e.status?e.message:'Could not complete Meta sign-in. Return to Spur and try again.')}
}
