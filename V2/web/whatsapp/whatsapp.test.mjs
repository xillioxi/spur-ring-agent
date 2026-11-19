import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,readFile,readdir,symlink} from 'node:fs/promises'
import {join,resolve,relative,isAbsolute} from 'node:path'
import {createHash} from 'node:crypto'
import {Readable,Writable} from 'node:stream'
import {parseWhatsAppExport} from './import.mjs'
import {createWhatsAppService} from './service.mjs'
import {encryptedSession,privateStore} from './private-store.mjs'
import {startWhatsApp} from './adapter.mjs'
import {handleWhatsAppRequest,WHATSAPP_PREFIX as prefix,whatsappReadToolRoute} from './http.mjs'
const accountId='123@s.whatsapp.net',chatId='456@s.whatsapp.net'
async function directory(t){const root=await mkdtemp(join(process.cwd(),'.spur-whatsapp-test-'));t.after(async()=>{const part=relative(process.cwd(),resolve(root));assert.ok(!part.startsWith('..')&&!isAbsolute(part));await rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:100})});return root}
const session=()=>({storage:'session',value:null,async get(){return this.value},async set(value){this.value=value},async clear(){this.value=null}})
const sample='17/11/2026, 10:00 - Alice: Production starts today\nBring the camera.\n17/11/2026, 10:01 - Bob: Ready!\n17/11/2026, 10:02 - Alice: <Media omitted>\n17/11/2026, 10:03 - Messages are encrypted'
test('Android and iOS exports parse multiline text, date order, timezone and skip system/media entries',()=>{
  const result=parseWhatsAppExport(sample,{dateOrder:'DMY',timezoneOffset:-480})
  assert.equal(result.messages.length,2);assert.equal(result.messages[0].text,'Production starts today\nBring the camera.');assert.equal(result.messages[0].timestamp,Date.UTC(2026,10,17,2));assert.equal(result.skippedMessages,1);assert.equal(result.ignoredLines,1)
  const ios=parseWhatsAppExport('[11/17/26, 9:01:02 PM] Alice: Hello',{dateOrder:'MDY',timezoneOffset:0})
  assert.equal(ios.messages[0].timestamp,Date.UTC(2026,10,17,21,1,2));assert.equal(parseWhatsAppExport('30/02/2026, 12:00 - Alice: Bad').messages.length,0)
  assert.throws(()=>parseWhatsAppExport(sample,{timezoneOffset:900}),{status:400})
})
test('imports deduplicate, persist context and messages, search text, and refuse stale account reads and writes',async t=>{
  const root=await directory(t),service=createWhatsAppService({root,session:session()})
  await service.importChat({content:sample,title:'Studio team',dateOrder:'DMY',timezoneOffset:0});await service.importChat({content:sample,title:'Studio team',dateOrder:'DMY',timezoneOffset:0})
  assert.equal((await service.status()).messageCount,2)
  const chat=(await service.chats()).chats[0]
  await service.updateChat({accountId:'imported',chatId:chat.id,relationship:'colleagues',company:'Studio',role:'Production'})
  assert.equal((await service.chats({query:'production',relationship:'colleagues'})).chats.length,1)
  const messages=await service.messages({accountId:'imported',chatId:chat.id,query:'camera'});assert.equal(messages.total,1);assert.match(messages.messages[0].text,/camera/)
  await assert.rejects(service.messages({accountId:'wrong',chatId:chat.id}),{status:409})
  await assert.rejects(service.updateChat({accountId:'wrong',chatId:chat.id,relationship:'friends'}),{status:409})
  const stored=JSON.parse(await readFile(join(root,'messages.json'),'utf8'));assert.equal(stored.accounts.imported.chats[chat.id].role,'Production')
})
test('linked history and live updates deduplicate, isolate sources and retain saved messages after unlink',async t=>{
  const root=await directory(t),auth=session();let callbacks,stopped=false
  const service=createWhatsAppService({root,session:auth,adapter:async value=>{callbacks=value;return {stop:async()=>{stopped=true}}}})
  await service.connect();await callbacks.onState({state:'pairing',qr:'sensitive-qr',qrExpiresAt:Date.now()+60000})
  assert.equal(JSON.stringify(await service.status()).includes('sensitive-qr'),false);assert.equal((await service.pairing()).qr,'sensitive-qr')
  await callbacks.onState({state:'connected',accountId})
  const message={id:'one',chatId,senderId:chatId,senderName:'Alice',text:'Camera delivery',timestamp:10}
  await callbacks.onBatch({accountId,messages:[message],historyReceived:true});await callbacks.onBatch({accountId,messages:[message]})
  assert.equal((await service.status()).messageCount,1);assert.equal((await service.status()).historyReceived,true)
  await service.importChat({content:sample,title:'Import',dateOrder:'DMY',timezoneOffset:0})
  await callbacks.onBatch({accountId,messages:[{...message,id:'two'}]})
  assert.equal((await service.status()).accountId,'imported');assert.equal((await service.status()).messageCount,2)
  await service.selectAccount(accountId);assert.equal((await service.messages({accountId,chatId})).total,2)
  await callbacks.onBatch({accountId,deleted:[{chatId,sourceId:'one'}]});assert.equal((await service.messages({accountId,chatId})).total,1)
  await service.disconnect();assert.equal(stopped,true);assert.equal((await service.status()).messageCount,1);assert.equal((await service.pairing()).qr,null)
  await callbacks.onBatch({accountId,messages:[{...message,id:'late'}]});assert.equal((await service.status()).messageCount,1)
})
test('existing direct chats and group senders resolve through the linked account’s saved phone mappings',async t=>{
  const root=await directory(t), auth=session(), lid='987@lid', group='555@g.us'
  const chats={[lid]:{id:lid,name:''},[group]:{id:group,name:'Studio'}}
  const contacts={[chatId]:{id:chatId,name:'Alex'},[lid]:{id:lid,name:'987'}}
  const message={id:'one',chatId:group,senderId:lid,senderName:'',text:'Hi',timestamp:1}
  await privateStore(root).write('messages.json',{schemaVersion:1,activeAccountId:accountId,accounts:{
    [accountId]:{id:accountId,chats,contacts,messages:[message]},
  }})
  await auth.set(JSON.stringify({creds:{me:{id:'123:4@s.whatsapp.net'}},keys:{'lid-mapping':{'456':'987'}}}))
  let callbacks
  const service=createWhatsAppService({root,session:auth,adapter:async value=>{callbacks=value;return {stop:async()=>{}}}})
  assert.equal((await service.chats({query:'Alex'})).chats[0].id,lid)
  assert.equal((await service.messages({accountId,chatId:group,query:'Alex'})).messages[0].senderName,'Alex')
  assert.equal((await service.chats({query:'Studio'})).chats[0].name,'Studio')
  assert.equal((await service.chats({query:'+4 56'})).chats[0].id,lid)
  await service.updateChat({accountId,chatId:lid,relationship:'friends',localName:'Lex'})
  assert.equal((await service.messages({accountId,chatId:group})).messages[0].senderName,'Lex')
  assert.equal((await service.chats({query:'Lex'})).chats[0].name,'Lex')
  await service.updateChat({accountId,chatId:lid,relationship:'friends',localName:''})
  assert.equal((await service.chats({query:'Alex'})).chats[0].name,'Alex')
  await service.connect()
  await callbacks.onBatch({accountId,contacts:[{id:chatId,notify:'Profile name'}]})
  assert.equal((await service.memorySnapshot()).accounts[0].chats.find(chat=>chat.id===lid).name,'Alex')
  await service.pause()
})
test('photos use the linked source, deduplicate preview requests and fall back for hidden photos',async t=>{
  const root=await directory(t), photo='https://pps.whatsapp.net/preview.jpg', group='555@g.us'
  const requests=[]
  let events
  const service=createWhatsAppService({root,session:session(),adapter:async callbacks=>{
    events=callbacks
    return {stop:async()=>{},profilePhoto:async id=>{
      requests.push(id)
      if(id===group)throw new Error('Photo is private')
      return photo
    }}
  }})
  await service.connect()
  await events.onState({state:'connected',accountId})
  await events.onBatch({accountId,chats:[{id:group}],messages:[{id:'one',chatId:group,senderId:chatId,text:'Hi',timestamp:1}]})
  const lookup=()=>service.profilePhoto({accountId,id:chatId})
  assert.deepEqual(await Promise.all([lookup(),lookup()]),[{url:photo},{url:photo}])
  assert.deepEqual(requests,[chatId])
  assert.deepEqual(await service.profilePhoto({accountId,id:group}),{url:null})
  await assert.rejects(service.profilePhoto({accountId:'imported',id:chatId}),{status:409})
  await service.pause()
  assert.deepEqual(await lookup(),{url:null})
})
test('session files are authenticated ciphertext and can reopen with the same protected key',async t=>{
  const root=await directory(t);let secret
  const keyStore={storage:'os_protected',get:async()=>secret,set:async value=>{secret=value},clear:async()=>{secret=null}}
  const first=encryptedSession(root,{keyStore});await first.set('private-whatsapp-session');assert.equal((await readFile(join(root,'auth.json'),'utf8')).includes('private-whatsapp-session'),false)
  assert.equal(await encryptedSession(root,{keyStore}).get(),'private-whatsapp-session')
  const files=privateStore(root),envelope=await files.read('auth.json');envelope.tag=Buffer.alloc(16).toString('base64');await files.write('auth.json',envelope)
  await assert.rejects(encryptedSession(root,{keyStore}).get(),{status:503});assert.ok(await files.read('auth.json'))
  await first.clear();assert.equal(await files.read('auth.json'),null)
})
test('adapter ingests text but excludes ephemeral/view-once, never sends read receipts, and clears QR on connect',async()=>{
  let processEvents,options;const batches=[],states=[];let loggedOut=false,ended=false
  const sdk={BufferJSON:{},initAuthCreds:()=>({}),jidNormalizedUser:value=>value||'',Browsers:{macOS:browser=>['Mac OS',browser,'1']},normalizeMessageContent:value=>value,proto:{Message:{AppStateSyncKeyData:{fromObject:value=>value}}},DisconnectReason:{loggedOut:401,restartRequired:515},default:value=>{options=value;return {user:{id:accountId,name:'Owner'},ev:{process:callback=>{processEvents=callback}},end:()=>{ended=true},logout:async()=>{loggedOut=true}}}}
  const auth=session(),adapter=await startWhatsApp({session:auth,onState:async value=>states.push(value),onBatch:async value=>batches.push(value),sdk})
  await processEvents({'connection.update':{qr:'test-local-qr'}});assert.match(states[0].qr,/^data:image\/png;base64,/)
  await processEvents({'connection.update':{connection:'open'}});assert.equal(states.at(-1).qr,null);assert.equal(options.markOnlineOnConnect,false);assert.equal(options.browser[1],'Chrome')
  const base={key:{id:'text',remoteJid:chatId},messageTimestamp:100,pushName:'Alice'}
  await processEvents({'messages.upsert':{messages:[{...base,message:{conversation:'Text'}},{...base,key:{...base.key,id:'ephemeral'},message:{ephemeralMessage:{message:{conversation:'Private'}}}},{...base,key:{...base.key,id:'viewonce'},message:{viewOnceMessage:{message:{imageMessage:{caption:'Private'}}}}}]}})
  assert.equal(batches[0].messages.length,1);assert.equal(batches[0].messages[0].text,'Text')
  await adapter.stop({unlink:true});assert.equal(loggedOut,true);assert.equal(ended,true);assert.equal(auth.value,null)
})
class Response extends Writable{constructor(){super();this.parts=[]} _write(part,_encoding,done){this.parts.push(part);done()}writeHead(code,headers){this.statusCode=code;this.headers=headers}json(){return JSON.parse(Buffer.concat(this.parts).toString())}}
test('HTTP import, grouping and account-scoped message reads work; harness cannot access pairing or writes',async t=>{
  const root=await directory(t),options={root,session:session()}
  const request=async(path,method='GET',value)=>{const req=Readable.from(value===undefined?[]:[Buffer.from(JSON.stringify(value))]);Object.assign(req,{url:prefix+path,method,headers:{'content-type':'application/json'}});const res=new Response();await handleWhatsAppRequest(req,res,options);return res}
  let res=await request('/import','POST',{content:sample,title:'HTTP team',dateOrder:'DMY',timezoneOffset:0});assert.equal(res.statusCode,200)
  const {accountId,chatId}=res.json();res=await request('/messages?'+new URLSearchParams({accountId,chatId}));assert.equal(res.json().total,2)
  assert.equal((await request('/import','POST',{content:sample,title:'bad',root:'outside'})).statusCode,400)
  assert.equal((await request('/chats?query=a&query=b')).statusCode,400)
  for(const path of ['/status','/chats','/messages'])assert.equal(whatsappReadToolRoute(prefix+path,'GET'),true)
  for(const path of ['/pairing','/connect','/connection','/import','/account'])assert.equal(whatsappReadToolRoute(prefix+path,'GET'),false)
  assert.equal(whatsappReadToolRoute(prefix+'/chats','PATCH'),false)
})
