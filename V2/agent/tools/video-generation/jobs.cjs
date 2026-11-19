const {readFileSync,writeFileSync,renameSync,mkdirSync,readdirSync}=require('node:fs');
const {join}=require('node:path');
const {randomUUID}=require('node:crypto');
const {videoStatus,downloadVideo}=require('./client.cjs');
const validId=id=>typeof id==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id);
const active=new Set(['queued','generating','downloading']);
function readJob(root,id){if(!validId(id))throw new Error('视频任务编号无效。');return JSON.parse(readFileSync(join(root,id+'.json'),'utf8'))}
function writeJob(root,job){
 if(!validId(job.id))throw new Error('视频任务编号无效。');
 mkdirSync(root,{recursive:true});const temp=join(root,job.id+'.'+randomUUID()+'.tmp');
 writeFileSync(temp,JSON.stringify({...job,updatedAt:new Date().toISOString()},null,2),{mode:0o600});renameSync(temp,join(root,job.id+'.json'));
}
function listJobs(root){mkdirSync(root,{recursive:true});return readdirSync(root).filter(f=>validId(f.replace(/\.json$/,''))&&f.endsWith('.json')).flatMap(f=>{try{return[readJob(root,f.slice(0,-5))]}catch{return[]}})}
function publicJob(job){return{id:job.id,status:job.status,createdAt:job.createdAt,completedAt:job.completedAt||null,error:job.error||null,url:job.status==='completed'?`/api/creator-agent/videos/${job.id}/file`:null,prompt:job.prompt||'',model:job.model||'',duration:job.duration||null,resolution:job.resolution||'',ratio:job.ratio||'',seed:job.seed??null,actualSeed:job.actualSeed??null,inference:job.inference??null,images:Array.isArray(job.images)?job.images.map(value=>({role:value.role,url:value.url})):[]}}
async function advanceJob(root,id,config,{getStatus=videoStatus,download=downloadVideo,now=Date.now()}={}){
 const job=readJob(root,id);
 if(!active.has(job.status)||Number(job.nextPollAt||0)>now)return job;
 if(now-Date.parse(job.resumedAt||job.createdAt)>86400000){job.status='paused';job.error='任务查询已超过 24 小时，已暂停；任务编号仍保留。';writeJob(root,job);return job}
 try{
  const result=await getStatus(config,job.requestId);
  job.status=result.status;job.error=null;
  if(result.status==='ready'){
   if(!result.url)throw new Error('服务显示完成，但未返回视频地址。');
   job.status='downloading';writeJob(root,job);
   const bytes=await download(result.url);
   const temp=join(root,id+'.'+randomUUID()+'.mp4.tmp');writeFileSync(temp,bytes);renameSync(temp,join(root,id+'.mp4'));
   job.status='completed';job.bytes=bytes.length;job.completedAt=new Date().toISOString();job.actualSeed=result.seed??null;job.inference=result.inference??null;
  }else if(result.status==='failed')job.error='视频服务报告生成失败，没有成品视频。';
  job.failures=0;job.nextPollAt=now+10000;
 }catch(error){
  job.failures=(job.failures||0)+1;job.status=job.failures>=20?'paused':(job.status==='downloading'?'downloading':'queued');
  job.error=job.status==='paused'?'视频查询多次失败，已暂停；不会重复提交生成。':'查询或下载暂时失败，后台会继续重试。';
  job.nextPollAt=now+Math.min(60000,5000*2**Math.min(job.failures,4));
 }
 writeJob(root,job);return job;
}
function startWorker(root,config){
 const busy=new Set();let stopped=false;
 async function tick(){if(stopped)return;for(const job of listJobs(root)){
  if(job.status==='submitting' && Date.now()-Date.parse(job.createdAt)>120000){job.status='submission_unknown';job.error='提交被中断，结果尚未确认；不会自动重复生成。';writeJob(root,job);continue}
  if(busy.size>=3)break;
  if(!active.has(job.status)||busy.has(job.id)||Number(job.nextPollAt||0)>Date.now())continue;
  busy.add(job.id);void advanceJob(root,job.id,config).catch(()=>{}).finally(()=>busy.delete(job.id));
 }}
 void tick();const timer=setInterval(()=>void tick(),5000);timer.unref();
 return()=>{stopped=true;clearInterval(timer)};
}
module.exports={validId,readJob,writeJob,listJobs,publicJob,advanceJob,startWorker};
