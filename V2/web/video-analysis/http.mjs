import {createReadStream} from 'node:fs'
import {pipeline} from 'node:stream/promises'
import {createVideoAnalysisService,VideoAnalysisError} from './service.mjs'
import {createInstagramConnectionStore} from './instagram-connection.mjs'

export const VIDEO_ANALYSIS_PREFIX='/api/creator-agent/video-analysis'
const idPattern='([a-f0-9-]{36})'
const itemRoute=new RegExp(`^${VIDEO_ANALYSIS_PREFIX}/items/${idPattern}(?:/(analyze|media|export|rea-assets|rea-frames|rea-review|face-candidates|reconstruction-plan|reconstructions))?$`)
const faceReferenceRoute=new RegExp(`^${VIDEO_ANALYSIS_PREFIX}/face-references/${idPattern}(?:/(image))?$`)
const reconstructionRoute=new RegExp(`^${VIDEO_ANALYSIS_PREFIX}/reconstructions/${idPattern}(?:/(media|analyze|resume))?$`)
const channelRoute=new RegExp(`^${VIDEO_ANALYSIS_PREFIX}/channels/((?:instagram|tiktok)-[a-z0-9_.]{1,30})(?:/(sync|discover|avatar|thumbnail|import-all|import-all/stop|analyze-all|analyze-all/stop|face-references|face-references/export))?$`)
const types={'.mp4':'video/mp4','.m4v':'video/mp4','.mov':'video/quicktime','.webm':'video/webm','.mkv':'video/x-matroska','.avi':'video/x-msvideo'}
const fail=(message,status=422,code)=>new VideoAnalysisError(message,status,code)
function json(res,status,value,method) {
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'})
  res.end(method==='HEAD'?undefined:JSON.stringify(value))
}
async function body(req,fields,maxBytes=16*1024) {
  if(!req.headers['content-type']?.startsWith('application/json')) throw fail('Use a JSON request body.',415)
  let bytes=0; const parts=[]
  for await(const part of req) {bytes+=part.length;if(bytes>maxBytes) throw fail('The request is too large.',413);parts.push(part)}
  let data
  try{data=JSON.parse(Buffer.concat(parts).toString('utf8'))}catch{throw fail('Provide a JSON object.',400)}
  if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).some(key=>!fields.includes(key))) throw fail('Unexpected request fields.',400)
  return data
}
function query(url,fields) {
  const seen=new Set()
  for(const [key] of url.searchParams) {if(!fields.includes(key)||seen.has(key)) throw fail('Unexpected query parameters.',400);seen.add(key)}
}
export function parseVideoByteRange(header,size) {
  if(!header) return null
  const match=/^bytes=(\d*)-(\d*)$/.exec(header)
  if(!match||!match[1]&&!match[2]||size<=0) throw fail('Requested video range is unavailable.',416,'invalid_range')
  let start,end
  if(!match[1]) { const suffix=Number(match[2]); if(!Number.isSafeInteger(suffix)||suffix<1) throw fail('Requested video range is unavailable.',416,'invalid_range');start=Math.max(0,size-suffix);end=size-1 }
  else {start=Number(match[1]);end=match[2]?Number(match[2]):size-1}
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start) throw fail('Requested video range is unavailable.',416,'invalid_range')
  return {start,end:Math.min(end,size-1)}
}
async function media(req,res,service,id,reconstruction=false) {
  const value=await (reconstruction?service.getReconstructionMedia(id):service.getMedia(id))
  let range
  try{range=parseVideoByteRange(req.headers.range,value.size)}catch(error){if(error.status===416)res.setHeader('Content-Range',`bytes */${value.size}`);throw error}
  const headers={'Content-Type':types[value.extension]||'application/octet-stream','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Accept-Ranges':'bytes','Content-Length':range?range.end-range.start+1:value.size,'Content-Disposition':'inline'}
  if(range) headers['Content-Range']=`bytes ${range.start}-${range.end}/${value.size}`
  res.writeHead(range?206:200,headers)
  if(req.method==='HEAD') {res.end();return}
  await pipeline(createReadStream(value.filePath,range||{}),res)
}

// The original Spur host authenticates the profile before invoking this adapter.
// Storage, credentials and analyzers come only from that host, never request data.
export async function handleVideoAnalysisRequest(req,res,options) {
  const raw=req.url||'/',url=new URL(raw,'http://localhost'),path=url.pathname,method=req.method||'GET',rawPath=raw.split('?')[0]
  if(path!==VIDEO_ANALYSIS_PREFIX&&!path.startsWith(VIDEO_ANALYSIS_PREFIX+'/')) return false
  try {
    if(rawPath!==path||rawPath.includes('\\')||/%2f|%5c|%2e/i.test(rawPath)) throw fail('Video endpoint not found.',404,'not_found')
    const connection=createInstagramConnectionStore({root:options.root,config:options.config}),service=createVideoAnalysisService({...options,getDiscoveryConfig:options.getDiscoveryConfig||(()=>connection.getConfig())}),route=itemRoute.exec(path),channel=channelRoute.exec(path),reconstruction=reconstructionRoute.exec(path),faceReference=faceReferenceRoute.exec(path)
    if(path===`${VIDEO_ANALYSIS_PREFIX}/instagram-connection`){
      query(url,[])
      try{
        if(['GET','HEAD'].includes(method))json(res,200,{connection:await connection.status()},method)
        else if(method==='PUT'){const value=await body(req,['accountId','accessToken']);json(res,200,{connection:await connection.connect(value)},method)}
        else if(method==='DELETE'){if(Number(req.headers['content-length'])>0)throw fail('Unexpected request body.',400);json(res,200,{connection:await connection.disconnect()},method)}
        else throw fail('Video endpoint not found.',404,'not_found')
      }catch(error){throw error instanceof VideoAnalysisError?error:fail(error.message,error.status,error.code)}
    }
    else if(path===`${VIDEO_ANALYSIS_PREFIX}/status`&&['GET','HEAD'].includes(method)) {query(url,[]);json(res,200,await service.status(),method)}
    else if(path===`${VIDEO_ANALYSIS_PREFIX}/items`&&['GET','HEAD'].includes(method)) {query(url,['channelId']);json(res,200,{items:await service.list({channelId:url.searchParams.has('channelId')?url.searchParams.get('channelId'):undefined})},method)}
    else if(path===`${VIDEO_ANALYSIS_PREFIX}/channels`&&['GET','HEAD'].includes(method)) {query(url,[]);json(res,200,{channels:await service.listChannels()},method)}
    else if(path===`${VIDEO_ANALYSIS_PREFIX}/reconstructions`&&['GET','HEAD'].includes(method)){query(url,['referenceId']);json(res,200,{jobs:await service.listReconstructions({referenceId:url.searchParams.get('referenceId')||undefined})},method)}
    else if(faceReference){
      const [,id,action]=faceReference
      if(!action&&method==='PATCH'){query(url,[]);const value=await body(req,['selected','angle','label']);json(res,200,{reference:await service.updateFaceReference(id,value)},method)}
      else if(action==='image'&&['GET','HEAD'].includes(method)){
        query(url,['context']);if(url.searchParams.has('context')&&url.searchParams.get('context')!=='1')throw fail('Unexpected query parameters.',400)
        const value=await service.getFaceReferenceImage(id,{context:url.searchParams.get('context')==='1'})
        res.writeHead(200,{'Content-Type':value.contentType,'Content-Length':value.size,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Disposition':`inline; filename="face-reference-${id}.jpg"`})
        if(method==='HEAD')res.end();else await pipeline(createReadStream(value.filePath),res)
      }else throw fail('Video endpoint not found.',404,'not_found')
    }
    else if(reconstruction){
      const [,id,action]=reconstruction
      if(!action&&['GET','HEAD'].includes(method)){query(url,[]);json(res,200,{job:await service.getReconstruction(id)},method)}
      else if(action==='media'&&['GET','HEAD'].includes(method)){query(url,[]);await media(req,res,service,id,true)}
      else if(action==='analyze'&&method==='POST'){query(url,[]);await body(req,[]);json(res,202,await service.analyzeReconstruction(id),method)}
      else if(action==='resume'&&method==='POST'){query(url,[]);await body(req,[]);json(res,202,{job:await service.resumeReconstruction(id)},method)}
      else throw fail('Video endpoint not found.',404,'not_found')
    }
    else if(path===`${VIDEO_ANALYSIS_PREFIX}/channels`&&method==='POST') {query(url,[]);const value=await body(req,['url']);json(res,201,{channel:await service.addChannel(value.url)},method)}
    else if(channel) {
      const [,id,action]=channel
      if(!action&&['GET','HEAD'].includes(method)){query(url,[]);json(res,200,{channel:await service.getChannel(id)},method)}
      else if(action==='face-references'&&['GET','HEAD'].includes(method)){query(url,[]);json(res,200,await service.listFaceReferences(id),method)}
      else if(action==='face-references'&&method==='POST'){
        query(url,['filename']);const length=req.headers['content-length']
        if(length!==undefined&&!/^\d+$/.test(length))throw fail('Invalid photo upload size.',400)
        json(res,201,await service.uploadFaceReference(id,req,{filename:url.searchParams.get('filename'),contentLength:length===undefined?undefined:Number(length),contentType:req.headers['content-type']}),method)
      }
      else if(action==='face-references/export'&&['GET','HEAD'].includes(method)){
        query(url,[]);const value=await service.exportFaceReferences(id)
        res.writeHead(200,{'Content-Type':value.contentType,'Content-Length':value.bytes.length,'Content-Disposition':`attachment; filename="${value.filename}"`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'})
        res.end(method==='HEAD'?undefined:value.bytes)
      }
      else if(!action&&method==='PATCH'){query(url,[]);const value=await body(req,['style']);json(res,200,{channel:await service.updateChannel(id,value)},method)}
      else if(action==='sync'&&method==='POST'){query(url,[]);if(req.headers['content-type']?.startsWith('application/json'))await body(req,[]);else if(Number(req.headers['content-length'])>0)throw fail('Use a JSON request body.',415);json(res,200,{channel:await service.syncChannel(id)},method)}
      else if(action==='discover'&&method==='POST'){query(url,[]);let value={};if(req.headers['content-type']?.startsWith('application/json'))value=await body(req,['resume']);else if(Number(req.headers['content-length'])>0)throw fail('Use a JSON request body.',415);json(res,202,{channel:await service.discoverChannel(id,value)},method)}
      else if(['import-all','import-all/stop'].includes(action)&&method==='POST'){query(url,[]);if(req.headers['content-type']?.startsWith('application/json'))await body(req,[]);else if(Number(req.headers['content-length'])>0)throw fail('Unexpected request body.',400);json(res,202,action==='import-all'?await service.importAllChannelVideos(id):await service.stopChannelImports(id),method)}
      else if(['analyze-all','analyze-all/stop'].includes(action)&&method==='POST'){query(url,[]);let value={};if(req.headers['content-type']?.startsWith('application/json'))value=await body(req,action==='analyze-all'?['analysisModelId','analysisWorkflowId','scriptTemplateId']:[]);else if(Number(req.headers['content-length'])>0)throw fail('Unexpected request body.',400);json(res,202,action==='analyze-all'?await service.analyzeAllChannelVideos(id,value):await service.stopChannelAnalyses(id),method)}
      else if(action==='avatar'&&['GET','HEAD'].includes(method)){query(url,['v']);const value=await service.getChannelAvatar(id);res.writeHead(200,{'Content-Type':value.contentType,'Content-Length':value.size,'Cache-Control':'private, max-age=3600','X-Content-Type-Options':'nosniff'});if(method==='HEAD')res.end();else await pipeline(createReadStream(value.filePath),res)}
      else if(action==='thumbnail'&&['GET','HEAD'].includes(method)){query(url,['video']);const value=await service.getChannelThumbnail(id,url.searchParams.get('video'));res.writeHead(200,{'Content-Type':value.contentType,'Content-Length':value.bytes.length,'Cache-Control':'private, max-age=900','X-Content-Type-Options':'nosniff'});res.end(method==='HEAD'?undefined:value.bytes)}
      else throw fail('Video endpoint not found.',404,'not_found')
    }
    else if(path===`${VIDEO_ANALYSIS_PREFIX}/uploads`&&method==='POST') {
      query(url,['filename','channelId'])
      const rawLength=req.headers['content-length']
      if(rawLength!==undefined&&!/^\d+$/.test(rawLength)) throw fail('Invalid upload size.',400)
      const item=await service.upload(req,{filename:url.searchParams.get('filename'),contentLength:rawLength===undefined?undefined:Number(rawLength),contentType:req.headers['content-type'],channelId:url.searchParams.has('channelId')?url.searchParams.get('channelId'):undefined})
      json(res,201,{item},method)
    } else if(path===`${VIDEO_ANALYSIS_PREFIX}/imports`&&method==='POST') {query(url,[]);const value=await body(req,['url','channelId']);json(res,202,{item:await service.importUrl(value.url,{channelId:value.channelId})},method)}
    else if(route) {
      const [,id,action]=route
      if(!action&&['GET','HEAD'].includes(method)) {query(url,[]);json(res,200,{item:await service.get(id)},method)}
      else if(!action&&method==='PATCH'){query(url,[]);const value=await body(req,['channelId']);if(!Object.hasOwn(value,'channelId'))throw fail('Choose a channel.',400);json(res,200,{item:await service.assignChannel(id,value.channelId)},method)}
      else if(action==='analyze'&&method==='POST') {query(url,[]);const value=await body(req,['mode','analysisModelId','analysisWorkflowId','scriptTemplateId']);json(res,202,{item:await service.analyze(id,value)},method)}
      else if(action==='face-candidates'&&method==='POST'){query(url,[]);await body(req,[]);json(res,201,await service.captureFaceReferences(id),method)}
      else if(action==='rea-review'&&method==='PUT') {query(url,[]);const value=await body(req,['summary','hook','payoff','characters','corrections'],96*1024);json(res,200,{item:await service.updateReaReview(id,value)},method)}
      else if(action==='rea-frames'&&method==='GET') {
        query(url,['start','end'])
        const start=url.searchParams.get('start'),end=url.searchParams.get('end')
        if(!start?.trim()||!end?.trim()||!Number.isFinite(Number(start))||!Number.isFinite(Number(end)))throw fail('Choose a valid start and end time.',400,'invalid_rea_frames')
        const value=await service.getReaFrames(id,{startSeconds:Number(start),endSeconds:Number(end)})
        res.writeHead(200,{'Content-Type':value.contentType,'Content-Length':value.bytes.length,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Disposition':`inline; filename="${value.filename}"`})
        res.end(value.bytes)
      }
      else if(action==='rea-assets'&&['GET','HEAD'].includes(method)) {
        query(url,['asset','download']);if(url.searchParams.has('download')&&url.searchParams.get('download')!=='1')throw fail('Unexpected query parameters.',400)
        const value=await service.getReaAsset(id,url.searchParams.get('asset'))
        res.writeHead(200,{'Content-Type':value.contentType,'Content-Length':value.bytes.length,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Disposition':`${url.searchParams.has('download')?'attachment':'inline'}; filename="${value.filename}"`})
        res.end(method==='HEAD'?undefined:value.bytes)
      }
      else if(action==='reconstruction-plan'&&['GET','HEAD'].includes(method)){query(url,[]);json(res,200,{plan:await service.reconstructionPlan(id)},method)}
      else if(action==='reconstruction-plan'&&method==='POST'){query(url,[]);const value=await body(req,['timeline'],1024*1024);json(res,200,{plan:await service.reconstructionPlan(id,value)},method)}
      else if(action==='reconstructions'&&method==='POST'){query(url,[]);const value=await body(req,['requestKey','planRevision','shots','timeline','audioMode','resolution'],1024*1024);json(res,202,{job:await service.createReconstruction(id,value)},method)}
      else if(action==='media'&&['GET','HEAD'].includes(method)) {query(url,[]);await media(req,res,service,id)}
      else if(action==='export'&&['GET','HEAD'].includes(method)) {
        query(url,['format']);const value=await service.exportItem(id,{format:url.searchParams.get('format')||'txt'})
        res.writeHead(200,{'Content-Type':value.contentType,'Content-Disposition':`attachment; filename="${value.filename}"`,'Content-Length':Buffer.byteLength(value.body),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'})
        res.end(method==='HEAD'?undefined:value.body)
      } else throw fail('Video endpoint not found.',404,'not_found')
    } else throw fail('Video endpoint not found.',404,'not_found')
  } catch(error) {
    if(!res.headersSent&&!res.destroyed) json(res,Number.isInteger(error.status)&&error.status>=400&&error.status<=599?error.status:500,{error:error instanceof VideoAnalysisError?error.message:'The video request could not be completed. Please try again.',code:error.code||'video_request_failed'},method)
    else if(!res.destroyed) res.destroy()
  }
  return true
}
