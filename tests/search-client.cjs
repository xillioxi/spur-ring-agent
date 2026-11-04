const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const nodes=new Map();
function node(key){if(!nodes.has(key))nodes.set(key,{value:({'#discovery-platform':'youtube','#discovery-days':'7','#discovery-query':'Paris'})[key]||'',innerHTML:'',textContent:'',disabled:false,hidden:false,checked:false,listeners:{},addEventListener(t,fn){this.listeners[t]=fn;},setAttribute(){},showModal(){this.open=true;},close(){this.open=false;}});return nodes.get(key);}
let fail=false,submitted;
const tikhub={configured:false,enabled:false,monthly_requests:250,daily_requests:20,monthly_budget_usd:25,max_request_cost_usd:0,usage:{requests:0,today:0,reserved_usd:0,month:'2026-10',timezone:'Asia/Hong_Kong'}};
const window={spurAuth:{ready:Promise.resolve(),request:async(path,method,body)=>{
  if(path==='/search/providers')return {youtube:{ready:true},tikhub};
  if(path==='/search/videos'){if(fail)throw new Error('Provider quota exceeded');return {provider:'youtube_official',platform:'youtube',observed_at:1,warnings:['One page, not exhaustive.'],items:[{platform:'youtube',format:'video',provider:'youtube_official',title:'<script>bad</script>',url:'javascript:alert(1)',thumbnail:'',published:null,metrics:{views:0,likes:null}}]};}
  submitted=body;return tikhub;
}}};
vm.runInNewContext(fs.readFileSync('spur/static/search.js','utf8'),{window,document:{querySelector:node},URL,Date,Number});
(async()=>{
  await window.spurSearch.load(true);assert(!node('#discovery-submit').disabled);
  const submit=()=>node('#discovery-form').listeners.submit({preventDefault(){}});
  await submit();const html=node('#discovery-results').innerHTML;
  assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/href="javascript:/);assert.match(html,/<strong>0<\/strong>/);assert.match(html,/Unavailable/);assert.match(html,/Publication date unverified/);
  fail=true;await submit();assert.equal(node('#discovery-results').innerHTML,html);assert.match(node('#discovery-error').textContent,/quota/);
  node('#discovery-platform').value='rednote';node('#discovery-platform').listeners.change();assert(node('#discovery-submit').disabled);
  await node('#discovery-settings-open').listeners.click();assert.equal(node('#discovery-key').value,'');
  node('#discovery-key').value='new-private-key';node('#discovery-budget').value='25';node('#discovery-cost').value='0.01';node('#discovery-monthly').value='250';node('#discovery-daily').value='20';
  await node('#discovery-settings-form').listeners.submit({preventDefault(){},submitter:{}});assert.equal(submitted.api_key,'new-private-key');assert.equal(node('#discovery-key').value,'');
  console.log('Discovery UI passed: real zero/missing values, escaped content, failed-search preservation, disabled paid sources and cleared secrets.');
})().catch(e=>{console.error(e);process.exitCode=1;});
