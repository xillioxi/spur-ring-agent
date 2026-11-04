/* First-use walkthrough. No model calls or background jobs run during the tour. */
(()=>{
  const q=selector=>document.querySelector(selector);
  const esc=value=>String(value || '').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  let step=0,brief={},busy=false;
  const labels=['Welcome','Your creator brief','Connect a model','Meet your team','Your first task'];
  const example=()=>`Help me plan my next ${brief.niche || 'creator'} video for ${brief.audience || 'my audience'}. Use Idea Strategist for 3 concepts, Script Writer for a short script, and Title & Hook Lab for titles. Pass the work between agents and save one campaign package.`;
  function render(){
    q('#welcome-error').textContent='';q('#welcome-step-label').textContent=`${step+1} of ${labels.length}`;
    q('#welcome-back').disabled=step===0;q('#welcome-next').textContent=step===4?'Open Marketing Lead →':'Continue →';
    q('#welcome-progress').innerHTML=labels.map((label,index)=>`<span class="${index===step?'current':index<step?'done':''}"><b>${index+1}</b>${label}</span>`).join('');
    const content=[
      `<span class="eyebrow">A QUICK TOUR OF YOUR WORKSPACE</span><h1>Welcome, ${esc(window.spurAuth.user.display_name)}<span>.</span></h1><p>Tell your agent team what you want to make. Work through ideas in chat, then let specialists turn your brief into drafts and research.</p><div class="welcome-feature-grid"><article><strong>Your private workspace</strong><p>Your chats, watchlist, outputs and model connection stay with your account. Other signups start fresh.</p></article><article><strong>A ready-made team</strong><p>Marketing Lead coordinates your specialists. The starter agents are ready; you bring the brief and model.</p></article><article><strong>You stay in control</strong><p>Review saved drafts before using them. The app does not publish videos, send pitches or render media.</p></article></div>`,
      `<span class="eyebrow">STEP 1 · GIVE YOUR TEAM CONTEXT</span><h1>What do you create?</h1><p>Your creator brief helps every agent understand your niche and audience. You can edit it later under Creator brief.</p><div class="welcome-fields"><label for="welcome-channel">Creator or channel name</label><input id="welcome-channel" maxlength="200" placeholder="e.g. Paris Pocket" value="${esc(brief.channel_name)}"><label for="welcome-niche">Your niche</label><input id="welcome-niche" maxlength="1000" placeholder="e.g. Affordable Paris travel" value="${esc(brief.niche)}"><label for="welcome-audience">Who is your audience?</label><input id="welcome-audience" maxlength="1000" placeholder="e.g. First-time visitors looking for practical advice" value="${esc(brief.audience)}"></div><small>You can leave these blank and come back later.</small>`,
      `<span class="eyebrow">STEP 2 · CHOOSE THE MODEL BEHIND YOUR AGENTS</span><h1>Connect your model.</h1><p>Spur Ring provides the agents, tools and memory. Connect DeepSeek, OpenAI, or a local Ollama model to power their replies.</p><div class="welcome-model"><strong id="welcome-model-status">Checking your connection…</strong><p>Your provider key belongs to this account. Hosted providers charge for API usage; model calls begin when you send work.</p><button type="button" class="button secondary" id="welcome-connect">Open model settings →</button></div><p>You can continue the tour without a model and connect one before sending your first message.</p>`,
      `<span class="eyebrow">STEP 3 · START WITH YOUR MARKETING LEAD</span><h1>One brief. The right team.</h1><p>Chat with Marketing Lead to explore a goal. When you ask it to execute, it chooses specialists and passes their work along.</p><div class="welcome-pipeline"><span>Marketing Lead<br><small>Strategy & assignments</small></span><b>→</b><span>Creator specialists<br><small>Research, ideas, scripts & packaging</small></span><b>→</b><span>Your outputs<br><small>Review, copy, export & refine</small></span></div><p>Each agent also has its own saved chat. Open any card in <strong>Your Agents</strong> to work with that specialist directly.</p>`,
      `<span class="eyebrow">STEP 4 · YOU ARE READY TO START</span><h1>Try your first brief.</h1><p>We’ll put this example in Marketing Lead’s chat for you to edit. Nothing is sent automatically.</p><div class="welcome-example">${esc(example())}</div><div class="welcome-feature-grid"><article><strong>Send</strong><p>Have a conversation, ask follow-ups, or request a saved deliverable.</p></article><article><strong>Run as task</strong><p>Submit the text directly as a background mission. Keep the local backend running while it works.</p></article><article><strong>Missions & Outputs</strong><p>Watch assignments and action summaries in Missions. Review completed drafts in Outputs.</p></article></div><small>Reopen this walkthrough any time from your account menu.</small>`
    ];
    q('#welcome-content').innerHTML=content[step];
    if(step===2){
      window.spurAuth.request('/settings/provider').then(connection=>{if(step===2)q('#welcome-model-status').textContent=connection.model?`Connected: ${connection.provider} · ${connection.model}`:'No model connected yet';}).catch(error=>q('#welcome-error').textContent=error.message);
      q('#welcome-connect').addEventListener('click',()=>window.openModal('settings'));
    }
  }
  async function open(){
    await window.spurAuth.ready;
    brief=await window.spurAuth.request('/creator-brief');step=0;
    q('#account-dialog').close();document.querySelector('.app-shell').inert=true;document.querySelector('.sidebar').inert=true;q('#welcome-screen').hidden=false;render();q('#welcome-next').focus();
  }
  async function finish(prefill){
    if(busy)return;busy=true;q('#welcome-next').disabled=true;q('#welcome-skip').disabled=true;
    try{
      await window.spurAuth.request('/auth/onboarding/complete','POST');
      window.spurAuth.onboarding={completed:true};q('#welcome-screen').hidden=true;document.querySelector('.app-shell').inert=false;document.querySelector('.sidebar').inert=false;
      if(prefill){sessionStorage.setItem('spur_prompt_draft_coordinator',example());location.hash='agent/coordinator/overview';setTimeout(()=>{q('#agent-prompt').value=example();if(typeof savePromptDraft==='function')savePromptDraft();q('#agent-prompt').focus();},0);}
      else if(location.hash==='#welcome')location.hash='agents';
    }catch(error){q('#welcome-error').textContent=error.message;}
    finally{busy=false;q('#welcome-next').disabled=false;q('#welcome-skip').disabled=false;}
  }
  q('#welcome-next').addEventListener('click',async()=>{
    if(busy)return;if(step===4)return finish(true);
    busy=true;q('#welcome-next').disabled=true;
    try{
      if(step===1){brief={...brief,channel_name:q('#welcome-channel').value.trim(),niche:q('#welcome-niche').value.trim(),audience:q('#welcome-audience').value.trim()};await window.spurAuth.request('/creator-brief','PUT',brief);}
      step++;render();
    }catch(error){q('#welcome-error').textContent=error.message;}
    finally{busy=false;q('#welcome-next').disabled=false;}
  });
  q('#welcome-back').addEventListener('click',()=>{if(step>0 && !busy){if(step===1)brief={...brief,channel_name:q('#welcome-channel').value,niche:q('#welcome-niche').value,audience:q('#welcome-audience').value};step--;render();}});
  q('#welcome-skip').addEventListener('click',()=>finish(false));
  document.querySelectorAll('[data-open-walkthrough]').forEach(button=>button.addEventListener('click',()=>open().catch(error=>q('#account-message').textContent=error.message)));
  window.spurAuth.ready.then(()=>{if(!window.spurAuth.onboarding?.completed || location.hash==='#welcome')return open();}).catch(()=>{});
})();
