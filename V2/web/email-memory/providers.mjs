import {mkdir,lstat,realpath,readFile,writeFile,rename,unlink} from 'node:fs/promises'
import {resolve,join,relative,isAbsolute} from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {createGmailProvider} from './gmail.mjs'
import {createOutlookProvider} from './outlook.mjs'
import {createImapProvider} from './imap.mjs'
import {replacePrivateFile} from './atomic-file.mjs'

const instances=new Map(),singleInstances=new Map(),pending=new Map()
const LABELS={gmail:'Gmail',outlook:'Outlook / Microsoft365',zoho:'Zoho Mail',imap:'Other email (IMAP)'}
const valid=id=>typeof id==='string'&&Object.hasOwn(LABELS,id)
const fail=(message,status=422,code='mail_provider_failed')=>Object.assign(new Error(message),{status,code})
const inside=(root,file)=>{const part=relative(root,file);return !part.startsWith('..')&&!isAbsolute(part)}
const identity=(id,email,host='')=>`${id}_${createHash('sha256').update(`${email}\0${host}`).digest('hex').slice(0,24)}`
const validEmail=value=>typeof value==='string'&&value.length<=320&&/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(value)
const validAccount=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(value)

/** Workspace-local provider selection; concrete providers own all credentials. */
function createSingleMailProvider({root,config={},sources}={}){
  const storageRoot=resolve(root),cached=!sources&&singleInstances.get(storageRoot)
  if(cached){cached.configure(config);return cached}
  let currentConfig=config,selected='gmail',loaded=false,serial=Promise.resolve()
  const concrete=sources||{
    gmail:createGmailProvider({root:storageRoot,config}),outlook:createOutlookProvider({root:storageRoot,config}),
    zoho:createImapProvider({root:join(storageRoot,'zoho'),provider:'zoho'}),imap:createImapProvider({root:join(storageRoot,'imap'),provider:'imap'}),
  }
  const file=join(storageRoot,'provider-selection.json')
  const exclusive=work=>{const next=serial.then(work,work);serial=next.catch(()=>{});return next}
  async function safe(){
    await mkdir(storageRoot,{recursive:true,mode:0o700})
    if((await lstat(storageRoot)).isSymbolicLink())throw fail('Private email provider storage is unavailable.',503)
    const info=await lstat(file).catch(error=>{if(error.code!=='ENOENT')throw error;return null})
    if(info&&(info.isSymbolicLink()||!info.isFile()||info.size>4096||!inside(await realpath(storageRoot),await realpath(file))))throw fail('Private email provider storage is invalid.',503)
    return info
  }
  async function load(){if(loaded)return;const info=await safe();if(info){let value;try{value=JSON.parse(await readFile(file,'utf8'))}catch{throw fail('Private email provider selection could not be read.',503)}if(value.schemaVersion!==1||!valid(value.provider))throw fail('Private email provider selection is invalid.',503);selected=value.provider}loaded=true}
  async function activate(id){await safe();const temporary=join(storageRoot,`.provider-${randomUUID()}.tmp`);try{await writeFile(temporary,JSON.stringify({schemaVersion:1,provider:id}),{flag:'wx',mode:0o600});await replacePrivateFile(temporary,file);selected=id;loaded=true}finally{await unlink(temporary).catch(()=>{})}}
  async function statusFor(id){
    const value=await concrete[id].status()
    return {...value,provider:id,providerLabel:LABELS[id],...(value.connected&&typeof value.email==='string'?{accountId:typeof value.accountId==='string'?value.accountId:identity(id,value.email,value.host)}:{})}
  }
  async function publicStatus(){
    await load();const value=await statusFor(selected),providers=[]
    for(const id of Object.keys(LABELS)){
      const other=id===selected?value:await concrete[id].status().catch(()=>({oauthAvailable:id==='outlook'}))
      providers.push({id,label:LABELS[id],oauthAvailable:other.oauthAvailable===true,...(other.clientIdRequired===true?{clientIdRequired:true}:{}),appPasswordAvailable:id!=='outlook'})
    }
    return {...value,providers}
  }
  const facade={
    configure(value){currentConfig=value||{};for(const source of Object.values(concrete))source.configure?.(currentConfig)},
    status(){return exclusive(publicStatus)},
    connectAppPassword(value={}){return exclusive(async()=>{await load();const id=value.provider||'gmail';if(!valid(id)||id==='outlook')throw fail('Choose a password-based email provider. Outlook uses Microsoft sign-in.');await concrete[id].connectAppPassword(value);await activate(id);return publicStatus()})},
    disconnect(){return exclusive(async()=>{await load();await concrete[selected].disconnect();for(const [key,value]of pending)if(value.facade===facade)pending.delete(key);return publicStatus()})},
    startOAuth(value={}){return exclusive(async()=>{
      await load();const id=value.provider||'gmail';if(!['gmail','outlook'].includes(id))throw fail('Choose Gmail or Outlook for browser sign-in.')
      const result=await concrete[id].startOAuth(value),url=new URL(result.authorizationUrl),state=url.searchParams.get('state')
      if(!state||state.length>256)throw fail('The email provider did not return a valid sign-in state.',502)
      for(const [key,item]of pending)if(item.expiresAt<Date.now()||item.facade===facade&&item.id===id)pending.delete(key)
      pending.set(state,{facade,id,expiresAt:Date.now()+10*60*1000})
      return result
    })},
    finishOAuth(id,params){return exclusive(async()=>{if(!['gmail','outlook'].includes(id))throw fail('Unsupported email sign-in.',400);await concrete[id].finishOAuth(params);await activate(id);return publicStatus()})},
    async scanPage(options){await exclusive(load);const id=selected,source=concrete[id],before=await statusFor(id),page=await source.scanPage(options);return {...page,mailboxAccountId:page.mailboxAccountId||(page.mailboxEmail&&page.mailboxEmail!==before.email?identity(id,page.mailboxEmail,before.host):before.accountId),provider:id,scope:page.scope||before.scope}},
    async getMessage(id){await exclusive(load);const selectedId=selected,source=concrete[selectedId],before=await statusFor(selectedId),message=await source.getMessage(id);return {...message,mailboxAccountId:message.mailboxAccountId||(message.mailboxEmail&&message.mailboxEmail!==before.email?identity(selectedId,message.mailboxEmail,before.host):before.accountId)}},
  }
  if(!sources)singleInstances.set(storageRoot,facade)
  return facade
}

/** Each linked mailbox owns a separate credential slot. Selecting a mailbox
 * changes the view; it never disconnects or mutates another linked account. */
export function createMailProvider({root,config={},sources,singleFactory=createSingleMailProvider}={}){
  const storageRoot=resolve(root),custom=!!sources||singleFactory!==createSingleMailProvider,cached=!custom&&instances.get(storageRoot)
  if(cached){cached.configure(config);return cached}
  const slots=new Map(),file=join(storageRoot,'mailbox-connections.json'),directory=join(storageRoot,'linked-mailboxes')
  let currentConfig=config,loaded=false,selected=null,entries=[],serial=Promise.resolve()
  const exclusive=work=>{const next=serial.then(work,work);serial=next.catch(()=>{});return next}
  const validSlot=id=>id==='legacy'||typeof id==='string'&&/^mailbox-[a-f0-9-]{36}$/.test(id)
  async function safe(){
    await mkdir(storageRoot,{recursive:true,mode:0o700})
    if((await lstat(storageRoot)).isSymbolicLink())throw fail('Private mailbox storage is unavailable.',503)
    await mkdir(directory,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error})
    if((await lstat(directory)).isSymbolicLink()||!inside(await realpath(storageRoot),await realpath(directory)))throw fail('Private mailbox storage is invalid.',503)
    const info=await lstat(file).catch(error=>{if(error.code!=='ENOENT')throw error;return null})
    if(info&&(info.isSymbolicLink()||!info.isFile()||info.size>64*1024))throw fail('The saved mailbox list is invalid.',503)
    return info
  }
  function slot(id){
    if(!validSlot(id))throw fail('Mailbox not found.',404)
    if(!slots.has(id))slots.set(id,singleFactory({root:id==='legacy'?storageRoot:join(directory,id),config:currentConfig,...(id==='legacy'&&sources?{sources}:{})}))
    return slots.get(id)
  }
  async function persist(){
    await safe();const temporary=join(storageRoot,`.mailboxes-${randomUUID()}.tmp`)
    try{await writeFile(temporary,JSON.stringify({schemaVersion:1,selectedMailboxId:selected,mailboxes:entries}),{flag:'wx',mode:0o600});await replacePrivateFile(temporary,file)}finally{await unlink(temporary).catch(()=>{})}
  }
  async function load(){
    if(loaded)return
    const info=await safe()
    if(info){let value;try{value=JSON.parse(await readFile(file,'utf8'))}catch{throw fail('The saved mailbox list could not be read.',503)}
      if(value.schemaVersion!==1||!Array.isArray(value.mailboxes)||value.mailboxes.length>32||value.mailboxes.some(entry=>!validSlot(entry?.id)||!valid(entry.provider)||!validEmail(entry.email)||!validAccount(entry.accountId))||new Set(value.mailboxes.map(entry=>entry.id)).size!==value.mailboxes.length||value.selectedMailboxId!==null&&!value.mailboxes.some(entry=>entry.id===value.selectedMailboxId))throw fail('The saved mailbox list is invalid.',503)
      entries=value.mailboxes.map(entry=>({id:entry.id,provider:entry.provider,email:entry.email,accountId:entry.accountId,providerLabel:typeof entry.providerLabel==='string'?entry.providerLabel.slice(0,100):LABELS[entry.provider]}));selected=value.selectedMailboxId
    }else{
      const legacy=await slot('legacy').status()
      if(legacy.connected&&legacy.email&&legacy.accountId){entries=[{id:'legacy',provider:legacy.provider,email:legacy.email,accountId:legacy.accountId,providerLabel:legacy.providerLabel}];selected='legacy';await persist()}
    }
    loaded=true
  }
  async function view(){
    await load();const current=await slot(selected||'legacy').status(),mailboxes=[]
    for(const entry of entries){const value=entry.id===selected?current:await slot(entry.id).status().catch(()=>({connected:false}));mailboxes.push({...entry,connected:value.connected===true})}
    const metadata=entries.find(entry=>entry.id===selected)
    return {...current,...(!current.connected&&metadata?{provider:metadata.provider,providerLabel:metadata.providerLabel,email:metadata.email,accountId:metadata.accountId}:{}),mailboxes,selectedMailboxId:selected}
  }
  async function register(id,value){
    if(entries.length>=32)throw fail('This workspace supports up to32 linked mailboxes.',507)
    if(!value.connected||!validEmail(value.email)||!validAccount(value.accountId)||!valid(value.provider))throw fail('The email provider did not verify this mailbox.',502)
    const previous=entries,oldSelected=selected
    entries=[...entries,{id,provider:value.provider,providerLabel:value.providerLabel,email:value.email,accountId:value.accountId}];selected=id
    try{await persist()}catch(error){entries=previous;selected=oldSelected;throw error}
    return view()
  }
  const outer={
    configure(value){currentConfig=value||{};for(const source of slots.values())source.configure?.(currentConfig)},
    status(){return exclusive(view)},
    selectMailbox(id){return exclusive(async()=>{await load();if(!entries.some(entry=>entry.id===id))throw fail('Mailbox not found.',404);const previous=selected;selected=id;try{await persist()}catch(error){selected=previous;throw error}return view()})},
    captureMailbox(){return exclusive(async()=>{await load();return slot(selected||'legacy')})},
    connectAppPassword(value={}){return exclusive(async()=>{await load();if(entries.length>=32)throw fail('This workspace supports up to32 linked mailboxes.',507);const id=`mailbox-${randomUUID()}`,source=slot(id);const connected=await source.connectAppPassword(value);return register(id,connected)})},
    startOAuth(value={}){return exclusive(async()=>{
      await load();if(entries.length>=32)throw fail('This workspace supports up to32 linked mailboxes.',507)
      const id=`mailbox-${randomUUID()}`,source=slot(id),result=await source.startOAuth(value),url=new URL(result.authorizationUrl),state=url.searchParams.get('state'),provider=value.provider||'gmail'
      if(!state)throw fail('The email provider did not return a valid sign-in state.',502)
      // Concrete providers validate and consume their own state. The outer
      // completion only links the verified slot to this originating workspace.
      pending.set(state,{id:provider,expiresAt:Date.now()+10*60*1000,complete:params=>exclusive(async()=>register(id,await source.finishOAuth(provider,params)))})
      return result
    })},
    disconnect(mailboxId){return exclusive(async()=>{await load();const id=mailboxId||selected||'legacy';if(id!=='legacy'&&!entries.some(entry=>entry.id===id))throw fail('Mailbox not found.',404);await slot(id).disconnect();return view()})},
    async scanPage(value){const source=await outer.captureMailbox();return source.scanPage(value)},
    async getMessage(id){const source=await outer.captureMailbox();return source.getMessage(id)},
  }
  if(!custom)instances.set(storageRoot,outer)
  return outer
}

/** OAuth state is bound to the workspace/provider that initiated authorization. */
export async function finishMailOAuth(provider,searchParams){
  const state=searchParams.get('state'),item=pending.get(state)
  if(!item||item.id!==provider||item.expiresAt<Date.now())throw fail('This email sign-in expired. Start again from Spur.',400,'mail_invalid_state')
  pending.delete(state)
  return item.complete?item.complete(searchParams):item.facade.finishOAuth(provider,searchParams)
}
