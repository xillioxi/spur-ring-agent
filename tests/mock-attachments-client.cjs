const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const nodes=new Map(),forms=[],calls=[],documentListeners={};
function node(key){if(!nodes.has(key))nodes.set(key,{value:'',innerHTML:'',textContent:'',dataset:{},listeners:{},hidden:false,addEventListener(e,f){this.listeners[e]=f;},closest(){return this;},insertAdjacentHTML(){}});return nodes.get(key);}
for(const platform of ['instagram','tiktok']){
 const batch={value:'1'},field={value:''},provider={value:'official'},ack={checked:false},form={dataset:{attachPlatform:platform},listeners:{},addEventListener(e,f){this.listeners[e]=f;},querySelector(selector){return selector==='[name="page_limit"]'?batch:selector==='[name="source"]'?field:selector==='[name="provider"]' && platform==='instagram'?provider:selector==='[name="public_page_ack"]'?ack:null;},reset(){field.value='';},field,provider,ack};forms.push(form);
}
const profile={id:'creator1',name:'Creator',mode:'public',platform:'youtube',catalog_size:0,status:'ready',complete:false,metadata_collection:{},channels:[{id:'ig1',platform:'instagram',source:'studio',status:'needs_setup',imported:0}]};
let fail=false;
const request=async(path,method,body)=>{
 calls.push({path,method,body});
 if(path==='/mock-profiles' && method==='POST')return {id:'tt1',workspace_id:'creator1',status:'needs_setup'};
 if(path==='/mock-profiles')return {profiles:[profile],public_import_provider:{configured:false,enabled:false}};
 if(path==='/mock-profile/context')return {profile};
 if(path.startsWith('/mock-profile/media'))return {items:[],total:0};
 if(path==='/mock-profiles/ig1/refresh'){if(fail)throw Error('Configure TikHub before syncing');return {};}
 throw Error('Unexpected request '+path);
};
const window={spurAuth:{ready:Promise.resolve(),mockProfile:null,request}};
vm.runInNewContext(fs.readFileSync('spur/static/mock-profiles.js','utf8'),{window,document:{querySelector:node,querySelectorAll:()=>forms,addEventListener(e,f){documentListeners[e]=f;}},location:{reload(){}},Date,URL,Number});
const settle=async()=>{for(let i=0;i<8;i++)await new Promise(setImmediate);};
(async()=>{
 await window.spurMocks.load(true);
 const card=window.spurMocks.platformCard({platform:'instagram',account_name:'<unsafe>'});assert(card.includes('Attach / sync Instagram profile'));assert(card.includes('&lt;unsafe&gt;'));
 assert.match(node('#mock-attach-provider').textContent,/Official Meta API/);
 forms[1].field.value='@newstudio';documentListeners.submit({target:forms[1],preventDefault(){}});await settle();
 const create=calls.find(c=>c.method==='POST' && c.path==='/mock-profiles');
 assert.equal(create.body.page_limit,1);assert.equal(create.body.workspace_id,'creator1');assert.equal(create.body.platform,'tiktok');assert.equal(create.body.source,'@newstudio');
 assert.match(node('#mock-attach-status').textContent,/Profile attached/);
 forms[0].field.value='https://www.instagram.com/studio/';documentListeners.submit({target:forms[0],preventDefault(){}});await settle();
 assert(calls.some(c=>c.path==='/mock-profiles/ig1/refresh' && c.body.provider==='official' && c.body.page_limit===1));
 assert.match(window.spurMocks.platformCard({platform:'instagram',import_method:'tikhub'}),/value="tikhub" selected/);
 assert.equal(calls.filter(c=>c.method==='POST' && c.path==='/mock-profiles').length,1);
 const before=calls.filter(c=>c.path==='/mock-profiles/ig1/refresh').length;forms[0].provider.value='public_pages';forms[0].field.value='@studio';documentListeners.submit({target:forms[0],preventDefault(){}});await settle();assert.equal(calls.filter(c=>c.path==='/mock-profiles/ig1/refresh').length,before);assert.match(node('#mock-attach-error').textContent,/Acknowledge/);
 forms[0].ack.checked=true;documentListeners.submit({target:forms[0],preventDefault(){}});await settle();assert(calls.some(c=>c.body?.provider==='public_pages' && c.body.public_page_ack===true));
 fail=true;forms[0].field.value='@studio';documentListeners.submit({target:forms[0],preventDefault(){}});await settle();
 assert.match(node('#mock-attach-error').textContent,/Configure TikHub/);
 console.log('Attachment UI passed: creator-scoped handles, existing-profile sync, setup status and local errors.');
})().catch(e=>{console.error(e);process.exitCode=1;});
