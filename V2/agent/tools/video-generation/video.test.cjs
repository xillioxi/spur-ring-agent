const {test}=require('node:test');const assert=require('node:assert/strict');const {mkdtempSync,rmSync,readFileSync,existsSync}=require('node:fs');const {tmpdir}=require('node:os');const {join}=require('node:path');const {randomUUID}=require('node:crypto');
const {submitVideo,videoStatus}=require('./client.cjs');const {writeJob,readJob,advanceJob,publicJob}=require('./jobs.cjs');
const config={apiKey:'private-key',baseUrl:'https://api.siliconflow.cn/v1',model:'MiniMaxAI/MiniMax-H3'};
test('submission uses the H3 endpoint and current official controls',async()=>{
 let sent;const id=await submitVideo(config,{prompt:'A person plays football on a ship',duration:12,resolution:'768p',ratio:'9:16',seed:42,images:[{role:'first_frame',url:'https://media.example/start.jpg'}]},async(url,options)=>{sent={url:String(url),...options};return{ok:true,json:async()=>({requestId:'provider-123'})}});
 assert.equal(id,'provider-123');assert.equal(sent.url,'https://api.siliconflow.cn/v1/video/submit');assert.deepEqual(JSON.parse(sent.body),{model:config.model,prompt:'A person plays football on a ship',duration:12,resolution:'768p',ratio:'9:16',seed:42,images:[{role:'first_frame',url:'https://media.example/start.jpg'}]});
 await assert.rejects(submitVideo(config,{prompt:'x',ratio:'unsupported'}));
 await assert.rejects(submitVideo(config,{prompt:'x',images:[{role:'first_frame',url:'http://localhost/start.jpg'}]}));
 await assert.rejects(submitVideo(config,{prompt:'x'},async()=>({ok:false,status:401})),e=>e.definitive&&!e.message.includes(config.apiKey));
});
test('status maps provider states without declaring queued jobs complete',async()=>{
 for(const [remote,local]of[['InQueue','queued'],['InProgress','generating'],['Succeed','ready'],['Failed','failed']]){
  const result=await videoStatus(config,'provider-123',async()=>({ok:true,json:async()=>({status:remote,results:{videos:[{url:'https://cdn.example/video.mp4'}]}})}));assert.equal(result.status,local)
 }
});
test('persisted queued job resumes querying and downloads once, never resubmits',async()=>{
 const root=mkdtempSync(join(tmpdir(),'spur-video-'));const id=randomUUID();const now=Date.now();let query=0,download=0;
 try{
  writeJob(root,{id,status:'queued',requestId:'original-request',createdAt:new Date(now).toISOString()});
  const getStatus=async(_config,requestId)=>{assert.equal(requestId,'original-request');return[++query===1?{status:'generating'}:{status:'ready',url:'https://cdn.example/video.mp4'}][0]};
  await advanceJob(root,id,config,{getStatus,now});
  assert.equal(readJob(root,id).status,'generating');
  await advanceJob(root,id,config,{getStatus,now:now+11000,download:async()=>{download++;return Buffer.from('test-video')}});
  assert.equal(readJob(root,id).status,'completed');assert.equal(download,1);assert.equal(readFileSync(join(root,id+'.mp4'),'utf8'),'test-video');
  assert.ok(publicJob(readJob(root,id)).url.endsWith('/file'));assert.equal('requestId'in publicJob(readJob(root,id)),false)
 }finally{rmSync(root,{recursive:true,force:true})}
});
test('download failure keeps original provider id for later recovery',async()=>{
 const root=mkdtempSync(join(tmpdir(),'spur-video-'));const id=randomUUID();const now=Date.now();
 try{
  writeJob(root,{id,status:'queued',requestId:'same-id',createdAt:new Date(now).toISOString()});
  const getStatus=async(_config,requestId)=>{assert.equal(requestId,'same-id');return{status:'ready',url:'https://cdn.example/video.mp4'}};
  await advanceJob(root,id,config,{now,getStatus,download:async()=>{throw new Error('network')}});
  assert.equal(readJob(root,id).status,'downloading');assert.equal(existsSync(join(root,id+'.mp4')),false);
  await advanceJob(root,id,config,{now:now+20000,getStatus,download:async()=>Buffer.from('video')});assert.equal(readJob(root,id).status,'completed')
 }finally{rmSync(root,{recursive:true,force:true})}
});
test('tool calls in the same task cannot submit the paid job twice',async()=>{
 const root=mkdtempSync(join(tmpdir(),'spur-video-'));const client=require('./client.cjs');const original=client.submitVideo;let calls=0;
 const previous={root:process.env.SPUR_VIDEO_JOBS_ROOT,out:process.env.SPUR_RESEARCH_OUTPUT};process.env.SPUR_VIDEO_JOBS_ROOT=root;process.env.SPUR_RESEARCH_OUTPUT=root;
 try{
  client.submitVideo=async()=>{calls++;return'one-request'};delete require.cache[require.resolve('./index.cjs')];const tools=new Map();require('./index.cjs').apply({tools:{register:value=>{tools.set(value.name,value)}}});const tool=tools.get('video_generate');
  const first=await tool.execute({prompt:'Football on a ship'});const second=await tool.execute({prompt:'Football on a ship'});assert.equal(calls,1);assert.equal(first.id,second.id);assert.equal((await tools.get('video_status').execute({})).id,first.id);assert.equal(calls,1)
 }finally{client.submitVideo=original;delete require.cache[require.resolve('./index.cjs')];for(const [key,value]of[['SPUR_VIDEO_JOBS_ROOT',previous.root],['SPUR_RESEARCH_OUTPUT',previous.out]]){if(value===undefined)delete process.env[key];else process.env[key]=value}rmSync(root,{recursive:true,force:true})}
});
