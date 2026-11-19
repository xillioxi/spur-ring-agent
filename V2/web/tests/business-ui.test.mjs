import test from 'node:test'
import assert from 'node:assert/strict'
import { build, transform } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const output=await build({entryPoints:[fileURLToPath(new URL('../src/businessApi.ts',import.meta.url))],bundle:true,write:false,format:'esm',platform:'node',target:'es2020',logLevel:'silent'})
const api=await import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].text).toString('base64'))
const {entities,recordPayload,drillRecords,localDateTime,calendarDay,businessPageFromHash,listRecords,safeUrl}=api

test('business routes extend the original Home without replacing task deep links',async()=>{
  assert.equal(businessPageFromHash('#business/overview'),'overview')
  assert.equal(businessPageFromHash('#business/action-center'),'action-center')
  assert.equal(businessPageFromHash('#task/12345678-1234-4234-8234-123456789abc'),null)
  assert.equal(businessPageFromHash('#business/automations'),null)
  const app=await readFile(new URL('../src/App.tsx',import.meta.url),'utf8')
  assert.match(app,/"app-shell v5-shell|app-shell v5-shell/)
  for(const original of ['SpurMascot','Conversation','Deliverables','Mailbox','ConnectedApps','IdeaPage','MemoryPage'])assert(app.includes('<'+original),`Preserve ${original}`)
  assert.match(app,/\? "workspace" : "home"/,'Unrouted entry still opens the original Home')
})

test('every native entity has a concrete editable model matching backend field names',()=>{
  assert.equal(Object.keys(entities).length,11)
  const keys=kind=>entities[kind].fields.map(field=>field.key)
  assert(keys('proposals').includes('budget'));assert(keys('proposals').includes('due_date'));assert(!keys('proposals').includes('amount'))
  assert(keys('opportunities').includes('budget'));assert(keys('opportunities').includes('due_date'));assert(!keys('opportunities').includes('deadline'))
  assert.deepEqual(entities.tasks.fields.find(field=>field.key==='status').options,['todo','in_progress','done'])
  assert.equal(entities.tasks.fields.find(field=>field.key==='project_id').relation,'projects')
  assert.equal(entities.finances.fields.find(field=>field.key==='client_id').relation,'clients')
})

test('financial form keeps decimal strings and linked identifiers',()=>{
  const form=new FormData();for(const [key,value] of Object.entries({title:'Paid project',type:'income',status:'paid',amount:'1200.100001',currency:'hkd',date:'2026-11-11',client_id:'client-1',project_id:'project-1'}))form.set(key,value)
  const payload=recordPayload('finances',form)
  assert.equal(payload.amount,'1200.100001');assert.equal(payload.currency,'HKD');assert.equal(payload.client_id,'client-1');assert.equal(payload.project_id,'project-1')
  assert.equal(typeof payload.amount,'string','Never use float arithmetic when saving money')
  assert.match(api.displayMoney('999999999999.123456','USD'),/123456/,'Display must retain supported decimal precision')
})

test('event editing and calendar grouping respect device timezone around midnight',()=>{
  const previous=process.env.TZ
  try{for(const timezone of ['Asia/Hong_Kong','America/New_York','Pacific/Kiritimati','Pacific/Pago_Pago']){
    process.env.TZ=timezone
    const form=new FormData();form.set('title','Review');form.set('start','2026-11-11T00:15');form.set('end','2026-11-11T01:15')
    const payload=recordPayload('events',form)
    assert.equal(localDateTime(payload.start),'2026-11-11T00:15')
    assert.equal(calendarDay({start:payload.start,end:payload.end,all_day:false}),'2026-11-11')
    assert.equal(payload.timezone,timezone)
    form.set('end','2026-11-11T00:10');assert.throws(()=>recordPayload('events',form),/after the start/)
  }}finally{process.env.TZ=previous}
})

test('metric drill-through returns only exact currency and status record identifiers',()=>{
  const usd={id:'usd',currency:'USD',amount:'100'},eur={id:'eur',currency:'EUR',amount:'900'},expense={id:'expense',currency:'USD',amount:'20'},pending={id:'pending',currency:'USD',amount:'70'}
  const dashboard={records:{finances:[usd,eur,expense,pending],projects:[{id:'active',status:'active'},{id:'planned',status:'planned'}]},totals_by_currency:[{currency:'USD',record_ids:{revenue:['usd'],expenses:['expense'],outstanding:['pending']}},{currency:'EUR',record_ids:{revenue:['eur']}}]}
  assert.deepEqual(drillRecords(dashboard,'revenue','USD').rows,[usd])
  assert.deepEqual(drillRecords(dashboard,'net','USD').rows,[usd,expense])
  assert.deepEqual(drillRecords(dashboard,'outstanding','USD').rows,[pending])
  assert.deepEqual(drillRecords(dashboard,'revenue','JPY').rows,[])
  assert.deepEqual(drillRecords(dashboard,'projects','USD').rows,[{id:'active',status:'active'}])
})

test('record search consumes pagination and preserves query/archive parameters',async()=>{
  const paths=[]
  const rows=await listRecords('clients','Acme & Co',true,async path=>{paths.push(path);return path.includes('offset=500')?{items:[{id:'last'}],next_offset:null}:{items:[{id:'first'}],next_offset:500}})
  assert.deepEqual(rows,[{id:'first'},{id:'last'}]);assert.equal(paths.length,2)
  for(const path of paths){const params=new URL('https://example.test'+path).searchParams;assert.equal(params.get('query'),'Acme & Co');assert.equal(params.get('archived'),'true')}
})

test('portfolio links reject script URLs and embedded credentials',()=>{
  assert.equal(safeUrl('javascript:alert(1)'),undefined)
  assert.equal(safeUrl('https://user:password@example.test'),undefined)
  assert.equal(safeUrl('http://example.test'),undefined)
  assert.equal(safeUrl('https://example.test/work'),'https://example.test/work')
})

test('delayed record opens cannot replace a newer request or reopen after navigation',async()=>{
  // Exercise the component's actual async callback with deferred requests, without a DOM framework.
  const source=await readFile(new URL('../src/BusinessWorkspace.tsx',import.meta.url),'utf8')
  const start=source.indexOf('  async function openRecord('),end=source.indexOf('  const edit=',start)
  const {code}=await transform(source.slice(start,end),{loader:'ts',target:'es2020'})
  const requests=new Map(),recordSequence={current:0},currentPage={current:'projects'}
  const opened=[],errors=[],recordUpdates=[]
  let relationLoads=0
  const environment={recordSequence,currentPage,moduleForKind:api.moduleForKind,enabled:()=>true,setError:error=>errors.push(error),businessRequest:path=>new Promise((resolve,reject)=>requests.set(path,{resolve,reject})),entities,listRecords:async()=>{relationLoads++;return []},setRecords:update=>recordUpdates.push(update({})),setEditor:editor=>opened.push(editor),crypto:{randomUUID:()=> 'test-request'}}
  const openRecord=new Function(...Object.keys(environment),code+'; return openRecord;')(...Object.values(environment))
  const old=openRecord('projects',{id:'older'}),latest=openRecord('projects',{id:'latest'})
  requests.get('/records/projects/latest').resolve({id:'latest',name:'Latest'})
  await latest
  requests.get('/records/projects/older').resolve({id:'older',name:'Older'})
  await old
  assert.equal(opened.length,1);assert.equal(opened[0].row.id,'latest');assert.equal(relationLoads,1)

  const navigating=openRecord('projects',{id:'leaving'})
  currentPage.current='clients'
  requests.get('/records/projects/leaving').resolve({id:'leaving'})
  await navigating
  assert.equal(opened.length,1,'An old page must not reopen a dialog')
  assert.equal(recordUpdates.length,1,'An old page must not replace relation choices')

  const staleError=openRecord('clients',{id:'late-error'})
  recordSequence.current++ // Matches page/unmount effect cleanup.
  requests.get('/records/clients/late-error').reject(new Error('Late failure'))
  await staleError
  assert(!errors.includes('Late failure'),'An invalidated request must not surface an unrelated error')
})
