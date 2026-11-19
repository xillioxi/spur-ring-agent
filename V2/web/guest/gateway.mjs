// Production guest gateway: no personal Agent token, Docker socket or model credentials.
import {createServer} from 'node:http'
import {readFileSync,existsSync,statSync,createReadStream,lstatSync,writeFileSync,renameSync,unlinkSync,chmodSync} from 'node:fs'
import {resolve,join,extname,sep} from 'node:path'
import {Readable} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import {fileURLToPath} from 'node:url'
import {GuestAccess,sessionCookie,sessionFromCookie} from './access.mjs'
import {GuestQueue,guestYoutubeTaskToken} from './queue.mjs'
import {AppConnections} from '../app-connections.mjs'
import {allowedBusinessRoute} from '../business-routes.mjs'
const uuid=/^[a-f0-9-]{36}$/
const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data))}
async function body(req){let size=0;const chunks=[];for await(const c of req){size+=c.length;if(size>49152)throw Object.assign(Error('请求过大。'),{status:413});chunks.push(c)}try{return JSON.parse(Buffer.concat(chunks).toString())}catch{throw Object.assign(Error('请求格式错误。'),{status:400})}}
function page(res,status,title,body){res.writeHead(status,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'"});res.end(`<!doctype html><meta charset="utf-8"><title>${title}</title><p>${body}</p>`)}
export function createGuestGateway({root,dist,origin='https://ai.hispurring.com',fetcher=fetch,now=Date.now,queueEnabled=false,connections=null}){
 if(new URL(origin).protocol!=='https:')throw Error('HTTPS origin required')
 const limits=new Map(),busy=new Set()
 function limited(key,max,window){const time=now();const old=limits.get(key);if(!old||old.until<=time){if(limits.size>10000){for(const [k,v]of limits)if(v.until<=time)limits.delete(k);if(limits.size>10000)return true}limits.set(key,{count:1,until:time+window});return false}return ++old.count>max}
 const store=()=>new GuestAccess(root,{now})
 function backend(id){const file=join(root,'workers.json');if(!existsSync(file))return null;if(!lstatSync(file).isFile()||(statSync(file).mode&0o077))throw Error('Private worker registry required');const v=JSON.parse(readFileSync(file,'utf8'))[id];if(!v||!Number.isInteger(v.port)||v.port<4300||v.port>4399||!/^[A-Za-z0-9_-]{43}$/.test(v.token))return null;return v}
 async function youtubeTaskToken(tenantId){if(!connections)return '';try{const credential=connections.bindings()[tenantId];if(!credential)return '';return guestYoutubeTaskToken((await connections.taskConfig(credential)).YOUTUBE_ACCESS_TOKEN)}catch{return ''}}
 const queue=queueEnabled?new GuestQueue({root,backend,fetcher,now,youtubeAccess:youtubeTaskToken,allowed:id=>{const t=store().data.tenants[id];return Boolean(t&&!t.revoked)}}):null
 const server=createServer(async(req,res)=>{
  let session,token;const url=new URL(req.url||'/',origin)
  try{
   if(req.headers.host!==new URL(origin).host)return json(res,403,{error:'无效站点。'})
   if(['POST','PUT','PATCH','DELETE'].includes(req.method)&&req.headers.origin!==origin)return json(res,403,{error:'请从当前网站操作。'})
   const youtubeCallback=req.method==='GET'&&url.pathname==='/api/connections/callback/youtube'
   if(req.headers['sec-fetch-site']==='cross-site'&&url.pathname.startsWith('/api/')&&!youtubeCallback)return json(res,403,{error:'不接受跨站请求。'})
   if(youtubeCallback){
    if(!connections)return page(res,503,'连接未完成','YouTube 官方授权尚未由管理员配置。')
    let ok=false
    try{await connections.callback('youtube',url.searchParams);ok=true}catch{}
    return page(res,ok?200:400,ok?'YouTube 已连接':'连接未完成',ok?'可以关闭这个页面，回到 Spur 刷新连接状态。':'授权已取消、过期或校验失败。请从 Spur 重新连接。')
   }
   if(req.method==='GET'&&url.pathname==='/healthz')return json(res,200,{status:'ready',service:'spur-guest-gateway',queueEnabled:Boolean(queue)})
   if(url.pathname==='/api/guest/login'&&req.method==='POST'){
    const ip=req.socket.remoteAddress||'unknown'
    if(limited('login:'+ip,20,600000))return json(res,429,{error:'尝试次数过多，请稍后再试。'})
    const data=await body(req),s=store().redeem(data.code)
    res.setHeader('Set-Cookie',sessionCookie(s.token));return json(res,200,{ok:true})
   }
   token=sessionFromCookie(req.headers.cookie);session=store().authenticate(token)
   if(url.pathname==='/api/guest/logout'&&req.method==='POST'){store().logout(token);res.setHeader('Set-Cookie',sessionCookie('',{clear:true}));return json(res,200,{ok:true})}
   if(url.pathname==='/login.js'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-store'});return res.end(readFileSync(new URL('./login.js',import.meta.url)))}
   if(!session&&url.pathname==='/api/web-backend'&&req.method==='GET')return json(res,200,{mode:'guest-public',label:'Spur Cloud',scope:'guest:public'})
   if(!session&&url.pathname.startsWith('/api/'))return json(res,401,{error:'请先在首页输入邀请码，解锁你的独立工作空间。'})
   if(url.pathname==='/api/web-backend'&&req.method==='GET')return json(res,200,{mode:'guest',label:'Spur Cloud',scope:'guest:'+session.tenantId})
   if(session&&url.pathname.startsWith('/api/guest/connections')){
    if(!connections)return json(res,503,{error:'YouTube 官方授权尚未由管理员配置。'})
    const credential=connections.credentialForTenant(session.tenantId)
    if(url.pathname==='/api/guest/connections'&&req.method==='GET'){
     const status=await connections.status(credential)
     const youtube=status.connections.find(item=>item.provider==='youtube')
     return json(res,200,{connections:[{provider:youtube.provider,state:youtube.state,label:youtube.label,configured:youtube.configured,connectedAt:youtube.connectedAt}]})
    }
    if(url.pathname==='/api/guest/connections/youtube/start'&&req.method==='POST'){const start=connections.start(credential,'youtube');return json(res,200,{authorizationUrl:start.authorizationUrl,expiresIn:start.expiresIn})}
    if(url.pathname==='/api/guest/connections/youtube/disconnect'&&req.method==='POST')return json(res,200,connections.disconnect(credential,'youtube'))
    return json(res,404,{error:'连接接口不存在。'})
   }
   if(session&&url.pathname.startsWith('/api/')){
    const method=req.method,path=url.pathname
    const match=path.match(/^\/api\/creator-agent\/(tasks|artifacts|videos)\/([a-f0-9-]{36})(?:\/(file))?$/)
    const submit=path==='/api/creator-agent/chat'&&method==='POST'
    const health=path==='/api/creator-agent/health'&&method==='GET'
    const business=allowedBusinessRoute(path,method)
    const get=match&&['GET','HEAD'].includes(method)&&uuid.test(match[2])&&(!match[3]||match[1]==='videos')
    if(!submit&&!health&&!get&&!business)return json(res,403,{error:'此体验暂未开放账号授权、邮箱或此操作。'})
    const rawPath=(req.url||'').split('?')[0]
    if(rawPath.includes('\\')||/%2f|%5c|%2e/i.test(rawPath)||path!==rawPath)return json(res,400,{error:'无效路径。'})
    if(limited('api:'+session.tenantId,150,60000))return json(res,429,{error:'请求频率过高，请稍后重试。'})
    const worker=backend(session.tenantId);if(!worker)return json(res,503,{error:'你的独立执行环境尚未准备好，请联系邀请人。'})
    const auth=store(),tenant=auth.data.tenants[session.tenantId];tenant.tasks||={};tenant.artifacts||={};tenant.videos||={};tenant.usage||={}
    if(get&& !tenant[match[1]][match[2]])return json(res,404,{error:'任务或成果不存在。'})
    if(queue&&get&&match[1]==='tasks'){
     const snapshot=queue.snapshot(session.tenantId,match[2])
     if(snapshot&&['queued','dispatching','failed'].includes(snapshot.queue.state))return json(res,200,snapshot)
    }
    let payload,runId
    if(business&&['POST','PUT','PATCH'].includes(method))payload=await body(req)
    if(submit){
     payload=await body(req);runId=payload.requestId
     if(!uuid.test(runId)||payload.async!==true||typeof payload.message!=='string'||!payload.message.trim()||payload.message.length>12000)return json(res,400,{error:'需要有效的异步任务请求。'})
     if(tenant.tasks[runId])return json(res,409,{error:'任务已经提交，请查询原任务。',runId})
     const today=new Date(now()).toISOString().slice(0,10),used=tenant.usage[today]||0,max=Math.min(20,Math.max(1,worker.dailyTasks||10))
     if(used>=max)return json(res,429,{error:'今日体验任务额度已用完。'})
     if(busy.has(session.tenantId))return json(res,429,{error:'上一个任务正在提交，请稍后再试。'})
     busy.add(session.tenantId);tenant.tasks[runId]={createdAt:now()};tenant.usage[today]=used+1;auth.save()
     // Only explicit protocol fields are forwarded. No browser-selected user/environment.
     payload={requestId:runId,message:payload.message,history:Array.isArray(payload.history)?payload.history:[],async:true}
     if(queue){
      try{queue.enqueue(session.tenantId,payload)}
      catch(error){const fresh=store(),t=fresh.data.tenants[session.tenantId];delete t.tasks[runId];t.usage[today]=Math.max(0,(t.usage[today]||0)-1);fresh.save();throw error}
      finally{busy.delete(session.tenantId)}
      return json(res,202,queue.snapshot(session.tenantId,runId))
     }
    }
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000),closed=()=>controller.abort();res.on('close',closed)
    try{
     const headers={Authorization:'Bearer '+worker.token};if(payload)headers['Content-Type']='application/json';if(req.headers.range)headers.Range=req.headers.range
     if(submit){const youtube=await youtubeTaskToken(session.tenantId);if(youtube)headers['X-Spur-Task-Youtube-Token']=youtube}
     const upstream=await fetcher('http://127.0.0.1:'+worker.port+path+url.search,{method,headers,body:payload?JSON.stringify(payload):undefined,signal:controller.signal,redirect:'manual'})
     clearTimeout(timer)
     if(upstream.status>=300&&upstream.status<400)return json(res,502,{error:'执行环境返回了意外重定向。'})
     if(upstream.headers.get('content-type')?.includes('application/json')){
      const result=await upstream.json()
      if(business)return json(res,upstream.status,result)
      const fresh=store(),owner=fresh.data.tenants[session.tenantId]
      const outputs=result.result||result
      for(const [field,target]of [['artifacts','artifacts'],['media','artifacts'],['videoJobs','videos']])for(const item of outputs[field]||[]){const id=field==='videoJobs'?item.id:String(item.url||'').match(/^\/api\/creator-agent\/artifacts\/([a-f0-9-]{36})(?:\?|$)/)?.[1];if(uuid.test(id||'')){owner[target]||={};owner[target][id]={runId:match?.[2]||runId}}}
      fresh.save();return json(res,upstream.status,result)
     }
     const h={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};for(const k of ['content-type','content-disposition','content-range','accept-ranges']){const value=upstream.headers.get(k);if(value)h[k]=value}res.writeHead(upstream.status,h)
     if(method==='HEAD'||!upstream.body)res.end();else await pipeline(Readable.fromWeb(upstream.body),res)
    }catch{if(!res.headersSent)json(res,502,{error:'连接中断，请查询原任务；不要重复提交。'});else res.destroy()}
    finally{clearTimeout(timer);res.off('close',closed);if(submit)busy.delete(session.tenantId)}
    return
   }
   if(!['GET','HEAD'].includes(req.method))return json(res,405,{error:'不支持的请求。'})
   let file=resolve(dist,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));if(!file.startsWith(resolve(dist)+sep))return json(res,400,{error:'无效路径。'})
   if(!existsSync(file)||!statSync(file).isFile())file=join(dist,'index.html')
   const type={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png'}[extname(file)]||'application/octet-stream'
   res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; media-src 'self' https:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'"});if(req.method==='HEAD')res.end();else createReadStream(file).pipe(res)
  }catch(e){if(!res.headersSent)json(res,e.status||500,{error:e.status?e.message:'访客服务暂时不可用，请稍后重试。'});else res.destroy()}
 })
 if(queue){const timer=setInterval(()=>void queue.tick().catch(()=>{}),2000);timer.unref();server.on('close',()=>clearInterval(timer))}
 return server
}
export function startGuestAdmin(root){
 const socket=join(root,'admin.sock');if(existsSync(socket)){if(!lstatSync(socket).isSocket())throw Error('Unexpected admin socket path');unlinkSync(socket)}
 const server=createServer(async(req,res)=>{try{
  if(req.method!=='POST')return json(res,405,{error:'POST required'})
  const data=await body(req),access=new GuestAccess(root)
  if(req.url==='/ping')return json(res,200,{ok:true})
  if(req.url==='/issue')return json(res,200,access.issue({label:data.label||'',tenantId:data.tenantId,days:data.days===undefined?7:data.days}))
  if(req.url==='/revoke'){access.revoke(data.tenantId);return json(res,200,{ok:true})}
  if(req.url==='/register'){
   if(!access.data.tenants[data.tenantId]||!Number.isInteger(data.port)||data.port<4300||data.port>4399||!/^[A-Za-z0-9_-]{43}$/.test(data.token))return json(res,400,{error:'Invalid worker'})
   const file=join(root,'workers.json'),registry=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{}
   if(Object.values(registry).some(v=>v.port===data.port))return json(res,409,{error:'Worker port already assigned'})
   registry[data.tenantId]={port:data.port,token:data.token,dailyTasks:10}
   const tmp=file+'.tmp';writeFileSync(tmp,JSON.stringify(registry),{mode:0o600});renameSync(tmp,file);return json(res,200,{ok:true})
  }
  return json(res,404,{error:'Unknown command'})
 }catch(e){return json(res,e.status||500,{error:'Admin operation failed'})}})
 server.listen(socket,()=>chmodSync(socket,0o600));return server
}
export function guestYoutubeConnections(root,env=process.env){
 const id=String(env.YOUTUBE_CLIENT_ID||'').trim(),secret=String(env.YOUTUBE_CLIENT_SECRET||'').trim()
 if(!id||!secret||/[\r\n]/.test(id+secret))return null
 return new AppConnections(root,{SPUR_PUBLIC_URL:'https://ai.hispurring.com',YOUTUBE_CLIENT_ID:id,YOUTUBE_CLIENT_SECRET:secret})
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const root=process.env.SPUR_GUEST_ROOT||'/data'
 new GuestAccess(root)
 const admin=startGuestAdmin(root)
 const connections=guestYoutubeConnections(root)
 console.log(connections?'YouTube guest connections enabled':'YouTube guest connections not configured')
 const server=createGuestGateway({root,dist:process.env.SPUR_WEB_DIST||'/app/dist',queueEnabled:process.env.SPUR_GUEST_QUEUE==='1'||existsSync(join(root,'queue-enabled')),connections})
 server.listen(Number(process.env.PORT||4190),'127.0.0.1',()=>console.log('Spur guest gateway listening on loopback'))
 for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{admin.close();server.close(()=>process.exit(0))})
}
