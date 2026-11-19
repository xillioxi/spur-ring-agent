import test from 'node:test'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {createServer} from 'node:net'
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {allowedBusinessRoute} from '../business-routes.mjs'

const prefix = '/api/creator-agent/business'
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(),'spur-business-http-'))
  const port = await new Promise(resolve=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})})
  const empty = join(root,'empty.env'); writeFileSync(empty,'')
  const token = 'B'.repeat(43)
  const child = spawn(process.execPath,[fileURLToPath(new URL('../server.mjs',import.meta.url))],{
    env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,HOME:root,HOST:'127.0.0.1',PORT:String(port),SPUR_RUNTIME_ROOT:root,SPUR_CONFIG_FILE:empty,SPUR_CREATOR_AGENT_TOKEN:token,
      SPUR_BUSINESS_PYTHON:process.env.SPUR_BUSINESS_PYTHON || (process.platform==='win32'?'python':'python3')},stdio:['ignore','pipe','pipe']})
  let diagnostic = ''; child.stderr.on('data',chunk=>{diagnostic+=chunk})
  t.after(async()=>{child.kill('SIGTERM');if(child.exitCode===null)await new Promise(resolve=>child.once('exit',resolve));rmSync(root,{recursive:true,force:true})})
  const base = `http://127.0.0.1:${port}`, headers = {Authorization:`Bearer ${token}`,'Content-Type':'application/json'}
  let up = false
  for(let i=0;i<100;i++){try{await fetch(base+'/');up=true;break}catch{await new Promise(resolve=>setTimeout(resolve,50))}}
  assert.ok(up,diagnostic)
  const request = async(path,method='GET',data,extra={})=>{
    const r=await fetch(base+path,{method,headers:{...headers,...extra},body:data===undefined?undefined:JSON.stringify(data)})
    const text=await r.text();let value;try{value=JSON.parse(text)}catch{value=text}
    return {status:r.status,data:value,text,headers:r.headers}
  }
  return {request,base}
}

test('business allowlist permits only explicit internal record operations',()=>{
  assert(allowedBusinessRoute(prefix+'/records/clients','POST'))
  assert(allowedBusinessRoute(prefix+'/records/clients/'+'a'.repeat(32),'PATCH'))
  assert(allowedBusinessRoute(prefix+'/export/clients.csv','GET'))
  for(const [path,method] of [['/email/send','POST'],['/records/clients','DELETE'],['/settings','POST'],['/execute','GET'],['/records/users','GET'],['/records/clients/../../settings','GET']])assert(!allowedBusinessRoute(prefix+path,method))
})

test('original server shares durable business records and tools across the complete engagement',async t=>{
  const {request}=await fixture(t)
  const create=async(kind,data,key)=>{const r=await request(prefix+'/records/'+kind,'POST',{data,request_id:key});assert.equal(r.status,201,r.text);return r.data}
  const lead=await create('leads',{name:'Studio prospect',estimated_value:'1200.00',currency:'USD'},'new-studio')
  const conversion=await request(prefix+'/leads/'+lead.id+'/convert','POST',{request_id:'convert-studio'})
  assert.equal(conversion.status,200,conversion.text)
  assert.deepEqual((await request(prefix+'/leads/'+lead.id+'/convert','POST',{request_id:'convert-studio'})).data,conversion.data)
  const clients=(await request(prefix+'/records/clients')).data.items
  assert.equal(clients.length,1)
  assert.equal((await request(prefix+'/records/clients?query=design%2Fedit')).status,200,'Encoded search text is not a path')
  const project=await create('projects',{name:'Launch film',status:'active',client_id:clients[0].id,due_date:'2027-01-20'})
  const task=await create('tasks',{title:'First cut',project_id:project.id,due_date:'2027-01-18'})
  await create('finances',{title:'Deposit',amount:'300.10',currency:'USD',status:'paid',date:'2027-01-10',project_id:project.id})
  await create('finances',{title:'Equipment',type:'expense',amount:'40.05',currency:'USD',status:'paid',date:'2027-01-11',project_id:project.id})
  await create('finances',{title:'HKD income',amount:'500.00',currency:'HKD',status:'paid',date:'2027-01-11'})
  const summary=(await request(prefix+'/dashboard?start=2027-01-01&end=2027-01-31')).data
  assert.equal(summary.totals_by_currency.find(r=>r.currency==='USD').net,'260.05')
  assert.equal(summary.totals_by_currency.find(r=>r.currency==='HKD').revenue,'500.00')
  assert.match((await request(prefix+'/calendar?start=2027-01-01&end=2027-01-31')).text,/First cut/)
  const tools=await request(prefix+'/tools');assert.equal(tools.status,200,tools.text)
  assert(tools.data.tools.some(tool=>tool.name==='business_update'))
  const get=await request(prefix+'/execute','POST',{name:'business_get',arguments:{kind:'tasks',id:task.id},request_id:'read-task'})
  assert.equal(get.status,200,get.text);assert.equal(get.data.result.id,task.id)
  const update=await request(prefix+'/execute','POST',{name:'business_update',arguments:{kind:'tasks',id:task.id,version:task.version,data:{status:'done'}},request_id:'complete-task'})
  assert.equal(update.status,200,update.text)
  assert.equal((await request(prefix+'/records/tasks/'+task.id)).data.status,'done')
  assert.equal((await request(prefix+'/records/tasks/'+task.id,'PATCH',{data:{status:'todo'},version:task.version})).status,409)
  assert.match((await request(prefix+'/export/projects.csv')).text,/Launch film/)
  assert.equal((await request(prefix+'/export')).data.schema_version,1)
  assert.equal((await request(prefix+'/records/clients','POST',{data:{name:'Hijack'},workspace:'another'})).status,422)
  assert.equal((await request(prefix+'/settings','PUT',{ai_enabled:false})).status,200)
  assert.equal((await request(prefix+'/execute','POST',{name:'business_list',arguments:{kind:'clients'},request_id:'disabled-read'})).status,403)
  assert.equal((await request('/api/creator-agent/chat','POST',{message:'Hello',async:true})).status,403)
  assert.equal((await request(prefix+'/dashboard')).status,200)
})

test('validated connection profiles cannot read owner or other profile records',async t=>{
  const {request,base}=await fixture(t)
  assert.equal((await fetch(base+prefix+'/modules')).status,401)
  const owner=await request(prefix+'/records/clients','POST',{data:{name:'Private owner'}})
  assert.equal(owner.status,201,owner.text)
  const a=(await request('/api/creator-agent/connections/profile','POST',{})).data.credential
  const b=(await request('/api/creator-agent/connections/profile','POST',{})).data.credential
  const ah={'X-Spur-Connection':a},bh={'X-Spur-Connection':b}
  assert.equal((await request(prefix+'/records/clients/'+owner.data.id,'GET',undefined,ah)).status,404)
  const record=await request(prefix+'/records/clients','POST',{data:{name:'Profile A'}},ah)
  assert.equal(record.status,201,record.text)
  assert.equal((await request(prefix+'/records/clients/'+record.data.id,'GET',undefined,bh)).status,404)
  assert.equal((await request(prefix+'/records/clients','GET',undefined,bh)).data.total,0)
  assert.equal((await request(prefix+'/modules','GET',undefined,{'X-Spur-Connection':'X'.repeat(43)})).status,401)
})
