const assert=require('node:assert/strict');
const {key,parse,add,monthDays,overlaps}=require('../spur/static/calendar.js');
for(const zone of ['Asia/Hong_Kong','America/New_York','Pacific/Kiritimati','Pacific/Pago_Pago']){
  process.env.TZ=zone;
  const days=monthDays(new Date(2026,10,1));
  assert.equal(days.length,42);assert.equal(days[0].getDay(),1);
  assert.equal(key(days[0]),'2026-10-26');assert.equal(key(days[41]),'2026-12-06');
  assert.equal(key(add(parse('2026-12-31'),1)),'2027-01-01');
  const allDay={start:'2026-11-01',end:'2026-11-03',all_day:true};
  assert(overlaps(allDay,parse('2026-11-01')));assert(overlaps(allDay,parse('2026-11-02')));
  assert(!overlaps(allDay,parse('2026-11-03')));
  const overnight={start:new Date(2026,10,1,23).toISOString(),end:new Date(2026,10,2,1).toISOString()};
  assert(overlaps(overnight,parse('2026-11-01')));assert(overlaps(overnight,parse('2026-11-02')));
  const midnight={start:new Date(2026,10,1,23).toISOString(),end:new Date(2026,10,2).toISOString()};
  assert(!overlaps(midnight,parse('2026-11-02')));
  assert(!overlaps({start:'bad',end:'bad'},parse('2026-11-02')));
}
console.log('Calendar date boundaries passed in four timezones.');
const fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('spur/static/calendar.js','utf8');
function harness(request){
  const elements=new Map();
  const document={hidden:false,addEventListener(){},querySelector(selector){
    if(!elements.has(selector))elements.set(selector,{value:'all',textContent:'',innerHTML:'',hidden:false,disabled:false,addEventListener(){}});
    return elements.get(selector);
  }};
  const window={spurAuth:{ready:Promise.resolve(),request}};
  vm.runInNewContext(source,{document,window,location:{hash:'#calendar'},setInterval(){},URLSearchParams,Intl,Date,Event});
  return {calendar:window.spurCalendar,el:id=>document.querySelector('#calendar-'+id)};
}
const connection={provider:'google',status:'connected',connected_features:['calendar'],email:'creator@example.test'};
const sample={id:'1',title:'<img src=x onerror=alert(1)>',start:'2026-10-30',end:'2026-10-31',all_day:true,editable:true};
(async()=>{
  let calls=0,fail=false;
  const h=harness(async path=>{calls++;if(fail)throw new Error('Reconnect this account');return path==='/office/connections'?{connections:[connection]}:{items:[sample]};});
  await h.calendar.load();assert.match(h.el('status').textContent,/Synced/);assert(!h.el('sync').disabled);
  // The app rerenders its route every four seconds. That must not call providers again.
  await h.calendar.load(false);assert.equal(calls,2);
  assert(h.el('grid').innerHTML.includes('&lt;img'));assert(!h.el('grid').innerHTML.includes('<img'));
  fail=true;await h.calendar.load();assert.match(h.el('error').textContent,/Reconnect/);assert(!h.el('sync').disabled);
  let resolveOld,count=0;
  const race=harness(async path=>{
    if(path==='/office/connections')return {connections:[connection]};
    count++;if(count===1)return new Promise(resolve=>{resolveOld=resolve;});
    return {items:[]};
  });
  const old=race.calendar.load();await new Promise(resolve=>setImmediate(resolve));
  await race.calendar.load();resolveOld({items:[sample]});await old;
  assert(!race.el('grid').innerHTML.includes('&lt;img'),'stale responses must not replace the current month');
  const empty=harness(async()=>({connections:[]}));await empty.calendar.load();assert(!empty.el('empty').hidden);assert(empty.el('new').disabled);
  console.log('Calendar sync, throttling, escaping, failures, empty state and stale-response checks passed.');
})().catch(e=>{console.error(e);process.exitCode=1;});
