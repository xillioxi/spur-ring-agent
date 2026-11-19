import {createWhatsAppService} from './service.mjs'
export const WHATSAPP_PREFIX='/api/creator-agent/whatsapp-memory'
export function whatsappReadToolRoute(path,method){return method==='GET'&&['/status','/chats','/messages'].some(suffix=>path===WHATSAPP_PREFIX+suffix)}
const fail=(message,status=400)=>Object.assign(new Error(message),{status})
async function body(req,fields,max=16384){if(!req.headers['content-type']?.startsWith('application/json'))throw fail('Use JSON.',415);const parts=[];let bytes=0;for await(const part of req){bytes+=part.length;if(bytes>max)throw fail('WhatsApp import exceeds 24 MiB.',413);parts.push(part)}let value;try{value=JSON.parse(Buffer.concat(parts).toString('utf8'))}catch{throw fail('Provide a JSON object.')}if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!fields.includes(key)))throw fail('Unexpected WhatsApp fields.');return value}
export async function handleWhatsAppRequest(req,res,options){
  const url=new URL(req.url,'http://localhost'),path=url.pathname,method=req.method||'GET',prefix=WHATSAPP_PREFIX
  if(!path.startsWith(prefix+'/'))return false
  const send=(code,value)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(method==='HEAD'?undefined:JSON.stringify(value))}
  try{
    const read=['GET','HEAD'].includes(method),service=createWhatsAppService(options),fields=(path===prefix+'/photo'||path===prefix+'/business-profile')?['accountId','id']:path===prefix+'/chats'?['query','relationship']:path===prefix+'/messages'?['accountId','chatId','query','cursor']:[],seen=new Set()
    for(const[key]of url.searchParams){if(!fields.includes(key)||seen.has(key))throw fail('Unexpected WhatsApp query.');seen.add(key)}
    if(path===prefix+'/status'&&read)send(200,await service.status())
    else if(path===prefix+'/business-profile'&&read)send(200,{profile:await service.businessProfile(Object.fromEntries(url.searchParams))})
    else if(path===prefix+'/photo'&&read)send(200,await service.profilePhoto(Object.fromEntries(url.searchParams)))
    else if(path===prefix+'/pairing'&&read)send(200,await service.pairing())
    else if(path===prefix+'/chats'&&read)send(200,await service.chats(Object.fromEntries(url.searchParams)))
    else if(path===prefix+'/messages'&&read)send(200,await service.messages(Object.fromEntries(url.searchParams)))
    else if(path===prefix+'/connect'&&method==='POST'){await body(req,[]);send(202,await service.connect())}
    else if(path===prefix+'/pause'&&method==='POST'){await body(req,[]);send(200,await service.pause())}
    else if(path===prefix+'/connection'&&method==='DELETE')send(200,await service.disconnect())
    else if(path===prefix+'/account'&&method==='POST'){const value=await body(req,['accountId']);send(200,await service.selectAccount(value.accountId))}
    else if(path===prefix+'/chats'&&method==='PATCH')send(200,await service.updateChat(await body(req,['accountId','chatId','relationship','company','role','localName'])))
    else if(path===prefix+'/import'&&method==='POST')send(200,await service.importChat(await body(req,['title','content','dateOrder','timezoneOffset'],24*1024*1024)))
    else throw fail('WhatsApp endpoint not found.',404)
  }catch(error){send(Number.isInteger(error.status)?error.status:500,{error:Number.isInteger(error.status)?error.message:'WhatsApp request failed. Saved messages were preserved.'})}
  return true
}
