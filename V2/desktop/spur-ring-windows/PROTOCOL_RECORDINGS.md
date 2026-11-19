# Recording protocol and implementation (2026-11-12)

Scope: static recovery from the bundled Android AARs, no device connection or writes performed. Decompiled files are research evidence, not a validated protocol specification. The mobile sources and exported bundle were not changed.

## Evidence

- `VoiceRecordManager.javap.txt` from `aizo_serversdk_release_v2_2.2.6.aar`: normal/resume selection, Opus file parsing, Ogg mux call.
- `BeFileTransferWithRfbpUtil.javap.txt` and its lambda classes: request/ACK bytes, packet layout, cache ordering/resend, end-of-file flow.
- `DeviceManager.javap.txt`, `DeviceManager$getDeviceStorageState$1*.javap.txt`: recording summary, battery and working state.
- Readable CFR output also exists under `.build-tools/cfr/aizo_serversdk_release_v2_2.2.6/com/eiot/ringsdk/`.

All commands below are application payloads passed to BtHelper.requestHex. Outer transport framing, encryption, GATT characteristics and authentication are separate layers.

## Commands

All multibyte transfer integers are big endian. File times are four-byte Unix seconds on the wire; SDK converts to milliseconds by multiplying by 1000.

| Purpose | Application payload |
| --- | --- |
| Recording storage summary | `AA 13 01` |
| Summary response | `AA 14`, type:u8, fileCount:u16BE, totalBytes:u32BE (9 bytes total) |
| Fresh recording transfer | `AC 21 01 01 FF FF FF FF 00 00 00 01 FF FF FF FF` |
| Resume transfer | `AC 21`, transType=2:u8, dataType=1:u8, fileTime:u32BE, startPacket:u32BE, `FF FF FF FF` |
| Packet ACK / resend request | `AC 23`, dataType:u8, fileTime:u32BE, packetNumber:u32BE, result:u8 |
| End ACK | `AC 25`, dataType:u8, fileTime:u32BE, result:u8 |
| Battery query | `39 01` |
| Working state ACK | `AA 12`, result:u8 |
| Smart touch ACK | `81 62`, result:u8 |

In AC23, result=0 asks for retransmission of packetNumber; result=1 confirms all packets through totalPacketCount. AC25 result=1 accepts the file and result=0 rejects/restarts. No ring deletion/retention guarantee was found; do not infer what a successful ACK does to storage retention.

`getVoiceRecordFile(false, callback)` is normal flow: resume cached partial if present, otherwise fresh request. `true` is resume-only and fails if the cached transfer type does not match. The start command returns success after submitting the write, before ring acknowledgement or transfer completion.

The sendFileDataRequest signature includes pktAckFreq but its bytecode never uses that argument. Do not add a guessed field to AC21.

## Incoming AC22 file-data packet

| Offset | Length | Meaning |
| --- | --- | --- |
| 0 | 2 | AC22 |
| 2 | 1 | dataType (1 = Opus recording) |
| 3 | 4 | file timestamp, BE seconds |
| 7 | 4 | total packet count, BE |
| 11 | 4 | current packet number, BE, starts at 1 |
| 15 | 1 | isLastPacket |
| 16 | 2 | payload length, BE |
| 18 | 1 | isResendPacket |
| 19 | 3 | high 12 bits = zero-based current file index; low 12 bits = total file count |
| 22 | 2 | reserved / not consumed |
| 24 | payload length | file bytes |

If counters are all-zero or all-FF, SDK exposes counters as zero. For usable counters it adds 1 to current file index. Bytes after payloadLength are excluded from file assembly.

First packet of a different timestamp/type resets local transfer cache. If first packet was lost but cache empty, the next packet can initialize state. Packets for a different timestamp/type with existing state are dropped. Cache is indexed by packet number, so duplicate packets replace existing entries. Assembly uses packet number ascending, not arrival order.

## Incoming AC24 end packet

20 bytes minimum: `AC 24`, dataType:u8, fileTime:u32BE, totalPacketCount:u32BE, checksum:u64BE, hasMoreFile:u8.

All-zero or all-FF checksum is treated as zero (no checksum). totalPacketCount=0 with zero/FF timestamp means no file and is ACKed success. totalPacketCount=0 with another timestamp is ACKed failure. If nonempty end packet does not match cache type/time, SDK ACKs failure, clears cache and makes a fresh AC21 request. If matching, SDK waits 500 ms, scans cache for missing packet numbers, and asks for retransmissions via AC23 result=0. For each retransmitted packet it checks for the next missing one; when complete it confirms AC23 total result=1. Once AC24 has arrived, complete payload is assembled and checked, AC25 success is sent, cache cleared, next fresh AC21 sent if hasMoreFile>0, then the Opus callback is raised. With no more files it raises finish.

An independent implementation should persist raw bytes before successful completion acknowledgement. This improves recoverability without assuming undocumented device storage behavior.

## Checksum caveat

The checksum function in actual javap output, `qGwvuPJEB8dIWulecTEXBZvK(byte[], long)`, loads two-byte big-endian words and takes a sum modulo 65536. HOWEVER bytecode at offsets 16 through 51 loops without changing source index or loop bound. For data length >2 this is an infinite loop if called. CFR reproduces the same missing advancement. Therefore the intended nonzero checksum algorithm is not fully proven by this build; sum of consecutive BE words is a plausible inference and must be confirmed against iOS or a real capture. Do not copy this defective loop or invent a corrected word-sum verifier. Zero/sentinel checksums are explicitly skipped in the Android SDK. The independent iOS recording baseline below omits custom whole-file checksums entirely.

## Recording payload format

16-byte little-endian custom header, then fixed-size Opus packets:

| Offset | Length | Meaning |
| --- | --- | --- |
| 0 | 1 | fileVersion / codec flavor (1=Apollo supported, 2 explicitly unsupported) |
| 1 | 4 | sampleFrequency |
| 5 | 1 | channelCount |
| 6 | 2 | frameDuration milliseconds |
| 8 | 2 | frameSize bytes |
| 10 | 2 | bitRate |
| 12 | 4 | reserved, ignored by parser |
| 16 | remainder | concatenated fixed-size Opus packets |

SDK drops trailing bytes that do not form a full frameSize packet. It muxes into Ogg Opus using channelCount and frameDuration, with Ogg granule sample rate fixed at 48000 (not the header sampleFrequency). Identification header: OpusHead v1, preskip 3200, input rate 48000, gain=0, mapping family=0. Comment vendor EIOT Opus Encoder. BOS page sequence0, tags sequence1, one Opus packet per page starting sequence2, granule += 48000*frameDuration/1000 each packet; empty EOS page at final granule. Proper Ogg CRC is implemented in OggCrcUtil; no native Opus decode library is required merely to mux already encoded packets into playable Ogg.

## Other device events

- `79 01`, battery state:u8 at offset2, level:u8 offset3. SDK PowerState(level,state).
- `AA 11`, function:u8 offset2, state:u8 offset3, optional remainingTime:u16BE offset4. SDK replies AA12 with result1 for successful parse, result0 for failure. Mobile maps states: 1 idle; 2 recording; 3 paused; 4 ready_to_sync; 5 syncing. Sync allowed in 1 or4, blocked in 2/3/5.
- `81 61`, repeated 8-byte touch records after command: local calendar timestamp [year-2000,month,day,hour,minute,second] (6 bytes), event:u16BE. ACK8162 result1 if parsed,2 if insufficient payload. Mobile maps 0x1101 single click,1102 double click,1103 volume up,1104 volume down,1105 swipe up,1106 swipe down,1107 swipe left,1108 swipe right.

## Remaining validation

Outer wire framing and authorization must be recovered separately. Hardware tests must verify the particular ring model, firmware, binding identity, successful transfer ACK/storage lifecycle, nonzero checksum behavior, disconnect/resume, missing/duplicate packet handling, real sample playback and timestamps. A built desktop UI alone cannot establish that this protocol implementation works with the user's ring.

## Desktop module API and implementation choices

`spur_ring.recordings.RecordingTransfer(output_dir)` has no BLE dependency. Use a single worker for the lifetime of one device connection. `start(resume=False)` returns the first AC21 command; call `feed(application_payload)` for authenticated/decrypted payloads. It returns `TransferUpdate(commands, completed, progress, finished, error, warnings)`. Send returned commands in order using the transport's existing encoding. File conversion and disk persistence are synchronous, so an asyncio UI should use a serialized worker/thread for feed rather than process packets concurrently.

`TransferProgress`: timestamp (wire Unix seconds), packets_received, total_packets, bytes_received, current_file, total_files, and percent property.

`RecordingFile`: timestamp (seconds), raw_path, ogg_path, size (raw bytes), metadata_path (JSON sidecar), checksum (wire integer), checksum_validation, metadata (`OpusMetadata`: version, sample_frequency, channels, frame_duration_ms, frame_size, bit_rate, packet_count, trailing_bytes; duration_ms property).

`parse_storage_summary` returns StorageSummary(data_type,file_count,total_bytes). `STORAGE_QUERY` is AA1301. `BATTERY_QUERY` is3901. `request_recording`, `packet_ack`, and `end_ack` build unframed application payloads.

The desktop module enforces limits rather than reproducing vendor defects: 64 MiB raw bytes per file,100000 packets,256 MiB raw bytes per explicit sync,4096 files per sync. Ogg output can be larger because every fixed-size Opus frame has a page header. Invalid or conflicting duplicate packets cause an error and no successful acknowledgement. Malformed packet data never controls file paths; filenames use bounded numeric wire timestamps and a 12-character SHA-256 content suffix. Existing files with differing bytes are never overwritten.

A complete transfer first writes and fsyncs `.aizo-opus` raw bytes, then writes and fsyncs a playable `.ogg`, and only then returns AC25 success. Unsupported container headers retain raw bytes for inspection and return an explicit error without successful ACK. The default checksum_policy="ios" follows the independently recovered iOS whole-file checksum omission; checksum_policy="strict" rejects unknown nonzero checksums with an explicit error and retains raw bytes. The application should stop the sync when an error is returned, while leaving the ring connected for diagnostics. No automatic delete, reset, recording control, unbind or OTA command is sent by this module.

Resume supports partial bytes held by the same RecordingTransfer object across disconnect/reconnect to the same ring. It does not provide process-restart resume. Start a new transfer object or `start(False)` on a different ring, since a timestamp alone is not a device identity.

The vendor flow requests a missing packet using AC23 result0. On receipt of retransmitted packets the module repeats that request for the next missing packet, or sends AC23 total result1 once all packets are present. It waits for the next AC24 end notification before file finalization, consistent with the vendor flow; a resend flag alone does not establish file completion.

The mux uses source-derived OpusHead, OpusTags and granules. It corrects the vendor's missing Ogg lacing zero terminator for frame sizes exactly divisible by255. It rejects channel counts outside1/2 because mapping family0 supports only mono/stereo. It reports ignored trailing incomplete frame bytes in metadata.

Validation: `python -m unittest discover -s tests -p test_recordings.py -v` passes synthetic vectors for application commands, payload bounds, storage response, packet ordering/retransmission, resume, disk failure, unsupported checksums/container versions, byte/packet limits, Ogg header/granules/CRC and255-byte lacing. A synthetic 400ms Opus silence stream converted with this mux was accepted by the bundled ffprobe as Opus48000Hz mono400ms and decoded by ffmpeg to a null sink without errors. These checks validate parsing/state transitions/container generation; they are not physical ring or Bluetooth acceptance tests.

## Independent checksum investigation

The checksum caveat was tested against the actual unmodified original `BeFileTransferWithRfbpUtil` class using reflection in a fresh JVM process with a3-second subprocess timeout. Only its Android class-initialization dependencies (scope,MMKV,serialization,logger) were replaced with no-op JVM stubs; the target SDK method and `ByteArrayExtKt.toIntBig` came from the original AAR JARs unchanged. Results: zero-byte,one-byte,two-byte inputs return calculated checksum0; three-byte and four-byte inputs time out after entering the original method. This proves the loop defect is not merely a decompiler artifact. Source and output are in `V2/sdk/spur-ring/research/recordings/checksum-harness/`.

The supplied iOS arm64 RingSDK binary was also inspected directly, with Mach-O symbol-table extraction and Capstone5.0.9 disassembly. `-[BTAudioManager validateAndCompleteWithData:]` starts at0x14fc0. It loads the AC24 command at0x15088, type at0x1509c, timestamp at0x150a4,total count at0x15200,hasMore at0x152bc. It checks packet-cache completeness, then sends AC25success at0x154c4 when no missing packet indices remain. It does not read checksum bytes11..18 or invoke either available checksum helper in this recording path. Therefore this iOS version accepts a complete recording without validating its whole-file checksum.

The iOS `+[BTOriginalDataHelper calculateChecksumForPackets:]` at0x1e614 sums individual payload bytes and returns a16-bit result (used for original/health data). `+[BTDataTools checkSumWithData:]` at0x29078 sums individual bytes into64bits and returns NSData (header documents OTA use). Neither establishes the intended Android recording algorithm, which visibly loads16-bit big-endian words. Substituting either helper for the recording checksum would be an unsupported inference.

Symbol-annotated assembly is saved in `BTAudioManager-validate.arm64.txt`, `BTOriginalDataHelper-checksum.arm64.txt`, `BTDataTools-checksum.arm64.txt`, `BTAudioPacketModel-parser.arm64.txt` under the recording research directory. These are static binary findings, not successful ring transfers. The desktop implementation deliberately mirrors the supplied iOS omission by default and offers strict rejection as an opt-in policy. It does not claim that a custom whole-file checksum was verified.

### Final checksum policy

The inspected iOS device RingSDK binary SHA-256 is `9aa87db922d37a3a89cdedf928083fcfb5344df070fcf22a9ebf48e9e20d095c`. Its recording completion routine's packet-complete success path does not read AC24 checksum bytes11..18. This manufacturer implementation is the basis of the desktop default `checksum_policy="ios"`; it is not evidence for any checksum arithmetic. Individual transport-frame CRCs and packet completeness remain mandatory and are independently verified by their respective transport/transfer layers.

For a nonzero AC24 checksum, the desktop records the exact value and policy in a durable `.ios.json` sidecar, sets `whole_file_verified` tofalse, and returns a warning. Raw data, Ogg output and JSON metadata must all persist successfully before AC25success is returned. The sidecar includes rawSHA-256, packet count, audio header metadata and the explicit vendor-policy basis. `RecordingFile` exposes metadata_path,checksum,checksum_validation; `TransferUpdate.warnings` carries the policy notice. Trailing bytes omitted from the playable Ogg are also reported through warnings and metadata.trailing_bytes; complete raw bytes are retained.

Use `checksum_policy="strict"` to reject any nonzero custom checksum instead. In this mode `.strict.json` records the rejected checksum/policy and raw data survives; no successful completion ACK is returned. Neither mode executes the proven defective Android checksum loop. Synthetic protocol/Ogg tests now cover both policies, metadata persistence and malformed AC24hasMore/truncated packets (18 tests).
