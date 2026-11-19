import {createHash,randomUUID} from 'node:crypto'
import {resolve} from 'node:path'
import {ImapFlow} from 'imapflow'
import {simpleParser} from 'mailparser'
import {createCredentialStore} from './credential-store.mjs'
import {resolveImapEndpoint} from './imap-host.mjs'

const instances=new Map(),PAGE_SIZE=100,MAX_TEXT=1024*1024
const fail=(message,status=422,code='imap_request_failed')=>Object.assign(new Error(message),{status,code,mailSafe:true})
const clean=(value,max=500)=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max):''
const address=value=>typeof value==='string'&&value.length<=320&&/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value)?value.toLowerCase():''
const addresses=value=>(Array.isArray(value)?value:[]).map(person=>({email:address(person?.address||person?.email),...(clean(person?.name,160)?{name:clean(person.name,160)}:{})})).filter(person=>person.email).slice(0,200)
const hash=value=>createHash('sha256').update(value).digest('hex').slice(0,24)
const accountId=value=>`${value.provider}_${hash(`${value.email}\0${value.host}`)}`
const generation=value=>hash(`${accountId(value)}\0${value.connectedAt}\0${value.generation||''}`)
const folderId=value=>hash(value)
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url')
function decode(value){try{if(typeof value!=='string'||value.length>16384||!/^[\w-]+$/.test(value))throw Error();return JSON.parse(Buffer.from(value,'base64url').toString('utf8'))}catch{throw fail('The mailbox checkpoint is invalid. Start a new sync.',409,'imap_invalid_cursor')}}
const ZOHO_REGIONS=Object.freeze({us:{personal:'imap.zoho.com',business:'imappro.zoho.com'},eu:{personal:'imap.zoho.eu',business:'imappro.zoho.eu'},in:{personal:'imap.zoho.in',business:'imappro.zoho.in'},au:{personal:'imap.zoho.com.au',business:'imap.zoho.com.au'},jp:{personal:'imap.zoho.jp',business:'imap.zoho.jp'},cn:{personal:'imap.zoho.com.cn',business:'imap.zoho.com.cn'}})
export const zohoRegions=Object.keys(ZOHO_REGIONS)
export function zohoHost({region='us',accountType='auto',email=''}={}){
  if(!Object.hasOwn(ZOHO_REGIONS,region)||!['auto','business','personal'].includes(accountType))throw fail('Choose a supported Zoho region and account type.',422,'imap_settings_invalid')
  const personal=/@(zoho|zohomail)\.(?:com|eu|in|jp|com\.au|com\.cn)$/i.test(email)
  return ZOHO_REGIONS[region][accountType==='auto'?(personal?'personal':'business'):accountType]
}
function safeFailure(error,provider){
  if(error?.mailSafe)return error
  // Inspect upstream diagnostics only to choose a fixed category. Never expose
  // responseText/response, which can contain credentials or account identifiers.
  const code=typeof error?.code==='string'?error.code:''
  const atom=typeof error?.serverResponseCode==='string'?error.serverResponseCode:''
  const detail=[error?.responseText,error?.response,error?.message,atom].filter(value=>typeof value==='string').join(' ').slice(0,16000)
  if(code==='invalid_imap_host')return fail('Use a public email server hostname with verified TLS on port 993.',422,code)
  if(code==='imap_dns_failed'||['ENOTFOUND','EAI_AGAIN'].includes(code))return fail('The email server hostname could not be resolved. Check its region and hostname, then try again.',502,'imap_dns_failed')
  if(['CERT_HAS_EXPIRED','ERR_TLS_CERT_ALTNAME_INVALID','DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(code))return fail('The mail server TLS certificate could not be verified. Check the selected server; certificate verification remains enabled.',502,'imap_tls_failed')
  if(['ETIMEDOUT','CONNECT_TIMEOUT','GREETING_TIMEOUT','SOCKET_TIMEOUT'].includes(code))return fail('The mail server did not respond in time on secure IMAP port 993. Check its server settings and try again.',504,'imap_timeout')
  if(provider==='zoho'){
    if(code==='ETHROTTLE'||/rate.?limit|too many (?:failed |login |sign.?in |authentication )?(?:attempts|connections|requests)|temporarily.*(?:throttl|limit)/i.test(detail))return fail('Zoho temporarily limited sign-in requests. Wait before trying again.',429,'zoho_rate_limited')
    if(/(?:account|user|access).{0,50}(?:blocked|suspended|locked)|(?:blocked|suspended|locked).{0,50}(?:account|user)/i.test(detail))return fail('Zoho blocked or restricted this mailbox sign-in. Check the account security settings or contact your Zoho administrator.',403,'zoho_account_blocked')
    if(/(?:wrong|different|correct|invalid).{0,40}(?:data.?cent(?:er|re)|region)|(?:data.?cent(?:er|re)|region).{0,40}(?:mismatch|incorrect|wrong)|use.{0,40}(?:imap|imappro)\.zoho\./i.test(detail))return fail('Zoho requires the mailbox server for this account’s data centre. Copy its server settings from Zoho Mail and choose the matching region and account type.',422,'zoho_region_mismatch')
    if(/(?:imap|mail client).{0,80}(?:disabled|not enabled|not allowed|not available|not permitted|not supported)|(?:enable|upgrade).{0,50}imap/i.test(detail))return fail('Zoho says IMAP access is disabled or unavailable. Enable IMAP in Zoho Mail settings and confirm the account plan includes IMAP.',409,'zoho_imap_disabled')
    if(/app(?:lication)?[ -]?(?:specific[ -]?)?password.{0,60}(?:required|use|generate)|(?:require|use|generate).{0,60}app(?:lication)?[ -]?(?:specific[ -]?)?password/i.test(detail))return fail('Zoho requires an application-specific password. Create one in Zoho Accounts security settings and enter it in Spur.',401,'zoho_app_password_required')
    if(error?.authenticationFailed||['AUTHENTICATIONFAILED','EAUTH'].includes(code)||/^(?:AUTHENTICATIONFAILED|AUTHORIZATIONFAILED)$/i.test(atom))return fail('Zoho rejected the sign-in. Check your full mailbox address, Zoho app password, data centre and account type.',401,'zoho_auth_required')
  }
  if(error?.authenticationFailed||['AUTHENTICATIONFAILED','EAUTH'].includes(code))return fail('The mail server rejected the sign-in. Check the account, app password and IMAP access setting.',401,'imap_auth_required')
  return fail('The mail server could not be reached securely. Check its settings and try again.',502,'imap_unavailable')
}
function foldersFrom(items){
  if(!Array.isArray(items)||items.length>500)throw fail('The mail server returned too many folders. Sync remains incomplete.',502)
  const selectable=items.filter(item=>typeof item.path==='string'&&item.path.length>0&&item.path.length<=1000&&!/[\u0000\r\n]/.test(item.path)&&![...(item.flags||[])].some(flag=>/^\\(?:Noselect|NonExistent)$/i.test(flag)))
  const excluded=item=>/^\\(?:Junk|Trash|Drafts?)$/i.test(item.specialUse||'')||/(?:^|[\/.])(?:junk(?: e-?mail)?|spam|trash|deleted (?:items|messages)|drafts?)(?:$|[\/.])/i.test(item.path)
  const allowed=selectable.filter(item=>!excluded(item)&&item.specialUse!=='\\All')
  if(!allowed.length&&selectable.some(item=>item.specialUse==='\\All'))throw fail('Only an aggregate All Mail view is exposed. Connect readable Inbox and Sent folders so excluded folders can be kept out of this sync.',409,'imap_folders_unavailable')
  return allowed.sort((a,b)=>a.path.localeCompare(b.path)).map(item=>({path:item.path,id:folderId(item.path)}))
}
function metadata(record,folder,validity){
  const envelope=record.envelope||{},date=new Date(record.internalDate||envelope.date||''),labels=[...new Set([...Array.from(record.flags||[]),...(Array.from(record.labels||[])),folder.path])].map(String).slice(0,50)
  return {id:`im_${folder.id}_${validity}_${record.uid}`,threadId:`im_${folder.id}_${validity}_${record.uid}`,from:addresses(envelope.from)[0]||{email:''},to:addresses(envelope.to),cc:addresses(envelope.cc),subject:clean(envelope.subject,500)||'(No subject)',...(Number.isNaN(date.valueOf())?{}:{date:date.toISOString()}),labels,...(envelope.messageId?{internetMessageId:clean(envelope.messageId,500)}:{})}
}

/** Shared read-only IMAP source. Custom server addresses are resolved and pinned. */
export function createImapProvider({root,provider='imap',credentials,imapFactory,lookupImpl}={}){
  if(!['imap','zoho'].includes(provider))throw fail('Choose a supported mail provider.')
  const key=resolve(root),custom=!!(credentials||imapFactory||lookupImpl),cacheKey=key+'\0'+provider
  if(!custom&&instances.has(cacheKey))return instances.get(cacheKey)
  const store=credentials||createCredentialStore({root:key}),label=provider==='zoho'?'Zoho Mail':'Other email (IMAP)',scope='Available mail folders, including sent and archive; excludes Junk, Trash and Drafts'
  let serial=Promise.resolve(),uidIndex
  const exclusive=work=>{const next=serial.then(work,work);serial=next.catch(()=>{});return next}
  async function credential(){const value=await store.get();if(value?.provider!==provider||!address(value.email)||typeof value.host!=='string'||typeof value.password!=='string')throw fail('Connect this email account before syncing.',401,'imap_auth_required');return value}
  async function withClient(value,work,signal){
    if(signal?.aborted)throw fail('Email sync was cancelled.',499,'imap_cancelled')
    let client
    const abort=()=>client?.close()
    signal?.addEventListener('abort',abort,{once:true})
    try{
      const endpoint=await resolveImapEndpoint({host:value.host,port:993,lookupImpl})
      const options={...endpoint,auth:{user:value.email,pass:value.password},logger:false,disableAutoIdle:true,connectionTimeout:20000,greetingTimeout:15000,socketTimeout:30000,maxIdleTime:30000}
      client=imapFactory?imapFactory(options):new ImapFlow(options);client.on?.('error',()=>{})
      if(signal?.aborted)throw fail('Email sync was cancelled.',499,'imap_cancelled')
      await client.connect();return await work(client)
    }catch(error){if(signal?.aborted)throw fail('Email sync was cancelled.',499,'imap_cancelled');throw safeFailure(error,provider)}
    finally{signal?.removeEventListener('abort',abort);if(client)await client.logout().catch(()=>client.close())}
  }
  const result={
    async status(){const value=await store.get(),connected=value?.provider===provider&&!!address(value.email);return {connected,provider,providerLabel:label,oauthAvailable:false,appPasswordAvailable:true,scope,credentialStorage:store.storage,...(connected?{email:value.email,host:value.host,method:`${provider}_imap`,accountId:accountId(value)}:{}),message:connected?'Email is connected for read-only syncing.':'Connect your email account using its IMAP settings and an app password.'}},
    connectAppPassword(value={}){return exclusive(async()=>{
      const email=address(value.email?.trim()),password=typeof value.appPassword==='string'?value.appPassword.trim():''
      if(!email||password.length<8||password.length>2048||/[\u0000-\u001f\u007f]/.test(password)||value.port!==undefined&&value.port!==993)throw fail('Enter a valid email address, app password and secure IMAP port 993.',422,'imap_settings_invalid')
      const host=provider==='zoho'?zohoHost({...value,email}):typeof value.host==='string'?value.host.trim().toLowerCase():''
      const next={provider,email,password,host,generation:randomUUID(),connectedAt:new Date().toISOString(),...(provider==='zoho'?{region:value.region||'us',accountType:value.accountType||'auto'}:{})}
      await withClient(next,async client=>{if(!foldersFrom(await client.list()).length)throw fail('No readable mail folders were exposed by this account.',409,'imap_folders_unavailable')})
      await store.set(next);uidIndex=undefined;return result.status()
    })},
    disconnect(){return exclusive(async()=>{await store.clear();uidIndex=undefined;return result.status()})},
    async startOAuth(){throw fail('This provider connects with IMAP settings and an app password.',503,'oauth_unavailable')},
    async scanPage({cursor,signal}={}){
      const value=await credential(),checkpoint=cursor?decode(cursor):null,key=generation(value)
      if(checkpoint&&(checkpoint.account!==key||typeof checkpoint.folderVersion!=='string'||!Number.isInteger(checkpoint.index)||checkpoint.index<0))throw fail('The email account or mailbox checkpoint changed. Start sync again.',409,'imap_account_changed')
      return withClient(value,async client=>{
        const folders=foldersFrom(await client.list()),folderVersion=hash(folders.map(folder=>folder.path).join('\0'))
        if(checkpoint&&(checkpoint.folderVersion!==folderVersion||checkpoint.index>=folders.length))throw fail('The available mail folders changed. Start a new sync.',409,'imap_invalid_cursor')
        const index=checkpoint?.index||0
        if(!folders.length)return {messages:[],hasNextPage:false,mailboxEmail:value.email,mailboxAccountId:accountId(value)}
        const folder=folders[index],lock=await client.getMailboxLock(folder.path,{readOnly:true,acquireTimeout:15000})
        try{
          const validity=String(client.mailbox.uidValidity),max=checkpoint?.max??Number(client.mailbox.uidNext)-1,next=checkpoint?.next??1
          if(!/^\d{1,30}$/.test(validity)||!Number.isSafeInteger(max)||max<0||!Number.isSafeInteger(next)||next<1||checkpoint?.validity&&checkpoint.validity!==validity)throw fail('The mail server rebuilt this folder. Start a new sync.',409,'imap_invalid_cursor')
          const indexKey=`${key}:${folder.id}:${validity}:${max}`
          if(next<=max&&(!uidIndex||uidIndex.key!==indexKey||next<uidIndex.start||uidIndex.more&&next>uidIndex.last)){
            const found=await client.search({uid:`${next}:${max}`},{uid:true})
            if(!Array.isArray(found))throw fail('The mail server did not return a valid folder index.',502)
            const sorted=found.filter(uid=>Number.isSafeInteger(uid)&&uid>=next&&uid<=max).sort((a,b)=>a-b),uids=[...new Set(sorted)].slice(0,100001)
            uidIndex={key:indexKey,start:next,last:uids.at(-1)||0,uids,more:sorted.length>100001}
          }
          const remaining=next<=max?(uidIndex?.uids||[]).filter(uid=>uid>=next):[],selected=remaining.slice(0,PAGE_SIZE),selectedSet=new Set(selected),messages=[]
          if(selected.length)for await(const record of client.fetch(selected.join(','),{uid:true,envelope:true,internalDate:true,flags:true},{uid:true})){if(!selectedSet.has(record.uid)||Array.from(record.flags||[]).some(flag=>/^\\Draft$/i.test(flag)))continue;messages.push(metadata(record,folder,validity))}
          const sameFolder=selected.length>0&&(remaining.length>selected.length||!!uidIndex?.more),hasNextPage=sameFolder||index+1<folders.length
          const nextState=sameFolder?{account:key,folderVersion,index,validity,max,next:selected.at(-1)+1}:{account:key,folderVersion,index:index+1}
          return {messages,hasNextPage,...(hasNextPage?{nextCursor:encode(nextState)}:{}),mailboxEmail:value.email,mailboxAccountId:accountId(value),scope}
        }finally{lock.release()}
      },signal)
    },
    async getMessage(id){
      const match=typeof id==='string'&&id.match(/^im_([a-f0-9]{24})_(\d{1,30})_(\d{1,15})$/)
      if(!match)throw fail('This email identifier is invalid.',400)
      const value=await credential()
      return withClient(value,async client=>{
        const folder=foldersFrom(await client.list()).find(folder=>folder.id===match[1])
        if(!folder)throw fail('This email folder is no longer available. Sync again.',404)
        const lock=await client.getMailboxLock(folder.path,{readOnly:true,acquireTimeout:15000})
        try{
          if(String(client.mailbox.uidValidity)!==match[2])throw fail('This email index changed. Sync again to open its current copy.',409,'imap_invalid_cursor')
          const record=await client.fetchOne(match[3],{uid:true,envelope:true,internalDate:true,flags:true,bodyStructure:true},{uid:true})
          if(!record)throw fail('This email is no longer available.',404)
          const choices=[]
          function inspect(part,depth=0){if(!part||depth>20||part.disposition==='attachment'||part.dispositionParameters?.filename||part.parameters?.name||part.type==='message/rfc822')return;if(['text/plain','text/html'].includes(part.type)&&(!part.part||/^\d+(?:\.\d+)*$/.test(part.part)))choices.push(part);for(const child of (part.childNodes||[]).slice(0,100))inspect(child,depth+1)}
          inspect(record.bodyStructure)
          const part=choices.find(part=>part.type==='text/plain')||choices[0]
          if(!part)return {...metadata(record,folder,match[2]),text:'This email has no text preview. Open it in your mail app to view its content.',bodyTruncated:false,attachmentsOmitted:true,mailboxEmail:value.email,mailboxAccountId:accountId(value)}
          const download=await client.download(match[3],part.part||'1',{uid:true,maxBytes:MAX_TEXT,chunkSize:65536})
          if(!download.content||download.meta?.filename||!['text/plain','text/html'].includes(download.meta?.contentType)){download.content?.destroy();throw fail('The mail server did not provide a safe text preview.',502)}
          const chunks=[];let bytes=0,truncated=Number(part.size)>MAX_TEXT
          for await(const chunk of download.content){bytes+=chunk.length;if(bytes>MAX_TEXT){truncated=true;download.content.destroy();break}chunks.push(Buffer.from(chunk))}
          const content=Buffer.concat(chunks),charset=download.meta?.charset||part.parameters?.charset||'utf-8'
          let text;try{text=new TextDecoder(charset).decode(content)}catch{text=content.toString('utf8')}
          if(part.type==='text/html'){const parsed=await simpleParser(Buffer.from('Content-Type: text/html; charset=utf-8\r\n\r\n'+text),{skipTextToHtml:true,skipImageLinks:true,maxHtmlLengthToParse:MAX_TEXT});text=parsed.text||''}
          return {...metadata(record,folder,match[2]),text:text.slice(0,64000),bodyTruncated:truncated||text.length>64000,attachmentsOmitted:true,mailboxEmail:value.email,mailboxAccountId:accountId(value)}
        }finally{lock.release()}
      })
    },
  }
  if(!custom)instances.set(cacheKey,result)
  return result
}
