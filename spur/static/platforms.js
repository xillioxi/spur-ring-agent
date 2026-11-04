(() => {
  'use strict';
  const q=s=>document.querySelector(s),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const catalog={tiktok:{name:'TikTok',logo:'tiktok.svg',description:'Public video performance and current profile statistics, with your authorization.'},linkedin:{name:'LinkedIn',logo:'linkedin.svg',description:'Organic analytics for a company Page you administer. Requires approved Community Management access.'},youtube:{name:'YouTube',logo:'youtube.png',description:'Channel performance, watch time, subscribers, and top videos.'},instagram:{name:'Instagram',logo:'instagram.png',description:'Reach, engagement, and recent content for your professional account.'},google:{name:'Google',logo:'google.png',description:'Gmail, Google Calendar, and Google Docs in your workspace.'},microsoft:{name:'Outlook',logo:'outlook.svg',description:'Outlook email drafts and calendar events.'}};
  const metric=value=>value===null || value===undefined || !Number.isFinite(Number(value))?'Unavailable':Number(value).toLocaleString();
  const active=()=>location.hash==='#platforms' || location.hash.startsWith('#platform/');
  let selected='all',office=[],loading=false,lastAttempt=0,officeLoaded=false,lastRender='',queuedRefresh=false,renderedPlatform=null;
  function status(c){return c?.status==='mock'?(c.synthetic?'Synthetic demo':'Public reference'):c?.status==='connected'?'Connected':c?.status==='choose_account'?'Choose account':c?.status==='reconnect'?'Reconnect needed':'Not connected';}
  function render(){
    const social=window.spurSocial.summary(),all=[...social.connections,...office],find=p=>all.find(c=>(c.platform || c.provider)===p);
    document.querySelectorAll('.platform-navigation a').forEach(a=>{const current=a.getAttribute('href')===(selected==='all'?'#platforms':'#platform/'+selected) && active();if(current)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});
    document.querySelectorAll('[data-platform-status]').forEach(el=>{const c=find(el.dataset.platformStatus);el.classList.toggle('connected',status(c)==='Connected');el.title=status(c);});
    if(!active())return;
    const item=catalog[selected],socialPage=['youtube','instagram','tiktok','linkedin'].includes(selected);
    q('#page-title').textContent=item?item.name:'Platforms';
    q('#page-description').textContent=item?(find(selected)?.mock_profile?'Mock profile catalog and metadata reports. No private account analytics.':item.description):'A shared overview of your connected accounts, analytics, and workspace tools.';
    q('#crumb').textContent=item?'Platforms / '+item.name:'Platforms';
    q('#platform-heading').textContent=item?item.name+' overview':'All your platforms';
    q('#platform-description').textContent=item?'Your account and its available tools in one place.':'Open a platform to explore its analytics or connected tools.';
    q('#platform-period-label').hidden=!!item && !socialPage;
    q('#platform-days').value=q('#social-days').value;
    q('#platform-loading').hidden=!loading;q('#platform-loading').textContent='Updating platform status…';
    if(renderedPlatform===selected && document.activeElement?.closest?.('[data-attach-platform]') && q('#platform-detail').contains(document.activeElement))return;
    const signature=JSON.stringify([selected,social,office,loading,officeLoaded,q('#social-days').value]);
    if(signature===lastRender)return;lastRender=signature;renderedPlatform=selected;
    q('#platform-summary').hidden=!!item;
    q('#platform-summary').innerHTML=`<div><strong>${all.filter(c=>status(c)==='Connected').length}</strong><span>Connected platforms</span></div><div><strong>${Object.values(social.snapshots).filter(s=>s && s.metric_basis!=='profile_only').length}</strong><span>Platforms with saved analytics</span></div><div><strong>${q('#social-days').value} days</strong><span>Selected analytics window</span></div>`;
    q('#platform-cards').hidden=!!item;
    q('#platform-cards').innerHTML=Object.entries(catalog).map(([p,meta])=>{
      const c=find(p),snapshot=social.snapshots[p],primaryKey=p==='linkedin'?'impressions':'views',secondaryKey=p==='youtube'?'subscribersGained':p==='tiktok'?'follower_count':p==='linkedin'?'clicks':'reach',available=['youtube','instagram','tiktok','linkedin'].includes(p),state=status(c);
      return `<a href="#platform/${p}" class="panel platform-overview-card"><div class="platform-card-top"><img src="/static/brand-${meta.logo}" alt=""><span class="pill ${state==='Connected'?'success':'neutral'}">${esc(state)}</span></div><h3>${meta.name}</h3><p>${esc(c?.account_name || c?.email || meta.description)}</p>${available?`<div class="platform-mini-metrics"><div><strong>${metric(snapshot?.totals?.[primaryKey])}</strong><span>${p==='linkedin'?'Organic impressions':p==='tiktok'?'Video views · lifetime':'Views'}</span></div><div><strong>${metric(snapshot?.totals?.[secondaryKey])}</strong><span>${p==='youtube'?'Subscribers gained':p==='tiktok'?'Current followers':p==='linkedin'?'Organic clicks':'Accounts reached'}</span></div></div><small>${snapshot?esc(snapshot.period.start)+' → '+esc(snapshot.period.end):p==='linkedin'?'Company Page analytics requires approved API access.':'Sync analytics after connecting your account.'}</small>`:`<p class="platform-tool-list">${esc(c?.connected_features?.map(f=>({mail:'Email',calendar:'Calendar',docs:'Google Docs'}[f] || f)).join(' · ') || 'Connect your account to open workspace tools.')}</p>`}<span class="platform-open">Open ${meta.name} →</span></a>`;
    }).join('');
    if(!item){q('#platform-detail').innerHTML='';return;}
    if(socialPage){
      const connection=find(selected);
      q('#platform-detail').innerHTML=(connection?window.spurSocial.card(connection):window.spurAuth.mockProfile && ['instagram','tiktok'].includes(selected)?window.spurMocks.platformCard({platform:selected}):'<p class="notice">Account status is unavailable. Retry from Connections & analytics.</p>')+window.spurSocial.analytics(selected,social.snapshots[selected]);
      if(selected==='tiktok' && !window.spurAuth.mockProfile)q('#platform-detail').insertAdjacentHTML('beforeend','<section class="panel social-data-panel"><h2>Post to TikTok</h2><p>Upload an MP4, review your account and posting settings, and track TikTok’s processing status. Direct Post needs video.publish; finishing in TikTok uses video.upload.</p><a href="#publishing" class="button primary" data-publish-platform="tiktok">Create a TikTok post →</a></section>');
      if(!window.spurAuth.mockProfile && ['tiktok','linkedin'].includes(selected))q('#platform-detail').insertAdjacentHTML('beforeend',`<section class="panel social-data-panel"><h2>What you need to connect ${catalog[selected].name}</h2>${selected==='linkedin'?'<ol class="platform-requirements"><li>A LinkedIn company Page and a LinkedIn account with approved Page administrator access.</li><li>A developer app associated with that Page, with its Page association verified and Community Management API access approved.</li><li>The rw_organization_admin permission. LinkedIn includes Page management in this permission; Spur Ring uses it only to read analytics.</li><li>Enter the app client ID and secret in Provider app setup, register its exact callback, then connect and choose your company Page.</li></ol><a href="https://www.linkedin.com/developers/apps" target="_blank" rel="noopener noreferrer">Open LinkedIn developer apps ↗</a>':'<ol class="platform-requirements"><li>A TikTok developer app with Login Kit; add Display API for analytics and Content Posting API for publishing.</li><li>Desktop Login Kit supports a registered localhost callback with PKCE. Web Login Kit requires public HTTPS. Use the exact /social/tiktok/callback shown in Provider app setup.</li><li>Approved user.info.basic and video.list scopes; user.info.stats enables follower and profile statistics.</li><li>For testing, add the TikTok account you own as a sandbox target user and use the matching sandbox credentials.</li><li>For production, complete the app website, privacy policy, terms, integration demo and app review. Enter the matching client key and secret in Provider app setup.</li></ol><a href="https://developers.tiktok.com/apps/" target="_blank" rel="noopener noreferrer">Open TikTok developer apps ↗</a>'}<p class="muted">Keep client secrets in Provider app setup. Each user authorizes their own account through the provider.</p></section>`);
    }else{
      const c=find(selected),tools=c?.connected_features || [],state=status(c);
      q('#platform-detail').innerHTML=`<section class="panel platform-workspace-detail"><div class="platform-card-top"><img src="/static/brand-${item.logo}" alt=""><span class="pill ${state==='Connected'?'success':'neutral'}">${esc(state)}</span></div><h2>${item.name} workspace</h2><p>${esc(c?.email || (officeLoaded?'Connect your account to use these tools.':'Loading account status…'))}</p><div class="platform-tool-grid">${['mail','calendar',...(selected==='google'?['docs']:[])].map(f=>`<div><h3>${{mail:selected==='google'?'Gmail':'Outlook mail',calendar:'Calendar',docs:'Google Docs'}[f]}</h3><p>${{mail:'Read your inbox and save email drafts.',calendar:'View synced events and plan your schedule.',docs:'Open, create, and edit documents.'}[f]}</p><span class="pill ${tools.includes(f)?'success':'neutral'}">${tools.includes(f)?'Connected':'Not connected'}</span>${f==='calendar' && tools.includes(f)?'<a href="#calendar" class="button secondary">Open calendar →</a>':`<a href="#connections" class="button secondary">${tools.includes(f)?'Open workspace':'Manage connection'} →</a>`}</div>`).join('')}</div><p class="muted">These connections provide workspace tools. Social performance analytics are available on the YouTube and Instagram pages.</p></section>`;
    }
  }
  async function load(platform='all',force=false){
    selected=catalog[platform]?platform:'all';render();
    if(loading){if(force)queuedRefresh=true;return;}
    if(!force && Date.now()-lastAttempt<15000)return;
    loading=true;lastAttempt=Date.now();q('#platform-error').textContent='';render();
    try{
      await Promise.all([window.spurSocial.load(force),(async()=>{await window.spurAuth.ready;const data=await window.spurAuth.request('/office/connections');office=data.connections;officeLoaded=true;})()]);
    }catch(e){q('#platform-error').textContent=e.message;}
    finally{loading=false;render();if(queuedRefresh){queuedRefresh=false;await load(selected,true);}}
  }
  q('#platform-days').addEventListener('change',()=>{q('#social-days').value=q('#platform-days').value;return load(selected,true);});
  window.spurSocial.subscribe(render);
  window.spurPlatforms={load};
})();
