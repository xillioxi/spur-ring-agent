const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const nodes=new Map(),events={};
function el(id){if(!nodes.has(id))nodes.set(id,{innerHTML:'',textContent:'',value:'',hidden:false,disabled:false,listeners:{},addEventListener(type,fn){this.listeners[type]=fn;},showModal(){this.open=true;},scrollIntoView(){},close(){this.open=false;}});return nodes.get(id);}
const analysis={mode:'mathematical_analysis',platform:'tiktok',provider:'tikhub',observed_at:1,descriptive:{views:{available:1,mean:100,median:100,q1:100,q3:100,minimum:100,maximum:100}},cohorts:[{platform:'tiktok',format:'video',age_band:'2–7 days',length_band:'<1 min',views_available:1,outlier_status:'insufficient_or_constant_data'}],evidence:[{id:'item-1',title:'<script>unsafe</script>',creator:'Creator',url:'javascript:alert(1)',metrics:{views:100,likes:0,comments:null},date_status:'valid',observed_interactions_per_view_pct:null,sample_outlier_z:null,growth:null}],formulas:{growth:'Observed change / elapsed time'},limitations:['No causal claims']};
const report={id:'report-1',content:{title:'Metadata fixture',summary:'Measured metadata only',expires_at:100,artifact:{data:analysis}}};
let submitted,pending=null;
const window={spurAuth:{ready:Promise.resolve(),user:{role:'member'},request:async(path,method,body)=>{
  if(path==='/search/history')return {runs:[]};
  if(path==='/search/reports'){submitted=body;return pending?await pending:report;}
  throw new Error('Unexpected request');
}}};
vm.runInNewContext(fs.readFileSync('spur/static/metadata-reports.js','utf8'),{window,document:{querySelector:el,querySelectorAll:()=>[{value:'item-1'}],addEventListener:(type,fn)=>events[type]=fn},URL,Date,Number,Map,setTimeout});
(async()=>{
  const html=window.spurMetadata.markup(report);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/href="javascript:/);assert.match(html,/Unavailable/);assert.match(html,/Needs another observation/);assert.match(html,/Formulas and methods/);
  const locked=window.spurMetadata.markup({...report,content:{...report.content,artifact:{data:{...analysis,mode:'source_evidence_only',descriptive:{},cohorts:[],formulas:{}}}}});
  assert.match(locked,/awaiting the required analytics approval/);assert.doesNotMatch(locked,/<th>Sample outlier z/);
  window.spurMetadata.result({search_id:'search-1',items:[{id:'item-1'}]});await el('#discovery-report-generate').listeners.click();
  assert.equal(submitted.search_id,'search-1');assert.equal(submitted.selected_ids[0],'item-1');assert(!el('#discovery-report').hidden);
  let resolve;pending=new Promise(r=>resolve=r);const old=el('#discovery-report-generate').listeners.click();window.spurMetadata.result({search_id:'search-2',items:[{id:'other'}]});resolve(report);await old;assert(el('#discovery-report').hidden,'stale report must not overwrite newly searched results');
  window.spurMetadata.show(report);assert(el('#report-dialog').open);
  console.log('Metadata UI passed: escaped evidence, missing metrics, permission mode, selected IDs, stale-report protection and saved report rendering.');
})().catch(e=>{console.error(e);process.exitCode=1;});
