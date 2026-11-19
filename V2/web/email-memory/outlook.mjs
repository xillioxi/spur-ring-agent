import {createHash,randomBytes} from 'node:crypto'
import {resolve,join} from 'node:path'
import {simpleParser} from 'mailparser'
import {createCredentialStore} from './credential-store.mjs'

const providers=new Map(),pendingOAuth=new Map()
const GRAPH='https://graph.microsoft.com'
const AUTH='https://login.microsoftonline.com/common/oauth2/v2.0'
const CALLBACK='http://127.0.0.1:4173/api/email-memory/outlook/callback'
const SCOPES='offline_access https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read'
const SCOPE_LABEL='Mail folders (excludes Junk, Deleted Items and Drafts)'
const META_FIELDS='id,internetMessageId,conversationId,from,toRecipients,ccRecipients,subject,receivedDateTime,sentDateTime,isDraft,parentFolderId'
const MAX_RESPONSE=4*1024*1024,MAX_BODY=128*1024
const fail=(message,status=422,code='outlook_request_failed')=>Object.assign(new Error(message),{status,code,outlookSafe:true})
const validClientId=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
const clean=(value,max=500)=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max):''
const email=value=>typeof value==='string'&&value.length<=320&&/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(value)?value.toLowerCase():''
const accountKey=value=>createHash('sha256').update(`${value.accountId}\0${value.email}\0${value.connectedAt}`).digest('hex').slice(0,24)
const cursorEncode=value=>Buffer.from(JSON.stringify(value)).toString('base64url')
const rawIdValid=value=>typeof value==='string'&&/^[A-Za-z0-9+/=_-]{1,700}$/.test(value)
const messageId=value=>{if(!rawIdValid(value))throw fail('Outlook returned an invalid message identifier.',502);return 'ms_'+Buffer.from(value).toString('base64url')}
function originalId(value){
  if(typeof value!=='string'||!/^ms_[A-Za-z0-9_-]{1,1021}$/.test(value))throw fail('Choose an indexed Outlook message.',400)
  const original=Buffer.from(value.slice(3),'base64url').toString('utf8')
  if(!rawIdValid(original)||messageId(original)!==value)throw fail('Choose an indexed Outlook message.',400)
  return original
}
function cursorDecode(value){try{if(typeof value!=='string'||value.length>8192||!/^[A-Za-z0-9_-]+$/.test(value))throw Error();const decoded=JSON.parse(Buffer.from(value,'base64url').toString('utf8'));if(!decoded||decoded.version!==1||typeof decoded.account!=='string'||typeof decoded.nextLink!=='string')throw Error();return decoded}catch{throw fail('The Outlook sync checkpoint is invalid. Start a new sync.',409,'outlook_invalid_cursor')}}
function settings(config){const clientId=config.OUTLOOK_CLIENT_ID||config.MICROSOFT_CLIENT_ID;return {clientId:validClientId(clientId)?clientId.toLowerCase():clientId,clientSecret:config.OUTLOOK_CLIENT_SECRET||config.MICROSOFT_CLIENT_SECRET}}
function safeFailure(error){if(error?.outlookSafe)return error;return fail('Outlook could not be reached. Check your connection and try again.',502,'outlook_unavailable')}
function scopeGranted(value){const scopes=typeof value==='string'?value.toLowerCase().split(/\s+/):[];return scopes.includes('mail.read')||scopes.includes('https://graph.microsoft.com/mail.read')}
async function requestJson(url,options={},fetchImpl=fetch){
  if(options.signal?.aborted)throw fail('Outlook sync was cancelled.',499)
  const controller=new AbortController(),abort=()=>controller.abort()
  options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort()
  const timer=setTimeout(abort,30000)
  try{
    const response=await fetchImpl(url,{...options,signal:controller.signal,redirect:'error'})
    if(Number(response.headers.get('content-length'))>MAX_RESPONSE){await response.body?.cancel();throw fail('Outlook returned too much message data.',502)}
    const chunks=[];let size=0
    if(response.body)for await(const part of response.body){size+=part.length;if(size>MAX_RESPONSE)throw fail('Outlook returned too much message data.',502);chunks.push(Buffer.from(part))}
    let data;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{throw fail('Outlook returned an incomplete response. Try again.',502)}
    if(!response.ok||data?.error){
      const code=typeof data?.error==='string'?data.error:data?.error?.code
      if(response.status===401||['invalid_grant','InvalidAuthenticationToken'].includes(code))throw fail('The Outlook connection expired. Reconnect Outlook.',401,'outlook_auth_required')
      if(response.status===429||code==='TooManyRequests')throw fail('Microsoft temporarily limited requests. Saved sync progress can be resumed later.',429,'outlook_rate_limited')
      if(response.status===403||code==='access_denied')throw fail('Microsoft did not permit read-only mail access. Check your app permissions and reconnect Outlook.',403,'outlook_permission_required')
      if(response.status===404)throw fail('This Outlook message or folder is no longer available.',404,'outlook_not_found')
      throw fail('Microsoft could not complete this mail request. Check the app configuration and try again.',502)
    }
    if(!data||typeof data!=='object'||Array.isArray(data))throw fail('Outlook returned invalid mail data.',502)
    return data
  }catch(error){if(controller.signal.aborted)throw fail(options.signal?.aborted?'Outlook sync was cancelled.':'Outlook did not respond in time. Resume sync to continue.',options.signal?.aborted?499:504);throw safeFailure(error)}
  finally{clearTimeout(timer);options.signal?.removeEventListener('abort',abort)}
}

/** A next-page URL is accepted only for the same read-only Graph collection. */
function pageUrl(value,path){
  let url;try{url=new URL(value)}catch{throw fail('Microsoft returned an invalid page checkpoint.',502,'outlook_invalid_cursor')}
  if(url.protocol!=='https:'||url.hostname!=='graph.microsoft.com'||url.port&&url.port!=='443'||url.username||url.password||url.hash||url.pathname!==path||url.href.length>4096)throw fail('Microsoft returned an unsupported page checkpoint.',502,'outlook_invalid_cursor')
  const allowed=new Set(['$top','$select','$skip','$skiptoken','$count','$orderby','$filter'])
  const seen=new Set()
  for(const [key]of url.searchParams){if(!allowed.has(key)||seen.has(key))throw fail('Microsoft returned an unsupported page checkpoint.',502,'outlook_invalid_cursor');seen.add(key)}
  if(path==='/v1.0/me/messages'){
    const selected=url.searchParams.get('$select')
    if(!selected||selected.split(',').some(field=>!META_FIELDS.split(',').includes(field)))throw fail('Microsoft returned a page outside the metadata-only sync scope.',502,'outlook_invalid_cursor')
  }
  return url
}
function participant(value){const source=value?.emailAddress||value,address=email(source?.address||source?.email);return address?{email:address,...(clean(source.name,160)?{name:clean(source.name,160)}:{})}:null}
const recipients=values=>(Array.isArray(values)?values:[]).slice(0,500).map(participant).filter(Boolean)
function metadata(record){
  const id=messageId(record?.id),date=new Date(record.receivedDateTime||record.sentDateTime||'')
  return {id,...(rawIdValid(record.conversationId)?{threadId:messageId(record.conversationId)}:{}),from:participant(record.from)||{email:''},to:recipients(record.toRecipients),cc:recipients(record.ccRecipients),subject:clean(record.subject,1000)||'(No subject)',...(Number.isNaN(date.valueOf())?{}:{date:date.toISOString()}),labels:record.isDraft?['DRAFT']:[],...(clean(record.internetMessageId,500)?{internetMessageId:clean(record.internetMessageId,500)}:{})}
}

export function createOutlookProvider({root,config={},credentials,fetchImpl=fetch}={}){
  const key=resolve(root),custom=!!credentials||fetchImpl!==fetch
  if(!custom&&providers.has(key)){const existing=providers.get(key);existing.configure(config);return existing}
  const store=credentials||createCredentialStore({root:join(key,'outlook')})
  let currentConfig=config,serial=Promise.resolve(),excludedCache
  const exclusive=work=>{const pending=serial.then(work,work);serial=pending.catch(()=>{});return pending}
  async function credential(){
    let value;try{value=await store.get()}catch{throw fail('The private Outlook connection could not be opened. Reconnect Outlook.',503,'outlook_storage_unavailable')}
    if(value?.method!=='outlook_oauth'||!email(value.email)||typeof value.accountId!=='string')throw fail('Connect Outlook to build your email network.',401,'outlook_auth_required')
    return value
  }
  async function tokenFor(value){
    if(typeof value.accessToken==='string'&&value.expiresAt>Date.now()+60000)return value.accessToken
    return exclusive(async()=>{
      const current=await credential()
      if(accountKey(current)!==accountKey(value))throw fail('The Outlook connection changed. Start a new sync.',409,'outlook_account_changed')
      if(current.accessToken&&current.expiresAt>Date.now()+60000)return current.accessToken
      if(!validClientId(current.clientId)||typeof current.refreshToken!=='string')throw fail('Reconnect Outlook to renew mail access.',401,'outlook_auth_required')
      const configured=settings(currentConfig),body={client_id:current.clientId,refresh_token:current.refreshToken,grant_type:'refresh_token',scope:SCOPES}
      if(current.confidential&&configured.clientId===current.clientId&&configured.clientSecret)body.client_secret=configured.clientSecret
      const token=await requestJson(AUTH+'/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(body)},fetchImpl)
      if(typeof token.access_token!=='string'||token.scope&&!scopeGranted(token.scope))throw fail('Microsoft did not renew read-only mail access. Reconnect Outlook.',401,'outlook_auth_required')
      const next={...current,accessToken:token.access_token,expiresAt:Date.now()+(Number(token.expires_in)||3600)*1000,...(typeof token.refresh_token==='string'?{refreshToken:token.refresh_token}:{})}
      await store.set(next);return token.access_token
    })
  }
  async function graph(url,value,{signal,bodyText=false}={}){
    const target=url instanceof URL?url:new URL(url,GRAPH)
    if(target.protocol!=='https:'||target.hostname!=='graph.microsoft.com'||target.port&&target.port!=='443'||target.username||target.password||target.hash)throw fail('An unsupported Outlook API address was rejected.',502)
    return requestJson(target,{headers:{authorization:`Bearer ${await tokenFor(value)}`,accept:'application/json',prefer:`IdType="ImmutableId"${bodyText?', outlook.body-content-type="text"':''}`},signal},fetchImpl)
  }
  async function excludedFolders(value,signal){
    const key=accountKey(value)
    if(excludedCache?.key===key&&excludedCache.at>Date.now()-5*60*1000)return excludedCache.ids
    const roots=await Promise.all(['junkemail','deleteditems','drafts'].map(name=>graph(`/v1.0/me/mailFolders/${name}?$select=id,childFolderCount`,value,{signal})))
    const ids=new Set(),queue=[]
    for(const folder of roots){if(!rawIdValid(folder.id)||!Number.isSafeInteger(folder.childFolderCount)||folder.childFolderCount<0)throw fail('Outlook did not identify its excluded mail folders. Sync remains incomplete.',502);ids.add(folder.id);if(folder.childFolderCount>0)queue.push(folder.id)}
    let pageCount=0
    while(queue.length){
      const id=queue.shift(),path=`/v1.0/me/mailFolders/${encodeURIComponent(id)}/childFolders`
      let next=new URL(path+'?$select=id,childFolderCount&$top=100',GRAPH)
      const seen=new Set()
      while(next){
        if(++pageCount>1000||ids.size>2000)throw fail('Outlook has too many excluded subfolders for this sync budget. Coverage remains incomplete.',507,'outlook_folder_limit')
        if(seen.has(next.href))throw fail('Outlook repeated a folder page checkpoint.',502,'outlook_invalid_cursor')
        seen.add(next.href)
        const data=await graph(next,value,{signal})
        if(!Array.isArray(data.value)||data.value.length>100)throw fail('Outlook returned an invalid folder page. Sync remains incomplete.',502)
        for(const folder of data.value){if(!rawIdValid(folder.id)||!Number.isSafeInteger(folder.childFolderCount)||folder.childFolderCount<0)throw fail('Outlook returned invalid folder metadata.',502);if(!ids.has(folder.id)){ids.add(folder.id);if(ids.size>2000)throw fail('Outlook has too many excluded subfolders for this sync budget. Coverage remains incomplete.',507,'outlook_folder_limit');if(folder.childFolderCount>0)queue.push(folder.id)}}
        next=data['@odata.nextLink']?pageUrl(data['@odata.nextLink'],path):null
      }
    }
    excludedCache={key,ids,at:Date.now()};return ids
  }
  const provider={
    configure(value){currentConfig=value||{}},
    async status(){
      let value;try{value=await store.get()}catch{throw fail('The private Outlook connection could not be opened. Reconnect Outlook.',503,'outlook_storage_unavailable')}
      const configured=validClientId(settings(currentConfig).clientId),connected=value?.method==='outlook_oauth'&&!!email(value.email)
      return {provider:'outlook',providerLabel:'Outlook / Microsoft 365',method:'outlook_oauth',connected,...(connected?{email:value.email,accountId:value.accountId,connectedAt:value.connectedAt}:{}),oauthAvailable:true,configuredOAuth:configured,clientIdRequired:!configured,appPasswordAvailable:false,credentialStorage:store.storage,scope:SCOPE_LABEL,message:connected?'Outlook is connected for read-only mail syncing.':configured?'Sign in with Microsoft to connect your Outlook or Microsoft 365 mailbox.':'Sign in with Microsoft using your own registered application client ID. The application must allow personal and organizational accounts, read-only Mail.Read and User.Read, and the local Outlook callback.'}
    },
    async startOAuth({clientId:provided}={}){
      const configured=settings(currentConfig),selected=provided||configured.clientId,clientId=validClientId(selected)?selected.toLowerCase():selected
      if(!validClientId(clientId))throw fail('Enter your registered Microsoft application client ID to continue.',422,'outlook_client_required')
      if(validClientId(configured.clientId)&&provided&&provided.toLowerCase()!==configured.clientId.toLowerCase())throw fail('This Spur host already has a Microsoft application configured. Use its sign-in button.',409)
      for(const [state,pending]of pendingOAuth)if(pending.expiresAt<Date.now()||pending.provider===provider)pendingOAuth.delete(state)
      const state=randomBytes(32).toString('base64url'),verifier=randomBytes(32).toString('base64url'),clientSecret=configured.clientId===clientId?configured.clientSecret:undefined
      pendingOAuth.set(state,{provider,verifier,clientId,clientSecret,expiresAt:Date.now()+600000})
      const url=new URL(AUTH+'/authorize')
      for(const [key,value]of Object.entries({client_id:clientId,response_type:'code',redirect_uri:CALLBACK,response_mode:'query',scope:SCOPES,state,prompt:'select_account',code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}))url.searchParams.set(key,value)
      return {authorizationUrl:url.href,expiresIn:600}
    },
    finishOAuth(params){return exclusive(async()=>{
      const query=params instanceof URLSearchParams?params:new URLSearchParams(params),pending=pendingOAuth.get(query.get('state'))
      if(!pending||pending.provider!==provider||pending.expiresAt<Date.now())throw fail('This Microsoft sign-in expired. Start again from Spur.',400,'outlook_invalid_state')
      pendingOAuth.delete(query.get('state'))
      if(query.get('error'))throw fail('Microsoft sign-in was cancelled. The previous connection is unchanged.',400,'outlook_oauth_cancelled')
      const code=query.get('code')
      if(typeof code!=='string'||!code||code.length>8192)throw fail('Microsoft did not return a valid authorization code.',400)
      const body={client_id:pending.clientId,code,redirect_uri:CALLBACK,grant_type:'authorization_code',code_verifier:pending.verifier,scope:SCOPES}
      if(pending.clientSecret)body.client_secret=pending.clientSecret
      const token=await requestJson(AUTH+'/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(body)},fetchImpl)
      if(typeof token.access_token!=='string'||typeof token.refresh_token!=='string'||!scopeGranted(token.scope))throw fail('Microsoft did not grant reusable read-only mail access. Reconnect with Mail.Read and offline access.',403,'outlook_permission_required')
      const next={method:'outlook_oauth',accessToken:token.access_token,refreshToken:token.refresh_token,expiresAt:Date.now()+(Number(token.expires_in)||3600)*1000,clientId:pending.clientId,confidential:!!pending.clientSecret,connectedAt:new Date().toISOString()}
      const profile=await graph('/v1.0/me?$select=id,mail,userPrincipalName',next),address=email(profile.mail)||email(profile.userPrincipalName)
      if(typeof profile.id!=='string'||!profile.id||profile.id.length>512||!address)throw fail('Microsoft could not identify the authorized mailbox.',502)
      next.email=address;next.accountId='outlook_'+createHash('sha256').update(profile.id).digest('hex').slice(0,24)
      await store.set(next);excludedCache=undefined;return provider.status()
    })},
    disconnect(){return exclusive(async()=>{await store.clear();excludedCache=undefined;for(const [state,pending]of pendingOAuth)if(pending.provider===provider)pendingOAuth.delete(state);return provider.status()})},
    async scanPage({cursor,signal}={}){
      const value=await credential(),checkpoint=cursor?cursorDecode(cursor):null,account=accountKey(value)
      if(checkpoint&&checkpoint.account!==account)throw fail('The Outlook account changed. Start a new mail sync.',409,'outlook_account_changed')
      const url=checkpoint?pageUrl(checkpoint.nextLink,'/v1.0/me/messages'):new URL(`/v1.0/me/messages?$top=100&$select=${META_FIELDS}`,GRAPH)
      const excluded=await excludedFolders(value,signal),data=await graph(url,value,{signal})
      if(!Array.isArray(data.value)||data.value.length>100)throw fail('Outlook returned an invalid message page. Sync remains incomplete.',502)
      for(const item of data.value)if(typeof item.parentFolderId!=='string'||typeof item.isDraft!=='boolean')throw fail('Outlook omitted folder or draft information. Sync remains incomplete.',502)
      const messages=data.value.filter(item=>!item.isDraft&&!excluded.has(item.parentFolderId)).map(metadata),next=data['@odata.nextLink']
      let nextLink
      if(next!==undefined){nextLink=pageUrl(next,'/v1.0/me/messages').href;if(nextLink===url.href)throw fail('Outlook repeated a page checkpoint. Resume sync later.',502,'outlook_invalid_cursor')}
      return {messages,hasNextPage:!!nextLink,...(nextLink?{nextCursor:cursorEncode({version:1,account,nextLink})}:{}),mailboxEmail:value.email,accountId:value.accountId,mailboxAccountId:value.accountId,scope:SCOPE_LABEL}
    },
    async getMessage(id){
      const original=originalId(id),value=await credential(),url=new URL(`/v1.0/me/messages/${encodeURIComponent(original)}`,GRAPH)
      url.searchParams.set('$select',META_FIELDS+',body')
      const record=await graph(url,value,{bodyText:true})
      if(record.id!==original)throw fail('Microsoft returned a different message. Reopen it from your mail list.',502)
      let text=typeof record.body?.content==='string'?record.body.content:''
      if(String(record.body?.contentType).toLowerCase()==='html'){
        const parsed=await simpleParser(Buffer.from('Content-Type: text/html; charset=utf-8\r\n\r\n'+text),{skipTextToHtml:true,skipImageLinks:true,maxHtmlLengthToParse:MAX_RESPONSE})
        text=parsed.text||''
      }else if(text&&String(record.body?.contentType).toLowerCase()!=='text')throw fail('Microsoft did not return a supported text preview.',502)
      return {...metadata(record),text:text.slice(0,MAX_BODY),bodyTruncated:text.length>MAX_BODY,attachmentsOmitted:true,mailboxEmail:value.email,accountId:value.accountId,mailboxAccountId:value.accountId}
    },
  }
  if(!custom)providers.set(key,provider)
  return provider
}

export async function finishOutlookOAuth(params){
  const search=params instanceof URLSearchParams?params:new URLSearchParams(params),pending=pendingOAuth.get(search.get('state'))
  if(!pending)throw fail('This Microsoft sign-in expired. Start again from Spur.',400,'outlook_invalid_state')
  return pending.provider.finishOAuth(search)
}
