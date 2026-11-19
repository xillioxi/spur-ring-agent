import { useEffect, useRef, useState } from "react";
import { Sidebar, type Page } from "./Sidebar";
import { InversePrompting } from "./InversePrompting";
import { VideoGeneration } from "./VideoGeneration";
import { TaskInput } from "./TaskInput";
import { Conversation } from "./Conversation";
import { DetailDrawer } from "./DetailDrawer";
import { SpurMascot, useMascotColor } from "./SpurMascot";
import { featureGroups } from "./homeFeatures";
import { Deliverables } from "./Deliverables";
import { Mailbox } from "./Mailbox";
import { ConnectedApps } from "./ConnectedApps";
import { IdeaPage } from "./IdeaPage";
import { MemoryPage } from "./MemoryPage";
import { isSocialMemoryHash } from "./SocialAccounts";
import { BusinessWorkspace } from "./BusinessWorkspace";
import { businessPageFromHash, businessPages, businessRequest, type BusinessConfiguration } from "./businessApi";
import { connectionView, platforms } from "./platformCatalog";
import { Icon } from "./Icon";
import {
  apiBase,
  backendScope,
  backendLabel,
  publicGuest,
  apiRequest,
  submitTask,
  fetchTask,
  mergeSnapshot,
  taskHistory,
  type Task,
} from "./taskApi";
import {
  disconnectYoutube,
  readYoutubeConnection,
  startYoutubeConnection,
  type GuestConnection,
} from "./guestConnections";

const storageKey = () => "spur.web.tasks.v1:" + (backendScope || apiBase());
function readTasks(): Task[] {
  if (publicGuest) return [];
  try {
    const data = JSON.parse(localStorage.getItem(storageKey()) || "[]");
    return Array.isArray(data)
      ? data
          .filter(
            (t) =>
              typeof t.id === "string" &&
              /^[a-f0-9-]{36}$/.test(t.id) &&
              typeof t.title === "string" &&
              t.title.length <= 12000 &&
              Number.isFinite(Date.parse(t.createdAt)) &&
              [
                "running",
                "submitting",
                "finished",
                "failed",
                "unknown",
              ].includes(t.status)
          )
          .slice(0, 100)
          .map((t) => ({
            ...t,
            status: t.status === "submitting" ? "unknown" : t.status,
            events: [],
          }))
      : [];
  } catch {
    return [];
  }
}
export default function App() {
  const [inviteCode, setInviteCode] = useState("");
  const [inviteError, setInviteError] = useState("");
  const [inviteBusy, setInviteBusy] = useState(false);
  async function loginInvite(e: React.FormEvent) {
    e.preventDefault(); setInviteBusy(true); setInviteError("");
    try {
      await apiRequest('/api/guest/login', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:inviteCode.trim()})});
      window.location.assign('/');
    } catch (e) { setInviteError(e instanceof Error ? e.message : '验证失败，请重试。'); setInviteBusy(false); }
  }
  const [tasks, setTasks] = useState<Task[]>(readTasks);
  const initialId =
    window.location.hash.match(/^#task\/([a-f0-9-]{36})$/)?.[1] || "";
  const [selected, setSelected] = useState(initialId);
  const [page, setPage] = useState<Page>(
    window.location.hash === '#apps' ? 'apps' : !publicGuest && (window.location.hash === '#memory' || isSocialMemoryHash(window.location.hash)) ? 'memory' : !publicGuest && window.location.hash === '#video/generation' ? 'video/generation' : !publicGuest && window.location.hash === '#video/inverse-prompting' ? 'video/inverse-prompting' : !publicGuest && businessPageFromHash(window.location.hash) ? `business/${businessPageFromHash(window.location.hash)}` : initialId && tasks.some((t) => t.id === initialId) ? "workspace" : "home"
  );
  const [businessConfiguration,setBusinessConfiguration]=useState<BusinessConfiguration|null>(null);
  const [businessNavigationError,setBusinessNavigationError]=useState('');
  useEffect(()=>{
    if(publicGuest)return;
    let cancelled=false;
    businessRequest<BusinessConfiguration>('/modules').then(config=>{if(!cancelled)setBusinessConfiguration(config)}).catch(()=>{});
    return ()=>{cancelled=true};
  },[]);
  useEffect(()=>{
    function followHash(){if(window.location.hash==='#apps'){setPage('apps');return;}if(!publicGuest&&(window.location.hash==='#memory'||isSocialMemoryHash(window.location.hash))){setPage('memory');return;}if(!publicGuest&&window.location.hash==='#video/generation'){setPage('video/generation');return;}if(!publicGuest&&window.location.hash==='#video/inverse-prompting'){setPage('video/inverse-prompting');return;}const id=businessPageFromHash(window.location.hash);if(id&&!publicGuest)setPage(`business/${id}`);}
    window.addEventListener('hashchange',followHash);return ()=>window.removeEventListener('hashchange',followHash);
  },[]);
  async function collapseBusinessSidebar(){
    if(!businessConfiguration)return;
    setBusinessNavigationError('');
    try{const settings=await businessRequest<BusinessConfiguration['settings']>('/settings','PUT',{version:businessConfiguration.settings.version,sidebar_collapsed:!businessConfiguration.settings.sidebar_collapsed});setBusinessConfiguration({...businessConfiguration,settings});}catch(error){setBusinessNavigationError(error instanceof Error?error.message:'Could not save the sidebar preference.');}
  }
  const [input, setInput] = useState("");
  const [platformInfo, setPlatformInfo] = useState<string | null>(null);
  const guestYoutube = backendScope.startsWith("guest:") && !publicGuest;
  const [youtube, setYoutube] = useState<GuestConnection | null>(null);
  const [youtubeReady, setYoutubeReady] = useState(false);
  const [youtubeBusy, setYoutubeBusy] = useState(false);
  const [youtubeError, setYoutubeError] = useState("");
  async function refreshYoutube() {
    if (!guestYoutube) {
      setYoutubeReady(true);
      return;
    }
    try {
      setYoutube(await readYoutubeConnection());
      setYoutubeError("");
    } catch (e) {
      setYoutube(null);
      setYoutubeError(e instanceof Error ? e.message : "暂时无法读取 YouTube 连接。");
    } finally {
      setYoutubeReady(true);
    }
  }
  useEffect(() => {
    if (!guestYoutube) return;
    void refreshYoutube();
    const onFocus = () => void refreshYoutube();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [guestYoutube]);
  async function connectYoutube() {
    if (youtubeBusy) return;
    setYoutubeBusy(true);
    setYoutubeError("");
    try {
      window.location.assign(await startYoutubeConnection());
    } catch (e) {
      setYoutubeError(e instanceof Error ? e.message : "连接未完成，请重试。");
      setPlatformInfo("YouTube");
      setYoutubeBusy(false);
    }
  }
  async function removeYoutube() {
    if (youtubeBusy) return;
    setYoutubeBusy(true);
    setYoutubeError("");
    try {
      await disconnectYoutube();
      await refreshYoutube();
    } catch (e) {
      setYoutubeError(e instanceof Error ? e.message : "断开失败，请重试。");
    } finally {
      setYoutubeBusy(false);
    }
  }
  const mascot = useMascotColor();
  const [comingSoon, setComingSoon] = useState(false);
  const [sidebar, setSidebar] = useState(false);
  const [ready, setReady] = useState<
    "checking" | "ready" | "offline" | "unauthorized"
  >("checking");
  const [storageWarning, setStorageWarning] = useState(false);
  const taskRef = useRef(tasks);
  taskRef.current = tasks;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const submitting = useRef(false);
  const mounted = useRef(true);
  const task = tasks.find((t) => t.id === selected);
  function update(id: string, change: (t: Task) => Task) {
    if (mounted.current)
      setTasks((list) => list.map((t) => (t.id === id ? change(t) : t)));
  }
  function openTask(id: string) {
    setSelected(id);
    setPage("workspace");
    setSidebar(false);
    window.history.replaceState(null, "", "#task/" + id);
  }
  function navigate(next: Page) {
    if(publicGuest&&next!=="home"&&next!=="apps"){setInviteError('输入邀请码后，即可打开你的独立工作空间。');setPage('home');setSidebar(false);document.getElementById('guest-invite-code')?.focus();return;}
    setSidebar(false);
    if (next === "workspace" && !selected && tasks.length) {
      openTask(tasks[0].id);
      return;
    }
    setPage(next);
    if(next==='apps'||next==='memory'||next.startsWith('business/')||next.startsWith('video/'))window.history.replaceState(null,'','#'+next);
    else if (next !== "workspace")
      window.history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search
      );
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(
        storageKey(),
        JSON.stringify(
          tasks.map(({ id, title, createdAt, status, parentId }) => ({
            id,
            title,
            createdAt,
            status,
            parentId,
          }))
        )
      );
      setStorageWarning(false);
    } catch {
      setStorageWarning(true);
    }
  }, [tasks]);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function check() {
      if(publicGuest){if(!stopped)setReady("unauthorized");return;}
      try {
        await apiRequest("/api/creator-agent/health");
        if (!stopped) setReady("ready");
      } catch (e) {
        if (!stopped)
          setReady(
            (e as { status?: number }).status === 401
              ? "unauthorized"
              : "offline"
          );
      }
      if (!stopped) timer = setTimeout(() => void check(), 30000);
    }
    void check();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const targets = taskRef.current.filter(
        (t) =>
          t.status === "running" ||
          ((t.id === selectedRef.current ||
            (() => {
              let c = taskRef.current.find((x) => x.id === selectedRef.current);
              const seen = new Set<string>();
              while (c && !seen.has(c.id)) {
                seen.add(c.id);
                if (c.parentId === t.id) return true;
                c = taskRef.current.find((x) => x.id === c?.parentId);
              }
              return false;
            })()) &&
            ((t.status === "finished" && !t.result) ||
              (t.status === "failed" && !t.error)) &&
            !t.connectionError)
      );
      for (const current of targets) {
        if (stopped) break;
        try {
          const snapshot = await fetchTask(current.id);
          if (!stopped) update(current.id, (t) => mergeSnapshot(t, snapshot));
        } catch (e) {
          if (!stopped)
            update(current.id, (t) => ({
              ...t,
              status:
                (e as { status?: number }).status === 404
                  ? "unknown"
                  : t.status,
              connectionError:
                e instanceof Error
                  ? e.message
                  : "连接暂时中断，正在查询原任务。",
            }));
        }
      }
      if (!stopped) timer = setTimeout(() => void poll(), 2000);
    }
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);
  async function refresh(id: string) {
    update(id, (t) => ({ ...t, connectionError: undefined }));
    try {
      const snapshot = await fetchTask(id);
      update(id, (t) => mergeSnapshot(t, snapshot));
    } catch (e) {
      update(id, (t) => ({
        ...t,
        connectionError:
          e instanceof Error ? e.message : "暂时无法查询，请保留任务编号。",
      }));
    }
  }
  async function send(text: string, parent?: Task) {
    if(publicGuest){setInviteError('请输入邀请码后再提交任务。');return;}
    if (!text.trim() || submitting.current) return;
    submitting.current = true;
    const id = crypto.randomUUID();
    const title = text.trim();
    setTasks((list) =>
      [
        {
          id,
          title,
          createdAt: new Date().toISOString(),
          status: "submitting" as const,
          events: [],
          parentId: parent?.id,
        },
        ...list,
      ].slice(0, 100)
    );
    setInput("");
    openTask(id);
    try {
      const history = taskHistory(parent, taskRef.current);
      const result = await submitTask(id, title, history);
      update(id, (t) => ({
        ...t,
        status: result ? "finished" : "running",
        result: result || undefined,
        plan: result?.plan,
      }));
    } catch (e) {
      const message = e instanceof Error ? e.message : "提交回执未确认。";
      update(id, (t) => ({
        ...t,
        status:
          (e as { status?: number }).status === 422 ? "failed" : "unknown",
        error: message,
        connectionError: "请查询原任务状态，避免重复提交。",
      }));
    } finally {
      submitting.current = false;
    }
  }
  return (
    <div className={`app-shell v5-shell ${businessConfiguration?.settings.sidebar_collapsed?'business-sidebar-collapsed':''}`} style={mascot.style}>
      <Sidebar
        page={page}
        tasks={tasks}
        selected={selected}
        open={sidebar}
        onClose={() => setSidebar(false)}
        onPage={navigate}
        onTask={openTask}
        businessModules={businessConfiguration?.modules}
        businessCollapsed={businessConfiguration?.settings.sidebar_collapsed}
        onBusinessCollapse={()=>void collapseBusinessSidebar()}
      />
      <main className="main-panel">
        <header className="topbar">
          <div>
            <button
              className="icon-button mobile-menu"
              aria-label="打开导航"
              onClick={() => setSidebar(true)}
            >
              <Icon name="menu" />
            </button>
            <span className="product-label">
              Personal Agent<span>/</span>
              <strong>
                {page === 'video/generation'
                  ? 'Video / Generation'
                  : page === 'video/inverse-prompting'
                  ? 'Video / Inverse prompting'
                  : page.startsWith('business/')
                  ? businessPages[page.slice(9)]?.[0] || 'Business'
                  : page === "home"
                  ? "Your next possibility"
                  : page === "workspace"
                  ? "Workspace"
                  : page === "agent"
                  ? "Agent updates"
                  : page === "mail"
                  ? "Agent Mail"
                  : page === "tasks"
                  ? "Tasks"
                  : page === "idea"
                  ? "Idea"
                  : page === "memory"
                  ? "Memory"
                  : "Deliverables"}
              </strong>
            </span>
          </div>
          <span
            className={`connection-badge connection-${page.startsWith('video/') || page === 'memory' ? 'checking' : ready}`}
            title={
              ready === "unauthorized"
                ? "当前服务需要授权；网页没有嵌入服务端密钥。"
                : undefined
            }
          >
            <i />
            {page === 'video/generation'
              ? 'Private generation workspace'
              : page === 'video/inverse-prompting'
              ? 'Private video workspace'
              : page === 'memory'
              ? 'Private memory'
              : ready === "ready"
              ? `${backendLabel} · 已连接`
              : ready === "checking"
              ? "Connecting…"
              : ready === "unauthorized"
              ? (publicGuest ? "邀请体验" : "需要授权")
              : "Agent offline"}
          </span>
          {backendScope.startsWith('guest:')&&!publicGuest&&<button className="icon-button" onClick={async()=>{try{await fetch('/api/guest/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});window.location.assign('/')}catch{}}}>退出登录</button>}
        </header>
        {storageWarning && (
          <div className="storage-warning">
            浏览器未允许保存历史。请保留任务编号，关闭页面可能丢失本地任务入口。
          </div>
        )}
        {businessNavigationError&&<div className="storage-warning" role="alert">{businessNavigationError}</div>}
        <div className={`page-content page-${page}`}>
          {page === 'video/generation' ? (
            <VideoGeneration />
          ) : page === 'video/inverse-prompting' ? (
            <InversePrompting />
          ) : page.startsWith('business/') ? (
            <BusinessWorkspace page={page.slice(9)} configuration={businessConfiguration} onConfiguration={setBusinessConfiguration} onNavigate={next=>navigate(next as Page)} />
          ) : page === "home" || page === "workspace" ? (
            <section
              className={`home ${
                page === "workspace" && task ? "home-conversation" : ""
              }`}
            >
              {page === "workspace" && task ? (
                <Conversation
                  task={task}
                  tasks={tasks}
                  onContinue={(text) => void send(text, task)}
                  onRefresh={(id) => void refresh(id)}
                />
              ) : (
                <>
                  <div className="home-intro">
                    <SpurMascot color={mascot.color} onColor={mascot.choose} />
                  </div>
                  <div className="home-composer">
                    {publicGuest ? <form className="guest-invite-composer" onSubmit={loginInvite}>
                      <label htmlFor="guest-invite-code">输入邀请码，开启你的 Personal Agent</label>
                      <input id="guest-invite-code" value={inviteCode} onChange={e=>setInviteCode(e.target.value)} placeholder="粘贴你的专属邀请码…" autoComplete="off" spellCheck={false} maxLength={43} required aria-describedby="guest-invite-note" />
                      <div className="guest-invite-bottom"><span id="guest-invite-note">独立工作空间 · 登录保持约 30 天</span><button type="submit" disabled={inviteBusy||!inviteCode.trim()}>{inviteBusy?'正在验证…':'验证并开始 →'}</button></div>
                      {inviteError&&<p className="task-error" role="alert">{inviteError}</p>}
                    </form> : <TaskInput
                      value={input}
                      onChange={setInput}
                      onSubmit={() => void send(input)}
                    />}
                  </div>
                  <div className="feature-groups">
                    {featureGroups.map((group) => (
                      <section
                        className="feature-group"
                        key={group.en}
                        aria-label={group.label}
                      >
                        <h2>
                          <span>{group.label}</span>
                          {group.en}
                        </h2>
                        <div className="feature-tiles">
                          {group.items.map(([label, icon, color]) => (
                            <button
                              key={label}
                              type="button"
                              onClick={() => setComingSoon(true)}
                            >
                              <span className={"feature-icon feature-" + color}>
                                {icon}
                              </span>
                              <span>{label}</span>
                            </button>
                          ))}
                        </div>
                      </section>
                    ))}
                  </div>
                  <section className="platform-connect" aria-label="连接平台">
                    <button type="button" className="platform-heading" onClick={() => navigate("apps")}>
                      <strong>Connect your platforms</strong>
                      <small>连接授权数据，让 Agent 更了解你的工作。</small>
                    </button>
                    <div className="platform-buttons">
                      {platforms.filter((platform) => platform.home).map((platform) => {
                        const view = connectionView(platform.id, youtube, guestYoutube, youtubeReady);
                        return (
                          <button key={platform.id} type="button" onClick={() => navigate("apps")}>
                            <span>{platform.mark} {platform.name}</span>
                            <small>
                              {view.label}
                              {view.account ? " · " + view.account : ""}
                            </small>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                </>
              )}
            </section>
          ) : page === "agent" ? (
            <section className="agent-updates">
              <span className="eyebrow">YOUR AGENT, LOOKING AHEAD</span>
              <h1>Agent updates</h1>
              <p>重要发现与需要你跟进的事项，集中在这里。</p>
              <div className="updates-empty">
                <span>✧</span>
                <h2>暂时没有可展示的主动推送</h2>
                <p>
                  此网页尚未接入可靠的个人主动推送数据源。连接状态和真实来信可在已有服务中核对，不会用示例代替真实发现。
                </p>
                <button
                  className="secondary-button"
                  onClick={() => navigate("mail")}
                >
                  打开 Agent 邮箱 →
                </button>
              </div>
            </section>
          ) : page === "apps" ? (
            <ConnectedApps
              signedIn={guestYoutube}
              ready={youtubeReady}
              youtube={youtube}
              busy={youtubeBusy}
              error={youtubeError}
              onConnect={() => void connectYoutube()}
              onDisconnect={() => void removeYoutube()}
              onRefresh={() => void refreshYoutube()}
              onNeedLogin={() => {
                setInviteError("先输入邀请码，即可连接你自己的 YouTube。");
                navigate("home");
                window.setTimeout(() => document.getElementById("guest-invite-code")?.focus(), 0);
              }}
            />
          ) : page === "mail" ? (
            <Mailbox onClose={() => navigate("home")} />
          ) : page === "idea" ? (
            <IdeaPage />
          ) : page === "memory" ? (
            <MemoryPage />
          ) : (
            <Deliverables
              tasks={tasks}
              onTask={openTask}
              history={page === "tasks"}
              onHome={() => navigate("home")}
            />
          )}
        </div>
      </main>
      {comingSoon && (
        <ComingSoonDialog onClose={() => setComingSoon(false)} />
      )}
      {platformInfo && (
        <DetailDrawer
          title={"连接 " + platformInfo}
          onClose={() => setPlatformInfo(null)}
        >
          <h2>{platformInfo}</h2>
          {platformInfo === "YouTube" && guestYoutube ? (
            <>
              <p>
                {youtube?.state === "connected"
                  ? "已连接" + (youtube.label ? "：" + youtube.label : " YouTube。") + " Spur 只能读取你授权的频道和只读分析数据。"
                  : youtube?.state === "needs_reconnect"
                  ? "授权已失效，请重新连接。"
                  : "连接后，Spur 只能读取这个访客自己授权的 YouTube 数据。"}
              </p>
              {youtubeError && <p className="task-error" role="alert">{youtubeError}</p>}
              {youtube?.state === "connected" ? (
                <button className="secondary-button" disabled={youtubeBusy} onClick={() => void removeYoutube()}>
                  {youtubeBusy ? "正在断开…" : "断开 YouTube"}
                </button>
              ) : (
                <button className="secondary-button" disabled={youtubeBusy} onClick={() => void connectYoutube()}>
                  {youtubeBusy ? "正在打开授权…" : "连接 YouTube"}
                </button>
              )}
            </>
          ) : (
            <p>此网页尚未接入该平台的用户授权流程，无法核实当前账号连接状态。</p>
          )}
          <div className="insight-evidence">
            <strong>能力与授权是两回事</strong>
            <p>
              公开内容搜索可由现有工具执行，但不代表已连接你的账号或能读取私人数据。已有
              iPhone 授权不在此网页自动显示为已连接。
            </p>
          </div>
          {!(platformInfo === "YouTube" && guestYoutube) && (
            <>
              <h3>下一步</h3>
              <p>
                你可以先提出公开内容研究任务；账号授权入口需要接入现有身份与连接接口后才能使用。
              </p>
            </>
          )}
          <button
            className="secondary-button"
            onClick={() => setPlatformInfo(null)}
          >
            知道了
          </button>
        </DetailDrawer>
      )}
    </div>
  );
}

function ComingSoonDialog({ onClose }: { onClose: () => void }) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const buttonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    buttonRef.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, []);
  return (
    <div className="coming-soon-layer">
      <button
        type="button"
        className="coming-soon-veil"
        aria-label="Close"
        onClick={onClose}
      />
      <section
        className="coming-soon-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="coming-soon-title"
      >
        <h2 id="coming-soon-title">Coming soon</h2>
        <button
          ref={buttonRef}
          type="button"
          className="coming-soon-dismiss"
          onClick={onClose}
        >
          Got it
        </button>
      </section>
    </div>
  );
}
