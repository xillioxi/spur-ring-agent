import {createEmailMemoryService,EmailMemoryError} from './service.mjs'

export const EMAIL_MEMORY_PREFIX='/api/creator-agent/email-memory'
const fail=(message,status=422,code)=>new EmailMemoryError(message,status,code)
function json(res,status,value,method){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(method==='HEAD'?undefined:JSON.stringify(value))}
async function body(req,fields){
  if(!req.headers['content-type']?.startsWith('application/json'))throw fail('Use a JSON request body.',415)
  const chunks=[];let bytes=0
  for await(const chunk of req){bytes+=chunk.length;if(bytes>16*1024)throw fail('The email request is too large.',413);chunks.push(chunk)}
  let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{throw fail('Provide a JSON object.',400)}
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!fields.includes(key)))throw fail('Unexpected email request fields.',400)
  return value
}
function query(url,fields){const seen=new Set();for(const [key] of url.searchParams){if(seen.has(key)||!fields.includes(key))throw fail('Unexpected email query parameters.',400);seen.add(key)}}
/** The host authenticates the workspace before invoking this private adapter. */
export async function handleEmailMemoryRequest(req,res,options){
  const raw=req.url||'/',url=new URL(raw,'http://localhost'),path=url.pathname,method=req.method||'GET',rawPath=raw.split('?')[0],prefix=EMAIL_MEMORY_PREFIX
  if(path!==prefix&&!path.startsWith(prefix+'/'))return false
  try{
    if(rawPath!==path||rawPath.includes('\\')||/%2f|%5c|%2e/i.test(rawPath))throw fail('Email endpoint not found.',404,'not_found')
    const service=createEmailMemoryService(options),read=['GET','HEAD'].includes(method),detail=new RegExp(`^${prefix}/messages/([^/]+)$`).exec(path)
    if(path===`${prefix}/status`&&read){query(url,[]);json(res,200,await service.status(),method)}
    else if(path===`${prefix}/graph`&&read){query(url,['query','relationship']);json(res,200,await service.graph({query:url.searchParams.get('query')||'',relationship:url.searchParams.get('relationship')||'auto'}),method)}
    else if(path===`${prefix}/messages`&&read){query(url,['person','query','cursor','limit']);const limit=url.searchParams.get('limit');if(limit!==null&&!/^\d{1,3}$/.test(limit))throw fail('Choose a valid email page size.',400);json(res,200,await service.messages({person:url.searchParams.has('person')?url.searchParams.get('person'):undefined,query:url.searchParams.get('query')||'',cursor:url.searchParams.has('cursor')?url.searchParams.get('cursor'):undefined,limit:limit===null?50:Number(limit)}),method)}
    else if(detail&&read){query(url,[]);let id;try{id=decodeURIComponent(detail[1])}catch{throw fail('Email not found.',404,'not_found')}json(res,200,await service.message(id),method)}
    else if(path===`${prefix}/contacts`&&method==='PATCH'){query(url,[]);const value=await body(req,['email','accountId','relationship','company','role']);json(res,200,await service.updateContact(value),method)}
    else if(path===`${prefix}/sync`&&method==='POST'){query(url,[]);const value=await body(req,['resume']);json(res,202,{status:await service.startSync(value)},method)}
    else if(path===`${prefix}/connect`&&method==='POST'){query(url,[]);const value=await body(req,['provider','email','appPassword','host','port','region','accountType']);json(res,200,{connection:await service.connect(value)},method)}
    else if(path===`${prefix}/oauth/start`&&method==='POST'){query(url,[]);const value=await body(req,['provider','clientId']);json(res,200,await service.startOAuth(value),method)}
    else if(path===`${prefix}/mailboxes/select`&&method==='POST'){query(url,[]);const value=await body(req,['mailboxId']);json(res,200,{status:await service.selectMailbox(value.mailboxId)},method)}
    else if(path===`${prefix}/connection`&&method==='DELETE'){query(url,[]);if(req.headers['transfer-encoding']||Number(req.headers['content-length'])>0)throw fail('Unexpected email request body.',400);json(res,200,{connection:await service.disconnect()},method)}
    else throw fail('Email endpoint not found.',404,'not_found')
  }catch(error){if(!res.headersSent&&!res.destroyed)json(res,error instanceof EmailMemoryError?error.status:500,{error:error instanceof EmailMemoryError?error.message:'The email request could not be completed. Please try again.',code:error instanceof EmailMemoryError?error.code:'email_memory_failed'},method);else if(!res.destroyed)res.destroy()}
  return true
}
