import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer,request as httpRequest} from 'node:http'
import {mkdtempSync,writeFileSync,chmodSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createBridge,allowedRoute} from '../cloud-bridge.mjs'
async function setup(t,fetcher,mode=0o600){
 const root=mkdtempSync(join(tmpdir(),'spur-bridge-test-')),file=join(root,'token');writeFileSync(file,'a'.repeat(43),{mode});chmodSync(file,mode)
 const bridge=createBridge({config:{enabled:true,tokenFile:file},fetcher})
 const server=createServer((req,res)=>bridge(req,res,()=>{res.writeHead(404);res.end()}));await new Promise(r=>server.listen(0,'127.0.0.1',r))
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(root,{recursive:true,force:true})})
 return (path,options={})=>new Promise((resolve,reject)=>{
  const req=httpRequest({hostname:'127.0.0.1',port:server.address().port,path,method:options.method||'GET',headers:{Host:'127.0.0.1:5174',Origin:'http://127.0.0.1:5174',...options.headers}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:res.headers})))})
  req.on('error',reject);req.end(options.body)
 })
}
test('only intended task and result routes are allowed',()=>{assert(allowedRoute('/api/creator-agent/chat','POST'));assert(!allowedRoute('/api/creator-agent/email/send','POST'));assert(!allowedRoute('/api/creator-agent/connections/profile','POST'));assert(!allowedRoute('/api/creator-agent/chat','GET'))})

test('video analysis stays local even when chat uses the cloud bridge',async()=>{
 let forwarded=false,continued=false
 const bridge=createBridge({config:{enabled:true,tokenFile:'/nonexistent-private-token'},fetcher:async()=>{forwarded=true;throw Error('must stay local')}})
 await bridge({url:'/api/creator-agent/video-analysis/uploads?filename=test.mp4',method:'POST',headers:{host:'127.0.0.1:5174',origin:'http://127.0.0.1:5174'}},{},()=>{continued=true})
 assert.equal(continued,true);assert.equal(forwarded,false)
})

test('email Memory and credentials remain local when chat uses the cloud bridge',async()=>{
 let forwarded=false,continued=false
 const bridge=createBridge({config:{enabled:true,tokenFile:'/nonexistent-private-token'},fetcher:async()=>{forwarded=true;throw Error('must stay local')}})
 await bridge({url:'/api/creator-agent/email-memory/connect',method:'POST',headers:{host:'127.0.0.1:5174',origin:'http://127.0.0.1:5174'}},{},()=>{continued=true})
 assert.equal(continued,true);assert.equal(forwarded,false)
})
test('server adds private token, ignores client credentials, preserves async response',async t=>{
 let count=0;const request=await setup(t,async(url,options)=>{count++;assert.equal(url,'https://api.hispurring.com/api/creator-agent/chat');assert.equal(options.headers.Authorization,'Bearer '+'a'.repeat(43));assert.equal(options.headers['X-Spur-Connection'],undefined);return Response.json({runId:'test-id',status:'running'},{status:202})})
 const r=await request('/api/creator-agent/chat',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer client-value','x-spur-connection':'untrusted'},body:JSON.stringify({async:true,message:'test'})});assert.equal(r.status,202);assert.equal((await r.json()).runId,'test-id');assert.equal(count,1)
})
test('cross-origin requests and unapproved routes never reach cloud',async t=>{
 let count=0;const request=await setup(t,async()=>{count++;return Response.json({})})
 for(const [path,headers] of [['/api/creator-agent/health',{Origin:'https://evil.example'}],['/api/creator-agent/health',{'sec-fetch-site':'cross-site'}],['/api/creator-agent/email/status',{}],['/api/creator-agent/tasks/%2e%2e/health',{}]])assert.equal((await request(path,{headers})).status,403)
 assert.equal(count,0)
})
test('unsafe token permissions fail closed without reading or forwarding credentials',async t=>{let called=false;const request=await setup(t,async()=>{called=true;return Response.json({})},0o644);const r=await request('/api/creator-agent/health');assert.equal(r.status,503);assert(!called);assert(!(await r.text()).includes('a'.repeat(43)))})
test('artifact streaming keeps file headers and refuses redirects',async t=>{
 const request=await setup(t,async url=>url.endsWith('/health')?new Response(null,{status:302,headers:{Location:'https://evil.example'}}):new Response('artifact-data',{headers:{'Content-Type':'text/plain','Content-Disposition':'attachment; filename="report.md"'}}))
 const r=await request('/api/creator-agent/artifacts/12345678-1234-1234-1234-123456789abc');assert.equal(await r.text(),'artifact-data');assert.match(r.headers.get('content-disposition'),/report.md/);assert.equal((await request('/api/creator-agent/health')).status,502)
})
test('synchronous posts are rejected without execution',async t=>{let called=false;const request=await setup(t,async()=>{called=true;return Response.json({})});assert.equal((await request('/api/creator-agent/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:'test'})})).status,400);assert(!called)})
