const {fetchPublic} = require('../playwright-browser/public-network.cjs');
async function api(config,path,payload,fetchApi=fetch) {
 const endpoint=new URL(config.baseUrl.replace(/\/$/,'')+path);
 if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||!config.apiKey) throw new Error('视频服务配置无效。');
 const response=await fetchApi(endpoint,{method:'POST',headers:{Authorization:`Bearer ${config.apiKey}`,'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(30000),redirect:'error'});
 if(!response.ok){const error=new Error(`视频服务返回 HTTP ${response.status}。`);error.status=response.status;error.definitive=response.status>=400&&response.status<500;throw error}
 return response.json();
}
const H3='MiniMaxAI/MiniMax-H3';const RATIOS=['1:1','3:4','4:3','9:16','16:9','21:9'];const RESOLUTIONS=['480p','768p'];const invalid=message=>Object.assign(new Error(message),{status:422,definitive:true});
function image(value){
 if(!value||typeof value!=='object'||!['first_frame','last_frame'].includes(value.role))throw invalid('参考图片角色无效。');
 let url;try{url=new URL(value.url)}catch{throw invalid('参考图片必须使用公开 HTTPS 地址。')}
 const host=url.hostname.toLowerCase();if(url.protocol!=='https:'||url.username||url.password||!host||host==='localhost'||host.endsWith('.local')||host.endsWith('.internal'))throw invalid('参考图片必须使用公开 HTTPS 地址。');
 return{url:url.href,role:value.role};
}
async function submitVideo(config,{prompt,duration=5,resolution='768p',ratio='16:9',seed,images=[]},fetchApi=fetch){
 if(config.model!==H3) throw invalid('视频生成必须配置 MiniMaxAI/MiniMax-H3。');
 if(typeof prompt!=='string'||!prompt.trim()||prompt.length>4000) throw invalid('视频描述应为 1–4000 个字符。');
 if(!Number.isInteger(duration)||duration<5||duration>15)throw invalid('视频时长必须是 5–15 秒的整数。');
 if(!RESOLUTIONS.includes(resolution)||!RATIOS.includes(ratio))throw invalid('不支持的视频分辨率或画面比例。');
 if(seed!==undefined&&(!Number.isSafeInteger(seed)||seed<0))throw invalid('随机种子必须是非负整数。');
 if(!Array.isArray(images)||images.length>2)throw invalid('最多添加首帧和尾帧各一张。');
 const prepared=images.map(image);if(new Set(prepared.map(value=>value.role)).size!==prepared.length)throw invalid('首帧或尾帧图片不能重复。');
 const body={model:config.model,prompt:prompt.trim(),duration,resolution,ratio};if(seed!==undefined)body.seed=seed;if(prepared.length)body.images=prepared;
 const result=await api(config,'/video/submit',body,fetchApi);
 if(typeof result.requestId!=='string'||!result.requestId.trim()) throw new Error('视频服务未返回任务编号；不会自动重复提交。');
 return result.requestId;
}
async function videoStatus(config,requestId,fetchApi=fetch){
 if(typeof requestId!=='string'||!requestId||requestId.length>200)throw new Error('视频任务编号无效。');
 const result=await api(config,'/video/status',{requestId},fetchApi);
 const status={InQueue:'queued',InProgress:'generating',Succeed:'ready',Failed:'failed'}[result.status];
 if(!status)throw new Error('视频服务返回未知状态。');
 return {status,url:status==='ready'?result.results?.videos?.[0]?.url:undefined,seed:result.results?.seed,inference:result.results?.timings?.inference};
}
async function downloadVideo(url){
 const result=await fetchPublic(url,0,{binary:true,maxBytes:200000000,timeoutMs:120000,mediaKind:'video'});
 const bytes=result.bytes;
 if(bytes.length<12||bytes.toString('ascii',4,8)!=='ftyp')throw new Error('返回文件不是有效的 MP4 视频。');
 return bytes;
}
module.exports={H3,RATIOS,RESOLUTIONS,submitVideo,videoStatus,downloadVideo};
