# Reference-guided reels foundation

Start with footage + a separate music track + straight cuts. Preserve real reference
videos, timed observations and their order. A pretrained multimodal model can supply
visual/audio interpretations and real embeddings; the agent can retrieve examples,
choose footage and revise an edit plan. JSON is the interface and evidence store,
not a prescribed creative format.

## Implemented

- `media.mjs`: local FFprobe metadata, FFmpeg scene-change candidates, 100ms audio
  RMS windows and energy-onset candidates. These are **not** narrative labels,
  transcription, BPM/beat tracking or semantic interpretation.
- `index.mjs`: persistent timestamped observations and optional dense vectors;
  exact cosine search only within the same model/version/dimension space. Numeric
  similarity is reported separately. Source links and full ordered references remain
  retrievable. No embedding provider or large vector service is installed.
- `plan.mjs`: a timing-transfer baseline. Caller selects one reference and one
  registered footage range per reference segment. The plan retains sequence,
  quantizes durations to frames, validates source lengths and optionally adds music.
  It does not select shots semantically or infer a channel's style.
- `render.mjs`: cuts-only, center-cropped H.264/AAC MP4. Measures actual source
  metadata again and checks the result's streams, dimensions, duration and full
  decoding before returning completion. Existing outputs are never overwritten.
- `workspace.mjs`, `tools.mjs`, `cli.mjs`: one host-selected private workspace,
  registered asset IDs, changed-file checks and callable functions. No publishing.

The canonical web UI and its live Harness configuration are not connected to these
new functions yet. A native plugin adapter is available at
`V2/agent/tools/reel-workspace/index.cjs`. Host registration, user-scoped asset
ingestion, multimodal model analysis and an embedding provider are still required
for an automatic channel-URL-to-reel flow. Supplying a URL stores an evidence link;
it does not download or analyze that URL.

## Local setup

Requires Node 20+ and, for media operations, existing FFmpeg and FFprobe executables
with the filters used by the renderer and the `libx264`/AAC encoders. No npm
dependencies are added. The local checkout had neither executable available during
verification; the real render test therefore skipped rather than reporting success.

From `V2/web`:

```powershell
npm run reels -- capabilities
```

If the tools are outside PATH, set `SPUR_FFMPEG_PATH` and `SPUR_FFPROBE_PATH` in the
host process to their absolute executable paths.

Create a private workspace with this layout, using your actual files:

```text
my-reel/
  project.json
  media/
    reference.mp4
    footage.mp4
    music.wav
  output/
```

`project.json` registers files relative to `media/`; IDs cannot select host paths:

```json
{
  "schemaVersion": 1,
  "assets": [
    {"id": "reference-01", "file": "reference.mp4"},
    {"id": "footage-01", "file": "footage.mp4"},
    {"id": "music-01", "file": "music.wav"}
  ]
}
```

Analyze a reference and register its measured sections, then analyze footage/music:

```powershell
npm run reels -- analyze --workspace my-reel --asset reference-01 --reference hotel-01 --url https://example.com/your-real-reference --title "Your reference title"
npm run reels -- analyze --workspace my-reel --asset footage-01
npm run reels -- analyze --workspace my-reel --asset music-01
npm run reels -- reference --workspace my-reel --id hotel-01
npm run reels -- assets --workspace my-reel
```

Use the actual source URL above. The analyzer scans at most the first 300 seconds;
only a completely analyzed reference with section measurements enters the index.
Reanalysis replaces the asset's own cache. Changed paths, sizes or modification
times invalidate cached metadata. This is not a cryptographic content identity.

The index also accepts a model-produced analysis through `import --input file.json`.
The JSON must be inside the workspace and follow this shape (descriptions below are
schema examples, not claims about a measured video):

```json
{
  "id": "hotel-01",
  "source": {"url": "https://example.com/your-real-reference", "title": "Reference title"},
  "durationSeconds": 3,
  "analysis": {"method": "multimodal_video_analysis", "model": "ACTUAL_MODEL", "version": "ACTUAL_VERSION"},
  "segments": [{
    "id": "opening",
    "startSeconds": 0,
    "endSeconds": 3,
    "observations": {"visual": "Actual observed framing and camera movement", "audio": "Actual observed sound/music"},
    "features": {"shotDurationSeconds": 3, "normalizedPosition": 0}
  }]
}
```

Each segment can optionally carry `embedding: {model, version, dimensions, values}`.
Use actual provider outputs, with the same embedding procedure for queries and
references. Do not mix models or use invented vectors. Without embeddings, a query
such as `{"features":{"shotDurationSeconds":1.5},"limit":5}` runs explicitly
labelled numeric-only search:

```powershell
npm run reels -- search --workspace my-reel --input query.json
npm run reels -- timing --workspace my-reel
```

For `plan-request.json`, select one footage range per section in the chosen
reference. This example assumes that reference has exactly two sections:

```json
{
  "referenceId": "hotel-01",
  "shots": [
    {"assetId": "footage-01", "sourceStartSeconds": 0},
    {"assetId": "footage-01", "sourceStartSeconds": 8}
  ],
  "music": {"assetId": "music-01", "sourceStartSeconds": 0, "gainDb": -6},
  "targetDurationSeconds": 15,
  "canvas": {"width": 1080, "height": 1920, "fps": 30}
}
```

All source ranges and the complete music range must be long enough. Target
duration is rounded to the nearest output frame. Review and edit the resulting
timeline before rendering:

```powershell
npm run reels -- plan --workspace my-reel --input plan-request.json --out plan.json
npm run reels -- render --workspace my-reel --input plan.json --out output/reel.mp4
```

Output parent directories must exist. JSON exports and MP4 outputs never overwrite
existing files. Limits: 200 registered assets; 60 shots; 0.5–180 seconds per reel;
even 64–2160px canvas dimensions; 15–60fps; source files at most 2GiB. The media
analyzer samples scene candidates at 6fps/320px, so inspect missed or false cuts.
Source audio is discarded; optional music is trimmed, not looped. There are no
transitions, captions, grading or automatic beat alignment in this slice.

## Harness interface

`createReelTools({root, allowWrites, allowRender, ffmpegPath, ffprobePath})` exposes
`catalog()` and `execute(name, {input: JSON.stringify(object)})`. Ten functions:
`reel_capabilities`, `reel_assets`, `reel_references`, `reel_reference`, `reel_search`,
`reel_timing`, `reel_plan`, `reel_analyze`, `reel_import_reference`, `reel_render`.
Roots, binaries and grants are host configuration, never tool arguments.

The native plugin reads `SPUR_REEL_WORKSPACE_ROOT`. Writes require the host to set
`SPUR_REEL_ALLOW_WRITES=1`; rendering additionally requires
`SPUR_REEL_ALLOW_RENDER=1`. Adding this folder alone does not register the plugin
in an active Harness. Do not point guest users at a shared owner workspace.

Use one writer host process per workspace. The small JSON index serializes writes
inside that host, but has no cross-process lock. Rendering rejects simultaneous
renders inside one process; a host must schedule separate processes itself.

## Verification

```powershell
node --test reels/index.test.mjs reels/media.test.mjs reels/plan.test.mjs reels/render.test.mjs reels/workspace.test.mjs
```

On 12 November 2026: **32 passed, 1 skipped**. Tests exercise persistence,
model-space isolation, timing transfer, source bounds, tool grants, cache
invalidation and path/junction escapes. The skipped test performs real synthetic
fixture renders when FFmpeg/FFprobe are available. Neither these fixtures nor the
passing unit checks demonstrate learned creator resemblance or production quality.
