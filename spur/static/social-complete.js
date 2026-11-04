/* OAuth recovery is bound to the original authenticated session and its CSRF token. */
(() => {
  const {platform,continuation}=document.currentScript.dataset;
  history.replaceState(null,'',location.pathname);
  const fail=message=>{
    document.querySelector('#connection-title').textContent='Connection needs attention';
    document.querySelector('#connection-message').textContent=message;
  };
  (async()=>{
    try{
      const auth=await fetch('/auth/me',{credentials:'same-origin',cache:'no-store'});
      if(!auth.ok)throw new Error('Sign in to the same workspace that started this connection, then start Connect again.');
      const session=await auth.json();
      const response=await fetch('/social/'+encodeURIComponent(platform)+'/complete',{
        method:'POST',credentials:'same-origin',cache:'no-store',
        headers:{'Content-Type':'application/json','X-Spur-Auth':'1','X-CSRF-Token':session.csrf_token},
        body:JSON.stringify({continuation})
      });
      const result=await response.json();
      if(!response.ok || !result.success)throw new Error(result.detail || result.message || 'Connection could not finish. Start Connect again.');
      location.replace('/#connections');
    }catch(error){fail(error.message);}
  })();
})();
