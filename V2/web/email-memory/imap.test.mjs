import test from 'node:test'
import assert from 'node:assert/strict'
import {Readable} from 'node:stream'
import {createImapProvider,zohoHost} from './imap.mjs'

const email='owner@example.com',password='synthetic-app-password'
const publicLookup=async()=>[{address:'93.184.216.34',family:4}]
function memoryStore(){let value=null;return {storage:'session',async get(){return value?structuredClone(value):null},async set(next){value=structuredClone(next)},async clear(){value=null}}}
function fake({folders=[{path:'INBOX'},{path:'Sent',specialUse:'\\Sent'},{path:'Trash',specialUse:'\\Trash'},{path:'Junk',specialUse:'\\Junk'},{path:'Drafts',specialUse:'\\Drafts'},{path:'All Mail',specialUse:'\\All'}],counts={INBOX:205,Sent:2},sparse,charset,failConnect=false}={}){
  const calls=[]
  const factory=options=>{
    let current='INBOX'
    const client={on(){},mailbox:{},async connect(){calls.push({action:'connect',options});if(failConnect)throw Object.assign(Error(password),{authenticationFailed:true})},async list(){return folders},async getMailboxLock(path,settings){current=path;client.mailbox={uidValidity:42n,uidNext:(sparse?.at(-1)||counts[path]||0)+1,exists:sparse?.length||counts[path]||0};calls.push({action:'lock',path,settings});return {release(){}}},async search(query){calls.push({action:'search',query,path:current});return sparse||Array.from({length:counts[current]||0},(_,index)=>index+1)},async *fetch(range,query,settings){calls.push({action:'fetch',range,query,settings,path:current});for(const uid of range.split(',').map(Number))yield record(uid,current)},async fetchOne(uid,query){calls.push({action:'fetchOne',uid,query});return {...record(Number(uid),current),bodyStructure:{type:'multipart/mixed',childNodes:[{type:'text/plain',part:'1',size:8,parameters:{charset:charset||'UTF-8'}},{type:'application/pdf',part:'2',disposition:'attachment',size:8000000}]}}},async download(uid,part,options){calls.push({action:'download',uid,part,options});return {meta:{contentType:'text/plain',charset:charset||'UTF-8'},content:Readable.from([charset?Buffer.from([99,97,102,233]):Buffer.from('Message body')])}},async logout(){},close(){}}
    return client
  }
  function record(uid,folder){return {uid,internalDate:new Date('2026-11-17T04:00:00Z'),flags:new Set(),envelope:{from:[{address:'alice@example.com',name:'Alice'}],to:[{address:email}],subject:folder+' '+uid,messageId:`<${folder}-${uid}@example.com>`}}}
  return {calls,factory}
}

test('generic IMAP uses pinned verified TLS993 and reads concrete folders without aggregate/junk/trash/drafts',async()=>{
  const source=fake(),provider=createImapProvider({root:process.cwd(),credentials:memoryStore(),imapFactory:source.factory,lookupImpl:publicLookup})
  const connected=await provider.connectAppPassword({email,appPassword:password,host:'mail.example.com',port:993})
  assert.equal(connected.connected,true);assert.equal(connected.provider,'imap');assert.equal(JSON.stringify(connected).includes(password),false)
  const connect=source.calls.find(call=>call.action==='connect')
  assert.equal(connect.options.host,'mail.example.com');assert.equal(connect.options.port,993);assert.equal(connect.options.secure,true);assert.equal(connect.options.tls.servername,'mail.example.com');assert.equal(connect.options.tls.rejectUnauthorized,true);assert.equal(typeof connect.options.tls.lookup,'function');assert.equal(connect.options.logger,false)
  let cursor,count=0,pages=0
  do{const page=await provider.scanPage({cursor});count+=page.messages.length;pages++;cursor=page.nextCursor;if(!page.hasNextPage)break}while(pages<10)
  assert.equal(count,207);assert.equal(pages,4)
  const locks=source.calls.filter(call=>call.action==='lock');assert.equal(locks.every(call=>call.settings.readOnly===true),true);assert.deepEqual([...new Set(locks.map(call=>call.path))],['INBOX','Sent'])
  assert.equal(source.calls.filter(call=>call.action==='fetch').some(call=>call.query.source),false)
})

test('Zoho region presets use verified official hosts and no arbitrary host override',async()=>{
  assert.equal(zohoHost({region:'us',accountType:'business'}),'imappro.zoho.com');assert.equal(zohoHost({region:'eu',accountType:'personal'}),'imap.zoho.eu');assert.equal(zohoHost({region:'in'}),'imappro.zoho.in');assert.equal(zohoHost({region:'au'}),'imap.zoho.com.au');assert.equal(zohoHost({region:'jp'}),'imap.zoho.jp');assert.equal(zohoHost({region:'cn'}),'imap.zoho.com.cn')
  assert.throws(()=>zohoHost({region:'unverified'}),{status:422})
  const source=fake(),provider=createImapProvider({root:process.cwd(),provider:'zoho',credentials:memoryStore(),imapFactory:source.factory,lookupImpl:publicLookup})
  const status=await provider.connectAppPassword({email,appPassword:password,region:'eu',accountType:'business',host:'attacker.example'})
  assert.equal(status.provider,'zoho');assert.equal(source.calls[0].options.host,'imappro.zoho.eu')
})

test('private DNS destinations and nonsecure ports fail before any credentials reach a socket',async()=>{
  const source=fake(),provider=createImapProvider({root:process.cwd(),credentials:memoryStore(),imapFactory:source.factory,lookupImpl:async()=>[{address:'127.0.0.1',family:4}]})
  await assert.rejects(provider.connectAppPassword({email,appPassword:password,host:'mail.example.com'}))
  await assert.rejects(provider.connectAppPassword({email,appPassword:password,host:'mail.example.com',port:143}),{status:422})
  assert.equal(source.calls.length,0)
})

test('IMAP sparse UID pages and selected text previews stay bounded and never retrieve attachments',async()=>{
  const source=fake({folders:[{path:'INBOX'}],sparse:[1,5000000,9000001],charset:'iso-8859-1'}),provider=createImapProvider({root:process.cwd(),credentials:memoryStore(),imapFactory:source.factory,lookupImpl:publicLookup})
  await provider.connectAppPassword({email,appPassword:password,host:'mail.example.com'})
  const page=await provider.scanPage();assert.equal(page.messages.length,3);assert.equal(page.hasNextPage,false);assert.match(page.messages[0].id,/^im_[a-f0-9]{24}_42_1$/)
  const detail=await provider.getMessage(page.messages[0].id);assert.equal(detail.text,'café');assert.equal(detail.attachmentsOmitted,true)
  const download=source.calls.find(call=>call.action==='download');assert.equal(download.part,'1');assert.equal(download.options.maxBytes,1024*1024);assert.equal(source.calls.find(call=>call.action==='fetchOne').query.source,undefined)
})

test('folder checkpoints cannot cross hosts or replaced credentials and auth diagnostics never echo secrets',async()=>{
  const source=fake(),provider=createImapProvider({root:process.cwd(),credentials:memoryStore(),imapFactory:source.factory,lookupImpl:publicLookup})
  await provider.connectAppPassword({email,appPassword:password,host:'mail.one.example'});const first=await provider.scanPage()
  const oldId=(await provider.status()).accountId
  await provider.connectAppPassword({email,appPassword:password,host:'mail.two.example'})
  assert.notEqual((await provider.status()).accountId,oldId);await assert.rejects(provider.scanPage({cursor:first.nextCursor}),{code:'imap_account_changed'})
  const bad=fake({failConnect:true}),badProvider=createImapProvider({root:process.cwd(),credentials:memoryStore(),imapFactory:bad.factory,lookupImpl:publicLookup})
  await assert.rejects(badProvider.connectAppPassword({email,appPassword:password,host:'mail.example.com'}),error=>error.status===401&&!error.message.includes(password))
})

test('an aggregate-only folder cannot falsely claim that Junk and Trash were excluded',async()=>{
  const source=fake({folders:[{path:'All Mail',specialUse:'\\All'}]}),provider=createImapProvider({root:process.cwd(),credentials:memoryStore(),imapFactory:source.factory,lookupImpl:publicLookup})
  await assert.rejects(provider.connectAppPassword({email,appPassword:password,host:'mail.example.com'}),{code:'imap_folders_unavailable'})
})

test('Zoho auto type uses the normalized mailbox address and preserves explicit personal/free organization selection',async()=>{
  assert.equal(zohoHost({email:'person@zohomail.com'}),'imap.zoho.com')
  assert.equal(zohoHost({email:'person@company.example'}),'imappro.zoho.com')
  assert.equal(zohoHost({email:'person@company.example',accountType:'personal'}),'imap.zoho.com')
  assert.equal(zohoHost({email:'person@zoho.eu',region:'eu',accountType:'auto'}),'imap.zoho.eu')
  const source=fake(),provider=createImapProvider({root:process.cwd(),provider:'zoho',credentials:memoryStore(),imapFactory:source.factory,lookupImpl:publicLookup})
  await provider.connectAppPassword({email:' Person@Zoho.com ',appPassword:'synthetic-zoho-password',region:'us',accountType:'auto'})
  assert.equal(source.calls[0].options.host,'imap.zoho.com');assert.equal(source.calls[0].options.auth.user,'person@zoho.com')
})

test('Zoho server refusals become specific safe diagnoses without leaking login transcripts',async()=>{
  const cases=[
    [{authenticationFailed:true,responseText:'Invalid credentials'},'zoho_auth_required',401],
    [{authenticationFailed:true,responseText:'IMAP access is not enabled for this account'},'zoho_imap_disabled',409],
    [{authenticationFailed:true,responseText:'Application-specific password required'},'zoho_app_password_required',401],
    [{authenticationFailed:true,responseText:'Account blocked'},'zoho_account_blocked',403],
    [{code:'ETHROTTLE',responseText:'Too many login attempts'},'zoho_rate_limited',429],
    [{authenticationFailed:true,responseText:'Please use the correct data center'},'zoho_region_mismatch',422],
    [{code:'CERT_HAS_EXPIRED'},'imap_tls_failed',502],
    [{code:'ETIMEDOUT'},'imap_timeout',504],
  ]
  for(const [properties,code,status]of cases){
    const store=memoryStore(),provider=createImapProvider({root:process.cwd(),provider:'zoho',credentials:store,lookupImpl:publicLookup,imapFactory:()=>({on(){},async connect(){throw Object.assign(Error('synthetic-private-password'),{...properties,response:'private login transcript synthetic-private-password'})},async logout(){},close(){}})})
    await assert.rejects(provider.connectAppPassword({email,appPassword:password}),error=>error.code===code&&error.status===status&&!error.message.includes('synthetic-private-password')&&!error.message.includes('transcript'))
    assert.equal(await store.get(),null)
  }
})

test('Zoho DNS and invalid-host failures are distinguished from sign-in failures',async()=>{
  let calls=0
  const provider=createImapProvider({root:process.cwd(),provider:'zoho',credentials:memoryStore(),lookupImpl:async()=>{throw Object.assign(Error('private DNS detail'),{code:'ENOTFOUND'})},imapFactory:()=>{calls++;throw Error('not reached')}})
  await assert.rejects(provider.connectAppPassword({email,appPassword:password}),error=>error.code==='imap_dns_failed'&&error.status===502&&!error.message.includes('private'))
  assert.equal(calls,0)
})
