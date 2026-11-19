import {join,resolve} from 'node:path'
import {randomUUID} from 'node:crypto'
import {privateStore} from '../whatsapp/private-store.mjs'
import {createEmailMemoryService} from '../email-memory/service.mjs'
import {createWhatsAppService} from '../whatsapp/service.mjs'
import {callBusiness} from '../business-client.mjs'
import {projectEmail,projectWhatsApp,projectProjects} from './projections.mjs'
const instances=new Map(),categories=['about','people','projects','knowledge']
const fail=(message,status=400)=>Object.assign(new Error(message),{status})
const clean=(value,max)=>typeof value==='string'?value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').trim().slice(0,max):''
export function createMemoryBank({root,config={},actor='user',emailReader,whatsappReader,projectReader}={}){
  root=resolve(root);const key=root+':'+actor;if(instances.has(key)&&!emailReader&&!whatsappReader&&!projectReader)return instances.get(key)
  const files=privateStore(join(root,'memory-bank'))
  const readers=[emailReader||(()=>createEmailMemoryService({root:join(root,'email-memory'),config}).memorySnapshot()),whatsappReader||(()=>createWhatsAppService({root:join(root,'whatsapp-memory')}).memorySnapshot()),projectReader||(()=>callBusiness(root,'list',{kind:'projects'},actor))]
  let serial=Promise.resolve(),cache=null,expires=0,pending=null
  const exclusive=work=>{const result=serial.then(work,work);serial=result.catch(()=>{});return result}
  async function saved(){const value=await files.read('memories.json');if(value&&(value.schemaVersion!==1||!Array.isArray(value.entries)))throw fail('Saved memories could not be read. Existing data was preserved.',503);return value?.entries||[]}
  async function observed(){
    if(cache&&Date.now()<expires)return cache
    if(pending)return pending
    pending=(async()=>{
      const results=await Promise.allSettled(readers.map(read=>Promise.resolve().then(read))),warnings=[]
      const value=(index,empty)=>{const result=results[index];if(result.status==='fulfilled')return result.value;warnings.push(`${['Email','WhatsApp','Projects'][index]} memory is temporarily unavailable. Other saved memories are still available.`);return empty}
      const email=projectEmail(value(0,{accounts:[]})),whatsapp=projectWhatsApp(value(1,{accounts:[]})),projects=projectProjects(value(2,[]))
      const identities=[...email.identities,...whatsapp.identities]
      const entries=[...email.entries,...whatsapp.entries,...projects,...(identities.length?[{id:'observed:identities',category:'about',title:'Your account identities',content:identities.join('\n'),status:'observed',updatedAt:null,sources:[{kind:'accounts',label:'Saved email and WhatsApp accounts'}]}]:[])]
      cache={entries,activity:[...email.activity,...whatsapp.activity].sort((a,b)=>(b.updatedAt||'').localeCompare(a.updatedAt||'')).slice(0,30),coverage:{emailAccounts:email.accountCount,whatsappAccounts:whatsapp.accountCount,emailMessages:email.messageCount,whatsappMessages:whatsapp.messageCount},warnings};expires=Date.now()+10000;return cache
    })().finally(()=>{pending=null})
    return pending
  }
  async function all(){const [source,notes]=await Promise.all([observed(),saved()]);const entries=new Map(source.entries.map(entry=>[entry.id,{...entry,version:0}]));for(const entry of notes)entries.set(entry.id,entry);return {...source,entries:[...entries.values()]}}
  const service={
    async list({query='',category='all',cursor='0',limit='40'}={}){
      if(typeof query!=='string'||query.length>300||!['all',...categories].includes(category)||!/^\d{1,7}$/.test(cursor)||!/^\d{1,3}$/.test(String(limit))||Number(limit)<1||Number(limit)>100)throw fail('Use a valid memory search and page.')
      const value=await all(),needle=query.trim().toLowerCase(),searched=value.entries.filter(entry=>!needle||`${entry.title} ${entry.content} ${entry.sources.map(source=>source.label).join(' ')}`.toLowerCase().includes(needle)),counts={all:searched.length,...Object.fromEntries(categories.map(category=>[category,searched.filter(entry=>entry.category===category).length]))}
      const matches=searched.filter(entry=>category==='all'||entry.category===category).sort((a,b)=>(b.updatedAt||'').localeCompare(a.updatedAt||'')||a.title.localeCompare(b.title)),offset=Number(cursor),end=offset+Number(limit)
      return {...value,entries:matches.slice(offset,end),counts,total:matches.length,nextCursor:end<matches.length?String(end):null,updatedAt:new Date().toISOString()}
    },
    save(input){return exclusive(async()=>{
      const allowed=['id','sourceId','category','title','content','version'];if(!input||Array.isArray(input)||Object.keys(input).some(key=>!allowed.includes(key))||!categories.includes(input.category)||typeof input.title!=='string'||!input.title.trim()||input.title.length>180||typeof input.content!=='string'||!input.content.trim()||input.content.length>6000||!Number.isSafeInteger(input.version)||input.version<0||input.id!==undefined&&(typeof input.id!=='string'||input.id.length>100)||input.sourceId!==undefined&&(typeof input.sourceId!=='string'||input.sourceId.length>100))throw fail('Provide a title, memory text, category and current version.')
      const notes=await saved(),observations=await all(),previous=input.id?observations.entries.find(entry=>entry.id===input.id):null,source=input.sourceId?observations.activity.find(item=>item.id===input.sourceId):null
      if(input.sourceId&&!source)throw fail('That source is no longer in recent observations. Refresh and select it again.',404)
      if(input.id&&!previous)throw fail('Memory not found. Refresh the bank.',404)
      if((previous?.version||0)!==input.version)throw fail('This memory changed. Refresh before saving your correction.',409)
      if(!previous&&notes.length>=5000)throw fail('The bank reached its 5,000 saved-memory limit.',507)
      const entry={id:previous?.id||'note:'+randomUUID(),category:input.category,title:clean(input.title,180),content:clean(input.content,6000),status:'confirmed',updatedAt:new Date().toISOString(),sources:previous?.sources||(source?[source.source]:[{kind:'manual',label:'Saved by you'}]),version:input.version+1}
      const next=notes.filter(note=>note.id!==entry.id);next.push(entry)
      if(Buffer.byteLength(JSON.stringify(next))>5*1024*1024)throw fail('Saved memory storage reached its 5 MiB limit.',507)
      await files.write('memories.json',{schemaVersion:1,entries:next});return {entry}
    })},
  }
  if(!emailReader&&!whatsappReader&&!projectReader)instances.set(key,service)
  return service
}
