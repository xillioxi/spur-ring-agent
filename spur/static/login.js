const $=selector=>document.querySelector(selector);
let setupRequired=false;let signupMode=location.pathname==='/signup';
function nextWorkspace(){const hash=sessionStorage.getItem('spur_after_login');sessionStorage.removeItem('spur_after_login');return hash?.startsWith('#')?'/'+hash:'/#agents';}
async function initialize(){
  try{
    const response=await fetch('/auth/status',{credentials:'same-origin',cache:'no-store'});
    if(!response.ok)throw new Error('Could not reach the workspace. Refresh to try again.');
    setupRequired=(await response.json()).setup_required;
    $('#display-name-field').hidden=!signupMode;$('#display-name').required=signupMode;
    $('#password').minLength=signupMode?12:1;$('#password').autocomplete=signupMode?'new-password':'current-password';
    $('#password-hint').hidden=!signupMode;
    $('#auth-title').textContent=signupMode?(setupRequired?'Create your owner account':'Create your account'):'Sign in to your workspace';
    $('#auth-eyebrow').textContent=signupMode?'MAKE YOURSELF AT HOME':'WELCOME BACK';
    $('#auth-description').textContent=signupMode?(setupRequired?'Secure the existing workspace with your first account.':'Start a private workspace with your own content and model connection.'):'Your agents and conversations are waiting.';
    $('#auth-footnote').innerHTML=signupMode?'Already have an account? <a href="/login">Sign in →</a>':'New here? <a href="/signup">Create an account →</a>';document.title=signupMode?'Create account — Spur Ring':'Sign in — Spur Ring';
    $('#auth-submit').textContent=signupMode?'Create account & continue':'Sign in';$('#auth-submit').disabled=false;
  }catch(error){$('#auth-error').textContent=error.message;}
}
$('#login-form').addEventListener('submit',async event=>{
  event.preventDefault();const button=$('#auth-submit');button.disabled=true;$('#auth-error').textContent='';
  try{
    const body={username:$('#username').value.trim(),password:$('#password').value,remember:$('#remember').checked};
    if(signupMode)body.display_name=$('#display-name').value.trim();
    const response=await fetch(signupMode?'/auth/register':'/auth/login',{method:'POST',credentials:'same-origin',
      headers:{'Content-Type':'application/json','X-Spur-Auth':'1'},body:JSON.stringify(body)});
    const data=await response.json();
    if(!response.ok)throw new Error(Array.isArray(data.detail)?data.detail.map(item=>item.msg).join('; '):data.detail || 'Could not sign in.');
    $('#password').value='';if(sessionStorage.getItem('spur_current_user')!==data.user.id){for(let i=sessionStorage.length-1;i>=0;i--){const key=sessionStorage.key(i);if(key.startsWith('spur_'))sessionStorage.removeItem(key);}}sessionStorage.setItem('spur_current_user',data.user.id);sessionStorage.removeItem('spur_api_key');location.replace(signupMode?'/#welcome':nextWorkspace());
  }catch(error){$('#auth-error').textContent=error.message;button.disabled=false;}
});
initialize();
