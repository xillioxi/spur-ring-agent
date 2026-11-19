import test from 'node:test'
import assert from 'node:assert/strict'
import {Readable,Writable} from 'node:stream'
import {mkdtemp,rm} from 'node:fs/promises'
import {join,resolve,relative,isAbsolute} from 'node:path'
import {handleEmailMemoryRequest,EMAIL_MEMORY_PREFIX as prefix} from './http.mjs'
import {waitForEmailMemoryIdle} from './service.mjs'

class Response extends Writable{
  constructor(){super();this.headers={};this.parts=[];this.statusCode=200;this.headersSent=false}
  _write(chunk,_encoding,done){this.parts.push(Buffer.from(chunk));done()}
  writeHead(status,headers){this.statusCode=status;this.headers=headers;this.headersSent=true;return this}
  json(){return JSON.parse(Buffer.concat(this.parts).toString('utf8'))}
}
async function fixture(t,provider){const root=await mkdtemp(join(process.cwd(),'.spur-email-http-test-'));t.after(async()=>{await waitForEmailMemoryIdle();const part=relative(process.cwd(),resolve(root));assert.ok(!part.startsWith('..')&&!isAbsolute(part));await rm(root,{recursive:true,force:true})});return {root,provider:provider||{status:async()=>({connected:false,oauthAvailable:false})}}}
async function request(options,url,{method='GET',body,headers={}}={}){
  const req=Readable.from(body===undefined?[]:[Buffer.from(typeof body==='string'?body:JSON.stringify(body))]);Object.assign(req,{url,method,headers})
  const res=new Response(),handled=await handleEmailMemoryRequest(req,res,options)
  if(handled&&!res.writableFinished&&!res.destroyed)await new Promise(done=>res.once('finish',done))
  return {res,handled}
}
const jsonHeaders={'content-type':'application/json'}
test('HTTP saves contact context only in its expected mailbox and exposes it in graph search',async t=>{
  const email='owner@gmail.com',contact='alice@studio.test'
  const options=await fixture(t,{status:async()=>({connected:true,email}),scanPage:async()=>({messages:[{id:'context-mail',from:{email:contact},to:[{email}],subject:'Hello',date:'2026-11-17T00:00:00Z'}],hasNextPage:false,mailboxEmail:email})})
  await request(options,`${prefix}/sync`,{method:'POST',headers:jsonHeaders,body:{}});await waitForEmailMemoryIdle()
  const {accountId}= (await request(options,`${prefix}/graph`)).res.json()
  const save=body=>request(options,`${prefix}/contacts`,{method:'PATCH',headers:jsonHeaders,body})
  assert.equal((await save({email:contact,accountId:'stale',relationship:'friends'})).res.statusCode,409)
  assert.equal((await save({email:contact,accountId,relationship:'friends',company:'Studio',role:'Editing'})).res.statusCode,200)
  const graph=(await request(options,`${prefix}/graph?query=editing`)).res.json()
  assert.equal(graph.visiblePeople,1);assert.equal(graph.nodes[1].relationship,'friends');assert.equal(graph.nodes[1].role,'Editing')
  assert.equal((await save({email:contact,accountId,root:'untrusted'})).res.statusCode,400)
})

test('HTTP connect, async full sync, graph, paginated list and plaintext selected message complete the private email flow',async t=>{
  let connected=false
  const email='owner@gmail.com',mail={id:'imap:42:10',threadId:'thread',from:{email:'alice@example.com',name:'Alice'},to:[{email}],cc:[],subject:'Production notes',date:'2026-11-17T03:00:00Z'}
  const provider={status:async()=>({connected,email:connected?email:undefined,oauthAvailable:false}),connectAppPassword:async value=>{assert.equal(value.appPassword,'synthetic-test-app-password');connected=true;return {connected,email}},scanPage:async()=>({messages:[mail],hasNextPage:false,mailboxEmail:email}),getMessage:async()=>({text:'<script>this is literal email text</script>',mailboxEmail:email,html:'never rendered'}),disconnect:async()=>{connected=false;return {connected:false}}}
  const options=await fixture(t,provider)
  assert.equal((await request(options,`${prefix}/status`)).res.json().connection.connected,false)
  const connect=await request(options,`${prefix}/connect`,{method:'POST',headers:jsonHeaders,body:{email,appPassword:'synthetic-test-app-password'}})
  assert.equal(connect.res.statusCode,200);assert.equal(connect.res.json().connection.connected,true);assert.equal(JSON.stringify(connect.res.json()).includes('synthetic-test'),false)
  const sync=await request(options,`${prefix}/sync`,{method:'POST',headers:jsonHeaders,body:{resume:true}})
  assert.equal(sync.res.statusCode,202);assert.equal(sync.res.json().status.sync.status,'running');await waitForEmailMemoryIdle()
  const status=await request(options,`${prefix}/status`);assert.equal(status.res.json().sync.status,'complete')
  const graph=await request(options,`${prefix}/graph?query=alice`);assert.equal(graph.res.json().edges.length,1)
  const list=await request(options,`${prefix}/messages?person=alice%40example.com&query=production&limit=1`);assert.equal(list.res.json().total,1);assert.equal(list.res.json().messages[0].id,mail.id)
  const detail=await request(options,`${prefix}/messages/${encodeURIComponent(mail.id)}`);assert.equal(detail.res.json().message.text,'<script>this is literal email text</script>');assert.equal('html'in detail.res.json().message,false)
  assert.match(detail.res.headers['Content-Type'],/application\/json/);assert.equal(detail.res.headers['Cache-Control'],'no-store')
  const disconnected=await request(options,`${prefix}/connection`,{method:'DELETE'});assert.equal(disconnected.res.json().connection.connected,false)
  assert.equal((await request(options,`${prefix}/messages`)).res.json().total,1)
})

test('HTTP rejects body paths, unknown fields, duplicate queries, traversal, unsupported verbs and non-JSON credentials',async t=>{
  const options=await fixture(t)
  assert.equal((await request(options,'/api/unrelated')).handled,false)
  for(const url of [`${prefix}/messages?query=a&query=b`,`${prefix}/graph?root=C:/private`,`${prefix}/messages/%2e%2e`,`${prefix}/messages/a%2fb`,`${prefix}/messages?limit=10000`,`${prefix}/messages?person=not-email`])assert.ok((await request(options,url)).res.statusCode>=400,url)
  for(const [path,body] of [['connect',{email:'owner@gmail.com',appPassword:'synthetic',root:'C:/private'}],['sync',{resume:'yes'}],['oauth/start',{redirect:'https://evil.example'}]])assert.ok((await request(options,`${prefix}/${path}`,{method:'POST',headers:jsonHeaders,body})).res.statusCode>=400)
  assert.equal((await request(options,`${prefix}/connect`,{method:'POST',body:{email:'owner@gmail.com',appPassword:'synthetic'}})).res.statusCode,415)
  assert.equal((await request(options,`${prefix}/status`,{method:'PATCH',headers:jsonHeaders,body:{}})).res.statusCode,404)
  assert.equal((await request(options,`${prefix}/connection`,{method:'DELETE',headers:{'content-length':'2'},body:{}})).res.statusCode,400)
  const head=await request(options,`${prefix}/status`,{method:'HEAD'});assert.equal(head.res.statusCode,200);assert.equal(head.res.parts.length,0)
})

test('HTTP connection and sync failures never echo provider credential diagnostics',async t=>{
  const secret='synthetic-private-app-password'
  const options=await fixture(t,{status:async()=>({connected:false,oauthAvailable:false}),connectAppPassword:async()=>{throw Error(secret)},startOAuth:async()=>{throw Error(secret)}})
  for(const path of ['connect','oauth/start']){
    const {res}=await request(options,`${prefix}/${path}`,{method:'POST',headers:jsonHeaders,body:path==='connect'?{email:'owner@gmail.com',appPassword:secret}:{}})
    assert.ok(res.statusCode>=400);assert.equal(JSON.stringify(res.json()).includes(secret),false)
  }
  const sync=await request(options,`${prefix}/sync`,{method:'POST',headers:jsonHeaders,body:{}});assert.equal(sync.res.statusCode,409)
})

test('known connection failure codes retain actionable static guidance and canonical HTTP status without upstream diagnostics',async t=>{
  let code='imap_auth_required'
  const secret='synthetic-password-do-not-return'
  const options=await fixture(t,{status:async()=>({connected:false,oauthAvailable:false}),connectAppPassword:async()=>{throw Object.assign(Error('Server said '+secret),{code,status:599,stage:secret,server:secret})}})
  const cases=[['imap_auth_required',401,/app password.*IMAP/i],['imap_unavailable',502,/server address.*region/i],['imap_folders_unavailable',409,/readable folders.*IMAP/i],['invalid_imap_host',422,/public email server hostname/i],['imap_settings_invalid',422,/incoming server/i],['imap_tls_failed',502,/verified secure connection/i],['imap_timeout',504,/did not respond in time/i],['imap_dns_failed',502,/hostname could not be resolved/i],['zoho_auth_required',401,/complete email address.*app password/i],['zoho_imap_disabled',409,/Enable IMAP.*plan or organization/i],['zoho_app_password_required',401,/application.specific password.*regular password/i],['zoho_rate_limited',429,/Zoho temporarily limited/i],['zoho_account_blocked',403,/Zoho blocked.*access policy/i],['zoho_region_mismatch',422,/Zoho server.*account.s region/i],['gmail_all_mail_unavailable',409,/All Mail.*IMAP settings/i],['gmail_permission_required',403,/read.only Gmail permission/i],['outlook_permission_required',403,/Mail\.Read/i]]
  for(const [next,status,message] of cases){
    code=next
    const {res}=await request(options,`${prefix}/connect`,{method:'POST',headers:jsonHeaders,body:{provider:'zoho',email:'owner@example.com',appPassword:secret}})
    assert.equal(res.statusCode,status,code);assert.equal(res.json().code,code);assert.match(res.json().error,message);assert.equal(JSON.stringify(res.json()).includes(secret),false);assert.deepEqual(Object.keys(res.json()).sort(),['code','error'])
  }
  code='unknown_provider_error'
  const unknown=await request(options,`${prefix}/connect`,{method:'POST',headers:jsonHeaders,body:{email:'owner@example.com',appPassword:secret}})
  assert.equal(unknown.res.statusCode,422);assert.equal(unknown.res.json().code,'email_connection_failed');assert.equal(JSON.stringify(unknown.res.json()).includes(secret),false)
})

test('a diagnosed failed mailbox add preserves the other linked mailboxes and selected account',async t=>{
  const account={connected:true,email:'existing@example.com',provider:'imap',accountId:'imap_existing',selectedMailboxId:'existing-slot',mailboxes:[{id:'existing-slot',provider:'imap',providerLabel:'Other email',email:'existing@example.com',accountId:'imap_existing',connected:true}]}
  const options=await fixture(t,{status:async()=>structuredClone(account),connectAppPassword:async()=>{throw Object.assign(Error('unsafe login transcript'),{code:'imap_auth_required',status:401})}})
  const before=(await request(options,`${prefix}/status`)).res.json()
  const failure=await request(options,`${prefix}/connect`,{method:'POST',headers:jsonHeaders,body:{provider:'zoho',email:'new@example.com',appPassword:'synthetic-password'}})
  assert.equal(failure.res.statusCode,401);assert.equal(failure.res.json().code,'imap_auth_required')
  const after=(await request(options,`${prefix}/status`)).res.json()
  assert.deepEqual(after.mailboxes,before.mailboxes);assert.equal(after.selectedMailboxId,before.selectedMailboxId);assert.equal(after.mailboxId,before.mailboxId)
})

test('known browser sign-in setup errors survive the service boundary with no client or token diagnostics',async t=>{
  const secret='synthetic-private-client-secret'
  const options=await fixture(t,{status:async()=>({connected:false}),startOAuth:async()=>{throw Object.assign(Error(secret),{code:'outlook_client_required',status:422})}})
  const result=await request(options,`${prefix}/oauth/start`,{method:'POST',headers:jsonHeaders,body:{provider:'outlook'}})
  assert.equal(result.res.statusCode,422);assert.equal(result.res.json().code,'outlook_client_required');assert.match(result.res.json().error,/application client ID/i);assert.equal(JSON.stringify(result.res.json()).includes(secret),false)
})
