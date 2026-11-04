const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const source=fs.readFileSync('spur/static/onboarding.js','utf8');
const nodes=new Map(),storage=new Map(),requests=[];let brief={},settingsOpened=false;
function element(key){if(!nodes.has(key))nodes.set(key,{innerHTML:'',textContent:'',hidden:true,disabled:false,value:'',listeners:{},addEventListener(type,callback){this.listeners[type]=callback;},focus(){},close(){}});return nodes.get(key);}
const auth={user:{id:'new-user',display_name:'New Creator'},onboarding:{completed:false},ready:Promise.resolve(),request:async(path,method='GET',body)=>{
  requests.push({path,method,body});
  if(path==='/creator-brief'){if(method==='PUT')brief=body;return brief;}
  if(path==='/settings/provider')return {provider:'ollama',model:''};
  if(path==='/auth/onboarding/complete')return null;
  throw new Error('Unexpected API call: '+path);
}};
const context=vm.createContext({document:{querySelector:element,querySelectorAll:()=>[element('walkthrough-reopen')]},sessionStorage:{setItem:(k,v)=>storage.set(k,v)},location:{hash:'#welcome'},setTimeout,spurAuth:auth,openModal:mode=>{settingsOpened=mode==='settings';}});context.window=context;
const settle=()=>new Promise(resolve=>setImmediate(resolve));
(async()=>{
  vm.runInContext(source,context);await settle();
  assert.equal(element('#welcome-screen').hidden,false);assert.equal(element('.app-shell').inert,true);
  assert.match(element('#welcome-content').innerHTML,/New Creator/);assert.match(element('#welcome-content').innerHTML,/private workspace/);
  await element('#welcome-next').listeners.click();
  element('#welcome-channel').value='Paris Pocket';element('#welcome-niche').value='Paris travel';element('#welcome-audience').value='First-time visitors';
  await element('#welcome-next').listeners.click();await settle();assert.equal(brief.channel_name,'Paris Pocket');
  element('#welcome-connect').listeners.click();assert.equal(settingsOpened,true);
  await element('#welcome-next').listeners.click();assert.match(element('#welcome-content').innerHTML,/One brief/);
  await element('#welcome-next').listeners.click();assert.match(element('#welcome-content').innerHTML,/Nothing is sent automatically/);
  await element('#welcome-next').listeners.click();await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(element('#welcome-screen').hidden,true);assert.equal(element('.app-shell').inert,false);
  assert.equal(context.location.hash,'agent/coordinator/overview');assert.match(storage.get('spur_prompt_draft_coordinator'),/Paris travel/);
  assert.equal(auth.onboarding.completed,true);assert.equal(requests.filter(r=>r.path==='/auth/onboarding/complete').length,1);
  assert.equal(requests.some(r=>r.path.includes('/chat') || r.path==='/missions'),false);
  await element('walkthrough-reopen').listeners.click();await settle();assert.equal(element('#welcome-screen').hidden,false);
  await element('#welcome-skip').listeners.click();assert.equal(element('#welcome-screen').hidden,true);
  console.log('Walkthrough passed: first-use welcome, private brief saving, model settings, team instructions, editable first prompt, persisted finish, replay and skip; no automatic model calls.');
})().catch(error=>{console.error(error);process.exitCode=1;});
