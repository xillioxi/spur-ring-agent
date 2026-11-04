(() => {
 'use strict';
 const q=s=>document.querySelector(s),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const api=async(p,m='GET',v)=>{await window.spurAuth.ready;return window.spurAuth.request(p,m,v);};
 const postApi=(suffix='',method='GET',body)=>api('/publishing/instagram'+suffix+'?mode='+mode,method,body);
 let data=null,busy=false,last=0,review=null,reviewAccountId='',previewUrl='',editing=null,mode='instagram';
 const safe=v=>{try{const u=new URL(v);return u.protocol==='https:'?esc(v):'';}catch{return '';}};
 async function load(force=false){
  if(q('#publishing-destination').value==='tiktok'){window.spurTikTokPublishing?.load(force);return;}
  if(busy || !force && Date.now()-last<4000)return;last=Date.now();await window.spurAuth.ready;
  const mock=!!window.spurAuth.mockProfile && mode==='instagram';q('#publish-mock').hidden=!mock;q('#publish-workspace').hidden=mock;if(mock)return;
  try{data=await postApi();const c=data.connection;
   q('#publish-provider-label').textContent=mode==='demo'?'LOCAL INSTAGRAM SIMULATOR':'OFFICIAL INSTAGRAM API';
   q('#publish-kind-help').textContent=mode==='demo'?'Test photos and Reels entirely inside this workspace.':'Single JPEG posts and MP4 Reels. Your own authorized account only.';
   q('#publish-hosting-note').textContent=mode==='demo'?'Local uploads and simulated publishing work on localhost. No Instagram account, hosting or HTTPS setup is required.':'MP4 Reels upload directly from this computer to Meta through Facebook Login. Image posts need a publicly accessible HTTPS JPEG URL, or an HTTPS app address for uploaded JPEGs.';
   q('#publish-validation-note').textContent=mode==='demo'?'Local preview. No media is sent to Instagram.':'Instagram validates the media when processing your post.';
   q('#publish-setup').hidden=!c.setup_issue;q('#publish-setup').textContent=c.setup_issue || '';
   q('#publish-token-setup').hidden=mode!=='instagram';q('#publish-token-explorer').href=c.developer_url || 'https://developers.facebook.com/tools/explorer/';
   q('#publish-token-expiry').textContent=c.expires?`Authorization expires ${new Date(c.expires*1000).toLocaleString()}. Reconnect when needed.`:'';
   q('#publish-account').textContent=mode==='demo'?'Local Instagram demo · ready to test':c.connected?`Instagram @${c.account_name} · ${c.publish_permission && c.authorization_current?'Publishing authorized':'Reconnect with publishing permission'}`:'Connect your own Instagram Business or Creator account.';
   q('#publish-demo-tools').hidden=mode!=='demo';q('#publish-connect').hidden=mode==='demo';q('#publish-demo-notice').hidden=mode!=='demo';q('#publish-connect').textContent=c.publish_permission?'Reconnect Instagram':'Connect Instagram for publishing';
   const facebookAction = post => {
     if(mode !== 'instagram' || post.status !== 'published' || post.media_type !== 'reel' || !post.asset_id) return '';
     const entry = (data.facebook || []).find(item => item.source_id === post.id);
     if(entry?.video_id) return `<a class="button secondary" href="https://www.facebook.com/watch/?v=${esc(entry.video_id)}" target="_blank" rel="noopener">View Facebook video</a>`;
     if(entry) return `<small>Facebook · ${esc(entry.status)} ${esc(entry.message || '')}</small>`;
     return `<button class="button secondary" data-facebook-share="${esc(post.id)}">Post video to Facebook Page</button>`;
   };
   const html=data.items.map(p=>`<article class="panel publishing-post"><div><span class="eyebrow">${mode==='demo'?'LOCAL DEMO · ':''}${esc(p.media_type)} · ${esc(p.status==='published' && mode==='demo'?'Published locally':p.status)}</span><h3>${esc(p.caption.slice(0,90) || 'Untitled post')}</h3><p class="publishing-caption">${esc(p.caption)}</p><small>${p.account_name?'@'+esc(p.account_name)+' · ':''}${p.scheduled_at?new Date(p.scheduled_at*1000).toLocaleString(): 'Saved draft'}</small>${p.error?`<p class="notice">${esc(p.error)}</p>`:''}</div>${mode==='demo' && p.status==='published' && p.asset_id?`<div class="publishing-feed-media">${p.media_type==='reel'?`<video controls preload="metadata" src="/content/${esc(p.content_id)}/assets/${esc(p.asset_id)}"></video>`:`<img loading="lazy" alt="Local demo post" src="/content/${esc(p.content_id)}/assets/${esc(p.asset_id)}">`}</div>`:''}<div class="publishing-post-actions">${p.status==='draft'?`<button class="button secondary" data-publish-edit="${p.id}">Edit draft</button><button class="button primary" data-publish-review="${p.id}">Review & publish</button>`:''}${['queued','scheduled'].includes(p.status)?`<button class="button secondary" data-publish-reschedule="${p.id}">Change time</button>`:''}${['draft','queued','scheduled'].includes(p.status)?`<button class="button secondary" data-publish-cancel="${p.id}">Cancel ${p.status==='draft'?'draft':'publication'}</button>`:''}${facebookAction(p)}${safe(p.permalink)?`<a class="button secondary" href="${safe(p.permalink)}" target="_blank" rel="noopener noreferrer">View on Instagram ↗</a>`:''}</div></article>`).join('');
   if(q('#publish-posts').innerHTML!==html)q('#publish-posts').innerHTML=html || '<section class="panel"><h3>Your first post starts here</h3><p>Save a draft, review it, then choose when to publish.</p></section>';
  }catch(e){q('#publish-error').textContent=e.message;}
 }
 async function act(work){if(busy)return;busy=true;q('#publish-error').textContent='';try{await work();}catch(e){q('#publish-error').textContent=e.message;}finally{busy=false;await load(true);}}
 function preview(){
  const file=q('#publish-file').files[0],url=q('#publish-url').value.trim(),type=q('#publish-type').value;
  if(previewUrl)URL.revokeObjectURL(previewUrl);previewUrl=file?URL.createObjectURL(file):'';
  const src=previewUrl || safe(url) || (editing?.asset_id?`/content/${editing.content_id}/assets/${editing.asset_id}`:'');q('#publish-preview').innerHTML=src?(type==='reel'?`<video controls preload="metadata" src="${src}"></video>`:`<img src="${src}" alt="Post media preview" referrerpolicy="no-referrer">`):'<p>Your media preview will appear here.</p>';
  q('#publish-caption-preview').textContent=q('#publish-caption').value;
 }
 q('#publish-file').addEventListener('change',preview);q('#publish-url').addEventListener('change',preview);q('#publish-type').addEventListener('change',preview);q('#publish-caption').addEventListener('input',()=>q('#publish-caption-preview').textContent=q('#publish-caption').value);
 q('#publish-connect').addEventListener('click',()=>act(async()=>{if(data?.connection.setup_issue)throw Error(data.connection.setup_issue);const result=await api('/social/instagram/connect?publishing=true','POST');location.assign(result.authorization_url);}));
 q('#publish-token-form').addEventListener('submit',event=>{event.preventDefault();act(async()=>{
  const field=q('#publish-token'),token=field.value.trim();field.value='';
  const result=await api('/social/instagram/developer-token','POST',{access_token:token});
  q('#publish-status').textContent=result.status==='choose_account'?'Authorized. Choose the Instagram account in Connections & Analytics.':`Connected Instagram @${result.account_name}. Live publishing and official creator imports can use this connection.`;
 });});
 q('#publish-demo-examples').addEventListener('click',()=>act(async()=>{if(mode!=='demo')return;await window.spurPublishingDemo.generate(message=>q('#publish-status').textContent=message);}));
 q('#publish-edit-cancel').addEventListener('click',()=>{editing=null;q('#publish-form').reset();q('#publish-save').textContent='Save draft';q('#publish-edit-cancel').hidden=true;preview();});
 q('#publish-form').addEventListener('submit',event=>{event.preventDefault();act(async()=>{
  const file=q('#publish-file').files[0],url=q('#publish-url').value.trim(),media_type=q('#publish-type').value,caption=q('#publish-caption').value;
  if(file && url || !file && !url && !editing?.asset_id)throw Error('Choose either one uploaded file or one hosted media URL.');
  let content_id=!file && !url && editing?editing.content_id:'',asset_id=!file && !url && editing?editing.asset_id:'';
  if(file){
   if(file.size>250*1024*1024)throw Error('Choose a file up to 250 MB.');
   if(!(media_type==='image'?/\.jpe?g$/i:/\.mp4$/i).test(file.name))throw Error('Choose a JPEG image or an MP4 Reel.');
   q('#publish-status').textContent='Uploading to your private content library…';
   const content=await api('/content','POST',{title:caption.slice(0,100) || 'Instagram publishing draft',format:media_type==='reel'?'instagram_reel':'image_post',kind:'own',stage:'drafting',caption});content_id=content.id;
   const auth=window.spurAuth,response=await fetch(`/content/${content_id}/assets?filename=${encodeURIComponent(file.name)}&role=footage`,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/octet-stream','X-CSRF-Token':auth.csrfToken,'X-Spur-User':auth.user.id,'X-Spur-Profile':'personal'},body:file});
   const result=await response.json();if(!response.ok)throw Error(result.detail || 'Upload failed. Your library draft is saved.');
   // The library upload returns the updated content record.
   asset_id=result.assets.find(a=>a.filename===file.name)?.id;if(!asset_id)throw Error('Uploaded asset was not returned. Check the content library.');
  }
  await postApi(editing?'/'+editing.id:'',editing?'PUT':'POST',{caption,media_type,media_url:url,content_id,asset_id,...(editing?{version:editing.version}:{})});editing=null;q('#publish-save').textContent='Save draft';q('#publish-edit-cancel').hidden=true;q('#publish-status').textContent='Draft saved. Review the account and content before publishing.';q('#publish-form').reset();preview();
 });});
 document.addEventListener('click',event=>{
  const b=event.target.closest('[data-publish-review],[data-publish-cancel],[data-publish-edit],[data-publish-reschedule]');if(!b)return;
  if(b.dataset.publishEdit){editing=data?.items.find(p=>p.id===b.dataset.publishEdit);if(!editing)return;q('#publish-form').reset();q('#publish-type').value=editing.media_type;q('#publish-url').value=editing.media_url;q('#publish-caption').value=editing.caption;q('#publish-save').textContent='Save changes';q('#publish-edit-cancel').hidden=false;q('#publish-caption').focus();preview();return;}
  if(b.dataset.publishCancel){act(()=>postApi(`/${b.dataset.publishCancel}/cancel`,'POST'));return;}
  review=data?.items.find(p=>p.id===(b.dataset.publishReview || b.dataset.publishReschedule));if(!review)return;
  reviewAccountId=data.connection.account_id || '';
  q('#publish-confirm-text').textContent=mode==='demo'?'Simulate this publication locally. Nothing will be sent to Instagram.':'I approve publishing this media and caption to the Instagram account shown above.';
  q('#publish-review-form button[type="submit"]').textContent=b.dataset.publishReschedule?'Save publication time':mode==='demo'?'Publish locally':'Confirm publication';
  q('#publish-review-account').textContent=mode==='demo'?'Preview · local demo feed':data.connection.account_name?'Publish to Instagram @'+data.connection.account_name:'Preview · Instagram account not connected';
  q('#publish-review-caption').textContent=review.caption;
  const url=review.media_url || `/content/${review.content_id}/assets/${review.asset_id}`;
  q('#publish-review-media').innerHTML=review.media_type==='reel'?`<video controls preload="metadata" src="${esc(url)}"></video>`:`<img src="${esc(url)}" alt="Media to publish" referrerpolicy="no-referrer">`;
  q('#publish-scheduled').value=b.dataset.publishReschedule && review.scheduled_at?new Date(review.scheduled_at*1000-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16):'';q('#publish-confirmed').checked=false;const ready=data.connection.connected && data.connection.publish_permission && data.connection.authorization_current;
  q('#publish-review-error').textContent=ready?'':'Connect your Instagram account with publishing permission before publishing.';q('#publish-review-form button[type="submit"]').disabled=!ready;q('#publish-review-dialog').showModal();
 });
 q('#publish-review-close').addEventListener('click',()=>q('#publish-review-dialog').close());
 q('#publish-review-form').addEventListener('submit',async event=>{
  event.preventDefault();if(busy || !review)return;busy=true;const b=event.submitter;if(b)b.disabled=true;
  try{const value=q('#publish-scheduled').value,scheduled_at=value?new Date(value).getTime()/1000:null;
   await postApi(`/${review.id}/${['queued','scheduled'].includes(review.status)?'reschedule':'dispatch'}`,'POST',{version:review.version,account_id:reviewAccountId,confirmed:q('#publish-confirmed').checked,scheduled_at});q('#publish-review-dialog').close();q('#publish-status').textContent=mode==='demo'?(scheduled_at?'Local demo scheduled. Keep the backend running.':'Local publication queued. Nothing sent to Instagram.'):scheduled_at?'Publication scheduled. Keep the backend and worker online.':'Publication queued. Status updates automatically.';
  }catch(e){q('#publish-review-error').textContent=e.message;}finally{busy=false;if(b)b.disabled=false;await load(true);}
 });
 q('#publish-posts').addEventListener('click',event=>{
   const button=event.target.closest('[data-facebook-share]');
   if(!button || busy) return;
   act(async()=>{
     const id=button.dataset.facebookShare;
     const page=await api('/publishing/facebook/'+id+'/review');
     if(!page.authorized) throw Error('To post to '+page.name+', reconnect Meta with pages_manage_posts in addition to your Instagram permissions. Use the Meta token connection above.');
     const post=data.items.find(item=>item.id===id);
     if(!window.confirm('Publish this video to the Facebook Page '+page.name+'?\n\n'+post.caption)) return;
     await api('/publishing/facebook/'+id+'/dispatch','POST',{page_id:page.id,confirmed:true});
     q('#publish-status').textContent='Facebook video queued.';
   });
 });
 q('#publish-mode').addEventListener('change',()=>{if(busy){q('#publish-mode').value=mode;return;}mode=q('#publish-mode').value;data=null;editing=null;review=null;q('#publish-form').reset();q('#publish-save').textContent='Save draft';q('#publish-edit-cancel').hidden=true;q('#publish-status').textContent='';q('#publish-review-dialog').close();preview();load(true);});
 setInterval(()=>{if(location.hash==='#publishing' && q('#publishing-destination').value!=='tiktok')load();},4000);
 window.spurPublishing={load};
})();
