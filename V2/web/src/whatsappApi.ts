import {apiBase} from './taskApi'
export type WhatsAppStatus = {state:string;accountId:string|null;linkedAccountId?:string;sources:string[];messageCount:number;chatCount:number;message?:string;historyReceived:boolean;limited:boolean;updatedAt?:string;sessionStorage:string;historyCoverage:string}
export type WhatsAppChat = {id:string;name:string;kind:string;localName?:string;relationship:string;company:string;role:string;messageCount?:number;lastMessageAt?:number;preview?:string}
export type WhatsAppMessage = {id:string;chatId:string;senderId:string;senderName:string;fromMe:boolean;text:string;timestamp:number}
export type WhatsAppMessages = {accountId:string;chatId:string;messages:WhatsAppMessage[];total:number;hasMore:boolean;nextCursor:string}
export async function whatsappRequest<T>(path:string,method='GET',body?:unknown,signal?:AbortSignal):Promise<T>{
  const response=await fetch(apiBase()+'/api/creator-agent/whatsapp-memory'+path,{method,cache:'no-store',signal,headers:body===undefined?{}:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})})
  const value=await response.json().catch(()=>null)
  if(!response.ok||!value)throw new Error(value?.error||'Could not reach WhatsApp Memory. Check that the local Spur server is running.')
  return value
}
