import { apiRequest } from './taskApi'

export type RecordKind = 'clients' | 'leads' | 'projects' | 'tasks' | 'finances' | 'events' | 'services' | 'portfolio' | 'proposals' | 'deliverables' | 'opportunities'
export type BusinessRecord = { id: string; kind: RecordKind; version: number; archived: boolean; created?: number; updated?: number; [key: string]: unknown }
export type BusinessModule = { id: string; name: string; description: string; enabled: boolean; available: boolean; permanent?: boolean; order: number; route?: string; settings?: Record<string, unknown>; permissions: { ai_read: boolean; ai_write: boolean } }
export type BusinessSettings = { currency: string; timezone: string; profession: string; ai_enabled: boolean; sidebar_collapsed: boolean; version?: number }
export type BusinessConfiguration = { modules: BusinessModule[]; settings: BusinessSettings; version: number }
export type BusinessAction = { id: string; kind: RecordKind; record_id: string; title: string; due_date: string; severity: string; module: string }
export type CurrencyTotal = { currency: string; revenue: string; expenses: string; net: string; outstanding: string; pipeline: string; pending_expenses?: string; record_ids: Record<string, string[]> }
export type MonthlyTotal = { month: string; currency: string; revenue: string; expenses: string; net: string; record_ids: string[] }
export type Breakdown = { id: string; name: string; currency: string; revenue: string; record_ids: string[] }
export type BusinessDashboard = { counts: Record<string, number>; totals_by_currency: CurrencyTotal[]; monthly: MonthlyTotal[]; breakdowns: Record<string, Breakdown[]>; project_status: Record<string, number>; lead_status: Record<string, number>; action_center: BusinessAction[]; records: Partial<Record<RecordKind, BusinessRecord[]>> }
export type CalendarEntry = { id: string; kind: RecordKind; record_id: string; title: string; start: string; end: string; all_day: boolean; project_id?: string; client_id?: string }
export type ActivityEntry = { id: number; kind: string; record_id: string; action: string; actor: string; created: number }
export type Field = { key: string; label: string; type?: 'text' | 'email' | 'tel' | 'url' | 'date' | 'datetime-local' | 'decimal' | 'currency' | 'textarea' | 'tags' | 'select' | 'relation'; required?: boolean; options?: string[]; relation?: RecordKind }

const f = (key: string, label: string, type: Field['type'] = 'text', required = false): Field => ({key,label,type,required})
const choice = (key: string, label: string, options: string[]): Field => ({key,label,type:'select',options})
const link = (key: string, label: string, relation: RecordKind): Field => ({key,label,type:'relation',relation})
const notes = f('notes','Notes','textarea')
const currency = f('currency','Currency','currency',true)
const client = link('client_id','Client','clients')
const project = link('project_id','Project','projects')
const due = f('due_date','Due date','date')
const description = f('description','Description','textarea')
export const entities: Record<RecordKind, { singular: string; fields: Field[] }> = {
  clients: {singular:'client',fields:[f('name','Name','text',true),f('company','Company'),f('email','Email','email'),f('phone','Phone','tel'),choice('status','Relationship',['active','inactive']),f('acquisition_source','How you met'),f('follow_up_date','Next follow-up','date'),f('tags','Tags','tags'),notes]},
  leads: {singular:'lead',fields:[f('name','Name','text',true),f('company','Company'),f('email','Email','email'),f('phone','Phone','tel'),choice('status','Stage',['new','contacted','qualified','proposal','won','lost']),f('acquisition_source','Lead source'),f('estimated_value','Estimated value','decimal'),currency,f('follow_up_date','Next follow-up','date'),f('requirements','Requirements','textarea'),f('lost_reason','Reason lost'),notes]},
  projects: {singular:'project',fields:[f('name','Project name','text',true),client,choice('status','Status',['planned','active','on_hold','completed','cancelled']),due,f('budget','Budget','decimal'),currency,f('hours','Hours worked','decimal'),f('service_category','Service category'),description,f('scope','Scope','textarea'),notes]},
  tasks: {singular:'task',fields:[f('title','Task','text',true),project,client,choice('status','Status',['todo','in_progress','done']),due,f('estimated_hours','Estimated hours','decimal'),f('hours','Hours worked','decimal'),notes]},
  finances: {singular:'financial entry',fields:[f('title','Entry title','text',true),choice('type','Entry type',['income','expense']),choice('status','Payment status',['pending','paid','cancelled']),f('amount','Amount','decimal',true),currency,f('date','Record date','date',true),due,client,project,f('category','Category'),f('invoice_number','Invoice reference'),notes]},
  events: {singular:'workspace event',fields:[f('title','Event title','text',true),f('start','Starts · device timezone','datetime-local',true),f('end','Ends · device timezone','datetime-local',true),client,project,notes]},
  services: {singular:'service',fields:[f('name','Service name','text',true),f('category','Category'),f('price','Starting price','decimal'),currency,choice('status','Status',['active','inactive']),description,notes]},
  portfolio: {singular:'portfolio item',fields:[f('title','Title','text',true),project,client,choice('status','Status',['draft','featured','published']),f('url','Work link (HTTPS)','url'),description,notes]},
  proposals: {singular:'proposal',fields:[f('title','Proposal title','text',true),client,link('lead_id','Lead','leads'),project,choice('status','Recorded status',['draft','sent','accepted','rejected']),f('budget','Proposed budget','decimal'),currency,due,f('scope','Scope','textarea'),f('deliverables','Deliverables','textarea'),notes]},
  deliverables: {singular:'deliverable',fields:[f('title','Deliverable title','text',true),project,client,choice('status','Recorded status',['draft','review','changes_requested','approved','delivered']),due,f('url','Delivery link (HTTPS)','url'),description,f('feedback','Review feedback','textarea'),notes]},
  opportunities: {singular:'opportunity',fields:[f('title','Opportunity title','text',true),choice('status','Status',['saved','applied','won','closed']),f('source','Source'),f('url','Opportunity link (HTTPS)','url'),f('budget','Estimated budget','decimal'),currency,due,f('location','Location'),client,project,description,notes]},
}
export const businessPages: Record<string,[string,string]> = {
  overview:['Overview','Your clients, projects, and earnings, connected in one workspace.'],
  'action-center':['Action Center','Follow-ups, deadlines, and payments that need your attention.'],
  clients:['Clients','Keep relationships, projects, and next steps together.'], leads:['Leads','From a first conversation to your next client.'],
  projects:['Projects','Plan the work, track the tasks, and keep your deadlines in view.'], finances:['Finances','Track recorded income and expenses, one currency at a time.'],
  calendar:['Business calendar','Workspace events, project deadlines, and client follow-ups.'],analytics:['Business analytics','Understand the work and relationships behind your revenue.'],
  portfolio:['Portfolio & Services','Keep your offer and selected work ready for the next conversation.'],proposals:['Proposals & Contracts','Save scope, pricing, and manually recorded decisions.'],delivery:['Collaboration & Delivery','Keep private delivery links, feedback, and review status together.'],opportunities:['Opportunities','Save possibilities and track your next step.'],
  modules:['Modules','Choose the tools that fit your work and control assistant access.'],settings:['Business settings','Your preferences, connections, and data.'],
}
export const moduleForKind: Record<RecordKind,string> = {clients:'clients',leads:'leads',projects:'projects',tasks:'projects',finances:'finances',events:'calendar',services:'portfolio',portfolio:'portfolio',proposals:'proposals',deliverables:'delivery',opportunities:'opportunities'}
export const kindForPage: Record<string,RecordKind> = {clients:'clients',leads:'leads',projects:'projects',finances:'finances',portfolio:'services',proposals:'proposals',delivery:'deliverables',opportunities:'opportunities'}
export const permanentModules = ['overview','action-center','modules','settings']
export const text = (value: unknown) => value == null ? '' : String(value)
export const titleOf = (row: BusinessRecord) => text(row.name || row.title || 'Untitled')
export const human = (value: unknown) => text(value).replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase())
export const localDate = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`
export function displayDate(value: unknown) {
  if(!value)return '—'
  const raw=text(value),d=new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw)?raw+'T12:00:00':raw)
  return Number.isNaN(d.valueOf())?raw:d.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'})
}
export function displayMoney(value: unknown, code='USD') {
  // Intl accepts a decimal string without losing its precision to a Number conversion.
  try{const format=new Intl.NumberFormat(undefined,{style:'currency',currency:code,maximumFractionDigits:6}).format as unknown as (value:string)=>string;return format(text(value || 0))}
  catch{return `${code} ${text(value || 0)}`}
}
export function localDateTime(value: unknown) {
  if(!value)return ''
  const d=new Date(text(value));if(Number.isNaN(d.valueOf()))return ''
  return `${localDate(d)}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
}
export function calendarDay(row: CalendarEntry,end=false) {return row.all_day?(end?row.end:row.start).slice(0,10):localDate(new Date(end?row.end:row.start))}
export function safeUrl(value: unknown) {try{const u=new URL(text(value));return u.protocol==='https:' && !u.username && !u.password?u.href:undefined}catch{return undefined}}
export function businessPageFromHash(hash: string) {const page=hash.match(/^#business\/([a-z-]+)$/)?.[1];return page && businessPages[page]?page:null}
export function recordPayload(kind: RecordKind, form: FormData) {
  const data: Record<string,unknown>={}
  for(const field of entities[kind].fields){
    let value: unknown=text(form.get(field.key)).trim()
    if(field.type==='tags')value=text(value).split(',').map(v=>v.trim()).filter(Boolean)
    if(field.type==='currency')value=text(value).toUpperCase()
    if(field.type==='datetime-local' && value)value=new Date(text(value)).toISOString()
    data[field.key]=value
  }
  if(kind==='events'){
    if(text(data.end)<=text(data.start))throw new Error('The end time must be after the start time.')
    data.timezone=Intl.DateTimeFormat().resolvedOptions().timeZone
  }
  return data
}
export function drillRecords(dashboard: BusinessDashboard,key:string,currency:string): {kind:RecordKind;rows:BusinessRecord[]} {
  if(key==='projects')return {kind:'projects',rows:(dashboard.records.projects || []).filter(row=>row.status==='active')}
  if(key==='leads')return {kind:'leads',rows:(dashboard.records.leads || []).filter(row=>!['won','lost'].includes(text(row.status)))}
  const total=dashboard.totals_by_currency.find(row=>row.currency===currency),kind=key==='pipeline'?'leads':'finances'
  const ids=new Set(key==='net'?[...(total?.record_ids.revenue || []),...(total?.record_ids.expenses || [])]:total?.record_ids[key] || [])
  return {kind,rows:(dashboard.records[kind] || []).filter(row=>ids.has(row.id))}
}
export const businessPrefix='/api/creator-agent/business'
export async function businessRequest<T>(path:string,method='GET',body?:unknown):Promise<T> {
  const {data}=await apiRequest(businessPrefix+path,{method,...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})})
  return data as T
}
export async function listRecords(kind:RecordKind,query='',archived=false,request=businessRequest) {
  const rows:BusinessRecord[]=[];let offset:number|null=0
  do {
    const params:URLSearchParams=new URLSearchParams({query,archived:String(archived),limit:'500',offset:String(offset)})
    const page:{items:BusinessRecord[];next_offset?:number|null}|BusinessRecord[]=await request<{items:BusinessRecord[];next_offset?:number|null}|BusinessRecord[]>(`/records/${kind}?${params}`)
    rows.push(...(Array.isArray(page)?page:page.items));offset=Array.isArray(page)?null:page.next_offset ?? null
  }while(offset!==null)
  return rows
}
