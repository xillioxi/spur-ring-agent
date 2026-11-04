/* Account sessions live in HttpOnly cookies; only the CSRF token is readable here. */
window.spurAuth={user:null,csrfToken:'',expired(){sessionStorage.setItem('spur_after_login',location.hash || '#agents');location.replace('/login');}};
window.spurAuth.refreshSession=async function(){
  if(!this.refreshing)this.refreshing=(async()=>{
    const data=await this.request('/auth/me');
    if(this.user && this.user.id!==data.user.id){location.reload();throw new Error('The signed-in account changed. Reloading your workspace.');}
    this.user=data.user;this.mockProfile=data.mock_profile || null;this.csrfToken=data.csrf_token;this.onboarding=data.onboarding;return data;
  })().finally(()=>{this.refreshing=null;});
  return this.refreshing;
};
window.spurAuth.request=async function(path,method='GET',body,retryVerification=true){
  const response=await fetch(path,{method,credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json','X-Spur-Auth':'1',...(this.user?{'X-Spur-User':this.user.id,...(!path.startsWith('/auth/') && !path.startsWith('/mock-profiles')?{'X-Spur-Profile':this.mockProfile?.id || 'personal'}:{})}:{}),...(method!=='GET'?{'X-CSRF-Token':this.csrfToken}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const data=response.status===204?null:await response.json();if(['account','workspace'].includes(response.headers.get('X-Spur-Session-Error'))){location.reload();throw new Error('The signed-in account changed. Reloading your workspace.');}
  if(response.status===403 && retryVerification && response.headers.get('X-Spur-Session-Error')==='csrf'){
    // This rejection happens before route execution. Re-fetch the current cookie's
    // CSRF token and retry once; never replay a write rejected for another reason.
    await this.refreshSession();return this.request(path,method,body,false);
  }
  if(!response.ok){if(response.status===401 && path!=='/auth/login')this.expired();throw new Error(Array.isArray(data.detail)?data.detail.map(item=>item.msg).join('; '):data.detail || 'Account request failed.');}
  return data;
};
window.spurAuth.ready=(async()=>{
  const auth=window.spurAuth;sessionStorage.removeItem('spur_api_key');
  const data=await auth.refreshSession();
  const previous=sessionStorage.getItem('spur_current_user');if(previous && previous!==auth.user.id){for(let i=sessionStorage.length-1;i>=0;i--){const key=sessionStorage.key(i);if(key.startsWith('spur_'))sessionStorage.removeItem(key);}sessionStorage.setItem('spur_current_user',auth.user.id);location.reload();throw new Error('Opening your private workspace.');}sessionStorage.setItem('spur_current_user',auth.user.id);
  const profileScope=auth.mockProfile?.id || 'personal',oldScope=sessionStorage.getItem('spur_current_profile') || 'personal';
  if(profileScope!==oldScope){const saved={};for(let i=sessionStorage.length-1;i>=0;i--){const key=sessionStorage.key(i);if(key.startsWith('spur_prompt_') || key.startsWith('spur_chat_')){saved[key]=sessionStorage.getItem(key);sessionStorage.removeItem(key);}}sessionStorage.setItem('spur_draft_scope_'+oldScope,JSON.stringify(saved));try{const restored=JSON.parse(sessionStorage.getItem('spur_draft_scope_'+profileScope) || '{}');for(const [key,value] of Object.entries(restored))sessionStorage.setItem(key,value);}catch{}}sessionStorage.setItem('spur_current_profile',profileScope);
  const name=document.querySelector('#account-name'),role=document.querySelector('#account-role');
  name.textContent=auth.user.display_name;role.textContent='Private workspace';
  document.querySelectorAll('[data-account-initial]').forEach(node=>node.textContent=auth.user.display_name[0].toUpperCase());
  document.querySelector('#account-owner-section').hidden=auth.user.role!=='owner';
  const providerSetup=document.querySelector('#platform-admin-nav');if(providerSetup)providerSetup.hidden=auth.user.role!=='owner' || !!auth.mockProfile;
  return data;
})();
async function openAccount(){
  const auth=window.spurAuth;await auth.ready;const dialog=document.querySelector('#account-dialog');
  document.querySelector('#account-identity').textContent=auth.user.display_name+' · @'+auth.user.username;
  document.querySelector('#account-message').textContent='';dialog.showModal();
  if(auth.user.role==='owner'){
    const users=await auth.request('/auth/users'),list=document.querySelector('#account-users');list.replaceChildren();
    for(const user of users){const row=document.createElement('li');row.textContent=user.display_name+' · @'+user.username+' · '+user.role;list.append(row);}
  }
}
document.querySelectorAll('[data-account-open]').forEach(button=>button.addEventListener('click',()=>openAccount().catch(error=>{document.querySelector('#account-message').textContent=error.message;})));
document.querySelector('#account-close').addEventListener('click',()=>document.querySelector('#account-dialog').close());
document.querySelector('#account-logout').addEventListener('click',async event=>{
  const button=event.currentTarget;button.disabled=true;
  try{await window.spurAuth.request('/auth/logout','POST');window.spurAuth.csrfToken='';location.replace('/login');}
  catch(error){document.querySelector('#account-message').textContent=error.message;button.disabled=false;}
});
document.querySelector('#account-password-form').addEventListener('submit',async event=>{
  event.preventDefault();const form=event.currentTarget,button=form.querySelector('button');button.disabled=true;
  try{
    const data=await window.spurAuth.request('/auth/password','POST',{current_password:document.querySelector('#current-password').value,new_password:document.querySelector('#new-password').value});
    window.spurAuth.csrfToken=data.csrf_token;form.reset();document.querySelector('#account-message').textContent='Password updated. Other sessions have been signed out.';
  }catch(error){document.querySelector('#account-message').textContent=error.message;}
  finally{button.disabled=false;}
});
document.querySelector('#account-create-form').addEventListener('submit',async event=>{
  event.preventDefault();const form=event.currentTarget,button=form.querySelector('button');button.disabled=true;
  try{
    const data=await window.spurAuth.request('/auth/register','POST',{username:document.querySelector('#new-username').value.trim(),display_name:document.querySelector('#new-display-name').value.trim(),password:document.querySelector('#new-user-password').value,admin_create:true});
    form.reset();await openAccount();document.querySelector('#account-message').textContent='Account created for @'+data.user.username+'. They can now sign in to their own private workspace.';
  }catch(error){document.querySelector('#account-message').textContent=error.message;}
  finally{button.disabled=false;}
});
