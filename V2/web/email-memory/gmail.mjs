import {createHash,randomBytes} from 'node:crypto'
import {resolve} from 'node:path'
import {ImapFlow} from 'imapflow'
import {simpleParser} from 'mailparser'
import {createCredentialStore} from './credential-store.mjs'

const providers=new Map(),pendingOAuth=new Map()
const SCOPE='https://www.googleapis.com/auth/gmail.readonly'
const CALLBACK='http://127.0.0.1:4173/api/email-memory/oauth/callback'
const MAIL_SCOPE='Gmail All Mail, including sent and archived mail; excludes Spam and Trash'
const OAUTH_SETUP_MESSAGE='The Spur host owner needs to configure Google sign-in for Gmail. An existing Spur Google OAuth registration can be reused with Gmail read access.'
const MAX_SOURCE=1024*1024,MAX_RESPONSE=4*1024*1024,PAGE_SIZE=100
const fail=(message,status=422,code='gmail_request_failed')=>Object.assign(new Error(message),{status,code,gmailSafe:true})
const clean=(value,max=240)=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,max):''
const email=value=>typeof value==='string'&&value.length<=254&&/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value)?value.toLowerCase():''
const addresses=values=>(Array.isArray(values)?values:[]).flatMap(value=>{const address=email(value?.address||value?.email);return address?[{email:address,...(clean(value.name,160)?{name:clean(value.name,160)}:{})}]:[]}).slice(0,200)
const cursorEncode=value=>Buffer.from(JSON.stringify(value)).toString('base64url')
function cursorDecode(value){try{if(typeof value!=='string'||value.length>4096||!/^[\w-]+$/.test(value))throw Error();return JSON.parse(Buffer.from(value,'base64url').toString('utf8'))}catch{throw fail('The Gmail sync checkpoint is invalid. Start a new sync.',409,'gmail_invalid_cursor')}}
const accountKey=credential=>createHash('sha256').update(`${credential.email}\0${credential.connectedAt}`).digest('hex').slice(0,20)
const abortError=()=>fail('Gmail sync was cancelled.',499,'gmail_cancelled')
function safeFailure(error){
  if(error?.gmailSafe)return error
  if(error?.authenticationFailed||['AUTHENTICATIONFAILED','EAUTH'].includes(error?.code)||/authentication|invalid credentials|application.specific password/i.test(String(error?.responseText||error?.message||'')))return fail('Gmail could not sign in. Use a Google app password with 2-Step Verification, or reconnect with Google.',401,'gmail_auth_required')
  return fail('Gmail could not be reached. Check your connection and try again.',502,'gmail_unavailable')
}
function oauthConfig(config){
  for(const prefix of ['GMAIL','GOOGLE','YOUTUBE']){
    const rawId=config[`${prefix}_CLIENT_ID`],rawSecret=config[`${prefix}_CLIENT_SECRET`]
    const clientId=typeof rawId==='string'?rawId.trim():'',clientSecret=typeof rawSecret==='string'?rawSecret.trim():''
    if(clientId&&clientSecret)return {clientId,clientSecret}
  }
  return {}
}
async function limitedJson(url,options={},fetchImpl=fetch){
  const controller=new AbortController(),abort=()=>controller.abort();options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort()
  const timer=setTimeout(abort,30_000)
  try{
    const response=await fetchImpl(url,{...options,signal:controller.signal,redirect:'error'})
    if(Number(response.headers.get('content-length'))>MAX_RESPONSE){await response.body?.cancel();throw fail('Gmail returned too much message data.',502)}
    const parts=[];let bytes=0
    if(response.body)for await(const part of response.body){bytes+=part.length;if(bytes>MAX_RESPONSE){await response.body.cancel().catch(()=>{});throw fail('Gmail returned too much message data.',502)}parts.push(Buffer.from(part))}
    let value;try{value=JSON.parse(Buffer.concat(parts).toString('utf8'))}catch{throw fail('Gmail returned an incomplete response. Try again.',502)}
    if(!response.ok||value?.error){
      const code=typeof value?.error==='string'?value.error:value?.error?.status
      if(response.status===401||code==='invalid_grant')throw fail('The Gmail connection expired. Reconnect Gmail.',401,'gmail_auth_required')
      if(response.status===429||response.status===403&&/rateLimitExceeded|userRateLimitExceeded/.test(JSON.stringify(value?.error?.errors||[])))throw fail('Gmail temporarily limited requests. Your saved sync progress can be resumed later.',429,'gmail_rate_limited')
      if(response.status===403)throw fail('Google did not permit Gmail read access. Enable the Gmail API and reconnect with the read-only Gmail permission.',403,'gmail_permission_required')
      if(response.status===404)throw fail('This message is no longer available in Gmail.',404,'gmail_message_not_found')
      throw fail('Google could not complete the Gmail request. Try reconnecting.',502)
    }
    return value
  }catch(error){if(controller.signal.aborted)throw options.signal?.aborted?abortError():fail('Gmail did not respond in time. Resume sync to continue.',504);throw safeFailure(error)}
  finally{clearTimeout(timer);options.signal?.removeEventListener('abort',abort)}
}
async function apiMetadata(record){
  const values=new Map((record.payload?.headers||[]).map(item=>[String(item.name).toLowerCase(),item.value]))
  const headers=['From','To','Cc','Subject','Date','Message-ID'].map(name=>`${name}: ${clean(values.get(name.toLowerCase()),8192)}`).join('\r\n')
  const parsed=await simpleParser(Buffer.from(headers+'\r\n\r\n'),{skipHtmlToText:true,skipTextToHtml:true})
  const timestamp=Number(record.internalDate)
  return {id:record.id,threadId:record.threadId,from:addresses(parsed.from?.value)[0]||{email:''},to:addresses(parsed.to?.value),cc:addresses(parsed.cc?.value),subject:clean(parsed.subject,500)||'(No subject)',date:Number.isFinite(timestamp)&&timestamp>0?new Date(timestamp).toISOString():parsed.date instanceof Date&&!Number.isNaN(parsed.date.valueOf())?parsed.date.toISOString():undefined,snippet:clean(record.snippet,500),labels:(record.labelIds||[]).slice(0,50),...(parsed.messageId?{internetMessageId:clean(parsed.messageId,500)}:{})}
}
function imapId(record,validity){
  // Gmail X-GM-MSGID is decimal; the Gmail API uses the equivalent hex value.
  if(typeof record.emailId==='string'&&/^\d{1,30}$/.test(record.emailId))return BigInt(record.emailId).toString(16)
  return `imap:${validity}:${record.uid}`
}
function imapMetadata(record,validity){
  const envelope=record.envelope||{},date=new Date(record.internalDate||envelope.date||'')
  return {id:imapId(record,validity),...(record.threadId?{threadId:/^\d{1,30}$/.test(String(record.threadId))?BigInt(record.threadId).toString(16):String(record.threadId)}:{}),from:addresses(envelope.from)[0]||{email:''},to:addresses(envelope.to),cc:addresses(envelope.cc),subject:clean(envelope.subject,500)||'(No subject)',...(Number.isNaN(date.valueOf())?{}:{date:date.toISOString()}),labels:Array.from(record.labels||[]).map(String).slice(0,50),...(envelope.messageId?{internetMessageId:clean(envelope.messageId,500)}:{})}
}

export function createGmailProvider({root,config={},credentials,imapFactory,fetchImpl=fetch}={}){
  const key=resolve(root),custom=!!(credentials||imapFactory||fetchImpl!==fetch)
  if(!custom&&providers.has(key)){const existing=providers.get(key);existing.configure(config);return existing}
  const store=credentials||createCredentialStore({root:key})
  let currentConfig=config,mutation=Promise.resolve(),uidIndex
  const exclusive=work=>{const result=mutation.then(work,work);mutation=result.catch(()=>{});return result}
  const requireCredential=async()=>{const value=await store.get();if(!value?.email||!['gmail_imap','gmail_oauth'].includes(value.method))throw fail('Connect Gmail to build your email network.',401,'gmail_auth_required');return value}
  async function withImap(credential,work,signal){
    if(signal?.aborted)throw abortError()
    const options={host:'imap.gmail.com',port:993,secure:true,tls:{rejectUnauthorized:true,minVersion:'TLSv1.2'},auth:{user:credential.email,pass:credential.appPassword},logger:false,disableAutoIdle:true,connectionTimeout:20_000,greetingTimeout:15_000,socketTimeout:30_000,maxIdleTime:30_000}
    const client=imapFactory?imapFactory(options):new ImapFlow(options)
    client.on?.('error',()=>{})
    const abort=()=>client.close();signal?.addEventListener('abort',abort,{once:true})
    let lock
    try{
      await client.connect()
      const boxes=await client.list(),box=boxes.find(item=>item.specialUse==='\\All')
      if(!box?.path)throw fail('Gmail All Mail is not available through IMAP. Make All Mail visible in Gmail’s IMAP settings, then reconnect.',409,'gmail_all_mail_unavailable')
      lock=await client.getMailboxLock(box.path,{readOnly:true,acquireTimeout:15000})
      if(signal?.aborted)throw abortError()
      return await work(client,box.path)
    }catch(error){if(signal?.aborted)throw abortError();throw safeFailure(error)}
    finally{signal?.removeEventListener('abort',abort);lock?.release();await client.logout().catch(()=>client.close())}
  }
  async function accessToken(credential){
    if(credential.accessToken&&credential.expiresAt>Date.now()+60000)return credential.accessToken
    return exclusive(async()=>{
      const latest=await requireCredential()
      if(latest.method!=='gmail_oauth'||accountKey(latest)!==accountKey(credential))throw fail('The connected Gmail account changed. Start sync again.',409,'gmail_account_changed')
      if(latest.accessToken&&latest.expiresAt>Date.now()+60000)return latest.accessToken
      const settings=oauthConfig(currentConfig)
      if(!settings.clientId||!settings.clientSecret||!latest.refreshToken)throw fail('Reconnect Gmail with Google to renew read access.',401,'gmail_auth_required')
      const token=await limitedJson('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:settings.clientId,client_secret:settings.clientSecret,refresh_token:latest.refreshToken,grant_type:'refresh_token'})},fetchImpl)
      if(typeof token.access_token!=='string')throw fail('Google did not renew Gmail access. Reconnect Gmail.',401,'gmail_auth_required')
      await store.set({...latest,accessToken:token.access_token,expiresAt:Date.now()+(Number(token.expires_in)||3600)*1000})
      return token.access_token
    })
  }
  async function api(path,credential,signal,query={}){
    const url=new URL('https://gmail.googleapis.com/gmail/v1/users/me'+path)
    for(const [name,value]of Object.entries(query))for(const part of Array.isArray(value)?value:[value])url.searchParams.append(name,String(part))
    return limitedJson(url,{headers:{authorization:`Bearer ${await accessToken(credential)}`,accept:'application/json'},signal},fetchImpl)
  }
  const provider={
    configure(value){currentConfig=value||{}},
    async status(){
      const value=await store.get(),settings=oauthConfig(currentConfig),connected=!!value?.email
      return {connected,...(connected?{email:value.email,method:value.method,connectedAt:value.connectedAt}:{}),oauthAvailable:!!(settings.clientId&&settings.clientSecret),appPasswordAvailable:true,credentialStorage:store.storage,scope:MAIL_SCOPE,message:connected?'Gmail is connected for read-only syncing.':settings.clientId&&settings.clientSecret?'Connect with Google to grant read-only Gmail access.':OAUTH_SETUP_MESSAGE}
    },
    connectAppPassword({email:rawEmail,appPassword}={}){return exclusive(async()=>{
      const account=email(rawEmail?.trim()),password=typeof appPassword==='string'?appPassword.replace(/\s/g,''):''
      if(!account||!/^[a-zA-Z0-9]{16}$/.test(password))throw fail('Enter your Gmail address and Google’s 16-character app password. Use an app password, not your normal account password.')
      const next={method:'gmail_imap',email:account,appPassword:password,connectedAt:new Date().toISOString()}
      await withImap(next,async()=>{})
      await store.set(next)
      return provider.status()
    })},
    disconnect(){return exclusive(async()=>{await store.clear();for(const [state,pending]of pendingOAuth)if(pending.provider===provider)pendingOAuth.delete(state);return provider.status()})},
    async startOAuth(){
      const settings=oauthConfig(currentConfig)
      if(!settings.clientId||!settings.clientSecret)throw fail(OAUTH_SETUP_MESSAGE,503,'gmail_oauth_unconfigured')
      for(const [state,value]of pendingOAuth)if(value.expiresAt<Date.now()||value.provider===provider)pendingOAuth.delete(state)
      const state=randomBytes(32).toString('base64url'),verifier=randomBytes(32).toString('base64url')
      pendingOAuth.set(state,{provider,verifier,expiresAt:Date.now()+10*60*1000})
      const url=new URL('https://accounts.google.com/o/oauth2/v2/auth')
      for(const [name,value]of Object.entries({client_id:settings.clientId,redirect_uri:CALLBACK,response_type:'code',scope:SCOPE,access_type:'offline',prompt:'consent',state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}))url.searchParams.set(name,value)
      return {authorizationUrl:url.href,expiresIn:600}
    },
    finishOAuth(params){return exclusive(async()=>{
      const search=params instanceof URLSearchParams?params:new URLSearchParams(params)
      const state=search.get('state'),pending=typeof state==='string'?pendingOAuth.get(state):null
      if(!pending||pending.provider!==provider||pending.expiresAt<Date.now())throw fail('This Gmail sign-in expired. Start again from Spur.',400,'gmail_invalid_state')
      pendingOAuth.delete(state)
      if(search.get('error'))throw fail('Google sign-in was cancelled. Your previous connection is unchanged.',400,'gmail_oauth_cancelled')
      const code=search.get('code'),settings=oauthConfig(currentConfig)
      if(!code||code.length>4096)throw fail('Google did not return a valid authorization code.',400)
      const token=await limitedJson('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code,client_id:settings.clientId,client_secret:settings.clientSecret,redirect_uri:CALLBACK,grant_type:'authorization_code',code_verifier:pending.verifier})},fetchImpl)
      if(typeof token.access_token!=='string'||typeof token.refresh_token!=='string'||typeof token.scope!=='string'||!token.scope.split(' ').includes(SCOPE))throw fail('Google did not grant reusable read-only Gmail access. Reconnect and allow the requested Gmail permission.',403,'gmail_permission_required')
      const credential={method:'gmail_oauth',email:'pending@invalid.example',accessToken:token.access_token,refreshToken:token.refresh_token,expiresAt:Date.now()+(Number(token.expires_in)||3600)*1000,connectedAt:new Date().toISOString()}
      const profile=await api('/profile',credential)
      const account=email(profile.emailAddress)
      if(!account)throw fail('Google did not identify the authorized Gmail account.',502)
      credential.email=account;await store.set(credential);return provider.status()
    })},
    async scanPage({cursor,signal}={}){
      const credential=await requireCredential(),checkpoint=cursor?cursorDecode(cursor):null,account=accountKey(credential)
      if(checkpoint&&(checkpoint.account!==account||checkpoint.method!==credential.method))throw fail('The Gmail account changed. Start a new mailbox sync.',409,'gmail_account_changed')
      if(credential.method==='gmail_imap')return withImap(credential,async(client)=>{
        const validity=String(client.mailbox.uidValidity),max=checkpoint?.max??Number(client.mailbox.uidNext)-1,next=checkpoint?.next??1
        if(!/^\d+$/.test(validity)||!Number.isSafeInteger(max)||!Number.isSafeInteger(next)||next<1||max<0||checkpoint&&checkpoint.validity!==validity)throw fail('Gmail rebuilt the mailbox index. Start a new sync to refresh its checkpoint.',409,'gmail_invalid_cursor')
        const indexKey=`${account}:${validity}:${max}`
        // Search actual UIDs once per bounded window instead of connecting for
        // every numeric range: deleted messages can leave millions of UID holes.
        if(next<=max&&(!uidIndex||uidIndex.key!==indexKey||next<uidIndex.start||uidIndex.more&&next>uidIndex.last)){
          const found=await client.search({uid:`${next}:${max}`},{uid:true})
          if(!Array.isArray(found))throw fail('Gmail did not return a valid mailbox index. Resume sync later.',502)
          const sorted=found.filter(uid=>Number.isSafeInteger(uid)&&uid>=next&&uid<=max).sort((a,b)=>a-b)
          const uids=[...new Set(sorted)].slice(0,100001)
          uidIndex={key:indexKey,start:next,last:uids.at(-1)||0,uids,more:sorted.length>100001}
        }
        const available=next<=max?(uidIndex?.uids||[]).filter(uid=>uid>=next):[],selected=available.slice(0,PAGE_SIZE),selectedSet=new Set(selected),messages=[]
        if(selected.length)for await(const record of client.fetch(selected.join(','),{uid:true,envelope:true,internalDate:true,size:true,emailId:true,threadId:true,labels:true},{uid:true})){
          if(!selectedSet.has(record.uid))continue
          messages.push(imapMetadata(record,validity))
        }
        const hasNextPage=selected.length>0&&(available.length>selected.length||!!uidIndex?.more)
        return {messages,hasNextPage,...(hasNextPage?{nextCursor:cursorEncode({method:credential.method,account,validity,next:(selected.at(-1)||next)+1,max})}:{}),estimatedTotal:Number(client.mailbox.exists)||0,mailboxEmail:credential.email}
      },signal)
      if(checkpoint?.pageToken!==undefined&&(typeof checkpoint.pageToken!=='string'||checkpoint.pageToken.length>2048))throw fail('The Gmail page checkpoint is invalid.',409,'gmail_invalid_cursor')
      const page=await api('/messages',credential,signal,{maxResults:100,includeSpamTrash:false,...(checkpoint?.pageToken?{pageToken:checkpoint.pageToken}:{})})
      if(page.messages!==undefined&&!Array.isArray(page.messages))throw fail('Gmail returned an invalid message page.',502)
      const listed=page.messages||[],messages=[]
      if(listed.length>100)throw fail('Gmail returned an oversized message page.',502)
      for(let start=0;start<listed.length;start+=4){const values=await Promise.all(listed.slice(start,start+4).map(async item=>{
        if(typeof item.id!=='string'||!(/^[a-f0-9]{1,40}$/i.test(item.id)))throw fail('Gmail returned an invalid message ID.',502)
        return apiMetadata(await api(`/messages/${item.id}`,credential,signal,{format:'metadata',metadataHeaders:['From','To','Cc','Subject','Date','Message-ID']}))
      }));messages.push(...values)}
      if(page.nextPageToken!==undefined&&(typeof page.nextPageToken!=='string'||!page.nextPageToken||page.nextPageToken.length>2048||page.nextPageToken===checkpoint?.pageToken))throw fail('Gmail repeated an invalid page checkpoint. Resume later.',502,'gmail_invalid_cursor')
      return {messages,hasNextPage:!!page.nextPageToken,...(page.nextPageToken?{nextCursor:cursorEncode({method:credential.method,account,pageToken:page.nextPageToken})}:{}),estimatedTotal:Number.isSafeInteger(page.resultSizeEstimate)?page.resultSizeEstimate:undefined,mailboxEmail:credential.email}
    },
    async getMessage(id){
      if(typeof id!=='string'||!(/^[a-f0-9]{1,40}$|^imap:\d{1,30}:\d{1,15}$/i.test(id)))throw fail('This Gmail message ID is invalid.',400)
      const credential=await requireCredential()
      if(credential.method==='gmail_imap')return withImap(credential,async client=>{
        const validity=String(client.mailbox.uidValidity),fallback=id.match(/^imap:(\d+):(\d+)$/)
        if(fallback&&fallback[1]!==validity)throw fail('This message is no longer available. Sync Gmail again.',404,'gmail_message_not_found')
        const uids=fallback?[Number(fallback[2])]:await client.search({emailId:BigInt('0x'+id).toString()},{uid:true})
        if(!uids?.length)throw fail('This message is no longer available in Gmail.',404,'gmail_message_not_found')
        const record=await client.fetchOne(String(uids[0]),{uid:true,envelope:true,internalDate:true,emailId:true,threadId:true,size:true,bodyStructure:true},{uid:true})
        if(!record)throw fail('This message is no longer available in Gmail.',404,'gmail_message_not_found')
        const choices=[]
        function inspect(part,depth=0){
          if(!part||depth>20||part.disposition==='attachment'||part.dispositionParameters?.filename||part.parameters?.name||part.type==='message/rfc822')return
          if(['text/plain','text/html'].includes(part.type)&&(!part.part||/^\d+(?:\.\d+)*$/.test(part.part)))choices.push(part)
          for(const child of (part.childNodes||[]).slice(0,100))inspect(child,depth+1)
        }
        inspect(record.bodyStructure)
        const selected=choices.find(part=>part.type==='text/plain')||choices[0]
        if(!selected)return {...imapMetadata(record,validity),id,text:'This message has no text preview. Open it in Gmail to view its content.',bodyTruncated:false,attachmentsOmitted:true,mailboxEmail:credential.email}
        const download=await client.download(String(uids[0]),selected.part||'1',{uid:true,maxBytes:MAX_SOURCE,chunkSize:64*1024})
        if(!download.content||download.meta?.filename||!['text/plain','text/html'].includes(download.meta?.contentType)){download.content?.destroy();throw fail('Gmail did not provide a safe text preview.',502)}
        const chunks=[];let bytes=0,truncated=Number(selected.size)>MAX_SOURCE
        for await(const chunk of download.content){bytes+=chunk.length;if(bytes>MAX_SOURCE){truncated=true;download.content.destroy();break}chunks.push(Buffer.from(chunk))}
        let text=Buffer.concat(chunks).toString('utf8')
        if(selected.type==='text/html'){const parsed=await simpleParser(Buffer.from('Content-Type: text/html; charset=utf-8\r\n\r\n'+text),{skipTextToHtml:true,skipImageLinks:true,maxHtmlLengthToParse:MAX_SOURCE});text=parsed.text||''}
        return {...imapMetadata(record,validity),id,text:text.slice(0,64000),bodyTruncated:truncated||text.length>64000,attachmentsOmitted:true,mailboxEmail:credential.email}
      })
      if(id.startsWith('imap:'))throw fail('Sync Gmail again after changing the connection method to open this message.',409)
      const metadata=await api(`/messages/${id}`,credential,undefined,{format:'metadata',metadataHeaders:['From','To','Cc','Subject','Date','Message-ID']})
      const base=await apiMetadata(metadata)
      if(Number(metadata.sizeEstimate)>MAX_SOURCE)return {...base,text:'This message is larger than the local preview limit. Open it in Gmail to read the full message.',bodyTruncated:true,attachmentsOmitted:true,mailboxEmail:credential.email}
      const data=await api(`/messages/${id}`,credential,undefined,{format:'full'}),plain=[],html=[]
      function parts(part,depth=0){if(!part||depth>20||part.filename)return;if(part.mimeType==='text/plain'&&part.body?.data)plain.push(Buffer.from(part.body.data,'base64url').toString('utf8'));else if(part.mimeType==='text/html'&&part.body?.data)html.push(Buffer.from(part.body.data,'base64url').toString('utf8'));for(const child of (part.parts||[]).slice(0,100))parts(child,depth+1)}
      parts(data.payload)
      let text=plain.join('\n\n')
      if(!text&&html.length){const parsed=await simpleParser(Buffer.from('Content-Type: text/html; charset=utf-8\r\n\r\n'+html.join('\n')),{skipTextToHtml:true,skipImageLinks:true,maxHtmlLengthToParse:MAX_SOURCE});text=parsed.text||''}
      return {...base,text:text.slice(0,64000),bodyTruncated:text.length>64000,attachmentsOmitted:true,mailboxEmail:credential.email}
    },
  }
  if(!custom)providers.set(key,provider)
  return provider
}

export async function finishGmailOAuth(searchParams){
  const state=searchParams.get('state'),pending=pendingOAuth.get(state)
  if(!pending)throw fail('This Gmail sign-in expired. Start again from Spur.',400,'gmail_invalid_state')
  return pending.provider.finishOAuth(searchParams)
}
