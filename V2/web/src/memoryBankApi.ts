import {apiBase} from './taskApi'
export type MemoryCategory='about'|'people'|'projects'|'knowledge'
export type MemorySource={kind:string;label:string;accountId?:string;recordId?:string;chatId?:string;excerpt?:string;note?:string}
export type BankEntry={id:string;category:MemoryCategory;title:string;content:string;status:'observed'|'inferred'|'confirmed';updatedAt:string|null;sources:MemorySource[];version:number;messageCount?:number}
export type MemoryObservation={id:string;title:string;content:string;updatedAt:string|null;source:MemorySource}
export type MemoryBankData={entries:BankEntry[];counts:Record<string,number>;total:number;nextCursor:string|null;activity:MemoryObservation[];warnings:string[];coverage:{emailAccounts:number;whatsappAccounts:number;emailMessages:number;whatsappMessages:number};updatedAt:string}
export type MemoryDraft={id?:string;sourceId?:string;category:MemoryCategory;title:string;content:string;version:number}
async function request<T>(path:string,options:RequestInit={},signal?:AbortSignal):Promise<T>{
  const response=await fetch(apiBase()+'/api/creator-agent/memory-bank'+path,{...options,cache:'no-store',signal})
  const value=await response.json().catch(()=>null)
  if(!response.ok||!value)throw new Error(value?.error||'Could not open Memory. Check that the Spur backend is running.')
  return value
}
export const getMemoryBank=(query='',category='all',cursor='0',signal?:AbortSignal)=>request<MemoryBankData>('/entries?'+new URLSearchParams({query,category,cursor}),{},signal)
export const saveBankEntry=(draft:MemoryDraft,signal?:AbortSignal)=>request<{entry:BankEntry}>('/entries',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(draft)},signal)
