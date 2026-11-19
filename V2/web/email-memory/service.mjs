import {mkdir,lstat,realpath,readFile,writeFile,rename,unlink,readdir,stat} from 'node:fs/promises'
import {resolve,join,relative,isAbsolute} from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {createMailProvider} from './providers.mjs'
import {replacePrivateFile} from './atomic-file.mjs'
import {emailAddress,messageId,normalizeMessage,messageParticipants,buildEmailGraph,countEmailPeople,isDraftMessage} from './graph.mjs'
import {normalizeContactProfile,relationshipLabels} from './relationships.mjs'

export const EMAIL_MEMORY_LIMITS=Object.freeze({maxMessages:100000,maxStorageBytes:100*1024*1024,maxRunMs:10*60*1000,maxPagesPerRun:2000,maxTotalPages:10000,maxBodyCharacters:128*1024,maxGraphNodes:300})
export class EmailMemoryError extends Error{constructor(message,status=422,code='email_memory_failed'){super(message);this.status=status;this.code=code}}
const fail=(message,status=422,code)=>new EmailMemoryError(message,status,code)
const inside=(root,file)=>{const part=relative(root,file);return !part.startsWith('..')&&!isAbsolute(part)}
const clone=value=>JSON.parse(JSON.stringify(value))
const now=()=>new Date().toISOString()
const services=new Map(),queue=[]
let active=false
const waiters=new Set()
async function drain(){if(active)return;active=true;try{while(queue.length){try{await queue.shift()()}catch{}}}finally{active=false;for(const done of waiters)done();waiters.clear()}}
export function waitForEmailMemoryIdle(){return !active&&!queue.length?Promise.resolve():new Promise(done=>waiters.add(done))}
const safeProviderError=error=>error?.status===429?'The email provider temporarily limited requests. Saved messages are available; resume later.':[401,403].includes(error?.status)?'This email account needs a fresh connection. Saved messages are available; reconnect to continue.':'The email provider could not finish this request. Saved messages are available; try again.'
// Only application-defined codes select public guidance. Never forward an IMAP
// response, exception message, credentials or connection diagnostics verbatim.
const CONNECTION_FAILURES=Object.freeze({
  imap_auth_required:[401,'The mail server rejected the sign-in. Check the email address and app password, and enable IMAP access in the account settings.'],
  imap_unavailable:[502,'The mail server could not be reached securely. Check the server address and region, then try again.'],
  imap_folders_unavailable:[409,'Sign-in reached the mail server, but no supported readable folders were exposed. Enable IMAP access and make Inbox and Sent available to email clients.'],
  invalid_imap_host:[422,'Use a public email server hostname with verified TLS on port 993. Check the incoming IMAP server address from your provider.'],
  imap_settings_invalid:[422,'Check the email address, app password, incoming server and secure IMAP port 993.'],
  imap_tls_failed:[502,'The mail server could not establish a verified secure connection. Check the incoming server address and region.'],
  imap_timeout:[504,'The mail server did not respond in time. Check the incoming server address and try again.'],
  imap_dns_failed:[502,'The mail server hostname could not be resolved. Check the incoming server address, region and internet connection.'],
  imap_rate_limited:[429,'The mail server temporarily limited sign-in requests. Wait before trying again.'],
  zoho_auth_required:[401,'Zoho rejected the sign-in. Check the complete email address and regional server. If two-factor authentication is enabled, use a Zoho app password.'],
  zoho_imap_disabled:[409,'Zoho did not allow IMAP access. Enable IMAP in Zoho Mail settings and check that your plan or organization allows email-client access.'],
  zoho_app_password_required:[401,'Zoho requires an application-specific password for this account. Create one in Zoho Accounts security settings and use it instead of your regular password.'],
  zoho_rate_limited:[429,'Zoho temporarily limited sign-in requests. Wait before trying again; repeated attempts can extend the limit.'],
  zoho_account_blocked:[403,'Zoho blocked IMAP sign-in for this account. Check the account security settings and your organization’s email-client access policy.'],
  zoho_region_mismatch:[422,'The selected Zoho server does not match this account’s region. Choose the region shown in your Zoho Mail web address and reconnect.'],
  gmail_auth_required:[401,'Gmail rejected the sign-in. Use a Google app password with 2-Step Verification, or reconnect with Google.'],
  gmail_permission_required:[403,'Google did not allow Gmail read access. Enable the Gmail API and reconnect with read-only Gmail permission.'],
  gmail_all_mail_unavailable:[409,'Gmail All Mail is not available through IMAP. Make All Mail visible in Gmail’s IMAP settings, then reconnect.'],
  gmail_unavailable:[502,'Gmail could not be reached. Check your connection and try again.'],
  gmail_rate_limited:[429,'Google temporarily limited sign-in requests. Wait before trying again.'],
  gmail_storage_unavailable:[503,'The private email connection could not be saved or opened. Check this computer’s private storage and reconnect.'],
  gmail_oauth_unconfigured:[503,'Google sign-in has not been configured for this Spur installation. The Spur owner can reuse an existing Google app registration; each mailbox only needs to sign in and approve access.'],
  outlook_auth_required:[401,'The Microsoft connection expired or could not sign in. Reconnect through Microsoft.'],
  outlook_permission_required:[403,'Microsoft did not allow read-only mail access. Check the application’s Mail.Read permission and reconnect.'],
  outlook_unavailable:[502,'Microsoft could not be reached. Check your connection and try again.'],
  outlook_rate_limited:[429,'Microsoft temporarily limited sign-in requests. Wait before trying again.'],
  outlook_storage_unavailable:[503,'The private Microsoft connection could not be saved or opened. Check this computer’s private storage and reconnect.'],
  outlook_client_required:[422,'Enter your registered Microsoft application client ID to continue.'],
})
function connectionFailure(error,{oauth=false}={}){
  const known=typeof error?.code==='string'&&Object.hasOwn(CONNECTION_FAILURES,error.code)?CONNECTION_FAILURES[error.code]:null
  if(known)return fail(known[1],known[0],error.code)
  if(error?.status===429)return fail('The email provider temporarily limited connection requests. Wait before trying again.',429,'email_rate_limited')
  return oauth?fail('Browser sign-in could not start. Check the selected provider and public application ID, or use its supported app-password connection.',503,'oauth_unavailable'):fail('The email connection could not be verified. Check the provider, email address, app password and server settings.',422,'email_connection_failed')
}
const validProvider=value=>['gmail','outlook','zoho','imap'].includes(value)?value:'gmail'
const publicConnection=value=>({connected:value?.connected===true,provider:validProvider(value?.provider),providerLabel:typeof value?.providerLabel==='string'?value.providerLabel.slice(0,100):'Gmail',...(emailAddress(value?.email)?{email:emailAddress(value.email)}:{}),...(typeof value?.accountId==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(value.accountId)?{accountId:value.accountId}:{}),oauthAvailable:value?.oauthAvailable===true,clientIdRequired:value?.clientIdRequired===true,...(typeof value?.method==='string'?{method:value.method.slice(0,50)}:{}),scope:typeof value?.scope==='string'?value.scope.slice(0,500):'All Mail (excludes Spam and Trash)',...(typeof value?.credentialStorage==='string'?{credentialStorage:value.credentialStorage.slice(0,100)}:{}),...(typeof value?.message==='string'?{message:value.message.slice(0,500)}:{}),...(Array.isArray(value?.mailboxes)?{mailboxes:value.mailboxes.filter(item=>typeof item?.id==='string'&&emailAddress(item.email)).map(item=>({id:item.id.slice(0,80),email:emailAddress(item.email),accountId:typeof item.accountId==='string'?item.accountId.slice(0,160):'',provider:validProvider(item.provider),providerLabel:typeof item.providerLabel==='string'?item.providerLabel.slice(0,100):item.provider,connected:item.connected===true})),selectedMailboxId:typeof value.selectedMailboxId==='string'?value.selectedMailboxId.slice(0,80):null}:{}),...(Array.isArray(value?.providers)?{providers:value.providers.filter(item=>['gmail','outlook','zoho','imap'].includes(item?.id)).map(item=>({id:item.id,label:typeof item.label==='string'?item.label.slice(0,100):item.id,oauthAvailable:item.oauthAvailable===true,clientIdRequired:item.clientIdRequired===true,appPasswordAvailable:item.appPasswordAvailable===true}))}:{})})
const connectionKey=connection=>connection.provider==='gmail'?connection.email:connection.accountId||`${connection.provider}_${createHash('sha256').update(connection.email||'').digest('hex').slice(0,24)}`
const duplicateKey=message=>message.internetMessageId&&message.from?.email&&message.date?createHash('sha256').update(JSON.stringify([message.internetMessageId,message.from.email,message.subject,message.date])).digest('hex'):null

export function createEmailMemoryService({root,config={},provider}={}){
  if(typeof root!=='string'||!root.trim())throw fail('Private memory storage is unavailable.',503)
  const storageRoot=resolve(root),cached=services.get(storageRoot)
  if(cached){cached.configure({config,provider});return cached}
  let currentProvider=provider||createMailProvider({root:storageRoot,config}),serial=Promise.resolve(),loaded=false,activeEmail=null,activeAccountKey=null,controller=null
  const pendingSyncs=new Set()
  const accounts=new Map(),registry=join(storageRoot,'mailboxes.json')
  const exclusive=work=>{const result=serial.then(work,work);serial=result.catch(()=>{});return result}
  const filename=email=>join(storageRoot,`mailbox-${createHash('sha256').update(email).digest('hex').slice(0,32)}.json`)
  async function checkFile(file,max=EMAIL_MEMORY_LIMITS.maxStorageBytes){
    const info=await lstat(file).catch(error=>{if(error.code!=='ENOENT')throw error;return null})
    if(info&&(info.isSymbolicLink()||!info.isFile()||info.size>max||!inside(await realpath(storageRoot),await realpath(file))))throw fail('Private memory storage is invalid. Existing files were preserved.',503,'storage_unavailable')
    return info
  }
  async function storageBytes(directory){let size=0;for(const entry of await readdir(directory,{withFileTypes:true})){if(entry.isSymbolicLink())throw fail('Private memory storage contains an unsupported symbolic link.',503);const path=join(directory,entry.name);if(entry.isDirectory())size+=await storageBytes(path);else if(entry.isFile())size+=(await stat(path)).size}return size}
  async function atomic(file,value){
    const previous=await checkFile(file),text=JSON.stringify(value),bytes=Buffer.byteLength(text)
    if(bytes>EMAIL_MEMORY_LIMITS.maxStorageBytes||await storageBytes(storageRoot)-(previous?.size||0)+bytes>EMAIL_MEMORY_LIMITS.maxStorageBytes)throw fail('The email memory cache reached its 100 MiB limit. Saved messages are preserved; coverage is incomplete.',507,'storage_full')
    const temporary=join(storageRoot,`.memory-${randomUUID()}.tmp`)
    try{await writeFile(temporary,text,{flag:'wx',mode:0o600});await replacePrivateFile(temporary,file)}finally{await unlink(temporary).catch(()=>{})}
  }
  async function initialize(){
    if(loaded)return
    await mkdir(storageRoot,{recursive:true,mode:0o700})
    const info=await lstat(storageRoot)
    if(info.isSymbolicLink()||!info.isDirectory())throw fail('Private memory storage is unavailable.',503)
    if(await checkFile(registry,16*1024)){
      let value;try{value=JSON.parse(await readFile(registry,'utf8'))}catch{throw fail('Private memory storage could not be read. Existing files were preserved.',503)}
      if(value.schemaVersion!==1||value.activeEmail!==null&&!emailAddress(value.activeEmail))throw fail('Private memory storage could not be read. Existing files were preserved.',503)
      activeEmail=value.activeEmail
      activeAccountKey=typeof value.activeAccountKey==='string'&&value.activeAccountKey.length<=500?value.activeAccountKey:value.activeEmail
    }
    loaded=true
  }
  async function account(key,email,connection){
    if(accounts.has(key))return accounts.get(key)
    let record={schemaVersion:2,key,email:email||emailAddress(key),accountId:connection?.accountId||key,provider:connection?.provider||'gmail',scope:connection?.scope||'All Mail (excludes Spam and Trash)',messages:[],sync:{status:'idle',pagesFetched:0,messageCount:0,updatedAt:now()}}
    const file=filename(key)
    if(await checkFile(file)){
      try{
        const value=JSON.parse(await readFile(file,'utf8'))
        if(![1,2].includes(value.schemaVersion)||!emailAddress(value.email)||email&&value.email!==email||value.schemaVersion===2&&value.key!==key||!Array.isArray(value.messages)||value.messages.length>EMAIL_MEMORY_LIMITS.maxMessages||!value.sync||typeof value.sync!=='object')throw Error('invalid')
        record={...record,...(value.schemaVersion===2?{accountId:value.accountId,provider:validProvider(value.provider),scope:typeof value.scope==='string'?value.scope.slice(0,500):record.scope}:{}),email:value.email,messages:[...new Map(value.messages.map(normalizeMessage).filter(Boolean).map(message=>[message.id,message])).values()],sync:value.sync}
        record.profiles=Object.fromEntries(Object.entries(value.profiles||{}).filter(([email])=>emailAddress(email)).map(([email,profile])=>[email,normalizeContactProfile(profile)]))
        if(record.sync.status==='running'){record.sync.status='partial';record.sync.message='Email sync was interrupted by a restart. Resume to continue from the saved page.';record.sync.updatedAt=now()}
      }catch{throw fail('Saved email memory could not be read. Existing files were preserved.',503,'storage_unavailable')}
    }
    if(!emailAddress(record.email))throw fail('The saved mailbox identity is invalid.',503)
    accounts.set(key,record);return record
  }
  async function context(){
    await initialize()
    const connection=publicConnection(await currentProvider.status())
    const hasSelection=connection.email&&(connection.connected||connection.selectedMailboxId)
    const email=hasSelection?connection.email:activeEmail
    const key=hasSelection?connectionKey(connection):activeAccountKey||email
    if(email&&(email!==activeEmail||key!==activeAccountKey)){await atomic(registry,{schemaVersion:1,activeEmail:email,activeAccountKey:key});activeEmail=email;activeAccountKey=key}
    return {connection,record:key?await account(key,email,connection):null}
  }
  function publicSync(record){
    const {nextCursor,cursorHashes,seenIds,...sync}=record?.sync||{status:'idle',pagesFetched:0,updatedAt:now()}
    return {...sync,messageCount:record?.messages.length||0,resumable:!!nextCursor&&sync.status!=='complete'&&!sync.restartRequired}
  }
  function statusValue(connection,record){return {connection,mailboxes:connection.mailboxes||[],selectedMailboxId:connection.selectedMailboxId||null,activeSyncMailboxIds:[...pendingSyncs].map(key=>accounts.get(key)?.accountId).filter(Boolean),sync:publicSync(record),messageCount:record?.messages.length||0,peopleCount:record?countEmailPeople(record.messages,record.email):0,mailboxEmail:record?.email||null,mailboxId:record?.accountId||null,limits:EMAIL_MEMORY_LIMITS}}
  async function save(email,change){return exclusive(async()=>{const current=await account(email),previous=clone(current);try{change(current);current.sync.updatedAt=now();current.sync.messageCount=current.messages.length;await atomic(filename(email),current)}catch(error){accounts.set(email,previous);throw error}return current})}
  async function syncJob(email,workerProvider){
    const started=Date.now();let pages=0,yielded=false
    try{
      for(;;){
        const snapshot=await exclusive(async()=>clone(await account(email)))
        if((snapshot.sync.pagesFetched||0)>=EMAIL_MEMORY_LIMITS.maxTotalPages){await save(email,record=>{record.sync.status='partial';record.sync.message='Sync reached its page safety limit. Saved messages are available; coverage is incomplete.'});return}
        if(pages>=EMAIL_MEMORY_LIMITS.maxPagesPerRun||Date.now()-started>=EMAIL_MEMORY_LIMITS.maxRunMs){await save(email,record=>{record.sync.status='running';record.sync.message='Saved sync progress. Continuing the next batch of emails…'});yielded=true;queue.push(()=>syncJob(email,workerProvider));return}
        const connection=publicConnection(await workerProvider.status())
        if(!connection.connected||connectionKey(connection)!==email)throw fail('Reconnect the same email account to resume this sync.',401)
        controller=new AbortController()
        let timer,page
        try{page=await Promise.race([workerProvider.scanPage({cursor:snapshot.sync.nextCursor,signal:controller.signal}),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(fail('The email provider did not respond in time.',502))},60_000)})])}finally{clearTimeout(timer);controller=null}
        if(!page||!Array.isArray(page.messages)||page.messages.length>1000||typeof page.hasNextPage!=='boolean'||page.mailboxEmail&&emailAddress(page.mailboxEmail)!==snapshot.email||page.mailboxAccountId&&page.mailboxAccountId!==snapshot.accountId)throw fail('The email provider returned different mailbox data. Saved messages were preserved.',502)
        const after=publicConnection(await workerProvider.status())
        if(!after.connected||connectionKey(after)!==email)throw fail('The email connection changed during sync. Reconnect the same account to continue.',401)
        const next=page.nextCursor
        if(page.hasNextPage&&(typeof next!=='string'||!next||next.length>16*1024))throw fail('The email provider did not provide a usable next page.',502)
        const digest=page.hasNextPage?createHash('sha256').update(next).digest('hex'):null
        if(digest&&snapshot.sync.cursorHashes?.includes(digest))throw fail('The email provider repeated a page cursor. Saved messages were preserved.',502)
        let stop=false
        await save(email,record=>{
          const messages=new Map(record.messages.map(message=>[message.id,message])),seen=new Set(record.sync.seenIds||[])
          const copies=['imap','zoho'].includes(record.provider)?new Map(record.messages.map(message=>[duplicateKey(message),message.id]).filter(([key])=>key)):null
          let limited=false
          for(const raw of page.messages){
            const message=normalizeMessage(raw);if(!message)throw fail('The email provider returned an invalid message identifier.',502)
            const key=copies&&duplicateKey(message),existingId=key&&copies.get(key)
            if(existingId&&existingId!==message.id){if(seen.has(existingId)){continue}else messages.delete(existingId)}
            if(!messages.has(message.id)&&messages.size>=EMAIL_MEMORY_LIMITS.maxMessages){limited=true;break}
            messages.set(message.id,message);seen.add(message.id);if(key)copies.set(key,message.id)
          }
          record.messages=[...messages.values()];record.sync.seenIds=[...seen];record.sync.pagesFetched=(record.sync.pagesFetched||0)+1
          if(Number.isSafeInteger(page.estimatedTotal)&&page.estimatedTotal>=0)record.sync.estimatedTotal=page.estimatedTotal
          record.sync.hasNextPage=page.hasNextPage
          if(limited){record.sync.status='partial';record.sync.message='The 100,000-message cache limit was reached. Saved messages are available; coverage is incomplete.';stop=true;return}
          if(!page.hasNextPage){record.messages=record.messages.filter(message=>seen.has(message.id));record.sync.status='complete';record.sync.message='The end of the available mail feed was reached. '+record.scope;record.sync.completedAt=now();delete record.sync.nextCursor;delete record.sync.cursorHashes;delete record.sync.seenIds;stop=true;return}
          record.sync.nextCursor=next;record.sync.cursorHashes=[...(record.sync.cursorHashes||[]),digest];record.sync.status='running';record.sync.message=`Indexed ${record.messages.length.toLocaleString('en-US')} emails. Reading the next page…`
        })
        pages++
        if(stop)return
      }
    }catch(error){await save(email,record=>{record.sync.status=[401,403,429].includes(error.status)?'blocked':record.sync.pagesFetched?'partial':'failed';record.sync.restartRequired=['gmail_invalid_cursor','gmail_account_changed','imap_invalid_cursor','imap_account_changed','outlook_invalid_cursor','outlook_account_changed'].includes(error.code);record.sync.message=record.sync.restartRequired?'The email provider changed its mailbox index or connection. Start sync again to rebuild the checkpoint; saved messages are preserved.':error instanceof EmailMemoryError?error.message:safeProviderError(error)}).catch(()=>{const record=accounts.get(email);if(record){record.sync.status='partial';record.sync.message='Sync paused because its progress could not be saved. Existing emails were preserved.'}})}
    finally{if(!yielded)pendingSyncs.delete(email);controller=null}
  }
  const service={
    configure(next){if(next.provider)currentProvider=next.provider;else if(next.config)currentProvider=createMailProvider({root:storageRoot,config:next.config})},
    memorySnapshot(){return exclusive(async()=>{
      await initialize()
      // Read saved caches without selecting accounts or contacting a mail provider.
      for(const name of await readdir(storageRoot)){
        if(!/^mailbox-[a-f0-9]{32}\.json$/.test(name))continue
        const file=join(storageRoot,name);await checkFile(file)
        const value=JSON.parse(await readFile(file,'utf8')),key=value.schemaVersion===2?value.key:value.email
        if(typeof key!=='string'||filename(key)!==file)throw fail('Saved mailbox identity is invalid.',503)
        await account(key,value.email)
      }
      return clone({accounts:[...accounts.values()].map(record=>({accountId:record.accountId,email:record.email,profiles:record.profiles||{},messages:record.messages,sync:publicSync(record)}))})
    })},
    status(){return exclusive(async()=>{const {connection,record}=await context();return statusValue(connection,record)})},
    graph({query='',relationship='auto'}={}){if(typeof query!=='string'||query.length>300||!(relationship==='auto'||Object.hasOwn(relationshipLabels,relationship)))throw fail('Use a valid contact search and relationship group.',400);return exclusive(async()=>{const {record}=await context();return {...buildEmailGraph(record?.messages||[],record?.email,{query,relationship,profiles:record?.profiles||{}}),accountId:record?.accountId||null,provider:record?.provider||null,...(record?.scope?{scope:record.scope}:{})}})},
    updateContact({email,accountId,relationship='auto',company='',role=''}={}){
      email=emailAddress(email)
      if(!email||typeof accountId!=='string'||!(relationship==='auto'||Object.hasOwn(relationshipLabels,relationship))||typeof company!=='string'||company.length>120||typeof role!=='string'||role.length>200)throw fail('Choose a valid contact group, company and responsibility.',400)
      return exclusive(async()=>{
        const {record}=await context()
        if(!record||record.accountId!==accountId)throw fail('The mailbox changed. Reopen the contact before saving.',409)
        if(email===record.email||!record.messages.some(message=>!isDraftMessage(message)&&messageParticipants(message).some(person=>person.email===email)))throw fail('Contact not found in this mailbox.',404)
        const profiles={...(record.profiles||{}),[email]:normalizeContactProfile({relationship,company,role})}
        await atomic(filename(record.key),{...record,profiles});record.profiles=profiles
        return {profile:profiles[email],accountId:record.accountId}
      })
    },
    messages({person,query='',cursor,limit=50}={}){
      if(person!==undefined&&!emailAddress(person))throw fail('Choose a valid email contact.',400)
      if(typeof query!=='string'||query.length>500)throw fail('Use a shorter email search.',400)
      if(!Number.isSafeInteger(limit)||limit<1||limit>100||cursor!==undefined&&!/^\d{1,8}$/.test(cursor))throw fail('Choose a valid email page.',400)
      return exclusive(async()=>{const {record}=await context(),needle=query.trim().toLocaleLowerCase(),email=person&&emailAddress(person),offset=Number(cursor||0);const matched=(record?.messages||[]).filter(message=>(!email||messageParticipants(message).some(person=>person.email===email))&&(!needle||`${message.subject} ${message.snippet} ${messageParticipants(message).map(person=>`${person.email} ${person.name||''}`).join(' ')}`.toLocaleLowerCase().includes(needle))).sort((a,b)=>(b.date||'').localeCompare(a.date||'')||a.id.localeCompare(b.id));return {messages:clone(matched.slice(offset,offset+limit)),accountId:record?.accountId||null,provider:record?.provider||null,total:matched.length,hasMore:offset+limit<matched.length,...(offset+limit<matched.length?{nextCursor:String(offset+limit)}:{})}})
    },
    async message(id){
      if(!messageId(id))throw fail('Email not found.',404,'not_found')
      const {record,connection,reader}=await exclusive(async()=>{const value=await context();return {...value,reader:currentProvider.captureMailbox?await currentProvider.captureMailbox():currentProvider}})
      const metadata=record?.messages.find(message=>message.id===id)
      if(!metadata)throw fail('Email not found.',404,'not_found')
      if(!connection.connected||connectionKey(connection)!==record.key)throw fail('Reconnect this email account to open the full email. Saved headers remain available.',409,'connection_required')
      const sourceConnection=publicConnection(await reader.status())
      if(!sourceConnection.connected||connectionKey(sourceConnection)!==record.key)throw fail('The selected mailbox changed. Reopen the email from its own account.',409)
      let value;try{value=await reader.getMessage(id)}catch(error){throw fail(safeProviderError(error),[401,403,429].includes(error?.status)?error.status:502)}
      if(value?.mailboxEmail&&emailAddress(value.mailboxEmail)!==record.email||value?.mailboxAccountId&&value.mailboxAccountId!==record.accountId)throw fail('The email connection changed. Reopen this email from the correct account.',409)
      const text=typeof value?.text==='string'?value.text:typeof value?.bodyText==='string'?value.bodyText:''
      return {accountId:record.accountId,provider:record.provider,message:{...clone(metadata),text:text.slice(0,EMAIL_MEMORY_LIMITS.maxBodyCharacters),bodyTruncated:text.length>EMAIL_MEMORY_LIMITS.maxBodyCharacters||value?.bodyTruncated===true}}
    },
    async connect(value){
      if(pendingSyncs.size&&!currentProvider.captureMailbox)throw fail('Wait for the current email sync to finish before changing accounts.',409)
      let connected;try{connected=await currentProvider.connectAppPassword(value)}catch(error){throw connectionFailure(error)}
      await exclusive(context);return publicConnection(connected)
    },
    async disconnect(){const {record,connection}=await exclusive(context);if(record&&pendingSyncs.has(record.key))throw fail('Wait for this mailbox sync to finish before disconnecting.',409);try{return publicConnection(await currentProvider.disconnect(connection.selectedMailboxId))}catch{throw fail('The email connection could not be removed. Try again.',503)}},
    async startOAuth(value={}){if(pendingSyncs.size&&!currentProvider.captureMailbox)throw fail('Wait for the current email sync to finish before changing accounts.',409);try{return await currentProvider.startOAuth(value)}catch(error){throw connectionFailure(error,{oauth:true})}},
    selectMailbox(id){return exclusive(async()=>{if(typeof id!=='string'||id.length>100||!currentProvider.selectMailbox)throw fail('Mailbox switching is unavailable.',404);try{await currentProvider.selectMailbox(id)}catch(error){throw fail(error?.status===404?'Mailbox not found.':'The mailbox could not be selected. Try again.',error?.status===404?404:503)}const {connection,record}=await context();return statusValue(connection,record)})},
    startSync({resume=true}={}){
      if(typeof resume!=='boolean')throw fail('Choose whether to resume email sync.',400)
      return exclusive(async()=>{
        const {record,connection}=await context()
        if(!connection.connected||!connection.email)throw fail('Connect an email account before syncing email memory.',409,'connection_required')
        if(pendingSyncs.has(record.key))return statusValue(connection,record)
        const workerProvider=currentProvider.captureMailbox?await currentProvider.captureMailbox():currentProvider
        const previous=clone(record),continueRun=resume&&record.sync.status!=='complete'&&!record.sync.restartRequired&&(!record.sync.method||record.sync.method===connection.method)
        record.sync={...(continueRun?record.sync:{}),status:'running',method:connection.method,pagesFetched:continueRun?(record.sync.pagesFetched||0):0,messageCount:record.messages.length,startedAt:now(),updatedAt:now(),message:'Waiting to read email…'}
        if(!continueRun)record.sync.seenIds=[]
        delete record.sync.completedAt
        try{await atomic(filename(record.key),record)}catch(error){accounts.set(record.key,previous);throw error}
        pendingSyncs.add(record.key);queue.push(()=>syncJob(record.key,workerProvider));setImmediate(drain)
        return statusValue(connection,record)
      })
    },
    whenIdle:waitForEmailMemoryIdle,
  }
  services.set(storageRoot,service);return service
}
