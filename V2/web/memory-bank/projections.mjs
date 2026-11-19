import {createHash} from 'node:crypto'
import {messageParticipants,isDraftMessage} from '../email-memory/graph.mjs'
import {contactContext} from '../email-memory/relationships.mjs'
export const idFor=(...parts)=>createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0,32)
const stamp=value=>{const time=typeof value==='number'?value*1000:Date.parse(value);return Number.isFinite(time)?new Date(time).toISOString():null}
export function projectEmail(snapshot){
  const entries=new Map(),activity=[],identities=[]
  let messageCount=0
  for(const account of snapshot.accounts||[]){
    identities.push(account.email);messageCount+=account.messages.length
    const people=new Map(),authored=new Map()
    for(const message of account.messages){
      if(isDraftMessage(message))continue
      if(message.from){const list=authored.get(message.from.email)||[];list.push(message);authored.set(message.from.email,list)}
      for(const person of messageParticipants(message)){
        if(person.email===account.email)continue
        const current=people.get(person.email)||{email:person.email,label:person.name||person.email,messageCount:0,lastContactAt:null}
        current.messageCount++;if(person.name)current.label=person.name
        if(message.date&&(!current.lastContactAt||message.date>current.lastContactAt)){current.lastContactAt=message.date;current.message=message}
        people.set(person.email,current)
      }
    }
    for(const person of people.values()){
      const context=contactContext(person,account.email,authored.get(person.email)||[],account.profiles?.[person.email])
      const source={kind:'email',accountId:account.accountId,label:account.email,recordId:person.message?.id||'',excerpt:person.message?.snippet||'',note:context.evidence.map(item=>item.reason).join('; ')}
      const id='email:'+idFor(person.email),old=entries.get(id)
      const content=[person.email,context.relationshipLabel,context.company&&`Organization: ${context.company}`,context.role&&`Responsible for: ${context.role}`].filter(Boolean).join(' · ')
      entries.set(id,{id,category:'people',title:old?.title!==person.email&&old?.title||person.label,content:old?(old.content.split('\n').includes(content)?old.content:old.content+'\n'+content):content,status:context.contextSource==='confirmed'&&(!old||old.status==='confirmed')?'confirmed':context.contextSource==='suggested'||old?.status==='inferred'?'inferred':'observed',updatedAt:[old?.updatedAt,person.lastContactAt].filter(Boolean).sort().at(-1)||null,sources:[...(old?.sources||[]),source],messageCount:(old?.messageCount||0)+person.messageCount})
    }
    for(const message of account.messages.filter(item=>!isDraftMessage(item)).sort((a,b)=>(b.date||'').localeCompare(a.date||'')).slice(0,15))activity.push({id:'email-event:'+idFor(account.accountId,message.id),title:message.subject,content:message.snippet||'',updatedAt:message.date,source:{kind:'email',accountId:account.accountId,label:account.email,recordId:message.id,excerpt:message.snippet||''}})
  }
  return {entries:[...entries.values()],activity,identities,messageCount,accountCount:(snapshot.accounts||[]).length}
}
export function projectWhatsApp(snapshot){
  const entries=[],activity=[],identities=[];let messageCount=0
  for(const account of snapshot.accounts||[]){
    identities.push(account.accountId==='imported'?'Imported WhatsApp chats':account.accountId.split('@')[0]);messageCount+=account.messageCount||0
    for(const chat of account.chats||[]){
      const confirmed=!!(chat.role||chat.company||chat.relationship&&chat.relationship!=='other')
      const source={kind:'whatsapp',accountId:account.accountId,label:account.accountId==='imported'?'WhatsApp import':`WhatsApp · ${account.accountId.split('@')[0]}`,recordId:chat.messageId||'',chatId:chat.id,excerpt:chat.preview||''}
      entries.push({id:'whatsapp:'+idFor(account.accountId,chat.id),category:'people',title:chat.name,content:[chat.id.endsWith('@g.us')?'Group conversation':'WhatsApp contact',chat.relationship&&chat.relationship!=='other'&&`Relationship: ${chat.relationship}`,chat.company&&`Organization: ${chat.company}`,chat.role&&`Responsible for: ${chat.role}`].filter(Boolean).join(' · '),status:confirmed?'confirmed':'observed',updatedAt:stamp(chat.lastMessageAt),sources:[source],messageCount:chat.messageCount||0})
      if(chat.preview)activity.push({id:'wa-event:'+idFor(account.accountId,chat.id,chat.messageId),title:chat.name,content:chat.preview,updatedAt:stamp(chat.lastMessageAt),source})
    }
  }
  return {entries,activity:activity.sort((a,b)=>(b.updatedAt||'').localeCompare(a.updatedAt||'')).slice(0,30),identities,messageCount,accountCount:(snapshot.accounts||[]).length}
}
export function projectProjects(records){return records.filter(row=>!row.archived).map(row=>({id:'project:'+idFor(row.id),category:'projects',title:row.name||row.title||'Untitled project',content:[row.description,row.status&&`Status: ${row.status}`,row.notes].filter(Boolean).join('\n').slice(0,4000),status:'observed',updatedAt:stamp(row.updated),sources:[{kind:'business',label:'Business projects',recordId:row.id}]}))}
