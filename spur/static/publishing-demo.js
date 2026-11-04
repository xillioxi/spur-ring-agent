/* Local test media, created on this device. No model, provider or external media calls. */
(() => {
 'use strict';
 const api=(path,method='GET',body)=>window.spurAuth.request(path,method,body);
 function draw(canvas,title,sub,phase=0){
  const c=canvas.getContext('2d'),w=canvas.width,h=canvas.height;
  c.fillStyle=phase%2?'#e9eee2':'#163f34';c.fillRect(0,0,w,h);
  c.strokeStyle='#b4cd8a';c.lineWidth=12;c.beginPath();c.arc(w*.78,h*.22,w*.16,0,Math.PI*2);c.stroke();
  c.fillStyle=phase%2?'#163f34':'#e9eee2';c.font='bold '+Math.round(w*.07)+'px Arial';c.fillText('spur ring',w*.08,h*.13);
  c.font='bold '+Math.round(w*.08)+'px Arial';c.fillText(title,w*.08,h*.49,w*.84);
  c.font=Math.round(w*.04)+'px Arial';c.fillText(sub,w*.08,h*.57,w*.84);
  c.font=Math.round(w*.027)+'px Arial';c.fillText('LOCAL DEMO · NOT POSTED TO INSTAGRAM',w*.08,h*.9,w*.84);
 }
 async function picture(title,sub){const canvas=document.createElement('canvas');canvas.width=1080;canvas.height=1080;draw(canvas,title,sub);return new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.9));}
 async function reel(title,sub){
  if(!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream)throw Error('This browser cannot generate a demo Reel. Photo examples still work; upload your own MP4 instead.');
  const canvas=document.createElement('canvas');canvas.width=720;canvas.height=1280;draw(canvas,title,sub);
  const stream=canvas.captureStream(10),mime=MediaRecorder.isTypeSupported('video/webm;codecs=vp8')?'video/webm;codecs=vp8':'video/webm';
  const recorder=new MediaRecorder(stream,{mimeType:mime}),chunks=[];
  return new Promise((resolve,reject)=>{
   let stopped=false;const start=Date.now();const timer=setInterval(()=>draw(canvas,title,sub,Math.floor((Date.now()-start)/1000)),100);
   const cleanup=()=>{clearInterval(timer);stream.getTracks().forEach(track=>track.stop());};
   recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
   recorder.onerror=()=>{cleanup();reject(Error('Demo video recording failed.'));};
   recorder.onstop=()=>{cleanup();resolve(new Blob(chunks,{type:'video/webm'}));};
   recorder.start();setTimeout(()=>{if(!stopped){stopped=true;recorder.stop();}},3200);
  });
 }
 async function generate(progress){
  await window.spurAuth.ready;
  const existing=(await api('/publishing/instagram?mode=demo')).items;
  const examples=[['image','Capture ideas','A thought worth keeping.'],['image','Create with clarity','From notes to your next story.'],['reel','Capture. Organize. Create.','A local publishing workflow demo.'],['reel','Research. Draft. Review.','Your content team, working together.']];
  for(let i=0;i<examples.length;i++){
   const [media_type,title,sub]=examples[i],caption='LOCAL DEMO '+(i+1)+' — '+title+' '+sub+' Created locally for testing; not published to Instagram.';
   if(existing.some(p=>p.caption===caption && p.status!=='cancelled'))continue;
   progress('Creating local example '+(i+1)+' of 4…');const blob=await (media_type==='image'?picture(title,sub):reel(title,sub));
   const content=await api('/content','POST',{title:'Local demo · '+title,caption,kind:'own',stage:'drafting',format:media_type==='image'?'image_post':'instagram_reel'});
   const filename='spur-local-demo-'+(i+1)+(media_type==='image'?'.jpg':'.webm'),auth=window.spurAuth;
   const response=await fetch(`/content/${content.id}/assets?filename=${filename}&role=footage`,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/octet-stream','X-CSRF-Token':auth.csrfToken,'X-Spur-User':auth.user.id,'X-Spur-Profile':auth.mockProfile?.id || 'personal'},body:blob});
   const saved=await response.json();if(!response.ok)throw Error(saved.detail || 'Could not save the local demo media.');
   const asset=saved.assets.find(a=>a.filename===filename);
   await api('/publishing/instagram?mode=demo','POST',{caption,media_type,content_id:content.id,asset_id:asset.id});
  }
  progress('Four local demo drafts are ready. Review one, then choose Publish locally to test the feed.');
 }
 window.spurPublishingDemo={generate};
})();
