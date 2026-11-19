# Spur Creator Web

## Memory → Email network

Open `#memory` to connect Gmail, Outlook / Microsoft 365, Zoho or another IMAP
provider, sync mailbox metadata and explore the people and
source messages behind an interactive network. The default view uses real mailbox
data; fictional records remain under Illustrative examples. See the
[email Memory guide](email-memory/README.md) for connections, privacy, limits and API tools.

## Video → Inverse prompting

Open `#video/inverse-prompting` in the existing app to upload a reference video,
extract its spoken script and visible text, and create a timed visual breakdown
with copyable reconstruction prompts. Results are saved and export as TXT, Markdown
or JSON. Analysis uses the configured backend provider. SiliconFlow mode sends
the complete video and synchronized audio through the server to one multimodal
model; provider credentials stay on the backend. Local analysis remains available
when explicitly selected.
See [video-analysis/README.md](video-analysis/README.md) for runtime setup, limits,
supported source handling and verification evidence.

## Creator business modules in the existing Spur UI

The original Home, mascot, Idea, Agent, Memory, conversations, task history,
deliverables, mailbox and connected-app pages remain the UI base. The **Business**
group in that same sidebar adds Overview, Action Center, Leads, Clients, Projects
and tasks, Calendar, Finances, Analytics, Modules and Business settings.

Business records are persistent and shared across those screens and the native
DeepSeek Harness tools. Leads convert into clients once; projects, tasks, events
and finance entries link by record ID. Paid income, expenses, net earnings,
outstanding payments and pipeline use server decimal calculations, with separate
totals for each currency and drill-through to the source records. These screens
work without a model connection.

Enable Portfolio & Services, Proposals & Contracts, Collaboration & Delivery, or
Opportunities in Modules to use their native record forms. They store private
references, service offerings, proposal drafts, delivery links, feedback and
manually recorded statuses. Business automation execution, public portfolios,
client portals and contract signing are not connected. Existing connected-app and
external-action flows retain their own authorization requirements.

Business storage requires **Python 3.10+ with Pydantic 2**, in addition to this
app's existing Node setup. A private process adapter calls the same validated
SQLite service for both HTTP and Harness requests; it starts no second web server.
For a fresh Windows setup, from `V2/web`:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r business\requirements.txt
$env:SPUR_BUSINESS_PYTHON = (Resolve-Path .venv\Scripts\python.exe).Path
npm ci
npm start
```

On macOS/Linux, install `business/requirements.txt` in a Python environment and set
`SPUR_BUSINESS_PYTHON` to that environment's Python executable. The fallback is
`python3` (`python` on Windows). The server returns a clear 503 if dependencies are
missing. Keep the variable set in the server process; the browser never receives
database paths or model/provider credentials. Start `npm run dev` in a second
terminal and open `http://127.0.0.1:5174/`.

Storage is under `SPUR_RUNTIME_ROOT/business/owner/business.db`, or under a
server-validated connection profile's private directory. Guest access routes to
the authenticated guest's existing worker and its own runtime. Neither an HTTP
body nor a tool argument may choose a workspace path. The guest/cloud gateways
allow only the explicit business routes; updating local code does not deploy them.

`GET /api/creator-agent/business/tools` discovers the 12 callable functions;
`POST /api/creator-agent/business/execute` invokes one. They are also registered
as the native `spur-business-workspace` Harness plugin. Read/write permission is
checked on every call, with transactional checks for mutations. Hiding a module
only hides navigation; use its AI permission checkboxes to revoke access. The
global AI switch stops new Harness runs and tool calls. It cannot recall an
external model request already in flight. Tools cannot enable their own access,
send mail, publish, make payments or sign agreements.
The Integrations grants also apply to the existing Notion and YouTube tools.
Notion writes are hidden by default and recheck current write access before a
provider request or receipt replay. The user's direct connected-app UI remains
under its existing authentication and confirmation flows.

See [HARNESS_HANDOFF.md](HARNESS_HANDOFF.md) for schemas, examples and retry rules.
Changes retain stable IDs, provenance, actors, audit history and optimistic record
versions. JSON/CSV export is available in Business settings. Creation, conversion,
updates and archiving support durable request receipts; reuse a request ID only
for the identical intended action.

Validation: `npm run build`, `python -m pytest business/test_domain.py -q`, and
`node --test tests/business-*.test.mjs ../agent/tools/business-workspace/index.test.cjs`.
The process tests use the Python selected above. Model/plugin tests use local
fixtures; live provider consent, model responses and external sending are outside
those tests. The new gateway identity tests model Unix private-file metadata on
Windows without changing production's permission checks.

## 2026-11-07：Personal Agent Web 工作空间

本轮改为极简Home、Agent Workspace、任务历史、成果库，并保留Agent邮箱和视频任务。前端使用既有异步接口：POST `/api/creator-agent/chat`（async:true），再GET `/api/creator-agent/tasks/{id}`。不使用模拟进度或模拟成果。

推荐本地体验方式（依赖已安装时，无需重新npm install）：

```bash
# 终端一：既有后端，默认127.0.0.1:4173
cd /Users/x/X/space/spur/V2/web
npm start

# 终端二：前端开发入口
cd /Users/x/X/space/spur/V2/web
npm run dev
```

打开 `http://127.0.0.1:5174/`。Vite默认代理至本机4173，并仅对当前本机开发页面的同源请求适配后端既有Origin约定；不会为跨站请求补授权，也不附加公网Bearer。旧文档中开发后端8788的默认配置不再适用于这一默认代理。

`npm run build`用于TypeScript与生产构建；`node --test tests/task-api.test.mjs`验证异步任务、丢失回执不重发、鉴权拒绝、文件链接保留和后续任务上下文。任务历史仅将编号、需求、时间、状态和父任务编号保存在此浏览器，结果在打开原任务时查询，不是完整云端任务历史或跨设备同步。

公网Web会话授权仍需后续单独接续。本轮未把服务端Token或Connector密钥注入前端，未修改Node后端、ECS、Caddy、Docker或环境文件。下文是历史启动和能力说明，实时验证记录以V2/docs同日Web UI开发记录为准。

Spur 面向自媒体创作者的网页对话入口。聊天请求由本地 API 适配层调用 DeepSeek Harness，模型密钥只从 `V2/agent/config/siliconflow.env` 或当前进程环境读取。

## 本地启动

先构建前端，再启动同源网页和 API 服务：

```bash
cd /Users/x/X/space/spur/V2/web
npm install
npm run build
npm start
```

默认本机地址为 `http://127.0.0.1:4173/`。开发模式仍可使用 Vite；需要同时启动 `npm run dev` 和 `PORT=8788 npm start`。

`npm start` 会选择已安装的兼容 Node.js 版本；在 macOS 上会读取系统 HTTP(S) 代理设置，供后端访问 AgentMail 等外部 API。浏览器可通过系统代理联网、但 Node 未走代理时，AgentMail 的 CloudFront 网关可能返回 403。

## Agent 接入

网页不直接持有模型或邮件 API 密钥。后端逐条请求启动 DeepSeek Harness headless 会话，使用 SiliconFlow 的 `SPUR_CHAT_MODEL`；网页把最近对话作为上下文传入。Harness 可调用只读 Creator 视频研究工具，并将报告保存在 `V2/web/.runtime/runs/`。响应字段：`response` 为文本，`sources` 和 `artifacts` 为可选链接数组。

### AgentMail 本地收件箱与确认回复

在被忽略的 `V2/agent/config/siliconflow.env` 中添加以下两项，然后重启服务。不要把 Key 放入网页、聊天、命令历史或 Git。当前本机控制台显示 Key 为 Full Access；由于启用了用户确认后回复的功能，建议改用仅覆盖该收件箱、且只包含 `inbox_read`、`message_read`、`message_send` 的 Bearer Key。AgentMail 的 `message_reply` 权限仅用于注册公钥的回复方式，Bearer Key 回复需要 `message_send`：

```ini
AGENTMAIL_API_KEY=你的只读API密钥
AGENTMAIL_INBOX_ID=你的AgentMail收件箱地址
```

侧栏“合作收件箱”可刷新最近来信。选择单封邮件并点击分析后，后端才会把正文交给当前 SiliconFlow 模型生成合作摘要和未发送回复草稿。网页会提取并允许编辑回复主题和正文；只有用户点击“确认并发送回复”，并在系统确认框再次确认后，后端才会在原邮件线程中回复原发件人。服务只允许来自本机页面的确认请求，并在本地记录已发送邮件编号以防重复发送。仍不会自动发送、标记已读或删除邮件。分析运行的 Harness 会话文件保存在本机忽略目录 `V2/web/.runtime/runs/`。

当前采用人工刷新，便于先验证邮箱授权和内容解析；公网 Webhook/后台常驻收信、用户账号隔离和云端发送审批尚未实现。服务默认绑定 `127.0.0.1`，不是可公开部署的多用户服务。

运行要求：DeepSeek Harness 构建文件和依赖可用，并有 Node.js 22.19+ 或 24+。服务默认只绑定 `127.0.0.1`，最多并行处理两个请求，单次运行最长八分钟。它是本地验证后端，不是云端部署；公开服务前需增加登录、会话隔离、密钥托管、限流和审批。

### Instagram and Messenger inbox sign-in

Social Network uses Facebook Login to connect Messenger Page inboxes and professional Instagram accounts linked to a Page. Configure the Meta app on the backend with `META_APP_ID` and `META_APP_SECRET`. Register `http://127.0.0.1:4173/api/meta-login/callback` for local development if your Meta app permits it. For a registered HTTPS callback, set `META_REDIRECT_URI` to the exact callback URL and route both `/api/meta-login/authorize` and `/api/meta-login/callback` to the same Spur backend. Restart Spur after configuration.

Request `pages_show_list`, `pages_read_engagement` and `pages_manage_metadata`, plus `pages_messaging` for Messenger or `instagram_basic` and `instagram_manage_messages` for Instagram. For Facebook Login for Business configurations, supply `META_MESSENGER_LOGIN_CONFIG_ID` and/or `META_INSTAGRAM_LOGIN_CONFIG_ID` with the corresponding permissions and user-token configuration. The person signing in needs messaging access to each selected Page. Production access requires the applicable Meta app review and business verification.

Spur syncs text messages after sign-in and checks for updates every five minutes while running. Meta limits Instagram message details to the most recent 20 per conversation. On Windows, the host protects Page tokens with DPAPI. Sync stores messages in the workspace’s social archive. Disconnecting clears local credentials and keeps the cached conversations.
