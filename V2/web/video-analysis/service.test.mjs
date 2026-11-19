import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {Readable} from 'node:stream'
import {createVideoAnalysisService,createReelTextExport,VIDEO_ANALYSIS_LIMITS,waitForVideoAnalysisIdle} from './service.mjs'
import {resolveAnalysisSelection} from './analysis-providers.mjs'

const sample=()=>({schemaVersion:1,summary:'A mountain sunrise reel.',durationSeconds:12,shots:[{index:0,startSeconds:0,endSeconds:12,visual:'Mountain sunrise',framing:'Wide shot',cameraMovement:'Slow pan',action:'Sun rises',onScreenText:['Get outside'],audio:'Instrumental music',spokenText:'A new morning.'}],script:{segments:[{startSeconds:1,endSeconds:3,text:'A new morning.'}],text:'A new morning.',onScreenText:[{startSeconds:0,endSeconds:2,text:'Get outside'}]},audio:{timelineVersion:1,status:'unavailable',windows:[],onsetCandidates:[],semanticStatus:'analyzed',speechStatus:'analyzed',semanticEvents:[]},warnings:[],provenance:{model:'test-analyzer'}})
async function fixture(t,options={}) {
  const root=await mkdtemp(join(process.cwd(),'.spur-analysis-test-'))
  t.after(async()=>{await waitForVideoAnalysisIdle();await rm(root,{recursive:true,force:true})})
  return {root,service:createVideoAnalysisService({root,...options})}
}
const upload=service=>service.upload(Readable.from([Buffer.from('test-video-bytes')]),{filename:'mountains.mp4',contentType:'video/mp4',contentLength:16})

test('explicit model selection freezes credentials and provider for queued work without exposing them',async t=>{
  const config={SPUR_VIDEO_ANALYSIS_PROVIDER:'siliconflow',SILICONFLOW_API_KEY:'private-original-key',POE_API_KEY:'private-poe-key'},calls=[]
  let release,entered
  const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve)
  const {root,service}=await fixture(t,{config,engine:{analyze:async({config:jobConfig})=>{calls.push({...jobConfig});if(calls.length===1){entered();await gate}return sample()}}})
  const first=await upload(service),second=await upload(service)
  try{
    await service.analyze(first.id,{analysisModelId:'siliconflow-qwen3-omni-thinking'});await started
    const receipt=await service.analyze(second.id,{analysisModelId:'siliconflow-qwen3-omni-thinking'})
    assert.equal(receipt.analysisModelId,'siliconflow-qwen3-omni-thinking')
    config.SILICONFLOW_API_KEY='private-changed-key';config.SPUR_VIDEO_ANALYSIS_PROVIDER='poe'
  }finally{release()}
  await service.whenIdle()
  assert.equal(calls.length,2)
  for(const call of calls){assert.equal(call.SPUR_VIDEO_ANALYSIS_PROVIDER,'siliconflow');assert.equal(call.SPUR_VIDEO_ANALYSIS_CLOUD_MODEL,'Qwen/Qwen3-Omni-30B-A3B-Thinking');assert.equal(call.SILICONFLOW_API_KEY,'private-original-key')}
  await assert.rejects(service.analyze(first.id,{analysisModelId:'arbitrary-provider'}),{status:422})
  const status=await service.status();assert.equal(status.defaultAnalysisModelId,'poe-gemini-3.7-flash')
  assert.equal(status.analysisModels.find(value=>value.id==='poe-gemini-3.7-flash').available,true)
  assert.doesNotMatch(JSON.stringify(status),/private-original|private-changed|private-poe/)
  assert.doesNotMatch(await readFile(join(root,'reference-library.json'),'utf8'),/private-original|private-changed|private-poe/)
})

test('bulk analysis freezes its model across the batch and reanalyzes when switching providers',async t=>{
  const config={SPUR_VIDEO_ANALYSIS_PROVIDER:'siliconflow',SILICONFLOW_API_KEY:'private-silicon-key',POE_API_KEY:'private-poe-key'},calls=[],channelId='instagram-dreamcode_films'
  let release,entered
  const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve)
  const {root,service}=await fixture(t,{config,engine:{analyze:async({config:jobConfig,mode})=>{
    const selection=resolveAnalysisSelection(jobConfig);calls.push(selection.provider)
    if(calls.length===1){entered();await gate}
    return {...sample(),mode,status:'complete',provenance:{multimodal:{provider:selection.provider,model:selection.model,mediaTransport:selection.target.mediaTransport,status:'analyzed'},vision:{status:'analyzed'},speech:{status:'analyzed'},ocr:{status:'analyzed'}}}
  }}})
  for(let index=0;index<2;index++)await service.upload(Readable.from(['saved']),{filename:`batch-${index}.mp4`,channelId})
  try{
    const receipt=await service.analyzeAllChannelVideos(channelId,{analysisModelId:'siliconflow-qwen3-omni-thinking'});await started
    assert.equal(receipt.job.analysisModelId,'siliconflow-qwen3-omni-thinking')
    config.SPUR_VIDEO_ANALYSIS_PROVIDER='poe'
    await assert.rejects(service.analyzeAllChannelVideos(channelId,{analysisModelId:'poe-gemini-3.7-flash'}),{status:409})
  }finally{release()}
  await service.whenIdle();assert.deepEqual(calls,['siliconflow','siliconflow'])
  await service.analyzeAllChannelVideos(channelId,{analysisModelId:'poe-gemini-3.7-flash'});await service.whenIdle()
  assert.deepEqual(calls,['siliconflow','siliconflow','poe','poe'])
  for(const item of await service.list({channelId})){const saved=await service.get(item.id);assert.equal(saved.result.provenance.multimodal.provider,'poe');assert.equal(saved.result.provenance.multimodal.model,'Gemini-3.7-Flash')}
  await service.analyzeAllChannelVideos(channelId,{analysisModelId:'poe-gemini-3.7-flash'});await service.whenIdle()
  assert.equal(calls.length,4);assert.equal((await service.getChannel(channelId)).bulkAnalysis.skipped,2)
  assert.doesNotMatch(await readFile(join(root,'channel-analysis-job.json'),'utf8'),/private-silicon|private-poe|POE_API_KEY|SILICONFLOW_API_KEY/)
})

test('a known-unavailable default cannot queue work or change an existing result',async t=>{
  const config={SPUR_VIDEO_ANALYSIS_PROVIDER:'siliconflow',SILICONFLOW_API_KEY:'synthetic-key'},channelId='instagram-dreamcode_films';let calls=0
  const {service}=await fixture(t,{config,engine:{analyze:async()=>{calls++;return sample()}}})
  const item=await service.upload(Readable.from(['saved']),{filename:'preserved.mp4',channelId})
  await service.analyze(item.id);await service.whenIdle()
  const before=await service.get(item.id)
  Object.assign(config,{SPUR_VIDEO_ANALYSIS_PROVIDER:'poe',POE_API_KEY:'synthetic-key',SPUR_POE_FLASH_API_AVAILABLE:'0'})
  await assert.rejects(service.analyze(item.id),{status:503,code:'analysis_model_unavailable'})
  await assert.rejects(service.analyzeAllChannelVideos(channelId),{status:503,code:'analysis_model_unavailable'})
  assert.deepEqual(await service.get(item.id),before);assert.equal(calls,1)
  assert.equal((await service.getChannel(channelId)).bulkAnalysis,null)
})

test('default Flash jobs are allowed despite an old Argon refusal and save the actual selected model',async t=>{
  const calls=[],config={SPUR_VIDEO_ANALYSIS_PROVIDER:'poe',POE_API_KEY:'synthetic-key',SPUR_POE_ARGON_API_AVAILABLE:'0'}
  const {service}=await fixture(t,{config,engine:{analyze:async({config:jobConfig,mode})=>{
    calls.push(jobConfig.SPUR_VIDEO_ANALYSIS_POE_MODEL)
    return {...sample(),mode,status:'complete',provenance:{multimodal:{provider:'poe',model:jobConfig.SPUR_VIDEO_ANALYSIS_POE_MODEL,mediaTransport:'original_video',status:'analyzed'},vision:{provider:'poe',status:'analyzed'},speech:{provider:'poe',status:'analyzed'},ocr:{provider:'poe',status:'analyzed'}}}
  }}})
  const item=await upload(service)
  const receipt=await service.analyze(item.id)
  assert.equal(receipt.analysisModelId,'poe-gemini-3.7-flash')
  await service.whenIdle()
  const saved=await service.get(item.id)
  assert.equal(saved.status,'complete')
  assert.deepEqual(calls,['Gemini-3.7-Flash'])
  assert.equal(saved.result.provenance.multimodal.model,'Gemini-3.7-Flash')
  assert.equal(saved.result.script.text,'A new morning.')
  assert.equal(saved.result.scriptBreakdown.columns.length,9)
  assert.equal(saved.result.scriptStructure,undefined)
})

test('switching the selectable Poe model preserves historical Argon results on reload without starting analysis',async t=>{
  let calls=0
  const {root,service}=await fixture(t)
  const item=await upload(service),filename=join(root,'reference-library.json')
  const document=JSON.parse(await readFile(filename,'utf8')),legacy=document.items.find(value=>value.id===item.id)
  legacy.status='complete';legacy.durationSeconds=12
  legacy.result={...sample(),mode:'both',status:'complete',provenance:{multimodal:{provider:'poe',model:'Gemini-4-Argon',mediaTransport:'original_video',status:'analyzed'}}}
  await writeFile(filename,JSON.stringify(document))
  const original=await readFile(filename,'utf8'),module=await import(`./service.mjs?flash-history=${Date.now()}`)
  const restored=module.createVideoAnalysisService({root,config:{SPUR_VIDEO_ANALYSIS_PROVIDER:'poe',POE_API_KEY:'synthetic-key',SPUR_POE_ARGON_API_AVAILABLE:'0'},engine:{analyze:async()=>{calls++;throw Error('Loading a saved analysis must not run a model')}}})
  assert.equal((await restored.status()).defaultAnalysisModelId,'poe-gemini-3.7-flash')
  assert.equal((await restored.get(item.id)).result.provenance.multimodal.model,'Gemini-4-Argon')
  const exported=JSON.parse((await restored.exportItem(item.id,{format:'json'})).body)
  assert.equal(exported.result.provenance.multimodal.model,'Gemini-4-Argon')
  assert.equal(exported.result.script.text,'A new morning.')
  assert.equal(calls,0)
  assert.equal(await readFile(filename,'utf8'),original)
})

test('script retries retain partial status when saved visual evidence remains incomplete',async t=>{
  for(const visualStatus of ['failed','partial','unavailable']){
    const {service}=await fixture(t,{engine:{analyze:async({mode})=>{
      const value=sample();value.mode=mode;value.status=mode==='both'?'partial':'complete'
      value.provenance={vision:{provider:'ollama',status:mode==='both'?visualStatus:'not_requested'},boundaries:{status:'analyzed'},speech:{status:'analyzed'},ocr:{status:'analyzed'}}
      if(mode==='both')value.shots[0].visual=null
      return value
    }}})
    const item=await upload(service);await service.analyze(item.id);await service.whenIdle()
    await service.analyze(item.id,{mode:'script'});await service.whenIdle()
    const saved=await service.get(item.id)
    assert.equal(saved.status,'partial',visualStatus);assert.equal(saved.result.status,'partial',visualStatus)
    assert.equal(saved.result.provenance.vision.status,visualStatus);assert.equal(saved.result.shots[0].visual,null)
    assert.equal(saved.result.provenance.speech.status,'analyzed')
  }
})

test('local bulk analysis replaces retained cloud visuals instead of skipping a mixed audio retry',async t=>{
  const modes=[],channelId='instagram-dreamcode_films'
  const {service}=await fixture(t,{engine:{analyze:async({mode})=>{
    modes.push(mode);const value={...sample(),mode,status:'complete'}
    const provider=modes.length===1?'siliconflow':'ollama'
    value.provenance={vision:{provider,model:modes.length===1?'Qwen':'local-vision',status:mode==='audio'?'not_requested':'analyzed'},boundaries:{provider,status:'analyzed'},ocr:{provider,status:mode==='audio'?'not_requested':'analyzed'},speech:{...(modes.length===1?{provider:'siliconflow',model:'Qwen'}:{method:'whisper.cpp',model:'ggml-base-q5_1.bin'}),status:'analyzed'},soundEvents:{...(modes.length===1?{provider:'siliconflow',model:'Qwen'}:{method:'yamnet_waveform_classification',model:'Google YAMNet / AudioSet 521 classes'}),status:'analyzed'},audio:{method:'ffmpeg_rms_energy_onsets',status:'analyzed'}}
    if(modes.length===1)value.provenance.multimodal={provider:'siliconflow',model:'Qwen',status:'analyzed',mediaTransport:'original_video'}
    return value
  }}})
  const item=await service.upload(Readable.from(['saved']),{filename:'mixed.mp4',channelId})
  await service.analyze(item.id);await service.whenIdle()
  await service.analyze(item.id,{mode:'audio'});await service.whenIdle()
  assert.equal((await service.get(item.id)).result.provenance.vision.provider,'siliconflow')
  for(const format of ['txt','md']){
    const text=(await service.exportItem(item.id,{format})).body
    assert.match(text,/Analysis sources: mixed/)
    assert.match(text,/Visual analysis: siliconflow; model: Qwen/)
    assert.match(text,/Speech transcription: local; model: ggml-base-q5_1\.bin/)
    assert.match(text,/Sound analysis: local; model: Google YAMNet \/ AudioSet 521 classes/)
    assert.doesNotMatch(text,/Analysis provider:|ffmpeg_rms_energy_onsets/)
  }
  await service.analyzeAllChannelVideos(channelId);await service.whenIdle()
  assert.deepEqual(modes,['both','audio','both'])
  assert.equal((await service.get(item.id)).result.provenance.vision.provider,'ollama')
  await service.analyzeAllChannelVideos(channelId);await service.whenIdle()
  assert.equal(modes.length,3);assert.equal((await service.getChannel(channelId)).bulkAnalysis.skipped,1)
})

test('uniform cloud exports retain their provider headline and ignore local measurement provenance',()=>{
  const result=sample(),identity={provider:'siliconflow',model:'Qwen',status:'analyzed'}
  result.provenance={multimodal:{...identity},vision:{...identity},speech:{...identity},soundEvents:{...identity},audio:{provider:'local',model:'FFmpeg',status:'analyzed'}}
  const item={id:'12345678-1234-1234-1234-123456789abc',title:'Uniform cloud',result,source:{kind:'upload'}}
  for(const format of ['txt','md']){
    const text=createReelTextExport(item,format).body
    assert.match(text,/Analysis provider: siliconflow; model: Qwen/)
    assert.doesNotMatch(text,/Analysis sources: mixed|Visual analysis:|Speech transcription:|Sound analysis:/)
  }
})

test('local catalog availability reuses the existing capability result without additional probing',async t=>{
  let probes=0
  const {service}=await fixture(t,{engine:{capabilities:async()=>{probes++;return {available:false,warnings:['No local models are ready.']}}}})
  const status=await service.status(),local=status.analysisModels.find(model=>model.id==='local')
  assert.equal(probes,1);assert.equal(local.available,false);assert.equal(local.reason,'No local models are ready.')
})

test('generated outputs retain their source relation and do not become creator-style training evidence',async t=>{
  const {service}=await fixture(t,{engine:{analyze:async()=>sample()}})
  const original=await service.upload(Readable.from(['source']),{filename:'source.mp4',channelId:'instagram-dreamcode_films'})
  await service.analyze(original.id);await service.whenIdle()
  const derived=await service.upload(Readable.from(['generated']),{filename:'recreation.mp4',channelId:'instagram-dreamcode_films',reconstruction:{referenceId:original.id,jobId:'22345678-1234-1234-1234-123456789abc'}})
  await service.analyze(derived.id);await service.whenIdle()
  assert.equal(derived.source.kind,'reconstruction')
  assert.equal(derived.source.referenceId,original.id)
  assert.equal(derived.source.reconstructionId,'22345678-1234-1234-1234-123456789abc')
  const channel=await service.getChannel('instagram-dreamcode_films')
  assert.equal(channel.observations.referenceCount,1)
  assert.equal(channel.observations.analyzedCount,1)
  assert.equal(channel.observations.shotCount,1)
  await assert.rejects(service.upload(Readable.from(['other']),{filename:'other.mp4',reconstruction:{referenceId:'../../outside',jobId:'22345678-1234-1234-1234-123456789abc'}}),{status:404})
})

test('Import all uses the real bounded queue, skips existing imports and reports individual errors without running analysis',async t=>{
  let calls=0,analysis=0
  const catalog=Array.from({length:30},(_,i)=>({url:`https://www.tiktok.com/@bulkcreator/video/${7014215295795498000n+BigInt(i)}`,title:`Reference ${i}`}))
  const {service}=await fixture(t,{importer:{discoverChannel:async()=>({handle:'bulkcreator',discoveredVideos:catalog}),importVideo:async({directory,url})=>{
    calls++;if(url===catalog[4].url)throw Object.assign(new Error('This video is private.'),{status:403})
    const filePath=join(directory,'reference.mp4');await writeFile(filePath,'video');return {filePath,title:'Imported',sourceUrl:url,creatorHandle:'bulkcreator',durationSeconds:5}
  }},engine:{analyze:async()=>{analysis++;return sample()}}})
  const channel=await service.addChannel('https://www.tiktok.com/@bulkcreator')
  await service.importUrl(catalog[0].url,{channelId:channel.id});await service.whenIdle()
  const started=await service.importAllChannelVideos(channel.id)
  assert.equal(started.job.total,30)
  await service.whenIdle()
  const complete=await service.getChannel(channel.id)
  assert.equal(complete.bulkImport.status,'complete');assert.equal(complete.bulkImport.imported,28)
  assert.equal(complete.bulkImport.skipped,1);assert.equal(complete.bulkImport.failed,1);assert.equal(calls,30);assert.equal(analysis,0)
  assert.equal((await service.list({channelId:channel.id})).filter(item=>item.hasMedia).length,29)
  const again=await service.importAllChannelVideos(channel.id);await service.whenIdle()
  const retried=await service.getChannel(channel.id)
  assert.notEqual(again.job.id,started.job.id);assert.equal(retried.bulkImport.skipped,29);assert.equal(calls,31)
})

test('Analyze all serializes more than a queueful of saved videos, skips results, preserves partials and isolates the channel',async t=>{
  const channelA='instagram-dreamcode_films',channelB='instagram-gdarusa',calls=[]
  let active=0,peak=0,imports=0,batchPhase=false,held=false,release,entered
  const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve)
  const {service}=await fixture(t,{importer:{discoverChannel:async()=>({handle:'dreamcode_films',discoveredVideos:[{url:'https://www.instagram.com/reel/DISCOVERED_ONLY/',title:'Not imported'}]}),importVideo:async()=>{imports++;throw Error('Discovered-only media must not be downloaded by Analyze all')}},engine:{analyze:async({filePath,mode})=>{
    assert.equal(mode,'both')
    const label=await readFile(filePath,'utf8');calls.push(label);active++;peak=Math.max(peak,active)
    try {
      if(batchPhase&&!held){held=true;entered();await gate}
      if(label==='video-03')throw Error('This one video could not be transcribed.')
      return ['video-01','video-02'].includes(label)?{...sample(),status:'partial',warnings:['Speech unavailable for this reference.']}:sample()
    } finally {active--}
  }}})
  await service.syncChannel(channelA)
  const saved=[]
  for(let index=0;index<30;index++)saved.push(await service.upload(Readable.from([`video-${String(index).padStart(2,'0')}`]),{filename:`video-${index}.mp4`,channelId:channelA}))
  const other=await service.upload(Readable.from(['other-channel']),{filename:'other.mp4',channelId:channelB})
  const unassigned=await upload(service)
  for(const item of saved.slice(0,2)){await service.analyze(item.id);await service.whenIdle()}
  assert.equal((await service.get(saved[1].id)).status,'partial')
  calls.length=0;batchPhase=true
  try {
    const accepted=await service.analyzeAllChannelVideos(channelA)
    assert.equal(accepted.job.total,30)
    await started
    assert.equal((await service.analyzeAllChannelVideos(channelA)).job.id,accepted.job.id)
    await assert.rejects(service.analyzeAllChannelVideos(channelB),{status:409})
    await assert.rejects(service.importAllChannelVideos(channelA),{status:409})
  } finally {release()}
  await service.whenIdle()
  const channel=await service.getChannel(channelA),job=channel.bulkAnalysis
  assert.equal(job.status,'complete');assert.equal(job.processed,30);assert.equal(job.analyzed,27)
  assert.equal(job.partial,1);assert.equal(job.skipped,2);assert.equal(job.failed,1);assert.equal(peak,1)
  assert.equal(calls.length,28);assert.equal(imports,0)
  assert.ok(!calls.includes('video-00'));assert.ok(!calls.includes('video-01'))
  assert.equal(job.failures[0].itemId,saved[3].id);assert.match(job.failures[0].error,/could not be transcribed/)
  assert.equal((await service.get(saved[2].id)).status,'partial')
  assert.equal((await service.get(saved[4].id)).status,'complete','a failure must not stop later references')
  assert.equal((await service.get(other.id)).status,'ready');assert.equal((await service.get(unassigned.id)).status,'ready')
  assert.equal((await service.getChannel(channelB)).bulkAnalysis,null)
  assert.equal(channel.discoveredVideos.length,1);assert.equal((await service.list({channelId:channelA})).length,30)
})

test('stopping Analyze all lets the current video finish and leaves later media ready',async t=>{
  let release,entered,calls=0
  const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve)
  const {service}=await fixture(t,{engine:{analyze:async()=>{calls++;entered();await gate;return sample()}}})
  const id='instagram-dreamcode_films',saved=[]
  for(let index=0;index<3;index++)saved.push(await service.upload(Readable.from(['video']),{filename:`stop-${index}.mp4`,channelId:id}))
  try {
    await service.analyzeAllChannelVideos(id);await started
    const stopped=await service.stopChannelAnalyses(id)
    assert.equal(stopped.job.status,'stopping');assert.equal(stopped.job.processed,0)
  } finally {release()}
  await service.whenIdle()
  const job=(await service.getChannel(id)).bulkAnalysis
  assert.equal(job.status,'cancelled');assert.equal(job.processed,1);assert.equal(job.analyzed,1);assert.equal(calls,1)
  const states=await Promise.all(saved.map(item=>service.get(item.id)))
  assert.equal(states.filter(item=>item.status==='complete').length,1)
  assert.equal(states.filter(item=>item.status==='ready'&&item.hasMedia).length,2)
})

test('Analyze all waits for an active channel import instead of starting a competing batch',async t=>{
  let release,entered,analyses=0
  const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve)
  const {service}=await fixture(t,{engine:{analyze:async()=>{analyses++;return sample()}},importer:{discoverChannel:async()=>({handle:'dreamcode_films',discoveredVideos:[{url:'https://www.instagram.com/reel/HELD_IMPORT/'}]}),importVideo:async({directory,url})=>{
    entered();await gate;const filePath=join(directory,'import.mp4');await writeFile(filePath,'video');return {filePath,sourceUrl:url,creatorHandle:'dreamcode_films'}
  }}})
  const id='instagram-dreamcode_films'
  await service.syncChannel(id);await service.upload(Readable.from(['saved']),{filename:'saved.mp4',channelId:id})
  try {
    await service.importAllChannelVideos(id);await started
    await assert.rejects(service.analyzeAllChannelVideos(id),{status:409})
    assert.equal(analyses,0)
  } finally {release()}
  await service.whenIdle()
  assert.equal((await service.getChannel(id)).bulkImport.status,'complete')
})

test('channel discovery reads host credentials per page and never persists a provider token error',async t=>{
  const secret='private-token-that-must-not-be-saved',calls=[]
  const {root,service}=await fixture(t,{config:{SPUR_VIDEO_ANALYSIS_MODEL:'local'},getDiscoveryConfig:async()=>({SPUR_INSTAGRAM_ACCESS_TOKEN:secret}),importer:{discoverChannelPage:async({config,cursor})=>{calls.push({token:config.SPUR_INSTAGRAM_ACCESS_TOKEN,cursor,model:config.SPUR_VIDEO_ANALYSIS_MODEL});if(cursor)throw Object.assign(Error(`Failed request https://graph.instagram.com/media?access_token=${secret}`),{status:401,code:'instagram_connection_required',requiresConnection:true});return {handle:'dreamcode_films',source:'instagram_authorized',coverage:'paginated',discoveredVideos:[{url:'https://www.instagram.com/reel/HOST_CONFIG/'}],pageInfo:{hasNextPage:true,endCursor:'next-private-page'}}}}})
  const accepted=await service.discoverChannel('instagram-dreamcode_films')
  assert.equal(accepted.discovery.status,'running');await service.whenIdle()
  const channel=await service.getChannel(accepted.id)
  assert.equal(calls.length,2);assert.equal(calls[0].token,secret);assert.equal(calls[0].model,'local')
  assert.equal(channel.discovery.status,'blocked');assert.equal(channel.discovery.requiresConnection,true)
  assert.ok(!JSON.stringify(channel).includes(secret));assert.ok(!JSON.stringify(channel).includes('next-private-page'));assert.ok(!(await readFile(join(root,'channels.json'),'utf8')).includes(secret));assert.match(channel.discovery.message,/redacted/)
})

test('upload is persistent and library never exposes host media paths',async t=>{
  const {root,service}=await fixture(t)
  const item=await upload(service)
  assert.equal(item.title,'mountains');assert.equal(item.status,'ready');assert.equal(item.hasMedia,true)
  assert.equal(item.mediaFile,undefined)
  const file=await service.getMedia(item.id)
  assert.equal(await readFile(file.filePath,'utf8'),'test-video-bytes')
  const disk=JSON.parse(await readFile(join(root,'reference-library.json'),'utf8'))
  assert.equal(disk.items[0].id,item.id)
  assert.ok(disk.items[0].mediaFile.startsWith(item.id))
  assert.equal((await service.list()).length,1)
})

test('channel libraries and saved production preferences stay separate; unknown uploads can be assigned',async t=>{
  const {service}=await fixture(t,{engine:{analyze:async()=>sample()}})
  const channelA='instagram-dreamcode_films',channelB='instagram-gdarusa'
  const selected=await service.upload(Readable.from(['reference']),{filename:'reference.mp4',channelId:channelA})
  const unassigned=await upload(service)
  assert.equal(selected.source.channelId,channelA)
  assert.equal((await service.list({channelId:channelA})).length,1)
  assert.equal((await service.list({channelId:channelB})).length,0)
  await service.assignChannel(unassigned.id,channelB)
  assert.equal((await service.list({channelId:channelB}))[0].id,unassigned.id)
  await service.updateChannel(channelA,{style:{generationMethod:'ai_video',direction:'Surreal cinematic scenes'}})
  assert.equal((await service.getChannel(channelA)).style.generationMethod,'ai_video')
  assert.equal((await service.getChannel(channelB)).style.generationMethod,'auto')
  await service.analyze(selected.id);await service.whenIdle()
  const observed=(await service.getChannel(channelA)).observations
  assert.equal(observed.analyzedCount,1);assert.equal(observed.shotCount,1);assert.equal(observed.visualExamples[0].text,'Mountain sunrise')
  assert.equal((await service.getChannel(channelB)).observations.analyzedCount,0)
  await service.assignChannel(unassigned.id,null)
  assert.equal((await service.get(unassigned.id)).source.channelId,undefined)
  await assert.rejects(service.upload(Readable.from(['x']),{filename:'x.mp4',channelId:'instagram-unknown'}),{status:404})
})

test('real Instagram ownership overrides the selected channel and cannot be relabeled',async t=>{
  const {service}=await fixture(t,{importer:{importVideo:async({directory})=>{const filePath=join(directory,'download.mp4');await writeFile(filePath,'real-reference');return {filePath,title:'Creator reference',sourceUrl:'https://instagram.com/reel/ACTUAL/',creatorHandle:'gdarusa'}}}})
  const queued=await service.importUrl('https://instagram.com/reel/ACTUAL/',{channelId:'instagram-dreamcode_films'})
  await service.whenIdle();const item=await service.get(queued.id)
  assert.equal(item.source.creatorHandle,'gdarusa');assert.equal(item.source.channelId,'instagram-gdarusa')
  assert.equal((await service.list({channelId:'instagram-dreamcode_films'})).length,0)
  assert.equal((await service.list({channelId:'instagram-gdarusa'}))[0].id,item.id)
  await assert.rejects(service.assignChannel(item.id,'instagram-dreamcode_films'),{status:409,code:'channel_owner_conflict'})
})

test('existing profile provenance is migrated without discarding the saved video or result',async t=>{
  const {root,service}=await fixture(t);const item=await upload(service)
  const index=join(root,'reference-library.json'),document=JSON.parse(await readFile(index,'utf8'))
  document.items[0].source={kind:'url',url:'https://www.instagram.com/reel/KNOWN/',profileUrl:'https://instagram.com/dreamcode_films/'};document.items[0].result=sample();await writeFile(index,JSON.stringify(document))
  const fresh=await import(`./service.mjs?channels-migration=${Date.now()}`),migrated=fresh.createVideoAnalysisService({root})
  const restored=await migrated.get(item.id);assert.equal(restored.source.channelId,'instagram-dreamcode_films');assert.equal(restored.result.script.text,'A new morning.');assert.equal(restored.hasMedia,true)
  assert.equal(JSON.parse(await readFile(index,'utf8')).items[0].source.channelId,'instagram-dreamcode_films')
})

test('analysis runs asynchronously, keeps source evidence and exports timed script and shots',async t=>{
  let invocation
  const {service}=await fixture(t,{engine:{capabilities:async()=>({analysis:true}),analyze:async args=>{invocation=args;await args.onProgress('Looking at shots');return sample()}}})
  const item=await upload(service)
  assert.equal((await service.analyze(item.id,{mode:'both'})).status,'queued')
  await service.whenIdle()
  const result=await service.get(item.id)
  assert.equal(result.status,'complete');assert.equal(result.durationSeconds,12);assert.equal(invocation.mode,'both')
  assert.ok(invocation.filePath.startsWith(invocation.allowedRoots[0]))
  const text=await service.exportItem(item.id,{format:'txt'})
  assert.match(text.body,/\[00:01\.00–00:03\.00\] A new morning\./)
  assert.match(text.body,/Camera movement: Slow pan/)
  assert.match((await service.exportItem(item.id,{format:'md'})).body,/# Spoken script/)
  assert.equal(JSON.parse((await service.exportItem(item.id,{format:'json'})).body).mediaFile,undefined)
})

test('one host worker serializes analysis across workspaces and duplicate starts are idempotent',async t=>{
  let active=0,peak=0,calls=0,release
  const held=new Promise(done=>release=done)
  const engine={analyze:async()=>{calls++;active++;peak=Math.max(peak,active);if(calls===1)await held;active--;return sample()}}
  const a=await fixture(t,{engine}),b=await fixture(t,{engine})
  const itemA=await upload(a.service),itemB=await upload(b.service)
  await a.service.analyze(itemA.id);await a.service.analyze(itemA.id);await b.service.analyze(itemB.id)
  release();await waitForVideoAnalysisIdle()
  assert.equal(peak,1);assert.equal(calls,2)
  await assert.rejects(b.service.get(itemA.id),{status:404})
})

test('partial analysis is explicit and engine errors do not become made-up scripts',async t=>{
  let calls=0
  const {service}=await fixture(t,{engine:{analyze:async()=>{calls++;if(calls===1)return {...sample(),status:'partial',warnings:['Speech transcription is not configured.']};throw Error('Transcription unavailable')}}})
  const item=await upload(service)
  await service.analyze(item.id);await service.whenIdle()
  const partial=await service.get(item.id)
  assert.equal(partial.status,'partial',partial.error)
  await service.analyze(item.id,{mode:'script'});await service.whenIdle()
  const failed=await service.get(item.id)
  assert.equal(failed.status,'failed');assert.equal(failed.retryable,true);assert.match(failed.error,/Transcription unavailable/)
})

test('URL imports are asynchronous, confined and do not automatically spend on analysis',async t=>{
  let imports=0
  const {service}=await fixture(t,{importer:{importVideo:async({directory,url})=>{imports++;const filePath=join(directory,'download.mp4');await writeFile(filePath,'imported');return {filePath,title:'Reference reel',sourceUrl:url}}}})
  const item=await service.importUrl('https://www.instagram.com/reel/abc123/')
  assert.equal(item.status,'queued')
  assert.equal((await service.importUrl('https://www.instagram.com/reel/abc123/')).id,item.id)
  await service.whenIdle()
  const result=await service.get(item.id)
  assert.equal(result.title,'Reference reel');assert.equal(result.status,'ready');assert.equal(imports,1)
  assert.equal(await readFile((await service.getMedia(item.id)).filePath,'utf8'),'imported')
})

test('direct TikTok imports refresh their automatically created creator profile once per channel',async t=>{
  let discoveries=0,imports=0
  const {service}=await fixture(t,{importer:{discoverChannel:async({url})=>{
    discoveries++;assert.equal(url,'https://www.tiktok.com/@creator_test')
    return {handle:'creator_test',name:'Creator Test',discoveredVideos:[]}
  },importVideo:async({directory,url})=>{
    imports++;const filePath=join(directory,'tiktok.mp4');await writeFile(filePath,'video')
    return {filePath,sourceUrl:url,creatorHandle:'creator_test',durationSeconds:5}
  }}})
  for(const videoId of ['7014215295795498245','7014215295795498246']){
    const imported=await service.importUrl(`https://www.tiktok.com/@creator_test/video/${videoId}`)
    await service.whenIdle()
    const item=await service.get(imported.id)
    assert.equal(item.status,'ready');assert.equal(item.source.channelId,'tiktok-creator_test')
  }
  const channel=await service.getChannel('tiktok-creator_test')
  assert.equal(channel.name,'Creator Test');assert.ok(channel.lastSyncedAt)
  assert.equal(imports,2);assert.equal(discoveries,1)
})

test('unsafe file names, oversized uploads, invalid modes and private URL forms are rejected',async t=>{
  const {service}=await fixture(t)
  await assert.rejects(service.upload(Readable.from(['x']),{filename:'../bad.mp4'}),{status:422})
  await assert.rejects(service.upload(Readable.from(['x']),{filename:'bad.html'}),{status:415})
  await assert.rejects(service.upload(Readable.from(['x']),{filename:'big.mp4',contentLength:VIDEO_ANALYSIS_LIMITS.maxUploadBytes+1}),{status:413})
  await assert.rejects(service.upload(Readable.from(['x']),{filename:'empty.mp4',contentLength:0}),{status:400})
  await assert.rejects(service.importUrl('file:///etc/passwd'),{status:422})
  await assert.rejects(service.importUrl('https://secret@www.instagram.com/reel/a'),{status:422})
  await assert.rejects(service.importUrl('https://localhost/video.mp4'),{status:422})
  await assert.rejects(service.analyze('abc',{mode:'invented'}),{status:422})
  assert.equal((await service.list()).length,0)
})

test('profile imports retain the actual reel, requested channel and measured duration through reload and export',async t=>{
  const profile='https://www.instagram.com/creator/'
  const reel='https://www.instagram.com/reel/actualReference/'
  const {root,service}=await fixture(t,{importer:{importVideo:async({directory})=>{
    const filePath=join(directory,'reference.mp4');await writeFile(filePath,'real-import-placeholder')
    return {filePath,title:'Public reference',sourceUrl:reel,profileUrl:profile,discoveryMethod:'public_profile_embed',durationSeconds:15}
  }},engine:{analyze:async()=>sample()}})
  const queued=await service.importUrl(profile)
  assert.equal((await service.importUrl(profile)).id,queued.id)
  await service.whenIdle()
  const item=await service.get(queued.id)
  assert.equal(item.status,'ready');assert.equal(item.durationSeconds,15)
  assert.equal(item.source.url,reel);assert.equal(item.source.profileUrl,profile)
  assert.equal(item.source.requestedUrl,profile);assert.equal(item.source.discoveryMethod,'public_profile_embed')
  const disk=JSON.parse(await readFile(join(root,'reference-library.json'),'utf8'))
  assert.equal(disk.items[0].source.url,reel)
  assert.equal((await service.importUrl(reel)).id,item.id)
  await service.analyze(item.id);await service.whenIdle()
  const text=(await service.exportItem(item.id,{format:'txt'})).body
  assert.ok(text.includes(`Source: ${reel}`));assert.ok(text.includes(`Source profile: ${profile}`))
  assert.match(text,/not a complete channel archive/)
})

test('an overlong imported result is rejected before promotion into the media library',async t=>{
  const {service}=await fixture(t,{importer:{importVideo:async({directory})=>{
    const filePath=join(directory,'overlong.mp4');await writeFile(filePath,'imported')
    return {filePath,title:'Too long',durationSeconds:301}
  }}})
  const item=await service.importUrl('https://www.instagram.com/reel/longVideo/')
  await service.whenIdle()
  const result=await service.get(item.id)
  assert.equal(result.status,'failed');assert.equal(result.hasMedia,false);assert.match(result.error,/five minutes/)
})

test('aborted or mismatched uploads leave no library entry',async t=>{
  const {service}=await fixture(t)
  await assert.rejects(service.upload(Readable.from(['short']),{filename:'short.mp4',contentLength:10}),{code:'incomplete_upload'})
  assert.equal((await service.list()).length,0)
})

test('restart recovers interrupted jobs to an explicit retryable failure',async t=>{
  const {root,service}=await fixture(t)
  const item=await upload(service)
  const path=join(root,'reference-library.json'),document=JSON.parse(await readFile(path,'utf8'))
  document.items[0].status='analyzing';document.items[0].pendingAction='analyze';await writeFile(path,JSON.stringify(document))
  const fresh=await import(`./service.mjs?restart=${Date.now()}`)
  const restarted=fresh.createVideoAnalysisService({root})
  const recovered=await restarted.get(item.id)
  assert.equal(recovered.status,'failed');assert.equal(recovered.retryable,true);assert.match(recovered.error,/interrupted/)
  assert.equal(JSON.parse(await readFile(path,'utf8')).items[0].pendingAction,undefined)
})

test('importer cannot place another workspace file in this library',async t=>{
  const {root,service}=await fixture(t,{importer:{importVideo:async()=>({filePath:join(root,'outside.mp4')})}})
  await writeFile(join(root,'outside.mp4'),'private-file')
  const item=await service.importUrl('https://example.com/video.mp4');await service.whenIdle()
  const result=await service.get(item.id)
  assert.equal(result.status,'failed');assert.equal(result.hasMedia,false)
  assert.equal(await readFile(join(root,'outside.mp4'),'utf8'),'private-file')
})

test('script and breakdown modes preserve each other with component provenance and exported prompts',async t=>{
  let calls=0
  const {service}=await fixture(t,{engine:{analyze:async({mode})=>{
    calls++
    const result=sample()
    // This test exercises legacy custom prompts; synchronized audio prompts are
    // covered separately by the audio refresh regression below.
    delete result.audio
    result.mode=mode
    result.provenance={speech:{status:'analyzed',model:`speech-${calls}`},vision:{status:'analyzed',model:`vision-${calls}`},boundaries:{method:'scene_detection'}}
    result.inversePrompt='Reference-guided wide mountain shot'
    result.shots[0].reconstructionPrompt='Recreate the mountain sunrise with a slow pan'
    if(mode==='script') {result.script.text='The new spoken words.';result.script.segments[0].text=result.script.text;result.script.onScreenText=[{startSeconds:2,endSeconds:2,text:'Freshly read caption'}];result.shots[0].visual=null;result.inversePrompt=null;result.shots[0].reconstructionPrompt=null}
    if(mode==='breakdown') {result.script.text='';result.script.segments=[];result.shots[0].visual='A refreshed mountain description'}
    return result
  }}})
  const item=await upload(service)
  await service.analyze(item.id);await service.whenIdle()
  await service.analyze(item.id,{mode:'script'});await service.whenIdle()
  let value=(await service.get(item.id)).result
  assert.equal(value.shots[0].visual,'Mountain sunrise')
  assert.equal(value.inversePrompt,'Reference-guided wide mountain shot')
  assert.equal(value.shots[0].spokenText,'The new spoken words.')
  assert.equal(value.script.onScreenText[0].text,'Freshly read caption')
  assert.equal(value.shots[0].onScreenText[0],'Freshly read caption')
  assert.equal(value.provenance.components.vision.detail.model,'vision-1')
  assert.equal(value.provenance.components.speech.detail.model,'speech-2')
  assert.equal(value.provenance.components.ocr.detail.model,'vision-2')
  await service.analyze(item.id,{mode:'breakdown'});await service.whenIdle()
  value=(await service.get(item.id)).result
  assert.equal(value.shots[0].visual,'A refreshed mountain description')
  assert.equal(value.script.text,'The new spoken words.')
  assert.equal(value.provenance.speech.model,'speech-2')
  assert.equal(value.provenance.components.vision.detail.model,'vision-3')
  const text=await service.exportItem(item.id)
  assert.match(text.body,/Reference-guided wide mountain shot/)
  assert.match(text.body,/Reconstruction prompt: Recreate the mountain sunrise/)
})

test('word timestamps survive merging without duplicating phrases across a cut',async t=>{
  const {service}=await fixture(t,{engine:{analyze:async({mode})=>{
    const value=sample()
    value.durationSeconds=10
    value.shots=[{...value.shots[0],index:0,startSeconds:0,endSeconds:5,visual:'Original first shot',spokenText:'before'}, {...value.shots[0],index:1,startSeconds:5,endSeconds:10,visual:'Original second shot',spokenText:'across after'}]
    value.script={segments:[{startSeconds:0,endSeconds:10,text:'before across after'}],words:[{startSeconds:1,endSeconds:2,text:'before'},{startSeconds:4.8,endSeconds:5.4,text:'across'},{startSeconds:7,endSeconds:8,text:'after'}],text:'before across after',onScreenText:[]}
    value.provenance={speech:{status:'analyzed',model:`speech-${mode}`},vision:{status:'analyzed',model:`vision-${mode}`}}
    if(mode==='script') {
      value.script.segments=[{startSeconds:0,endSeconds:10,text:'alpha beta'}]
      value.script.words=[{startSeconds:4.6,endSeconds:5,text:'alpha'},{startSeconds:4.9,endSeconds:5.3,text:'beta'}]
      value.script.text='alpha beta'
      value.script.onScreenText=[{startSeconds:4.9,endSeconds:4.9,observedAtSeconds:[4.9,5.1],text:'Fresh OCR across the cut'}]
      value.shots[0].visual='Unrequested refreshed description'
    }
    if(mode==='breakdown') {
      value.script={segments:[],words:[],text:'',onScreenText:[]}
      value.shots[0].endSeconds=4.7;value.shots[1].startSeconds=4.7
      value.provenance.speech={status:'not_requested'}
    }
    return value
  }}})
  const item=await upload(service)
  await service.analyze(item.id);await service.whenIdle()
  let value=(await service.get(item.id)).result
  assert.deepEqual(value.shots.map(shot=>shot.spokenText),['before','across after'])
  await service.analyze(item.id,{mode:'script'});await service.whenIdle()
  value=(await service.get(item.id)).result
  assert.deepEqual(value.shots.map(shot=>shot.spokenText),['alpha','beta'])
  assert.equal(value.shots[0].visual,'Original first shot')
  assert.deepEqual(value.shots.map(shot=>shot.onScreenText),[['Fresh OCR across the cut'],['Fresh OCR across the cut']])
  assert.equal(value.provenance.components.vision.detail.model,'vision-both')
  assert.equal(value.provenance.components.ocr.detail.model,'vision-script')
  await service.analyze(item.id,{mode:'breakdown'});await service.whenIdle()
  value=(await service.get(item.id)).result
  assert.deepEqual(value.script.words.map(word=>word.text),['alpha','beta'])
  assert.deepEqual(value.shots.map(shot=>shot.spokenText),['','alpha beta'])
  assert.equal(value.provenance.speech.model,'speech-script')
})

test('audio refresh aligns fresh speech and sound labels to saved visual cuts and preserves partial visual evidence',async t=>{
  const calls=[]
  const originalScreens=[{startSeconds:0.4,endSeconds:0.4,text:'Original caption',observedAtSeconds:[0.4]}]
  const {service}=await fixture(t,{engine:{analyze:async({mode})=>{
    calls.push(mode)
    if(mode==='both')return {
      ...sample(),status:'partial',durationSeconds:6,metadata:{durationSeconds:6,hasAudio:true,hasVideo:true},
      shots:[
        {index:0,startSeconds:0,endSeconds:2,visual:'Saved mountain wide shot',framing:'Wide',onScreenText:['Original caption'],sampledFrames:[{timeSeconds:0.4,onScreenText:['Original caption'],ocrStatus:'analyzed'}]},
        {index:1,startSeconds:2,endSeconds:6,visual:'Saved mountain close shot',framing:'Close-up',onScreenText:[],sampledFrames:[]},
      ],
      script:{segments:[{startSeconds:0.2,endSeconds:1,text:'Old narration.'}],words:[{startSeconds:0.2,endSeconds:1,text:'Old narration.'}],text:'Old narration.',onScreenText:originalScreens},
      warnings:['Only selected visual frames were analyzed.'],
      provenance:{boundaries:{method:'saved-cuts'},vision:{status:'partial',model:'saved-vision'},ocr:{status:'analyzed',model:'saved-ocr'},speech:{status:'analyzed',model:'old-speech'}},
    }
    assert.equal(mode,'audio','refresh must not request vision or OCR again')
    return {
      ...sample(),mode:'audio',status:'complete',durationSeconds:6,metadata:{durationSeconds:6,hasAudio:true,hasVideo:true},
      // A fresh detector disagrees with the saved cut. Audio refresh must retain
      // the user's existing shot grid while realigning the new timed evidence.
      shots:[{index:0,startSeconds:0,endSeconds:3,visual:null,onScreenText:[]},{index:1,startSeconds:3,endSeconds:6,visual:null,onScreenText:[]}],
      script:{segments:[{startSeconds:1.7,endSeconds:3.4,text:'New narration.'}],words:[{startSeconds:1.7,endSeconds:1.9,text:'New'},{startSeconds:1.9,endSeconds:2.3,text:'narration.'}],text:'New narration.',onScreenText:[]},
      audio:{timelineVersion:1,status:'analyzed',windows:Array.from({length:60},(_,index)=>({startSeconds:index/10,endSeconds:(index+1)/10,rmsDb:index<20?-40:-20})),onsetCandidates:[{timeSeconds:2.1,strength:0.8}],semanticStatus:'analyzed',semanticModel:'verified-test-audio-model',semanticEvents:[{startSeconds:1.5,endSeconds:2.6,label:'Music',confidence:0.88},{startSeconds:2.1,endSeconds:2.5,label:'Click',confidence:0.76}]},
      warnings:['Sound labels are model estimates.'],
      provenance:{boundaries:{method:'fresh-cuts'},vision:{status:'not_requested'},ocr:{status:'not_requested'},speech:{status:'analyzed',model:'fresh-speech'},audio:{status:'analyzed',method:'measured-rms'},soundEvents:{status:'analyzed',model:'verified-test-audio-model'}},
    }
  }}})
  const item=await upload(service)
  await service.analyze(item.id);await service.whenIdle()
  const before=(await service.get(item.id)).result
  await service.analyze(item.id,{mode:'audio'});await service.whenIdle()
  const saved=await service.get(item.id),value=saved.result
  assert.deepEqual(calls,['both','audio'])
  assert.equal(saved.status,'partial','refreshing sound cannot certify unsampled visual frames')
  assert.deepEqual(value.shots.map(shot=>[shot.startSeconds,shot.endSeconds,shot.visual]),[[0,2,'Saved mountain wide shot'],[2,6,'Saved mountain close shot']])
  assert.deepEqual(value.script.onScreenText,originalScreens)
  assert.deepEqual(value.shots[0].sampledFrames,before.shots[0].sampledFrames)
  assert.deepEqual(value.shots.map(shot=>shot.onScreenText),[['Original caption'],[]])
  assert.deepEqual(value.shots.map(shot=>shot.spokenText),['New','narration.'])
  assert.deepEqual(value.audio.segments.map(segment=>[segment.startSeconds,segment.endSeconds,segment.spokenText]),[[0,2,'New'],[2,6,'narration.']])
  assert.deepEqual(value.audio.segments.map(segment=>segment.events.map(event=>event.label)),[['Music'],['Music','Click']])
  assert.deepEqual(value.audio.segments.map(segment=>segment.onsetTimes),[[],[2.1]])
  assert.equal(value.audio.segments[0].meanDb,-40)
  assert.equal(value.audio.segments[1].meanDb,-20)
  assert.equal(value.audio.semanticModel,'verified-test-audio-model')
  assert.equal(value.provenance.components.vision.detail.model,'saved-vision')
  assert.equal(value.provenance.components.ocr.detail.model,'saved-ocr')
  assert.equal(value.provenance.components.boundaries.detail.method,'saved-cuts')
  assert.equal(value.provenance.components.speech.detail.model,'fresh-speech')
  assert.equal(value.provenance.components.soundEvents.detail.model,'verified-test-audio-model')
  assert.ok(value.warnings.some(warning=>warning.includes('Only selected visual frames were analyzed.')))
  for(const format of ['txt','md']) {
    const text=(await service.exportItem(item.id,{format})).body
    assert.match(text,/Synchronized audio timeline/)
    assert.match(text,/Detected sound: Music/)
    assert.match(text,/Detected sound: Click/)
    assert.match(text,/model score 0\.88/)
    assert.match(text,/Original caption/)
    assert.match(text,/Saved mountain wide shot/)
  }
  const exported=JSON.parse((await service.exportItem(item.id,{format:'json'})).body)
  assert.equal(exported.result.audio.timelineVersion,1)
  assert.equal(exported.result.shots[1].audioAnalysis.events[1].label,'Click')
  assert.equal(exported.mediaFile,undefined)
})

test('SiliconFlow Analyze all upgrades local results, retains semantic sound, skips current results and retries a changed model',async t=>{
  const config={SPUR_VIDEO_ANALYSIS_PROVIDER:'siliconflow',SPUR_VIDEO_ANALYSIS_CLOUD_MODEL:'Qwen/Qwen3-Omni-30B-A3B-Instruct',SILICONFLOW_API_KEY:'test-private-key'}
  const modes=[],channelId='instagram-dreamcode_films'
  let cloudPhase=false
  const {service}=await fixture(t,{config,engine:{analyze:async({mode})=>{
    modes.push(mode)
    if(!cloudPhase)return sample()
    return {...sample(),mode,status:'complete',metadata:{durationSeconds:12,hasAudio:true,hasVideo:true},
      audio:{...sample().audio,semanticDescription:'Gentle music with a brief metal click.',semanticSegments:[{startSeconds:0,endSeconds:12,description:'Soft music plays under the narration.'},{startSeconds:2,endSeconds:3,description:'A metallic click is audible.'}]},
      provenance:{multimodal:{provider:'siliconflow',model:config.SPUR_VIDEO_ANALYSIS_CLOUD_MODEL,mediaTransport:'original_video',status:'analyzed'},vision:{status:'analyzed',provider:'siliconflow'},ocr:{status:'analyzed',provider:'siliconflow'},speech:{status:'analyzed',provider:'siliconflow'}},
    }
  }}})
  const item=await service.upload(Readable.from(['video']),{filename:'cloud-upgrade.mp4',channelId})
  await service.analyze(item.id);await service.whenIdle()
  cloudPhase=true;modes.length=0
  await service.analyzeAllChannelVideos(channelId);await service.whenIdle()
  const saved=await service.get(item.id)
  assert.deepEqual(modes,['both'],'a local result requires full video and audio analysis with the cloud model')
  assert.equal(saved.result.audio.description,'Gentle music with a brief metal click.')
  assert.match(saved.result.shots[0].audio,/metallic click/)
  assert.equal(saved.result.shots[0].spokenText,'A new morning.')
  assert.equal(saved.result.provenance.components.multimodal.detail.provider,'siliconflow')
  const exported=(await service.exportItem(item.id,{format:'md'})).body
  assert.match(exported,/Analysis provider: siliconflow/)
  assert.match(exported,/Gentle music/)
  await service.analyzeAllChannelVideos(channelId);await service.whenIdle()
  assert.equal((await service.getChannel(channelId)).bulkAnalysis.skipped,1)
  assert.equal(modes.length,1)
  config.SPUR_VIDEO_ANALYSIS_CLOUD_MODEL='Qwen/Qwen3-Omni-30B-A3B-Thinking'
  await service.analyzeAllChannelVideos(channelId);await service.whenIdle()
  assert.deepEqual(modes,['both','both'])
  assert.equal((await service.get(item.id)).result.provenance.multimodal.model,config.SPUR_VIDEO_ANALYSIS_CLOUD_MODEL)
  config.SPUR_VIDEO_ANALYSIS_VISION_MODEL='deepseek-ai/DeepSeek-V4.1-Flash'
  await service.analyzeAllChannelVideos(channelId);await service.whenIdle()
  assert.deepEqual(modes,['both','both'],'legacy frame-model configuration cannot change the direct video route')
  assert.equal((await service.get(item.id)).result.provenance.multimodal.mediaTransport,'original_video')
  await service.analyzeAllChannelVideos(channelId);await service.whenIdle()
  assert.equal((await service.getChannel(channelId)).bulkAnalysis.skipped,1)
})

test('Analyze all refreshes old cloud frame results once with the complete-video route',async t=>{
  const config={SPUR_VIDEO_ANALYSIS_PROVIDER:'siliconflow',SILICONFLOW_API_KEY:'test-key'}
  const channelId='instagram-dreamcode_films'
  let calls=0
  const {service}=await fixture(t,{config,engine:{analyze:async()=>{
    const oldFrames=calls++===0
    return {...sample(),mode:'both',status:'complete',provenance:{multimodal:{provider:'siliconflow',model:'Qwen/Qwen3-Omni-30B-A3B-Instruct',status:'analyzed',inputMode:oldFrames?'frames_and_audio':'video_and_audio',...(oldFrames?{visionModel:'previous-frame-model'}:{mediaTransport:'original_video'})},vision:{status:'analyzed'},ocr:{status:'analyzed'},speech:{status:'analyzed'}}}
  }}})
  const item=await service.upload(Readable.from(['video']),{filename:'native-upgrade.mp4',channelId})
  await service.analyze(item.id);await service.whenIdle()
  await service.analyzeAllChannelVideos(channelId);await service.whenIdle()
  assert.equal(calls,2)
  assert.equal((await service.get(item.id)).result.provenance.multimodal.mediaTransport,'original_video')
  await service.analyzeAllChannelVideos(channelId);await service.whenIdle()
  assert.equal(calls,2)
  assert.equal((await service.getChannel(channelId)).bulkAnalysis.skipped,1)
})

test('a successful cloud shot retry retains speech and clears the obsolete visual failure notes',async t=>{
  let calls=0
  const {service}=await fixture(t,{engine:{analyze:async({mode})=>{
    const result={...sample(),mode,status:'complete',provenance:{multimodal:{provider:'siliconflow',model:'test-omni',visionModel:'test-vision'},vision:{status:'analyzed'},ocr:{status:'analyzed'},speech:{status:'analyzed'}}}
    if(calls++===0)return {...result,status:'partial',shots:[],warnings:['Interval 1 needs review: visual verification failed.'],provenance:{...result.provenance,vision:{status:'failed'},ocr:{status:'failed'}}}
    assert.equal(mode,'breakdown')
    result.script={segments:[],text:'',onScreenText:sample().script.onScreenText}
    result.provenance.speech.status='not_requested'
    return result
  }}})
  const item=await upload(service)
  await service.analyze(item.id);await service.whenIdle()
  assert.equal((await service.get(item.id)).result.shots.length,0)
  await service.analyze(item.id,{mode:'breakdown'});await service.whenIdle()
  const saved=await service.get(item.id)
  assert.equal(saved.status,'complete')
  assert.equal(saved.result.shots.length,1)
  assert.equal(saved.result.script.text,'A new morning.')
  assert.ok(!saved.result.warnings.some(warning=>/visual verification failed/.test(warning)))
  assert.ok(saved.result.warnings.some(warning=>/Spoken words were retained/.test(warning)))
})

test('a direct video retry with a timing gap retains current review notes and removes resolved frame failures',async t=>{
  let calls=0
  const {service}=await fixture(t,{engine:{analyze:async({mode})=>{
    const result={...sample(),mode,status:'partial',provenance:{multimodal:{provider:'siliconflow',model:'test-omni',mediaTransport:'original_video'},vision:{status:'partial'},ocr:{status:'partial'},speech:{status:'analyzed'}}}
    if(calls++===0)return {...result,shots:[],warnings:['Interval 1 needs review: visual verification failed.'],provenance:{...result.provenance,vision:{status:'failed'},ocr:{status:'failed'}}}
    result.warnings=['Video analysis needs review: the visual timeline has uncovered gaps.']
    result.script={segments:[],text:'',onScreenText:[]}
    result.provenance.speech.status='not_requested'
    return result
  }}})
  const item=await upload(service)
  await service.analyze(item.id);await service.whenIdle()
  await service.analyze(item.id,{mode:'breakdown'});await service.whenIdle()
  const saved=await service.get(item.id)
  assert.equal(saved.status,'partial')
  assert.equal(saved.result.shots.length,1)
  assert.equal(saved.result.script.text,'A new morning.')
  assert.ok(saved.result.warnings.some(warning=>/uncovered gaps/.test(warning)))
  assert.ok(!saved.result.warnings.some(warning=>/visual verification failed/.test(warning)))
})

test('Analyze all upgrades legacy results with audio only then skips the synchronized results on the next run',async t=>{
  const modes=[],channelId='instagram-dreamcode_films'
  let phase='seed'
  const {service}=await fixture(t,{engine:{analyze:async({filePath,mode})=>{
    const source=await readFile(filePath,'utf8')
    modes.push({source,mode})
    const result=sample()
    if(phase==='seed'&&source==='legacy')delete result.audio
    if(mode==='audio') {
      result.shots[0].visual='This unrequested visual must not replace the saved result.'
      result.script={segments:[{startSeconds:2,endSeconds:3,text:'Fresh soundtrack words.'}],words:[{startSeconds:2,endSeconds:3,text:'Fresh soundtrack words.'}],text:'Fresh soundtrack words.',onScreenText:[]}
      result.provenance={speech:{status:'analyzed'},vision:{status:'not_requested'},ocr:{status:'not_requested'}}
    }
    return result
  }}})
  const legacy=await service.upload(Readable.from(['legacy']),{filename:'legacy.mp4',channelId})
  const current=await service.upload(Readable.from(['current']),{filename:'current.mp4',channelId})
  const untouched=await service.upload(Readable.from(['untouched']),{filename:'untouched.mp4',channelId})
  for(const item of [legacy,current]){await service.analyze(item.id);await service.whenIdle()}
  assert.equal((await service.get(legacy.id)).result.audio,undefined)
  modes.length=0;phase='batch'
  await service.analyzeAllChannelVideos(channelId);await service.whenIdle()
  const job=(await service.getChannel(channelId)).bulkAnalysis
  assert.equal(job.status,'complete');assert.equal(job.total,3);assert.equal(job.analyzed,2);assert.equal(job.skipped,1);assert.equal(job.failed,0)
  assert.deepEqual(modes.filter(call=>call.source==='legacy'),[{source:'legacy',mode:'audio'}])
  assert.deepEqual(modes.filter(call=>call.source==='untouched'),[{source:'untouched',mode:'both'}])
  assert.ok(!modes.some(call=>call.source==='current'))
  const upgraded=await service.get(legacy.id)
  assert.equal(upgraded.result.audio.timelineVersion,1)
  assert.equal(upgraded.result.shots[0].visual,'Mountain sunrise')
  assert.equal(upgraded.result.shots[0].spokenText,'Fresh soundtrack words.')
  assert.equal((await service.get(untouched.id)).hasResult,true)
  await service.analyzeAllChannelVideos(channelId);await service.whenIdle()
  const second=(await service.getChannel(channelId)).bulkAnalysis
  assert.equal(second.skipped,3);assert.equal(second.analyzed,0);assert.equal(second.failed,0)
  assert.equal(modes.length,2,'already synchronized results should not trigger further inference')
})

test('Analyze all retries incomplete audio components and repairs audio-only partials while retaining completed frames',async t=>{
  const cases=[
    {label:'semantic-failed',semantic:'failed',speech:'analyzed'},
    {label:'semantic-unavailable',semantic:'unavailable',speech:'analyzed'},
    {label:'semantic-not-requested',semantic:'not_requested',speech:'analyzed'},
    {label:'speech-failed',semantic:'analyzed',speech:'failed'},
    {label:'speech-unavailable',semantic:'analyzed',speech:'unavailable'},
    {label:'speech-not-requested',semantic:'analyzed',speech:'not_requested'},
  ]
  const calls=[],channelId='instagram-dreamcode_films',saved=[]
  let phase='seed'
  const {service}=await fixture(t,{engine:{analyze:async({filePath,mode})=>{
    const label=await readFile(filePath,'utf8'),scenario=cases.find(value=>value.label===label)
    calls.push({label,mode})
    const result=sample()
    result.metadata={durationSeconds:12,hasAudio:true,hasVideo:true}
    result.shots[0].sampledFrames=[{timeSeconds:2.4,onScreenText:['Get outside'],ocrStatus:'analyzed'},{timeSeconds:9.6,onScreenText:[],ocrStatus:'analyzed'}]
    result.audio={...result.audio,status:'analyzed',windows:Array.from({length:120},(_,index)=>({startSeconds:index/10,endSeconds:(index+1)/10,rmsDb:-24}))}
    if(phase==='seed') {
      result.status='partial'
      result.audio.semanticStatus=scenario.semantic
      result.provenance={vision:{status:'analyzed',sampledFrameCount:2,model:`saved-vision-${label}`},ocr:{status:'analyzed',sampledFrameCount:2,model:`saved-ocr-${label}`},speech:{status:scenario.speech},soundEvents:{status:scenario.semantic}}
      return result
    }
    assert.equal(mode,'audio','incomplete current audio must be retried without a new vision pass')
    result.status='complete'
    result.audio.semanticStatus='analyzed'
    result.audio.semanticEvents=[{startSeconds:0,endSeconds:12,label:'Music',confidence:0.86}]
    result.script={segments:[{startSeconds:2,endSeconds:3,text:'Repaired soundtrack.'}],words:[{startSeconds:2,endSeconds:3,text:'Repaired soundtrack.'}],text:'Repaired soundtrack.',onScreenText:[]}
    result.shots[0].visual=null
    result.shots[0].onScreenText=[]
    result.shots[0].sampledFrames=[]
    result.provenance={vision:{status:'not_requested'},ocr:{status:'not_requested'},speech:{status:'analyzed'},soundEvents:{status:'analyzed'}}
    return result
  }}})
  for(const scenario of cases) {
    const item=await service.upload(Readable.from([scenario.label]),{filename:`${scenario.label}.mp4`,channelId})
    saved.push(item)
    await service.analyze(item.id);await service.whenIdle()
    const seeded=await service.get(item.id)
    assert.equal(seeded.status,'partial')
    assert.equal(seeded.result.audio.timelineVersion,1)
    assert.equal(seeded.result.audio.semanticStatus,scenario.semantic)
    assert.equal(seeded.result.audio.speechStatus,scenario.speech)
  }
  phase='repair';calls.length=0
  await service.analyzeAllChannelVideos(channelId);await service.whenIdle()
  const job=(await service.getChannel(channelId)).bulkAnalysis
  assert.equal(job.analyzed,cases.length);assert.equal(job.skipped,0);assert.equal(job.failed,0);assert.equal(job.partial,0)
  assert.equal(calls.length,cases.length)
  assert.ok(calls.every(call=>call.mode==='audio'))
  for(let index=0;index<saved.length;index++) {
    const item=await service.get(saved[index].id),label=cases[index].label
    assert.equal(item.status,'complete','a sound-only failure can be repaired when the original frames were fully processed')
    assert.equal(item.result.shots[0].visual,'Mountain sunrise')
    assert.equal(item.result.shots[0].sampledFrames.length,2)
    assert.deepEqual(item.result.shots[0].onScreenText,['Get outside'])
    assert.equal(item.result.provenance.vision.model,`saved-vision-${label}`)
    assert.equal(item.result.provenance.ocr.model,`saved-ocr-${label}`)
    assert.equal(item.result.audio.semanticStatus,'analyzed')
    assert.equal(item.result.audio.speechStatus,'analyzed')
    assert.equal(item.result.shots[0].spokenText,'Repaired soundtrack.')
  }
  await service.analyzeAllChannelVideos(channelId);await service.whenIdle()
  const repeated=(await service.getChannel(channelId)).bulkAnalysis
  assert.equal(repeated.skipped,cases.length);assert.equal(repeated.analyzed,0)
  assert.equal(calls.length,cases.length,'successful repairs are reused on the next batch')
})
