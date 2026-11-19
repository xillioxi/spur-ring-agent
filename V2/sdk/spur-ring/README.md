# Spur Ring SDK extraction

This exports the AIZO / Yanqiang ring integration currently embedded in
`V2/appV2/app_mobile` into a separate, reusable local bundle. The mobile app
continues using its existing SDK files and build configuration.

**2026-11-12 update:** a separate [Windows protocol port](../../desktop/spur-ring-windows/README.md)
has now been built from analysis of these binaries. Version 0.1.2 has passed
software tests, live ring authentication and a recording-count query. Physical
recording download acceptance remains pending. The extraction below remains the
original mobile SDK snapshot.

The exported vendor binaries support Android and iOS. **They do not provide a
Windows SDK or a working desktop Bluetooth connection.** No desktop connection,
authentication, recording transfer, or playback has been tested with a real ring.

## Export and verify

Run from the repository root with Node.js 20 or newer:

```powershell
node V2/sdk/spur-ring/export-sdk.mjs
node V2/sdk/spur-ring/export-sdk.mjs --verify
node V2/sdk/spur-ring/export-sdk.mjs --verify-source
```

The export writes to `V2/sdk/spur-ring/bundle/`, which is ignored by Git.
`--verify` checks the exported bundle against its manifest without needing the
mobile source. `--verify-source` additionally compares files with the mobile
source in this checkout. `manifest.json` records each file's SHA-256 hash and
source path relative to the recorded `sourceRoot`.

Export uses a fixed destination, deletes nothing, and stops before copying if an
existing exported file has changed. Keep edits in a separate working copy.
The distributable archive is `artifacts/Spur-Ring-SDK.zip` at the repository root.
After unpacking it, run `node export-sdk.mjs --verify` inside the extracted folder.

## Bundle contents

| Path inside `bundle/` | Contents |
| --- | --- |
| `vendor/android/` | Seven original, unchanged vendor AAR/JAR archives |
| `vendor/ios/` | Complete, unchanged `RingSDK.xcframework` and `AB_FOTA.xcframework` trees |
| `reference/android/` | Native modules, registration dependencies, Gradle configuration and Android manifest |
| `reference/ios/` | Ring bridge, simulator stub, recording transcoder/helpers, path header, original podspec and Podfile |
| `reference/typescript/` | `native.ts`, `types.ts` and `RingConnectionService.ts` |
| `reference/SDK-MIGRATION.md` | Existing migration notes and their dated validation limits |
| `manifest.json` | File inventory, source paths and SHA-256 hashes |

Android archives: `aizo_be_lib_release_v2.1.0.aar`,
`aizo_sdk_release_v2.1.2.aar`, `aizo_serversdk_release_v2_2.2.6.aar`,
`AliAgent-release-4.1.3.aar`, `rtk-bbpro-core-1.6.1.jar`,
`rtk-core-1.6.9.jar` and `rtk-dfu-3.12.32.jar`.

## Integration boundaries

The reference code is **not a standalone React Native package**. Android sources
use `com.suprring`, its generated `BuildConfig`, Android Bluetooth APIs and MMKV.
The original registration also includes phone audio, feedback and identity
modules. Its Gradle dependencies and application setup must be adapted together
when integrating into another mobile app.

The iOS bridge depends on React Native, Apple frameworks, Swift-generated bridge
headers and recording helpers. Its original podspec and Podfile are references
to the mobile project, rather than installable configuration for this folder.
Keep the existing vendor app ID, initialization and authentication sequence until
the manufacturer provides replacement authorization details.

Connection completion is event driven: a successful `connect()` command does not
mean authentication succeeded. Preserve the ready/authentication lifecycle in
`RingConnectionService.ts`. Android uses the vendor Opus-to-OGG conversion; iOS
uses the included custom recording parser and Apple audio conversion to M4A.

## What is needed for Windows

The Android AARs require Android runtime APIs. Their native libraries are Android
`.so` files, including ARM variants and x86/x64 AES variants; they are not Windows
DLLs. Both XCFrameworks contain arm64 iOS device and simulator slices only. The
simulator ring bridge is a stub and cannot validate ring Bluetooth behavior.

A Windows implementation needs a manufacturer Windows SDK, or a port of the AIZO
protocol with a Windows Bluetooth implementation. The supplied headers expose
API declarations; the Android bytecode and iOS binary supplied enough additional
implementation evidence for the Windows port linked above. Extracting files
alone does not convert these mobile binaries into desktop binaries.

Request the following from the manufacturer:

- Windows x64/ARM64 SDK binaries, headers, dependencies and a working BLE sample,
  or permission and documentation to implement the protocol independently.
- Exact ring model/firmware compatibility, service/characteristic UUIDs, framing,
  checksums, notification setup and supported BLE connection parameters.
- App authorization, pairing/binding, challenge/response, encryption and key
  provisioning rules, including compatibility with an existing mobile binding.
- Recording listing/download commands, progress, retry/resume and completion
  rules, plus custom Opus header/packet format, timestamps and conversion samples.
- Desktop licensing/redistribution terms and real-device acceptance tests.

Do not substitute the older SmartRing PCM or NUS/Speex implementation: those are
different hardware/protocol paths and do not establish AIZO compatibility.

## Provenance and rights

This extraction was checked against current source and `docs/SDK-MIGRATION.md`.
The instructed `app/docs/PROJECT_CONTEXT.md` and
`app/docs/DEVELOPMENT_RECORDS_INDEX.md` were absent from this checkout. Migration
notes are historical evidence, not proof of current hardware or deployment state.

The original podspec identifies the vendor SDK as proprietary and for internal
use only. A private local export does not grant new distribution or desktop-use
rights. Preserve the vendor files and confirm applicable terms with the vendor.
