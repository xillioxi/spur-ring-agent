(() => {
  'use strict';
  const q=s=>document.querySelector(s),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const api=async(path,method='GET',body)=>{await window.spurAuth.ready;return window.spurAuth.request(path,method,body);};
  let data=null,busy=false,lastLoad=0,configBusy=false;
  const money=n=>Number(n).toLocaleString([],{style:'currency',currency:'USD',maximumFractionDigits:4});
  const safe=v=>{try{return new URL(v).protocol==='https:'?esc(v):'';}catch{return '';}};
  function state(){
    if(!data)return;
    if(data.mock_profile){q('#discovery-provider-state').textContent='Local mock catalog · '+data.mock_profile.name+' · no external discovery requests';q('#discovery-submit').disabled=busy || !(data.mock_profile.platforms || [data.mock_profile.platform]).includes(q('#discovery-platform').value);q('#discovery-settings-open').disabled=true;return;}
    const paid=q('#discovery-platform').value!=='youtube',c=data.tikhub;
    q('#discovery-provider-state').textContent=paid?`TikHub · ${c.configured?c.enabled?'Enabled':'Saved, disabled':'Key needed'} · ${c.usage.requests}/${c.monthly_requests} monthly attempts · ${money(c.usage.reserved_usd)} reserved estimate of ${money(c.monthly_budget_usd)}`:`YouTube official API · ${data.youtube.ready?'Connected and ready':'Connect YouTube in Platforms first'}`;
    q('#discovery-submit').disabled=busy || (paid? !c.configured || !c.enabled:!data.youtube.ready);
  }
  async function load(force=false){
    if(configBusy || !force && Date.now()-lastLoad<15000)return;
    configBusy=true;lastLoad=Date.now();
    try{data=await api('/search/providers');state();}catch(e){q('#discovery-error').textContent=e.message;}finally{configBusy=false;}
  }
  function render(result){
    window.spurMetadata?.result(result);
    q('#discovery-status').textContent=`${result.items.length} results · ${result.provider==='demo_synthetic'?'Synthetic demo catalog':result.provider==='youtube_official'?'YouTube official API':'TikHub'} · Checked ${new Date(result.observed_at*1000).toLocaleString()}`;
    q('#discovery-coverage').hidden=!result.warnings.length;q('#discovery-coverage').textContent=result.warnings.join(' ');
    q('#discovery-results').innerHTML=result.items.length?result.items.map(item=>`<article class="panel discovery-result">${safe(item.thumbnail)?`<img loading="lazy" referrerpolicy="no-referrer" src="${safe(item.thumbnail)}" alt="">`:'<div class="discovery-no-cover">No thumbnail returned</div>'}<div class="discovery-result-body"><label class="discovery-select"><input type="checkbox" data-discovery-select value="${esc(item.id)}" checked> Include in report</label><span class="eyebrow">${esc(item.platform)} · ${esc(item.format)}</span><h3>${safe(item.url)?`<a href="${safe(item.url)}" target="_blank" rel="noopener noreferrer">${esc(item.title)}</a>`:esc(item.title)}</h3><p>${esc(item.creator || 'Creator not returned')}</p><small>${item.published?new Date(item.published*1000).toLocaleDateString():'Publication date unverified'}</small><div class="discovery-counts">${Object.entries(item.metrics).map(([key,value])=>`<span><strong>${value===null?'Unavailable':Number(value).toLocaleString()}</strong>${esc(key)}</span>`).join('')}</div><small>${item.synthetic?'Fictional scenario counts':'Public lifetime counts'} · ${esc(item.provider)}</small></div></article>`).join(''):'<div class="panel empty-state"><h3>No results in this response</h3><p>Try another phrase or date window. This does not establish that no matching content exists.</p></div>';
  }
  q('#discovery-platform').addEventListener('change',state);
  q('#discovery-form').addEventListener('submit',async event=>{
    event.preventDefault();if(busy)return;busy=true;state();q('#discovery-error').textContent='';q('#discovery-status').textContent='Searching the selected provider…';q('#discovery-results').setAttribute('aria-busy','true');
    try{render(await api('/search/videos','POST',{platform:q('#discovery-platform').value,query:q('#discovery-query').value.trim(),days:Number(q('#discovery-days').value),limit:20}));}
    catch(e){q('#discovery-error').textContent=e.message;q('#discovery-status').textContent='Search failed. Any previous results below are unchanged.';}
    finally{busy=false;q('#discovery-results').setAttribute('aria-busy','false');await load(true);state();}
  });
  q('#discovery-settings-open').addEventListener('click',async()=>{
    try{data=await api('/search/providers');const c=data.tikhub;q('#discovery-key').value='';q('#discovery-enabled').checked=c.enabled;q('#discovery-budget').value=c.monthly_budget_usd;q('#discovery-cost').value=c.max_request_cost_usd;q('#discovery-monthly').value=c.monthly_requests;q('#discovery-daily').value=c.daily_requests;
      q('#discovery-usage').textContent=`${c.usage.month} · ${c.usage.timezone} · ${c.usage.requests} attempts · ${money(c.usage.reserved_usd)} reserved estimate. Saving or rotating the key does not reset usage.`;q('#discovery-settings-error').textContent='';q('#discovery-settings').showModal();}
    catch(e){q('#discovery-error').textContent=e.message;}
  });
  q('#discovery-settings-close').addEventListener('click',()=>q('#discovery-settings').close());
  q('#discovery-settings-form').addEventListener('submit',async event=>{
    event.preventDefault();const button=event.submitter;if(button)button.disabled=true;
    try{await api('/search/providers/tikhub','PUT',{api_key:q('#discovery-key').value,enabled:q('#discovery-enabled').checked,monthly_budget_usd:Number(q('#discovery-budget').value),max_request_cost_usd:Number(q('#discovery-cost').value),monthly_requests:Number(q('#discovery-monthly').value),daily_requests:Number(q('#discovery-daily').value)});q('#discovery-key').value='';q('#discovery-settings').close();await load(true);}
    catch(e){q('#discovery-settings-error').textContent=e.message;}finally{if(button)button.disabled=false;}
  });
  window.spurSearch={load,render};
})();
