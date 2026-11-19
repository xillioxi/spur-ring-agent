import {createMemoryBank} from './service.mjs'
export const MEMORY_BANK_PREFIX='/api/creator-agent/memory-bank'
export const memoryBankReadToolRoute=(path,method)=>method==='GET'&&path===MEMORY_BANK_PREFIX+'/entries'
export async function handleMemoryBankRequest(req,res,options){
  const url=new URL(req.url,'http://localhost'),method=req.method||'GET'
  if(!url.pathname.startsWith(MEMORY_BANK_PREFIX+'/'))return false
  const send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(method==='HEAD'?undefined:JSON.stringify(value))}
  try{
    if(url.pathname!==MEMORY_BANK_PREFIX+'/entries')throw Object.assign(Error('Memory endpoint not found.'),{status:404})
    const seen=new Set();for(const[key]of url.searchParams){if(!['query','category','cursor','limit'].includes(key)||seen.has(key))throw Object.assign(Error('Unexpected memory query.'),{status:400});seen.add(key)}
    const service=createMemoryBank(options)
    if(['GET','HEAD'].includes(method))send(200,await service.list(Object.fromEntries(url.searchParams)))
    else if(method==='POST'){
      if(url.search)throw Object.assign(Error('Save a memory without query parameters.'),{status:400})
      if(!req.headers['content-type']?.startsWith('application/json'))throw Object.assign(Error('Use JSON.'),{status:415})
      let bytes=0;const parts=[];for await(const part of req){bytes+=part.length;if(bytes>32768)throw Object.assign(Error('Memory is too large.'),{status:413});parts.push(part)}
      let input;try{input=JSON.parse(Buffer.concat(parts).toString('utf8'))}catch{throw Object.assign(Error('Provide a memory object.'),{status:400})}
      send(200,await service.save(input))
    }else throw Object.assign(Error('Unsupported memory method.'),{status:405})
  }catch(error){send(error.status||500,{error:error.status&&error.status!==503?error.message:'Memory storage could not be read. Existing records were preserved.'})}
  return true
}
