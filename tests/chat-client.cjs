const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const source=fs.readFileSync('spur/static/app.js','utf8');
const chatSource=source.slice(source.indexOf('function renderChat()'),source.indexOf('async function openModal('));
const elements=new Map();
function element(id){if(!elements.has(id))elements.set(id,{innerHTML:'',textContent:'',value:'',disabled:false,dataset:{},scrollHeight:500,scrollTop:0,clientHeight:400,listeners:{},addEventListener(type,fn){this.listeners[type]=fn;}});return elements.get(id);}
const data=new Map();let resolveLoad;
const context=vm.createContext({console,Map,Set,JSON,crypto:{randomUUID:()=> 'new-request-id'},
  sessionStorage:{getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)},
  $:element,escapeHtml:v=>String(v??'').replaceAll('<','&lt;').replaceAll('>','&gt;'),icon:()=>'',date:()=> 'Today',
  savePromptDraft:()=>{},toast:()=>{},
  api:async()=> new Promise(resolve=>{resolveLoad=resolve;})});
vm.runInContext("const state={activeAgentId:'title-lab',agents:[{id:'title-lab',name:'Title Lab'},{id:'script-writer',name:'Writer'}],worker:true,missions:[]};const agentChats=new Map(),chatLoads=new Map(),chatSending=new Set();let chatSignature='';"+chatSource+";this.test={state,agentChats,renderChat,refreshChat};",context);
const {state,agentChats,renderChat,refreshChat}=context.test;
const msg=(id,role,content,status='succeeded',metadata={})=>({id,role,content,status,metadata,created:1,job_id:'job-'+id});
(async()=>{
  renderChat();assert.match(element('#agent-chat').innerHTML,/Loading/);assert.equal(element('#prompt-submit').disabled,true);
  agentChats.set('title-lab',[msg(1,'user','<img src=x>'),msg(2,'assistant','A quiet Paris title')]);renderChat();
  assert.match(element('#agent-chat').innerHTML,/&lt;img/);assert.doesNotMatch(element('#agent-chat').innerHTML,/<img/);
  assert.equal(element('#prompt-submit').disabled,false);
  const load=refreshChat('title-lab');assert.equal(element('#agent-chat').innerHTML.includes('quiet Paris'),true);
  state.activeAgentId='script-writer';agentChats.set('script-writer',[]);renderChat();
  assert.match(element('#agent-chat').innerHTML,/Say hello to Writer/);assert.doesNotMatch(element('#agent-chat').innerHTML,/quiet Paris/);
  resolveLoad([msg(1,'user','Only title conversation')]);await load;
  assert.doesNotMatch(element('#agent-chat').innerHTML,/Only title/);
  agentChats.set('script-writer',[msg(3,'user','Write a script','queued')]);renderChat();assert.equal(element('#prompt-submit').disabled,true);
  assert.match(element('#agent-chat').innerHTML,/Queued for reply/);
  state.worker=false;renderChat();assert.match(element('#agent-chat').innerHTML,/Start the background worker/);
  agentChats.set('script-writer',[{...msg(3,'user','Write a script','failed'),error:'Model unavailable'}]);renderChat();assert.match(element('#agent-chat').innerHTML,/data-chat-retry/);
  state.missions=[{id:'mission-1',status:'completed',state:{report_id:'output-1'}}];
  agentChats.set('script-writer',[msg(3,'assistant','Draft created','succeeded',{mission_ids:['mission-1'],model:'deepseek-flash'})]);renderChat();
  assert.match(element('#agent-chat').innerHTML,/data-report="output-1"/);assert.match(element('#agent-chat').innerHTML,/deepseek-flash/);
  console.log('Chat client passed: isolation, delayed responses, escaping, loading, queued/offline/failed states and output links.');
})().catch(error=>{console.error(error);process.exitCode=1;});
