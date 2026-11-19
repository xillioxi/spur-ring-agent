import {resolve} from 'node:path'
import {createHash} from 'node:crypto'
import {privateStore,encryptedSession} from './private-store.mjs'
import {startWhatsApp} from './adapter.mjs'
import {parseWhatsAppExport} from './import.mjs'
const instances=new Map(),groups=['other','friends','family','colleagues','services','company']
const text=(value,max=200)=>typeof value==='string'?value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').trim().slice(0,max):''
const hash=value=>createHash('sha256').update(value).digest('hex')
const validId=value=>typeof value==='string'&&value.length<=300&&(/^[a-zA-Z0-9_.:+-]+@(?:s\.whatsapp\.net|c\.us|lid|g\.us)$/.test(value)||/^export:[a-f0-9]{32}$/.test(value)||value==='imported')
const fail=(message,status=400)=>Object.assign(new Error(message),{status})
function personId(id) {
  if (typeof id !== 'string') return ''
  const match = /^(\d+)(?::\d+)?@(lid|s\.whatsapp\.net|c\.us)$/.exec(id)
  return match ? match[1] + '@' + (match[2] === 'c.us' ? 's.whatsapp.net' : match[2]) : ''
}
function linkContact(account, lid, phone) {
  lid = personId(lid)
  phone = personId(phone)
  if (!lid.endsWith('@lid') || !phone.endsWith('@s.whatsapp.net')) return
  const aliases = account.aliases ||= {}
  for (const id of [lid, phone]) if (aliases[id]) delete aliases[aliases[id]]
  aliases[lid] = phone
  aliases[phone] = lid
}
function nameResolver(account) {
  const profiles = new Map()
  for (const message of account?.messages || []) {
    if (!message.fromMe && message.senderName) profiles.set(message.senderId, message.senderName)
  }
  return rawId => {
    const id = personId(rawId) || rawId
    const alias = account?.aliases?.[id]
    const contact = account?.contacts[id], alternate = account?.contacts[alias]
    const localName = account?.contactNames?.[id] || account?.contactNames?.[alias]
    const names = [contact?.name, alternate?.name, contact?.verifiedName, alternate?.verifiedName, contact?.notify, alternate?.notify,
      profiles.get(id), profiles.get(alias), account?.chats[id]?.name, account?.chats[alias]?.name]
    return localName || names.find(name => name && !/^[+\d\s().-]+(?:@(?:lid|s\.whatsapp\.net|c\.us))?$/.test(name)) || names.find(Boolean) || ''
  }
}
function chatName(chat, resolveName) {
  return (personId(chat.id) && resolveName(chat.id)) || chat.name || resolveName(chat.id) || chat.id.split('@')[0]
}
export function createWhatsAppService({root,adapter=startWhatsApp,session:providedSession}={}) {
  root=resolve(root);if(instances.has(root))return instances.get(root)
  const files=privateStore(root),session=providedSession||encryptedSession(root)
  let data,serial=Promise.resolve(),connection={state:'disconnected'},live,generation=0,pairTimer
  const photoCache = new Map()
  const exclusive=work=>{const next=serial.then(work,work);serial=next.catch(()=>{});return next}
  async function load(){
    if(data)return
    const saved=await files.read('messages.json')
    if(saved&&(saved.schemaVersion!==1||!saved.accounts||typeof saved.accounts!=='object'||Array.isArray(saved.accounts)))throw fail('WhatsApp cache could not be read. Existing data was preserved.',503)
    const next=saved||{schemaVersion:1,activeAccountId:null,accounts:{}}
    // Older caches kept the phone-to-LID mappings only in the linked session.
    if (Object.values(next.accounts).some(account => !account.aliases && account.id !== 'imported')) {
      let auth
      try { auth = JSON.parse(await session.get()) } catch { /* Offline history remains readable. */ }
      const owner = next.accounts[personId(auth?.creds?.me?.id)]
      if (owner && !owner.aliases) {
        for (const [phone, lid] of Object.entries(auth.keys?.['lid-mapping'] || {})) {
          if (/^\d+$/.test(phone) && typeof lid === 'string') linkContact(owner, lid + '@lid', phone + '@s.whatsapp.net')
        }
        if (owner.aliases) await commit(next)
      }
    }
    data=next
  }
  const current=()=>data.accounts[data.activeAccountId]
  function account(id){return data.accounts[id]||{id,chats:{},contacts:{},messages:[],historyReceived:false}}
  async function commit(next){await files.write('messages.json',next);data=next}
  async function ingest(batch){
    if(!validId(batch.accountId))throw fail('WhatsApp returned an invalid account.',502)
    await load();const previous=account(batch.accountId),next=structuredClone(previous)
    for (const mapping of batch.mappings || []) linkContact(next, mapping.lid, mapping.pn)
    for (const contact of (batch.contacts || []).slice(0, 20000)) {
      const id = personId(contact.id) || contact.id
      if (!validId(id)) continue
      if ('imgUrl' in contact) {
        photoCache.delete(id)
        photoCache.delete(next.aliases?.[id])
      }
      linkContact(next, contact.lid || id, contact.phoneNumber || id)
      const previous = next.contacts[id]
      next.contacts[id] = {id, name:text(contact.name,160) || previous?.name || '',
        verifiedName:text(contact.verifiedName,160) || previous?.verifiedName || '',
        notify:text(contact.notify || contact.username,160) || previous?.notify || ''}
    }
    for(const chat of (batch.chats||[]).slice(0,5000))if(validId(chat.id))next.chats[chat.id]={...next.chats[chat.id],id:chat.id,name:text(chat.name||chat.subject||next.chats[chat.id]?.name,160)}
    const messages=new Map(next.messages.map(message=>[message.id,message]))
    for(const deleted of batch.deleted||[])if(validId(deleted.chatId)&&typeof deleted.sourceId==='string')for(const[id,message]of messages)if(message.chatId===deleted.chatId&&message.sourceId===deleted.sourceId)messages.delete(id)
    for(const item of batch.messages||[]) {
      if(!validId(item.chatId)||!validId(item.senderId)||!text(item.id,200)||!text(item.text,64000)||!Number.isFinite(item.timestamp)||item.chatId==='status@broadcast'||item.chatId.endsWith('@newsletter'))continue
      const id=hash(JSON.stringify([item.chatId,item.senderId,item.id])),existing=messages.get(id)
      // Deduplicate replayed history and live updates while retaining actual text.
      messages.set(id,{id,sourceId:text(item.id,200),chatId:item.chatId,senderId:item.senderId,senderName:text(item.senderName,160)||existing?.senderName||'',fromMe:item.fromMe===true,text:text(item.text,64000),timestamp:item.timestamp})
      next.chats[item.chatId]||={id:item.chatId,name:''}
    }
    const sorted=[...messages.values()].sort((a,b)=>a.timestamp-b.timestamp||a.id.localeCompare(b.id))
    next.limited=previous.limited||sorted.length>50000;next.messages=sorted.slice(-50000);next.historyReceived=previous.historyReceived||batch.historyReceived;next.updatedAt=new Date().toISOString()
    await commit({...data,activeAccountId:data.activeAccountId||batch.accountId,accounts:{...data.accounts,[batch.accountId]:next}})
  }
  const service={
    async businessProfile({accountId,id}) {
      await exclusive(load)
      if (!personId(id) || !validId(accountId)) throw fail('Choose a valid WhatsApp contact.')
      if (accountId !== data.activeAccountId) throw fail('WhatsApp account changed.',409)
      const source = current(), socket = live
      if (!socket || connection.state !== 'connected' || connection.accountId !== accountId || !source?.chats[id]) return null
      const phone = id.endsWith('@lid') ? source.aliases?.[id] || id : id
      const profile = await socket.businessProfile(phone).catch(() => null)
      if (socket !== live || accountId !== data.activeAccountId || !profile?.wid) return null
      return {category:text(profile.category,160)}
    },
    async profilePhoto({accountId, id}) {
      await exclusive(load)
      if (!validId(id) || !validId(accountId)) throw fail('Choose a valid WhatsApp contact.')
      if (accountId !== data.activeAccountId) throw fail('WhatsApp account changed.',409)
      const source = current()
      if (!live || connection.state !== 'connected' || connection.accountId !== accountId || !source) return {url:null}
      if (!source.chats[id] && !source.contacts[id] && !source.messages.some(message => message.senderId === id)) return {url:null}
      const cached = photoCache.get(id)
      if (cached && cached.expires > Date.now()) return {url:await cached.result}
      const socket = live
      const result = Promise.resolve().then(() => socket.profilePhoto(id)).then(value => {
        if (!value || socket !== live || data.activeAccountId !== accountId) return null
        const url = new URL(value)
        return url.protocol === 'https:' && !url.username && !url.password && /(?:^|\.)(?:whatsapp\.net|whatsapp\.com|fbcdn\.net)$/.test(url.hostname) ? url.href : null
      }).catch(() => null)
      photoCache.set(id,{result,expires:Date.now()+5*60_000})
      return {url:await result}
    },
    memorySnapshot:()=>exclusive(async()=>{
      await load()
      return {accounts:Object.values(data.accounts).map(value=>{
        const stats=new Map(), resolveName=nameResolver(value)
        for(const message of value.messages){const previous=stats.get(message.chatId)||{messageCount:0,lastMessageAt:0};previous.messageCount++;if(message.timestamp>=previous.lastMessageAt)Object.assign(previous,{lastMessageAt:message.timestamp,preview:message.text.slice(0,500),messageId:message.id});stats.set(message.chatId,previous)}
        return {accountId:value.id,messageCount:value.messages.length,limited:!!value.limited,historyReceived:!!value.historyReceived,chats:Object.values(value.chats).map(chat=>({...chat,name:chatName(chat,resolveName),...stats.get(chat.id)}))}
      })}
    }),
    status:()=>exclusive(async()=>{await load();const value=current();return {...connection,qr:undefined,qrExpiresAt:undefined,linkedAccountId:connection.accountId,accountId:data.activeAccountId,sources:Object.keys(data.accounts),messageCount:value?.messages.length||0,chatCount:Object.keys(value?.chats||{}).length,historyReceived:!!value?.historyReceived,limited:!!value?.limited,updatedAt:value?.updatedAt,sessionStorage:session.storage,historyCoverage:'Only messages supplied by WhatsApp or explicitly imported; full history is not guaranteed.'}}),
    selectAccount:id=>exclusive(async()=>{await load();if(!validId(id)||!Object.hasOwn(data.accounts,id))throw fail('Choose a saved WhatsApp source.',404);await commit({...data,activeAccountId:id});return {accountId:id}}),
    pairing:()=>exclusive(async()=>({state:connection.state,qr:connection.qrExpiresAt>Date.now()?connection.qr:null,qrExpiresAt:connection.qrExpiresAt})),
    async connect(){
      let token,old
      await exclusive(async()=>{await load();if(['connecting','pairing','connected','reconnecting'].includes(connection.state))throw fail('A WhatsApp connection is already active.',409);token=++generation;photoCache.clear();old=live;live=null;connection={state:'connecting'}})
      await old?.stop()
      try {
        const started=await adapter({session,onState:update=>exclusive(async()=>{if(token!==generation)return;const {qr,qrExpiresAt,...state}=update;connection={...connection,...state,qr,qrExpiresAt};if(update.state==='connected'&&validId(update.accountId)){await load();await commit({...data,activeAccountId:update.accountId,accounts:{...data.accounts,[update.accountId]:account(update.accountId)}});clearTimeout(pairTimer)}}),onBatch:batch=>exclusive(async()=>{if(token===generation)await ingest(batch)})})
        await exclusive(async()=>{if(token===generation)live=started})
        if(token!==generation){await started.stop();return}
        pairTimer=setTimeout(()=>{if(token===generation&&['connecting','pairing'].includes(connection.state)){void service.pause()}},150000);pairTimer.unref?.()
      }catch{await exclusive(async()=>{if(token===generation)connection={state:'failed',message:'WhatsApp could not start. Check connectivity and reconnect.'}});throw fail('WhatsApp could not start. Check connectivity and reconnect.',503)}
      return service.status()
    },
    async pause(){let old;await exclusive(async()=>{generation++;photoCache.clear();clearTimeout(pairTimer);old=live;live=null;connection={state:'disconnected'}});await old?.stop();return service.status()},
    async disconnect(){let old;await exclusive(async()=>{generation++;photoCache.clear();clearTimeout(pairTimer);old=live;live=null;connection={state:'disconnected',message:'Local session removed. Check Linked devices on your phone to confirm the device is unlinked.'}});await old?.stop({unlink:true});await session.clear();return service.status()},
    chats:({query='',relationship='auto'}={})=>exclusive(async()=>{
      if(typeof query!=='string'||query.length>300||!['auto',...groups].includes(relationship))throw fail('Use a valid chat search and group.')
      await load();const value=current(),counts={auto:0},needle=query.trim().toLowerCase(),stats=new Map(), resolveName=nameResolver(value)
      for(const message of value?.messages||[]){const statsValue=stats.get(message.chatId)||{messageCount:0,lastMessageAt:0,preview:''};statsValue.messageCount++;if(message.timestamp>=statsValue.lastMessageAt){statsValue.lastMessageAt=message.timestamp;statsValue.preview=message.text.slice(0,200)}stats.set(message.chatId,statsValue)}
      const searched=Object.values(value?.chats||{}).map(chat=>({...chat,name:chatName(chat,resolveName),localName:value.contactNames?.[chat.id]||value.contactNames?.[value.aliases?.[chat.id]]||'',relationship:chat.relationship||'other',company:chat.company||'',role:chat.role||'',kind:chat.id.endsWith('@g.us')?'group':'person',...stats.get(chat.id)})).filter(chat=>!needle||`${chat.name} ${chat.company} ${chat.role} ${chat.id} ${value.aliases?.[chat.id]||''}`.toLowerCase().includes(needle)||(/^[+\d\s().-]+$/.test(needle) && [chat.id,value.aliases?.[chat.id]].some(id=>id?.split('@')[0]===needle.replace(/\D/g,''))))
      counts.auto=searched.length;for(const chat of searched)counts[chat.relationship]=(counts[chat.relationship]||0)+1
      return {accountId:data.activeAccountId,counts,chats:searched.filter(chat=>relationship==='auto'||chat.relationship===relationship).sort((a,b)=>(b.lastMessageAt||0)-(a.lastMessageAt||0))}
    }),
    messages:({accountId,chatId,query='',cursor='0'}={})=>exclusive(async()=>{if(!validId(chatId)||typeof query!=='string'||query.length>300||!/^\d{1,8}$/.test(cursor))throw fail('Choose a valid chat.');await load();if(accountId!==data.activeAccountId)throw fail('WhatsApp account changed. Reopen the conversation.',409);const resolveName=nameResolver(current());const needle=query.toLowerCase(),all=(current()?.messages||[]).filter(message=>message.chatId===chatId).map(message=>({...message,senderName:resolveName(message.senderId)||message.senderName})).filter(message=>(!needle||`${message.text} ${message.senderName}`.toLowerCase().includes(needle))).sort((a,b)=>b.timestamp-a.timestamp||a.id.localeCompare(b.id)),offset=Number(cursor);return {accountId,chatId,messages:all.slice(offset,offset+50),total:all.length,hasMore:offset+50<all.length,nextCursor:String(offset+50)}}),
    updateChat:value=>exclusive(async()=>{const {accountId,chatId,relationship,company='',role=''}=value;if(!validId(chatId)||!groups.includes(relationship)||typeof company!=='string'||company.length>120||typeof role!=='string'||role.length>200)throw fail('Choose a valid group, organization and responsibility.');await load();if(accountId!==data.activeAccountId)throw fail('WhatsApp account changed. Reopen the conversation.',409);const currentAccount=current();if(!currentAccount?.chats[chatId])throw fail('Conversation not found.',404);const next=structuredClone(data)
      if (value.localName !== undefined) {
        if (!personId(chatId) || typeof value.localName !== 'string' || value.localName.length > 160) throw fail('Enter a contact name of up to 160 characters.')
        const owner = next.accounts[accountId], names = owner.contactNames ||= {}
        delete names[owner.aliases?.[chatId]]
        const name = text(value.localName,160)
        if (name) names[chatId] = name
        else delete names[chatId]
      }
      Object.assign(next.accounts[accountId].chats[chatId],{relationship,company:text(company,120),role:text(role,200)});await commit(next);return {saved:true}}),
    importChat:value=>exclusive(async()=>{const {content,title,dateOrder,timezoneOffset}=value;if(typeof content!=='string'||Buffer.byteLength(content)>20*1024*1024||!text(title,160))throw fail('Provide a chat name and a text export up to 20 MiB.');await load();const parsed=parseWhatsAppExport(content,{dateOrder,timezoneOffset});if(!parsed.messages.length)throw fail('No supported messages found. Check the export date format.');const accountId='imported',chatId='export:'+hash(text(title,160).toLowerCase()).slice(0,32);await ingest({accountId,historyReceived:false,chats:[{id:chatId,name:text(title,160)}],messages:parsed.messages.map(message=>({...message,chatId,senderId:'export:'+hash(message.senderName).slice(0,32)}))});await commit({...data,activeAccountId:accountId});return {imported:parsed.messages.length,ignoredLines:parsed.ignoredLines,skippedMessages:parsed.skippedMessages,accountId,chatId}}),
  }
  // Serialize device lifecycle work separately from storage work. Event callbacks
  // must remain able to commit while a stop waits for its event queue to drain.
  let lifecycle=Promise.resolve()
  for(const name of ['connect','pause','disconnect']){const run=service[name].bind(service);service[name]=(...args)=>{const next=lifecycle.then(()=>run(...args));lifecycle=next.catch(()=>{});return next}}
  instances.set(root,service);return service
}
export async function stopWhatsAppServices(){await Promise.allSettled([...instances.values()].map(service=>service.pause()))}
