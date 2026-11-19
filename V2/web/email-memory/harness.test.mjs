import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import plugin from '../../agent/tools/email-memory/index.cjs'
import {emailMemoryReadToolRoute as allowed,EMAIL_MEMORY_PREFIX as prefix} from './tool-routes.mjs'

test('email Memory tool scopes allow only read routes and never connection or sync actions',()=>{
  for(const path of ['/status','/graph','/messages','/messages/gmail_message_123'])assert.equal(allowed(prefix+path,'GET'),true)
  assert.equal(allowed(prefix+'/messages/ms_'+ 'A'.repeat(700),'GET'),true)
  assert.equal(allowed(prefix+'/messages/'+ 'A'.repeat(1025),'GET'),false)
  for(const [path,method]of [['/connect','POST'],['/sync','POST'],['/connection','DELETE'],['/oauth/start','POST'],['/messages','POST'],['/messages/../secret','GET'],['/messages/x/body','GET']])assert.equal(allowed(prefix+path,method),false)
  assert.equal(allowed(prefix+'/mailboxes/select','POST'),false)
  assert.equal(allowed(prefix+'/contacts','PATCH'),false)
})
test('native email Memory tools use short-lived scoped reads and preserve source IDs',async t=>{
  const requests=[]
  const server=createServer((req,res)=>{requests.push({url:req.url,method:req.method,token:req.headers['x-spur-memory-tool']});res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({messages:[],nextCursor:'30',sourceId:'source_1'}))})
  await new Promise(done=>server.listen(0,'127.0.0.1',done));t.after(()=>{server.closeAllConnections();server.close()})
  const previous={endpoint:process.env.SPUR_EMAIL_MEMORY_ENDPOINT,token:process.env.SPUR_EMAIL_MEMORY_TOOL_TOKEN}
  t.after(()=>{for(const[name,value]of [['SPUR_EMAIL_MEMORY_ENDPOINT',previous.endpoint],['SPUR_EMAIL_MEMORY_TOOL_TOKEN',previous.token]]){if(value===undefined)delete process.env[name];else process.env[name]=value}})
  process.env.SPUR_EMAIL_MEMORY_ENDPOINT=`http://127.0.0.1:${server.address().port}${prefix}`;process.env.SPUR_EMAIL_MEMORY_TOOL_TOKEN='synthetic-scoped-memory-token'
  const tools=new Map();await plugin.apply({tools:{register(tool){tools.set(tool.name,tool)}}})
  assert.equal(tools.size,8)
  const result=await tools.get('email_memory_search').execute({person:'person@example.com',query:'Travel',cursor:'30'})
  assert.equal(result.ok,true);assert.equal(result.result.sourceId,'source_1');assert.equal(requests[0].token,'synthetic-scoped-memory-token');assert.equal(requests[0].method,'GET')
  const url=new URL(requests[0].url,'http://localhost');assert.equal(url.searchParams.get('person'),'person@example.com');assert.equal(url.searchParams.get('query'),'Travel')
  assert.equal((await tools.get('email_memory_message').execute({id:'../../secret'})).ok,false);assert.equal(requests.length,1)
  assert.equal((await tools.get('email_memory_network').execute({query:'production',relationship:'colleagues'})).ok,true)
  const graph=new URL(requests[1].url,'http://localhost');assert.equal(graph.searchParams.get('query'),'production');assert.equal(graph.searchParams.get('relationship'),'colleagues')
  assert.equal((await tools.get('email_memory_network').execute({relationship:'invalid'})).ok,false);assert.equal(requests.length,2)
  assert.equal((await tools.get('whatsapp_memory_chats').execute({query:'camera',relationship:'colleagues'})).ok,true)
  const whatsapp=new URL(requests[2].url,'http://localhost');assert.equal(whatsapp.pathname,'/api/creator-agent/whatsapp-memory/chats');assert.equal(whatsapp.searchParams.get('relationship'),'colleagues')
  assert.equal((await tools.get('whatsapp_memory_messages').execute({accountId:'imported',chatId:'export:abc',query:'shot list'})).ok,true)
  assert.equal(new URL(requests[3].url,'http://localhost').searchParams.get('accountId'),'imported')
  assert.equal((await tools.get('memory_bank_search').execute({query:'editing',category:'knowledge'})).ok,true)
  const memory=new URL(requests[4].url,'http://localhost');assert.equal(memory.pathname,'/api/creator-agent/memory-bank/entries');assert.equal(memory.searchParams.get('category'),'knowledge');assert.equal(requests[4].token,'synthetic-scoped-memory-token');assert.equal(requests[4].method,'GET')
  assert.equal((await tools.get('memory_bank_search').execute({category:'credentials'})).ok,false);assert.equal(requests.length,5)
})
