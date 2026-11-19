const {basename,join}=require('node:path');const {appendFileSync}=require('node:fs');const {randomUUID}=require('node:crypto');
const {submitVideo}=require('./client.cjs');const {listJobs,writeJob,readJob,publicJob}=require('./jobs.cjs');
exports.inject=['tools'];
exports.apply=function(ctx){
 const root=process.env.SPUR_VIDEO_JOBS_ROOT;const out=process.env.SPUR_RESEARCH_OUTPUT;if(!root||!out)throw new Error('视频任务目录未配置。');
 const runId=basename(out);const log=e=>appendFileSync(join(out,'tool-events.jsonl'),JSON.stringify({at:new Date().toISOString(),...e})+'\n');
 ctx.tools.register({name:'video_status',description:'Read the tracked status of an existing video job without submitting another generation. Omit job_id to check the most recent local job. Use for progress questions, never regenerate just to check status.',parameters:{job_id:{type:'string'}},output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},async execute({job_id}){
  const job=job_id?readJob(root,job_id):listJobs(root).sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt))[0];
  if(!job)return{found:false,message:'还没有视频生成任务。'};
  const id=randomUUID();log({event:'call',id,tool:'video_status',args:{job_id:job.id}});log({event:'result',id,tool:'video_status',available:true,jobId:job.id});return publicJob(job);
 }});
 ctx.tools.register({name:'video_generate',description:'Submit one real MiniMax H3 video generation job. Preserve the requested scene and choose reasonable unspecified details. Returns immediately with a persisted asynchronous job; the website tracks progress and displays the finished video. Submit once, never repeatedly submit or poll in the model loop. Do not claim it is finished while queued.',parameters:{prompt:{type:'string',required:true},duration:{type:'integer',minimum:5,maximum:15},resolution:{type:'string',enum:['480p','768p']},ratio:{type:'string',enum:['1:1','3:4','4:3','9:16','16:9','21:9']},seed:{type:'integer',minimum:0},images:{type:'array',items:{type:'object',properties:{url:{type:'string'},role:{type:'string',enum:['first_frame','last_frame']}},required:['url','role'],additionalProperties:false},maxItems:2}},output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},async execute(args){
  if(typeof args.prompt!=='string'||!args.prompt.trim()||args.prompt.length>4000)throw new Error('视频描述无效。');
  const jobs=listJobs(root);const prior=jobs.find(j=>j.runId===runId);if(prior)return publicJob(prior);
  if(jobs.filter(j=>['queued','generating','downloading','submitting'].includes(j.status)).length>=3)throw new Error('已有三个视频任务在处理，请稍后再提交。');
  const request={prompt:args.prompt,duration:args.duration||5,resolution:args.resolution||'768p',ratio:args.ratio||'16:9',...(args.seed===undefined?{}:{seed:args.seed}),...(args.images?.length?{images:args.images}:{})};
  const job={id:randomUUID(),runId,status:'submitting',createdAt:new Date().toISOString(),...request,model:process.env.SPUR_VIDEO_T2V_MODEL||'MiniMaxAI/MiniMax-H3'};writeJob(root,job);log({event:'call',id:job.id,tool:'video_generate',args:{...request,images:request.images?.map(value=>({role:value.role,url:'[reference image URL]'}))}});
  const providerConfig = {
   apiKey: process.env.SPUR_VIDEO_SILICONFLOW_API_KEY ?? process.env.SILICONFLOW_API_KEY,
   baseUrl: process.env.SPUR_VIDEO_SILICONFLOW_BASE_URL || process.env.SILICONFLOW_BASE_URL || 'https://api.siliconflow.cn/v1',
   model: job.model,
  };
  try{job.requestId=await submitVideo(providerConfig,request);job.status='queued';writeJob(root,job);log({event:'result',id:job.id,tool:'video_generate',available:true,jobId:job.id});return{...publicJob(job),submitted:true,instruction:'Briefly confirm submission. The website shows progress and will display the video automatically. Do not poll, resubmit or claim completion.'}}
  catch(error){job.status=error.definitive?'failed':'submission_unknown';job.error=error.definitive?error.message:'提交结果暂未确认，不会自动重试，避免重复生成。';writeJob(root,job);log({event:'result',id:job.id,tool:'video_generate',available:false,error:job.error});return publicJob(job)}
 }});
};
