const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const nodes=new Map();
function element(key){if(!nodes.has(key))nodes.set(key,{value:key==='#social-days'?'28':'',innerHTML:'',textContent:'',hidden:false,listeners:{},insertAdjacentHTML(where,html){this.innerHTML+=html;},addEventListener(type,fn){this.listeners[type]=fn;}});return nodes.get(key);}
let changed,officeFail=false,loads=0;
const connections=[{platform:'youtube',status:'connected',account_name:'<script>unsafe</script>'},{platform:'instagram',status:'disconnected'}];
const snapshots={youtube:{totals:{views:0,subscribersGained:5},period:{start:'2026-10-01',end:'2026-10-28'}}};
const window={spurSocial:{summary:()=>({connections,snapshots}),subscribe:fn=>changed=fn,load:async()=>{loads++;changed();},card:c=>`account:${c.platform}`,analytics:(p,s)=>`analytics:${p}:${!!s}`},spurAuth:{ready:Promise.resolve(),request:async()=>{if(officeFail)throw new Error('Session expired');return {connections:[{provider:'google',status:'connected',email:'creator@example.test',connected_features:['mail','calendar','docs']},{provider:'microsoft',status:'disconnected'}]};}}};
const location={hash:'#platforms'},doc={querySelector:element,querySelectorAll:()=>[],activeElement:null};
element('#platform-detail').contains=()=>true;
vm.runInNewContext(fs.readFileSync('spur/static/platforms.js','utf8'),{window,location,document:doc,Date,Number});
(async()=>{
  await window.spurPlatforms.load();
  assert.match(element('#platform-summary').innerHTML,/<strong>2<\/strong>/);
  assert.match(element('#platform-cards').innerHTML,/<strong>0<\/strong><span>Views/,'zero is a valid metric');
  assert.match(element('#platform-cards').innerHTML,/Unavailable/,'missing analytics are not fabricated');
  assert.match(element('#platform-cards').innerHTML,/&lt;script&gt;/);assert.doesNotMatch(element('#platform-cards').innerHTML,/<script>/);
  location.hash='#platform/youtube';await window.spurPlatforms.load('youtube');
  assert.equal(element('#platform-detail').innerHTML,'account:youtubeanalytics:youtube:true');assert(element('#platform-cards').hidden);
  assert.equal(loads,1,'route polling must reuse loaded data');
  doc.activeElement={closest:()=>true};
  location.hash='#platform/instagram';await window.spurPlatforms.load('instagram');assert.equal(element('#platform-detail').innerHTML,'account:instagramanalytics:instagram:false');
  doc.activeElement=null;
  location.hash='#platform/google';await window.spurPlatforms.load('google');
  assert(element('#platform-period-label').hidden);assert.match(element('#platform-detail').innerHTML,/Open calendar/);assert.match(element('#platform-detail').innerHTML,/Google Docs/);
  location.hash='#platform/linkedin';await window.spurPlatforms.load('linkedin');assert.match(element('#platform-detail').innerHTML,/rw_organization_admin/);
  location.hash='#platform/tiktok';await window.spurPlatforms.load('tiktok');assert.match(element('#platform-detail').innerHTML,/sandbox target user/);
  location.hash='#platforms';element('#platform-days').value='7';await element('#platform-days').listeners.change();
  // The handler starts an asynchronous refresh; await the same load to finish.
  await window.spurPlatforms.load('all');assert.equal(element('#social-days').value,'7');
  officeFail=true;await window.spurPlatforms.load('all',true);assert.match(element('#platform-error').textContent,/Session expired/);
  console.log('Platforms passed: aggregate status, zero/missing metrics, escaping, platform scoping, workspace links, periods, throttling and errors.');
})().catch(e=>{console.error(e);process.exitCode=1;});
