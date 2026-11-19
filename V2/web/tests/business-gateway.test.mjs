import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {syncBuiltinESMExports} from 'node:module'
import {request as httpRequest,createServer} from 'node:http'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {GuestAccess} from '../guest/access.mjs'
import {createGuestGateway} from '../guest/gateway.mjs'
import {createBridge,allowedRoute} from '../cloud-bridge.mjs'
const prefix='/api/creator-agent/business'

// These tests exercise identity/routing, not Unix permission emulation. Windows
// cannot report 0600; retain production's fail-closed checks and model only that
// platform-specific file metadata in this isolated test process.
function privateMetadata(t,paths){
  if(process.platform!=='win32')return
  for(const name of ['statSync','lstatSync']){
    const original=fs[name]
    t.mock.method(fs,name,(path,...args)=>{const result=original(path,...args);if(paths.includes(String(path)))result.mode=(result.mode&~0o777)|0o600;return result})
  }
  syncBuiltinESMExports()
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports()})
}
function request(port,path,{method='GET',data,headers={}}={}){
  return new Promise((resolve,reject)=>{const req=httpRequest({hostname:'127.0.0.1',port,path,method,headers:{'Content-Type':'application/json',...headers}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{const text=Buffer.concat(chunks).toString();resolve({status:res.statusCode,headers:res.headers,text,json:()=>JSON.parse(text)})})});req.on('error',reject);req.end(data===undefined?undefined:JSON.stringify(data))})
}
async function listen(t,server){await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))});return server.address().port}

test('guest business requests keep server-selected tenant and strip browser identities',async t=>{
  const root=fs.mkdtempSync(join(tmpdir(),'spur-business-gateway-')),dist=join(root,'dist');fs.mkdirSync(dist);fs.writeFileSync(join(dist,'index.html'),'Spur')
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}))
  const access=new GuestAccess(root),a=access.issue(),b=access.issue(),registry=join(root,'workers.json')
  fs.writeFileSync(registry,JSON.stringify({[a.tenantId]:{port:4300,token:'a'.repeat(43)},[b.tenantId]:{port:4301,token:'b'.repeat(43)}}),{mode:0o600})
  privateMetadata(t,[registry,join(root,'access.json')]);const calls=[]
  const server=createGuestGateway({root,dist,fetcher:async(url,options)=>{calls.push({url,options});return Response.json({workspace:new URL(url).port})}})
  const port=await listen(t,server),headers={Host:'ai.hispurring.com',Origin:'https://ai.hispurring.com'}
  const call=(path,options={})=>request(port,path,{...options,headers:{...headers,...options.headers}})
  async function login(code){const response=await call('/api/guest/login',{method:'POST',data:{code}});assert.equal(response.status,200);return response.headers['set-cookie'][0].split(';')[0]}
  const ca=await login(a.code),cb=await login(b.code)
  assert.equal((await call(prefix+'/modules')).status,401)
  assert.equal((await call(prefix+'/records/clients?query=design%2Fedit',{headers:{Cookie:ca,Authorization:'Bearer forged','X-Spur-Connection':'forged'}})).json().workspace,'4300')
  assert.equal((await call(prefix+'/records/clients',{headers:{Cookie:cb}})).json().workspace,'4301')
  const saved=await call(prefix+'/records/clients',{method:'POST',headers:{Cookie:ca},data:{data:{name:'Private A'},request_id:'client-a'}})
  assert.equal(saved.status,200)
  assert.equal(calls[0].options.headers.Authorization,'Bearer '+'a'.repeat(43))
  assert.equal(calls[1].options.headers.Authorization,'Bearer '+'b'.repeat(43))
  assert.equal(calls[0].options.headers['X-Spur-Connection'],undefined)
  assert(calls[0].url.endsWith('?query=design%2Fedit'))
  assert.equal(JSON.parse(calls[2].options.body).data.name,'Private A')
  assert.equal((await call(prefix+'/settings',{method:'PUT',headers:{Cookie:ca,Origin:'https://evil.example'},data:{ai_enabled:false}})).status,403)
  assert.equal((await call(prefix+'/records/clients',{method:'DELETE',headers:{Cookie:ca}})).status,403)
  assert.equal(calls.length,3)
})

test('cloud bridge forwards business JSON edits without requiring a chat async flag',async t=>{
  const root=fs.mkdtempSync(join(tmpdir(),'spur-business-cloud-')),tokenFile=join(root,'token');fs.writeFileSync(tokenFile,'c'.repeat(43),{mode:0o600});privateMetadata(t,[tokenFile]);t.after(()=>fs.rmSync(root,{recursive:true,force:true}))
  const calls=[];const bridge=createBridge({config:{enabled:true,tokenFile},fetcher:async(url,options)=>{calls.push({url,options});return Response.json({saved:true})}})
  const port=await listen(t,createServer((req,res)=>bridge(req,res,()=>{res.writeHead(404);res.end()})))
  const headers={Host:'127.0.0.1:5174',Origin:'http://127.0.0.1:5174'}
  for(const [path,method,data] of [[prefix+'/settings','PUT',{currency:'HKD'}],[prefix+'/records/clients/'+'a'.repeat(32),'PATCH',{data:{name:'New name'},version:1}],[prefix+'/execute','POST',{name:'business_list',arguments:{kind:'clients'},request_id:'list-clients'}]]){
    assert(allowedRoute(path,method));assert.equal((await request(port,path,{method,data,headers})).status,200)
    assert.deepEqual(JSON.parse(calls.at(-1).options.body),data)
  }
  assert(calls.every(call=>call.options.headers.Authorization==='Bearer '+'c'.repeat(43)))
  assert.equal((await request(port,prefix+'/records/clients?query=design%2Fedit',{headers})).status,200)
  assert(calls.at(-1).url.endsWith('?query=design%2Fedit'))
  assert.equal((await request(port,prefix+'/settings',{method:'DELETE',headers})).status,403)
  assert.equal((await request(port,prefix+'/../email/send',{method:'POST',data:{},headers})).status,403)
  assert.equal(calls.length,4)
})
