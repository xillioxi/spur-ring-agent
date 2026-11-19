const {test}=require('node:test');
const assert=require('node:assert/strict');
const {mkdtempSync,mkdirSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join,resolve}=require('node:path');
const {pathToFileURL}=require('node:url');
const {integrationToolVisible,assertIntegrationAccess}=require('./access.cjs');

async function scenario(t){
  const base=mkdtempSync(join(tmpdir(),'spur-connector-permissions-'));
  const keys=['SPUR_BUSINESS_ROOT','SPUR_RESEARCH_OUTPUT','SPUR_INTEGRATIONS_AI_READ','SPUR_INTEGRATIONS_AI_WRITE'];
  const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  Object.assign(process.env,{SPUR_BUSINESS_ROOT:join(base,'business'),SPUR_RESEARCH_OUTPUT:join(base,'run'),
    SPUR_INTEGRATIONS_AI_READ:'1',SPUR_INTEGRATIONS_AI_WRITE:'0'});
  mkdirSync(process.env.SPUR_RESEARCH_OUTPUT,{recursive:true});
  const {callBusiness}=await import(pathToFileURL(resolve(__dirname,'../../../web/business-client.mjs')).href);
  const root=process.env.SPUR_BUSINESS_ROOT;
  t.after(()=>{
    for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
    rmSync(base,{recursive:true,force:true});
  });
  return {root,callBusiness,permissions:(ai_read,ai_write)=>callBusiness(root,'configure_modules',
    {value:{modules:[{id:'integrations',permissions:{ai_read,ai_write}}]}})};
}

function connector(t,name,implementations){
  const clientPath=require.resolve(`../connectors/${name}/client.cjs`);
  const pluginPath=require.resolve(`../connectors/${name}/index.cjs`);
  const clientBefore=require.cache[clientPath],pluginBefore=require.cache[pluginPath];
  require.cache[clientPath]={id:clientPath,filename:clientPath,loaded:true,exports:implementations};
  delete require.cache[pluginPath];
  const plugin=require(pluginPath);
  t.after(()=>{
    if(clientBefore)require.cache[clientPath]=clientBefore;else delete require.cache[clientPath];
    if(pluginBefore)require.cache[pluginPath]=pluginBefore;else delete require.cache[pluginPath];
  });
  return ()=>{const tools=new Map();plugin.apply({tools:{register:tool=>tools.set(tool.name,tool)}});return tools;};
}

test('standalone connectors retain their existing policy without a business root',async()=>{
  const root=process.env.SPUR_BUSINESS_ROOT;
  delete process.env.SPUR_BUSINESS_ROOT;
  try{
    assert.equal(integrationToolVisible('ai_read'),true);
    assert.equal(integrationToolVisible('ai_write'),true);
    await assertIntegrationAccess('ai_write');
  }finally{if(root!==undefined)process.env.SPUR_BUSINESS_ROOT=root;}
});

test('Notion write tools are hidden by default; stale flags cannot authorize writes',async t=>{
  const env=await scenario(t),calls=[];
  const invoke=name=>async()=>{calls.push(name);return name==='list'?[]:{created:true,id:'page-1'};};
  const load=connector(t,'notion',{listPages:invoke('list'),readPage:invoke('read'),createPage:invoke('create'),
    appendBlocks:invoke('append'),updateBlock:invoke('update')});
  const readonly=load();
  assert.deepEqual([...readonly.keys()],['notion_list_pages','notion_read_page']);
  process.env.SPUR_INTEGRATIONS_AI_WRITE='1';
  const stale=load();
  assert.equal(stale.size,5);
  for(const name of ['notion_create_page','notion_append_blocks','notion_update_block'])
    await assert.rejects(stale.get(name).execute({}),error=>error.status===403);
  assert.equal(calls.length,0);
  await env.permissions(true,true);
  const created=await stale.get('notion_create_page').execute({parent:'authorized-page',title:'Requested page'});
  assert.equal(created.created,true);assert.deepEqual(calls,['create']);
  await env.permissions(true,false);
  await assert.rejects(stale.get('notion_create_page').execute({parent:'authorized-page',title:'Requested page'}),error=>error.status===403);
  assert.deepEqual(calls,['create']);
  process.env.SPUR_INTEGRATIONS_AI_READ='0';
  assert.equal(load().size,0);
});

test('YouTube checks current access before all six provider tools and cached results',async t=>{
  const env=await scenario(t);let calls=0;
  const implementation=async()=>{calls++;return {videos:[{videoId:'video-1'}]};};
  const load=connector(t,'youtube',{channelDetails:implementation,myAnalytics:implementation,myChannel:implementation,
    myComments:implementation,searchVideos:implementation,videoDetails:implementation});
  const tools=load();assert.equal(tools.size,6);
  await tools.get('youtube_search').execute({query:'User request'});
  assert.equal(calls,1);
  await env.permissions(false,false);
  for(const [name,tool] of tools)
    await assert.rejects(tool.execute(name==='youtube_search'?{query:'User request'}:{}),error=>error.status===403);
  assert.equal(calls,1);
  process.env.SPUR_INTEGRATIONS_AI_READ='0';assert.equal(load().size,0);
});

test('global AI disable also denies existing Notion and YouTube definitions',async t=>{
  const env=await scenario(t);let calls=0;
  const implementation=async()=>{calls++;return {};};
  const notion=connector(t,'notion',{listPages:implementation,readPage:implementation,createPage:implementation,
    appendBlocks:implementation,updateBlock:implementation})();
  const youtube=connector(t,'youtube',{channelDetails:implementation,myAnalytics:implementation,myChannel:implementation,
    myComments:implementation,searchVideos:implementation,videoDetails:implementation})();
  await env.callBusiness(env.root,'update_settings',{value:{ai_enabled:false}});
  await assert.rejects(notion.get('notion_read_page').execute({page:'id'}),error=>error.status===403 && error.code==='ai_disabled');
  await assert.rejects(youtube.get('youtube_my_analytics').execute({}),error=>error.status===403 && error.code==='ai_disabled');
  assert.equal(calls,0);
});
