const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const nodes=new Map(),events={},calls=[],storage=new Map();let destination='',confirm=false;
const element=key=>{if(!nodes.has(key))nodes.set(key,{value:key==='#social-days'?'28':'',textContent:'',innerHTML:'',disabled:false,hidden:false,required:false,listeners:{},classList:{toggle(){},remove(){}},addEventListener(type,fn){this.listeners[type]=fn;},showModal(){this.open=true;},close(){this.open=false;},focus(){}});return nodes.get(key);};
const connection={platform:'youtube',configured:false,can_manage:true,client_id:'',callback_url:'http://localhost:8000/social/youtube/callback',api_version:'v24.0',has_client_secret:false,status:'disconnected',accounts:[]};
let snapshot=null;
const api=async(path,method='GET',body)=>{
  calls.push({path,method,body});
  if(path==='/social/connections')return {connections:[{...connection},{...connection,platform:'instagram'}],notice:null};
  if(path.includes('/analytics'))return {snapshot:path.includes('youtube')?snapshot:null};
  if(path==='/social/youtube/app'){connection.configured=true;connection.client_id=body.client_id;connection.has_client_secret=true;return {};}
  if(path.endsWith('/connect'))return {authorization_url:'https://accounts.google.com/o/oauth2/v2/auth?state=test'};
  if(path.endsWith('/sync'))return {job_id:'sync-job'};
  if(path==='/settings/provider')return {model:'test-model'};
  if(path==='/agents/coordinator/chat')return {job_id:'analysis-reply'};
  if(path.endsWith('/brief'))return {knowledge_id:'analytics-note',brief:{snapshot_id:'snapshot-123',period:{start:'2026-10-01',end:'2026-10-28'}}};
  if(method==='DELETE')return {};
  throw new Error('Unexpected request '+path);
};
const context=vm.createContext({document:{querySelector:element,addEventListener:(type,fn)=>events[type]=fn},spurAuth:{ready:Promise.resolve(),request:api},URL,Date,Number,sessionStorage:{setItem:(k,v)=>storage.set(k,v),getItem:k=>storage.get(k)},location:{assign:url=>destination=url,hash:'#connections'},setTimeout,confirm:()=>confirm});context.window=context;
vm.runInContext(fs.readFileSync('spur/static/social.js','utf8'),context);
const click=async dataset=>events.click({target:{closest:()=>({dataset,disabled:false})}});
(async()=>{
  await context.spurSocial.load();assert.match(element('#social-cards').innerHTML,/administrator is finishing/);assert.doesNotMatch(element('#social-cards').innerHTML,/data-social-setup/);assert.match(element('#social-analytics').innerHTML,/performance data/);
  await click({socialSetup:'youtube'});assert.equal(element('#social-setup-dialog').open,true);assert.equal(destination,'');assert.equal(element('#social-callback').value,connection.callback_url);
  element('#social-client-id').value='google-client';element('#social-client-secret').value='private-secret';element('#social-api-version').value='v24.0';
  await element('#social-setup-form').listeners.submit({preventDefault(){}});assert.equal(element('#social-client-secret').value,'');assert.equal(connection.configured,true);
  await click({socialConnect:'youtube'});assert.match(destination,/^https:\/\/accounts.google.com/);
  await click({socialSync:'youtube'});assert.equal(calls.find(c=>c.path.endsWith('/sync')).body.days,28);
  snapshot={account_name:'My channel',period:{start:'2026-10-01',end:'2026-10-28'},totals:{views:100,likes:0},previous:{views:50},series:[{day:'2026-10-01',views:0},{day:'2026-10-02',views:100}],content:[{title:'<img onerror=alert(1)>',url:'javascript:alert(1)',metrics:{views:100,likes:0,comments:0}}],limitations:['Sample data fixture only'],synced_at:1};
  await context.spurSocial.load(true);const html=element('#social-analytics').innerHTML;
  assert.match(html,/100.0% vs previous/);assert.match(html,/Unavailable/);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/href="javascript:/);
  await click({socialBrief:'youtube'});await new Promise(resolve=>setTimeout(resolve,5));assert.equal(context.location.hash,'agent/coordinator/overview');assert.match(calls.find(c=>c.path==='/agents/coordinator/chat').body.content,/saved YouTube analytics/);assert.equal(calls.find(c=>c.path==='/agents/coordinator/chat').body.request_id,'analytics:snapshot-123');
  const before=calls.filter(c=>c.method==='DELETE').length;await click({socialDisconnect:'youtube'});assert.equal(calls.filter(c=>c.method==='DELETE').length,before);
  const tt=context.spurSocial.card({...connection,platform:'tiktok',connect_ready:false,setup_issue:'Public HTTPS callback required'});
  assert.match(tt,/HTTPS/);assert.match(tt,/brand-tiktok.svg/);assert.match(tt,/data-social-connect="tiktok" disabled/);
  const lifetime=context.spurSocial.analytics('tiktok',{...snapshot,totals:{views:50},series:[]});assert.match(lifetime,/not views or engagement earned during that period/);assert.match(lifetime,/Video views · lifetime/);
  const page=context.spurSocial.analytics('linkedin',{...snapshot,content:[],totals:{impressions:50,clicks:2},series:[{day:'2026-10-01',impressions:50}]});assert.match(page,/Organic impressions/);assert.match(page,/Daily organic impressions/);assert.match(page,/Per-post rankings are not fetched/);assert.doesNotMatch(page,/Daily views/);
  console.log('Social UI passed: setup, OAuth redirect, sync, missing values, comparison, escaped content, analytics handoff and safe disconnect cancellation.');
})().catch(error=>{console.error(error);process.exitCode=1;});
