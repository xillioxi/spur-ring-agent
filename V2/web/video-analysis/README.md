# Video → Inverse prompting

## Optional rea-video workflow

**Analysis workflow** offers the existing model breakdown and **Rea Video · local
technical analysis**. The standard workflow remains the default. The Rea option
runs the actual [rea-video](https://github.com/JuneYaooo/rea-video) Python pipeline,
pinned for this integration to `e83d5874beb6429d9488129c7f046755b60a5371`.
It measures shot candidates, motion and production-source evidence locally.
It is not a replacement vision model and this integration does not enable its
optional VLM, speech recognition, OCR or audio stem models.

Configure these host-owned values in the ignored `.runtime/.env.video-analysis`
and restart the backend:

```dotenv
SPUR_REA_VIDEO_PYTHON=/absolute/path/to/isolated/python
SPUR_REA_VIDEO_SOURCE=/absolute/path/to/pinned/rea-video
```

The source directory must contain `rea_video/pipeline.py`. Use an isolated Python
3.10+ environment with `numpy`, `opencv-python-headless`, `Pillow`, `PyYAML` and
`videomd`. The checked local installation uses Python 3.12, a sparse source
checkout and an editable `--no-deps` package install after installing those
minimal dependencies. The unused audio-separation runtime is not required by
this mode. Absolute FFmpeg/FFprobe paths must also be configured. No installation
or model download occurs during app startup or analysis.

The wrapper disables network access, limits child processes to the fixed local
media tools, and disables shared preferences/corrections. Provider credentials
are excluded from the child environment. Temporary reports are removed after a
bounded, sanitized result is saved. Cancellation stops the media process tree.

Requests use `analysisWorkflowId: "rea-video"`, with `mode: "both"` or
`"breakdown"`; model selection is disabled because this workflow makes no cloud
model requests. Individual and channel jobs snapshot the workflow/revision.
Historical results without a workflow remain standard analyses, and changing
the selector does not relabel an existing result.

Rea results are explicitly **partial / unreviewed**. The technical panel and
TXT/Markdown/JSON exports retain the estimated classifications, scores,
evidence, limitations and pinned revision. The same nine production columns
remain, with unknown scene/action/dialogue details unfilled. Automatic remake
planning requires a model breakdown first; explicitly authored timelines remain
available through the existing API.

On the saved 22.822-second chess reference, the local run detected one interval
(0–22.7s), estimated live-action production with a 0.453 heuristic score, and
did not independently identify the king-capture / pawn-to-king payoff. This is
technical evidence, not a successful semantic-understanding benchmark. The
comparison artifacts keep the untouched local report separate from an explicitly
user-assisted visual review. No external model request was made for this test.

## Script production breakdown

**Script breakdown** uses the selected audiovisual model to inspect the complete
video and soundtrack, then produces the same nine-column production sheet for
every reference:

| 分镜编号 | 取景地 | 画面 | 台词 | 镜头运用 | 秒数 | 花字 | 背景特效与滤镜 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

The action runs combined video and audio (`mode: both`), not transcript-only
extraction. Fields come from the current video evidence, durations from observed
intervals, and dialogue and overlays retain their original wording. Timestamp
links appear inside the shot-number cell. Music remains available in the audio
view rather than becoming a tenth production column. Unknown details stay empty.
When only speech/text timing is available,
rows are labeled as speech segments or text intervals rather than camera shots.
Transcript-only runs do not invent visual observations; use **Script breakdown**
for the complete production table.

Narrative matching defaults to **None**. The 11 XC, XMZ, YMZ, ZK and PL narrative
patterns remain optional under Advanced options. They do not define the
production columns, and loading the page never launches model analysis. Optional
selection is captured when individual or batch analysis starts; it does not
relabel a saved result. With `scriptTemplateId: none`, no narrative prompt or
classification is requested or retained.

Structure interpretation is separate from verbatim speech and visible text.
Every retained stage cites an exact timed observation from that result. Auto can
return no supported match; stages can be missing, repeated or reordered. A
reusable pattern uses placeholders, without copying the examples' brand, price,
pack weight, ingredient figures, claimed usage period or urgency claims.
The 4斤/7斤 and 6+1+1 filename terms describe product quantities, not stage counts.

The catalog retains both XC proof variants and references all 11 originals by
filename, worksheet, cell range and SHA-256. It records the stale whole-script
line in XC variant 2 and the conflicting quantity text in YMZ variant 2 as source
notes. Embedded workbook images are reference illustrations, not footage from a
subsequently analyzed video. Raw workbooks and their images are not uploaded by
this feature or bundled into the browser.

Copy and TXT/Markdown/JSON exports include the nine-column production table and,
only when requested, structure interpretation. Existing saved analyses remain
readable; explicitly run **Script breakdown** to refresh them with the corrected
schema. Batch freshness includes production schema/revision and optional template
selection.
No analysis request is started by loading the catalog. The ordinary local engine
still supplies evidence, but does not claim a cloud narrative classification.

Implementation: `script-template-catalog.mjs` holds the curated patterns and
provenance; `script-templates.mjs` validates quoted stage evidence and builds the
production table after component merging. Provider, service, HTTP, Harness,
frontend and isolated browser fixtures cover selection, refreshes, persistence,
exports and rendering. These fixture checks do not establish live-model accuracy.

## Choose the analysis model

The **Analysis model** dropdown controls both the selected video's analysis and
**Analyze all videos**. The server publishes a fixed allowlist through
`analysisModels` and `defaultAnalysisModelId` in the status response. Requests may
select an `analysisModelId`; credentials, model names and endpoints remain owned
by the server. Every queued video and channel batch retains its selected
configuration. Saved results identify the provider and model that actually ran.

Poe's Gemini 3.7 Flash adapter is configured in the ignored backend file
`.runtime/.env.video-analysis`:

```dotenv
POE_API_KEY=your-server-key
POE_BASE_URL=https://api.poe.com/v1
SPUR_VIDEO_ANALYSIS_PROVIDER=poe
SPUR_VIDEO_ANALYSIS_POE_MODEL=Gemini-3.7-Flash
SPUR_POE_FLASH_API_AVAILABLE=1
```

The adapter uses Poe's documented generic `file` input for the complete original
MP4, including embedded audio; audio-only mode attaches the extracted full MP3.
It does not send the unsupported `input_audio` format, extract visual frames,
silently change model, or retry a paid request. It validates output using the
same audiovisual JSON schema as SiliconFlow. Poe controls internal sampling;
Spur does not claim a decoded frame rate that Poe has not reported. Model
availability is separate from having a valid API key.

**Verified API access on 2026-11-16:** the configured account's API catalog lists
`gemini-3.7-flash`, and a text availability request using `Gemini-3.7-Flash`
returned HTTP 200 and the requested sentinel. Text access alone does not prove
video understanding; the adapter uses the same bounded original-video transport
and validates the complete production result before saving it. A subsequently
approved live test of the saved 22.822-second chess reference completed using
`Gemini-3.7-Flash` on Poe, with original video/audio transport, four timed
production sections, the exact nine-column sheet, and no narrative matching.

Gemini 3.7 Flash replaces the unavailable Argon menu option. The earlier
`SPUR_POE_ARGON_API_AVAILABLE=0` setting records the historical Argon refusal and
does not disable Flash. `SPUR_POE_FLASH_API_AVAILABLE=0` can disable Flash after a
confirmed access failure. Restart the backend after changing configuration.
SiliconFlow options remain selectable; existing saved Argon or Qwen results
retain their actual model provenance and are refreshed only by an explicit
analysis request. No alternate model is submitted automatically.

References: [Poe file inputs](https://creator.poe.com/docs/external-applications/openai-compatible-api#file-inputs),
[official Gemini 3.7 Flash bot](https://poe.com/Gemini-3.7-Flash).

## SiliconFlow video and audio analysis

The local web host supports `SPUR_VIDEO_ANALYSIS_PROVIDER=siliconflow` with
`Qwen/Qwen3-Omni-30B-A3B-Instruct` by default; the Thinking variant can be
configured explicitly. A video analysis sends the **complete original video**
to one multimodal model in one request. MP4 source bytes are sent directly;
other supported video containers retain their native MIME type. Spur does not
extract visual frames, transcode the video or split it into intervals for this
route. The chat, image-generation and video-generation model settings are
independent of the analysis model.

The backend loads an optional `.runtime/.env.video-analysis` after its normal
configuration. This ignored backend file configures the private video workspace,
including analysis and optional recreation; credentials never enter the browser
bundle, HTTP status responses, saved results or exports:

```dotenv
SILICONFLOW_API_KEY=your-server-key
SILICONFLOW_BASE_URL=https://api.siliconflow.cn/v1
SPUR_VIDEO_ANALYSIS_PROVIDER=siliconflow
SPUR_VIDEO_ANALYSIS_CLOUD_MODEL=Qwen/Qwen3-Omni-30B-A3B-Instruct
SPUR_VIDEO_RECONSTRUCTION_MODEL=MiniMaxAI/MiniMax-H3
```

Restart the backend after editing that file. Explicit process environment values
take precedence. Local FFprobe checks duration, while FFmpeg extracts the full
synchronized 16 kHz mono WAV track and measures physical sound levels. The WAV
is supplied separately through `audio_url` alongside the original `video_url`
payload. Audio-only analysis omits video. Files without an audio track do not
receive invented speech or sound evidence. Temporary audio is deleted after
processing. This route adds no dependencies and does not start Ollama or download
models. Missing credentials and failed cloud requests remain explicit; Spur
does not substitute a local description.

Spur accepts at most five minutes for this analysis route and bounds the source
video at 48 MiB, the prepared audio at 12 MiB and the serialized request at
84 MiB. Media exceeding these limits is rejected before a paid request. The
provider performs its own video sampling with `fps: 2`, `max_frames: 128` and
`detail: "auto"`; sending the complete file does not guarantee that the model
observes every frame or catches every action. Model timestamps, spoken words and
sound identities remain estimates that need review. No paid request is retried
automatically.

Missing visual results show the safe failure reason and a **Retry shot analysis**
action. A shot retry retains saved speech; a successful retry removes obsolete
visual failure notes. Existing frame-based analyses remain readable and keep
their original provenance until explicitly refreshed.

The existing **Analyze video**, **Analyze all videos** and Harness tools use the
selected backend provider. Bulk analysis replaces earlier local analyses with a
full video/audio pass, and skips complete results only when they match the
current cloud model. Existing imports are reused. Starting the server does not
start a channel analysis or upload the archive. Vite blocks `.runtime` files and
environment files from HTTP access. The UI shows the active provider,
discloses media transfer, and identifies the provider behind each saved result.
TXT/MD/JSON exports retain semantic audio, script and provenance. Saved provenance
identifies `mediaTransport: "original_video"`, the input mode, one request's
coverage, provider sampling parameters and aggregate token usage. The UI labels
new results **Complete video + audio**, while historical frame results retain
their original input labels.

Provider contract: [SiliconFlow multimodal guide](https://docs.siliconflow.cn/docs/userguide/capabilities/multimodal-vision).

The direct-video route uses the configured cloud model for visuals and sound
together. It does not invoke the earlier separate frame-verification model or
use transcript-only context to invent missing visual actions.

### Recreate a saved analysis

The separate recreation module closes the workflow from a saved reference analysis
to an editable production plan, generated clips, an assembled private video and a
new analysis of that output. Reading a plan does not submit generation. The plan
shows each clip's editable text prompt, target timing, model and **billable
generation seconds**. Review the prompts against the source before generating:
analysis descriptions and timings remain estimates, and an incorrect observation
can become an incorrect generation instruction.

The selected provider is SiliconFlow's `MiniMaxAI/MiniMax-H3`. Its
[current video-generation contract](https://docs.siliconflow.cn/docs/api/video-submit-post)
accepts integer durations of **5–15 seconds**, `480p` or `768p` resolution, and
aspect ratios including `9:16`. Spur defaults recreation requests to **480p**;
the provider's own default is **768p**. Resolution can be selected for a run.
The older `Wan-AI/Wan2.2-T2V-A14B` and `Wan-AI/Wan2.2-I2V-A14B` were retired on
2026-11-10; they are not silently substituted into reconstruction requests. See
the [official retirement notice](https://docs.siliconflow.cn/docs/release-notes/overview).

This first implementation uses **text-to-video**, one paid request per planned
clip. It does not send image keyframes or use the source video as a generation
reference. A short target section still requires at least five generated seconds.
The plan therefore distinguishes the final target length from the larger number
of billable generated seconds; it does not quote an unverified currency price.
FFmpeg trims generated clips to the planned section lengths, normalizes the
output format and joins them with hard cuts. Timing is rounded to 30 fps frames;
the assembly does not promise the original transitions or exact visual content.

Final audio is either the reference video's existing soundtrack (`reference`) or
no audio (`silent`). This choice does not train a voice, reconstruct original
music or guarantee generated dialogue. The completed MP4 is saved as a new private
library item in **Unassigned**, linked to its reference and recreation job. It is
not published to a channel.

#### Use an authored storyboard

The recreation editor can prepare a custom plan from a pasted storyboard JSON
containing `clips[].timeline` and `clips[].api_payload.prompt`. Only the authored
times and prompt text become generation inputs; provider URLs, model names,
placeholder keyframes and unsupported settings are not forwarded. Preparing or
editing a plan does not submit generation. The editor selects 768p for custom
plans; API callers can choose either supported resolution explicitly.

`POST /items/:id/reconstruction-plan` accepts
`{timeline: [{startSeconds, endSeconds, prompt}]}`. Send the same `timeline` with
the reviewed `planRevision` when creating a recreation. The source analysis is
preserved. Authored timing and prompts participate in revision and idempotency
checks, and a saved job records `source: "authored_timeline"`.

The target duration is the final authored end time. Gaps are rendered locally as
black frames without paid generation; the original soundtrack keeps its absolute
timing across those gaps. Each shot requests at least five generated seconds and
is trimmed to its target. For the supplied liminal teleport sequence, the five
shots require 5/8/5/8/5 generated seconds (31 total), assembled to a 26-second
timeline including 0.7 seconds of black gaps. This text-to-video pass does not
apply the placeholder first/last frames, 2K or watermark options, create the
named music or SFX, or implement the proposed radial disappearance transition.

Generation uses a stable UUID `requestKey` and the current `planRevision` to keep
one intended run identifiable. Read the existing job to check progress; never
submit another generation merely to poll. An ambiguous provider submission is
marked `submission_unknown` and is not automatically submitted again, because it
may already have created a paid provider job. Confirmed task identifiers are
retained for status queries and downloading the result.

Temporary status-query or download failures can leave a job **Paused**. The GUI's
**Resume recreation** action and `POST /reconstructions/:id/resume` resume that
existing job: completed clips are retained, accepted clips are checked through
their saved provider receipts, and still-pending clips may continue under the
originally approved plan. Resume is not a new version or a new request key. It
does not resubmit a clip with an ambiguous submission. A `submission_unknown` job
remains blocked for confirmation rather than being treated as a resumable read
failure.

**Analyze recreation** sends the finished output through the same configured
full-video analysis pipeline. The resulting comparison reports source/output shot
counts, durations and duration difference, plus word-set overlap when speech text
is available. These are inspection aids, not a
validated quality score, a learned similarity model, proof of matching production
quality, or a guarantee that inverse prompting can reconstruct the original.
Neither analysis nor recreation fine-tunes the provider model.

Live verification on 2026-11-12 recreated the saved 26.7-second dreamcode reference
with five MiniMax-H3 clips (34 generated seconds). The assembled MP4 is 480×854 at
30 fps, 7,311,401 bytes, and retains the reference soundtrack. Browser playback and
full-video reanalysis succeeded: the output has five analyzed sections, zero
duration difference and the retained spoken line. Matching transcript wording is
expected when reusing the same soundtrack; these results are not a visual-quality
benchmark. Completed intermediate clips and the duplicate assembly file were
removed; the private library retains the finished MP4 and job manifest.

## Synchronized video and audio

**Video + audio** now combines visual shots, timed Whisper speech, measured sound
levels and local sound-event predictions on the original video's timestamps.
Every shot has aligned audio evidence, including intervals that were not sampled
by the vision model. The **Audio timeline** tab uses the same shot boundaries and
seeks the same source video. Energy-onset candidates are labeled as estimates,
not verified musical beats or BPM.

Sound classification uses Google's pretrained **YAMNet / AudioSet 521-class**
TensorFlow Lite model on actual 16 kHz mono waveform samples: 0.975-second windows
with a 0.48-second hop. The strongest three class scores at or above 0.25 are
retained per window; overlapping predictions of the same class are merged.
These are approximate sound labels and model scores, not calibrated probabilities,
music-track identification, separated stems or verified sound identities. Quiet or
overlapping sounds can be missed. The detector does not infer sounds from frames.
The model's input contract is documented in the
[official TensorFlow Lite audio example](https://android.googlesource.com/platform/external/tensorflow/+/main/tensorflow/lite/g3doc/examples/audio_classification/overview.md).

This Windows workspace reuses its existing Python/TensorFlow installation and adds
only the official model (4,126,810 bytes) and class map (14,096 bytes). In local
mode, no audio is uploaded and no cloud inference API is called. `setup-audio.py` reproduces the
bounded download and verifies pinned SHA-256 hashes; it installs no packages.
In local mode, other hosts configure `SPUR_AUDIO_PYTHON`, `SPUR_AUDIO_MODEL` and
`SPUR_AUDIO_LABELS`. Missing or failed sound classification remains explicit.

**Audio only** refreshes speech, sound labels and measurements while preserving
saved visual descriptions, sampled frames and OCR. The service realigns fresh
audio against the retained visual cuts and retains component provenance. Incomplete
visual coverage stays partial. A partial caused only by failed audio can complete
after successful audio refresh. Audio evidence is included in TXT/MD/JSON exports
and reconstruction prompts. Existing library entries are preserved.

**Analyze all videos** upgrades older results with an audio-only refresh and skips
current results only when both speech and sound classification finished (or the
source has no audio/is silent). Failed or unavailable audio can be retried. The
native `video_reference_analyze` tool accepts `mode:"audio"` through the same
workspace-scoped API. No client can select model binaries, paths or providers.

Live verification: the saved 23.659-second EZ Home reference completed an audio-only
refresh with 12 aligned intervals. The retained visual fields, sampled frames and
OCR were unchanged; speech and YAMNet events gained fresh component provenance.
The actual soundtrack produced Music across the clip (maximum model score 0.996)
and a weaker Rapping prediction during the first window (0.262), illustrating why
scores and uncertainty stay visible. A timeline click sought the unmuted source to
5.333 seconds. Results survived a server restart and exported with audio evidence.
Evidence: `.runtime/verification/synchronized-audio-live.json` and
`synchronized-video-audio.jpg`. Current focused checks: 167 passed, one optional
model fixture skipped, zero failures; the production TypeScript/Vite build passed.

## Analyze all saved videos and TikTok profile artwork

**Analyze all videos** processes this channel's saved video files, one at a time,
through the same shot, speech and on-screen-text pipeline as individual analysis.
It snapshots the saved library when started; discovered videos must be imported
first. Retried URL references are deduplicated. Existing complete and partial
results are skipped, while failed analyses can be retried. Use individual
**Analyze again** to refresh an existing result or expand a previous script-only
run. Partial results retain their component warnings.

The channel exposes a durable `bulkAnalysis` summary with processed, analyzed,
partial, skipped and failed counts. Individual failures do not stop the remaining
videos. **Stop analysis after current** finishes the current video and retains all
results. A restart pauses the batch without automatically starting inference.
Starting again skips completed work. Import-all and analyze-all batches cannot run
simultaneously in the same workspace.

`POST /channels/:id/analyze-all` and `/channels/:id/analyze-all/stop` accept an empty
JSON object only. The server selects saved media from the authenticated workspace;
clients cannot provide file paths, arbitrary IDs or model settings. Poll the channel
read for progress. No new cloud provider or paid service is introduced.

The native Harness adapter exposes `video_channel_analyze_all` and
`video_channel_stop_analysis`, as well as `video_channel_import_all` and
`video_channel_stop_imports`. Each accepts only a registered `channelId` and
returns an asynchronous receipt; use `video_channel_get` to inspect progress.

TikTok creator refresh now obtains the matching creator's actual profile photo
from public profile metadata, separately from video covers. The optional request
uses the canonical official profile URL, never follows redirects or sends cookies,
and is bounded to eight seconds and 2 MiB. The existing validated image cache serves
the artwork privately. Blocked artwork does not discard the public video list or
replace a saved profile image. New channels created by individual TikTok imports
also attempt one profile refresh; batch imports reuse the saved channel metadata.

Live `@ez_home` verification on 2026-11-12 retrieved a real 67,890-byte JPEG and
displayed it in the app. Deterministic checks cover batches larger than the queue,
partial/failure outcomes, duplicate skips, stop/restart behavior and workspace
isolation. Verification logs remain in the ignored `.runtime/verification` folder.
Current focused run: 138 tests, 137 passed, one optional model fixture skipped;
the production TypeScript/Vite build passed.
The live UI bulk action finished both saved EZ Home videos with zero failures:
the 23.659-second reference completed with 12 described intervals, while the
103.838-second reference remained partial because 12 of its 71 detected intervals
were visually sampled. Both retained transcripts and OCR observations. Browser
reload preserved batch progress; final evidence is `tiktok-profile-analysis-live.json`
and `tiktok-profile-analyze-all.jpg` in the verification directory.

## Import all channel videos

Each channel exposes **Import all videos** next to Add video. This snapshots all
currently discovered URLs, skips already saved videos, and imports the rest through
the existing single-worker queue. It does not run analysis automatically. A public
preview is still only a preview: the button does not claim to import undiscovered
videos from an entire account.

The workspace persists one bulk job with processed/imported/skipped/failed counts.
Progress survives navigation and browser reloads. **Stop after current** prevents
further downloads while retaining imported files. A server restart marks unfinished
work paused; starting again skips saved files. File/library/storage limits remain
enforced. Rate limits, unavailable tools and full storage pause the job; individual
unavailable videos are reported and other videos continue.

API: `POST /channels/:id/import-all` and `POST /channels/:id/import-all/stop` accept
an empty JSON object only. The host selects URLs from the saved channel catalog.
Channel reads expose a slim `bulkImport` summary. No client paths, arbitrary URL
lists or model/provider settings are accepted. One channel batch runs per workspace.

Verification: 122 focused tests passed, one optional model fixture skipped, and the
production build passed. Tests cover 30/35-video runs beyond the queue limit,
duplicate skips, retrying failures, stopping, interrupted progress and storage/rate
limits. Index replacement retries transient Windows sharing violations while keeping
atomic replacement and preserving the original index on failure.

## TikTok creator workspaces

Add `https://www.tiktok.com/@creator` through **Add channel**. TikTok profiles have
their own reference library, style/production settings and observations, separate
from Instagram profiles with the same handle. Saved imports with verified TikTok
creator metadata are matched to the appropriate workspace automatically.

Public refresh uses the installed official yt-dlp extractor in metadata-only mode:
at most 24 posts, a 40-second deadline and 4 MiB of output. Recognized photo-mode
entries and foreign-owner entries are excluded. Catalog videos download only when
the user chooses Import video; the existing 150 MiB/5-minute checks still apply.
The preview never claims full-feed coverage, and TikTok channels do not display
Instagram connection controls. Restricted profiles remain saved with a refresh
error so existing references and style settings are preserved.

Live verification on 2026-11-12: `@ez_home` was added through the actual UI, returned
22 public video references from the bounded preview, and included the previously
imported 23.659-second reference in its library. Source and private-thumbnail routes
use platform-qualified channel IDs. Focused checks: 115 passed, one optional model
fixture skipped; the production build passed.

## Scope

The Spur web app exposes the following functions at `#video/inverse-prompting`:

1. **Shot breakdown / inverse prompts:** visual descriptions, estimated section
   timing, framing/movement/action, and copyable per-shot and whole-video production
   descriptions. SiliconFlow receives the complete original video; the optional
   local pipeline uses measured scene candidates and sampled frames.
2. **Script & text:** actual audio transcription, readable timed speech segments
   and separately timestamped on-screen text observations. Local word timestamps
   are retained when available; multimodal timings remain model estimates.
3. **Recreation:** editable per-clip prompts, explicitly requested paid H3
   generation, trimmed hard-cut assembly, private output and same-pipeline
   reanalysis. The generation and audio limits above remain visible in the plan.

Upload a video or import a supported public link, select an analysis mode and run
Analyze video. Results persist in the private reference library and export as TXT,
Markdown or JSON. Selecting a timestamp seeks the source preview. A refresh or
server restart does not discard completed results.

Analysis alone produces text and observations; it does not generate a new video.
The separate recreation action produces an approximate new video from the reviewed
plan. It does not automatically optimize prompts through repeated paid generations,
fine-tune a model, guarantee exact reconstruction, or publish to Instagram.

## Channel workspaces

The top bar switches between creator accounts using their real profile images and
handles. Each account has a separate reference grid and **Style & production** tab.
The grid combines saved imports and the account's publicly discoverable preview
videos. Original source ownership is retained; unrelated uploads and other
platform references remain in **Unassigned** unless explicitly assigned.

Channel images are cached privately and reference thumbnails are fetched through
a bounded official-CDN image proxy. **Refresh profile** updates the public preview;
**Discover full channel** starts the separate paginated feed scan described below.
Refreshing preserves earlier references. Individual videos are downloaded only
when imported. Search covers the complete saved metadata catalog; the grid renders
24 references initially, with a Show more action to avoid loading every thumbnail.

Creative direction, recurring format, editing/sound, voice, production notes and
preferred production approach are saved per account. The options are flexible,
AI video, footage editing or hybrid. These preferences inform future briefs;
the recreation module currently implements text-to-video clips and assembly rather
than every production approach. Unsaved drafts survive channel switching
within the open workspace. A saved profile can be copied as a channel brief.

The observations panel derives shot timing, framing, movement, speech and text
statistics from that account's actual saved analyses. Partial results remain
identified. No channel-wide learned model, training job or quality score is implied.

Channel metadata and styles persist in `channels.json` beside the reference
library. Existing profile-linked imports are migrated without losing video bytes
or analyses. The original workspace authentication boundary also applies to channel
and image routes.

| API below the video-analysis prefix | Behavior |
| --- | --- |
| GET/POST `/channels` | List accounts or add a public Instagram/TikTok profile |
| GET/PATCH `/channels/:id` | Read the account or save `{style}` |
| POST `/channels/:id/sync` | Refresh public account image and catalog |
| POST `/channels/:id/discover` | Start/resume paginated discovery, async 202, `{resume?:boolean}` |
| POST `/channels/:id/import-all` | Import the saved discovered catalog, async 202, `{}` |
| POST `/channels/:id/import-all/stop` | Stop after the current import, `{}` |
| POST `/channels/:id/analyze-all` | Analyze saved channel media, async 202, `{}` |
| POST `/channels/:id/analyze-all/stop` | Stop after the current analysis, `{}` |
| GET/PUT/DELETE `/instagram-connection` | Read connection status, validate/save `{accountId,accessToken}`, or disconnect |
| GET `/channels/:id/avatar` | Private cached account image |
| GET `/channels/:id/thumbnail?video=CODE` | Bounded private catalog thumbnail |
| GET `/items?channelId=...` | Filter the saved library by account |
| PATCH `/items/:id` | Assign an unverified reference using `{channelId}` |

Imports accept an optional `channelId` field; uploads accept it as a query
parameter. Verified source ownership takes precedence over a requested assignment.
The native video tools now include account list/read/add/sync/discover/style and reference
assignment, using the existing short-lived workspace-scoped host token. A live
Harness session still requires the separately configured chat runtime.

Channel workspace verification: the final focused run passed 82 of 83 tests,
with one optional model integration fixture skipped, and the production build
passed. The live app loaded both account JPEGs and private catalog thumbnails
with HTTP 200; each library showed six real videos, with earlier failed imports
in a separate collapsed issues list. Browser checks verified account switching,
saved profile feedback, copied account-specific briefs, per-account production
draft restoration, and accessible reference observations on the narrow layout.
The unsaved production test choice was restored to its original value. The
library screenshot and test log are in the ignored `.runtime/verification` folder.

## Full channel discovery

The anonymous embed is a preview with six entries for the supplied accounts and no
pagination cursor. Live full-profile access redirected to Instagram login; a
public profile-info request returned 429. Further anonymous requests stopped.
Those six entries cannot be represented as a complete channel feed.

Full discovery uses [Meta Instagram Business Discovery](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api)
through an authorized professional Instagram account. In **Connect Instagram**,
enter the caller's own linked professional Instagram account ID and a Meta access
token with the required `instagram_basic`, `instagram_manage_insights` and
`pages_read_engagement` permissions. Meta app access/review and account eligibility
also apply. This initial connection flow accepts an existing API token; it is not
a complete one-click OAuth onboarding flow. The API supports public professional
targets, not arbitrary personal/private accounts. A connection cannot guarantee
that Meta exposes every historical/deleted/restricted item.

Tokens are never returned by GET, sent in URLs, exposed to the Harness, included in
channel records or stored in browser storage. On Windows, the host protects saved
credentials with CurrentUser DPAPI in its private workspace; other platforms use
server-session memory unless a credential protector is supplied. The form clears
its token after connection attempts or cancellation. A host can alternatively set
`SPUR_INSTAGRAM_ACCOUNT_ID`, `SPUR_INSTAGRAM_ACCESS_TOKEN`, and optional validated
`SPUR_INSTAGRAM_API_VERSION` (default `v25.0`).

The server reads metadata pages sequentially, classifies video/video-containing
carousels, deduplicates shortcodes and saves each successful page with a private
cursor. The available feed is marked complete only after a real paginated source
returns an explicit end. Rate limits, expired permissions, restarts, malformed
pages, cursor loops and resource limits retain references and report incomplete
coverage. Resume continues from the durable checkpoint. Post counts that include
photos are not presented as a video-total progress percentage.

The old 100-entry truncation is removed. Bounds are 10,000 video metadata entries
across the workspace, 16 MiB for the channel index and the existing 2 GiB workspace
budget. A run pauses after 1,000 pages or 10 minutes and can resume. Discovery does
not automatically download or analyze the channel's media.

Harness tool `video_channel_discover({channelId,resume?})` returns a queued receipt;
poll `video_channel_get` to inspect `discovery.status`, page counts and coverage.
Secrets and raw pagination cursors remain host-private.

Verification: 108 focused video/channel/UI tests passed; one optional real-model
fixture was skipped. The production build passed. Fixture checks cover 260-video
pagination, durable resume, explicit coverage limits, API/provider failures and
token privacy. Actual Windows DPAPI protection/reopening passed with a synthetic
credential. No authorized full live feed has been fetched because no Meta token
is connected in this workspace.

## Local runtime

No cloud API key is required for the installed configuration:

- Official FFmpeg/FFprobe executables measure and decode media.
- Official Whisper.cpp with `ggml-base-q5_1.bin` and Silero VAD transcribes speech.
- Ollama runs `qwen3-vl:2b-instruct` on the dedicated loopback port 11435.

The model and tools live in the ignored repository `.build-tools` directory.
`local-runtime.mjs` discovers them and starts the dedicated local Ollama process
when necessary. It never downloads files during normal app startup. Explicit host
configuration takes precedence. The earlier default thinking-model test variant
was removed after the instruct variant passed; only the working model remains.

Use the existing app startup from `V2/web` (`npm start`, and `npm run dev` for the
Vite preview). Video analysis runs independently of the chat Harness readiness.
In the loopback development bridge, this section stays local even if chat uses the
cloud. This change has not deployed a server or enabled the public guest gateway.

For another Windows checkout, `python V2/web/video-analysis/setup-local.py` installs
the media/ASR/download tools from official sources with bounded downloads and
checksums where provided. Install Ollama from its official distribution, use
`.build-tools/models/ollama` as `OLLAMA_MODELS`, bind `OLLAMA_HOST` to
`127.0.0.1:11435`, start `ollama serve`, and pull `qwen3-vl:2b-instruct` against that
service. The model is approximately 1.9 GB. Use the **instruct** tag: the default
thinking variant exhausted the response budget without returning usable JSON in
live testing.

Host overrides: `SPUR_FFMPEG_BIN`, `SPUR_FFPROBE_BIN`, `SPUR_WHISPER_BIN`,
`SPUR_WHISPER_MODEL`, `SPUR_WHISPER_VAD_MODEL`, `SPUR_WHISPER_LANGUAGE`,
`SPUR_VIDEO_ANALYSIS_OLLAMA_URL`, `SPUR_VIDEO_ANALYSIS_MODEL`, `SPUR_YTDLP_BIN`.
Paths, provider addresses and credentials are never accepted in analysis requests.

## Source handling and boundaries

Both supplied channel links are saved as reference shortcuts:
`dreamcode_films` and `gdarusa`. Public channel import now resolves an actual reel
from Instagram's `/{username}/embed/` preview, validates the profile and each video
owner, and downloads the selected individual reel with yt-dlp. This replaces
yt-dlp's broken profile-listing extractor. The app preserves the requested profile,
resolved original reel and discovery method. A preview exposes only a small sample,
not a complete archive or a guaranteed chronological latest post. Up to three
public candidates may be tried; sign-in failures and rate limits stop immediately.

Both reference channels also have one-click buttons for clearly labelled selected
example reels. Valid creator-prefixed, `/reels/` and legacy TV links normalize to
canonical individual links; tracking parameters do not create duplicate imports.
No login cookies, browser credentials or third-party download services are used.
Private, unavailable and rate-limited videos still produce explicit failures.

Instagram can omit duration and dimensions in its download metadata. The importer
allows unknown upstream values, supports portrait media, and verifies the actual
file using FFprobe before saving: a real video stream and a measured positive
duration of at most five minutes are mandatory. Audio/video formats are preferred
together, with a merged-stream fallback. Missing yt-dlp metadata prints JSON null,
never literal `NA`, so a successful download is not discarded as malformed output.

Link import supports bounded Instagram, individual TikTok videos, direct YouTube/Shorts and Vimeo URLs using
yt-dlp. Its generic extractor is disabled. Direct video downloads are restricted to
known public media hosts/paths, with public DNS checks, redirect checks and size
limits. No login cookies or browser credentials are imported automatically.

TikTok accepts `tiktok.com/@creator/video/ID`, `vm.tiktok.com/CODE`,
`vt.tiktok.com/CODE` and `tiktok.com/t/CODE`. Tracking queries are removed. Share
redirects are resolved with a 20-second deadline, at most six requests, public DNS
checks and an exact TikTok host/path allowlist at every hop. Profiles, live streams,
photo posts and redirects outside TikTok are rejected. The existing single-video
download, media verification, size/duration limits, private preview and analysis
flow apply unchanged. The resolved video URL and requested share URL are retained.
TikTok can reject public downloads by IP, region or sign-in state; these failures
are displayed explicitly rather than treated as unsupported URLs.

TikTok verification (2026-11-12): the documented public `@scout2015` example
`6718335390845095173` imported through the actual Spur form, saved 2,004,627 bytes,
and played in the private source preview at 720×1280, 10.495 seconds, with no media
error. It remained ready for the existing analysis actions. A different public
sample was IP-blocked by TikTok; the importer now reports that cause explicitly.
Final focused video/client checks: 61 passed, one optional model fixture skipped;
the production build passed. One parallel run hit a transient Windows EPERM rename
in the existing persistence tests; isolated and serial runs passed. Proof image:
`.runtime/verification/tiktok-import.jpg` (ignored runtime artifact).

Limits: 150 MiB per video, 5 minutes, 2 GiB per private library, 200 records and 24
queued jobs. One host worker runs at a time across profiles. Media and library
operations use the server-selected workspace. Files are streamed with range support;
the browser does not receive local paths. Incomplete work after a restart becomes
an explicit retryable failure. Imports reserve space before downloading.

Visual analysis reads two stills from at most 12 detected intervals (24 frames),
not every frame. Printed text is transcribed in independent, single-frame OCR
calls; scene-description responses cannot populate the script or on-screen text.
Script mode runs speech transcription and OCR without the shot-description call.
On-screen text timestamps are observed sample times, not full subtitle-duration
claims. Cuts, movement, OCR and ASR can be wrong; names in particular need review.
Missing or failed components produce a partial result.
“Complete” means the requested processing finished, not a production-quality score.

## API and Harness

All endpoints are beneath `/api/creator-agent/video-analysis` and use the existing
host authentication/profile boundary:

| Method/path | Behavior |
| --- | --- |
| GET `/status` | Actual dependency/model capabilities and limits |
| GET `/items` | Slim saved-library summaries |
| POST `/uploads?filename=...` | Raw bounded video upload |
| POST `/imports` | Queue `{url}` import |
| GET `/items/:id` | Saved details, progress and analysis |
| POST `/items/:id/analyze` | Queue `{mode, analysisModelId?}`; modes are `both`, `breakdown`, `script`, `audio` |
| GET `/items/:id/media` | Private source playback |
| GET `/items/:id/export?format=txt` | TXT, MD or JSON export |
| GET `/items/:id/rea-assets?asset=storyboard` | Private Rea storyboard, audio chart or shot contact sheet; `download=1` downloads it |
| GET `/items/:id/rea-frames?start=14&end=22` | Local timestamped full-frame grid, up to 12 seconds and 24 samples |
| PUT `/items/:id/rea-review` | Save manual `summary`, `hook`, `payoff`, `characters`, `corrections` notes (4,000 characters per field) |

The registered native adapter is `V2/agent/tools/video-analysis/index.cjs`.
`video_analysis_status` reads the available model IDs and access limitations.
`video_reference_analyze` and `video_channel_analyze_all` accept an optional
`analysisModelId` from that list. `video_reference_list`, `video_reference_import`
and `video_reference_get` call the same host API. The host supplies a short-lived,
workspace-scoped tool token; tools cannot choose a filesystem root. This avoids
multiple writer processes. Full live Harness invocation still depends on its
existing runtime and chat-provider setup; the direct UI does not require it.

Script refreshes preserve visual results; breakdown refreshes preserve verified
speech. OCR and speech evidence retain separate component provenance. Word midpoint
assignment avoids repeating a full sentence across adjacent shot intervals.

## Verification evidence

The production UI build passes. Focused service, HTTP, importer, model-discovery,
Harness-adapter, client and existing reel-foundation tests pass; optional tests
requiring an explicit integration fixture are reported separately.

Final focused run: 74 tests, 73 passed, zero failed, one optional integration
fixture skipped. Actual installed-model inference was verified separately below.
The browser reopened the saved result after a page reload, copied the timed script
and triggered a text download. All three export endpoints returned valid downloads.
The browser automation file chooser did not attach the Windows fixture; the real
upload endpoint was used to seed that same source before running analysis in the UI.

The subsequent Instagram fix was checked with real anonymous downloads, not only
metadata probes: dreamcode's `DepDMxUAQPe` is 15.79 seconds, 720×1280 H264 with AAC
audio (1.10 MB); gdarusa's `DfYo7LKgBoY` is 71.51 seconds, 720×1280 H264 with AAC
audio (19.68 MB). A full channel-to-file smoke check also resolved dreamcode's
`DethNB9g3m_` and verified its 4.57-second portrait video and audio. Public preview
responses were HTTP 200 for both supplied channels. Compact evidence is saved in
the ignored verification directory. The focused suite after this import change
passed 61 tests, with one optional model integration fixture skipped.

In the running Spur app, both supplied profile URLs completed import and the
previously failing `/reels/DfUrMUqgB6p/` link also completed (33.71 seconds).
Browser verification showed the saved source/profile links and a loaded portrait
preview. Analysis of the imported dreamcode example returned three visual shot
descriptions and inverse prompts; its final interval remained explicitly partial
because one frame could not be decoded. Import success does not imply every later
analysis component succeeds. `instagram-app-import-evidence.json` and
`instagram-import-working.jpg` retain the local verification evidence.

`verify-local.mjs` builds a clearly labelled synthetic 13-second clip using local
speech synthesis and visible text. An **earlier pipeline**, before OCR was split
into independent single-frame calls, passed in 17.6 seconds: two intervals, four
sampled frames, expected spoken phrases and all four visible strings recovered.
That timing is not a benchmark of the final OCR pipeline. “Spur Ring” was
transcribed as “spurring,” demonstrating the proper-name limitation. A 301-second
fixture was rejected before inference.

The final independent OCR path was checked directly with `verify-ocr.mjs`. Two
single-frame calls completed in 3.33 seconds: the labelled synthetic printed-text
frame returned “SPUR RING”, “VIDEO SCRIPT” and “TEST”; an inspected actual Sintel
frame without printed words returned an empty text list. The output is saved as
`independent-ocr-verification.json` under the ignored verification directory. This
is a two-frame correctness check, not evidence of accuracy on every reel.

A separate real example uses a 16-second excerpt of the Blender Foundation's Sintel
trailer served by the [W3C video demo](https://www.w3.org/2010/05/video/mediaevents.html).
The latest app result is **partial**: six shot intervals, two accurate speech
segments (“What brings you to the land of the gatekeepers?” and “I’m searching
for someone.”), and one valid title-text observation. A sample that echoed the
OCR output key was rejected and explicitly flagged as unreliable; its text was
not accepted as a caption. The source is labelled as a W3C reference excerpt,
never as content from either supplied Instagram channel.

Earlier real runs exposed both placeholder text and scene descriptions incorrectly
returned as OCR. Text now comes only from the independent transcription calls.
The parser filters placeholder-only responses and rejects exact schema-key echoes
(`onScreenText` / `on_screen_text`), producing a partial result rather than fake
captions. Regression tests preserve legitimate phrases such as “Null Island” and
long printed captions; there is no caption-length or sentence-wording filter.

Run the focused tests with Node's test runner over `video-analysis/*.test.mjs` and
`tests/inverse-video.test.mjs`. The Windows sandbox can block `realpath` and loopback
listeners; verification used normal local filesystem access. Existing cloud-bridge
tests that rely on POSIX token-file permissions fail on Windows; the new boundary
test confirms video data remains local and never reaches the cloud bridge.

Generated samples and verification outputs are under ignored `.runtime` directories.
No model weights, source videos or private library data belong in a commit.

## Expanded Rea Video breakdown

The local workflow retains native camera/framing, lighting and colour estimates,
editing rhythm, signal-based sound candidates, packaging observations, source
material requirements and shooting/remake guidance. These are bounded readable
sections from the pinned native report, explicitly marked unreviewed. Native
lighting, voice origin and production-format guesses can be wrong; they are not
proof of the actual equipment, human/TTS voice, AI source or narrative meaning.
OCR being disabled means captions were not analysed, even when no cues appear.

Storyboards, audio charts and selected shot contact sheets are resized and capped
at 256 KiB each and 1 MiB total per result. The private index retains their bytes;
normal detail responses and JSON exports expose metadata only. Asset routes use
fixed IDs, image signatures and existing profile authentication. Frame inspection
runs locally on demand, permits one operation per workspace at a time and does not
retain the generated grid after the response. Both workflows isolate credentials,
block downloads/network access in Python and clean temporary media.

Manual review notes are user-supplied observations. They persist across Rea
reruns and exports but never change `reviewStatus: unreviewed`, VLM provenance,
classification scores or the nine-column production sheet. Switching to a model
workflow discards Rea-specific components. No correction is silently added to a
model evaluation prompt.

Optional native OCR, speech recognition, diarization and audio stems require
additional dependencies/model files and are not enabled by this integration.
Semantic interpretation is available through the separate model workflow; paid
generation, local remake/compare tools and PDF export are separate native tools,
not enabled actions in this screen. The UI reports these distinctions rather than
claiming unavailable functions ran.
