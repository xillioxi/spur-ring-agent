(() => {
  'use strict';
  const q=s=>document.querySelector(s);
  const esc=v=>String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const api=async(path,method='GET',body)=>{await window.spurAuth.ready;return window.spurAuth.request(path,method,body);};
  const fields=['title','format','kind','stage','campaign','owner_agent_id','audience','objective','brief','script','caption','due_date','publish_date','source_url','live_url','cover_asset_id'];
  let data={items:[],formats:[],stages:[]},agents=[],reports=[],view='gallery',loading=false,signature='',current=null,busy=false,candidates=[];
  let month=new Date(new Date().getFullYear(),new Date().getMonth(),1);
  const format=id=>data.formats.find(f=>f.id===id)?.label || id;
  const stage=id=>data.stages.find(s=>s.id===id)?.label || id;
  const owner=id=>agents.find(a=>a.id===id)?.name || 'Unassigned';
  const feedback=message=>{q('#library-feedback').textContent=message;};
  const fail=error=>{q('#library-error').textContent=error.message;};
  const assetUrl=(item,id)=>`/content/${encodeURIComponent(item.id)}/assets/${encodeURIComponent(id)}`;
  const day=value=>value?new Date(value+'T12:00:00').toLocaleDateString([],{month:'short',day:'numeric'}):'No date';
  const iso=value=>`${value.getFullYear()}-${String(value.getMonth()+1).padStart(2,'0')}-${String(value.getDate()).padStart(2,'0')}`;
  const options=(list,value)=>list.map(item=>`<option value="${esc(item.id)}" ${item.id===value?'selected':''}>${esc(item.label || item.name)}</option>`).join('');
  const badge=item=>`<span class="lib-stage lib-stage-${esc(item.stage)}">${esc(stage(item.stage))}</span>`;
  function youtubeId(value){
    try{const url=new URL(value),host=url.hostname.toLowerCase();const id=host==='youtu.be'?url.pathname.slice(1):['youtube.com','www.youtube.com','m.youtube.com'].includes(host)?url.searchParams.get('v') || url.pathname.match(/^\/(?:shorts|embed)\/([^/]+)/)?.[1]:'';return /^[A-Za-z0-9_-]{11}$/.test(id)?id:'';}catch{return '';}
  }
  function cover(item){
    const id=youtubeId(item.source_url || item.live_url),src=item.cover_asset_id?assetUrl(item,item.cover_asset_id):id?'https://i.ytimg.com/vi/'+id+'/hqdefault.jpg':'';
    return `<div class="lib-cover lib-cover-${esc(item.format)}"><span class="lib-cover-symbol" aria-hidden="true">${['article','podcast'].includes(item.format)?'≋':'▷'}</span><span class="lib-cover-format">${esc(format(item.format))}</span>${src?`<img src="${esc(src)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">`:''}${item.kind==='reference'?'<span class="lib-reference">Reference</span>':''}</div>`;
  }
  function card(item,board=false){
    return `<article class="lib-card" draggable="${board}" data-lib-drag="${esc(item.id)}"><button class="lib-card-open" data-lib-open="${esc(item.id)}">${cover(item)}<div class="lib-card-copy"><div class="lib-card-top">${badge(item)}<span>${esc(item.campaign || 'No campaign')}</span></div><h3>${esc(item.title)}</h3><p>${esc(item.objective || item.brief || 'Add a brief to give your team a clear starting point.')}</p><div class="lib-card-meta"><span>${esc(owner(item.owner_agent_id))}</span><span>${item.publish_date?'Publish '+day(item.publish_date):item.due_date?'Due '+day(item.due_date):'No date yet'}</span></div></div></button>${board?`<label class="lib-card-move"><span>Move to</span><select data-lib-stage="${esc(item.id)}" aria-label="Stage for ${esc(item.title)}">${options(data.stages,item.stage)}</select></label>`:''}</article>`;
  }
  function filtered(){
    const query=q('#library-search').value.toLowerCase().trim(),kind=q('#library-kind').value,stageId=q('#library-stage').value,campaign=q('#library-campaign').value;
    return data.items.filter(item=>(!kind || item.kind===kind)&&(!stageId || item.stage===stageId)&&(!campaign || item.campaign===campaign)&&(!query || [item.title,item.brief,item.objective,item.campaign,...item.tags].join(' ').toLowerCase().includes(query)));
  }
  function calendar(items){
    const first=new Date(month);first.setDate(first.getDate()-(first.getDay()+6)%7);
    return `<div class="lib-calendar-heading"><div><h2>${month.toLocaleDateString([],{month:'long',year:'numeric'})}</h2><p>Publication date, or due date when no publication date is set.</p></div><div><button data-lib-month="-1" aria-label="Previous month">←</button><button data-lib-month="today">Today</button><button data-lib-month="1" aria-label="Next month">→</button></div></div><div class="lib-calendar"><div class="lib-weekdays">${['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(d=>`<span>${d}</span>`).join('')}</div><div class="lib-days">${Array.from({length:42},(_,index)=>{const value=new Date(first);value.setDate(value.getDate()+index);const date=iso(value);return `<div class="lib-day ${value.getMonth()!==month.getMonth()?'lib-other-month':''} ${date===iso(new Date())?'lib-today':''}"><button class="lib-day-number" data-lib-date="${date}" aria-label="New content for ${date}">${value.getDate()} <span>+</span></button>${items.filter(item=>(item.publish_date || item.due_date)===date).map(item=>`<button class="lib-calendar-item lib-stage-${esc(item.stage)}" data-lib-open="${esc(item.id)}" title="${esc(item.title)}">${esc(item.title)}</button>`).join('')}</div>`;}).join('')}</div></div><div class="lib-unscheduled"><h3>Without a date <span>${items.filter(i=>!i.publish_date && !i.due_date).length}</span></h3>${items.filter(i=>!i.publish_date && !i.due_date).map(i=>`<button data-lib-open="${esc(i.id)}">${esc(i.title)} ↗</button>`).join('') || '<p>Everything has a date.</p>'}</div>`;
  }
  function render(){
    const items=filtered(),own=data.items.filter(i=>i.kind==='own');
    q('#library-stats').innerHTML=[[own.length,'Your content'],[own.filter(i=>!['idea','published'].includes(i.stage)).length,'In progress'],[own.filter(i=>i.stage==='published').length,'Published']].map(([n,label])=>`<div><strong>${n}</strong><span>${label}</span></div>`).join('');
    document.querySelectorAll('[data-lib-view]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.libView===view)));
    const root=q('#library-content');root.setAttribute('aria-busy','false');
    if(!items.length && view!=='calendar'){
      root.innerHTML=`<div class="panel lib-empty"><div class="lib-empty-symbol">▤</div><h2>${data.items.length?'No content matches these filters':q('#library-archived').checked?'Your archive is empty':'Make room for your next great idea.'}</h2><p>${data.items.length?'Try another search, stage, or campaign.':'Create a content brief, attach creative files, or bring in a collected video as a reference.'}</p><button class="button primary" data-lib-new>+ Create content</button> <button class="button secondary" data-lib-import-open>Import existing</button></div>`;return;
    }
    if(view==='gallery')root.innerHTML=`<div class="lib-gallery">${items.map(i=>card(i)).join('')}</div>`;
    if(view==='board')root.innerHTML=`<p class="lib-view-hint">Drag cards between stages, or use each card’s stage menu.</p><div class="lib-board">${data.stages.map(s=>`<section class="lib-column" data-lib-column="${s.id}"><h2><i class="lib-dot lib-stage-${s.id}"></i>${esc(s.label)} <span>${items.filter(i=>i.stage===s.id).length}</span></h2>${items.filter(i=>i.stage===s.id).map(i=>card(i,true)).join('')}<button class="lib-column-add" data-lib-new-stage="${s.id}">+ Add content</button></section>`).join('')}</div>`;
    if(view==='calendar')root.innerHTML=calendar(items);
    if(view==='table')root.innerHTML=`<div class="panel lib-table-wrap"><table class="lib-table"><thead><tr><th>Content</th><th>Format</th><th>Stage</th><th>Campaign</th><th>Assigned to</th><th>Publication</th></tr></thead><tbody>${items.map(i=>`<tr><td><button data-lib-open="${esc(i.id)}">${esc(i.title)}</button><small>${i.kind==='reference'?'Reference':'Your content'}</small></td><td>${esc(format(i.format))}</td><td>${badge(i)}</td><td>${esc(i.campaign || '—')}</td><td>${esc(owner(i.owner_agent_id))}</td><td>${day(i.publish_date)}</td></tr>`).join('')}</tbody></table></div>`;
  }
  async function load(force=false){
    if(loading)return;loading=true;
    try{
      const result=await Promise.all([api('/content?archived='+q('#library-archived').checked),api('/agents'),api('/reports')]);
      const next=JSON.stringify(result);if(!force && next===signature)return;
      signature=next;[data,agents,reports]=result;
      const currentStage=q('#library-stage').value,campaign=q('#library-campaign').value;
      q('#library-stage').innerHTML='<option value="">All stages</option>'+options(data.stages,currentStage);
      q('#library-campaign').innerHTML='<option value="">All campaigns</option>'+options([...new Set(data.items.map(i=>i.campaign).filter(Boolean))].sort().map(c=>({id:c,label:c})),campaign);
      q('#library-error').textContent='';render();
    }catch(error){fail(error);q('#library-content').setAttribute('aria-busy','false');}
    finally{loading=false;}
  }

  document.body.insertAdjacentHTML('beforeend',`<dialog id="library-dialog" class="lib-dialog" aria-labelledby="library-dialog-title"><form id="library-form"><div class="lib-dialog-top"><div><span class="eyebrow">CONTENT RECORD</span><h2 id="library-dialog-title">New content</h2></div><button type="button" class="close-button" id="library-close" aria-label="Close content">×</button></div><div class="lib-editor-grid"><div><label>Title<input id="lib-title" maxlength="300" required placeholder="Give this content a working title"></label><div class="lib-field-grid"><label>Format<select id="lib-format" aria-label="Format" aria-describedby="lib-format-hint"></select><small id="lib-format-hint"></small></label><label>Ownership<select id="lib-kind"><option value="own">Your content</option><option value="reference">Reference / inspiration</option></select></label><label>Production stage<select id="lib-stage"></select></label><label>Assigned agent<select id="lib-owner_agent_id"></select></label><label>Campaign<input id="lib-campaign" maxlength="160" placeholder="e.g. Paris in autumn"></label><label>Tags<input id="lib-tags" placeholder="travel, Paris, budget"></label><label>Due date<input id="lib-due_date" type="date"></label><label>Publication date<input id="lib-publish_date" type="date"></label></div><div class="lib-editor-tabs" role="group" aria-label="Content details"><button type="button" data-lib-tab="brief" aria-pressed="true">Brief</button><button type="button" data-lib-tab="copy" aria-pressed="false">Script & caption</button><button type="button" data-lib-tab="files" aria-pressed="false">Files</button><button type="button" data-lib-tab="history" aria-pressed="false">History</button></div><div data-lib-panel="brief"><label>Audience<input id="lib-audience" maxlength="1000" placeholder="Who is this for?"></label><label>Objective<input id="lib-objective" maxlength="1000" placeholder="What should this content achieve?"></label><label>Content brief<textarea id="lib-brief" maxlength="20000" rows="8" placeholder="Concept, key points, required shots, references, and what success looks like…"></textarea></label><label>Reference / source link<input id="lib-source_url" type="url" maxlength="2048" placeholder="https://…"></label><label>Live post link<input id="lib-live_url" type="url" maxlength="2048" placeholder="Required when marking content Published"></label></div><div data-lib-panel="copy" hidden><label>Script<textarea id="lib-script" maxlength="60000" rows="16" placeholder="Your spoken script, scenes, and visual notes…"></textarea></label><label>Caption / description<textarea id="lib-caption" maxlength="12000" rows="7" placeholder="Publication copy, description, hashtags…"></textarea></label></div><div data-lib-panel="files" hidden><div class="lib-upload"><h3>Creative assets</h3><p>MP4, MOV, WebM · JPG, PNG, WebP · MP3, WAV, M4A · PDF, TXT, Markdown, SRT, VTT. Up to 250 MB per file, 50 files per record.</p><label>File role<select id="lib-file-role"><option value="footage">Footage</option><option value="thumbnail">Thumbnail / image</option><option value="script">Script / document</option><option value="captions">Subtitles / captions</option><option value="audio">Audio</option><option value="other">Other</option></select></label><label class="lib-file-picker">Choose files<input id="lib-upload-files" type="file" multiple></label><p id="lib-upload-hint">Save this record before adding files.</p></div><div id="lib-assets"></div></div><div data-lib-panel="history" hidden id="lib-history"></div></div><aside class="lib-editor-aside"><div id="lib-editor-cover"></div><label>Cover image<select id="lib-cover_asset_id"><option value="">Automatic / platform thumbnail</option></select></label><label>Linked agent outputs<select id="lib-report_ids" multiple size="6" aria-describedby="lib-output-hint"></select></label><small id="lib-output-hint">Choose saved outputs to keep this record connected to the team’s work. Ctrl / ⌘ selects multiple.</small><div id="lib-output-links"></div><div class="lib-agent-note"><h3>Keep the team in context.</h3><p>Saved briefs appear in agent context. Open a conversation to develop this content with the assigned agent.</p><button type="button" class="button secondary" id="lib-discuss">Discuss with agent ↗</button></div><p class="lib-footnote">Dates are plans. Marking content Published records a live link; it does not upload or publish.</p></aside></div><p id="lib-editor-error" class="form-error" role="alert"></p><p id="lib-editor-status" class="lib-feedback" role="status" aria-live="polite"></p><div class="lib-editor-footer"><button type="button" class="text-button" id="lib-archive" hidden>Archive content</button><div><button type="button" class="button secondary" id="lib-cancel">Close</button><button class="button primary" id="lib-save">Save content</button></div></div></form></dialog><dialog id="library-import-dialog" class="lib-import-dialog"><div class="lib-dialog-top"><div><span class="eyebrow">BRING YOUR WORK TOGETHER</span><h2>Import existing content</h2></div><button class="close-button" id="lib-import-close" aria-label="Close import">×</button></div><p>Collected videos become references. Connected account posts become your content. Imports save links and metadata; no media is downloaded.</p><input id="lib-import-search" type="search" placeholder="Search collected videos and connected posts" aria-label="Search import candidates"><div id="lib-import-results"></div><p id="lib-import-error" class="form-error" role="alert"></p></dialog>`);

  const dialog=q('#library-dialog');
  function blank(){return {...Object.fromEntries(fields.map(key=>[key,key==='format'?'youtube_video':key==='kind'?'own':key==='stage'?'idea':''])),tags:[],report_ids:[],assets:[],changes:[]};}
  function formValue(){
    return {...Object.fromEntries(fields.map(key=>[key,q('#lib-'+key).value.trim()])),tags:q('#lib-tags').value.split(',').map(s=>s.trim()).filter(Boolean),report_ids:[...q('#lib-report_ids').selectedOptions].map(o=>o.value)};
  }
  function dirty(){return current && JSON.stringify(formValue())!==JSON.stringify(Object.fromEntries([...fields,'tags','report_ids'].map(key=>[key,current[key]])));}
  function formatHint(){const f=data.formats.find(f=>f.id===q('#lib-format').value);q('#lib-format-hint').textContent=f?.ratio?'Suggested canvas: '+f.ratio+'. Confirm platform requirements before delivery.':'Flexible document or media format.';}
  function selectTab(name){document.querySelectorAll('[data-lib-panel]').forEach(p=>p.hidden=p.dataset.libPanel!==name);document.querySelectorAll('[data-lib-tab]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.libTab===name)));}
  function fileRows(){
    q('#lib-upload-files').disabled=!current.id;q('#lib-upload-files').accept=(data.upload_extensions || []).join(',');
    q('#lib-upload-hint').textContent=current.id?'Files are stored locally with this private workspace.':'Save this record before adding files.';
    q('#lib-assets').innerHTML=current.assets.length?current.assets.map(a=>`<article class="lib-asset"><div><strong>${esc(a.filename)}</strong><small>${esc(a.role)} · ${(a.size/1024/1024).toFixed(2)} MB</small></div><a href="${assetUrl(current,a.id)}?download=true" download>Download ↗</a><button type="button" data-lib-remove-asset="${esc(a.id)}" aria-label="Remove ${esc(a.filename)}">×</button>${a.media_type.startsWith('image/')?`<img src="${assetUrl(current,a.id)}" alt="${esc(a.filename)}" loading="lazy">`:a.media_type.startsWith('video/')?`<video controls preload="none" src="${assetUrl(current,a.id)}"></video>`:a.media_type.startsWith('audio/')?`<audio controls preload="none" src="${assetUrl(current,a.id)}"></audio>`:''}</article>`).join(''):'<p class="lib-footnote">No files attached yet. Keep the footage, thumbnail, script, and subtitles together here.</p>';
    q('#lib-history').innerHTML=current.changes.map(c=>`<div class="lib-history-entry"><span>${esc(c.message)}</span><time>${new Date(c.created*1000).toLocaleString()}</time></div>`).join('') || '<p class="lib-footnote">Your saved changes will appear here.</p>';
  }
  function fill(item){
    current=item;
    q('#library-dialog-title').textContent=item.id?'Content details':'New content';
    q('#lib-format').innerHTML=options(data.formats,item.format);q('#lib-stage').innerHTML=options(data.stages,item.stage);
    q('#lib-owner_agent_id').innerHTML='<option value="">Unassigned</option>'+options(agents,item.owner_agent_id);
    q('#lib-cover_asset_id').innerHTML='<option value="">Automatic / platform thumbnail</option>'+options(item.assets.filter(a=>a.media_type.startsWith('image/')).map(a=>({id:a.id,label:a.filename})),item.cover_asset_id);
    fields.forEach(key=>q('#lib-'+key).value=item[key]);q('#lib-tags').value=item.tags.join(', ');
    q('#lib-report_ids').innerHTML=reports.map(r=>`<option value="${esc(r.id)}" ${item.report_ids.includes(r.id)?'selected':''}>${esc(r.title || r.topic || 'Saved output')}</option>`).join('');
    // Preserve linked older outputs even if they fall outside the recent output list.
    item.report_ids.filter(id=>!reports.some(r=>r.id===id)).forEach(id=>q('#lib-report_ids').insertAdjacentHTML('beforeend',`<option value="${esc(id)}" selected>Saved output ${esc(id.slice(0,8))}</option>`));
    q('#lib-output-links').innerHTML=item.report_ids.map(id=>`<button type="button" class="text-button" data-lib-output="${esc(id)}">Open linked output ↗</button>`).join('');
    q('#lib-editor-cover').innerHTML=cover(item);q('#lib-editor-error').textContent='';q('#lib-editor-status').textContent='';
    q('#lib-archive').hidden=!item.id;q('#lib-archive').textContent=item.archived?'Restore to library':'Archive content';
    fileRows();formatHint();
  }
  async function open(id,defaults={}){
    try{if(!data.formats.length)await load(true);fill(id?await api('/content/'+encodeURIComponent(id)):{...blank(),...defaults});selectTab('brief');if(!dialog.open)dialog.showModal();}
    catch(error){fail(error);}
  }
  function close(){if(busy)return;if(dirty() && !window.confirm('Close without saving your changes?'))return;dialog.close();current=null;}
  async function persist(){
    if(!q('#library-form').reportValidity())return false;
    const saved=await api('/content'+(current.id?'/'+encodeURIComponent(current.id):''),current.id?'PUT':'POST',{...formValue(),...(current.id?{version:current.version}:{})});
    fill(saved);q('#lib-editor-status').textContent='Saved to your content library.';await load(true);return true;
  }
  async function editorAction(work){
    if(busy)return;busy=true;q('#library-form').inert=true;q('#lib-save').disabled=true;q('#lib-editor-error').textContent='';
    try{await work();}catch(error){q('#lib-editor-error').textContent=error.message;}
    finally{busy=false;q('#library-form').inert=false;q('#lib-save').disabled=false;}
  }
  async function move(id,nextStage){
    try{const item=await api('/content/'+encodeURIComponent(id));if(item.stage===nextStage)return;const value=Object.fromEntries([...fields,'tags','report_ids','version'].map(key=>[key,item[key]]));await api('/content/'+encodeURIComponent(id),'PUT',{...value,stage:nextStage});feedback('Moved to '+stage(nextStage)+'.');await load(true);}
    catch(error){fail(error);await open(id);q('#lib-stage').value=nextStage;q('#lib-editor-error').textContent=error.message;render();}
  }
  function importRows(){const query=q('#lib-import-search').value.toLowerCase();q('#lib-import-results').innerHTML=candidates.filter(c=>(c.title+' '+c.label).toLowerCase().includes(query)).map((c)=>`<div class="lib-import-row"><div><strong>${esc(c.title)}</strong><small>${esc(c.label)} · ${c.kind==='own'?'Your account post':'Collected reference'}</small></div><button class="button secondary compact" data-lib-import-source="${esc(c.source)}" data-lib-import-id="${esc(c.external_id)}">Add to library</button></div>`).join('') || '<div class="lib-empty"><h3>No existing content found</h3><p>Collect watchlist videos, or connect your account and sync its 28-day analytics to import recent posts.</p><a href="#connections" id="lib-import-connections">Connections & analytics ↗</a></div>';}
  async function importOpen(){q('#lib-import-error').textContent='';q('#lib-import-results').textContent='Loading…';q('#library-import-dialog').showModal();try{candidates=await api('/content/import-candidates');q('#lib-import-search').value='';importRows();}catch(e){q('#lib-import-error').textContent=e.message;}}
  async function importOne(source,external_id){
    try{const saved=await api('/content/import','POST',{source,external_id});q('#library-import-dialog').close();location.hash='library';await load(true);await open(saved.id);feedback(saved.archived?'This item was previously imported and archived. Restore it from its content record.':'Content added. Repeated imports open the existing record.');}
    catch(error){q('#lib-import-error').textContent=error.message;fail(error);}
  }
  async function binary(path,method='GET',body,retry=true){
    await window.spurAuth.ready;const auth=window.spurAuth;
    const response=await fetch(path,{method,credentials:'same-origin',cache:'no-store',headers:{'X-Spur-User':auth.user.id,'X-Spur-Profile':auth.mockProfile?.id || 'personal',...(method!=='GET'?{'X-CSRF-Token':auth.csrfToken,'Content-Type':'application/octet-stream'}:{})},...(body?{body}:{})});
    if(['account','workspace'].includes(response.headers.get('X-Spur-Session-Error'))){location.reload();throw new Error('Account changed. Reloading.');}
    if(response.status===403 && retry && response.headers.get('X-Spur-Session-Error')==='csrf'){await auth.refreshSession();return binary(path,method,body,false);}
    if(response.status===401)auth.expired();
    if(!response.ok){const error=await response.json();throw new Error(typeof error.detail==='string'?error.detail:'File request failed.');}return response;
  }
  q('#library-new').addEventListener('click',()=>open());q('#library-import').addEventListener('click',importOpen);
  q('#library-close').addEventListener('click',close);q('#lib-cancel').addEventListener('click',close);
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  q('#lib-import-close').addEventListener('click',()=>q('#library-import-dialog').close());q('#lib-import-search').addEventListener('input',importRows);
  q('#library-form').addEventListener('submit',event=>{event.preventDefault();editorAction(persist);});
  q('#lib-format').addEventListener('change',formatHint);
  ['search','kind','stage','campaign'].forEach(key=>q('#library-'+key).addEventListener(key==='search'?'input':'change',render));
  q('#library-archived').addEventListener('change',()=>load(true));
  q('#lib-archive').addEventListener('click',()=>editorAction(async()=>{if(dirty() && !await persist())return;const saved=await api('/content/'+current.id+'/archive','POST',{archived:!current.archived,version:current.version});dialog.close();current=null;feedback(saved.archived?'Content archived. Find it with the Archived filter.':'Content restored.');await load(true);}));
  q('#lib-discuss').addEventListener('click',()=>editorAction(async()=>{if((!current.id || dirty()) && !await persist())return;const agent=current.owner_agent_id || 'coordinator';const accepted=window.dispatchEvent(new CustomEvent('spur:library-chat',{cancelable:true,detail:{agentId:agent,content:`Help me develop this content library record: ${current.title} (content ID: ${current.id}). Review its saved brief, current stage, and linked outputs. Suggest the next concrete steps; distinguish planned content from completed production. I will review your proposal before starting work.`}}));if(accepted){dialog.close();current=null;}}));
  q('#lib-upload-files').addEventListener('change',()=>{const files=[...q('#lib-upload-files').files];const role=q('#lib-file-role').value;editorAction(async()=>{if(dirty() && !await persist())return;for(const file of files){if(file.size>data.max_asset_bytes)throw new Error(file.name+' exceeds the 250 MB limit.');q('#lib-editor-status').textContent='Uploading '+file.name+'…';const response=await binary('/content/'+current.id+'/assets?filename='+encodeURIComponent(file.name)+'&role='+role,'POST',file);fill(await response.json());}q('#lib-editor-status').textContent='Files added.';q('#lib-upload-files').value='';await load(true);});});
  q('#library-export').addEventListener('change',async event=>{const kind=event.target.value;event.target.value='';if(!kind)return;try{const response=await binary('/content/export?format='+kind+'&archived='+q('#library-archived').checked);const blob=await response.blob(),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='spur-content-library.'+kind;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);feedback('Exported '+kind.toUpperCase()+' metadata. Attached media stays in local storage.');}catch(error){fail(error);}});
  document.addEventListener('click',event=>{
    const button=event.target.closest('[data-lib-open],[data-lib-view],[data-lib-tab],[data-lib-new],[data-lib-new-stage],[data-lib-date],[data-lib-month],[data-lib-import-open],[data-lib-import-source],[data-lib-remove-asset],[data-lib-output]');if(!button)return;
    if(button.dataset.libOpen)open(button.dataset.libOpen);
    if(button.dataset.libView){view=button.dataset.libView;render();}
    if(button.dataset.libTab)selectTab(button.dataset.libTab);
    if(button.hasAttribute('data-lib-new'))open();
    if(button.dataset.libNewStage)open(null,{stage:button.dataset.libNewStage});
    if(button.dataset.libDate)open(null,{publish_date:button.dataset.libDate});
    if(button.dataset.libMonth){month=button.dataset.libMonth==='today'?new Date(new Date().getFullYear(),new Date().getMonth(),1):new Date(month.getFullYear(),month.getMonth()+Number(button.dataset.libMonth),1);render();}
    if(button.hasAttribute('data-lib-import-open'))importOpen();
    if(button.dataset.libImportSource){button.disabled=true;importOne(button.dataset.libImportSource,button.dataset.libImportId).finally(()=>button.disabled=false);}
    if(button.dataset.libRemoveAsset)editorAction(async()=>{if(!window.confirm('Remove this file from local storage?'))return;if(dirty() && !await persist())return;fill(await api('/content/'+current.id+'/assets/'+button.dataset.libRemoveAsset,'DELETE'));await load(true);});
    if(button.dataset.libOutput){dialog.close();current=null;window.dispatchEvent(new CustomEvent('spur:library-output',{detail:{id:button.dataset.libOutput}}));}
  });
  document.addEventListener('click',event=>{if(event.target.closest('#lib-import-connections'))q('#library-import-dialog').close();});
  q('#library-content').addEventListener('change',event=>{if(event.target.dataset.libStage)move(event.target.dataset.libStage,event.target.value);});
  q('#library-content').addEventListener('dragstart',event=>{const card=event.target.closest('[data-lib-drag]');if(card){event.dataTransfer.setData('text/plain',card.dataset.libDrag);event.dataTransfer.effectAllowed='move';}});
  q('#library-content').addEventListener('dragover',event=>{if(event.target.closest('[data-lib-column]'))event.preventDefault();});
  q('#library-content').addEventListener('drop',event=>{const column=event.target.closest('[data-lib-column]'),id=event.dataTransfer.getData('text/plain');if(column && data.items.some(i=>i.id===id)){event.preventDefault();move(id,column.dataset.libColumn);}});
  document.addEventListener('error',event=>{if(event.target.matches('.lib-cover img'))event.target.hidden=true;},true);
  window.spurLibrary={load,open,importOne};
})();
