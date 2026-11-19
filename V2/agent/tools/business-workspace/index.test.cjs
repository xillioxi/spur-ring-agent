const {test}=require('node:test');
const assert=require('node:assert/strict');
const {mkdtempSync,rmSync,readFileSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join,resolve}=require('node:path');
const {pathToFileURL}=require('node:url');

test('real Harness plugin registers, mutates, reads and audits the shared business store',async()=>{
  const base=mkdtempSync(join(tmpdir(),'spur-business-plugin-'));
  const saved=Object.fromEntries(['SPUR_BUSINESS_ROOT','SPUR_RESEARCH_OUTPUT','SPUR_BUSINESS_TASK_ID'].map(key=>[key,process.env[key]]));
  Object.assign(process.env,{SPUR_BUSINESS_ROOT:join(base,'workspace'),SPUR_RESEARCH_OUTPUT:join(base,'task'),SPUR_BUSINESS_TASK_ID:'durable-task-one'});
  try{
    const tools=new Map();
    await require('./index.cjs').apply({tools:{register:tool=>tools.set(tool.name,tool)}});
    assert.equal(tools.size,12);
    const create=tools.get('business_create');
    assert.equal(create.parameters.type,'object');
    assert.equal(create.parameters.additionalProperties,false);
    assert.ok(create.parameters.required.includes('kind'));
    assert.equal(create.parameters.properties.data.type,'string');
    for(const definition of tools.values()){
      assert.equal(definition.parameters.type,'object');
      assert.ok(Array.isArray(definition.parameters.required));
      for(const property of Object.values(definition.parameters.properties))
        assert.ok(Object.keys(property).every(key=>['type','enum','const','description','title','default','examples'].includes(key)),
          'Direct registration must use raw JSON Schema in the Harness-supported subset');
    }
    const first=await create.execute({kind:'clients',data:'{"name":"Harness client","email":"private@example.com"}'});
    assert.equal(first.ok,true,JSON.stringify(first));
    const replay=await create.execute({kind:'clients',data:'{ "email": "private@example.com", "name": "Harness client" }'});
    assert.equal(replay.result.id,first.result.id);
    const opened=await tools.get('business_get').execute({kind:'clients',id:first.result.id});
    assert.equal(opened.result.name,'Harness client');
    const edit={kind:'clients',id:first.result.id,version:1,data:'{"notes":"Agreed brief"}'};
    assert.equal((await tools.get('business_update').execute(edit)).result.version,2);
    assert.equal((await tools.get('business_update').execute(edit)).result.version,2);
    const events=readFileSync(join(base,'task','tool-events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(events.filter(row=>row.event==='result').length,5);
    assert.ok(events.every(row=>!('args' in row)));
    assert.ok(!JSON.stringify(events).includes('private@example.com'));
    const {callBusiness}=await import(pathToFileURL(resolve(__dirname,'../../../web/business-client.mjs')).href);
    assert.equal((await callBusiness(process.env.SPUR_BUSINESS_ROOT,'list',{kind:'clients'})).length,1);
    await callBusiness(process.env.SPUR_BUSINESS_ROOT,'configure_modules',{value:{modules:[{id:'clients',permissions:{ai_read:false,ai_write:false}}]}});
    assert.equal((await tools.get('business_get').execute({kind:'clients',id:first.result.id})).error.status,403);
    assert.equal((await create.execute({kind:'clients',root:'../escape',data:'{"name":"Bad"}'})).error.status,422);
  }finally{
    for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
    rmSync(base,{recursive:true,force:true});
  }
});
