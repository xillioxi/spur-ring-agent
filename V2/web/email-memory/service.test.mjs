import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,readFile,writeFile,readdir} from 'node:fs/promises'
import {join,resolve,relative,isAbsolute} from 'node:path'
import {createHash} from 'node:crypto'
import {createEmailMemoryService,waitForEmailMemoryIdle,EMAIL_MEMORY_LIMITS} from './service.mjs'
import {buildEmailGraph,normalizeMessage} from './graph.mjs'

const self='owner@gmail.com'
const mail=(id,overrides={})=>({id,threadId:id,from:{email:'alice@example.com',name:'Alice'},to:[{email:self}],cc:[],subject:`Mail ${id}`,date:'2026-11-17T01:00:00Z',snippet:'Useful context',...overrides})
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve}}
test('relationship groups use sender evidence, separate companies, and do not label personal mail or co-recipients as friends',()=>{
  const messages=[
    mail('coworker',{from:{email:'alex@spur.test'},to:[{email:'me@spur.test'},{email:'copy@gmail.com'}],snippet:"I'm responsible for video production."}),
    mail('service',{from:{email:'billing@spur.test'},to:[{email:'me@spur.test'}]}),
    mail('external',{from:{email:'sam@studio.test'},to:[{email:'me@spur.test'}]}),
    mail('friend',{from:{email:'pal@gmail.com'},labels:['Friends']}),
  ].map(normalizeMessage)
  const graph=buildEmailGraph(messages,'me@spur.test'),person=email=>graph.nodes.find(node=>node.email===email)
  assert.equal(person('alex@spur.test').relationship,'colleagues');assert.equal(person('alex@spur.test').role,'video production');assert.equal(person('alex@spur.test').evidence[1].messageId,'coworker')
  assert.equal(person('billing@spur.test').relationship,'services');assert.equal(person('sam@studio.test').company,'studio.test')
  assert.equal(person('copy@gmail.com').relationship,'other');assert.equal(person('copy@gmail.com').role,'')
  assert.equal(person('pal@gmail.com').relationship,'friends')
  const corrected=buildEmailGraph(messages,'me@spur.test',{query:'editing',profiles:{'sam@studio.test':{relationship:'friends',company:'Studio',role:'Editing'}}})
  assert.equal(corrected.visiblePeople,1);assert.equal(corrected.nodes[1].relationship,'friends');assert.equal(corrected.nodes[1].contextSource,'confirmed')
  const crowded=[...Array.from({length:310},(_,index)=>normalizeMessage(mail(`bulk-${index}`,{from:{email:`notice${index}@company.test`}}))),normalizeMessage(mail('rare-friend',{from:{email:'rare@gmail.com'},labels:['Friends']}))]
  const filtered=buildEmailGraph(crowded,self,{relationship:'friends'})
  assert.equal(filtered.visiblePeople,1);assert.equal(filtered.nodes[1].email,'rare@gmail.com');assert.equal(filtered.relationshipCounts.auto,311)
  const subdomain=buildEmailGraph([normalizeMessage(mail('system',{from:{email:'account-security-noreply@accountprotection.microsoft.com'}})),normalizeMessage(mail('uk',{from:{email:'alex@team.studio.co.uk'}}))],self)
  assert.equal(subdomain.nodes.find(node=>node.email.startsWith('account-security')).relationship,'services');assert.equal(subdomain.nodes.find(node=>node.email.startsWith('account-security')).company,'microsoft.com')
  assert.equal(subdomain.nodes.find(node=>node.email.startsWith('alex@')).company,'studio.co.uk')
})
test('contact corrections persist through sync and reject stale mailbox and unknown contact writes',async t=>{
  const {service,root}=await fixture(t);await service.startSync();await service.whenIdle()
  const {accountId}=await service.graph()
  await assert.rejects(service.updateContact({email:'alice@example.com',accountId:'wrong',relationship:'friends'}),{status:409})
  await assert.rejects(service.updateContact({email:'absent@example.com',accountId,relationship:'friends'}),{status:404})
  assert.throws(()=>service.updateContact({email:'alice@example.com',accountId,relationship:'invalid'}),{status:400})
  await service.updateContact({email:'alice@example.com',accountId,relationship:'colleagues',company:'Spur',role:'Video production'})
  await service.startSync();await service.whenIdle()
  const node=(await service.graph()).nodes.find(node=>node.email==='alice@example.com')
  assert.equal(node.relationship,'colleagues');assert.equal(node.role,'Video production')
  const file=(await readdir(root)).find(name=>/^mailbox-/.test(name)),saved=JSON.parse(await readFile(join(root,file),'utf8'))
  assert.equal(saved.profiles['alice@example.com'].company,'Spur')
  await service.updateContact({email:'alice@example.com',accountId,relationship:'auto'})
  assert.equal((await service.graph()).nodes.find(node=>node.email==='alice@example.com').relationship,'company')
})
async function fixture(t,{provider:given,...extra}={}){
  const root=await mkdtemp(join(process.cwd(),'.spur-email-memory-test-'))
  t.after(async()=>{await waitForEmailMemoryIdle();const part=relative(process.cwd(),resolve(root));assert.ok(!part.startsWith('..')&&!isAbsolute(part));await rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:100})})
  const provider=given||{status:async()=>({connected:true,email:self,oauthAvailable:false}),scanPage:async()=>({messages:[mail('first')],hasNextPage:false,mailboxEmail:self}),getMessage:async()=>({text:'Actual plaintext body',mailboxEmail:self})}
  return {root,provider,service:createEmailMemoryService({root,provider,...extra})}
}

test('graph links actual sender to recipients, counts distinct messages, and never infers co-recipient friendships',()=>{
  const first=normalizeMessage(mail('1',{to:[{email:self},{email:'bob@example.com'}],cc:[{email:'bob@example.com'},{email:'carol@example.com'}]})),second=normalizeMessage(mail('2'))
  const graph=buildEmailGraph([first,second],self)
  assert.equal(graph.totalPeople,3);assert.equal(graph.nodes.find(node=>node.email==='alice@example.com').messageCount,2)
  assert.equal(graph.edges.find(edge=>edge.source==='alice@example.com'&&edge.target===self).weight,2)
  assert.equal(graph.edges.find(edge=>edge.source==='alice@example.com'&&edge.target==='bob@example.com').weight,1)
  assert.equal(graph.edges.some(edge=>edge.source==='bob@example.com'&&edge.target==='carol@example.com'),false)
  assert.deepEqual(graph.edges.find(edge=>edge.target===self).messageIds,['1','2'])
})

test('graph search occurs before the visible contact limit and message IDs remain bounded evidence',()=>{
  const messages=Array.from({length:360},(_,index)=>normalizeMessage(mail(String(index),{from:{email:`person${index}@example.com`,name:`Person ${index}`}})))
  assert.equal(buildEmailGraph(messages,self).nodes.length,300)
  const filtered=buildEmailGraph(messages,self,{query:'person359'})
  assert.equal(filtered.nodes.some(node=>node.email==='person359@example.com'),true)
  assert.equal(filtered.totalPeople,360);assert.equal(filtered.visiblePeople,1);assert.equal(filtered.truncated,false)
})

test('unsent drafts stay searchable but never establish communication edges or contact counts',async t=>{
  const messages=[mail('draft',{from:{email:self},to:[{email:'not-contacted@example.com'}],labels:['DRAFT']})]
  const graph=buildEmailGraph(messages.map(normalizeMessage),self)
  assert.equal(graph.edges.length,0);assert.equal(graph.totalPeople,0);assert.equal(graph.excludedDraftCount,1);assert.equal(graph.totalMessages,1)
  const provider={status:async()=>({connected:true,email:self}),scanPage:async()=>({messages,hasNextPage:false,mailboxEmail:self})}
  const {service}=await fixture(t,{provider});await service.startSync();await service.whenIdle()
  assert.equal((await service.status()).peopleCount,0);assert.equal((await service.messages({query:'not-contacted'})).total,1)
})

test('full sync traverses pages, deduplicates records and persists messages without the provider cursor in public status',async t=>{
  const calls=[]
  const provider={status:async()=>({connected:true,email:self,oauthAvailable:true}),scanPage:async({cursor})=>{calls.push(cursor);return cursor?{messages:[mail('second')],hasNextPage:false,mailboxEmail:self}:{messages:[mail('first')],hasNextPage:true,nextCursor:'private-provider-cursor',estimatedTotal:2,mailboxEmail:self}}}
  const {service,root}=await fixture(t,{provider})
  assert.equal((await service.startSync()).sync.status,'running')
  await service.whenIdle()
  const status=await service.status()
  assert.equal(status.sync.status,'complete');assert.equal(status.messageCount,2);assert.equal(status.sync.pagesFetched,2)
  assert.deepEqual(calls,[undefined,'private-provider-cursor'])
  assert.equal(JSON.stringify(status).includes('private-provider-cursor'),false)
  const files=await readdir(root),file=files.find(file=>/^mailbox-/.test(file))
  assert.equal(JSON.parse(await readFile(join(root,file),'utf8')).messages.length,2)
  const graph=await service.graph();assert.equal(graph.edges.find(edge=>edge.target===self).weight,2)
})

test('rate-limited sync preserves its durable checkpoint, redacts provider errors and resumes from the saved cursor',async t=>{
  let limited=true;const calls=[]
  const provider={status:async()=>({connected:true,email:self}),scanPage:async({cursor})=>{calls.push(cursor);if(cursor&&limited)throw Object.assign(new Error('secret-password-in-provider-diagnostics'),{status:429});return cursor?{messages:[mail('second')],hasNextPage:false,mailboxEmail:self}:{messages:[mail('first')],hasNextPage:true,nextCursor:'page-two',mailboxEmail:self}}}
  const {service}=await fixture(t,{provider})
  await service.startSync();await service.whenIdle()
  let status=await service.status();assert.equal(status.sync.status,'blocked',JSON.stringify(status.sync));assert.equal(status.messageCount,1);assert.equal(status.sync.resumable,true);assert.equal(JSON.stringify(status).includes('secret-password'),false)
  limited=false;await service.startSync();await service.whenIdle();status=await service.status()
  assert.equal(status.sync.status,'complete');assert.equal(status.messageCount,2);assert.deepEqual(calls,[undefined,'page-two','page-two'])
})

test('metadata and graph are isolated when Gmail accounts switch, then remain browsable after disconnect',async t=>{
  let email=self,connected=true
  const provider={status:async()=>({connected,email}),scanPage:async()=>({messages:[mail(email===self?'first':'other',{to:[{email}]})],hasNextPage:false,mailboxEmail:email}),disconnect:async()=>{connected=false;return {connected:false}}}
  const {service}=await fixture(t,{provider})
  await service.startSync();await service.whenIdle()
  email='second@gmail.com';assert.equal((await service.status()).messageCount,0)
  await service.startSync();await service.whenIdle()
  assert.deepEqual((await service.messages()).messages.map(message=>message.id),['other'])
  email=self;assert.deepEqual((await service.messages()).messages.map(message=>message.id),['first'])
  await service.disconnect();assert.equal((await service.status()).connection.connected,false);assert.equal((await service.messages()).total,1)
  await assert.rejects(service.message('first'),{status:409})
})

test('an account change during an in-flight page cannot blend the new mailbox into the old graph',async t=>{
  let email=self;const started=deferred(),release=deferred()
  const provider={status:async()=>({connected:true,email}),scanPage:async()=>{started.resolve();await release.promise;return {messages:[mail('foreign')],hasNextPage:false,mailboxEmail:'other@gmail.com'}}}
  const {service}=await fixture(t,{provider})
  await service.startSync();await started.promise;email='other@gmail.com';release.resolve();await service.whenIdle()
  assert.equal((await service.status()).messageCount,0)
  email=self;assert.equal((await service.status()).messageCount,0);assert.notEqual((await service.status()).sync.status,'complete')
})

test('message list supports contact/query filtering and pagination across the full stored cache; bodies stay on demand',async t=>{
  let reads=0
  const provider={status:async()=>({connected:true,email:self}),scanPage:async()=>({messages:[mail('1'),mail('2',{subject:'Travel plan'}),mail('3',{from:{email:'bob@example.com'}})],hasNextPage:false,mailboxEmail:self}),getMessage:async()=>{reads++;return {text:'<script>literal text</script>'+'.'.repeat(EMAIL_MEMORY_LIMITS.maxBodyCharacters),html:'<img src="https://remote.example/tracker">',accessToken:'never-return',mailboxEmail:self}}}
  const {service,root}=await fixture(t,{provider})
  await service.startSync();await service.whenIdle();assert.equal(reads,0)
  const first=await service.messages({person:'alice@example.com',limit:1});assert.equal(first.total,2);assert.equal(first.hasMore,true)
  const second=await service.messages({person:'alice@example.com',limit:1,cursor:first.nextCursor});assert.equal(second.messages[0].id,'2')
  assert.equal((await service.messages({query:'Travel'})).total,1)
  const detail=await service.message('1');assert.equal(reads,1);assert.equal(detail.message.bodyTruncated,true);assert.equal(detail.message.text.length,EMAIL_MEMORY_LIMITS.maxBodyCharacters);assert.equal('html'in detail.message,false);assert.equal('accessToken'in detail.message,false)
  const stored=await readFile(join(root,(await readdir(root)).find(name=>/^mailbox-/.test(name))),'utf8');assert.equal(stored.includes('literal text'),false)
})

test('restart restores interrupted sync as partial and hides its private checkpoint',async t=>{
  const {root,provider}=await fixture(t)
  const otherRoot=await mkdtemp(join(root,'restart-'))
  const hash=createHash('sha256').update(self).digest('hex').slice(0,32)
  await writeFile(join(otherRoot,'mailboxes.json'),JSON.stringify({schemaVersion:1,activeEmail:self}))
  await writeFile(join(otherRoot,`mailbox-${hash}.json`),JSON.stringify({schemaVersion:1,email:self,messages:[mail('1')],sync:{status:'running',pagesFetched:1,nextCursor:'private-restart-cursor',seenIds:['1']}}))
  const service=createEmailMemoryService({root:otherRoot,provider})
  const status=await service.status();assert.equal(status.sync.status,'partial');assert.equal(status.sync.resumable,true);assert.equal(status.messageCount,1);assert.equal(JSON.stringify(status).includes('private-restart-cursor'),false)
})

test('repeated provider cursors stop without erasing successful pages or reporting complete',async t=>{
  const provider={status:async()=>({connected:true,email:self}),scanPage:async()=>({messages:[mail('1')],hasNextPage:true,nextCursor:'same-page',mailboxEmail:self})}
  const {service}=await fixture(t,{provider})
  await service.startSync();await service.whenIdle();const status=await service.status()
  assert.equal(status.sync.status,'partial');assert.equal(status.messageCount,1);assert.equal(status.sync.pagesFetched,1)
})

test('refresh reconciles deleted messages only after its feed completes and refuses credential changes during sync',async t=>{
  let refresh=false;const started=deferred(),release=deferred()
  const provider={status:async()=>({connected:true,email:self}),scanPage:async()=>{if(refresh){started.resolve();await release.promise}return {messages:refresh?[mail('2')]:[mail('1'),mail('2')],hasNextPage:false,mailboxEmail:self}},connectAppPassword:async()=>({connected:true,email:self})}
  const {service}=await fixture(t,{provider})
  await service.startSync();await service.whenIdle();refresh=true;await service.startSync();await started.promise
  assert.equal((await service.messages()).total,2)
  await assert.rejects(service.connect({email:self,appPassword:'synthetic'}),{status:409});await assert.rejects(service.disconnect(),{status:409})
  release.resolve();await service.whenIdle();assert.equal((await service.messages()).total,1)
})

test('long full sync yields a queued batch and continues to the true end without manual restart',async t=>{
  const originalNow=Date.now;let shifted=false,calls=0
  t.after(()=>{Date.now=originalNow})
  const provider={status:async()=>({connected:true,email:self}),scanPage:async({cursor})=>{calls++;if(!cursor){shifted=true;Date.now=()=>originalNow()+EMAIL_MEMORY_LIMITS.maxRunMs+10;return {messages:[mail('1')],hasNextPage:true,nextCursor:'next-batch',mailboxEmail:self}}return {messages:[mail('2')],hasNextPage:false,mailboxEmail:self}}}
  const {service}=await fixture(t,{provider});await service.startSync();await service.whenIdle()
  assert.equal(shifted,true);assert.equal(calls,2);assert.equal((await service.status()).sync.status,'complete');assert.equal((await service.messages()).total,2)
})

test('replacing the Gmail access method restarts its scan instead of reusing an incompatible checkpoint',async t=>{
  let method='gmail_imap',limited=true;const calls=[]
  const provider={status:async()=>({connected:true,email:self,method}),scanPage:async({cursor})=>{calls.push({method,cursor});if(method==='gmail_imap'&&cursor)throw Object.assign(Error('limited'),{status:429});return method==='gmail_imap'?{messages:[mail('1')],hasNextPage:true,nextCursor:'imap-checkpoint',mailboxEmail:self}:{messages:[mail('1'),mail('2')],hasNextPage:false,mailboxEmail:self}}}
  const {service}=await fixture(t,{provider});await service.startSync();await service.whenIdle()
  method='gmail_oauth';await service.startSync();await service.whenIdle()
  assert.deepEqual(calls.at(-1),{method:'gmail_oauth',cursor:undefined});assert.equal((await service.status()).sync.status,'complete');assert.equal((await service.messages()).total,2)
})

test('IMAP copies with matching message identity count once and retain a current source ID after refresh',async t=>{
  let refresh=false
  const copy=id=>mail(id,{internetMessageId:'<same-message@example.com>',subject:'Same delivered email'})
  const distinct=mail('different',{internetMessageId:'<different-message@example.com>'})
  const provider={status:async()=>({connected:true,email:self,provider:'imap',accountId:'imap_server_one',scope:'Inbox and Sent'}),scanPage:async({cursor})=>refresh?{messages:[copy('folder-two'),distinct],hasNextPage:false,mailboxEmail:self,mailboxAccountId:'imap_server_one'}:cursor?{messages:[copy('folder-two'),distinct],hasNextPage:false,mailboxEmail:self,mailboxAccountId:'imap_server_one'}:{messages:[copy('folder-one')],hasNextPage:true,nextCursor:'sent-folder',mailboxEmail:self,mailboxAccountId:'imap_server_one'}}
  const {service}=await fixture(t,{provider});await service.startSync();await service.whenIdle()
  assert.equal((await service.messages()).total,2);assert.equal((await service.graph()).edges.find(edge=>edge.target===self).weight,2)
  refresh=true;await service.startSync();await service.whenIdle()
  const messages=(await service.messages()).messages;assert.equal(messages.some(message=>message.id==='folder-two'),true);assert.equal(messages.some(message=>message.id==='folder-one'),false);assert.equal((await service.graph()).scope,'Inbox and Sent')
})
