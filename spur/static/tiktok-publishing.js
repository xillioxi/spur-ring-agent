(() => {
 'use strict';
 const q=s=>document.querySelector(s),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const api=async(p,m='GET',v)=>{await window.spurAuth.ready;return window.spurAuth.request(p,m,v);};
 const labels={PUBLIC_TO_EVERYONE:'Everyone',MUTUAL_FOLLOW_FRIENDS:'Friends',FOLLOWER_OF_CREATOR:'Followers',SELF_ONLY:'Only me'};
 const names={inbox_delivered:'Sent to TikTok · finish in the TikTok app',awaiting_tiktok:'Waiting for TikTok · check status later',upload_incomplete:'Upload incomplete',upload_pending:'Uploading',processing:'TikTok is processing',uncertain:'Check TikTok · outcome uncertain'};
 let data=null,busy=false,loading=false,last=0,editing=null,review=null,previewUrl='';
 const active=()=>q('#publishing-destination').value==='tiktok';
 const safe=v=>{try{return new URL(v).protocol==='https:'?esc(v):'';}catch{return '';}};
 function select(platform){
  if(busy)return;q('#publishing-destination').value=platform;
  q('#publishing-instagram').hidden=platform==='tiktok';q('#publishing-tiktok').hidden=platform!=='tiktok';
  sessionStorage.setItem('spur_publish_destination',platform);
  if(platform==='tiktok')load(true);else window.spurPublishing?.load(true);
 }
 async function load(force=false){
  if(!active() || busy || loading || !force && Date.now()-last<15000)return;
  await window.spurAuth.ready;const mock=!!window.spurAuth.mockProfile;
  q('#tt-mock').hidden=!mock;q('#tt-workspace').hidden=mock;q('#tt-connect').hidden=mock;
  if(mock){q('#tt-account').textContent='Creator reference workspace';q('#tt-capabilities').textContent='Authorize your own TikTok account in your personal workspace.';q('#tt-connection-note').textContent='';return;}
  loading=true;last=Date.now();
  try{
   data=await api('/publishing/tiktok');const c=data.connection,creator=data.creator;
   q('#tt-account').textContent=c.connected?(creator?.creator_nickname || c.account_name)+' · TikTok':'Connect your TikTok account';
   q('#tt-capabilities').textContent=c.connected?`Direct Post: ${c.direct_enabled?'authorized':'not authorized'} · Upload to inbox: ${c.inbox_enabled?'authorized':'not authorized'}`:'Your account authorizes access through TikTok. Tokens stay encrypted in the backend.';
   q('#tt-connect').textContent=c.connected?'Reconnect TikTok posting permissions':'Connect TikTok for posting';
   q('#tt-connection-note').textContent=[c.setup_issue,data.creator_error,c.audit_approved?'Direct Post audit approval is recorded for this app.':'TikTok testing: unaudited Direct Post apps require a private account and Only me visibility. Upload to TikTok lets you finish editing and posting in TikTok.'].filter(Boolean).join(' ');
   const html=data.items.map(p=>`<article class="panel publishing-post"><div><span class="eyebrow">TIKTOK · ${esc(names[p.status] || p.status)}</span><h3>${esc(p.caption.slice(0,90) || 'Untitled TikTok video')}</h3><p class="publishing-caption">${esc(p.caption)}</p><small>${p.method==='inbox'?'Upload to TikTok':'Direct Post'} · ${Number(p.media.duration).toFixed(1)} seconds${p.account_name?' · '+esc(p.account_name):''}${p.scheduled_at?' · '+new Date(p.scheduled_at*1000).toLocaleString():''}</small>${p.error?`<p class="notice">${esc(p.error)}</p>`:''}${['upload_pending','uploading','processing'].includes(p.status)?`<progress aria-label="TikTok video bytes uploaded" value="${Number(p.uploaded_bytes || 0)}" max="${Number(p.media.size)}"></progress><small>${(Number(p.uploaded_bytes || 0)/1048576).toFixed(1)} / ${(Number(p.media.size)/1048576).toFixed(1)} MB uploaded</small>`:''}${p.publish_id?`<small>TikTok reference: ${esc(p.publish_id)}</small>`:''}</div><div class="publishing-post-actions">${p.status==='draft'?`<button class="button secondary" data-tt-edit="${p.id}">Edit draft</button><button class="button primary" data-tt-review="${p.id}">${p.method==='inbox'?'Review & upload':'Review & post'}</button>`:''}${['draft','queued','scheduled'].includes(p.status)?`<button class="button secondary" data-tt-cancel="${p.id}">Cancel ${p.status==='draft'?'draft':'queued upload'}</button>`:''}${p.publish_id && !['published','cancelled'].includes(p.status)?`<button class="button secondary" data-tt-status="${p.id}">Check TikTok status</button>`:''}${p.account_username?(p.post_ids || []).map(id=>`<a class="button secondary" href="https://www.tiktok.com/@${esc(p.account_username)}/video/${esc(id)}" target="_blank" rel="noopener noreferrer">View TikTok post ↗</a>`).join(''):(p.post_ids || []).map(id=>`<small>Published video ID: ${esc(id)}</small>`).join('')}</div></article>`).join('');
   q('#tt-posts').innerHTML=html || '<section class="panel publishing-account"><div><h3>Your first TikTok starts here</h3><p>Upload your own MP4, save a draft, then review the account and posting options.</p></div></section>';
  }catch(e){q('#tt-error').textContent=e.message;}finally{loading=false;}
 }
 async function act(work){if(busy)return;busy=true;q('#publishing-destination').disabled=true;q('#tt-error').textContent='';try{await work();}catch(e){q('#tt-error').textContent=e.message;}finally{busy=false;q('#publishing-destination').disabled=false;await load(true);}}
 function preview(){
  if(previewUrl)URL.revokeObjectURL(previewUrl);const file=q('#tt-file').files[0];previewUrl=file?URL.createObjectURL(file):'';
  const src=previewUrl || (editing?`/content/${editing.content_id}/assets/${editing.asset_id}`:'');
  q('#tt-preview').innerHTML=src?`<video controls preload="metadata" src="${esc(src)}"></video>`:'<p>Your video preview will appear here.</p>';
  q('#tt-caption-preview').textContent=q('#tt-caption').value;
  q('#tt-method-note').textContent=q('#tt-method').value==='inbox'?'TikTok sends an inbox notification. Open it to edit and publish; uploading alone does not publish your video. Add the saved caption in TikTok when finishing.':'Review your TikTok account, visibility, interactions and content disclosures before sending. TikTok’s processing and moderation still apply.';
 }
 function reset(){editing=null;q('#tt-form').reset();q('#tt-save').textContent='Save TikTok draft';q('#tt-edit-cancel').hidden=true;preview();}
 q('#publishing-destination').addEventListener('change',()=>select(q('#publishing-destination').value));
 document.addEventListener('click',e=>{const link=e.target.closest('[data-publish-platform]');if(link)select(link.dataset.publishPlatform);});
 for(const id of ['tt-file','tt-method','tt-caption'])q('#'+id).addEventListener(id==='tt-caption'?'input':'change',preview);
 q('#tt-edit-cancel').addEventListener('click',reset);
 q('#tt-connect').addEventListener('click',()=>act(async()=>{if(data?.connection.setup_issue)throw Error(data.connection.setup_issue+' Open Provider app setup to finish configuration.');const r=await api('/social/tiktok/connect?publishing=true','POST');location.assign(r.authorization_url);}));
 q('#tt-form').addEventListener('submit',e=>{e.preventDefault();act(async()=>{
  const file=q('#tt-file').files[0],caption=q('#tt-caption').value,method=q('#tt-method').value;
  let content_id=editing?.content_id,asset_id=editing?.asset_id;
  if(file){
   if(!/\.mp4$/i.test(file.name) || file.size>250*1024*1024)throw Error('Choose an MP4 video up to 250 MB.');
   q('#tt-status').textContent='Saving your video to the private content library…';
   const c=await api('/content','POST',{title:caption.slice(0,100) || 'TikTok video draft',format:'tiktok_video',kind:'own',stage:'drafting',caption});content_id=c.id;
   const auth=window.spurAuth,r=await fetch(`/content/${c.id}/assets?filename=${encodeURIComponent(file.name)}&role=footage`,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/octet-stream','X-CSRF-Token':auth.csrfToken,'X-Spur-User':auth.user.id,'X-Spur-Profile':'personal'},body:file});
   const result=await r.json();if(!r.ok)throw Error(result.detail || 'Video upload failed. The library draft is saved.');asset_id=result.assets.find(a=>a.filename===file.name)?.id;
  }
  if(!content_id || !asset_id)throw Error('Choose your MP4 video first.');
  await api('/publishing/tiktok'+(editing?'/'+editing.id:''),editing?'PUT':'POST',{caption,method,content_id,asset_id,...(editing?{version:editing.version}:{})});
  reset();q('#tt-status').textContent='TikTok draft saved. Review the account and video before sending.';
 });});
 function choices(){return {privacy_level:q('#tt-privacy').value,allow_comment:q('#tt-comment').checked,allow_duet:q('#tt-duet').checked,allow_stitch:q('#tt-stitch').checked,commercial:q('#tt-commercial').checked,own_brand:q('#tt-own-brand').checked,branded_content:q('#tt-branded').checked,is_aigc:q('#tt-aigc').checked,music_confirmed:q('#tt-music').checked,branded_confirmed:q('#tt-branded-confirm').checked,confirmed:q('#tt-confirmed').checked};}
 function validate(){
  if(!review)return;const v=choices(),direct=review.post.method==='direct';
  q('#tt-brand-options').hidden=!v.commercial;q('#tt-branded-confirm-label').hidden=!v.branded_content;
  let message='';
  if(direct && !v.privacy_level)message='Choose who can watch this video.';
  else if(direct && !review.connection.audit_approved && (v.privacy_level!=='SELF_ONLY' || review.review.creator.privacy_level_options.includes('PUBLIC_TO_EVERYONE')))message='TikTok restricts unaudited Direct Post to private accounts and Only me posts. Choose Upload to TikTok instead, or complete the app audit.';
  else if(direct && v.commercial && !v.own_brand && !v.branded_content)message='Choose Your brand, Branded content, or both.';
  else if(direct && v.branded_content && v.privacy_level==='SELF_ONLY')message='Paid partnership cannot use Only me visibility.';
  else if(direct && !v.music_confirmed)message='Confirm TikTok’s Music Usage Confirmation.';
  else if(direct && v.branded_content && !v.branded_confirmed)message='Confirm TikTok’s Branded Content Policy.';
  else if(!v.confirmed)message='Approve sending this video to the account shown above.';
  q('#tt-review-error').textContent=message;q('#tt-submit').disabled=busy || !!message;
 }
 q('#tt-commercial').addEventListener('change',()=>{if(!q('#tt-commercial').checked){q('#tt-own-brand').checked=false;q('#tt-branded').checked=false;q('#tt-branded-confirm').checked=false;}validate();});
 for(const id of ['tt-privacy','tt-comment','tt-duet','tt-stitch','tt-own-brand','tt-branded','tt-music','tt-branded-confirm','tt-confirmed'])q('#'+id).addEventListener('change',validate);
 document.addEventListener('click',e=>{
  const b=e.target.closest('[data-tt-edit],[data-tt-review],[data-tt-cancel],[data-tt-status]');if(!b || busy)return;
  if(b.dataset.ttEdit){editing=data.items.find(p=>p.id===b.dataset.ttEdit);q('#tt-form').reset();q('#tt-method').value=editing.method;q('#tt-caption').value=editing.caption;q('#tt-save').textContent='Save TikTok changes';q('#tt-edit-cancel').hidden=false;preview();q('#tt-caption').focus();return;}
  if(b.dataset.ttCancel){act(()=>api(`/publishing/tiktok/${b.dataset.ttCancel}/cancel`,'POST'));return;}
  if(b.dataset.ttStatus){act(()=>api(`/publishing/tiktok/${b.dataset.ttStatus}/status`,'POST'));return;}
  act(async()=>{
   review=await api(`/publishing/tiktok/${b.dataset.ttReview}/review`,'POST');const p=review.post,c=review.review.creator,direct=p.method==='direct';
   q('#tt-review-form').reset();q('#tt-review-account').textContent=(direct?'Post to ':'Upload to ')+(c.creator_nickname || review.connection.account_name)+(c.creator_username?' (@'+c.creator_username+')':'');
   q('#tt-review-media').innerHTML=`<video controls preload="metadata" src="/content/${esc(p.content_id)}/assets/${esc(p.asset_id)}"></video>`;q('#tt-review-caption').textContent=p.caption;
   q('#tt-direct-options').hidden=!direct;q('#tt-privacy').required=direct;
   q('#tt-privacy').innerHTML='<option value="">Choose visibility…</option>'+(c.privacy_level_options || []).map(v=>`<option value="${esc(v)}">${esc(labels[v] || v)}</option>`).join('');q('#tt-privacy').value='';
   for(const kind of ['comment','duet','stitch']){const box=q('#tt-'+kind);box.checked=false;box.disabled=!direct || c[kind+'_disabled']!==false;}
   q('#tt-brand-options').hidden=true;q('#tt-branded-confirm-label').hidden=true;
   q('#tt-review-note').textContent=direct?`${p.media.duration.toFixed(1)} second video · Account maximum ${c.max_video_post_duration_sec} seconds. Choose visibility and interactions explicitly.`:'This sends a video to your TikTok inbox. Open TikTok’s notification to edit and publish. The caption is saved in Spur Ring; add it in TikTok when finishing.';
   q('#tt-submit').textContent=direct?'Confirm TikTok post':'Confirm upload to TikTok';q('#tt-review-dialog').showModal();
  }).then(validate);
 });
 q('#tt-review-close').addEventListener('click',()=>{q('#tt-review-dialog').close();review=null;});
 q('#tt-review-form').addEventListener('submit',e=>{e.preventDefault();if(!review || busy)return;act(async()=>{
  const v=choices(),scheduled=q('#tt-scheduled').value;
  const result=await api(`/publishing/tiktok/${review.post.id}/dispatch`,'POST',{...v,version:review.post.version,review_id:review.review.id,account_id:review.review.account_id,scheduled_at:scheduled?new Date(scheduled).getTime()/1000:null});
  q('#tt-review-dialog').close();review=null;q('#tt-status').textContent=result.status==='scheduled'?'TikTok upload scheduled. Keep Spur Ring’s backend and worker online.':'TikTok upload queued. Processing status updates here automatically.';
 }).then(validate);});
 setInterval(()=>{if(location.hash==='#publishing' && active())load();},15000);
 window.spurTikTokPublishing={load,select,validate};
 if(sessionStorage.getItem('spur_publish_destination')==='tiktok')select('tiktok');
})();
