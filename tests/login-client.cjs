const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const source=fs.readFileSync('spur/static/login.js','utf8');
function setup(firstAccount,fail=false){
  const elements=new Map(),storage=new Map([['spur_after_login','#agent/coordinator/overview'],['spur_api_key','obsolete'],['spur_current_user','previous-user'],['spur_prompt_draft_coordinator','Previous account secret draft']]);let destination='',submitted;
  const element=key=>{if(!elements.has(key))elements.set(key,{value:'',checked:false,hidden:false,disabled:false,textContent:'',listeners:{},addEventListener(type,handler){this.listeners[type]=handler;}});return elements.get(key);};
  const context=vm.createContext({document:{querySelector:element},sessionStorage:{get length(){return storage.size;},key:index=>[...storage.keys()][index],getItem:key=>storage.get(key),setItem:(k,v)=>storage.set(k,v),removeItem:key=>storage.delete(key)},location:{pathname:firstAccount?'/signup':'/login',replace:path=>destination=path},fetch:async(path,options)=>{
    if(path==='/auth/status')return {ok:true,json:async()=>({setup_required:firstAccount})};
    submitted={path,options,body:JSON.parse(options.body)};
    return {ok:!fail,json:async()=>fail?{detail:'Incorrect username or password.'}:{user:{id:'user-one'}}};
  }});
  vm.runInContext(source,context);
  return {element,storage,get submitted(){return submitted;},get destination(){return destination;}};
}
(async()=>{
  const first=setup(true);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(first.element('#auth-title').textContent,'Create your owner account');assert.equal(first.element('#display-name').required,true);assert.equal(first.element('#password').minLength,12);
  first.element('#username').value='owner';first.element('#password').value='long-test-passphrase';first.element('#display-name').value='Owner';first.element('#remember').checked=true;
  await first.element('#login-form').listeners.submit({preventDefault(){}});
  assert.equal(first.submitted.path,'/auth/register');assert.equal(first.submitted.body.display_name,'Owner');assert.equal(first.submitted.body.remember,true);
  assert.equal(first.submitted.options.headers['X-Spur-Auth'],'1');assert.equal(first.submitted.options.credentials,'same-origin');assert.equal(first.destination,'/#welcome');assert.equal(first.storage.has('spur_api_key'),false);assert.equal(first.storage.has('spur_prompt_draft_coordinator'),false);assert.equal(first.element('#password').value,'');
  const normal=setup(false,true);await new Promise(resolve=>setImmediate(resolve));assert.equal(normal.element('#display-name-field').hidden,true);assert.equal(normal.element('#password').autocomplete,'current-password');
  normal.element('#username').value='owner';normal.element('#password').value='incorrect';
  await normal.element('#login-form').listeners.submit({preventDefault(){}});
  assert.equal(normal.submitted.path,'/auth/login');assert.match(normal.element('#auth-error').textContent,/Incorrect/);assert.equal(normal.element('#auth-submit').disabled,false);assert.equal(normal.destination,'');
  console.log('Login client passed: first-owner setup, sign-in mode, remember option, safe return path and failed-login feedback.');
})().catch(error=>{console.error(error);process.exitCode=1;});
