import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {callBusiness} from '../business-client.mjs';
import {catalog,execute,requestKey,assertAiEnabled} from '../business-tools.mjs';

async function workspace(t){
  const root=await mkdtemp(join(tmpdir(),'spur-business-tools-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  return root;
}
const editPermissions=(root,id,ai_read,ai_write=ai_read)=>callBusiness(root,'configure_modules',
  {value:{modules:[{id,permissions:{ai_read,ai_write}}]}});
const invoke=(root,name,args={},key='stable-request-one')=>execute(root,name,args,key);

test('catalog describes real business functions and rejects unknown tools/paths',async t=>{
  const root=await workspace(t);
  const tools=await catalog(root);
  assert.equal(tools.length,12);
  assert.ok(tools.every(tool=>!tool.external_action));
  assert.ok(tools.find(tool=>tool.name==='business_create').requires_request_id);
  const schema=await invoke(root,'business_schema',{kind:'clients'});
  assert.ok(schema.ok);
  assert.ok(schema.result.schema.required.includes('name'));
  assert.equal((await invoke(root,'configure_modules')).error.code,'unknown_tool');
  assert.equal((await invoke(root,'business_list',{kind:'clients',root:'../other'})).error.status,422);
  assert.equal((await invoke(root,'business_create',{kind:'clients',data:{name:'Test',actor:'user'}})).error.status,422);
});

test('native create/read/update/archive persist and replay exactly once',async t=>{
  const root=await workspace(t);
  const args={kind:'clients',data:{name:'Acme',email:'client@example.com'}};
  const first=await invoke(root,'business_create',args);
  assert.equal(first.ok,true,JSON.stringify(first));
  assert.equal(first.result.created_by,'harness');
  assert.equal(first.result.source,'ai_generated');
  assert.deepEqual(await invoke(root,'business_create',args),first);
  const edit={kind:'clients',id:first.result.id,version:1,data:{notes:'Agreed brief'}};
  const updated=await invoke(root,'business_update',edit,'update-request-one');
  assert.equal(updated.result.version,2);
  assert.deepEqual(await invoke(root,'business_update',edit,'update-request-one'),updated);
  assert.equal((await invoke(root,'business_update',edit,'stale-request-one')).error.status,409);
  const archive={kind:'clients',id:first.result.id,version:2};
  const archived=await invoke(root,'business_archive',archive,'archive-request-one');
  assert.equal(archived.result.archived,1);
  assert.deepEqual(await invoke(root,'business_archive',archive,'archive-request-one'),archived);
  const audit=await callBusiness(root,'activity');
  assert.equal(audit.filter(row=>row.actor==='harness').length,3);
});

test('stable task keys normalize JSON fields and distinguish tasks',()=>{
  const one={kind:'clients',data:'{"name":"Acme","email":"x@example.com"}'};
  const two={data:{email:'x@example.com',name:'Acme'},kind:'clients'};
  assert.equal(requestKey('task-1','business_create',one),requestKey('task-1','business_create',two));
  assert.notEqual(requestKey('task-1','business_create',one),requestKey('task-2','business_create',one));
});

test('workspace selection belongs to server and list/search pagination is bounded',async t=>{
  const root=await workspace(t),other=await workspace(t);
  const client=await callBusiness(root,'create',{kind:'clients',data:{name:'First'}});
  await callBusiness(root,'create',{kind:'clients',data:{name:'Second'}});
  const page=(await invoke(root,'business_list',{kind:'clients',limit:1})).result;
  assert.equal(page.total,2);assert.equal(page.next_offset,1);
  const search=(await invoke(root,'business_list',{kind:'clients',query:'First'})).result;
  assert.equal(search.items[0].id,client.id);
  assert.equal((await invoke(other,'business_get',{kind:'clients',id:client.id})).error.status,404);
  assert.equal((await invoke(root,'business_list',{kind:'clients',limit:true})).error.status,422);
});

test('AI permissions gate reads, writes, summaries and replayed linked identifiers',async t=>{
  const root=await workspace(t);
  const client=await callBusiness(root,'create',{kind:'clients',data:{name:'Private client',follow_up_date:'2000-01-01'}});
  const financeArgs={kind:'finances',data:{title:'Fee',amount:'991.23',client_id:client.id,due_date:'2000-01-01'}};
  assert.equal((await invoke(root,'business_create',financeArgs)).ok,true);
  await editPermissions(root,'clients',false);
  assert.equal((await invoke(root,'business_get',{kind:'clients',id:client.id})).error.status,403);
  assert.equal((await invoke(root,'business_create',{kind:'clients',data:{name:'Denied'}})).error.status,403);
  for(const name of ['business_dashboard','business_actions'])assert.equal((await invoke(root,name)).error.status,403);
  const calendar=await invoke(root,'business_calendar');
  assert.equal(calendar.ok,true);assert.ok(!JSON.stringify(calendar).includes(client.id));
  const replay=await invoke(root,'business_create',financeArgs);
  assert.equal(replay.ok,true);assert.ok(!JSON.stringify(replay).includes(client.id));
  assert.ok(!(await catalog(root)).find(row=>row.name==='business_create').allowed_kinds.includes('clients'));
  await callBusiness(root,'update_settings',{value:{ai_enabled:false}});
  await assert.rejects(assertAiEnabled(root),/AI is disabled/);
  assert.ok((await catalog(root)).every(row=>!row.enabled));
  assert.equal((await invoke(root,'workspace_modules')).error.code,'ai_disabled');
});

test('deterministic dashboard, lead conversion and optional-module privacy',async t=>{
  const root=await workspace(t);
  const lead=await callBusiness(root,'create',{kind:'leads',data:{name:'Prospect'}});
  const converted=await invoke(root,'business_convert_lead',{id:lead.id});
  assert.equal(converted.ok,true,JSON.stringify(converted));
  assert.deepEqual(await invoke(root,'business_convert_lead',{id:lead.id}),converted);
  const client=(await callBusiness(root,'list',{kind:'clients'}))[0];
  const project=await callBusiness(root,'create',{kind:'projects',data:{name:'Film',client_id:client.id,due_date:'2000-01-01'}});
  await callBusiness(root,'create',{kind:'finances',data:{title:'Income',amount:'10.10',status:'paid',currency:'HKD',project_id:project.id}});
  await callBusiness(root,'create',{kind:'finances',data:{title:'Expense',type:'expense',amount:'2.20',status:'paid',currency:'HKD',project_id:project.id}});
  await callBusiness(root,'create',{kind:'proposals',data:{title:'Secret proposal'}});
  await editPermissions(root,'proposals',false);
  const dashboard=await invoke(root,'business_dashboard');
  assert.equal(dashboard.result.totals_by_currency.find(row=>row.currency==='HKD').net,'7.90');
  assert.ok(!JSON.stringify(dashboard).includes('Secret proposal'));
  assert.equal(dashboard.result.records_are_previews,true);
  const actions=await invoke(root,'business_actions');
  assert.ok(actions.result.items.some(row=>row.record_id===project.id));
});

test('hidden navigation retains access, metadata settings never enter model context',async t=>{
  const root=await workspace(t);
  await callBusiness(root,'configure_modules',{value:{modules:[{id:'clients',enabled:false,settings:{secret:'do-not-disclose'}}]}});
  assert.equal((await invoke(root,'business_list',{kind:'clients'})).ok,true);
  const discovery=await invoke(root,'workspace_modules');
  assert.ok(!JSON.stringify(discovery).includes('do-not-disclose'));
});
