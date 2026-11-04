const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const nodes=new Map(),handlers={},calls=[];
function node(key){if(!nodes.has(key))nodes.set(key,{value:'',textContent:'',innerHTML:'',hidden:false,disabled:false,files:[],listeners:{},addEventListener(k,f){this.listeners[k]=f;},reset(){},focus(){},showModal(){this.open=true;},close(){this.open=false;}});return nodes.get(key);}
const draft={id:'draft1',version:3,status:'draft',media_type:'image',caption:'Before',media_url:'',content_id:'content1',asset_id:'asset1'};
const scheduled={...draft,id:'scheduled1',status:'scheduled',version:5,account_id:'123',scheduled_at:Date.now()/1000+7200};
const response={connection:{connected:true,account_id:'123',account_name:'studio',publish_permission:true,authorization_current:true},items:[draft,scheduled]};
const window={spurAuth:{ready:Promise.resolve(),mockProfile:null,request:async(path,method,body)=>{calls.push({path,method,body});return response;}}};
vm.runInNewContext(fs.readFileSync('spur/static/publishing.js','utf8'),{window,document:{querySelector:node,addEventListener(k,f){handlers[k]=f;}},location:{hash:'#publishing'},URL,Date,Number,setInterval(){}});
const settle=async()=>{for(let i=0;i<10;i++)await new Promise(setImmediate);};
const click=data=>handlers.click({target:{closest(){return {dataset:data};}}});
(async()=>{
 await window.spurPublishing.load(true);
 click({publishEdit:'draft1'});assert.equal(node('#publish-caption').value,'Before');assert.match(node('#publish-preview').innerHTML,/content1\/assets\/asset1/);
 node('#publish-type').value='image';node('#publish-caption').value='After';node('#publish-form').listeners.submit({preventDefault(){}});await settle();
 const edit=calls.find(c=>c.method==='PUT');assert.equal(edit.path,'/publishing/instagram/draft1?mode=instagram');assert.equal(edit.body.version,3);assert.equal(edit.body.asset_id,'asset1');assert.equal(edit.body.caption,'After');
 click({publishReschedule:'scheduled1'});assert(node('#publish-scheduled').value);node('#publish-confirmed').checked=true;
 await node('#publish-review-form').listeners.submit({preventDefault(){},submitter:{disabled:false}});
 const move=calls.find(c=>c.path.endsWith('/reschedule?mode=instagram'));assert(move);assert.equal(move.body.account_id,'123');assert.equal(move.body.version,5);
 console.log('Publishing UI passed: draft edit retains uploaded media and version; schedule changes use the existing publication and reviewed account.');
})().catch(e=>{console.error(e);process.exitCode=1;});
