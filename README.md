# Spur Ring Intelligence Agent

## Cross-platform content search

Open **Discover content** (`/#discover`) to search real provider results. YouTube uses
the connected account's OAuth token with the official Data API (`search.list` then
`videos.list`), independently of the model. TikTok, Instagram Reels and Rednote have
optional TikHub adapters based on its public API schema; they require a provider key
and live-response validation. Broad LinkedIn topic search is explicitly unsupported.
These are bounded one-page searches, not exhaustive indexes or autonomous monitoring.

**Search data settings** stores the provider key encrypted in the current user's
workspace. Paid discovery is disabled by default. Enabling requires a verified maximum
per-request price. The local estimated budget is capped at US$25/month, with configurable
daily/monthly attempt limits. Attempts are reserved transactionally, including failures;
rotating credentials does not reset usage. These reservations cannot enforce the vendor's
actual invoice: verify endpoint prices and configure its own balance/spending cap.
No automatic paid pagination/retries are used. Chat tools reuse successful searches or
report failed/uncertain attempts on job retry rather than silently charging again.

Endpoints: `GET /search/providers`, `PUT /search/providers/tikhub`, and
`POST /search/videos` (`platform`, `query`, `days`, `limit`). Authentication and CSRF
protection apply. Agent chat exposes the same `search_videos` service, bounded to two
search requests per turn. Dates, missing counts and provider provenance stay explicit;
schema failures are not presented as successful empty searches. Instagram V2 source
statistics may lag collection time. Search settings and usage are isolated by workspace.

Tests: `tests/test_video_search.py`, the live-search chat test in `tests/test_chat.py`,
and `node tests/search-client.cjs`.

## Ten content-creator specialists

Metadata reports are also available from **Discover content**: search or reopen a saved
search, select items, then choose **Generate metadata report**. Reports are deterministic
Python calculations and incur no extra provider or model call. They are saved in Outputs,
can be reopened, and export as JSON. Agent chat can also call `generate_metadata_report`
using the saved `search_id` returned by `search_videos`.

The mathematical engine includes available-data distributions (mean, median, interpolated
quartiles), observed `(likes + comments) / views` ratios, log-view/MAD sample outliers,
and observed count changes between snapshots at least one hour apart. Outlier cohorts
require matching platform, provider format, video-age and duration bands and at least
five known view counts. Missing or constant data does not produce a score. A duration
band does not identify Shorts. These are descriptive sample analyses, not viral
predictions, causal claims or channel-baseline comparisons.

Official YouTube custom calculations default to **source evidence only** until the owner
records the applicable existing Google analytics approval/policy amendment in
**Analytics permissions**. This setting records an existing approval; it does not obtain
one. It is bound to the configured Google client, and changing that client disables the
recorded approval. Other users cannot change it. Raw source evidence remains available.
Source snapshots and metadata reports expire after 29 days; worker maintenance removes
expired data. Future reports need refreshed evidence. Tests cover mathematics, missing
values, history, source permissions, workspace isolation and browser rendering.

Spur Ring now registers ten creator specialists, plus the original YouTube Research
workspace and Marketing Lead. The creator specialists have concrete workflows:

| Agent | Working output |
| --- | --- |
| Channel Scout | Search, relevance screening, saved watchlist and sourced scouting report |
| Competitor Analyst | Positioning/format comparisons from collected metadata, with evidence limits |
| Idea Strategist | Concepts with audience value, differentiation, hooks and production plans |
| Script Writer | Spoken dialogue, scene durations, visual direction and CTA |
| Title & Hook Lab | Title/hook options, audience promises, two exact recommended variants and a test plan |
| Thumbnail Director | Composition, subject, short overlay text, contrast and image prompts (design briefs) |
| Shorts Producer | Original/adapted short scripts, shot beats, captions and CTA (no footage editing) |
| SEO & Publishing Editor | Description, keywords, hashtags, proposed chapters and pre-publish checklist |
| Content Calendar Planner | Dated publication entries, production tasks, dependencies and estimated hours |
| Brand Partnership Writer | Sponsor-fit brief, unsent email pitch, deliverables, missing data and disclosure reminders |

Start with **Creator brief** on Agents home to save audience, niche, voice and production
constraints. Each specialist has a relevant example prompt. Creative agents work from
your brief even without video evidence; research agents need source material to support
factual conclusions. Draft generation uses a distinct typed schema per workflow, with
one constraint/schema repair attempt. Actual publishing, email sending, generated images,
video rendering and private performance analytics are not connected.

**Outputs** supports this-agent/all-workspace filtering. Open an artifact to copy text,
download text, export a calendar as CSV, or send the full saved output to another agent
with revision instructions. Handoffs snapshot the supplied report. The coordinator also
passes full specialist deliverables rather than summaries alone. Completed artifacts
and assumptions are stored with the report; no fabricated success metrics are added.

The DeepSeek adapter explicitly selects non-thinking mode to keep its completion budget
available for usable output, rather than inheriting high-effort reasoning defaults.
Read-only report tool calls are bounded to three executed calls per turn; excess calls
receive a budget response so the report can continue with existing evidence.

For explicit live-provider acceptance testing, `python -m spur.creator_qa --round 1`
and `--round 2` run creator scenarios in `data/creator-qa.db`, separate from production.
These commands incur provider usage and may search/collect public YouTube metadata.
Results are saved to `data/creator-qa-round-1.json` and `data/creator-qa-round-2.json`.
Round two includes script-to-Shorts reuse and a coordinated idea → script → title chain.
The driver exercises the same authenticated application API, persistent queue and worker
functions. It does not certify browser click behavior or visual layout.

The completed local acceptance review is in `data/creator-review.txt`. The final second-
round results include all ten specialists and a three-specialist coordinator package.
For focused verification after a fix, `--agent script-writer,shorts-producer` repeats
only those workflows within the selected round. Draft validation also checks plausible
English Shorts pacing, future filming dates, Saturday constraints when specified,
and unsupported first-person filming/sponsorship claims in descriptions. These checks
do not guarantee every factual claim or creative judgment is correct.

## Spur Ring platform and coordinated agents

The root page (`/#agents`) is the platform agent directory. Agent workspaces live
under `/#agent/<agent-id>/overview`, with their missions and tools as subpages.
The existing research workspace is `/#agent/youtube-research/overview`; old hashes
such as `#missions` still resolve to the selected specialist's workspace.

The initial registered agents are **YouTube Research**, **Channel Scout**,
**Competitor Analyst**, and **Marketing Lead**, alongside the creator specialists. You can create additional specialist
profiles with a name, description and instructions. Instructions are snapshotted into
new missions and supplied during planning, screening and synthesis. Profiles use the
same implemented research toolset; naming an agent does not add new integrations.

Open **Marketing Lead**, the first card in Your Agents, and give it a campaign goal.
It uses your creator brief to propose a strategy, success criteria, and up to twelve ordered assignments to
registered specialists, persists child missions, waits for their results, passes
deliverables to the next specialist, then produces a combined campaign package or research report. Handoffs are
idempotent and linked to the parent. Pause/resume/cancel on the parent propagates to
its current children at checkpoint boundaries. Independent agents share the worker;
team assignments currently execute sequentially, not as parallel model processes.

Sources, reports, knowledge, provider credentials and schedules are shared by the agents
inside one account's private workspace. Each account has a separate workspace database.
Agent mission pages filter by agent ownership. Watchlist-clear commands affect the
shared watchlist and stop competing missions. Keep coordinated goals within the
supported discovery/collection/research capabilities.

The backend is a persistent agent harness. Its knowledge, source archive, jobs and
tools belong to your workspace; a connected model supplies reasoning for each run.
Models can be changed without resetting that knowledge.

## Autonomous missions

**Activity** now includes expandable per-step trails with tool requests, results,
the current operation and brief decision summaries. **Missions** combines the same
live events with checkpoints: the generated plan, relevance criteria, search queries,
candidate metadata, screening decisions and report validation. Events are persisted
before long-running calls and displayed on the next four-second refresh. “Load full
step history” / “Load full activity trail” retrieves up to 100 recent events.
These are operational summaries and observable decisions, not private chain-of-thought
or raw provider reasoning. Older jobs show only the events recorded at the time.

Supported prompt actions include **“Delete all the wishlisted channels”**,
**“Delete all the watched channels”**, and **“Clear my watchlist.”** These commands
archive watchlist membership, preserve collected evidence and reports, cancel other
active/paused missions, and return an exact removed count with a Restore button.
Explicit clear commands work without a model call. Restoring channels does not
restart stopped missions. Other unimplemented actions must be classified unsupported
rather than silently converted into research. This is a bounded research/action
controller, not an unrestricted agent with arbitrary tools.

The Overview prompt starts a **mission**, not just a report. For example:
“Find and follow 100 Paris travel channels and analyze what makes a good travel channel.”
The controller plans the request, runs diverse discovery searches, resolves public
YouTube channel IDs, screens recent feed metadata for relevance, adds qualifying
channels to this application's watchlist, collects videos, and generates a sourced
report. It does not subscribe to channels on your YouTube account.

The **Missions** page shows phases, accepted counts, search/assessment counts, gaps,
and an event log. Pause/resume/cancel act at checkpoint boundaries: an already-running
network call may finish and a source already added remains in your watchlist.
One bounded step runs per durable job, and its checkpoint and next job are committed
together. Closing the browser does not stop the worker. Closing the backend or sleeping
the computer stops execution until it is running again. Worker recovery uses job leases.

Discovery currently uses DeepSeek's Search API with the SAME saved DeepSeek API key,
even if you choose another reasoning provider. It is a hosted search service, and
provider usage charges can apply. No extra search account or YouTube API key is needed
for this connector. It only resolves URLs on YouTube, never arbitrary URLs provided
by model output. Public feeds or pages can still be unavailable or blocked.

Each mission is bounded to 100 accepted channels, 20 planned searches, 400 candidate
pages checked and 155 planning/screening model calls, plus up to 5 reporting calls.
Transient job retries can repeat an in-flight external request; limits are work limits,
not guaranteed monetary caps. Discovery stops when the target is met or work/search
limits are exhausted. A shortfall is marked **partial**, not presented as success.
Failures retain progress and can be resumed after fixing the cause.

Channel relevance and quality judgments use titles/descriptions, not watched videos,
transcripts, thumbnails or private analytics. The final report samples up to three
recent videos per accepted channel, which can predate the selected lookback window;
timestamps remain attached and the model must distinguish historical from current
evidence. It cannot establish retention, engagement or causal success factors from
this sample. Missions preserve accepted/rejected reasons and source gaps.

## Connected YouTube and Instagram analytics

Open **Connections & analytics** from the sidebar, or visit `/#connections`.
The installation owner configures provider credentials once in **Platform apps**
(`/#integrations`). Ordinary users choose **Connect** for official OAuth consent, account selection when
several eligible accounts are returned, **Sync analytics**, and disconnect/delete.
Connections and encrypted tokens belong to the signed-in user's workspace.

For YouTube, create a Google OAuth **Web application**, enable **YouTube Data API v3**
and **YouTube Analytics API**, register the exact callback shown in App setup, and
enter its client ID and secret. The connector requests `youtube.readonly` and
`yt-analytics.readonly`. Add test users to your Google consent setup when required.
Google's [web-server OAuth guide](https://developers.google.com/identity/protocols/oauth2/web-server)
and [channel reports](https://developers.google.com/youtube/analytics/channel_reports)
describe account ownership, scopes and supported report combinations.

Instagram uses **Facebook Login** for a **Professional account linked to a Facebook
Page**. Configure a Meta app and the displayed callback. Required read permissions
are `instagram_basic`, `instagram_manage_insights`, `pages_show_list` and
`pages_read_engagement`. App roles, review and an accepted HTTPS callback may be
required by Meta. Open Spur Ring on the same callback origin before authorizing.
The Graph API version is editable; the connector defaults to `v24.0`.
See [Meta's Instagram collection](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api).
These OAuth app credentials are separate from model-provider API keys.

Syncing queues a private background job. YouTube stores 7/14/28-day totals, daily
views, up to 25 ranked videos, and previous-period values. Instagram reads available
account views/reach/engaged accounts and up to 25 recent media objects. Missing
metrics are labelled unavailable; Instagram post likes/comments are current
lifetime counts for sampled posts, not period totals. Daily Instagram series and
previous-period comparisons are not implemented. Google refresh tokens renew access
when available; expired Instagram authorization currently requires reconnecting.

**Analyze with Marketing Lead** saves a metric-labelled brief to Knowledge and
requests a chat analysis from the connected model. Recent 28-day snapshots are also supplied as
read-only context when chatting. No model call runs merely by connecting or syncing.
No publishing, direct messaging, monetary scopes or fabricated analytics are used.
Live provider consent requires your own configured Google/Meta app; automated tests
use isolated workspaces and mocked official API responses.

## Gmail, Outlook, calendars, and Google Docs

Open **Connections & analytics → Email, calendars & documents**. Google and
Microsoft each have **Connect**, **Open workspace**, and
**Disconnect**. The installation owner chooses services and saves developer credentials
once in **Platform apps**. Developer credentials are encrypted in the root database;
account connections and encrypted access/refresh tokens remain in each private workspace.
These OAuth credentials are separate from your model API key.

Google setup: create an OAuth **Web application** in
[Google Cloud](https://console.cloud.google.com/apis/credentials), register the
exact callback URI shown by Spur Ring, enable Gmail API / Google Calendar API /
Google Docs API for the services you select, and add yourself as a test user if
the consent screen is in testing. Enter the client ID and secret in App setup,
then Connect and approve the services. Public use of Gmail scopes can require
Google verification; testing refresh-token lifetimes depend on Google's app settings.

Microsoft setup: register an app in [Microsoft Entra](https://entra.microsoft.com/),
select the intended personal/work account types, create a client secret, and
register the displayed callback as a **Web** redirect (not SPA). The default tenant
is `common`; use your tenant ID for a single-tenant organization app. If Entra
rejects an HTTP `127.0.0.1` redirect, open Spur Ring at `http://localhost:8000`,
sign in there, and save the corresponding localhost callback. Organizational
consent policies can require administrator approval.

Requested permissions:

| Service | Permissions |
| --- | --- |
| Google account identity | `userinfo.email` |
| Gmail | `gmail.readonly`, `gmail.compose` |
| Google Calendar | `calendar.events.owned` |
| Google Docs | `documents` |
| Microsoft identity / refresh | `User.Read`, `offline_access` |
| Outlook mail | `Mail.ReadWrite` |
| Outlook Calendar | `Calendars.ReadWrite` |

The app uses authorization code flow with PKCE, a one-use OAuth state ticket tied
to the initiating Spur Ring session, and automatic refresh when refresh tokens
are available. Changing the app ID, tenant, services, or callback requires
reconnection. Partial grants expose only services actually granted by the provider.

**Email:** read the latest 20 inbox messages, create plain-text drafts, and edit
plain-text drafts in Gmail or Outlook. Use a saved agent output to populate the
draft editor. Save writes to the provider's Drafts folder; there is no email-send
endpoint. Google's compose scope itself includes sending permission, while this
implementation only uses draft create/update. Outlook does not request Mail.Send.
Received email is read-only. Rich-text, multipart, and very long drafts open in
the provider so the editor does not flatten formatting or discard attachments.
Existing Outlook attachments remain when editing a plain-text draft.

**Calendar:** browse the primary calendar in ranges of 1–93 days (up to 50 events),
create personal events, and edit personal non-recurring events. Timed inputs use
the browser's local timezone and send explicit UTC instants; all-day end dates
are exclusive. Meetings with guests and recurring series open in the provider.
Google edits use etags; Outlook edits use provider revisions/etags when returned.

**Google Docs:** create documents, open an existing Google Docs URL/ID, read its
tabs, append text, and replace exact text in a selected tab. Writes require the
current revision ID and preserve the remaining document structure. Recent
document titles and IDs are remembered per connected Google account. This is a
text editor, not a full rich-text/Drive/Sheets editor. No Drive browsing scope is
requested. The agent-output dropdown can supply initial document text.

All writes require the normal workspace authentication and CSRF protection.
Action IDs prevent automatic duplicate submissions; an uncertain provider write
must be checked by refreshing the provider list before starting a new edit.
Email bodies are fetched on demand, never rendered as provider HTML, never
automatically added to Knowledge, and never automatically sent to the model.
Draft/document/event changes are made through these editors; agent chat does not
have direct account-editing tools. Disconnect removes local tokens, preserves
provider content, and does not revoke the grant in the provider's account settings.

Tests use mocked provider responses, including PKCE callbacks, token rotation,
scope checks, private workspaces, provider version conflicts, duplicate saves,
draft preservation, calendar edits, and document tabs. Real provider consent and
account operations require your OAuth developer app credentials and are not
claimed as live-tested. For isolated browser QA with mocked accounts, use
`python -m tests.office_preview` (port 8001; `data/office-ui-qa/workspace.db`).

## Content library

Open **Content library** in the sidebar, or visit `/#library`. Gallery, board,
calendar, and table views show the same persistent records in your private SQLite
workspace. Search and filter by ownership, stage, campaign, or archived status.
The board supports drag-and-drop and accessible stage menus.

Create YouTube videos, Shorts, Instagram Reels, carousels, Stories, image posts,
articles/newsletters, podcasts, or other content. Suggested aspect ratios are
creative starting points, not a platform upload validator. Each record keeps its
brief, script, caption, tags, campaign, dates, assigned agent, live/source links,
linked saved outputs, and change history together.

Stages: **Idea → Drafting → In production → In review → Scheduled → Published**.
Scheduled requires a publication date; Published requires a live HTTPS post link.
These are user-maintained production states. No content is automatically published.
Archive is reversible. Version checks prevent stale edits from overwriting changes.

**Import existing** saves collected videos as references and recent connected-account
posts as your own content. Connected imports use the latest 28-day analytics snapshot.
Repeated imports reopen the original record, including archived records. Imports
save metadata and links; they do not download another creator’s media. You can also
save references directly from **Collected videos**.

Files: MP4, MOV, WebM; JPG, PNG, WebP; MP3, WAV, M4A; PDF, TXT, Markdown, SRT, VTT.
Each record supports 50 files, up to 250 MB per file. Image, audio, and video previews
depend on browser codec support. Files are served only to authenticated users of
the owning workspace. Assets live beside the workspace database in `content_assets/`;
back up that directory **and** its SQLite database. Media is stored on disk rather
than inside SQLite. CSV and JSON exports contain metadata, not attached file bytes.

Saved content text is included in agent chat, specialist generation, and Marketing
Lead planning context (up to 20 recent records, prioritizing explicit content IDs).
Discussing a specific record includes its saved script, caption, file metadata,
and excerpts from up to three linked outputs. **Discuss with agent** prepares an
editable message; you choose when to send it. Agents do not view/transcribe attached
media or edit library records. The library itself does not require a model connection.

Backend tests: `python -m pytest tests/test_library.py -q`. For isolated browser QA,
run `python -m tests.library_preview` on port 8001; its fixture account and sample
content use only `data/library-ui-qa/workspace.db`, separate from real workspaces.

## Hosted models and lasting knowledge

Open **Settings & model**, choose **OpenAI** or **DeepSeek**, enter a model ID available
to your API account, and enter your provider API key. Save the connection; **Test saved
connection** checks the provider model-list endpoint without running paid inference.
It does not guarantee that the selected model supports every tool/schema feature.
OpenAI uses `/v1/responses` and DeepSeek uses `/chat/completions`. Keys are never sent
to frontend responses, job payloads or reports. On Windows, saved keys are encrypted
with DPAPI for the server's Windows user and written under `data/credentials/`.
The server and worker must run as that same Windows user. In environments without an
available Windows user profile, use environment variables instead:

```powershell
$env:OPENAI_API_KEY = 'YOUR_OPENAI_API_KEY'
# or
$env:DEEPSEEK_API_KEY = 'YOUR_DEEPSEEK_API_KEY'
```

Restart the local launcher after setting environment variables; existing variables
take precedence over saved encrypted keys. Model IDs and provider selection are kept
in SQLite. Do not put credentials in Knowledge notes. A ChatGPT subscription is
separate from OpenAI API billing; this integration does not sign in to chatgpt.com.
Hosted providers receive the request and retrieved workspace context when a job runs.

Use the **Knowledge** page to save business context, priorities, and reference notes.
Completed report summaries with source provenance are automatically added in the same
database transaction as report completion. Earlier reports are indexed on startup.
The harness seeds each run with up to ten recent memories and exposes
`search_knowledge(query)` for further literal-text retrieval. Reports record the memory
context they used. Saved context can be used even before collecting videos, but
developments and potential trends still require video evidence. Historical analysis
is explicitly treated as possibly stale context, not freshly verified facts.

Memory is durable storage plus bounded retrieval, not an infinite model context window
or model fine-tuning. Keep backups of the database. Retrieval currently uses literal
substring matching rather than embeddings or semantic search. Prompt jobs and research
are persisted, including separate multi-turn chat histories for each agent.

## Local dashboard

Start the web interface and background worker together:

```powershell
.\.venv312\Scripts\python.exe -m spur.local
```

Open http://127.0.0.1:8000 and choose **Create an account**, or open `/signup` directly.
The first account preserves the existing workspace; later signups get private, empty
workspaces with the starter agent team. Subsequent visits use your username and password.
No API key needs to be pasted into the dashboard.
The local launcher binds only to loopback.
The interface includes your YouTube watchlist, video library, live job activity,
reports with citations and JSON downloads, recurring schedules, and local model
selection. No JavaScript build tools or external UI services are needed.

Use **Chat & overview** to discuss ideas or enter instructions (up to 6,000 characters).
**Send** or Ctrl/Cmd+Enter continues the agent's saved conversation. **Run as task**
submits the composer text directly as a background mission with the selected lookback.
Your draft is preserved within the browser tab. Task links lead to progress and outputs.

Add a channel using its canonical UC ID or `/channel/UC…` URL, then click **Collect
now**. To generate reports, install/start Ollama and select an installed model in
**Settings & model**, or connect OpenAI/DeepSeek. The model must support tool calls and structured output.
Collection works without a model. The dashboard uses your actual database and
does not insert sample channels or fabricated reports.

Stop the launcher with Ctrl+C to stop both services. When using the separate
API/worker commands below, the browser still uses account login. Programmatic
clients can use the server's `X-API-Key`; that service credential is never placed
in the browser cookie. `SPUR_LOCAL_UI` no longer bypasses account login.

## Accounts and cookies

Accounts, password hashes, login-attempt counters and sessions live in the central
SQLite database (`data/spur.db`, or `SPUR_DB`). There are no default credentials.
First-owner setup is restricted to localhost. Public signup is available at `/signup`,
linked from login. The installation owner can also add accounts through **Account & access**.
All users can change their own password.

Passwords use per-user random salts and PBKDF2-HMAC-SHA256 with 600,000 iterations;
the work factor follows the [OWASP password-storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).
The browser receives an opaque HttpOnly, SameSite=Strict cookie. Only a SHA-256 hash
of its random token is stored in SQLite. Cookies use Secure on HTTPS; localhost HTTP
uses a non-Secure cookie. Cookie-authenticated writes require a CSRF token and reject
foreign origins. Login attempts are throttled using SQLite counters.

Normal sessions last eight hours on the server and use browser-session cookies.
**Keep me signed in** persists the cookie for 30 days. Sessions survive server
restarts, expire on the server, and are revoked by logout. Changing a password signs
out other sessions and replaces the current session. Passwords and session cookies
are never sent to the model. No email verification or email password recovery is connected.

New accounts use `data/workspaces/<user-id>/workspace.db`, with a separate credentials
directory alongside that file. Chats, custom agents, sources, outputs, notes, creator
briefs, model settings and jobs are private to the authenticated account. Starter agents
are seeded in each workspace. New accounts do not inherit the original account's saved
API keys or environment-provided hosted credentials. The original owner keeps the legacy
workspace and provider connection. Browser drafts are cleared when switching accounts.
The local worker discovers all account workspaces and executes a bounded step per
workspace in rotation, using that workspace's settings and credential path.

## First-use walkthrough

Signup opens a five-step welcome tour: your private workspace, a creator brief,
model connection, the agent team, and your first task. The tour can open Settings,
saves the brief you enter, and places an editable example in Marketing Lead's chat
when finished. It never sends the example or starts model work automatically.
You can skip it, and reopen it from **Account & access → Getting started walkthrough**.
Completion is stored per account and survives sign-out and server restarts.

AI agent backend for monitoring a YouTube channel watchlist and generating
industry reports. No n8n, scraping subscription, paid model API, or agent-framework
subscription is required. Local inference still consumes hardware and electricity;
hosting elsewhere costs extra. Check the license of the model you choose separately.

## What works

- FastAPI REST API with account-cookie authentication, service API keys and interactive OpenAPI docs.
- YouTube channel feed collection: titles, descriptions, timestamps, video links.
- SQLite source history and deduplication, durable jobs, three attempts with a 30-second
  retry delay, and recovery after expired worker leases.
- A bounded tool-calling agent using OpenAI, DeepSeek or Ollama. The model searches
  source evidence and durable knowledge, then returns a validated JSON report.
- Citation-ID validation, source links, collection coverage, and a tool-call trace.
- Persisted interval schedules for collection and report generation.

This is a single-host backend with private account workspaces, not a hardened multi-server
service. There is no transcript extraction, automatic subscription import,
email delivery, or arbitrary-web scraper yet. Channel feeds expose recent uploads,
not a guaranteed complete archive. Reports analyze metadata, not video contents.

## Optional local-model setup on Windows / PowerShell

Requires Python 3.10+ and a separately installed Ollama runtime with a local model
that supports **tool calling and structured JSON output**. Select a model appropriate
to your machine; set its installed name below. No model is downloaded by this project.

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -e '.[test]'

# Generate once, then use the SAME key in both terminals and API requests.
$env:SPUR_API_KEY = .\.venv\Scripts\python.exe -c 'import secrets; print(secrets.token_urlsafe(32))'
$env:OLLAMA_MODEL = 'YOUR_INSTALLED_TOOL_CAPABLE_MODEL'
$env:OLLAMA_URL = 'http://127.0.0.1:11434'
$env:SPUR_DB = "$PWD\data\spur.db"
.\.venv\Scripts\python.exe -m uvicorn spur.api:app --host 127.0.0.1 --port 8000
```

This workspace also contains a prepared `.venv312` environment with the dependencies
installed. Use `.\.venv312\Scripts\python.exe` instead of the `.venv` executable to use
it. The test suite passed on Python 3.12.14. `constraints-tested.txt` records the tested
dependency versions; for a fresh Python 3.12 environment use
`python -m pip install -c constraints-tested.txt -e '.[test]'`.

In a second terminal in the same folder, set `SPUR_DB` and `OLLAMA_MODEL` to the same
values (and `OLLAMA_URL` if changed), then run the separate worker:

```powershell
$env:SPUR_DB = "$PWD\data\spur.db"
$env:OLLAMA_MODEL = 'YOUR_INSTALLED_TOOL_CAPABLE_MODEL'
.\.venv\Scripts\python.exe -m spur.worker
```

Environment variables are read at process start. No `.env` loader is included.
Ollama must be running when using the Ollama provider; hosted providers do not need it.
The worker polls every two seconds. Run one worker initially. API and worker must use
the same local database file; do not put SQLite on a network filesystem.

## First report

Open http://127.0.0.1:8000/docs and use **Authorize** with `X-API-Key`, or use PowerShell:

```powershell
$headers = @{ 'X-API-Key' = 'PASTE_THE_GENERATED_KEY' }
$base = 'http://127.0.0.1:8000'

# Use the canonical channel ID, UC followed by 22 characters, not an @handle.
$source = @{ channel_id = 'REPLACE_WITH_REAL_UC_CHANNEL_ID'; name = 'Channel name' } | ConvertTo-Json
Invoke-RestMethod "$base/sources" -Method Post -Headers $headers -ContentType 'application/json' -Body $source

$collection = Invoke-RestMethod "$base/jobs/collect" -Method Post -Headers $headers
Invoke-RestMethod "$base/jobs/$($collection.job_id)" -Headers $headers
# Wait for succeeded; inspect result.failed_sources and GET /sources for partial failures.

$request = @{ topic = 'AI agent infrastructure'; days = 7 } | ConvertTo-Json
$reportJob = Invoke-RestMethod "$base/jobs/report" -Method Post -Headers $headers -ContentType 'application/json' -Body $request
Invoke-RestMethod "$base/jobs/$($reportJob.job_id)" -Headers $headers
# Once succeeded, result.report_id identifies the stored report:
Invoke-RestMethod "$base/reports" -Headers $headers
```

Jobs return `202` immediately. Poll `GET /jobs/{id}` for `queued`, `running`,
`succeeded`, or `failed`. Read `GET /reports/{report_id}` for report contents. A failed
model request never turns into a fabricated fallback report. Full collection failure
retries the job; partial failure is explicitly included in the successful job result
and in source coverage. Retry jobs by submitting a new request after fixing the cause.

To collect hourly, create a schedule (first run is immediate when the worker next polls):

```powershell
$schedule = @{ kind = 'collect'; interval_seconds = 3600 } | ConvertTo-Json
Invoke-RestMethod "$base/schedules" -Method Post -Headers $headers -ContentType 'application/json' -Body $schedule
```

A report schedule additionally requires `report: { topic: "...", days: 7 }`.
Schedules are independent: reports do not automatically wait for collection. Complete
an initial collection before scheduling reports. After downtime, each overdue schedule
enqueues one run rather than replaying every missed interval. Delete schedules via
`DELETE /schedules/{id}`. Stop the worker to stop execution.

## Agent design and limitations

The agent has two read-only tools, `search_items(query, period)` and
`search_knowledge(query)`, and up to four tool
rounds with at most three calls per round. Every search returns up to 30 recent matches;
descriptions supplied to the model are truncated to 2,000 characters. This bounded
sample can miss relevant material in large watchlists. Full descriptions up to 12,000
characters remain stored. Topic relevance is judged by the model, not guaranteed by
the collector. Previous-window records must already have been collected to support
historical comparisons.

Source text is treated as untrusted data. The model has no shell, filesystem, or
arbitrary network tools. The collector only requests a fixed YouTube feed destination.
Final findings must cite retrieved IDs, and potential trends require evidence from
at least two channels. These checks verify evidence references, **not factual entailment**;
review report quality before making decisions or distributing it automatically.

The worker gives each attempt a 600-second timeout and a 900-second lease. Large
watchlists may need per-channel jobs. Model calls have a 90-second timeout each; slow
hardware or oversized models can require tuning. Small local models may fail the
schema or tool protocol, in which case the job fails explicitly.

Before an internet deployment: add TLS and a reverse proxy with request/rate limits,
user-scoped authorization if needed, managed secrets, process supervision, database
backups, dependency pinning and monitoring. Do not expose Ollama publicly. Check
YouTube collection access for your actual channels; no authenticated account access
or private videos are supported. For multiple servers, migrate the store/queue to
PostgreSQL and a suitable distributed worker system while retaining the agent and
connector interfaces.

## Tests

Each agent’s **Chat & overview** page has its own saved conversation. **Send**
supports discussion and follow-up questions using that specialist’s instructions,
your creator brief, saved workspace knowledge, and the latest 40 messages from
that agent’s conversation. Earlier messages stay in SQLite and can be loaded in
the chat window. Chats persist across restarts and model changes.

An explicit request for research or a saved deliverable can start a background
mission from chat. Its status and completed output are linked in the reply.
**Run as task** submits the text in the composer directly as a mission using
the selected lookback. Failed chat replies can be retried. Chat jobs use the
same saved model connection and background worker as missions.

```powershell
.\.venv312\Scripts\python.exe -m pytest -q
```

Tests use temporary databases, fixture feeds and mocked model-provider services. They cover
queue recovery, stale workers, atomic report persistence, schedules, deduplication,
XML parsing, API authorization, tool execution, evidence validation, durable knowledge,
provider switching and Windows credential encryption. They do not
prove real-model quality or live YouTube availability.

## Dependencies and ownership

Connection logos are vendor artwork served locally with original colors and
proportions: [YouTube](https://brand.youtube/) (brand-site icon),
[Instagram](https://www.meta.com/brand/resources/instagram/instagram-brand/)
(official gradient glyph from the 2023 brand asset pack),
[Google](https://www.gstatic.com/images/branding/product/2x/googleg_48dp.png), and
[Outlook](https://res.cdn.office.net/files/fabric-cdn-prod_20221201.001/assets/brand-icons/product/svg/outlook_48x1.svg).
The [Microsoft symbol](https://learn.microsoft.com/en-us/entra/identity-platform/howto-add-branding-in-apps)
is also bundled. These brands and logos remain their respective owners' trademarks.

Application code is in `spur/`; `agent.py` owns analysis, `youtube.py` owns collection,
`store.py` owns persistence/jobs, `worker.py` owns execution, and `api.py` owns HTTP.
FastAPI, HTTPX, Uvicorn and defusedxml use open-source licenses. This repository does
not currently add a redistribution license to your application code.

## Mock creator profiles

Open **Mock profiles** in the sidebar. The YouTube and Instagram starter demos each
contain 48 explicitly fictional metadata records. Each profile has a separate
SQLite workspace for chats, knowledge, missions, library drafts and reports. The
existing model connection is inherited; connecting accounts and external writes
are disabled inside mock workspaces. Return to the personal workspace with the
banner button. Tabs detect a workspace switch before writing stale content.

For a real reference, enter a YouTube channel ID or @handle. No Google login or personal YouTube connection is required. The background worker
uses yt-dlp in metadata-only mode to walk Videos, Shorts and live catalogs in
50-item batches with saved checkpoints. Public counts can be rounded; missing
dates and statistics remain unavailable. Site changes or bot checks can interrupt
imports, which remain partial until every catalog tab finishes. It excludes private, deleted and inaccessible items;
only completion of provider pagination marks the import complete. Imports pause
after a 200-page batch and can be resumed. Instagram public profile import uses
the configured TikHub provider and shares the personal workspace's paid request
budget. That adapter still requires live validation with a configured key; a
failed or uncertain paid call is never automatically repeated.

Catalog records feed the existing agent harness and library. Generate a report
directly from the full available catalog; the report shows its coverage and
limitations. Real YouTube custom calculations retain the analytics approval gate.
Synthetic scenarios can explicitly advance one day to exercise observed growth
and outlier reports without claiming real performance. No videos are downloaded,
watched or transcribed, and reference profiles do not provide private analytics.
Public source metadata expires after 29 days and needs refreshing; local scripts
and attached assets remain. See `tests/test_mock_profiles.py` for isolation,
pagination, report, budget retry and refresh checks.

## Prepared HTTPS deployment entry point

`python -m spur.hosted` runs the Windows backend and worker behind a local HTTPS
reverse proxy. Set `SPUR_PUBLIC_HOST` to the chosen hostname (without `https://`),
`SPUR_TLS_EMAIL` to the certificate contact email, and run Caddy separately with
`caddy run --config deploy/Caddyfile --adapter caddyfile`. The Python process binds
only to `127.0.0.1:8000`; forwarding headers are trusted only from loopback. The
public hostname is validated, unexpected Host headers are rejected, and proxied
HTTPS account sessions use Secure cookies.

This configuration is prepared, not deployed. A persistent server, DNS access,
external ports 80/443, and a Caddy installation are still needed. Keep using
`python -m spur.local` until the deployment host is selected. The existing
`hispurring.com` storefront is separate; no storefront or DNS changes have been
made. OAuth callbacks must be registered and saved for the actual app hostname
after HTTPS is working, rather than pointing providers at an unserved URL.

The current provider secrets use Windows DPAPI. Run under the original Windows
account to retain access; copying its database to Linux or another Windows account
does not make those secrets decryptable. A different host requires a planned
credential migration. Tests in `tests/test_hosted.py` verify hostname validation,
Secure cookies through a trusted proxy, and rejection of spoofed forwarding.


## Agent-driven video analytics

The imported-profile harness now includes `get_profile_analytics` and
`compare_profile_videos`. Backend code computes coverage, descriptive statistics,
format summaries, publication cadence, observed growth and relative viewership.
The model queries those tools and interprets their evidence; it does not estimate
channel performance from the first 20 catalog records. Chat, creator specialists,
research and Marketing Lead planning receive a compact computed performance brief.

Relative viewership compares views with the median of at least five same-channel
videos in the same format, age band and duration band. It is a descriptive ratio,
not a viral probability or proof of creative causation. Unknown dates or too few
peers yield no score. The Video analytics page supports filtering, paging and
sending selected IDs to the coordinator for comparison. Anonymous public metadata
can be computed independently; official API-sourced records retain their existing
approval gate. Growth requires repeated comparable observations and does not
compare rounded catalog counts with the first detailed video fetch.


Automatic profile briefings are enabled for public reference profiles with a model
connection and at least five measured, dated videos. The app worker starts an
insight mission at the highest reached collection milestone (initial usable data,
halfway detailed collection, or completed pass), with at most three distinct
briefings per import generation and no overlapping automatic missions. Reports
appear in the Your agent noticed feed without a chat prompt and remain saved in
Outputs and Knowledge. Pause automatic insights to pause active automatic missions
and future scheduling; user-created tasks are unaffected. Model requests use the
existing provider. There is no external email/push notification or infinite
model polling. Citation checks allow one bounded repair before the existing job
retry policy applies. Tests exercise automatic scheduling, deduplication, pause,
missing-model/data handling, and a report reaching the feed without any chat.


Mock profiles inherit the personal model until a model is selected in that profile's
Settings & model dialog. The selection is stored as a profile-only override and
uses the owning account's saved provider credential. Chats, tasks and automatic
briefings honor that override; other profiles and the personal model are unchanged.
API keys remain managed in the personal workspace. The mock settings endpoint
rejects credential writes and rejects providers without a saved key.


Chat and research harnesses share `browse_collected_videos` and
`read_collected_video`. These tools query the active profile's saved catalog,
provide explicit pagination totals, and retrieve stored descriptions, metrics,
publication dates and observation timestamps. They have no default date cutoff
and make no external requests. Previews do not restrict database access. Tool
results remain untrusted source data; report citations are checked against the
records actually returned. Tests include older-record lookup, pagination,
workspace isolation, and a chat-to-tool retrieval sequence.

## TikTok publishing

Open **Publish content → TikTok** to save an owned MP4 as a draft, review the
authorized account and video, then upload now or schedule within 30 days. Uploads
use TikTok's official Content Posting API and transfer files directly from this
computer; a publicly hosted video URL is not required. Uploaded videos are limited
to 250 MB here. The server reads the MP4 duration and binds the reviewed media,
account, draft version, visibility and content disclosures to the queued job.

**Direct Post** requires `video.publish`. **Upload to TikTok** requires
`video.upload` and sends an inbox notification; the creator finishes editing and
publishing in TikTok. Inbox delivery is never labeled as publication. Public Direct
Post requires TikTok's audit; unaudited clients are restricted to private accounts
and `SELF_ONLY`. Account visibility is never changed by Spur Ring. An installation
owner can record an existing audit approval reference in Provider app setup.

For local login, register the exact loopback callback under **Desktop Login Kit**
in the TikTok portal and select Desktop in Provider app setup. This uses TikTok's
hex SHA-256 PKCE challenge and sends the verifier in the token exchange. Web Login
Kit still requires public HTTPS. Enable Login Kit and Content Posting API, use the
matching sandbox credentials and add your testing account as a sandbox target
user. Production registration needs the website, legal pages, integration demo and
TikTok review; the application does not invent these approvals.

Chunk progress and publish IDs are durable. Signed upload URLs are encrypted and
redacted from HTTP logs. Unknown write outcomes are not automatically replayed;
**Check TikTok status** uses the existing publish ID. Reference/mock workspaces
cannot connect or publish as another creator. Scheduled work requires the backend
and worker to remain online.

Sources: [Desktop Login Kit](https://developers.tiktok.com/docs/en/login-kit-desktop),
[Direct Post](https://developers.tiktok.com/docs/en/content-posting-api-reference-direct-post),
[Upload](https://developers.tiktok.com/docs/en/content-posting-api-reference-upload-video),
[sharing guidelines](https://developers.tiktok.com/docs/en/content-sharing-guidelines).

## Local Instagram workflow testing

Open **Publish content** and choose **Local demo** (the default). It works in the
personal workspace and creator reference workspaces without Meta login, HTTPS,
a hosted server or paid data. **Add 2 photo + 2 Reel examples** creates local JPEG
cards and short WebM clips in that workspace's content library. Review a draft,
choose **Publish locally**, or schedule it and use **Change time** / **Cancel
publication**. Drafts can be edited without re-uploading their existing media.

Local demo delivery uses a separate worker job and publishing mode, never reads
social credentials and never calls Instagram. Its results are labelled
**Published locally**. Demo publications do not change imported creator metadata,
performance metrics or ownership. **Live Instagram** still requires an authorized
Professional account and the accepted HTTPS OAuth callback. Live Reels require
MP4; the generated WebM clips are only for local workflow testing.
