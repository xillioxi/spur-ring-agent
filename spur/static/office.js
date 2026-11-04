(() => {
  'use strict';
  const q=s=>document.querySelector(s),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const api=async(path,method='GET',body)=>{await window.spurAuth.ready;return window.spurAuth.request(path,method,body);};
  const names={google:'Google',microsoft:'Outlook / Microsoft'},labels={mail:'Inbox',drafts:'Email drafts',events:'Calendar',documents:'Google Docs'};
  const features={google:{mail:'Gmail',calendar:'Google Calendar',docs:'Google Docs'},microsoft:{mail:'Outlook mail',calendar:'Outlook Calendar'}};
  let data=null,loading=false,signature='',provider='google',resource='drafts',rows=[],setupProvider='',editor=null,busy=false,requestVersion=0;
  const connection=p=>data?.connections.find(c=>c.provider===p);
  const allowed=(c,r)=>c?.status==='connected' && c.connected_features.includes({mail:'mail',drafts:'mail',events:'calendar',documents:'docs'}[r]);
  const localDate=date=>new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16);
  const today=()=>localDate(new Date()).slice(0,10);
  const safeLink=value=>{try{const u=new URL(value);return u.protocol==='https:' && /(^|\.)(google\.com|live\.com|office\.com|office365\.com|outlook\.com)$/.test(u.hostname)?esc(u.href):'';}catch{return '';}};
  const error=e=>{q('#office-error').textContent=e.message;};
  const note=message=>{q('#office-notice').textContent=message;};
  const path=(r=resource,id='')=>'/office/'+provider+'/items/'+r+(id?'/'+encodeURIComponent(id):'');
  function card(c){
    const connected=c.status==='connected',reconnect=c.status==='reconnect';
    return `<article class="panel social-card office-card"><div class="social-card-heading"><span class="office-logo office-${c.provider}"><img src="/static/brand-${c.provider==='google'?'google.png':'outlook.svg'}" alt="" aria-hidden="true" width="32" height="32" decoding="async"></span><div><h2>${names[c.provider]}</h2><span class="pill ${connected?'success':'neutral'}">${connected?'Connected':reconnect?'Reconnect required':'Not connected'}</span></div></div><p>${c.provider==='google'?'Read Gmail, save drafts, manage your personal calendar, and edit Google documents.':'Connect Outlook.com or Microsoft 365 to read mail, edit drafts and manage your personal calendar.'}</p>${c.email?`<div class="social-account-name">${esc(c.account_name)} · ${esc(c.email)}</div>`:''}<div class="office-capabilities">${(connected?c.connected_features:c.features).map(f=>`<span>${esc(features[c.provider][f])}</span>`).join('')}</div>${!c.configured?'<div class="social-setup-note">Your administrator is finishing this connection’s setup.</div>':''}<div class="social-card-actions"><button class="button ${connected?'secondary':'primary'}" data-office-connect="${c.provider}" ${!c.configured?'disabled':''}>${connected || reconnect?'Reconnect':'Connect '+names[c.provider]}</button><button class="button primary" data-office-open="${c.provider}" ${!connected?'disabled':''}>Open workspace →</button>${c.email?`<button class="text-button" data-office-disconnect="${c.provider}">Disconnect</button>`:''}</div></article>`;
  }
  async function load(force=false){
    if(loading)return;loading=true;
    try{const next=await api('/office/connections');data=next;const value=JSON.stringify(next);if(force || value!==signature){signature=value;q('#office-cards').innerHTML=next.connections.map(card).join('');}
      if(next.notice && !q('#office-notice').textContent)note(next.notice.message);
      if(!q('#office-workspace').hidden && connection(provider)?.status!=='connected'){q('#office-workspace').hidden=true;rows=[];}
    }catch(e){error(e);}finally{loading=false;}
  }
  function setup(p){
    setupProvider=p;const c=connection(p);if(!c?.can_manage)throw new Error('Only the installation owner can configure provider apps.');q('#office-setup-title').textContent='Connect '+names[p];
    q('#office-client-id').value=c.client_id;q('#office-client-secret').value='';q('#office-client-secret').required=!c.has_client_secret;
    q('#office-tenant').value=c.tenant;q('#office-tenant-label').hidden=p!=='microsoft';q('#office-callback').value=c.callback_url;
    q('#office-feature-fields').innerHTML=Object.entries(features[p]).map(([key,label])=>`<label><input type="checkbox" name="office-feature" value="${key}" ${c.features.includes(key)?'checked':''}>${esc(label)}</label>`).join('');
    q('#office-setup-guide').innerHTML=p==='google'?'Create a Google OAuth <strong>Web application</strong>, add the callback below, and enable Gmail API, Google Calendar API and Google Docs API for the services you select. Add yourself as a test user while the OAuth app is in testing. <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer">Google Cloud setup ↗</a>':'Register a Microsoft Entra application, choose the supported account types, add the callback as a <strong>Web</strong> redirect, and create a client secret. Use delegated User.Read, Mail.ReadWrite and Calendars.ReadWrite for the selected services. A company administrator may need to approve consent. <a href="https://entra.microsoft.com/" target="_blank" rel="noopener noreferrer">Microsoft Entra setup ↗</a>';
    q('#office-scope-hint').textContent=p==='google'?'Gmail uses readonly + compose (the compose permission includes sending, although this app only saves drafts). Calendar uses events.owned. Docs uses documents access: you choose the document links to open.':'Uses delegated access for the signed-in account. Mail.Send is not requested. offline_access allows token refresh.';
    q('#office-setup-error').textContent='';q('#office-setup-dialog').showModal();
  }
  async function openWorkspace(p){
    provider=p;const c=connection(p);if(c?.status!=='connected')throw new Error('Connect this account first.');
    resource=allowed(c,'drafts')?'drafts':allowed(c,'events')?'events':'documents';
    q('#office-workspace').hidden=false;q('#office-workspace-title').textContent=names[p]+' workspace';
    q('#office-workspace-account').textContent=c.email;q('#office-error').textContent='';
    await list();q('#office-workspace').scrollIntoView({behavior:'smooth',block:'start'});
  }
  async function list(){
    const version=++requestVersion,c=connection(provider);
    document.querySelectorAll('[data-office-tab]').forEach(b=>{b.disabled=!allowed(c,b.dataset.officeTab);b.setAttribute('aria-pressed',String(resource===b.dataset.officeTab));});
    q('#office-new').hidden=resource==='mail';q('#office-new').textContent=resource==='drafts'?'+ New draft':resource==='events'?'+ New event':'+ New document';
    q('#office-calendar-range').hidden=resource!=='events';q('#office-doc-open').hidden=resource!=='documents';q('#office-query').hidden=!['mail','drafts'].includes(resource);
    q('#office-coverage').textContent=resource==='documents'?'Recently opened documents for this account. Paste a Google Docs link to open another. Edits append text or replace exact text in the selected tab, preserving the rest of the document.':resource==='events'?'Primary calendar · all events in the selected range. Personal, non-recurring events can be edited here. Meetings with guests open in the provider.':'Latest 20 items. Received mail is read-only; draft edits save to your account without sending. Rich-text drafts open in the provider to preserve formatting.';
    q('#office-items').innerHTML='<div class="empty-state"><p>Loading from '+names[provider]+'…</p></div>';
    try{const params=new URLSearchParams({query:q('#office-query').value,start:q('#office-start').value,end:q('#office-end').value});const result=await api(path()+'?'+params);if(version!==requestVersion)return;rows=result.items;renderRows();}
    catch(e){if(version===requestVersion){q('#office-items').innerHTML='<div class="empty-state"><p>Unable to load this service.</p></div>';error(e);}}
  }
  function renderRows(){
    q('#office-items').innerHTML=rows.length?rows.map((row,index)=>`<button class="office-item" data-office-item="${index}"><span class="office-item-icon">${resource==='drafts'?'✎':resource==='events'?'▦':resource==='documents'?'≡':'✉'}</span><span><strong>${esc(row.title || '(Untitled)')}</strong><small>${esc(resource==='events'?row.start+' → '+row.end:row.from || row.preview || 'Open to view and edit')}</small></span><span class="office-item-arrow">↗</span></button>`).join(''):'<div class="empty-state"><h3>No items to show</h3><p>'+(resource==='documents'?'Open a document link or create a Google document.':resource==='drafts'?'Create your first draft here.':'Try another search or calendar range.')+'</p></div>';
  }
  const input=(id,label,value='',type='text',extra='')=>`<label>${label}<input id="${id}" type="${type}" value="${esc(value)}" ${extra}></label>`;
  const textarea=(id,label,value='',rows=8)=>`<label>${label}<textarea id="${id}" rows="${rows}" maxlength="60000">${esc(value)}</textarea></label>`;
  async function openEditor(id='',defaults={}){
    q('#office-editor-error').textContent='';q('#office-editor-status').textContent='';
    let item=id?await api(path(resource,id)):{title:'',body:'',to:'',cc:'',bcc:'',start:localDate(new Date(Date.now()+3600000)),end:localDate(new Date(Date.now()+7200000)),all_day:false,...defaults};
    editor={id,item,resource,provider,requestId:crypto.randomUUID()};
    q('#office-editor-title').textContent=resource==='mail'?'Read email':(id?'Edit ':'New ')+(resource==='drafts'?'email draft':resource==='events'?'calendar event':'Google document');
    q('#office-editor-account').textContent=names[provider]+' · '+connection(provider).email;
    const readOnly=resource==='mail' || (id && item.editable===false);
    if(readOnly && resource==='events')q('#office-editor-title').textContent='Calendar event details';
    q('#office-editor-save').hidden=readOnly;q('#office-output-field').hidden=readOnly;
    q('#office-editor-source-link').innerHTML=safeLink(item.url)?`<a href="${safeLink(item.url)}" target="_blank" rel="noopener noreferrer">Open on provider ↗</a>`:'';
    if(readOnly){q('#office-editor-fields').innerHTML=`<h3 class="office-read-title">${esc(item.title)}</h3>${resource==='events'?`<p>${esc(item.all_day?item.start+' → '+item.end+' (all day; end exclusive)':new Date(item.start).toLocaleString()+' → '+new Date(item.end).toLocaleString())}</p><p>${esc(item.location || '')}</p>`:''}<p>${esc(item.reason || item.from || '')}</p><pre class="office-reading">${esc(item.body)}</pre>`;}
    else if(resource==='drafts'){
      q('#office-editor-fields').innerHTML=input('office-edit-to','To (comma-separated)',item.to)+`<div class="office-field-grid">${input('office-edit-cc','Cc',item.cc)}${input('office-edit-bcc','Bcc',item.bcc)}</div>`+input('office-edit-title','Subject',item.title,'text','maxlength="300"')+textarea('office-edit-body','Message · plain text',item.body,14)+`<p class="office-edit-hint">Saves a draft in ${names[provider]}. Send it from your email provider when ready.${item.has_attachments?' Existing Outlook attachments are retained.':''}</p>`;
    }else if(resource==='events'){
      const stamp=v=>item.all_day?v.slice(0,10):localDate(new Date(v));
      q('#office-editor-fields').innerHTML=input('office-edit-title','Event title',item.title,'text','maxlength="300" required')+`<label class="office-checkbox"><input id="office-edit-all-day" type="checkbox" ${item.all_day?'checked':''}>All-day event</label><div class="office-field-grid">${input('office-edit-start','Start',id?stamp(item.start):item.start,item.all_day?'date':'datetime-local','required')}${input('office-edit-end','End',id?stamp(item.end):item.end,item.all_day?'date':'datetime-local','required')}</div>`+input('office-edit-location','Location',item.location || '', 'text','maxlength="1000"')+textarea('office-edit-body','Description',item.body,6)+'<p class="office-edit-hint">Timed events use your browser’s local timezone. For all-day events, the end date is exclusive. Creates or edits a personal event without guests.</p>';
    }else{
      q('#office-editor-fields').innerHTML=input('office-edit-title','Document title',item.title,'text',id?'readonly':'maxlength="300" required')+(id?`<label>Document tab<select id="office-edit-tab">${item.tabs.map(t=>`<option value="${esc(t.id)}">${esc(t.title)}</option>`).join('')}</select></label><details><summary>Read current text</summary><pre id="office-doc-text" class="office-reading">${esc(item.tabs[0]?.text)}</pre></details><label>Edit mode<select id="office-edit-mode"><option value="append">Append text</option><option value="replace">Find and replace exact text</option></select></label><div id="office-find-field" hidden>${input('office-edit-find','Exact text to replace','','text','maxlength="1000"')}</div>`:'')+textarea('office-edit-body',id?'Text to append / replacement text':'Initial document text',item.body,12)+'<p class="office-edit-hint">Changes save to Google Docs. Existing documents keep their structure and formatting; exact-text replacements apply only to the selected tab.</p>';
    }
    editor.readOnly=readOnly;editor.initialState=formState();q('#office-editor-dialog').showModal();
    if(!readOnly){const outputs=await api('/reports');q('#office-output').innerHTML='<option value="">Choose a saved agent output…</option>'+outputs.map(r=>`<option value="${esc(r.id)}">${esc(r.title || r.topic || 'Saved output')}</option>`).join('');}
  }
  function values(){
    const result={request_id:editor.requestId,resource:editor.resource,target_id:editor.id,title:q('#office-edit-title').value,body:q('#office-edit-body').value,version:editor.item.version || ''};
    if(resource==='drafts')for(const key of ['to','cc','bcc'])result[key]=q('#office-edit-'+key).value.split(',').map(s=>s.trim()).filter(Boolean);
    if(resource==='events'){result.all_day=q('#office-edit-all-day').checked;for(const key of ['start','end'])result[key]=result.all_day?q('#office-edit-'+key).value:new Date(q('#office-edit-'+key).value).toISOString();result.location=q('#office-edit-location').value;}
    if(resource==='documents' && editor.id){result.mode=q('#office-edit-mode').value;result.find=q('#office-edit-find').value;result.tab_id=q('#office-edit-tab').value;}
    return result;
  }
  async function save(event){
    event.preventDefault();if(busy)return;busy=true;q('#office-editor-form').inert=true;q('#office-editor-save').disabled=true;q('#office-editor-error').textContent='';
    try{const result=await api('/office/'+editor.provider+'/actions','POST',values());q('#office-editor-dialog').close();note(result.message);document.dispatchEvent(new Event('spur-office-saved'));if(location.hash==='#calendar')await window.spurCalendar.load();else await list();}
    catch(e){q('#office-editor-error').textContent=e.message;}
    finally{busy=false;q('#office-editor-form').inert=false;q('#office-editor-save').disabled=false;}
  }
  function formState(){return JSON.stringify([...q('#office-editor-fields').querySelectorAll('input,textarea,select')].map(el=>[el.id,el.value,el.checked]));}
  function closeEditor(){if(!busy){if(editor && !editor.readOnly && editor.initialState!==formState() && !window.confirm('Close without saving these edits to the provider?'))return;q('#office-editor-dialog').close();editor=null;}}
  document.body.insertAdjacentHTML('beforeend',`<dialog id="office-setup-dialog" class="office-dialog" aria-labelledby="office-setup-title"><form id="office-setup-form"><div class="dialog-top"><span class="eyebrow">CONNECT YOUR WORKSPACE</span><button type="button" class="close-button" id="office-setup-close" aria-label="Close workspace setup">×</button></div><h2 id="office-setup-title"></h2><p id="office-setup-guide"></p>${input('office-client-id','OAuth application client ID','','text','required maxlength="300" autocomplete="off"')}${input('office-client-secret','Client secret','','password','maxlength="1000" autocomplete="off" placeholder="Leave blank to keep the saved secret"')}<fieldset><legend>Services to connect</legend><div id="office-feature-fields"></div></fieldset><label id="office-tenant-label">Microsoft tenant<input id="office-tenant" value="common" placeholder="common or your tenant ID"></label>${input('office-callback','Authorized callback URI','','text','readonly')}<p id="office-scope-hint" class="office-edit-hint"></p><p class="office-edit-hint">Register the exact callback URI above. Credentials are encrypted on this Windows account. This uses a developer OAuth app, not your DeepSeek key.</p><p id="office-setup-error" class="form-error" role="alert"></p><div class="dialog-footer"><button type="submit" class="button primary" id="office-setup-save">Save app setup</button></div></form></dialog><dialog id="office-editor-dialog" class="office-dialog office-editor-dialog" aria-labelledby="office-editor-title"><form id="office-editor-form"><div class="dialog-top"><span class="eyebrow" id="office-editor-account"></span><button type="button" class="close-button" id="office-editor-close" aria-label="Close platform editor">×</button></div><h2 id="office-editor-title"></h2><div id="office-editor-source-link"></div><label id="office-output-field">Use an agent output<select id="office-output"></select></label><div id="office-editor-fields"></div><p id="office-editor-error" class="form-error" role="alert"></p><p id="office-editor-status" role="status"></p><div class="dialog-footer"><button type="button" class="button secondary" id="office-editor-cancel">Close</button><button class="button primary" id="office-editor-save">Save on provider</button></div></form></dialog>`);
  const start=new Date();q('#office-start').value=today();q('#office-end').value=localDate(new Date(start.getTime()+30*86400000)).slice(0,10);
  q('#office-setup-close').addEventListener('click',()=>q('#office-setup-dialog').close());
  q('#office-setup-form').addEventListener('submit',async event=>{event.preventDefault();const button=q('#office-setup-save');button.disabled=true;q('#office-setup-error').textContent='';try{await api('/office/'+setupProvider+'/app','PUT',{client_id:q('#office-client-id').value.trim(),client_secret:q('#office-client-secret').value,tenant:q('#office-tenant').value.trim() || 'common',features:[...document.querySelectorAll('input[name="office-feature"]:checked')].map(i=>i.value)});q('#office-client-secret').value='';q('#office-setup-dialog').close();note('App setup saved. Connect the account to grant the selected services.');await load(true);}catch(e){q('#office-setup-error').textContent=e.message;}finally{button.disabled=false;}});
  q('#office-editor-form').addEventListener('submit',save);q('#office-editor-close').addEventListener('click',closeEditor);q('#office-editor-cancel').addEventListener('click',closeEditor);
  q('#office-editor-dialog').addEventListener('cancel',event=>{event.preventDefault();closeEditor();});
  q('#office-editor-fields').addEventListener('change',event=>{
    if(event.target.id==='office-edit-mode')q('#office-find-field').hidden=event.target.value!=='replace';
    if(event.target.id==='office-edit-tab')q('#office-doc-text').textContent=editor.item.tabs.find(t=>t.id===event.target.value)?.text || '';
    if(event.target.id==='office-edit-all-day')for(const key of ['start','end']){const input=q('#office-edit-'+key),value=input.value;input.type=event.target.checked?'date':'datetime-local';input.value=event.target.checked?value.slice(0,10):value+'T09:00';}
  });
  q('#office-output').addEventListener('change',async event=>{if(!event.target.value)return;try{const output=await api('/reports/'+encodeURIComponent(event.target.value));const r=output.content;if(q('#office-edit-body').value && !window.confirm('Replace the editor text with this saved agent output?'))return;q('#office-edit-body').value=[r.summary,r.artifact?JSON.stringify(r.artifact.data,null,2):JSON.stringify(r,null,2)].filter(Boolean).join('\n\n').slice(0,60000);if(!editor.id)q('#office-edit-title').value=(r.title || r.topic || 'Agent output').slice(0,300);}catch(e){q('#office-editor-error').textContent=e.message;}});
  q('#office-refresh').addEventListener('click',()=>{q('#office-error').textContent='';list().catch(error);});
  q('#office-new').addEventListener('click',()=>openEditor().catch(error));
  q('#office-open-doc').addEventListener('click',()=>{const value=q('#office-doc-link').value.trim(),id=value.match(/^https:\/\/docs\.google\.com\/document\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)/)?.[1] || (/^[A-Za-z0-9_-]{10,200}$/.test(value)?value:'');if(!id){error(new Error('Paste a Google Docs document link or document ID.'));return;}openEditor(id).catch(error);});
  document.addEventListener('click',async event=>{
    const button=event.target.closest('[data-office-setup],[data-office-connect],[data-office-open],[data-office-disconnect],[data-office-tab],[data-office-item]');if(!button || busy)return;
    q('#office-error').textContent='';
    try{
      if(button.dataset.officeSetup){setup(button.dataset.officeSetup);return;}
      if(button.dataset.officeConnect){const p=button.dataset.officeConnect;if(!connection(p).configured){setup(p);return;}button.disabled=true;const result=await api('/office/'+p+'/connect','POST');location.assign(result.authorization_url);}
      if(button.dataset.officeOpen)await openWorkspace(button.dataset.officeOpen);
      if(button.dataset.officeDisconnect){await api('/office/'+button.dataset.officeDisconnect,'DELETE');await load(true);note('Disconnected locally. Provider content is unchanged. Revoke the app in provider settings if needed.');}
      if(button.dataset.officeTab){resource=button.dataset.officeTab;await list();}
      if(button.hasAttribute('data-office-item'))await openEditor(rows[Number(button.dataset.officeItem)].id);
    }catch(e){error(e);button.disabled=false;}
  });
  window.spurOffice={load,async openCalendarEvent(p,id='',day=''){
    if(busy || q('#office-editor-dialog').open)return;
    await load(true);if(!allowed(connection(p),'events'))throw new Error('Connect this account with calendar access in Connections & analytics.');
    provider=p;resource='events';await openEditor(id,day?{start:day+'T09:00',end:day+'T10:00'}:{});
  }};
})();
