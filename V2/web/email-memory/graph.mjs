const text=(value,max=300)=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max):''
import {contactContext} from './relationships.mjs'
export const emailAddress=value=>typeof value==='string'&&value.length<=320&&/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(value)?value.toLowerCase():''
export const messageId=value=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,1024}$/.test(value)?value:''
export function normalizeParticipant(value){
  const email=emailAddress(typeof value==='string'?value:value?.email)
  return email?{email,...(text(value?.name)?{name:text(value.name)}:{})}:null
}
function participants(values){
  return [...new Map((Array.isArray(values)?values:[]).slice(0,500).map(normalizeParticipant).filter(Boolean).map(person=>[person.email,person])).values()]
}
export function normalizeMessage(value){
  const id=messageId(value?.id)
  if(!id)return null
  const timestamp=Date.parse(value.date)
  return {id,threadId:messageId(value.threadId)||id,from:normalizeParticipant(value.from),to:participants(value.to),cc:participants(value.cc),subject:text(value.subject,1000)||'(No subject)',date:Number.isFinite(timestamp)?new Date(timestamp).toISOString():null,snippet:text(value.snippet,1000),labels:(Array.isArray(value.labels)?value.labels:[]).slice(0,100).map(value=>text(value,100)).filter(Boolean),...(text(value.internetMessageId,500)?{internetMessageId:text(value.internetMessageId,500)}:{})}
}
export function messageParticipants(message){return [...new Map([message.from,...message.to,...message.cc].filter(Boolean).map(person=>[person.email,person])).values()]}
export const isDraftMessage=message=>(message.labels||[]).some(label=>/^(?:DRAFT|\\DRAFTS?|\[GMAIL\]\/DRAFTS)$/i.test(label))
export function countEmailPeople(messages,mailboxEmail){const self=emailAddress(mailboxEmail),people=new Set();for(const message of messages){if(isDraftMessage(message))continue;for(const person of messageParticipants(message))if(person.email!==self)people.add(person.email)}return people.size}

/** An edge means actual sender→recipient evidence, never inferred friendship. */
export function buildEmailGraph(messages,mailboxEmail,{query='',limit=300,profiles={},relationship='auto'}={}){
  const self=emailAddress(mailboxEmail),people=new Map()
  const communication=messages.filter(message=>!isDraftMessage(message))
  if(self)people.set(self,{id:self,email:self,label:'You',kind:'self',messageCount:0})
  for(const message of communication){
    for(const person of messageParticipants(message)){
      let node=people.get(person.email)
      if(!node){node={id:person.email,email:person.email,label:person.name||person.email,kind:person.email===self?'self':'person',messageCount:0};people.set(person.email,node)}
      if(node.kind!=='self'&&person.name&&node.label===node.email)node.label=person.name
      node.messageCount++
      if(message.date&&(!node.lastContactAt||message.date>node.lastContactAt))node.lastContactAt=message.date
    }
  }
  const authored=new Map()
  for(const message of communication){if(!message.from)continue;const email=message.from.email;if(!authored.has(email))authored.set(email,[]);authored.get(email).push(message)}
  const needle=query.trim().toLocaleLowerCase(),all=[...people.values()].filter(node=>node.kind!=='self')
  for(const node of all)Object.assign(node,contactContext(node,self,authored.get(node.email)||[],Object.hasOwn(profiles,node.email)?profiles[node.email]:null))
  const searched=all.filter(node=>!needle||`${node.label} ${node.email} ${node.company} ${node.role} ${node.relationshipLabel}`.toLocaleLowerCase().includes(needle))
  const relationshipCounts={auto:searched.length}
  for(const node of searched)relationshipCounts[node.relationship]=(relationshipCounts[node.relationship]||0)+1
  const matched=searched.filter(node=>relationship==='auto'||node.relationship===relationship).sort((a,b)=>b.messageCount-a.messageCount||(b.lastContactAt||'').localeCompare(a.lastContactAt||'')||a.email.localeCompare(b.email))
  const selected=matched.slice(0,Math.max(1,Math.min(300,limit))-(self?1:0)),nodes=[...(self?[people.get(self)]:[]),...selected],ids=new Set(nodes.map(node=>node.id))
  // Count only visible relationships, so bulk mailing lists cannot make an
  // unbounded edge map before the rendering limit is applied.
  const edges=new Map()
  for(const message of communication){
    const source=message.from?.email
    if(!source||!ids.has(source))continue
    for(const target of new Set([...message.to,...message.cc].map(person=>person.email))){
      if(source===target||!ids.has(target))continue
      const id=JSON.stringify([source,target])
      let edge=edges.get(id)
      if(!edge){edge={id,source,target,weight:0,messageIds:[]};edges.set(id,edge)}
      edge.weight++;if(edge.messageIds.length<20)edge.messageIds.push(message.id)
      if(message.date&&(!edge.lastContactAt||message.date>edge.lastContactAt))edge.lastContactAt=message.date
    }
  }
  const visibleEdges=[...edges.values()].sort((a,b)=>b.weight-a.weight).slice(0,3000)
  return {nodes,edges:visibleEdges,relationshipCounts,totalPeople:all.length,totalMessages:messages.length,communicationMessageCount:communication.length,excludedDraftCount:messages.length-communication.length,visiblePeople:selected.length,matchedPeople:matched.length,truncated:matched.length>selected.length,edgesTruncated:edges.size>visibleEdges.length,totalVisibleRelationships:edges.size,mailboxEmail:self||null,scope:'All Mail (excludes Spam and Trash)',relationshipMeaning:'An arrow records sender-to-recipient email activity. Unsent drafts do not establish communication, friendship or personal closeness.'}
}
