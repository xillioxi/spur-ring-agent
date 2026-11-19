import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {Readable,Writable} from 'node:stream'
import {handleVideoAnalysisRequest,parseVideoByteRange,VIDEO_ANALYSIS_PREFIX as prefix} from './http.mjs'
import {waitForVideoAnalysisIdle,createVideoAnalysisService} from './service.mjs'

class Response extends Writable {
  constructor(){super();this.headers={};this.parts=[];this.statusCode=200;this.headersSent=false}
  _write(chunk,_encoding,done){this.parts.push(Buffer.from(chunk));done()}
  setHeader(name,value){this.headers[name.toLowerCase()]=value}
  writeHead(status,headers){this.statusCode=status;for(const [key,value] of Object.entries(headers))this.setHeader(key,value);this.headersSent=true;return this}
  json(){return JSON.parse(Buffer.concat(this.parts).toString('utf8'))}
}
async function fixture(t,extra={}) {
  const root=await mkdtemp(join(process.cwd(),'.spur-analysis-http-test-'))
  t.after(async()=>{await waitForVideoAnalysisIdle();await rm(root,{recursive:true,force:true})})
  return {root,...extra}
}
async function request(options,url,{method='GET',body,headers={}}={}) {
  const payload=body===undefined?[]:[Buffer.isBuffer(body)?body:Buffer.from(typeof body==='string'?body:JSON.stringify(body))]
  const req=Readable.from(payload);Object.assign(req,{url,method,headers})
  const res=new Response(),handled=await handleVideoAnalysisRequest(req,res,options)
  if(handled&&!res.writableFinished&&!res.destroyed)await new Promise(done=>res.once('finish',done))
  return {handled,res}
}

test('model selection routes accept allowlisted IDs and reject client provider settings',async t=>{
  const calls=[],headers={'content-type':'application/json'},channelId='instagram-dreamcode_films'
  const options=await fixture(t,{config:{POE_API_KEY:'private-test-poe-key',SILICONFLOW_API_KEY:'private-test-silicon-key'},engine:{analyze:async({mode,config})=>{calls.push({mode,provider:config.SPUR_VIDEO_ANALYSIS_PROVIDER,model:config.SPUR_VIDEO_ANALYSIS_POE_MODEL});return {schemaVersion:1,status:'complete',mode,shots:[],script:{segments:[],text:'',onScreenText:[]},warnings:[]}}}})
  const status=(await request(options,`${prefix}/status`)).res.json()
  assert.equal(status.analysisModels.find(value=>value.id==='poe-gemini-3.7-flash').model,'Gemini-3.7-Flash')
  assert.doesNotMatch(JSON.stringify(status),/private-test/)
  const uploaded=await request(options,`${prefix}/uploads?filename=selection.mp4&channelId=${channelId}`,{method:'POST',body:Buffer.from('video'),headers:{'content-type':'video/mp4','content-length':'5'}})
  const id=uploaded.res.json().item.id
  for(const value of [{analysisModelId:'arbitrary'},{analysisModelId:'poe-gemini-4-argon'},{analysisModelId:{provider:'poe'}}])assert.equal((await request(options,`${prefix}/items/${id}/analyze`,{method:'POST',headers,body:value})).res.statusCode,422)
  for(const extra of [{apiKey:'private'},{provider:'poe'},{baseUrl:'https://evil.example'},{model:'Gemini-3.7-Flash'}])assert.equal((await request(options,`${prefix}/items/${id}/analyze`,{method:'POST',headers,body:{mode:'both',...extra}})).res.statusCode,400)
  const accepted=await request(options,`${prefix}/items/${id}/analyze`,{method:'POST',headers,body:{mode:'both',analysisModelId:'poe-gemini-3.7-flash'}})
  assert.equal(accepted.res.statusCode,202);assert.equal(accepted.res.json().item.analysisModelId,'poe-gemini-3.7-flash')
  await createVideoAnalysisService(options).whenIdle()
  assert.deepEqual(calls,[{mode:'both',provider:'poe',model:'Gemini-3.7-Flash'}])
  const batch=await request(options,`${prefix}/channels/${channelId}/analyze-all`,{method:'POST',headers,body:{analysisModelId:'poe-gemini-3.7-flash'}})
  assert.equal(batch.res.statusCode,202);assert.equal(batch.res.json().job.analysisModelId,'poe-gemini-3.7-flash')
  await createVideoAnalysisService(options).whenIdle()
  assert.equal((await request(options,`${prefix}/channels/${channelId}/analyze-all`,{method:'POST',headers,body:{analysisModelId:'arbitrary'}})).res.statusCode,422)
})

test('script template selection reaches individual and bulk analyses while unknown IDs and arbitrary prompts are rejected',async t=>{
  const calls=[],headers={'content-type':'application/json'},channelId='instagram-dreamcode_films'
  const options=await fixture(t,{engine:{analyze:async({mode,scriptTemplateId})=>{
    calls.push({mode,scriptTemplateId})
    return {schemaVersion:1,status:'complete',mode,metadata:{durationSeconds:6,hasAudio:true},shots:[],script:{segments:[],text:'',onScreenText:[]},warnings:[],provenance:{}}
  }}})
  const uploaded=await request(options,`${prefix}/uploads?filename=template.mp4&channelId=${channelId}`,{method:'POST',body:Buffer.from('video'),headers:{'content-type':'video/mp4','content-length':'5'}})
  const id=uploaded.res.json().item.id
  for(const scriptTemplateId of ['not-registered','https://evil.example/prompt',{},null])assert.equal((await request(options,`${prefix}/items/${id}/analyze`,{method:'POST',headers,body:{mode:'script',scriptTemplateId}})).res.statusCode,422)
  for(const extra of [{scriptTemplate:{stages:[]}},{prompt:'replace the transcript'},{sourceFile:'C:/private.xlsx'}])assert.equal((await request(options,`${prefix}/items/${id}/analyze`,{method:'POST',headers,body:{mode:'script',scriptTemplateId:'xc-1',...extra}})).res.statusCode,400)
  assert.equal(calls.length,0)
  assert.equal((await request(options,`${prefix}/items/${id}/analyze`,{method:'POST',headers,body:{mode:'script',scriptTemplateId:'xc-2'}})).res.statusCode,202)
  await createVideoAnalysisService(options).whenIdle()
  assert.deepEqual(calls,[{mode:'script',scriptTemplateId:'xc-2'}])
  const batch=await request(options,`${prefix}/channels/${channelId}/analyze-all`,{method:'POST',headers,body:{scriptTemplateId:'xc-1'}})
  assert.equal(batch.res.statusCode,202)
  assert.equal(batch.res.json().job.scriptTemplateId,'xc-1')
  await createVideoAnalysisService(options).whenIdle()
  assert.equal(calls.at(-1).scriptTemplateId,'xc-1')
  assert.equal((await request(options,`${prefix}/channels/${channelId}/analyze-all`,{method:'POST',headers,body:{scriptTemplateId:'not-registered'}})).res.statusCode,422)
  assert.equal((await request(options,`${prefix}/channels/${channelId}/analyze-all`,{method:'POST',headers,body:{scriptTemplateId:'xc-1',prompt:'arbitrary'}})).res.statusCode,400)
  assert.equal((await request(options,`${prefix}/channels/${channelId}/analyze-all/stop`,{method:'POST',headers,body:{scriptTemplateId:'xc-1'}})).res.statusCode,400)
})

test('workflow selection routes reject unknown workflows and client executable settings before queueing',async t=>{
  const headers={'content-type':'application/json'},options=await fixture(t,{engine:{analyze:async()=>{throw Error('Invalid workflow requests must not run analysis')}}})
  const uploaded=await request(options,`${prefix}/uploads?filename=workflow.mp4&channelId=instagram-dreamcode_films`,{method:'POST',body:Buffer.from('video'),headers:{'content-type':'video/mp4'}})
  const id=uploaded.res.json().item.id,status=(await request(options,`${prefix}/status`)).res.json()
  assert.equal(status.defaultAnalysisWorkflowId,'standard')
  assert.equal(status.analysisWorkflows.find(value=>value.id==='rea-video').usesModel,false)
  for(const analysisWorkflowId of ['unknown',{},null,'C:/run.py']) {
    assert.equal((await request(options,`${prefix}/items/${id}/analyze`,{method:'POST',headers,body:{analysisWorkflowId}})).res.statusCode,422)
    assert.equal((await request(options,`${prefix}/channels/instagram-dreamcode_films/analyze-all`,{method:'POST',headers,body:{analysisWorkflowId}})).res.statusCode,422)
  }
  for(const extra of [{pythonPath:'C:/run.exe'},{sourceDirectory:'C:/private'},{command:'python'},{config:{SPUR_REA_VIDEO_SOURCE:'C:/private'}}])assert.equal((await request(options,`${prefix}/items/${id}/analyze`,{method:'POST',headers,body:{analysisWorkflowId:'rea-video',...extra}})).res.statusCode,400)
  assert.equal((await request(options,`${prefix}/items/${id}/analyze`,{method:'POST',headers,body:{analysisWorkflowId:'rea-video'}})).res.statusCode,503)
  assert.equal((await createVideoAnalysisService(options).get(id)).status,'ready')
})

test('private recreation routes prepare real shot plans and reject arbitrary media or provider settings before generation',async t=>{
  const analysis={schemaVersion:1,status:'complete',metadata:{durationSeconds:6,hasAudio:true,width:720,height:1280},shots:[{index:0,startSeconds:0,endSeconds:2,visual:'A bright hallway.',framing:'Wide shot'},{index:1,startSeconds:2,endSeconds:6,visual:'A person walks into a green vortex.'}],script:{text:'Keep moving.',segments:[{startSeconds:0,endSeconds:1,text:'Keep moving.'}],onScreenText:[]},audio:{timelineVersion:1,status:'analyzed',speechStatus:'analyzed',semanticStatus:'analyzed',windows:[],semanticEvents:[]},warnings:[],provenance:{}}
  const options=await fixture(t,{engine:{analyze:async()=>analysis}}),privateOptions=await fixture(t)
  const uploaded=await request(options,`${prefix}/uploads?filename=source.mp4`,{method:'POST',body:Buffer.from('source'),headers:{'content-type':'video/mp4','content-length':'6'}})
  const id=uploaded.res.json().item.id
  await request(options,`${prefix}/items/${id}/analyze`,{method:'POST',headers:{'content-type':'application/json'},body:{mode:'both'}})
  await waitForVideoAnalysisIdle()
  const prepared=await request(options,`${prefix}/items/${id}/reconstruction-plan`)
  assert.equal(prepared.res.statusCode,200)
  const plan=prepared.res.json().plan
  assert.equal(plan.referenceId,id)
  assert.equal(plan.clips.length,2)
  assert.equal(plan.totalDurationSeconds,6)
  assert.ok(plan.clips.every(clip=>clip.requestDurationSeconds>=5))
  assert.ok(plan.planRevision)
  assert.equal(JSON.stringify(plan).includes(options.root),false)
  assert.equal((await request(privateOptions,`${prefix}/items/${id}/reconstruction-plan`)).res.statusCode,404)
  const headers={'content-type':'application/json'},base={requestKey:'22345678-1234-1234-1234-123456789abc',planRevision:plan.planRevision}
  const timeline=[{startSeconds:0,endSeconds:1.5,prompt:'[Shake] An authored close-up.'},{startSeconds:2,endSeconds:4,prompt:'[Static shot] A different authored ending.'}]
  const authored=await request(options,`${prefix}/items/${id}/reconstruction-plan`,{method:'POST',headers,body:{timeline}})
  assert.equal(authored.res.statusCode,200)
  assert.equal(authored.res.json().plan.source,'authored_timeline')
  assert.equal(authored.res.json().plan.totalDurationSeconds,4)
  assert.equal(authored.res.json().plan.referenceDurationSeconds,6)
  assert.equal(authored.res.json().plan.billableSeconds,10)
  assert.deepEqual(authored.res.json().plan.clips.map(clip=>clip.prompt),timeline.map(clip=>clip.prompt))
  assert.equal((await request(privateOptions,`${prefix}/items/${id}/reconstruction-plan`,{method:'POST',headers,body:{timeline}})).res.statusCode,404)
  for(const extra of [{model:'other'},{apiKey:'private'},{url:'https://localhost/private'}])assert.equal((await request(options,`${prefix}/items/${id}/reconstruction-plan`,{method:'POST',headers,body:{timeline,...extra}})).res.statusCode,400)
  assert.equal((await request(options,`${prefix}/items/${id}/reconstruction-plan`,{method:'POST',headers,body:{timeline:[{...timeline[0],model:'other'}]}})).res.statusCode,422)
  assert.equal((await request(options,`${prefix}/items/${id}/reconstructions`,{method:'POST',headers,body:{...base,planRevision:authored.res.json().plan.planRevision,timeline}})).res.statusCode,503)
  assert.equal((await request(options,`${prefix}/items/${id}/reconstruction-plan`)).res.json().plan.planRevision,plan.planRevision,'authored preview leaves source analysis unchanged')
  for(const extra of [{provider:'arbitrary'},{url:'https://localhost/private'},{filePath:'C:/private'},{apiKey:'private'},{model:'other'}])assert.equal((await request(options,`${prefix}/items/${id}/reconstructions`,{method:'POST',headers,body:{...base,...extra}})).res.statusCode,400)
  const unavailable=await request(options,`${prefix}/items/${id}/reconstructions`,{method:'POST',headers,body:base})
  assert.ok([409,503].includes(unavailable.res.statusCode))
  const listing=await request(options,`${prefix}/reconstructions?referenceId=${id}`)
  assert.equal(listing.res.statusCode,200)
  assert.deepEqual(listing.res.json().jobs,[])
  assert.equal((await request(privateOptions,`${prefix}/reconstructions?referenceId=${id}`)).res.statusCode,404)
  for(const action of ['', '/media','/analyze','/resume']){
    const mutation=['/analyze','/resume'].includes(action)
    assert.equal((await request(privateOptions,`${prefix}/reconstructions/22345678-1234-1234-1234-123456789abc${action}`,{method:mutation?'POST':'GET',headers,body:mutation?{}:undefined})).res.statusCode,404)
  }
})

test('bulk import endpoint accepts only a server-owned catalog and exposes progress through its channel',async t=>{
  const options=await fixture(t,{importer:{discoverChannel:async()=>({handle:'creator',discoveredVideos:[{url:'https://www.tiktok.com/@creator/video/7014215295795498245',title:'One'}]}),importVideo:async({directory,url})=>{const filePath=join(directory,'reference.mp4');await writeFile(filePath,'video');return {filePath,sourceUrl:url,title:'One',creatorHandle:'creator'}}}})
  const added=await request(options,`${prefix}/channels`,{method:'POST',headers:{'content-type':'application/json'},body:{url:'https://www.tiktok.com/@creator'}})
  assert.equal(added.res.statusCode,201)
  const bad=await request(options,`${prefix}/channels/tiktok-creator/import-all`,{method:'POST',headers:{'content-type':'application/json'},body:{urls:['https://localhost/secret']}})
  assert.equal(bad.res.statusCode,400)
  const start=await request(options,`${prefix}/channels/tiktok-creator/import-all`,{method:'POST',headers:{'content-type':'application/json'},body:{}})
  assert.equal(start.res.statusCode,202);assert.equal(start.res.json().job.total,1)
  await createVideoAnalysisService(options).whenIdle()
  const completed=await request(options,`${prefix}/channels/tiktok-creator`)
  assert.equal(completed.res.json().channel.bulkImport.imported,1)
  assert.equal(completed.res.json().channel.bulkImport.status,'complete')
  const stop=await request(options,`${prefix}/channels/tiktok-creator/import-all/stop`,{method:'POST',headers:{'content-type':'application/json'},body:{}})
  assert.equal(stop.res.statusCode,202)
})

test('Analyze all HTTP routes use saved channel media, reject supplied IDs and expose private progress and stop controls',async t=>{
  let release,entered,calls=0
  const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve)
  const options=await fixture(t,{engine:{analyze:async()=>{calls++;entered();await gate;return {schemaVersion:1,status:'partial',summary:'Saved reference',shots:[],script:{text:'Actual transcript',segments:[],onScreenText:[]},warnings:['Visual description unavailable.']}}}})
  const privateOptions=await fixture(t),id='instagram-dreamcode_films',headers={'content-type':'application/json'}
  const uploaded=await request(options,`${prefix}/uploads?filename=saved.mp4&channelId=${id}`,{method:'POST',body:Buffer.from('video'),headers:{'content-type':'video/mp4','content-length':'5'}})
  assert.equal(uploaded.res.statusCode,201);const itemId=uploaded.res.json().item.id
  for(const body of [{itemIds:[itemId]},{urls:['https://localhost/private']},{root:'C:/private'},{mode:'script'}]){
    const rejected=await request(options,`${prefix}/channels/${id}/analyze-all`,{method:'POST',headers,body})
    assert.equal(rejected.res.statusCode,400)
  }
  try {
    const accepted=await request(options,`${prefix}/channels/${id}/analyze-all`,{method:'POST',headers,body:{}})
    assert.equal(accepted.res.statusCode,202);assert.equal(accepted.res.json().job.total,1)
    await started
    const repeated=await request(options,`${prefix}/channels/${id}/analyze-all`,{method:'POST',headers,body:{}})
    assert.equal(repeated.res.json().job.id,accepted.res.json().job.id)
    const progress=await request(options,`${prefix}/channels/${id}`)
    assert.equal(progress.res.json().channel.bulkAnalysis.status,'running');assert.equal(progress.res.json().channel.bulkAnalysis.currentItemId,itemId)
    const otherWorkspace=await request(privateOptions,`${prefix}/channels/${id}`)
    assert.equal(otherWorkspace.res.json().channel.bulkAnalysis,null)
    assert.equal((await request(privateOptions,`${prefix}/items/${itemId}`)).res.statusCode,404)
    assert.equal((await request(privateOptions,`${prefix}/channels/${id}/analyze-all`,{method:'POST',headers,body:{}})).res.statusCode,422)
    const invalidStop=await request(options,`${prefix}/channels/${id}/analyze-all/stop`,{method:'POST',headers,body:{itemId}})
    assert.equal(invalidStop.res.statusCode,400)
    const stopped=await request(options,`${prefix}/channels/${id}/analyze-all/stop`,{method:'POST',headers,body:{}})
    assert.equal(stopped.res.statusCode,202);assert.equal(stopped.res.json().job.status,'stopping')
  } finally {release()}
  await createVideoAnalysisService(options).whenIdle()
  const finished=await request(options,`${prefix}/channels/${id}`),job=finished.res.json().channel.bulkAnalysis
  assert.equal(job.status,'cancelled');assert.equal(job.analyzed,1);assert.equal(job.partial,1);assert.equal(calls,1)
  assert.ok(!JSON.stringify(job).includes(options.root),'public progress must not expose a host media path')
})
test('HTTP upload, durable list, media playback ranges and JSON download use ID-only routes',async t=>{
  const options=await fixture(t)
  const uploaded=await request(options,`${prefix}/uploads?filename=example.mp4`,{method:'POST',body:Buffer.from('0123456789'),headers:{'content-type':'video/mp4','content-length':'10'}})
  assert.equal(uploaded.res.statusCode,201)
  const item=uploaded.res.json().item
  const list=await request(options,`${prefix}/items`)
  assert.equal(list.res.json().items[0].id,item.id)
  const range=await request(options,`${prefix}/items/${item.id}/media`,{headers:{range:'bytes=2-5'}})
  assert.equal(range.res.statusCode,206);assert.equal(range.res.headers['content-range'],'bytes 2-5/10');assert.equal(Buffer.concat(range.res.parts).toString(),'2345')
  const suffix=await request(options,`${prefix}/items/${item.id}/media`,{headers:{range:'bytes=-3'}})
  assert.equal(Buffer.concat(suffix.res.parts).toString(),'789')
  const invalid=await request(options,`${prefix}/items/${item.id}/media`,{headers:{range:'bytes=99-'}})
  assert.equal(invalid.res.statusCode,416);assert.equal(invalid.res.headers['content-range'],'bytes */10')
  const head=await request(options,`${prefix}/items/${item.id}/media`,{method:'HEAD'})
  assert.equal(head.res.headers['content-length'],10);assert.equal(head.res.parts.length,0)
  const exported=await request(options,`${prefix}/items/${item.id}/export?format=json`)
  assert.equal(exported.res.statusCode,200);assert.equal(exported.res.json().mediaFile,undefined)
  const premature=await request(options,`${prefix}/items/${item.id}/export?format=txt`)
  assert.equal(premature.res.statusCode,409)
})
test('HTTP routes reject traversal, arbitrary body paths, duplicate queries and unknown verbs',async t=>{
  const options=await fixture(t)
  for(const url of [`${prefix}/items/%2e%2e/media`,`${prefix}/items/%2fsecret`,`${prefix}/items?root=C:/private`,`${prefix}/uploads?filename=a.mp4&filename=b.mp4`]) {
    const {res}=await request(options,url,{method:url.includes('/uploads')?'POST':'GET'})
    assert.ok([400,404].includes(res.statusCode),`${url} ${res.statusCode}`)
  }
  const bad=await request(options,`${prefix}/imports`,{method:'POST',headers:{'content-type':'application/json'},body:{url:'https://example.com/x.mp4',directory:'C:/private'}})
  assert.equal(bad.res.statusCode,400)
  assert.equal((await request(options,`${prefix}/items`,{method:'DELETE'})).res.statusCode,404)
  assert.equal((await request(options,'/api/something-else')).handled,false)
})
test('HTTP status includes the two supplied reference channels and reports unavailable analysis honestly',async t=>{
  const options=await fixture(t)
  const result=await request(options,`${prefix}/status`)
  assert.equal(result.res.statusCode,200)
  const value=result.res.json()
  assert.equal(value.referenceChannels.length,2);assert.equal(value.referenceChannels[0].id,'dreamcode_films')
  assert.equal(value.capabilities.analysis,false);assert.equal(value.limits.maxDurationSeconds,300)
})
test('HTTP channel catalog, style settings and library assignment use scoped validated routes',async t=>{
  const options=await fixture(t,{importer:{discoverChannel:async({url})=>({handle:new URL(url).pathname.split('/')[1],name:'Creator name',discoveredVideos:[{url:'https://instagram.com/reel/REFERENCE/',title:'Public reference'}]})}})
  const channels=await request(options,`${prefix}/channels`)
  assert.equal(channels.res.statusCode,200);assert.equal(channels.res.json().channels.length,2)
  const added=await request(options,`${prefix}/channels`,{method:'POST',headers:{'content-type':'application/json'},body:{url:'https://www.instagram.com/new_creator/'}})
  assert.equal(added.res.statusCode,201);const id=added.res.json().channel.id;assert.equal(id,'instagram-new_creator');assert.equal(added.res.json().channel.discoveredVideos.length,1)
  const updated=await request(options,`${prefix}/channels/${id}`,{method:'PATCH',headers:{'content-type':'application/json'},body:{style:{generationMethod:'footage_edit',editing:'Cut with the music'}}})
  assert.equal(updated.res.statusCode,200);assert.equal(updated.res.json().channel.style.editing,'Cut with the music')
  const uploaded=await request(options,`${prefix}/uploads?filename=travel.mp4&channelId=${id}`,{method:'POST',body:Buffer.from('video'),headers:{'content-type':'video/mp4','content-length':'5'}})
  assert.equal(uploaded.res.statusCode,201);const item=uploaded.res.json().item;assert.equal(item.source.channelId,id)
  const filtered=await request(options,`${prefix}/items?channelId=${id}`);assert.equal(filtered.res.json().items.length,1)
  const detail=await request(options,`${prefix}/channels/${id}`);assert.equal(detail.res.json().channel.observations.referenceCount,1)
  const assignment=await request(options,`${prefix}/items/${item.id}`,{method:'PATCH',headers:{'content-type':'application/json'},body:{channelId:'instagram-gdarusa'}})
  assert.equal(assignment.res.statusCode,200);assert.equal(assignment.res.json().item.source.channelId,'instagram-gdarusa')
  for(const [path,method,payload] of [[`/channels/${id}`,'PATCH',{style:{generationMethod:'invalid'}}],[`/channels/${id}/sync`,'POST',{root:'bad'}],[`/channels`,'POST',{url:'https://example.com/arbitrary/'}]]){const invalid=await request(options,prefix+path,{method,headers:{'content-type':'application/json'},body:payload});assert.ok(invalid.res.statusCode>=400)}
  const missingAvatar=await request(options,`${prefix}/channels/${id}/avatar?v=1`);assert.equal(missingAvatar.res.statusCode,404)
  const arbitraryImage=await request(options,`${prefix}/channels/${id}/thumbnail?video=UNLISTED`);assert.equal(arbitraryImage.res.statusCode,404)
})
test('range parser bounds open, suffix and invalid multi-range requests',()=>{
  assert.deepEqual(parseVideoByteRange('bytes=2-',10),{start:2,end:9})
  assert.deepEqual(parseVideoByteRange('bytes=0-999',10),{start:0,end:9})
  assert.deepEqual(parseVideoByteRange('bytes=-999',10),{start:0,end:9})
  for(const range of ['bytes=','bytes=-0','bytes=3-2','bytes=0-1,4-5','bytes=9007199254740992-'])assert.throws(()=>parseVideoByteRange(range,10),{status:416})
})

test('HTTP full-channel discovery starts asynchronously and exposes durable coverage without cursors',async t=>{
  const options=await fixture(t,{getDiscoveryConfig:async()=>({SPUR_INSTAGRAM_ACCESS_TOKEN:'test-private-token'}),importer:{discoverChannelPage:async({cursor,config})=>{assert.equal(config.SPUR_INSTAGRAM_ACCESS_TOKEN,'test-private-token');return {handle:'dreamcode_films',source:'instagram_authorized',authoritative:true,coverage:'paginated',discoveredVideos:[{url:`https://www.instagram.com/reel/${cursor?'SECOND':'FIRST'}/`}],pageInfo:cursor?{hasNextPage:false}:{hasNextPage:true,endCursor:'private-next-cursor'}}}}})
  const start=await request(options,`${prefix}/channels/instagram-dreamcode_films/discover`,{method:'POST',headers:{'content-type':'application/json'},body:{resume:true}})
  assert.equal(start.res.statusCode,202);assert.equal(start.res.json().channel.discovery.status,'running')
  await waitForVideoAnalysisIdle()
  const detail=await request(options,`${prefix}/channels/instagram-dreamcode_films`)
  const channel=detail.res.json().channel;assert.equal(channel.discoveredVideos.length,2);assert.equal(channel.discovery.status,'complete');assert.equal(channel.discovery.hasNextPage,false);assert.equal(channel.catalogComplete,true)
  assert.ok(!JSON.stringify(channel).includes('private-next-cursor'));assert.ok(!JSON.stringify(channel).includes('test-private-token'))
  const invalid=await request(options,`${prefix}/channels/instagram-dreamcode_films/discover`,{method:'POST',headers:{'content-type':'application/json'},body:{resume:'yes'}})
  assert.equal(invalid.res.statusCode,400)
  const pathInjection=await request(options,`${prefix}/channels/instagram-dreamcode_films/discover`,{method:'POST',headers:{'content-type':'application/json'},body:{resume:true,root:'C:/elsewhere'}})
  assert.equal(pathInjection.res.statusCode,400)
})
