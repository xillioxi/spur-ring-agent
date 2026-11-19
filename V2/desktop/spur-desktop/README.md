# Spur Desktop 0.3.0

A Windows and macOS desktop app with a React/TypeScript interface, ElevenLabs speech
recognition, a global dictation shortcut, and native Unicode text insertion.
The Bluetooth authentication and recording adapter runs in a bundled Python
service. Python and Node do not need to be installed to run a packaged release.
The Windows protocol baseline has been verified with the ring. Native macOS
packaging, permissions, Bluetooth, and cursor insertion require acceptance on a
Mac; adding build support does not establish those hardware results.

## Start

On Windows, extract the complete release folder and open **Spur Desktop.exe**. Keep its
`resources` and other runtime files alongside it. Close the old Tk desktop app
before connecting the ring from this version.

On macOS, use the **arm64** DMG for an Apple Silicon Mac or the **x64** DMG for an
Intel Mac. Open the DMG, drag **Spur Desktop** to **Applications**, eject the image,
then open the installed app. macOS **13 Ventura or later** is required by the
pinned Electron 45 runtime; see [Electron's supported platforms](https://github.com/electron/electron/blob/v45.3.1/README.md#platform-support).
The two architectures use separate native helpers; there is no universal build.

In **Settings**, enter your ElevenLabs API key, choose the audio source and
language, then save. Electron safeStorage protects the key using Windows DPAPI
or macOS Keychain. The renderer never receives the saved key. An existing
`ELEVENLABS_API_KEY` environment variable is also supported.

Audio is sent to ElevenLabs only during an explicitly started dictation session
or when you select a recording's **Transcribe** action. Your account's speech-to-text
permissions, credits, internet access and microphone access are required.

## Three audio modes

| Mode | Microphone | Behavior |
| --- | --- | --- |
| Ring control | Computer | Connect the ring, arm dictation, focus your destination, then press/release the ring to start/finish live transcription. It stays armed for the next phrase. |
| Computer mic | Computer | Focus a text field and press **Ctrl+Shift+Space** on Windows or **Cmd+Shift+Space** on macOS to start or stop live dictation. Starting from the app gives you 3 seconds to select your destination. |
| Ring audio | Ring | Arm dictation and make a recording on the ring. After it ends, the new file is synced and transcribed. This mode transcribes completed recordings. |

The Android app linked by the user uses `AudioRecord` on the **phone** for its
live ElevenLabs stream; the AIZO ring supplies gesture/recording-state controls.
Ring control reproduces that behavior with the computer's microphone. This
release does not claim that the detected FE02 AIZO device streams its own mic
live. The separate BAE8 SmartRing stream in that repository is another protocol.
See the bundled `PROTOCOL_LIVE.md` for immutable source links and command evidence.

Only committed ElevenLabs phrases are inserted into the selected foreground
window. Partial text stays in the preview. If the destination changes, insertion
pauses and the transcript remains available to copy. Windows may block input into
elevated programs; run the destination normally. macOS requires Accessibility
permission for cursor insertion. Native password fields are
excluded. Dictation does not press Enter, send a message, or execute commands.

For ring audio, automatic upload requires a physical recording start/stop cycle
while armed and exactly one newly downloaded file whose device timestamp fits
that cycle. Ambiguous or clock-skewed files remain local for manual transcription.
Existing recordings are not automatically sent to ElevenLabs when arming.

## Recordings and data

The library supports sync, playback in your default Ogg player, export, and
manual transcription. Original audio and transcripts remain under
`%LOCALAPPDATA%/Spur/RingDesktop/recordings` on Windows and
`~/Library/Application Support/Spur/RingDesktop/recordings` on macOS. Existing
desktop ring identity and recordings are reused. Preserve `desktop.json` during
upgrades. macOS identifies Bluetooth peripherals with a computer-specific UUID;
scan on that Mac rather than copying a Windows Bluetooth address.

`desktop-ui.json` stores preferences; `elevenlabs-key.bin` stores the encrypted
key. Transcripts are saved beside audio as `.ogg.transcript.json`. Live microphone
audio is streamed without being saved; the current live transcript stays in the
app until cleared or closed. No transcription is started automatically on launch.

The previous app's frame CRC/packet checks and iOS-compatible whole-file checksum
policy remain in effect. See `PROTOCOL_RECORDINGS.md` for recording limitations.

## Validation

The Windows baseline passed TypeScript compilation, protocol/lifecycle tests,
and the Python Bluetooth, packet, audio, IPC and cursor regression suite.
Native English/Chinese/emoji insertion was verified in a disposable test field.
The standalone Electron app passes UI/service startup, Settings navigation, and
renderer isolation checks. Refer to `release-manifest.json` for the final counts
and hardware/cloud acceptance status; mocked tests are not a live ElevenLabs test.
These are the recorded Windows checks, not a claim that a macOS release passed
native or ring testing. A Mac build must be tested on its target architecture.
Final local 0.3.0 checks: 120 Python tests and 33 TypeScript tests passed. Two
native macOS binding tests were skipped on Windows and run by the Mac workflow.
The cross-platform source app also passed startup, Settings, renderer-isolation
and synthetic PCM checks on Windows. These checks do not replace a native Mac
build or a physical ring test on macOS.

```powershell
& '.\Spur Desktop.exe' --self-test --report "$PWD\self-test.json"
```

## macOS permissions

Allow **Bluetooth** when you first scan for your ring, and **Microphone** when you
start live computer-microphone dictation. For cursor insertion, use Spur's
permission controls and enable the application named by macOS under
**System Settings → Privacy & Security → Accessibility**. It may list Spur Desktop
or its bundled SpurRingService helper. Quit and reopen the installed app after
changing permissions. You can use transcript preview and copy without cursor
insertion permission.

If Bluetooth or microphone access was denied, re-enable it in the corresponding
Privacy & Security pane. macOS does not let an app repeatedly request a denied
Bluetooth permission; [Bleak documents the permission lifecycle](https://bleak.readthedocs.io/en/latest/backends/macos.html#permissions).
No permissions, Bluetooth connection, or transcription are requested by the build
script. The optional startup smoke test does not scan or connect a ring.

## Build Windows

Use Node 22.12+ and Python 3.11 x64. The adjacent `spur-ring-windows` project holds
the protocol/service implementation and pinned Python requirements. Install
those requirements plus PyInstaller into your Python environment, then run:

```powershell
.\build.ps1 -PythonPath 'C:\path\to\python.exe'
```

The script builds the native service, installs the locked TypeScript dependencies,
builds the UI, and packages Windows output under `release/win-unpacked`.
No app signing certificate is included; this is a local unsigned test release.

## Build macOS DMGs

Build on **macOS 13 or later**, using native **Python 3.11**, **Node 22.12+**, npm,
and Xcode command line tools (`xcode-select --install`). Use an Apple Silicon Mac
for arm64 and an Intel Mac for x64. The script rejects Rosetta and mismatched
Python/Node architectures. PyInstaller must freeze its service on the target OS;
the Windows workstation cannot produce a working macOS service executable.

From this directory, run the command appropriate to the build machine:

```sh
# On an Apple Silicon Mac
bash build-macos.sh --arch arm64

# On an Intel Mac
bash build-macos.sh --arch x64
```

`--python /path/to/python3.11` and `--node /path/to/node` select explicit tools.
`SPUR_BUILD_PYTHON` and `SPUR_BUILD_NODE` provide the same defaults. The script
creates `../spur-ring-windows/.venv-macos-<arch>`, installs
`requirements-macos.lock`, runs Python and TypeScript regressions, freezes a
console-enabled `SpurRingService.app`, and builds the Electron app and DMG.
The helper has its own Bluetooth and microphone purpose strings and retains
JSON stdio for the private bridge. The top-level app and nested binaries receive
the generated JIT, audio-input, and Bluetooth entitlements when signed.

Artifacts are named `release/Spur-Desktop-<version>-macOS-arm64.dmg` and
`release/Spur-Desktop-<version>-macOS-x64.dmg`. The unpacked app is in
`release/mac-arm64/` or `release/mac/`. Build each architecture in its own checkout
if running the jobs concurrently: `resources/ring-service` is a generated staging
directory shared by the platform build scripts. Never stage the Windows service
in a Mac app or mix two architectures' service files.

By default, the DMG is a **local unsigned build**, without Developer ID signing
or notarization. macOS may block it; follow the system's explicit Open Anyway
flow only for a build you trust. No command disables Gatekeeper. For a distributable
release, pass `--signed` with a Developer ID Application certificate available in
the keychain or through `CSC_LINK` and `CSC_KEY_PASSWORD`; `CSC_NAME` can select
the identity. Missing signing credentials fail a signed build.

`--notarize` enables signing and Apple's notarization service. Supply one complete
credential set: `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`; or
`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`; or `APPLE_KEYCHAIN`,
`APPLE_KEYCHAIN_PROFILE`. Keep secrets outside source control. Notarization runs
only with that flag. Every build uses `--publish never`; no release is uploaded.
See the pinned [electron-builder v26 signing documentation](https://www.electron.build/v26/docs/mac/).

Notices are copied into the app by an `afterPack` hook **before** signing and DMG
creation. `node scripts/collect-notices.mjs --verify` checks both platforms' output
without modifying signed Mac bundles. Python/PyObjC notices stay inside the
helper's Resources directory.

On a Mac with a graphical session, add `--smoke-test` to run the installed-format
app's hidden startup checks. The report is `test-output/macos-<arch>-self-test.json`.
Then mount the DMG, install the app, and verify the Bluetooth/microphone prompts,
ring authentication and recording transfer, Accessibility cursor insertion,
hotkey, playback, and ElevenLabs dictation. A startup report alone does not prove
those hardware/cloud flows. Signed/notarized builds additionally verify code
signatures and the stapled notarization ticket.

ElevenLabs API references: [realtime speech-to-text](https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime)
and [file transcription](https://elevenlabs.io/docs/api-reference/speech-to-text/convert).
