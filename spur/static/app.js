const $ = (s) => document.querySelector(s);
const state = { sources: [], videos: [], reports: [], schedules: [], jobs: [], knowledge: [], missions: [], model: '', provider:'', models: [], modelOnline: false, worker: false, page: 'agents', agents: [], activeAgentId: 'youtube-research' };
const pages = {
  'profile-analytics':['CREATOR PERFORMANCE','Video analytics','Measured public performance, available to every agent in this profile.','Video analytics'],
  'mock-profiles': ['CREATOR SANDBOX', 'Creator workspaces', 'One creator, multiple channels, shared agents and knowledge.', 'Creator workspaces'],
  discover: ['FIND YOUR NEXT OPPORTUNITY', 'Discover content', 'Search real provider results across platforms. Each result keeps its source and collection time.', 'Discover'],
  platforms: ['YOUR CONNECTED WORKSPACE', 'Platforms', 'Your accounts, performance, and connected tools in one place.', 'Platforms'],
  publishing: ['READY TO SHARE', 'Publish content', 'Create, review and schedule content for your authorized Instagram and TikTok accounts.', 'Publishing'],
  calendar: ['YOUR TIME, CONNECTED', 'Calendar', 'See your connected calendars and plan your next creative session.', 'Calendar'],
  integrations: ['PLATFORM ADMINISTRATION', 'Provider app setup', 'Configure provider applications once. Every user connects their own account.', 'Provider setup'],
  library: ['FROM IDEA TO PUBLICATION', 'Content library', 'One shared home for your content, creative assets, and production plans.', 'Content library'],
  connections: ['YOUR ACCOUNTS, CONNECTED', 'Connections & analytics', 'Connect social accounts, email, calendars, and documents. Analyze performance and edit your connected tools.', 'Connections'],
  agents: ['YOUR AGENTS, TOGETHER', 'Your agent workspace', 'Create specialists. Coordinate their work. Keep every result in view.', 'Agents'],
  overview: ['YOUR AGENT CONVERSATION', 'Agent workspace', 'Chat, refine ideas, and follow your agent’s work.', 'Chat & overview'],
  sources: ['CURATE YOUR PERSPECTIVE', 'Your watchlist', 'Bring the voices you trust into one research workspace.', 'Watchlist'],
  videos: ['THE EVIDENCE LIBRARY', 'Collected videos', 'A searchable history of the signals your channels are sharing.', 'Collected videos'],
  reports: ['CONNECT THE DOTS', 'Research reports', 'Explore findings, potential trends, and the evidence behind them.', 'Reports'],
  knowledge: ['A WORKSPACE THAT REMEMBERS', 'Agent knowledge', 'Give your agent lasting context. Keep what it learns, whichever model you use.', 'Knowledge'],
  missions: ['GOALS INTO ACTION', 'Agent missions', 'Discovery, watchlist updates, collection, and analysis — with progress saved at every step.', 'Missions'],
  activity: ['BEHIND THE RESEARCH', 'Agent activity', 'Follow each collection and report job from queue to completion.', 'Activity'],
  schedules: ['LET YOUR RESEARCH RUN', 'Your schedules', 'Keep your watchlist fresh and your reports arriving regularly.', 'Schedules']
};
const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const date = (stamp) => stamp ? new Date(stamp * 1000).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : 'Never collected';
const shortDate = (stamp) => new Date(stamp * 1000).toLocaleDateString([], {month:'short',day:'numeric',year:'numeric'});
const pill = (status, label = status) => `<span class="pill ${['succeeded','success'].includes(status) ? 'success' : ['running','failed','queued'].includes(status) ? status : 'neutral'}">${escapeHtml(label)}</span>`;
const empty = (i, title, description, action, label) => `<div class="empty-state"><div class="empty-icon">${icon(i)}</div><h3>${title}</h3><p>${description}</p>${action ? `<button class="button secondary" data-action="${action}">${label}</button>` : ''}</div>`;
let refreshBusy = false, modalMode = '', activeReport = null, toastTimeout;
state.activeAgentId=decodeURIComponent(location.hash.match(/^#agent\/([^/]+)/)?.[1] || 'youtube-research');
let promptJobId = state.activeAgentId==='youtube-research' ? sessionStorage.getItem('spur_prompt_job') || '' : '';
let promptSending = false;
const expandedTraces = new Set();
const loadedJobEvents = new Map();
let promptMissionId = sessionStorage.getItem('spur_prompt_mission_'+state.activeAgentId) || (state.activeAgentId==='youtube-research' ? sessionStorage.getItem('spur_prompt_mission') || '' : '');
const agentChats=new Map(), chatLoads=new Map(), chatSending=new Set();
let chatSignature='';

async function api(path, method = 'GET', body) {
  const auth=window.spurAuth;
  await auth.ready;
  return auth.request(path,method,body);
}

function toast(message) { $('#toast').textContent = message; $('#toast').classList.add('visible'); clearTimeout(toastTimeout); toastTimeout = setTimeout(() => $('#toast').classList.remove('visible'), 6000); }
function route() {
  const hash=location.hash.slice(1);
  const match=hash.match(/^agent\/([^/]+)(?:\/([^/]+))?$/);
  const oldAgent=state.activeAgentId;
  const platformMatch=hash.match(/^platform\/(youtube|instagram|google|microsoft|tiktok|linkedin)$/);
  const requested=platformMatch?'platforms':match ? match[2] || 'overview' : hash || 'agents';
  state.page=pages[requested] ? requested : 'agents';
  if (match) state.activeAgentId=decodeURIComponent(match[1]);
  if (oldAgent!==state.activeAgentId && $('#agent-prompt')) {
    $('#agent-prompt').value=sessionStorage.getItem('spur_prompt_draft_'+state.activeAgentId) || '';
    promptMissionId=sessionStorage.getItem('spur_prompt_mission_'+state.activeAgentId) || '';
    $('#prompt-feedback').classList.add('hidden');
    $('#chat-error').textContent='';chatSignature='';savePromptDraft();
  }
  const agent=state.agents.find(a=>a.id===state.activeAgentId);
  const hub=['agents','connections','library','integrations','calendar','publishing','platforms','discover','mock-profiles','profile-analytics'].includes(state.page);
  document.body.classList.toggle('platform-home',hub);
  const [eyebrow,title,description,crumb]=pages[state.page];
  $('#page-eyebrow').textContent=eyebrow;
  $('#page-title').textContent=!hub && state.page==='overview' ? agent?.name || 'Agent workspace' : title;
  $('#page-title').insertAdjacentHTML('beforeend','<span>.</span>');
  $('#page-description').textContent=!hub && state.page==='overview' ? agent?.description || description : description;
  $('#crumb').textContent=crumb;
  $('#selected-agent-name').textContent=agent?.name || 'YouTube Research';
  $('#agent-breadcrumb').textContent=hub ? '' : (agent?.name || 'YouTube Research')+' / ';
  $('#prompt-title').textContent='Chat with '+(agent?.name || 'your agent');
  $('#agent-chat').setAttribute('aria-label','Conversation with '+(agent?.name || 'your agent'));
  const primary=$('#page-primary-action');
  primary.hidden=['connections','library','integrations','calendar','publishing','platforms','discover','mock-profiles','profile-analytics'].includes(state.page);
  primary.dataset.action=hub?'agent':state.activeAgentId==='coordinator' || (agent?.workflow && !['research','coordinator'].includes(agent.workflow))?'ask-agent':'report';
  primary.innerHTML=icon('plus')+(hub?'Create agent':state.activeAgentId==='coordinator'?'Brief Marketing Lead':agent?.workflow && agent.workflow!=='research'?'New deliverable':'Create report');
  document.querySelectorAll('[data-page]').forEach(el=>el.hidden=el.dataset.page!==state.page);
  document.querySelectorAll('[data-nav]').forEach(el=>{el.href='#agent/'+encodeURIComponent(state.activeAgentId)+'/'+el.dataset.nav;el.classList.toggle('active',el.dataset.nav===state.page)});
  if (!hub && !match) history.replaceState(null,'','#agent/'+encodeURIComponent(state.activeAgentId)+'/'+state.page);
  if (agent) {
    const creative=!['research','coordinator'].includes(agent.workflow);
    $('#prompt-scope').textContent=state.activeAgentId==='coordinator'?'Your marketing lead builds a strategy, delegates to any specialist, and combines their work into one campaign package.':creative?'Creates a reviewable draft using your creator brief, source material, and instructions.':'Can discover channels, update your watchlist, collect evidence, and report in the background.';
    $('#agent-sidebar-type').textContent=creative?'Creator studio':state.activeAgentId==='coordinator'?'Marketing lead · Orchestrator':'Research harness';
    $('#agent-quick-start').hidden=!agent.example;
    $('#agent-quick-start').dataset.promptExample=agent.example || '';
    $('#agent-quick-start').textContent=agent.example?'Try a '+agent.name+' example ↗':'';
  }
  if (state.missions.length) renderMissions();
  if(state.page==='connections'){window.spurSocial?.load();window.spurOffice?.load();}
  if(state.page==='integrations')window.spurIntegrations?.load();
  if(state.page==='library')window.spurLibrary?.load();
  if(state.page==='profile-analytics')window.spurProfileAnalytics?.load();
  if(state.page==='mock-profiles')window.spurMocks?.load();
  if(state.page==='discover')window.spurSearch?.load();
  if(state.page==='platforms')window.spurPlatforms?.load(platformMatch?.[1] || 'all');
  if(state.page==='publishing')window.spurPublishing?.load();
  if(state.page==='calendar')window.spurCalendar?.load(false);
  if (!hub && state.page==='overview') {renderChat();refreshChat().catch(error=>{$('#chat-error').textContent=error.message;});}
}

function sourceRows(sources) {
  return sources.map(s => `<div class="source-row"><span class="channel-avatar">${escapeHtml(s.name.slice(0,1).toUpperCase())}</span><div class="source-copy"><strong>${escapeHtml(s.name)}</strong><small>${escapeHtml(window.spurAuth?.mockProfile?'Mock profile catalog':s.channel_id)} · ${s.last_success ? 'Collected '+date(s.last_success) : 'Waiting for first collection'}</small>${s.last_error ? `<small class="source-error">${escapeHtml(s.last_error)}</small>` : ''}</div>${pill(s.last_error ? 'failed' : s.last_success ? 'success' : 'neutral', s.last_error ? 'Needs attention' : s.last_success ? 'Synced' : 'Not collected')}</div>`).join('');
}

function reportRows(reports) {
  return reports.map((r, index) => `<div class="report-row">${icon('report')}<div><strong>${escapeHtml(r.title || r.topic?.slice(0,100) || 'Research report')}</strong><small>${escapeHtml(state.agents.find(a=>a.id===r.agent_id)?.name || 'Research')} · ${escapeHtml((r.artifact_kind || 'research').replaceAll('_',' '))} · ${date(r.created)}</small></div><button class="text-button" data-report="${escapeHtml(r.id)}">Open output ${icon('arrow')}</button></div>`).join('');
}

function traceRows(events) {
  return events.map(e => `<div class="trace-event trace-${escapeHtml(e.kind || 'checkpoint')}"><div class="trace-dot"></div><div class="trace-body"><div class="trace-meta"><span>${escapeHtml((e.kind || 'checkpoint').toUpperCase())}</span><time>${date(e.created)}</time></div><strong>${escapeHtml(e.title || e.message)}</strong>${Object.keys(e.details || {}).length ? `<dl>${Object.entries(e.details).map(([key,value]) => `<div><dt>${escapeHtml(key.replaceAll('_',' '))}</dt><dd>${escapeHtml(Array.isArray(value) ? value.join(' · ') : typeof value === 'object' && value !== null ? JSON.stringify(value) : value ?? 'None')}</dd></div>`).join('')}</dl>` : ''}</div></div>`).join('');
}
function activityRows(jobs) {
  return jobs.map(j => {
    const cached=loadedJobEvents.get(j.id) || [];
    const events=[...(j.events || []),...cached].filter((event,index,all) => all.findIndex(other => other.created===event.created && other.title===event.title)===index).sort((a,b)=>b.created-a.created);
    const latest=(j.events || [])[0];
    return `<article class="activity-entry"><div class="activity-row"><span class="activity-icon">${icon(j.kind === 'collect' ? 'refresh' : 'report')}</span><div class="activity-copy"><strong>${j.kind === 'profile_metadata' ? 'Video metadata collection' : j.kind === 'profile_import' ? 'Creator catalog import' : j.kind === 'collect' ? 'Channel collection' : j.kind === 'mission' ? 'Mission step' : 'Research report'}${j.payload?.topic ? ' · '+escapeHtml(j.payload.topic) : ''}</strong><small>${j.error ? escapeHtml(j.error) : latest ? escapeHtml(latest.title) : j.status==='running' ? 'Processing this step…' : j.status==='succeeded' ? 'Completed successfully' : 'Waiting for the background worker'}${j.attempts ? ` · Attempt ${j.attempts}/3` : ''}</small></div>${j.result?.report_id ? `<button class="text-button" data-report="${escapeHtml(j.result.report_id)}">View report</button>` : ''}${pill(j.status)}<time>${date(j.created)}</time></div><details class="job-trace" data-trace-id="${j.id}" ${expandedTraces.has(j.id) ? 'open' : ''}><summary>Agent activity & decision summaries ${j.status==='running' ? '<span class="live-label">Live</span>' : ''}</summary><div class="trace-list">${events.length ? traceRows(events) : '<p class="muted">No detailed trace was recorded for this older step. New steps record their actions as they run.</p>'}</div><button class="text-button" data-load-job-events="${j.id}">Load full step history ↓</button></details></article>`;
  }).join('');
}

function render(data) {
  $('#nav-sources').textContent = data.counts.sources;
  const metrics = [ ['Watched channels',data.counts.sources,'ring',window.spurAuth?.mockProfile?'Active reference profile':'Your curated YouTube sources'], ['Collected videos',data.counts.videos,'video','Evidence saved to your library'], ['Research reports',data.counts.reports,'report','Insights with source references'], ['Active jobs',data.counts.active_jobs,'pulse',state.worker ? 'Background worker is online' : 'Background worker is offline'] ];
  $('#metrics').innerHTML = metrics.map(([title,n,i,caption]) => `<div class="metric"><div class="metric-top"><span>${title}</span><span class="metric-icon">${icon(i)}</span></div><div class="metric-number">${n.toLocaleString()}</div><div class="metric-bottom"><i></i>${caption}</div></div>`).join('');
  $('#overview-sources').innerHTML = state.sources.length ? sourceRows(state.sources.slice(0,4)) : empty('ring','Start with the voices you trust','Add a YouTube channel to begin building your research watchlist.','source','+ Add your first channel');
  const query = $('#source-search').value.toLowerCase();
  const filtered = state.sources.filter(s => `${s.name} ${s.channel_id}`.toLowerCase().includes(query));
  $('#source-list').innerHTML = filtered.length ? sourceRows(filtered) : empty('ring',query ? 'No matching channels' : 'Your watchlist starts here',query ? 'Try a different channel name.' : 'Add channels you follow, competitors, or industry voices.','source','+ Add channel');
  $('#agent-pill').outerHTML = `<span id="agent-pill" class="pill ${state.worker ? 'success' : 'neutral'}">${state.worker ? 'Worker online' : 'Worker offline'}</span>`;
  $('#worker-status').textContent = state.worker ? 'Connected' : 'Offline';
  $('#model-status').textContent = state.model ? `${state.provider === 'openai' ? 'OpenAI' : state.provider === 'deepseek' ? 'DeepSeek' : 'Ollama'} · ${state.model}` : 'No model connected';
  const running = state.jobs.find(j => j.status === 'running');
  $('#agent-title').textContent = running ? running.kind === 'collect' ? 'Collecting new signals' : 'Investigating your evidence' : state.model ? 'Ready for your next question' : 'Your agent is taking shape';
  $('#agent-description').textContent = running ? 'Follow progress in the activity feed.' : state.model ? `${data.knowledge_count} saved knowledge entries stay with your agent across runs.` : 'Connect OpenAI or DeepSeek. Your knowledge stays in this workspace.';
  const ownReports=state.reports.filter(r=>(r.agent_id || 'youtube-research')===state.activeAgentId);
  const scopedReports=$('#output-scope').value==='all'?state.reports:ownReports;
  $('#overview-reports').innerHTML = ownReports.length ? reportRows(ownReports.slice(0,3)) : empty('report','Your next output starts here','Give this specialist a goal. Creative drafts can start from your brief; research uses source evidence.','ask-agent','Start a task');
  $('#report-list').innerHTML = scopedReports.length ? reportRows(scopedReports) : empty('report','No outputs yet','Start a specialist task. Finished drafts and research will appear here.','ask-agent','Start a task');
  $('#overview-activity').innerHTML = state.jobs.length ? activityRows(state.jobs.slice(0,3)) : empty('pulse','All quiet, for now','Your collection and report jobs will appear here as they happen.');
  $('#activity-list').innerHTML = state.jobs.length ? activityRows(state.jobs) : empty('pulse','Your agent’s work, in view','Run your first collection to see job progress, attempts, and results.','collect','Collect channels');
  renderVideos();
  renderKnowledge();
  renderMissions();
  $('#schedule-list').innerHTML = state.schedules.length ? state.schedules.map(s => `<div class="schedule-row">${icon('clock')}<div><strong>${s.kind === 'collect' ? 'Collect watched channels' : escapeHtml(s.payload.topic)}</strong><small>Every ${s.interval_seconds / 3600} hours · Next run ${date(s.next_run)}</small></div>${pill('neutral',s.kind)}<button class="delete-button" data-delete-schedule="${escapeHtml(s.id)}" aria-label="Remove schedule">Remove</button></div>`).join('') : empty('clock','Research on your rhythm','Schedule collection or reports. Your local worker must be running.','schedule','+ Create schedule');
  $('#last-updated').textContent = `Updated ${new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})}`;
}

function videoThumbnail(video) {
  if(video.provider || video.platform){if(video.synthetic || !video.url)return '<div class="video-thumbnail discovery-no-cover">Synthetic demo content</div>';const safe=String(video.url).startsWith('https://')?escapeHtml(video.url):'';return safe?`<a class="video-thumbnail" href="${safe}" target="_blank" rel="noopener noreferrer">${video.thumbnail && String(video.thumbnail).startsWith('https://')?`<img src="${escapeHtml(video.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer">`:'View source content ↗'}</a>`:'<div class="discovery-no-cover">Source link unavailable</div>';}
  const valid=/^[A-Za-z0-9_-]{11}$/.test(video.id);
  return `<a class="video-thumbnail" href="https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}" target="_blank" rel="noopener noreferrer" aria-label="Watch ${escapeHtml(video.title)} on YouTube"><span class="video-thumbnail-fallback ${valid?'hidden':''}">${icon('video')}<span>Preview unavailable</span></span>${valid?`<img data-video-thumbnail src="https://i.ytimg.com/vi/${encodeURIComponent(video.id)}/hqdefault.jpg" alt="Thumbnail for ${escapeHtml(video.title)}" width="480" height="270" loading="lazy" decoding="async" referrerpolicy="no-referrer">`:''}<span class="video-thumbnail-play" aria-hidden="true">▶</span></a>`;
}
$('#video-list').addEventListener('error',event=>{
  const image=event.target;
  if(!image.matches('img[data-video-thumbnail]'))return;
  image.hidden=true;image.closest('.video-thumbnail').querySelector('.video-thumbnail-fallback').classList.remove('hidden');
},true);
function renderVideos() {
  const query = $('#video-search').value.toLowerCase();
  const videos = state.videos.filter(v => `${v.title} ${v.description} ${v.source_name}`.toLowerCase().includes(query));
  $('#video-list').innerHTML = videos.length ? videos.map(v => `<article class="video-card">${videoThumbnail(v)}<div class="video-label">${icon('video')}${escapeHtml(v.source_name)} · ${shortDate(v.published)}</div><h3>${escapeHtml(v.title)}</h3><p>${escapeHtml(v.description || 'No description was provided by this channel.')}</p>${v.synthetic?'<span class="muted">Synthetic scenario · no published video</span>':`<a href="${escapeHtml(v.url || 'https://www.youtube.com/watch?v='+encodeURIComponent(v.id))}" target="_blank" rel="noopener noreferrer">Open source ${icon('arrow')}</a>`}<button class="text-button" data-library-video="${escapeHtml(v.id)}">Save reference to content library +</button></article>`).join('') : empty('video',query ? 'No matching videos' : 'Your evidence library is waiting',query ? 'Try another search term.' : 'Add a channel and run collection. Titles, descriptions, and source links will appear here.');
}

async function refresh() {
  window.spurInsights?.load();
  if (refreshBusy) return;
  refreshBusy = true;
  try {
    const [data,sources,videos,reports,schedules,knowledge,missions,agents] = await Promise.all([api('/dashboard'),api('/sources'),api('/videos'),api('/reports'),api('/schedules'),api('/knowledge'),api('/missions'),api('/agents')]);
    Object.assign(state,{sources,videos,reports,schedules,knowledge,missions,agents,jobs:data.jobs,model:data.model,provider:data.provider,worker:data.worker_online});
    $('#connection-banner').classList.add('hidden'); route(); render(data); renderAgentDirectory();
    if (promptMissionId) {
      const mission = state.missions.find(m => m.id === promptMissionId) || await api('/missions/'+encodeURIComponent(promptMissionId));
      renderPromptMission(mission);
    } else if (promptJobId) {
      const job = state.jobs.find(j => j.id === promptJobId) || await api('/jobs/'+encodeURIComponent(promptJobId));
      renderPromptJob(job);
    }
  } catch (error) { $('#connection-banner').textContent = error.message; $('#connection-banner').classList.remove('hidden'); $('#last-updated').textContent = 'Connection needs attention'; }
  finally { refreshBusy = false; }
}

const field = (id,label,input,hint='') => `<label for="${id}">${label}</label>${input}${hint ? `<small>${hint}</small>` : ''}`;
const textInput = (id,placeholder='',value='',required=true) => `<input id="${id}" name="${id}" ${required ? 'required' : ''} placeholder="${placeholder}" value="${escapeHtml(value)}" autocomplete="off">`;

function promptFeedback(html, error = false) {
  const feedback = $('#prompt-feedback');
  feedback.innerHTML = html;
  feedback.classList.remove('hidden');
  feedback.classList.toggle('prompt-feedback-error', error);
}

function renderPromptJob(job) {
  if (promptSending) return;
  const active = ['queued','running'].includes(job.status);
  if (job.status === 'succeeded' && job.result?.report_id) {
    promptFeedback(`<span>${icon('check')} Your research is ready.</span><button type="button" class="text-button" data-report="${escapeHtml(job.result.report_id)}">Read agent report ${icon('arrow')}</button>`);
  } else if (job.status === 'failed') {
    promptFeedback(`<span>Agent request failed: ${escapeHtml(job.error || 'See Activity for details.')}</span><a class="text-button" href="#activity">View activity →</a>`, true);
  } else {
    const message = job.status === 'running' ? 'Your agent is investigating the collected evidence.' : job.attempts ? `Waiting to retry. ${escapeHtml(job.error || '')}` : state.worker ? 'Request queued. Your agent will begin shortly.' : 'Request queued. Start the background worker to continue.';
    promptFeedback(`<span>${icon('pulse')} ${message}</span><a class="text-button" href="#activity">Follow progress →</a>`);
  }
}

function savePromptDraft() {
  sessionStorage.setItem('spur_prompt_draft_'+state.activeAgentId, $('#agent-prompt').value);
  sessionStorage.setItem('spur_prompt_days', $('#prompt-days').value);
  $('#prompt-count').textContent = `${$('#agent-prompt').value.length.toLocaleString()} / 6,000`;
}

$('#agent-prompt').addEventListener('input', savePromptDraft);
$('#prompt-days').addEventListener('change', savePromptDraft);
$('#agent-prompt').addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); if (!$('#prompt-submit').disabled) $('#agent-prompt-form').requestSubmit(); }
});
$('#task-submit').addEventListener('click', async () => {
  if (promptSending) return;
  const agentId=state.activeAgentId;
  const topic = $('#agent-prompt').value.trim();
  if (!topic) { promptFeedback('<span>Enter a question or instructions for your agent.</span>', true); return; }
  promptSending = true; $('#task-submit').disabled = true; $('#task-submit').textContent = 'Starting…';
  savePromptDraft();
  try {
    const mission = await api('/missions', 'POST', {topic, days:Number($('#prompt-days').value),agent_id:agentId});
    sessionStorage.setItem('spur_prompt_mission_'+agentId,mission.mission_id);
    if(agentId!==state.activeAgentId){toast('Background task started.');return;}
    promptMissionId = mission.mission_id;
    promptJobId = ''; sessionStorage.removeItem('spur_prompt_job');
    promptSending = false;
    promptFeedback('<span>Mission accepted. Your agent is planning the next steps.</span><a href="#missions" class="text-button">View mission →</a>');
    await refresh();
  } catch (error) {
    promptFeedback(`<span>${escapeHtml(error.message)}</span>`, true);
  } finally { promptSending = false;$('#task-submit').disabled=false;$('#task-submit').textContent='Run as task'; }
});

function renderChat() {
  const agentId=state.activeAgentId, messages=agentChats.get(agentId), name=state.agents.find(a=>a.id===agentId)?.name || 'Agent';
  const pending=(messages || []).some(m=>['queued','running'].includes(m.status));
  $('#prompt-submit').disabled=pending || chatSending.has(agentId) || !messages;
  $('#prompt-submit').innerHTML=(pending?'Replying…':chatSending.has(agentId)?'Sending…':'Send')+' '+icon(pending?'clock':'arrow');
  const signature=JSON.stringify([agentId,messages,state.worker,state.missions.map(m=>[m.id,m.status,m.state.report_id])]);
  if(signature===chatSignature)return;
  const log=$('#agent-chat'),atBottom=log.scrollHeight-log.scrollTop-log.clientHeight<70;
  const changed=log.dataset.agent!==agentId;log.dataset.agent=agentId;chatSignature=signature;
  log.innerHTML=messages===undefined?'<p class="chat-empty">Loading this agent’s conversation…</p>':!messages.length?`<div class="chat-empty"><h3>Say hello to ${escapeHtml(name)}</h3><p>Discuss ideas here. Ask for a saved deliverable or research task when you’re ready.<br>Your chat history is saved separately for every agent.</p></div>`:
    (messages.length>=100?'<button class="text-button chat-earlier" data-chat-earlier>Load earlier messages ↑</button>':'')+messages.map(m=>{
      const links=(m.metadata.mission_ids || []).map(id=>{const mission=state.missions.find(x=>x.id===id);return `<div class="chat-task-link"><a href="#agent/${encodeURIComponent(agentId)}/missions">Background task · ${escapeHtml(mission?.status || 'View progress')} →</a>${mission?.state.report_id?`<button class="text-button" data-report="${escapeHtml(mission.state.report_id)}">Open output →</button>`:''}</div>`;}).join('');
      const status=m.role==='user' && ['queued','running'].includes(m.status)?`<p class="chat-status">${state.worker?(m.status==='queued'?'Queued for reply…':'Agent is replying…'):'Message saved. Start the background worker to receive a reply.'}</p>`:m.role==='user' && m.status==='failed'?`<p class="chat-status chat-failed">Reply failed: ${escapeHtml(m.error || 'Model request failed')} <button class="text-button" data-chat-retry="${escapeHtml(m.job_id)}">Retry reply</button></p>`:'';
      return `<article class="chat-message chat-${m.role==='user'?'user':'assistant'}"><div class="chat-message-meta"><strong>${escapeHtml(m.role==='user'?'You':name)}</strong><time>${date(m.created)}</time>${m.metadata.model?`<span>${escapeHtml(m.metadata.model)}</span>`:''}</div><div class="chat-message-text">${escapeHtml(m.content)}</div>${links}${(m.metadata.report_ids || []).map(id=>`<button class="text-button" data-report="${escapeHtml(id)}">Open saved report →</button>`).join('')}${status}</article>`;
    }).join('');
  if(changed || atBottom)log.scrollTop=log.scrollHeight;
}
async function refreshChat(agentId=state.activeAgentId) {
  if(chatLoads.has(agentId))return chatLoads.get(agentId);
  const load=api('/agents/'+encodeURIComponent(agentId)+'/chat').then(messages=>{
    const older=(agentChats.get(agentId) || []).filter(m=>messages.length && m.id<messages[0].id);
    agentChats.set(agentId,[...older,...messages]);
    if(state.activeAgentId===agentId){$('#chat-error').textContent='';renderChat();}
  }).finally(()=>chatLoads.delete(agentId));
  chatLoads.set(agentId,load);return load;
}
$('#agent-prompt-form').addEventListener('submit',async event=>{
  event.preventDefault();const agentId=state.activeAgentId,content=$('#agent-prompt').value.trim();
  if(!content || $('#prompt-submit').disabled)return;
  chatSending.add(agentId);$('#chat-error').textContent='';renderChat();
  const draftKey='spur_chat_request_'+agentId;
  let request;try{request=JSON.parse(sessionStorage.getItem(draftKey));}catch{}
  if(!request || request.content!==content)request={content,request_id:crypto.randomUUID()};
  sessionStorage.setItem(draftKey,JSON.stringify(request));
  try {
    await api('/agents/'+encodeURIComponent(agentId)+'/chat','POST',request);
    sessionStorage.removeItem(draftKey);
    if(state.activeAgentId===agentId && $('#agent-prompt').value.trim()===content){$('#agent-prompt').value='';savePromptDraft();}
    else if(sessionStorage.getItem('spur_prompt_draft_'+agentId)?.trim()===content)sessionStorage.removeItem('spur_prompt_draft_'+agentId);
    await refreshChat(agentId);
  } catch(error){if(state.activeAgentId===agentId)$('#chat-error').textContent=error.message;else toast(error.message);}
  finally{chatSending.delete(agentId);renderChat();}
});
$('#agent-chat').addEventListener('click',async event=>{
  const retry=event.target.closest('[data-chat-retry]'),earlier=event.target.closest('[data-chat-earlier]');
  if(!retry && !earlier)return;
  const agentId=state.activeAgentId;const button=retry || earlier;button.disabled=true;
  try{
    if(retry){await api('/agents/'+encodeURIComponent(agentId)+'/chat/'+encodeURIComponent(retry.dataset.chatRetry)+'/retry','POST');await refreshChat(agentId);}
    else{const messages=agentChats.get(agentId),older=await api('/agents/'+encodeURIComponent(agentId)+'/chat?before='+messages[0].id);agentChats.set(agentId,[...older,...messages]);if(agentId===state.activeAgentId){const log=$('#agent-chat'),height=log.scrollHeight;renderChat();log.scrollTop=log.scrollHeight-height;}if(!older.length)button.remove();}
  }catch(error){if(agentId===state.activeAgentId)$('#chat-error').textContent=error.message;}
  finally{button.disabled=false;}
});
async function openModal(mode) {
  modalMode = mode; $('#modal-error').textContent = ''; $('#modal-submit').disabled = false;
  const config = {
    agent:['Create a specialist agent','Give this agent a clear role. It will use the shared research tools and can receive coordinator assignments.','Create agent'],
    source:['Add a YouTube channel','Build a watchlist of the voices you want your agent to follow.','Add channel'],
    report:['Create a research report','Your agent investigates collected titles and descriptions, then returns findings with sources.','Generate report'],
    schedule:['Create a schedule','Run jobs automatically while the local backend is on. The first run starts immediately.','Create schedule'],
    settings:['Connect a model','Your agent keeps its knowledge and tools. Choose the model it uses to reason.','Save connection'],
    brief:['Your creator brief','Save your audience, voice, and constraints once. Every creator specialist can use this context.','Save brief'],
    handoff:['Send to a specialist','The selected specialist receives the complete saved deliverable and your revision instructions.','Start assignment'],
    knowledge:['Save agent knowledge','Add business context, research goals, preferences, or reference notes for future requests.','Save knowledge']
  }[mode];
  $('#modal-title').textContent = config[0]; $('#modal-description').textContent = config[1]; $('#modal-submit').textContent = config[2];
  if (mode==='brief') {
    $('#modal-fields').innerHTML='<p class="muted">Loading your brief…</p>';$('#form-dialog').showModal();
    const brief=await api('/creator-brief');
    $('#modal-fields').innerHTML=[['channel_name','Channel / creator name','Paris Pocket'],['niche','Content niche','Budget travel for first-time visitors'],['audience','Audience','Who watches, and what do they need?'],['voice','Voice and style','Warm, practical, specific'],['platforms','Platforms','YouTube, Shorts'],['production_constraints','Production constraints','Time, gear, cadence and budget'],['available_assets','Verified existing assets (optional)','What is already filmed, timed, approved, or confirmed?']].map(([id,label,placeholder])=>field('brief-'+id,label,textInput('brief-'+id,placeholder,brief[id] || '',false))).join('');return;
  }
  if (mode==='handoff') $('#modal-fields').innerHTML=field('handoff-agent','Specialist',`<select id="handoff-agent">${state.agents.filter(a=>a.creator_specialist).map(a=>`<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)}</option>`).join('')}</select>`)+field('handoff-instruction','Assignment instructions','<textarea id="handoff-instruction" required rows="5" placeholder="How should this agent adapt or improve the supplied output?"></textarea>');
  if (mode === 'agent') $('#modal-fields').innerHTML=field('new-agent-name','Agent name',textInput('new-agent-name','e.g. Travel Strategy Analyst'))+field('new-agent-description','What does it do?',textInput('new-agent-description','One sentence describing its role'))+field('new-agent-instructions','Specialist instructions','<textarea id="new-agent-instructions" required maxlength="6000" rows="6" placeholder="Describe its focus, evaluation criteria, and how it should present findings…"></textarea>','Uses the existing research toolset. Custom instructions do not add new integrations.');
  if (mode === 'source') $('#modal-fields').innerHTML = field('name','Channel name',textInput('name','e.g. My industry watchlist')) + field('channel','Channel ID or channel URL',textInput('channel','UC… or youtube.com/channel/UC…'),'Use the canonical UC channel ID. Handles and subscription imports are not supported yet.');
  if (mode === 'report') $('#modal-fields').innerHTML = (!state.model ? '<div class="notice">Connect OpenAI, DeepSeek, or Ollama in Settings before generating a report.</div>' : '') + field('topic','Research topic',textInput('topic','e.g. New developments in AI agent infrastructure')) + field('days','Lookback window','<select id="days"><option value="7">Last 7 days</option><option value="14">Last 14 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option></select>','Uses saved knowledge and collected videos. Collection does not run automatically before a report.');
  if (mode === 'knowledge') $('#modal-fields').innerHTML = field('knowledge-title','Title',textInput('knowledge-title','e.g. Our business and research priorities')) + field('knowledge-content','What should your agent know?','<textarea id="knowledge-content" rows="7" maxlength="12000" required placeholder="Describe your business, the topics that matter, the audience for your reports, or useful reference material…"></textarea>','Saved in your workspace and retrieved when the agent researches. Never add passwords or API keys here.');
  if (mode === 'schedule') $('#modal-fields').innerHTML = field('kind','Job type','<select id="kind"><option value="collect">Collect watched channels</option><option value="report">Generate a report</option></select>') + field('interval','Run frequency','<select id="interval"><option value="3600">Every hour</option><option value="21600">Every 6 hours</option><option value="86400" selected>Every day</option><option value="604800">Every week</option></select>') + '<div id="schedule-topic-fields" hidden>'+field('topic','Report topic',textInput('topic','Your research question','',false))+field('days','Lookback window','<select id="days"><option value="7">Last 7 days</option><option value="30">Last 30 days</option></select>')+'</div>';
  if (mode === 'settings') {
    $('#modal-fields').innerHTML = '<div class="notice">Loading model connection…</div>';
    $('#form-dialog').showModal();
    const connection = await api('/settings/provider').catch(() => ({provider:'openai',model:'',has_key:false}));
    if (modalMode !== mode || !$('#form-dialog').open) return;
    state.connection = connection;
    const provider = connection.model ? connection.provider : 'openai';
    $('#modal-fields').innerHTML = `<div class="harness-summary"><strong>Persistent harness → Replaceable model</strong><span>Knowledge · Sources · Tools · Jobs · Research history</span></div>` + field('provider','Model provider',`<select id="provider"><option value="openai" ${provider==='openai'?'selected':''}>OpenAI (models behind ChatGPT)</option><option value="deepseek" ${provider==='deepseek'?'selected':''}>DeepSeek API</option><option value="ollama" ${provider==='ollama'?'selected':''}>Ollama (optional local model)</option></select>`) + field('provider-model','Model ID',textInput('provider-model','Enter the model ID from your API account',connection.model),'Choose a model with tool calling and structured JSON support.') + `<div id="provider-key-fields">${field('provider-key','Provider API key','<input type="password" id="provider-key" placeholder="Paste your provider API key" autocomplete="off">','Saved on this machine using Windows user encryption, or read from the server environment. Keys are never returned to the browser.')}</div><div id="provider-guidance" class="notice"></div><button type="button" class="button secondary" data-action="test-provider">Test saved connection</button><p id="provider-test-result" class="muted" role="status"></p>`;
    updateProviderFields();
    return;
  }
  $('#form-dialog').showModal();
}

$('#modal-form').addEventListener('submit', async e => {
  e.preventDefault(); const button = $('#modal-submit'); button.disabled = true; $('#modal-error').textContent = '';
  try {
    if (modalMode==='brief') {
      const body={};for(const id of ['channel_name','niche','audience','voice','platforms','production_constraints','available_assets'])body[id]=$('#brief-'+id).value.trim();
      await api('/creator-brief','PUT',body);toast('Creator brief saved for your whole team.');
    } else if (modalMode==='handoff') {
      const agent_id=$('#handoff-agent').value;
      await api('/missions','POST',{topic:$('#handoff-instruction').value.trim(),days:7,agent_id,input_report_id:activeReport.id});
      location.hash='agent/'+agent_id+'/missions';toast('Specialist assignment started with your saved output.');
    } else if (modalMode === 'agent') {
      const agent=await api('/agents','POST',{name:$('#new-agent-name').value.trim(),description:$('#new-agent-description').value.trim(),instructions:$('#new-agent-instructions').value.trim()});
      state.agents.push(agent);location.hash='agent/'+agent.id+'/overview';toast('Specialist created and available to Marketing Lead.');
    } else if (modalMode === 'source') {
      let channel = $('#channel').value.trim();
      if (channel.includes('/')) { const url = new URL(channel.startsWith('http') ? channel : 'https://'+channel); if (!['youtube.com','www.youtube.com'].includes(url.hostname)) throw new Error('Enter a YouTube channel URL.'); channel = url.pathname.match(/^\/channel\/(UC[\w-]{22})\/?$/)?.[1] || ''; }
      if (!/^UC[\w-]{22}$/.test(channel)) throw new Error('Use a UC channel ID with 24 characters, or a youtube.com/channel/UC… URL.');
      await api('/sources','POST',{name:$('#name').value.trim(),channel_id:channel}); toast('Channel added to your watchlist. Collect now to find its latest videos.');
    } else if (modalMode === 'report') {
      if (!state.model) throw new Error('Connect a model in Settings first.');
      if (!state.videos.length && !state.knowledge.length) throw new Error('Save knowledge or collect videos before generating a report.');
      await api('/jobs/report','POST',{topic:$('#topic').value.trim(),days:Number($('#days').value)}); toast('Report queued. Follow its progress in Activity.'); location.hash = 'activity';
    } else if (modalMode === 'schedule') {
      const kind = $('#kind').value; const payload = {kind,interval_seconds:Number($('#interval').value)};
      if (kind === 'report') { if (!$('#topic').value.trim()) throw new Error('Enter a report topic.'); if (!state.model) throw new Error('Configure a model before scheduling reports.'); payload.report = {topic:$('#topic').value.trim(),days:Number($('#days').value)}; }
      await api('/schedules','POST',payload); toast('Schedule created. It will run when the worker next checks for jobs.');
    } else if (modalMode === 'settings') {
      const provider = $('#provider').value, model = $('#provider-model').value.trim();
      if (!model) throw new Error('Enter the model ID to use for agent requests.');
      const providerKey = $('#provider-key').value.trim();
      await api('/settings/provider','PUT',{provider,model,...(providerKey && provider !== 'ollama' ? {api_key:providerKey} : {})});
      $('#provider-key').value = '';
      toast('Model connection saved. Your agent’s knowledge is unchanged.');
    } else if (modalMode === 'knowledge') {
      await api('/knowledge','POST',{title:$('#knowledge-title').value.trim(),content:$('#knowledge-content').value.trim()});
      toast('Knowledge saved. Your agent can recall it in future requests.');
    }
    $('#form-dialog').close(); modalMode = ''; await refresh();
  } catch (error) { $('#modal-error').textContent = error.message; }
  finally { button.disabled = false; }
});

async function showReport(id) {
  try {
    const report = await api('/reports/'+encodeURIComponent(id)); activeReport = report;
    const r = report.content;
    $('#report-dialog .dialog-top .eyebrow').textContent=r.artifact?'CREATOR OUTPUT':'RESEARCH REPORT';
    if(r.artifact?.kind==='metadata_analysis'){window.spurMetadata.show(report);return;}
    if (r.artifact) {renderCreatorOutput(report);if(!$('#report-dialog').open)$('#report-dialog').showModal();return;}
    const evidence = (ids) => ids.map(id => { const item = r.sources[id]; return item ? (item.url && /^https:\/\//.test(item.url)?`<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.source_name)} · ${escapeHtml(item.title.slice(0,65))} ↗</a>`:`<span class="muted">${escapeHtml(item.title.slice(0,65))} · synthetic reference</span>`) : ''; }).join('');
    const findings = (title,items) => `<section class="report-section"><h3>${title}</h3>${items.length ? items.map(f => `<div class="finding"><h4>${escapeHtml(f.title)}</h4><p>${escapeHtml(f.observation)}</p><p><strong>Why it matters</strong> · ${escapeHtml(f.implication)}</p>${evidence(f.evidence_ids)}</div>`).join('') : '<p class="muted">The collected evidence did not support findings in this section.</p>'}</section>`;
    $('#report-detail').innerHTML = `<h2>${escapeHtml(r.topic)}</h2><div class="report-meta">${date(report.created)} · ${escapeHtml(r.model)} · ${shortDate(r.window_start)} – ${shortDate(r.window_end)}</div><div class="report-summary">${escapeHtml(r.summary)}</div>${findings('Key developments',r.developments)}${findings('Potential trends',r.potential_trends)}<section class="report-section"><h3>Research limitations</h3><ul>${r.limitations.map(l => `<li>${escapeHtml(l)}</li>`).join('')}</ul><p class="muted">${escapeHtml(r.evidence_type)}</p></section><section class="report-section"><h3>Collection coverage</h3>${sourceRows(r.coverage)}</section><details class="report-section"><summary class="muted">View agent tool trace</summary><pre>${escapeHtml(JSON.stringify(r.tool_trace,null,2))}</pre></details><div class="report-actions"><span class="muted">Grounded in your collected sources.</span><button class="button secondary" data-action="download-report">Download JSON</button></div>`;
    if(r.team_outputs?.length)$('#report-detail').insertAdjacentHTML('afterbegin',`<section class="team-output-links"><h3>Team deliverables</h3>${r.team_outputs.filter(o=>o.report_id).map(o=>`<button class="button secondary" data-report="${escapeHtml(o.report_id)}">${escapeHtml(o.agent)} →</button>`).join('')}</section>`);
    if(!$('#report-dialog').open)$('#report-dialog').showModal();
  } catch (error) { toast(error.message); }
}

document.addEventListener('toggle', e => {
  if (e.target.matches?.('[data-trace-id]')) {
    if (e.target.open) expandedTraces.add(e.target.dataset.traceId); else expandedTraces.delete(e.target.dataset.traceId);
  }
}, true);
document.addEventListener('click', async e => {
  const loadEvents=e.target.closest('[data-load-job-events]');
  if (loadEvents) {
    try { const id=loadEvents.dataset.loadJobEvents; const events=await api('/jobs/'+encodeURIComponent(id)+'/events'); loadedJobEvents.set(id,events); loadEvents.closest('details').querySelector('.trace-list').innerHTML=traceRows(events) || '<p class="muted">No detailed events recorded for this step.</p>'; } catch(error) {toast(error.message);}
    return;
  }

  const restore = e.target.closest('[data-restore-watchlist]');
  if (restore) {
    restore.disabled=true;
    try {const result=await api('/watchlist/restore/'+encodeURIComponent(restore.dataset.restoreWatchlist),'POST'); toast(`Restored ${result.restored} channels. Stopped missions remain stopped.`); await refresh();} catch(error) {toast(error.message);} finally {restore.disabled=false;}
    return;
  }
  const missionControl = e.target.closest('[data-mission-control]');
  if (missionControl) {
    missionControl.disabled = true;
    try {await api('/missions/'+encodeURIComponent(missionControl.dataset.missionId)+'/control','POST',{action:missionControl.dataset.missionControl}); await refresh();} catch(error) {toast(error.message);} finally {missionControl.disabled=false;}
    return;
  }
  const missionDetails = e.target.closest('[data-mission-details]');
  if (missionDetails) {
    try { const mission = await api('/missions/'+encodeURIComponent(missionDetails.dataset.missionDetails)); $('#mission-events-'+mission.id).innerHTML = traceRows(mission.events); } catch(error) {toast(error.message);}
    return;
  }
  const example = e.target.closest('[data-prompt-example]');
  if (example) { $('#agent-prompt').value = example.dataset.promptExample; savePromptDraft(); $('#agent-prompt').focus(); return; }
  const reportButton = e.target.closest('[data-report]'); if (reportButton) { showReport(reportButton.dataset.report); return; }
  const remove = e.target.closest('[data-delete-schedule]');
  if (remove) { try { await api('/schedules/'+encodeURIComponent(remove.dataset.deleteSchedule),'DELETE'); toast('Schedule removed. Already queued jobs will still run.'); await refresh(); } catch(error) {toast(error.message);} return; }
  const target = e.target.closest('[data-action]'); if (!target) return;
  const action = target.dataset.action;
  if (action==='ask-agent') {location.hash='agent/'+state.activeAgentId+'/overview';$('#agent-prompt').focus();return;}
  if (['source','report','schedule','settings','knowledge','agent','brief','handoff'].includes(action)) { if(action==='handoff')$('#report-dialog').close();openModal(action); return; }
  if (action === 'test-provider') {
    target.disabled = true; $('#provider-test-result').textContent = 'Checking the saved connection…';
    try { const result = await api('/settings/provider/test','POST'); $('#provider-test-result').textContent = `${result.ok ? '✓' : 'Needs attention:'} ${result.message}`; } catch(error) { $('#provider-test-result').textContent = error.message; } finally {target.disabled=false;}
  }
  if (action === 'close') { $('#form-dialog').close(); modalMode = ''; }
  if (action === 'close-report') $('#report-dialog').close();
  if (action === 'refresh') { await refresh(); toast('Workspace refreshed.'); }
  if (action === 'collect') {
    if (!state.sources.length) { openModal('source'); return; }
    target.disabled = true;
    try { await api('/jobs/collect','POST'); toast('Collection queued. Your worker will pick it up shortly.'); await refresh(); } catch (error) { toast(error.message); } finally {target.disabled = false;}
  }
  if (action==='copy-output' && activeReport) {try{await navigator.clipboard.writeText(outputText(activeReport));toast('Output copied.');}catch{toast('Clipboard unavailable. Use Download text instead.');}}
  if (action==='download-output' && activeReport) downloadOutput(outputText(activeReport),'txt');
  if (action==='download-calendar' && activeReport) {
    const rows=activeReport.content.artifact.data.entries;
    const quote=value=>'"'+String(value).replaceAll('"','""')+'"';
    const csv='Publish date,Filming date,Title,Format,Estimated hours,Production tasks,Dependencies\r\n'+rows.map(row=>[row.publish_date,row.filming_date || '',row.title,row.format,row.estimated_hours,row.production_tasks.join('; '),row.dependencies.join('; ')].map(quote).join(',')).join('\r\n');
    downloadOutput(csv,'csv');
  }
  if (action === 'download-report' && activeReport) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(activeReport,null,2)],{type:'application/json'}));
    const a = document.createElement('a'); a.href=url; a.download='spur-report-'+activeReport.id.slice(0,8)+'.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
  }
});
document.addEventListener('change', e => { if (e.target.id === 'kind') $('#schedule-topic-fields').hidden = e.target.value !== 'report'; if (e.target.id === 'provider') { $('#provider-key').value=''; $('#provider-model').value=''; updateProviderFields(); } });
$('#video-search').addEventListener('input',renderVideos);
$('#source-search').addEventListener('input', () => { const query = $('#source-search').value.toLowerCase(); const list = state.sources.filter(s => `${s.name} ${s.channel_id}`.toLowerCase().includes(query)); $('#source-list').innerHTML = list.length ? sourceRows(list) : empty('search','No matching channels','Try another channel name.'); });
window.addEventListener('hashchange',route);
window.addEventListener('spur:library-output',event=>showReport(event.detail.id).catch(error=>toast(error.message)));
window.addEventListener('spur:library-chat',event=>{
  const {agentId,content}=event.detail;
  const draft=sessionStorage.getItem('spur_prompt_draft_'+agentId);
  if(draft && draft!==content && !window.confirm('Replace the unsent message draft for this agent with the content brief?')){event.preventDefault();return;}
  location.hash='agent/'+encodeURIComponent(agentId)+'/overview';route();
  $('#agent-prompt').value=content;savePromptDraft();$('#agent-prompt').focus();
  toast('Content brief ready. Send it when you are ready to chat.');
});
document.addEventListener('click',event=>{
  const button=event.target.closest('[data-library-video]');
  if(button){button.disabled=true;window.spurLibrary.importOne('collected',button.dataset.libraryVideo).finally(()=>button.disabled=false);}
});
function updateProviderFields() {
  const provider = $('#provider').value;
  const current = $('#provider-model');
  const selected = current.value;
  if (provider === 'deepseek') {
    const models = [
      ['deepseek-flash', 'DeepSeek V4.1 Flash · deepseek-flash'],
      ['deepseek-v4-pro', 'DeepSeek V4 Pro · deepseek-v4-pro']
    ];
    // Preserve a previously saved ID even when the documented catalog changes.
    if (selected && !models.some(([id]) => id === selected)) models.push([selected, 'Saved model · '+selected]);
    const picker = document.createElement('select');
    picker.id = 'provider-model'; picker.name = 'provider-model'; picker.required = true;
    picker.innerHTML = '<option value="">Choose a DeepSeek model</option>' + models.map(([id,label]) => `<option value="${escapeHtml(id)}">${escapeHtml(label)}</option>`).join('');
    picker.value = selected; current.replaceWith(picker);
  } else if (current.tagName === 'SELECT') {
    const input = document.createElement('input');
    input.id = 'provider-model'; input.name = 'provider-model'; input.required = true;
    input.placeholder = provider === 'ollama' ? 'Enter an installed Ollama model name' : 'Enter the model ID from your API account';
    input.autocomplete = 'off'; input.value = selected; current.replaceWith(input);
  }
  $('#provider-key-fields').hidden = provider === 'ollama' || !!window.spurAuth.mockProfile;
  $('#provider-key').placeholder = state.connection?.provider === provider && state.connection.has_key ? 'Key configured. Leave blank to keep it.' : 'Paste your provider API key';
  $('#provider-guidance').textContent = provider === 'openai' ? 'Uses OpenAI’s API with separate API billing. Your ChatGPT subscription is not used by this connection. Retrieved workspace context is sent to OpenAI when you run the agent.' : provider === 'deepseek' ? 'Uses the DeepSeek API. Retrieved workspace context is sent to DeepSeek when you run the agent. Provider usage charges apply.' : 'Runs against your configured Ollama server. No hosted-model API key is required.';
    if(window.spurAuth.mockProfile)$('#provider-guidance').insertAdjacentHTML('afterbegin','<p><strong>Model for this mock profile</strong> · Uses your saved provider key. Your personal workspace and other profiles keep their current model. Manage API keys in your personal workspace.</p>');
}
function renderKnowledge() {
  const query = $('#knowledge-search').value.toLowerCase();
  const records = state.knowledge.filter(k => `${k.title} ${k.content}`.toLowerCase().includes(query));
  $('#knowledge-list').innerHTML = records.length ? records.map(k => `<article class="panel knowledge-card"><div class="knowledge-meta">${pill('neutral',k.kind === 'report' ? 'Past research' : 'Saved context')}<time>${date(k.created)}</time></div><h3>${escapeHtml(k.title)}</h3><p>${escapeHtml(k.kind === 'report' ? (() => {try{return JSON.parse(k.content).summary}catch{return k.content}})() : k.content)}</p>${k.report_id ? `<button class="text-button" data-report="${escapeHtml(k.report_id)}">Open original report →</button>` : ''}</article>`).join('') : empty('ring',query ? 'No matching knowledge' : 'An agent that builds on what it knows',query ? 'Try another search term.' : 'Save your business context and priorities. Completed research will be remembered here automatically.','knowledge','+ Save your first knowledge');
}
function renderPromptMission(mission) {
  if (promptSending) return;
  const s = mission.state, active = mission.status === 'active';
  const count = `${s.channels.length}${s.plan?.target_channels ? '/'+s.plan.target_channels : ''}`;
  const action=s.action_result;
  const text = action?.action==='clear_watchlist' ? `Removed ${action.removed} channels from your watchlist. Evidence and reports preserved.` : mission.status==='unsupported' ? `Unsupported action: ${action?.message || 'See mission details.'}` : mission.status === 'completed' ? (s.artifact_kind?'Your creator draft is ready.':'Mission completed. Your research is ready.') : mission.status === 'partial' ? 'Research finished with gaps. See the mission for details.' : `Mission ${mission.status} · ${s.phase.replaceAll('_',' ')} · ${count} channels followed`;
  promptFeedback(`<span>${icon(active ? 'pulse' : 'check')}${escapeHtml(text)}</span>${action?.restore_id ? `<button type="button" class="text-button" data-restore-watchlist="${escapeHtml(action.restore_id)}">Restore channels →</button>` : s.report_id ? `<button type="button" class="text-button" data-report="${escapeHtml(s.report_id)}">Read report →</button>` : '<a href="#missions" class="text-button">View mission →</a>'}`,['failed','unsupported'].includes(mission.status));
}
function marketingPlanMarkup(s) {
  const plan=s.team_plan;
  return `<div class="marketing-plan">${plan.strategy?`<p><strong>Marketing strategy</strong><br>${escapeHtml(plan.strategy)}</p>`:''}<ol>${plan.assignments.map((task,index)=>{
    const agent=state.agents.find(a=>a.id===task.agent_id),child=state.missions.find(m=>m.id===s.children?.[index]);
    return `<li><a href="#agent/${encodeURIComponent(task.agent_id)}/missions">${escapeHtml(agent?.name || task.agent_id)}</a>${pill(child?.status || 'neutral',child?.status || 'Planned')}<p>${escapeHtml(task.instruction)}</p></li>`;
  }).join('')}</ol>${plan.success_criteria?.length?`<p><strong>Proposed success criteria</strong><br>${plan.success_criteria.map(escapeHtml).join('<br>')}</p>`:''}</div>`;
}
function renderMissions() {
  const agentMissions=state.missions.filter(m=>(m.state.agent_id || 'youtube-research')===state.activeAgentId);
  $('#mission-list').innerHTML = agentMissions.length ? agentMissions.map(m => {
    const s=m.state, target=s.plan?.target_channels || 0, total=s.channels.length;
    const controls = (m.status==='active' ? ['pause','cancel'] : ['paused','failed'].includes(m.status) ? ['resume','cancel'] : []);
    return `<article class="panel mission-card"><div class="mission-title"><div><span class="eyebrow">${escapeHtml(m.status.toUpperCase())} · ${escapeHtml(s.phase.replaceAll('_',' ').toUpperCase())}</span><h2>${escapeHtml(m.prompt)}</h2></div><div class="mission-controls">${controls.map(action => `<button class="button secondary compact" data-mission-control="${action}" data-mission-id="${escapeHtml(m.id)}">${action[0].toUpperCase()+action.slice(1)}</button>`).join('')}</div></div><div class="mission-agent-links">${s.parent_mission_id ? `<a href="#agent/coordinator/missions">← Marketing Lead mission</a>` : ''}${(s.children || []).map(id=>{const child=state.missions.find(c=>c.id===id);return child ? `<a href="#agent/${encodeURIComponent(child.state.agent_id)}/missions">${escapeHtml(child.state.agent_name)} · ${escapeHtml(child.status)} ↗</a>` : ''}).join('')}</div><div class="mission-progress"><strong>${total}${target ? ' / '+target : ''} channels</strong><span>${s.queries_done} searches · ${s.checked.length} pages checked · ${s.model_calls} planning/screening calls · ${s.failures.length} collection gaps</span></div><progress max="${target || 1}" value="${total}"></progress>${s.team_plan ? marketingPlanMarkup(s) : ''}${s.plan || s.team_plan ? `<p class="muted">${escapeHtml((s.plan || s.team_plan).objective)}</p>` : '<p class="muted">Planning your request…</p>'}${s.shortfall ? `<p class="form-error">${escapeHtml(s.shortfall)}</p>` : ''}<p class="trace-explainer">Live actions, results, and decision summaries · updated every 4 seconds</p><div class="mission-links">${s.action_result?.restore_id ? `<strong class="muted">Removed ${s.action_result.removed} channels</strong><button class="text-button" data-restore-watchlist="${escapeHtml(s.action_result.restore_id)}">Restore channels →</button>` : ''}${s.report_id ? `<button class="text-button" data-report="${escapeHtml(s.report_id)}">Open saved output →</button>` : ''}<a class="text-button" href="#sources">Open watchlist →</a><button class="text-button" data-mission-details="${escapeHtml(m.id)}">Load full activity trail ↓</button></div><div id="mission-events-${m.id}" class="mission-events">${traceRows(m.events || [])}</div></article>`;
  }).join('') : empty('pulse','Give your agent a goal','Type a request on Overview, such as “Find and follow 100 Paris travel channels, then analyze their positioning.”');
}
function renderAgentDirectory() {
  const active=state.missions.filter(m=>m.status==='active');
  $('#platform-stats').innerHTML=`<div><strong>${state.agents.length}</strong><span>Agents in your ring</span></div><div><strong>${active.length}</strong><span>Active assignments</span></div><div><strong>${state.knowledge.length}</strong><span>Recent knowledge entries</span></div><div><strong>${state.worker?'Online':'Offline'}</strong><span>Background worker</span></div>`;
  $('#agent-directory').innerHTML=state.agents.map(a=>{
    const missions=state.missions.filter(m=>(m.state.agent_id || 'youtube-research')===a.id);
    const running=missions.filter(m=>m.status==='active').length;
    return `<article class="agent-card panel" data-agent-lead="${a.id==='coordinator'}" data-agent-name="${escapeHtml(a.name.toLowerCase())}"><div class="agent-card-top"><span class="agent-card-icon">${icon(a.id==='coordinator'?'grid':'ring')}</span>${pill(running?'running':'neutral',running?running+' active':a.id==='coordinator'?'Marketing lead':'Specialist')}</div><h3>${escapeHtml(a.name)}</h3><p>${escapeHtml(a.description)}</p><div class="agent-card-tools">${a.id==='coordinator'?'Strategy · Delegate · Coordinate · Review':a.workflow==='research'?'Discover · Collect · Research':escapeHtml(a.workflow)+' · Structured draft · Export'}</div><div class="agent-card-footer"><span>${missions.length} recent missions</span><a href="#agent/${encodeURIComponent(a.id)}/overview">${a.id==='coordinator'?'Brief your lead':'Open agent'} ${icon('arrow')}</a></div></article>`;
  }).join('')+`<button class="agent-create-card" data-action="agent"><span>+</span><strong>Add a specialist</strong><small>Give your next agent a focused role.</small></button>`;
  filterAgents();
}
function prettyLabel(key){return key.replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase());}
function artifactMarkup(value) {
  if(Array.isArray(value))return '<div class="artifact-collection">'+value.map((v,i)=>typeof v==='object'?`<article class="artifact-block"><span class="eyebrow">${i+1}</span>${artifactMarkup(v)}</article>`:`<p>• ${escapeHtml(v)}</p>`).join('')+'</div>';
  if(value && typeof value==='object')return Object.entries(value).map(([key,v])=>`<section class="artifact-field"><h4>${escapeHtml(prettyLabel(key))}</h4>${typeof v==='object'?artifactMarkup(v):`<p>${escapeHtml(v)}</p>`}</section>`).join('');
  return `<p>${escapeHtml(value)}</p>`;
}
function flattenOutput(value,level=0) {
  if(Array.isArray(value))return value.map((v,i)=>typeof v==='object'?`\n${i+1}.\n`+flattenOutput(v,level+1):'- '+v).join('\n');
  if(value && typeof value==='object')return Object.entries(value).map(([key,v])=>prettyLabel(key)+':\n'+flattenOutput(v,level+1)).join('\n\n');
  return String(value ?? '');
}
function outputText(report){const r=report.content;return (r.title || r.topic)+'\n\n'+r.summary+'\n\n'+flattenOutput(r.artifact?.data || r)+'\n\nASSUMPTIONS\n'+(r.assumptions || []).join('\n')+'\n\nVERIFY BEFORE PUBLISHING\n'+(r.verification_needed || []).join('\n');}
function downloadOutput(text,extension){const url=URL.createObjectURL(new Blob([text],{type:extension==='csv'?'text/csv;charset=utf-8':'text/plain;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='spur-output-'+activeReport.id.slice(0,8)+'.'+extension;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function renderCreatorOutput(report) {
  const r=report.content;
  $('#report-detail').innerHTML=`<div class="output-badges">${pill('neutral','CREATOR DRAFT')}${pill('neutral',r.artifact.kind)}</div><h2>${escapeHtml(r.title || r.topic)}</h2><div class="report-meta">${date(report.created)} · ${escapeHtml(r.provider)} · ${escapeHtml(r.model)}</div><div class="report-actions output-actions"><button class="button primary" data-action="handoff">Send to another agent →</button><button class="button secondary" data-action="copy-output">Copy text</button><button class="button secondary" data-action="download-output">Download text</button>${r.artifact.kind==='calendar'?'<button class="button secondary" data-action="download-calendar">Export calendar CSV</button>':''}</div><div class="report-summary">${escapeHtml(r.summary)}</div><div class="artifact-content">${artifactMarkup(r.artifact.data)}</div><section class="report-section"><h3>Assumptions</h3>${artifactMarkup(r.assumptions || [])}<h3>Verify before publishing</h3>${artifactMarkup(r.verification_needed?.length ? r.verification_needed : ['Review this draft for accuracy, voice, and platform requirements.'])}</section><p class="muted">Draft only. Nothing has been published, emailed, rendered, or uploaded.</p>`;
  if(r.team_outputs?.length)$('#report-detail').insertAdjacentHTML('afterbegin',`<section class="team-output-links"><h3>Open individual deliverables</h3>${r.team_outputs.filter(o=>o.report_id).map(o=>`<button class="button secondary" data-report="${escapeHtml(o.report_id)}">${escapeHtml(o.agent)} →</button>`).join('')}</section>`);
}
function filterAgents(){const query=$('#agent-filter').value.toLowerCase();document.querySelectorAll('[data-agent-name]').forEach(card=>card.hidden=!card.dataset.agentName.includes(query));}
$('#agent-filter').addEventListener('input',filterAgents);
$('#output-scope').addEventListener('change',refresh);
$('#knowledge-search').addEventListener('input',renderKnowledge);
globalThis.spurAuth.ready.then(()=>{
  // Account/profile draft storage has been restored by authentication at this point.
  $('#agent-prompt').value=sessionStorage.getItem('spur_prompt_draft_'+state.activeAgentId) || (state.activeAgentId==='youtube-research'?sessionStorage.getItem('spur_prompt_draft') || '':'');
  $('#prompt-days').value=sessionStorage.getItem('spur_prompt_days') || '7';
  promptJobId=state.activeAgentId==='youtube-research'?sessionStorage.getItem('spur_prompt_job') || '':'';
  promptMissionId=sessionStorage.getItem('spur_prompt_mission_'+state.activeAgentId) || '';
  savePromptDraft();route();refresh();setInterval(refresh,4000);
}).catch(error=>{$('#connection-banner').textContent=error.message;$('#connection-banner').classList.remove('hidden');});
