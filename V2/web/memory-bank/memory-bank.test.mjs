import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {join,relative,isAbsolute,resolve} from 'node:path'
import {Readable,Writable} from 'node:stream'
import {projectEmail,projectWhatsApp} from './projections.mjs'
import {createMemoryBank} from './service.mjs'
import {handleMemoryBankRequest,MEMORY_BANK_PREFIX as prefix,memoryBankReadToolRoute} from './http.mjs'
import {createEmailMemoryService} from '../email-memory/service.mjs'
import {createWhatsAppService} from '../whatsapp/service.mjs'
const owner='me@gmail.com',mail=(id,email='alice@studio.test',overrides={})=>({id,from:{email,name:'Alice'},to:[{email:owner}],cc:[],labels:[],subject:'Production',snippet:'I am responsible for editing. Bring the camera.',date:'2026-11-17T03:00:00.000Z',...overrides})
const snapshot={accounts:[{accountId:'first',email:owner,messages:[mail('one'),mail('draft','draft@studio.test',{labels:['DRAFT']})],profiles:{}},{accountId:'second',email:'me@outlook.com',messages:[mail('two')],profiles:{}}]}
const emptyReaders={emailReader:async()=>snapshot,whatsappReader:async()=>({accounts:[]}),projectReader:async()=>[{id:'project-one',name:'Production project',description:'A real project record',status:'active',updated:1794884400,archived:false}]}
async function directory(t){const root=await mkdtemp(join(process.cwd(),'.spur-bank-test-'));t.after(async()=>{const part=relative(process.cwd(),resolve(root));assert.ok(!part.startsWith('..')&&!isAbsolute(part));await rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:100})});return root}

test('central projections keep every contact beyond the graph cap, preserve provenance and exclude drafts',()=>{
  const result=projectEmail(snapshot),alice=result.entries.find(entry=>entry.title==='Alice')
  assert.equal(result.entries.length,2) // Alice plus the other account identity seen as a recipient.
  assert.equal(alice.sources.length,2);assert.equal(alice.status,'inferred');assert.match(alice.content,/Responsible for: editing/)
  assert.equal(result.entries.some(entry=>entry.content.includes('draft@')),false)
  const many=projectEmail({accounts:[{accountId:'many',email:owner,profiles:{},messages:Array.from({length:350},(_,index)=>mail('m'+index,`person${index}@studio.test`))}]})
  assert.equal(many.entries.length,350)
  const wa=projectWhatsApp({accounts:[{accountId:'123@s.whatsapp.net',messageCount:2,chats:[{id:'456@s.whatsapp.net',name:'Alice',role:'',company:'',messageCount:2,lastMessageAt:1794884400,preview:'Hello',messageId:'source-message'}]}]})
  assert.notEqual(wa.entries[0].id,alice.id);assert.equal(wa.entries[0].status,'observed');assert.equal(wa.entries[0].sources[0].recordId,'source-message')
})

test('saved memories persist on reopen, corrections retain sources and reject stale versions and invented sources',async t=>{
  const root=await directory(t),service=createMemoryBank({root,...emptyReaders})
  const before=await service.list(),alice=before.entries.find(entry=>entry.title==='Alice')
  assert.equal(before.counts.projects,1);assert.match(before.activity[0].content,/camera/)
  const saved=await service.save({id:alice.id,category:'people',title:'Alice',content:'Editor at the studio; confirm dates before booking.',version:0})
  assert.equal(saved.entry.version,1);assert.equal(saved.entry.status,'confirmed');assert.equal(saved.entry.sources.length,2)
  const reopened=createMemoryBank({root,...emptyReaders})
  assert.equal((await reopened.list({query:'confirm dates'})).entries[0].content,saved.entry.content)
  await assert.rejects(service.save({id:alice.id,category:'people',title:'Alice',content:'Stale update',version:0}),{status:409})
  await assert.rejects(service.save({category:'knowledge',title:'Unknown source',content:'Test',version:0,sourceId:'invented'}),{status:404})
  const observed=before.activity[0]
  const note=await service.save({sourceId:observed.id,category:'knowledge',title:'Production reminder',content:observed.content,version:0})
  assert.equal(note.entry.sources[0].recordId,observed.source.recordId)
  const isolated=createMemoryBank({root:await directory(t),...emptyReaders})
  assert.equal((await isolated.list({category:'knowledge'})).total,0)
  await assert.rejects(service.save({category:'knowledge',title:'Root injection',content:'No',version:0,root:'other'}),{status:400})
})

test('partial source failures remain visible and pagination searches the full bank',async t=>{
  const service=createMemoryBank({root:await directory(t),...emptyReaders,whatsappReader:()=>{throw Error('private details must not leak')}})
  const first=await service.list({limit:'1'}),second=await service.list({limit:'1',cursor:first.nextCursor})
  assert.notEqual(first.entries[0].id,second.entries[0].id);assert.equal(first.warnings.length,1);assert.doesNotMatch(JSON.stringify(first),/private details/)
  assert.equal((await service.list({query:'editing',category:'people'})).total,1)
  await assert.rejects(service.list({cursor:'../secret'}),{status:400})
})

test('real source snapshots read caches without selecting accounts, fetching bodies, or starting WhatsApp',async t=>{
  const root=await directory(t);let bodies=0,starts=0
  const email=createEmailMemoryService({root:join(root,'email-memory'),provider:{status:async()=>({connected:true,email:owner}),scanPage:async()=>({messages:[mail('saved')],hasNextPage:false,mailboxEmail:owner}),getMessage:async()=>{bodies++;return {text:'Not requested'}}}})
  await email.startSync();await email.whenIdle();const before=await email.status(),projection=await email.memorySnapshot(),after=await email.status()
  assert.equal(projection.accounts[0].messages.length,1);assert.equal(after.mailboxId,before.mailboxId);assert.equal(bodies,0)
  const wa=createWhatsAppService({root:join(root,'whatsapp-memory'),adapter:async()=>{starts++;throw Error('Should not start')}})
  await wa.importChat({title:'Studio chat',content:'17/11/2026, 10:00 - Alice: Bring camera',dateOrder:'DMY',timezoneOffset:0})
  const source=await wa.memorySnapshot();assert.equal(source.accounts[0].chats[0].preview,'Bring camera');assert.equal(starts,0)
  const bank=createMemoryBank({root,projectReader:async()=>[]})
  const result=await bank.list();assert.equal(result.coverage.emailMessages,1);assert.equal(result.coverage.whatsappMessages,1)
})

class Response extends Writable{constructor(){super();this.parts=[]} _write(chunk,encoding,done){this.parts.push(chunk);done()}writeHead(status,headers){this.status=status;this.headers=headers}json(){return JSON.parse(Buffer.concat(this.parts).toString())}}
test('HTTP memory flow rejects unexpected input and tool authorization stays read-only',async t=>{
  const options={root:await directory(t),...emptyReaders}
  async function request(method,path,body){const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);Object.assign(req,{method,url:path,headers:{'content-type':'application/json'}});const res=new Response();await handleMemoryBankRequest(req,res,options);return res}
  const created=await request('POST',prefix+'/entries',{category:'about',title:'How I work',content:'Review ideas before starting a task.',version:0})
  assert.equal(created.status,200)
  const found=await request('GET',prefix+'/entries?query=Review');assert.equal(found.json().entries[0].id,created.json().entry.id);assert.equal(found.headers['Cache-Control'],'no-store')
  assert.equal((await request('GET',prefix+'/entries?root=elsewhere')).status,400)
  assert.equal((await request('POST',prefix+'/entries',null)).status,400)
  assert.equal(memoryBankReadToolRoute(prefix+'/entries','GET'),true);assert.equal(memoryBankReadToolRoute(prefix+'/entries','POST'),false);assert.equal(memoryBankReadToolRoute(prefix+'/credentials','GET'),false)
})
