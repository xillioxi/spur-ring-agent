const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const source=fs.readFileSync('spur/static/accounts.js','utf8');
const apiSource=fs.readFileSync('spur/static/app.js','utf8').split('async function api(')[1].split('\nfunction toast(')[0];
const response=(status,data={},csrfError=false)=>({status,ok:status>=200&&status<300,json:async()=>data,headers:{get:name=>csrfError&&name==='X-Spur-Session-Error'?'csrf':null}});
function client(fetchImpl){
  let redirects=0,reloads=0;const element={textContent:'',hidden:false,addEventListener(){}};
  const context=vm.createContext({fetch:fetchImpl,document:{querySelector:()=>element,querySelectorAll:()=>[]},sessionStorage:{getItem(){},setItem(){},removeItem(){}},location:{hash:'#agents',replace:()=>redirects++,reload:()=>reloads++}});
  context.window=context;
  vm.runInContext(source+';async function api('+apiSource+';this.api=api;',context);
  return {api:context.api,auth:context.spurAuth,redirects:()=>redirects,reloads:()=>reloads};
}
(async()=>{
  let token='initial-token',reads=0,writes=0,executed=0;
  const local=client(async(path,options)=>{
    assert.equal(options.credentials,'same-origin');assert.equal(options.headers['X-API-Key'],undefined);
    if(path==='/auth/me'){reads++;await new Promise(resolve=>setTimeout(resolve,5));return response(200,{user:{id:'owner',display_name:'Owner',role:'owner'},csrf_token:token});}
    writes++;assert.deepEqual(JSON.parse(options.body),{topic:'Test'});
    if(options.headers['X-CSRF-Token']!==token)return response(403,{detail:'Session verification failed'},true);
    executed++;return response(202,{mission_id:'saved'});
  });
  // Sending before initialization finishes must wait for the CSRF token.
  await local.api('/missions','POST',{topic:'Test'});assert.equal(executed,1);assert.equal(reads,1);
  token='rotated-token';
  await Promise.all([local.api('/missions','POST',{topic:'Test'}),local.api('/missions','POST',{topic:'Test'})]);
  assert.equal(reads,2);assert.equal(executed,3);assert.equal(writes,5);assert.equal(local.auth.csrfToken,token);
  let deniedWrites=0;
  const denied=client(async(path)=>path==='/auth/me'?response(200,{user:{id:'owner',display_name:'Owner',role:'owner'},csrf_token:'token'}):(deniedWrites++,response(403,{detail:'Not allowed'})));
  await assert.rejects(()=>denied.api('/missions','POST',{}),/Not allowed/);assert.equal(deniedWrites,1);
  let refreshes=0,failedWrites=0;
  const bounded=client(async path=>path==='/auth/me'?(refreshes++,response(200,{user:{id:'owner',display_name:'Owner'},csrf_token:'token'})):(failedWrites++,response(403,{detail:'Session verification failed'},true)));
  await assert.rejects(()=>bounded.api('/missions','POST',{}),/verification/);assert.equal(refreshes,2);assert.equal(failedWrites,2);
  let expired=false;
  const missing=client(async path=>expired?response(401,{detail:'Sign in again'}):response(200,{user:{id:'owner',display_name:'Owner'},csrf_token:'token'}));
  await missing.auth.ready;expired=true;await assert.rejects(()=>missing.api('/missions','POST',{}),/Sign in/);assert.equal(missing.redirects(),1);
  console.log('Account client passed: startup wait, rotated-token recovery, concurrent refresh coalescing, one retry maximum, no replay of permission failures, expired-session redirect.');
})().catch(error=>{console.error(error);process.exitCode=1;});
