(() => {
  'use strict';
  const key=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const parse=s=>{const [y,m,d]=s.split('-').map(Number);return new Date(y,m-1,d);};
  const add=(d,n)=>new Date(d.getFullYear(),d.getMonth(),d.getDate()+n);
  const monthDays=date=>{const first=new Date(date.getFullYear(),date.getMonth(),1),start=add(first,-((first.getDay()+6)%7));return Array.from({length:42},(_,i)=>add(start,i));};
  const overlaps=(event,day)=>{
    if(event.all_day)return event.start<=key(day) && event.end>key(day);
    const start=new Date(event.start),end=new Date(event.end);
    return start<add(day,1) && end>day;
  };
  // Export pure date helpers for timezone and boundary regression tests.
  const dates={key,parse,add,monthDays,overlaps};
  if(typeof module!=='undefined' && module.exports){module.exports=dates;return;}
  const q=s=>document.querySelector(s),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const api=async path=>{await window.spurAuth.ready;return window.spurAuth.request(path);};
  const names={google:'Google Calendar',microsoft:'Outlook Calendar'};
  let month=new Date(),selected=key(new Date()),accounts=[],events=[],version=0,loading=false,synced=null,lastAttempt=0,opening=false;
  const visible=()=>location.hash==='#calendar' && !document.hidden;
  const time=event=>event.all_day?'All day':new Date(event.start).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});
  const matching=day=>events.filter(e=>overlaps(e,day)).sort((a,b)=>Number(b.all_day)-Number(a.all_day)||(a.all_day?a.start.localeCompare(b.start):new Date(a.start)-new Date(b.start)));
  function render(){
    q('#calendar-month').textContent=month.toLocaleDateString([],{month:'long',year:'numeric'});
    q('#calendar-empty').hidden=accounts.length>0 || loading;q('#calendar-layout').hidden=!accounts.length;
    q('#calendar-new').disabled=!accounts.length || loading;q('#calendar-sync').disabled=loading;
    q('#calendar-grid').innerHTML=monthDays(month).map(day=>{
      const id=key(day),items=matching(day),outside=day.getMonth()!==month.getMonth();
      return `<div class="calendar-cell ${outside?'outside':''} ${id===selected?'selected':''} ${id===key(new Date())?'is-today':''}"><button class="calendar-date" data-calendar-day="${id}" aria-pressed="${id===selected}" aria-label="${esc(day.toLocaleDateString([],{dateStyle:'full'}))}, ${items.length} events">${day.getDate()}</button>${items.slice(0,3).map(e=>`<button class="calendar-event ${e.provider}" data-calendar-event="${events.indexOf(e)}" title="${esc(e.title)}"><span>${esc(time(e))}</span> ${esc(e.title || 'Untitled event')}</button>`).join('')}${items.length>3?`<button class="calendar-more" data-calendar-day="${id}">+${items.length-3} more</button>`:''}</div>`;
    }).join('');
    const day=parse(selected),items=matching(day);
    q('#calendar-day-title').textContent=day.toLocaleDateString([],{weekday:'long',month:'short',day:'numeric'});
    q('#calendar-agenda').innerHTML=items.length?items.map(e=>`<button class="calendar-agenda-event ${e.provider}" data-calendar-event="${events.indexOf(e)}"><small>${esc(time(e))} · ${esc(names[e.provider])}</small><strong>${esc(e.title || 'Untitled event')}</strong>${e.location?`<span>${esc(e.location)}</span>`:''}<span>${esc(e.email)}</span>${!e.editable?'<small>View details · edit on provider</small>':''}</button>`).join(''):`<div class="calendar-free"><p>${loading?'Loading your events…':'No events on this day.'}</p><small>${loading?'':'Make room for your next idea.'}</small></div>`;
    q('#calendar-coverage').textContent=`Primary calendars only. Timed events use ${Intl.DateTimeFormat().resolvedOptions().timeZone}. All-day end dates are exclusive. Refreshes every minute while this page is visible; saved changes sync back to the provider.`;
  }
  async function load(force=true){
    if(force===false && (loading || Date.now()-lastAttempt<60000))return;
    lastAttempt=Date.now();const current=++version;loading=true;q('#calendar-error').textContent='';q('#calendar-status').textContent='Syncing connected calendars…';render();
    try{
      const data=await api('/office/connections');if(current!==version)return;
      accounts=data.connections.filter(c=>c.status==='connected' && c.connected_features.includes('calendar'));
      const select=q('#calendar-account'),previous=select.value;
      select.innerHTML='<option value="all">All connected calendars</option>'+accounts.map(c=>`<option value="${esc(c.provider)}">${esc(names[c.provider])} · ${esc(c.email)}</option>`).join('');
      select.value=previous==='all'||accounts.some(c=>c.provider===previous)?previous:'all';
      const chosen=accounts.filter(c=>select.value==='all'||select.value===c.provider),days=monthDays(month);
      // Pad UTC query boundaries so every local day is covered, including UTC+14 / UTC-12.
      const params=new URLSearchParams({start:key(add(days[0],-1)),end:key(add(days[41],2))});
      const results=await Promise.allSettled(chosen.map(async c=>({account:c,items:(await api(`/office/${c.provider}/items/events?${params}`)).items})));
      if(current!==version)return;
      events=[];const errors=[];
      results.forEach((r,i)=>{if(r.status==='fulfilled')events.push(...r.value.items.map(e=>({...e,provider:r.value.account.provider,email:r.value.account.email})));else errors.push(`${names[chosen[i].provider]}: ${r.reason.message}`);});
      synced=new Date();q('#calendar-error').textContent=errors.join(' ');
      q('#calendar-status').textContent=errors.length?(errors.length===chosen.length?'Calendar sync failed. Try Sync calendars again.':'Some calendars could not sync. Displaying successful results.'):accounts.length?'Synced '+synced.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})+' · '+events.filter(e=>monthDays(month).some(day=>overlaps(e,day))).length+' events in view':'No calendar connected yet';
    }catch(e){if(current===version){events=[];q('#calendar-error').textContent=e.message;q('#calendar-status').textContent='Calendar sync failed. Try Sync calendars again.';}}
    finally{if(current===version){loading=false;render();}}
  }
  async function openEvent(id=''){
    if(opening)return;opening=true;
    try{q('#calendar-error').textContent='';let p;
      if(id!==''){const event=events[Number(id)];p=event.provider;await window.spurOffice.openCalendarEvent(p,event.id);}
      else{const filter=q('#calendar-account').value;p=accounts.find(c=>filter==='all'||c.provider===filter)?.provider;if(p)await window.spurOffice.openCalendarEvent(p,'',selected);}
    }catch(e){q('#calendar-error').textContent=e.message;}finally{opening=false;}
  }
  q('#calendar-sync').addEventListener('click',load);
  q('#calendar-account').addEventListener('change',load);
  q('#calendar-new').addEventListener('click',()=>openEvent());
  for(const [id,delta] of [['prev',-1],['next',1]])q('#calendar-'+id).addEventListener('click',()=>{month=new Date(month.getFullYear(),month.getMonth()+delta,1);selected=key(month);load();});
  q('#calendar-today').addEventListener('click',()=>{month=new Date();selected=key(month);load();});
  q('[data-page="calendar"]').addEventListener('click',e=>{const day=e.target.closest('[data-calendar-day]'),event=e.target.closest('[data-calendar-event]');if(day){selected=day.dataset.calendarDay;render();}if(event)openEvent(event.dataset.calendarEvent);});
  setInterval(()=>{if(visible()&&!loading)load();},60000);
  document.addEventListener('visibilitychange',()=>{if(visible()&&!loading)load();});
  window.spurCalendar={load};
})();
