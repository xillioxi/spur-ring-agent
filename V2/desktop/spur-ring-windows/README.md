# Spur Ring for Windows

Version 0.1.2 fixes authentication by using the negotiated Bluetooth write size.
The ring's 76-byte handshake is sent in one write instead of four 20-byte pieces.
The packaged Windows EXE authenticated with the user's physical ring and retrieved
its recording count successfully on 2026-11-12.

A Windows x64 desktop app that connects directly to an AIZO / Yanqiang Spur
Ring over Bluetooth, using a protocol implementation recovered from the supplied
Android and iOS SDK binaries. It runs without a phone, Android emulator, or cloud
service. The original mobile binaries are analysis inputs, not Windows DLLs.

**Status: live ring authentication verified; recording download validation pending.**
The tested ring reported zero stored recordings. The build is a local unsigned
test release; the window title and sidebar display version 0.1.2.

## Run

Open `artifacts/Spur-Ring-Windows-v0.1.2/SpurRing/SpurRing.exe` from the repository root.
For another PC, extract `artifacts/Spur-Ring-Windows-v0.1.2.zip` and open `SpurRing.exe`
inside its `SpurRing` folder. Keep `_internal` alongside the executable.
Python does not need to be installed on the destination PC.

1. Enable Bluetooth, wake the ring and keep it nearby.
2. Make the ring available for a new connection using its normal device process.
   A connection held by the mobile app may prevent desktop access.
3. Click **Scan for rings**, select your ring, then **Connect**.
4. Wait for authentication to succeed, finish any ring recording, then click
   **Sync recordings**.
5. Select a downloaded recording to **Play** or **Export** it. Play opens the
   Windows default player; that player must support Ogg Opus.

The app preserves vendor authentication rejection. A ring bound to another client
may refuse this PC; there is no automatic unbinding or reset action.

## Local data

Data lives in `%LOCALAPPDATA%/Spur/RingDesktop`. `desktop.json` contains this PC's
persistent SDK client identity. Preserve it when updating the app.

`recordings/<device-address>/` stores original `.aizo-opus` bytes, playable `.ogg`
files, and `.ios.json` validation metadata. Complete files are saved before the
ring receives a successful transfer-completion acknowledgement. File names include
a content hash; different rings have separate folders.

The app checks each Bluetooth frame's CRC and recording packet completeness.
Whole-file checksum handling follows the supplied **iOS** recording code, which
does not verify that field. Metadata records the supplied value and that it was
not verified. The Android method was independently found to hang on longer input;
its defective loop is not executed. See [recording evidence](PROTOCOL_RECORDINGS.md).

The app supports manual sync, missing-packet requests, duplicate detection,
bounded transfers, playback/export and an activity log. Restarting a failed sync
starts a fresh download; cross-process partial-transfer resume is not implemented.
Firmware updates, ring recording deletion, health features, phone transcription
and the Creator web workspace are outside this desktop ring utility.

## Validation

- 55 protocol, audio-container and mocked Bluetooth integration tests passed.
- Framing, CRC, sequence and authentication challenge outputs match vectors run
  against the original Android JAR classes.
- A synthetic Opus recording was recognized and decoded with ffprobe/ffmpeg.
- The packaged EXE passed its hidden Tk/async-worker startup test and Windows
  Bluetooth-radio diagnostic.
- Both the production source client and packaged Windows EXE received and verified the physical ring's
  `70 70` challenge, sent `70 71 01`, entered the authenticated state, and
  received `AA 14` in reply to its storage query. The negotiated MTU was 247,
  allowing a 244-byte write. The ring reported zero files and zero stored bytes.
- Real recording download/playback remains pending until a test recording is
  available. Synthetic transfer and audio checks do not replace that acceptance.

Run local diagnostics from PowerShell in the extracted application folder:

```powershell
.\SpurRing.exe --diagnose --report "$PWD\diagnostics.json"
.\SpurRing.exe --self-test --report "$PWD\self-test.json"
```

An explicit connection diagnostic is available as
`--test-connection DEVICE_ADDRESS --report PATH`. It authenticates the selected
ring using this PC's persistent identity, reads recording counts, and disconnects.
It does not start a recording download.

To run the source, use Python 3.11 x64 with `requirements.txt`, then
`python launcher.py`. `--data-dir PATH` selects a separate local library.

## Build from source

From this directory on Windows:

```powershell
.\build.ps1
```

The script creates a local `.venv`, installs pinned dependencies from
`requirements-windows.lock`, runs tests and packages the application with
PyInstaller. Output is under the repository's `artifacts/Spur-Ring-Windows/`.
Windows asyncio uses local sockets internally; this environment's restricted
sandbox requires an approved execution context for async tests and diagnostics.

For protocol details and source-binary evidence, read
[authentication](PROTOCOL_AUTH.md), [recordings](PROTOCOL_RECORDINGS.md), and
[runtime notices](THIRD_PARTY.md).
