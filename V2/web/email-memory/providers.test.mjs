import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,readFile} from 'node:fs/promises'
import {join,resolve,relative,isAbsolute} from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {createMailProvider,finishMailOAuth} from './providers.mjs'
import {createEmailMemoryService,waitForEmailMemoryIdle} from './service.mjs'

const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve}}
const idFor=(provider,email,host='')=>provider+'_'+createHash('sha256').update(email+'\0'+host).digest('hex').slice(0,24)
async function fixture(t,{legacy,scanHook,bodyHook}={}){
  const root=await mkdtemp(join(process.cwd(),'.spur-multi-mailbox-test-')),slots=new Map(),reads=[]
  t.after(async()=>{await waitForEmailMemoryIdle();const part=relative(process.cwd(),resolve(root));assert.ok(!part.startsWith('..')&&!isAbsolute(part));await rm(root,{recursive:true,force:true})})
  const singleFactory=({root:slotRoot})=>{
    if(slots.has(slotRoot))return slots.get(slotRoot)
    let value=slotRoot===root&&legacy?{...legacy,connected:true}:{connected:false,provider:'gmail'},pending
    const source={
      async status(){return {...value,providerLabel:value.provider,oauthAvailable:true,scope:value.provider+' mailbox scope',providers:[{id:'gmail',label:'Gmail',oauthAvailable:true},{id:'outlook',label:'Outlook',oauthAvailable:true},{id:'zoho',label:'Zoho',oauthAvailable:false},{id:'imap',label:'Other',oauthAvailable:false}] }},
      async connectAppPassword(input){if(input.appPassword==='invalid')throw Error('synthetic-secret');const provider=input.provider||'gmail';value={provider,email:input.email,accountId:idFor(provider,input.email,input.host),connected:true,method:provider+'_imap'};return source.status()},
      async startOAuth(input){pending={state:randomUUID(),provider:input.provider||'gmail'};return {authorizationUrl:`https://${pending.provider==='outlook'?'login.microsoftonline.com':'accounts.google.com'}/authorize?state=${pending.state}`,expiresIn:600}},
      async finishOAuth(provider,params){if(!pending||params.get('state')!==pending.state||params.get('code')!=='valid')throw Error('cancelled');value={provider,email:params.get('testEmail')||'oauth@example.com',connected:true,accountId:idFor(provider,params.get('testEmail')||'oauth@example.com'),method:provider+'_oauth'};pending=null;return source.status()},
      async disconnect(){value={...value,connected:false};return source.status()},
      async scanPage(options){await scanHook?.(value,options);return {messages:[{id:'same_id',threadId:'same_id',from:{email:'alice@example.com'},to:[{email:value.email}],cc:[],subject:value.provider+' '+value.email,date:'2026-11-17T04:00:00Z'}],hasNextPage:false,mailboxEmail:value.email,mailboxAccountId:value.accountId}},
      async getMessage(id){const snapshot={...value};reads.push(snapshot.email);await bodyHook?.(snapshot,id);return {text:snapshot.provider+' body for '+snapshot.email,mailboxEmail:snapshot.email,mailboxAccountId:snapshot.accountId}},
    }
    slots.set(slotRoot,source);return source
  }
  return {root,slots,reads,singleFactory,provider:createMailProvider({root,singleFactory})}
}

test('many mailboxes of the same provider retain independent credentials, selection and disconnect state',async t=>{
  const fx=await fixture(t,{legacy:{provider:'gmail',email:'legacy@gmail.com',accountId:idFor('gmail','legacy@gmail.com'),method:'gmail_imap'}})
  let status=await fx.provider.status();assert.equal(status.mailboxes.length,1);assert.equal(status.selectedMailboxId,'legacy')
  await fx.provider.connectAppPassword({provider:'gmail',email:'one@gmail.com',appPassword:'synthetic-private-password'})
  status=await fx.provider.connectAppPassword({provider:'gmail',email:'two@gmail.com',appPassword:'synthetic-private-password'})
  assert.equal(status.mailboxes.length,3);assert.equal(status.mailboxes.every(mailbox=>mailbox.connected),true)
  const first=status.mailboxes.find(mailbox=>mailbox.email==='one@gmail.com'),second=status.mailboxes.find(mailbox=>mailbox.email==='two@gmail.com')
  await fx.provider.selectMailbox(first.id);assert.equal((await fx.provider.status()).email,'one@gmail.com')
  await fx.provider.disconnect(first.id);status=await fx.provider.status();assert.equal(status.connected,false);assert.equal(status.email,'one@gmail.com');assert.equal(status.mailboxes.find(mailbox=>mailbox.id===second.id).connected,true)
  const reloaded=createMailProvider({root:fx.root,singleFactory:fx.singleFactory});assert.equal((await reloaded.status()).selectedMailboxId,first.id)
  const disk=await readFile(join(fx.root,'mailbox-connections.json'),'utf8');assert.equal(disk.includes('synthetic-private-password'),false)
  assert.equal(fx.slots.size,3)
})

test('a failed add leaves existing linked accounts and active selection intact',async t=>{
  const fx=await fixture(t)
  await fx.provider.connectAppPassword({provider:'zoho',email:'one@example.com',appPassword:'valid-password'})
  const before=await fx.provider.status()
  await assert.rejects(fx.provider.connectAppPassword({provider:'imap',email:'two@example.com',appPassword:'invalid'}))
  const after=await fx.provider.status();assert.equal(after.selectedMailboxId,before.selectedMailboxId);assert.equal(after.mailboxes.length,1);assert.equal(after.email,'one@example.com')
})

test('OAuth adds a mailbox only after verified callback and binds it to its initiating workspace',async t=>{
  const first=await fixture(t),second=await fixture(t)
  const start=await first.provider.startOAuth({provider:'outlook',clientId:'public-app-id'}),state=new URL(start.authorizationUrl).searchParams.get('state')
  assert.equal((await first.provider.status()).mailboxes.length,0)
  await assert.rejects(finishMailOAuth('gmail',new URLSearchParams({state,code:'valid'})),{code:'mail_invalid_state'})
  const connected=await finishMailOAuth('outlook',new URLSearchParams({state,code:'valid',testEmail:'personal@outlook.com'}))
  assert.equal(connected.mailboxes.length,1);assert.equal(connected.email,'personal@outlook.com');assert.equal((await second.provider.status()).mailboxes.length,0)
  await assert.rejects(finishMailOAuth('outlook',new URLSearchParams({state,code:'valid'})),{code:'mail_invalid_state'})
})

test('same-address mailboxes on different providers and servers keep different networks and response identities',async t=>{
  const fx=await fixture(t),service=createEmailMemoryService({root:fx.root,provider:fx.provider}),email='owner@example.com'
  await service.connect({provider:'imap',email,host:'one.example.com',appPassword:'valid-password'});await service.startSync();await service.whenIdle()
  const first=await service.status();assert.equal(first.messageCount,1)
  await service.connect({provider:'imap',email,host:'two.example.com',appPassword:'valid-password'})
  let status=await service.status();assert.equal(status.messageCount,0);assert.notEqual(status.mailboxId,first.mailboxId)
  await service.startSync();await service.whenIdle();const second=await service.status()
  assert.equal((await service.graph()).accountId,second.mailboxId);assert.equal((await service.messages()).accountId,second.mailboxId);assert.equal((await service.message('same_id')).accountId,second.mailboxId)
  await service.selectMailbox(first.selectedMailboxId);status=await service.status();assert.equal(status.mailboxId,first.mailboxId);assert.equal(status.messageCount,1)
  await service.connect({provider:'zoho',email,appPassword:'valid-password'});assert.equal((await service.status()).messageCount,0)
})

test('switching views and queuing another mailbox cannot move a running sync to the other account',async t=>{
  const started=deferred(),release=deferred()
  const fx=await fixture(t,{scanHook:async value=>{if(value.email==='one@gmail.com'){started.resolve();await release.promise}}}),service=createEmailMemoryService({root:fx.root,provider:fx.provider})
  await service.connect({provider:'gmail',email:'one@gmail.com',appPassword:'valid-password'});const first=await service.status();await service.startSync();await started.promise
  await service.connect({provider:'gmail',email:'two@gmail.com',appPassword:'valid-password'});const second=await service.status();await service.startSync()
  assert.equal((await service.status()).activeSyncMailboxIds.length,2)
  release.resolve();await service.whenIdle()
  assert.equal((await service.status()).mailboxId,second.mailboxId);assert.match((await service.messages()).messages[0].subject,/two@gmail.com/)
  await service.selectMailbox(first.selectedMailboxId);assert.equal((await service.status()).sync.status,'complete');assert.match((await service.messages()).messages[0].subject,/one@gmail.com/)
})

test('selected email body requests stay pinned to their originating mailbox while the UI switches',async t=>{
  const bodyStarted=deferred(),release=deferred()
  const fx=await fixture(t,{bodyHook:async value=>{if(value.email==='one@gmail.com'){bodyStarted.resolve();await release.promise}}}),service=createEmailMemoryService({root:fx.root,provider:fx.provider})
  await service.connect({provider:'gmail',email:'one@gmail.com',appPassword:'valid-password'});const first=await service.status();await service.startSync();await service.whenIdle()
  await service.connect({provider:'gmail',email:'two@gmail.com',appPassword:'valid-password'});await service.startSync();await service.whenIdle()
  const second=await service.status();await service.selectMailbox(first.selectedMailboxId)
  const reading=service.message('same_id');await bodyStarted.promise;await service.selectMailbox(second.selectedMailboxId);release.resolve()
  const result=await reading;assert.equal(result.accountId,first.mailboxId);assert.match(result.message.text,/one@gmail.com/);assert.deepEqual(fx.reads,['one@gmail.com'])
})
