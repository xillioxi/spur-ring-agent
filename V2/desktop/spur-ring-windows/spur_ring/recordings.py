"""Phone-free AIZO recording application protocol recovered from Android.

No BLE dependency: a transport sends returned commands using its normal framing
and authentication, then passes decrypted application payloads into ``feed``.
Actual ring/firmware compatibility remains unverified until hardware testing.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from pathlib import Path
import hashlib
import json
import os
import struct
import tempfile

from .ogg import OpusMetadata, opus_to_ogg


VOICE_DATA_TYPE = 1
STORAGE_QUERY = bytes.fromhex("AA1301")
BATTERY_QUERY = bytes.fromhex("3901")


def request_recording(*, resume: bool = False, timestamp: int = 0xFFFFFFFF,
                      start_packet: int = 1) -> bytes:
    """Build AC21; timestamp is wire Unix seconds, not SDK milliseconds."""
    if not 0 <= timestamp <= 0xFFFFFFFF or not 1 <= start_packet <= 0xFFFFFFFF:
        raise ValueError("Timestamp or start packet is outside the wire format")
    return b"\xAC\x21" + struct.pack(">BBII", 2 if resume else 1, VOICE_DATA_TYPE, timestamp, start_packet) + b"\xFF" * 4


def packet_ack(data_type: int, timestamp: int, packet: int, success: bool) -> bytes:
    return b"\xAC\x23" + struct.pack(">BIIB", data_type, timestamp, packet, int(success))


def end_ack(data_type: int, timestamp: int, success: bool) -> bytes:
    return b"\xAC\x25" + struct.pack(">BIB", data_type, timestamp, int(success))


@dataclass(frozen=True)
class StorageSummary:
    data_type: int
    file_count: int
    total_bytes: int


def parse_storage_summary(payload: bytes) -> StorageSummary:
    if len(payload) < 9 or payload[:2] != b"\xAA\x14":
        raise ValueError("Expected an AA14 recording storage response with at least 9 bytes")
    return StorageSummary(*struct.unpack_from(">BHI", payload, 2))


@dataclass(frozen=True)
class FilePacket:
    data_type: int
    timestamp: int
    total_packets: int
    packet: int
    is_last: bool
    is_resend: bool
    current_file: int
    total_files: int
    data: bytes


def parse_file_packet(payload: bytes) -> FilePacket:
    if len(payload) < 24 or payload[:2] != b"\xAC\x22":
        raise ValueError("Expected AC22 with a complete 24-byte header")
    data_type, timestamp, total, current, last, length, resend = struct.unpack_from(">BIIIBHB", payload, 2)
    if not total or not 1 <= current <= total:
        raise ValueError("AC22 packet number or total is invalid")
    if last not in (0, 1) or resend not in (0, 1):
        raise ValueError("AC22 last/resend flag is invalid")
    if len(payload) < 24 + length or not length:
        raise ValueError("AC22 payload length exceeds available bytes or is empty")
    counters = payload[19:22]
    if counters in (b"\0" * 3, b"\xFF" * 3):
        file_number = file_total = 0
    else:
        packed = int.from_bytes(counters, "big")
        file_number, file_total = (packed >> 12) + 1, packed & 0xFFF
    return FilePacket(data_type, timestamp, total, current, bool(last), bool(resend),
                      file_number, file_total, payload[24:24 + length])


@dataclass(frozen=True)
class EndPacket:
    data_type: int
    timestamp: int
    total_packets: int
    checksum: int
    has_more: bool


def parse_end_packet(payload: bytes) -> EndPacket:
    if len(payload) < 20 or payload[:2] != b"\xAC\x24":
        raise ValueError("Expected AC24 with at least 20 bytes")
    data_type, timestamp, total, checksum, more = struct.unpack_from(">BIIQB", payload, 2)
    if more not in (0, 1):
        raise ValueError(f"Invalid AC24 has-more flag {more}; expected 0 or 1")
    if checksum == 0xFFFFFFFFFFFFFFFF:
        checksum = 0
    return EndPacket(data_type, timestamp, total, checksum, bool(more))


@dataclass(frozen=True)
class TransferProgress:
    timestamp: int
    packets_received: int
    total_packets: int
    bytes_received: int
    current_file: int
    total_files: int

    @property
    def percent(self) -> int:
        return min(100, round(100 * self.packets_received / self.total_packets))


@dataclass(frozen=True)
class RecordingFile:
    timestamp: int
    raw_path: Path
    ogg_path: Path | None
    size: int
    metadata: OpusMetadata | None
    metadata_path: Path | None = None
    checksum: int = 0
    checksum_validation: str = "not-provided"


@dataclass
class TransferUpdate:
    commands: list[bytes] = field(default_factory=list)
    completed: list[RecordingFile] = field(default_factory=list)
    progress: TransferProgress | None = None
    finished: bool = False
    error: str | None = None
    warnings: list[str] = field(default_factory=list)


def _atomic_write(path: Path, data: bytes) -> None:
    """Ensure durable local bytes exist before returning a completion ACK."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        if path.read_bytes() == data:
            return
        raise ValueError(f"Existing recording has different bytes: {path}")
    temp_name = None
    try:
        with tempfile.NamedTemporaryFile(prefix=".spur-", suffix=".tmp", dir=path.parent, delete=False) as stream:
            temp_name = stream.name
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_name, path)
        temp_name = None
    finally:
        if temp_name is not None:
            try:
                os.unlink(temp_name)
            except FileNotFoundError:
                pass


class RecordingTransfer:
    """Bounded transfer state machine; call from one serialized worker.

    Resume supports a partial transfer retained in this object across a BLE
    disconnect. Restarting the application starts a fresh transfer; no claim of
    cross-process resume or ring-side data retention is made.
    """
    def __init__(self, output_dir: Path | str, *, max_file_bytes: int = 64 * 1024 * 1024,
                 max_packets: int = 100_000, max_session_bytes: int = 256 * 1024 * 1024,
                 max_files_per_sync: int = 4096, checksum_policy: str = "ios"):
        if max_file_bytes < 16 or max_packets < 1 or max_session_bytes < 16 or max_files_per_sync < 1:
            raise ValueError("Transfer limits must be positive")
        self.output_dir = Path(output_dir)
        self.max_file_bytes = max_file_bytes
        self.max_packets = max_packets
        self.max_session_bytes = max_session_bytes
        self.max_files_per_sync = max_files_per_sync
        if checksum_policy not in ("ios", "strict"):
            raise ValueError("Checksum policy must be 'ios' or 'strict'")
        # The supplied iOS vendor SDK verifies packet completeness and ignores
        # the custom AC24 whole-file checksum. The Android checksum method was
        # independently confirmed defective. This is a deliberate vendor policy,
        # not an invented checksum verifier. Transport CRC remains mandatory.
        self.checksum_policy = checksum_policy
        self._session_bytes = 0
        self._session_files = 0
        self.active = False
        self._accepted_end: tuple[int, int, int] | None = None
        self._reset()

    def _reset(self) -> None:
        self._identity: tuple[int, int] | None = None
        self._total = 0
        self._packets: dict[int, bytes] = {}
        self._bytes = 0
        self._end_seen = False
        self._next_missing = 1

    def start(self, resume: bool = True) -> list[bytes]:
        self.active = True
        self._accepted_end = None
        self._session_bytes = 0
        self._session_files = 0
        if resume and self._identity is not None and self._packets:
            return [request_recording(resume=True, timestamp=self._identity[1],
                                      start_packet=min(max(self._packets) + 1, self._total))]
        self._reset()
        return [request_recording()]

    def stop(self) -> None:
        """Stop receiving without discarding the in-memory partial transfer."""
        self.active = False

    def _find_missing(self) -> int | None:
        while self._next_missing <= self._total and self._next_missing in self._packets:
            self._next_missing += 1
        return self._next_missing if self._next_missing <= self._total else None

    def feed(self, payload: bytes) -> TransferUpdate:
        update = TransferUpdate()
        if not self.active or payload[:2] not in (b"\xAC\x22", b"\xAC\x24"):
            return update
        try:
            if payload[:2] == b"\xAC\x22":
                return self._receive_file(parse_file_packet(payload))
            return self._receive_end(parse_end_packet(payload))
        except (ValueError, OSError) as error:
            update.error = str(error)
            return update

    def _receive_file(self, packet: FilePacket) -> TransferUpdate:
        update = TransferUpdate()
        if packet.data_type != VOICE_DATA_TYPE:
            raise ValueError(f"Unsupported transfer data type {packet.data_type}")
        if packet.total_packets > self.max_packets:
            raise ValueError(f"Recording exceeds packet limit {self.max_packets}")
        identity = (packet.data_type, packet.timestamp)
        if self._identity != identity:
            if self._identity is not None and packet.packet != 1:
                raise ValueError("AC22 timestamp/type differs from the active recording")
            self._reset()
            self._identity = identity
            self._total = packet.total_packets
        if packet.total_packets != self._total:
            raise ValueError("AC22 total packet count changed during the recording")
        old = self._packets.get(packet.packet)
        # Conflicting repeated packets indicate corruption; do not silently
        # overwrite a frame and acknowledge a potentially damaged recording.
        if old is not None and old != packet.data:
            raise ValueError(f"Conflicting duplicate recording packet {packet.packet}")
        if old is None:
            if self._bytes + len(packet.data) > self.max_file_bytes:
                raise ValueError(f"Recording exceeds byte limit {self.max_file_bytes}")
            self._packets[packet.packet] = packet.data
            self._bytes += len(packet.data)
        update.progress = TransferProgress(packet.timestamp, len(self._packets), self._total,
                                           self._bytes, packet.current_file, packet.total_files)
        if packet.is_resend or self._end_seen:
            missing = self._find_missing()
            update.commands.append(packet_ack(*identity, missing if missing is not None else self._total,
                                              missing is None))
            # As in the vendor SDK, wait for AC24 after a retransmission ACK;
            # a resend flag alone does not mean the file is complete.
        return update

    def _receive_end(self, end: EndPacket) -> TransferUpdate:
        update = TransferUpdate()
        if end.data_type != VOICE_DATA_TYPE:
            raise ValueError(f"Unsupported transfer data type {end.data_type}")
        if end.total_packets > self.max_packets:
            raise ValueError(f"Recording exceeds packet limit {self.max_packets}")
        key = (end.data_type, end.timestamp, end.total_packets)
        if key == self._accepted_end:
            update.commands.append(end_ack(end.data_type, end.timestamp, True))
            return update
        if end.total_packets == 0:
            empty = end.timestamp in (0, 0xFFFFFFFF)
            update.commands.append(end_ack(end.data_type, end.timestamp, empty))
            if not empty:
                update.error = "The requested recording does not exist on the ring"
            if end.has_more:
                self._reset()
                update.commands.append(request_recording())
            else:
                update.finished = True
                self.active = False
            return update
        if self._identity != (end.data_type, end.timestamp) or end.total_packets != self._total:
            update.commands.append(end_ack(end.data_type, end.timestamp, False))
            self._reset()
            update.commands.append(request_recording())
            update.error = "AC24 does not match the cached recording; restarted transfer"
            return update
        self._end_seen = True
        missing = self._find_missing()
        if missing is not None:
            update.commands.append(packet_ack(end.data_type, end.timestamp, missing, False))
            return update
        raw = b"".join(self._packets[index] for index in range(1, self._total + 1))
        if self._session_files >= self.max_files_per_sync or self._session_bytes + len(raw) > self.max_session_bytes:
            raise ValueError("Recording sync reached its session file/byte limit; start a new sync to continue")
        # Numeric name comes entirely from bounded wire fields; no ring text is
        # accepted as a local filename. Every raw byte survives a mux failure.
        base = f"ring-{end.timestamp}-{hashlib.sha256(raw).hexdigest()[:12]}"
        raw_path = self.output_dir / (base + ".aizo-opus")
        _atomic_write(raw_path, raw)
        metadata_path = self.output_dir / (base + f".{self.checksum_policy}.json")
        checksum_validation = "vendor-ios-policy" if end.checksum else "not-provided"
        saved_info = {
            "schema_version": 1,
            "timestamp_seconds": end.timestamp,
            "raw_file": raw_path.name,
            "raw_bytes": len(raw),
            "raw_sha256": hashlib.sha256(raw).hexdigest(),
            "packet_count": self._total,
            "checksum": {
                "value": f"0x{end.checksum:016X}",
                "policy": self.checksum_policy,
                "whole_file_verified": False,
                "validation": checksum_validation,
                "basis": "Bundled vendor iOS BTAudioManager ignores the AC24 checksum; packet completeness is checked separately.",
            },
        }
        if end.checksum and self.checksum_policy == "strict":
            saved_info["status"] = "checksum-rejected"
            saved_info["checksum"]["validation"] = "rejected-unverified"
            _atomic_write(metadata_path, json.dumps(saved_info, indent=2).encode("utf-8"))
            update.error = (f"Unsupported nonzero recording checksum 0x{end.checksum:016X}. "
                            f"The bundled SDK checksum loop is defective; raw data was saved to {raw_path}. "
                            "No successful completion ACK was sent.")
            return update
        ogg_bytes, metadata = opus_to_ogg(raw)
        ogg_path = self.output_dir / (base + ".ogg")
        _atomic_write(ogg_path, ogg_bytes)
        saved_info.update(status="complete", ogg_file=ogg_path.name, audio=asdict(metadata))
        _atomic_write(metadata_path, json.dumps(saved_info, indent=2).encode("utf-8"))
        update.completed.append(RecordingFile(end.timestamp, raw_path, ogg_path, len(raw), metadata,
                                             metadata_path, end.checksum, checksum_validation))
        if end.checksum:
            update.warnings.append(
                f"Recording saved using the vendor iOS checksum policy: AC24 checksum 0x{end.checksum:016X} "
                "was recorded but not verified. Packet completeness and transport CRC are checked separately.")
        if metadata.trailing_bytes:
            update.warnings.append(f"Ogg conversion ignored {metadata.trailing_bytes} trailing bytes forming an incomplete Opus frame; raw data was preserved.")
        self._session_files += 1
        self._session_bytes += len(raw)
        # Returned only after both fsync + atomic replaces succeeded.
        update.commands.append(end_ack(end.data_type, end.timestamp, True))
        self._accepted_end = key
        self._reset()
        if end.has_more:
            update.commands.append(request_recording())
        else:
            self.active = False
            update.finished = True
        return update
