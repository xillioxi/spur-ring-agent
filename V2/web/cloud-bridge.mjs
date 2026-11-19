// Single-owner, loopback-only development bridge. Not a public multi-user gateway.
import {existsSync,readFileSync,statSync} from 'node:fs'
import {join} from 'node:path'
import {homedir} from 'node:os'
import {Readable} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import {allowedBusinessRoute} from './business-routes.mjs'
export const cloudOrigin='https://api.hispurring.com'
export function bridgeConfig(env=process.env){
 const tokenFile=env.SPUR_WEB_AGENT_TOKEN_FILE || join(homedir(),'.local/share/spur/web-cloud/agent-token')
 const enabled=env.SPUR_WEB_CLOUD==='1'||(env.SPUR_WEB_CLOUD!=='0'&&existsSync(tokenFile))
 return {enabled,tokenFile}
}
export function allowedRoute(path,method){
 if(allowedBusinessRoute(path,method))return true
 if(method==='POST')return path==='/api/creator-agent/chat'
 if(!['GET','HEAD'].includes(method))return false
 return path==='/api/creator-agent/health'||/^\/api\/creator-agent\/(tasks|artifacts)\/[a-f0-9-]{36}$/.test(path)||/^\/api\/creator-agent\/videos(?:\/[a-f0-9-]{36}(?:\/file)?)?$/.test(path)
}
function localRequest(req){
 const host=req.headers.host
 if(!['127.0.0.1:5174','localhost:5174'].includes(host))return false
 const site=req.headers['sec-fetch-site']
 if(site&&!['same-origin','none'].includes(site))return false
 const origin=req.headers.origin
 return !origin||origin===`http://${host}`
}
function json(res,status,body){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body))}
export function createBridge({config=bridgeConfig(),fetcher=fetch}={}){
 return async function bridge(req,res,next){
  const raw=req.url||'/'
  if(!raw.startsWith('/api/'))return next()
  if(!localRequest(req))return json(res,403,{error:'请从本机 Spur 网页访问。'})
  if(raw==='/api/web-backend'&&req.method==='GET')return json(res,200,{mode:config.enabled?'cloud':'local',label:config.enabled?'硅谷 ECS':'本机 Agent',scope:config.enabled?cloudOrigin:''})
  // Local video analysis uses this machine's private library and local models,
  // including when chat is routed to the cloud. Never forward video files or model calls.
  if(raw.split('?')[0].startsWith('/api/creator-agent/video-analysis/'))return next()
  // Personal email and credentials belong to this computer's Memory store.
  // Never send them to the chat cloud bridge.
  if(raw.split('?')[0].startsWith('/api/creator-agent/email-memory/'))return next()
  const privatePath=raw.split('?')[0]
  if(privatePath==='/api/creator-agent/meta-inbox'||privatePath.startsWith('/api/meta-login/')||privatePath==='/api/creator-agent/social-archives'||privatePath==='/api/creator-agent/social-connections'||privatePath.startsWith('/api/creator-agent/whatsapp-memory/'))return next()
  if(!config.enabled)return next()
  const url=new URL(raw,'http://localhost')
  const rawPath=raw.split('?')[0]
  if(!allowedRoute(url.pathname,req.method)||rawPath.includes('\\')||/%2f|%5c|%2e/i.test(rawPath)||url.pathname!==rawPath)return json(res,403,{error:'此接口尚未接通云端。'})
  let token
  try{
   const mode=statSync(config.tokenFile).mode
   if(mode&0o077)throw Error('permissions')
   token=readFileSync(config.tokenFile,'utf8').trim()
   if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw Error('invalid')
  }catch{return json(res,503,{error:'云端访问令牌未配置或文件权限不正确，请完成本机私有配置。'})}
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000)
  const closed=()=>controller.abort()
  res.on('close',closed)
  try{
   let body
   if(['POST','PUT','PATCH'].includes(req.method)){
    if(!req.headers['content-type']?.startsWith('application/json'))return json(res,415,{error:'仅支持 JSON 任务请求。'})
    const chunks=[];let bytes=0
    for await(const chunk of req){bytes+=chunk.length;if(bytes>48*1024)return json(res,413,{error:'任务请求过大。'});chunks.push(chunk)}
    body=Buffer.concat(chunks)
    let data;try{data=JSON.parse(body.toString())}catch{return json(res,400,{error:'无效 JSON。'})}
    if(url.pathname==='/api/creator-agent/chat'&&data.async!==true)return json(res,400,{error:'云端任务必须异步提交。'})
   }
   const headers={Authorization:`Bearer ${token}`}
   if(body)headers['Content-Type']='application/json'
   if(req.headers.range)headers.Range=req.headers.range
   const upstream=await fetcher(cloudOrigin+url.pathname+url.search,{method:req.method,headers,body,signal:controller.signal,redirect:'manual'})
   clearTimeout(timer) // file/video streaming is not limited to the API header timeout
   if(upstream.status>=300&&upstream.status<400)return json(res,502,{error:'云端返回了意外重定向，已停止转发。'})
   const output={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}
   for(const key of ['content-type','content-disposition','content-range','accept-ranges']){const value=upstream.headers.get(key);if(value)output[key]=value}
   res.writeHead(upstream.status,output)
   if(req.method==='HEAD'||!upstream.body)res.end()
   else await pipeline(Readable.fromWeb(upstream.body),res)
  }catch{
   if(!res.headersSent)json(res,502,{error:'与硅谷 ECS 连接中断；已提交的任务请查询原任务状态，不要重复提交。'})
   else res.destroy()
  }finally{clearTimeout(timer);res.off('close',closed)}
 }
}
export function cloudBridgePlugin(){return {name:'spur-private-cloud-bridge',configureServer(server){server.middlewares.use(createBridge())}}}
