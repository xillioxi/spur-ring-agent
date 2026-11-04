(() => {
  const q=s=>document.querySelector(s),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const providers={tiktok:['TikTok','https://developers.tiktok.com/apps/','brand-tiktok.svg'],linkedin:['LinkedIn','https://www.linkedin.com/developers/apps','brand-linkedin.svg'],google:['Google Workspace','https://console.cloud.google.com/apis/credentials','brand-google.png'],microsoft:['Outlook / Microsoft','https://entra.microsoft.com/','brand-outlook.svg'],youtube:['YouTube','https://console.cloud.google.com/apis/credentials','brand-youtube.png'],instagram:['Instagram / Meta','https://developers.facebook.com/apps/','brand-instagram.png']};
  let busy=false,signature='';
  async function load(){
    if(busy)return;busy=true;
    try{
      await window.spurAuth.ready;if(window.spurAuth.user.role!=='owner')throw new Error('Only the installation owner can manage provider apps.');
      const result=await window.spurAuth.request('/admin/integrations');const value=JSON.stringify(result);if(value===signature)return;signature=value;
      q('#integrations-cards').innerHTML=[...result.office.map(c=>({...c,kind:'office'})),...result.social.map(c=>({...c,provider:c.platform,kind:'social'}))].map(c=>{
        const [name,url,logo]=providers[c.provider];
        return `<article class="panel social-card"><div class="social-card-heading"><span class="office-logo"><img src="/static/${logo}" alt="" width="30" height="30"></span><div><h2>${name}</h2><span class="pill ${c.configured?'success':'neutral'}">${c.configured?'App configured':'Registration needed'}</span></div></div><p>Register Spur Ring with the provider, enable the requested services, and add this exact callback URI.</p><p><code style="overflow-wrap:anywhere">${esc(c.callback_url)}</code></p>${c.configured?`<small>Client ID: ${esc(c.client_id)}</small>`:''}<div class="social-card-actions"><a class="button secondary" href="${url}" target="_blank" rel="noopener noreferrer">Developer console ↗</a><button class="button primary" data-${c.kind}-setup="${c.provider}">${c.configured?'Edit platform app':'Enter app credentials'}</button></div></article>`;
      }).join('');
      q('#integrations-error').textContent='';await Promise.all([window.spurOffice.load(true),window.spurSocial.load(true)]);
    }catch(e){q('#integrations-error').textContent=e.message;}
    finally{busy=false;}
  }
  window.spurIntegrations={load};
})();
