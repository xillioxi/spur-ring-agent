"""Mux the vendor's custom recording container into Ogg Opus.

Derived from the bundled Android VoiceRecordManager and OpusOggFileEncapUtil.
This wraps existing Opus frames; it does not decode or transcode audio.
"""
from __future__ import annotations

from dataclasses import dataclass
import struct


def _crc_table() -> tuple[int, ...]:
    table = []
    for value in range(256):
        crc = value << 24
        for _ in range(8):
            crc = ((crc << 1) ^ (0x04C11DB7 if crc & 0x80000000 else 0)) & 0xFFFFFFFF
        table.append(crc)
    return tuple(table)


_OGG_CRC_TABLE = _crc_table()


@dataclass(frozen=True)
class OpusMetadata:
    version: int
    sample_frequency: int
    channels: int
    frame_duration_ms: int
    frame_size: int
    bit_rate: int
    packet_count: int
    trailing_bytes: int

    @property
    def duration_ms(self) -> int:
        return self.packet_count * self.frame_duration_ms


def ogg_crc(data: bytes) -> int:
    """Ogg's non-reflected CRC-32 (not zlib.crc32)."""
    crc = 0
    for value in data:
        crc = ((crc << 8) & 0xFFFFFFFF) ^ _OGG_CRC_TABLE[(crc >> 24) ^ value]
    return crc


def _page(packet: bytes | None, granule: int, sequence: int, flags: int) -> bytes:
    # A zero terminator is required when the packet length is a multiple of 255.
    # The Android muxer omits that terminator; conforming Ogg avoids joining two
    # fixed-size frames when frame_size happens to be a multiple of 255.
    lacing = b"" if packet is None else bytes([255] * (len(packet) // 255) + [len(packet) % 255])
    if len(lacing) > 255:
        raise ValueError("Opus frame exceeds one Ogg page (65024 bytes)")
    header = struct.pack("<4sBBQIIIB", b"OggS", 0, flags, granule, 0, sequence, 0, len(lacing))
    page = bytearray(header + lacing + (packet or b""))
    struct.pack_into("<I", page, 22, ogg_crc(page))
    return bytes(page)


def opus_to_ogg(raw: bytes) -> tuple[bytes, OpusMetadata]:
    """Convert a complete custom vendor recording, retaining known header rules.

    Version 1 is the vendor's supported Apollo format. Version 2 is explicitly
    unsupported by the Android SDK. Its reserved four-byte header field is not
    interpreted. As the vendor does, ignore a final incomplete fixed-size frame
    and report its byte count so callers can surface that limitation.
    """
    if len(raw) < 16:
        raise ValueError("Recording is shorter than its 16-byte vendor Opus header")
    version, frequency, channels, duration, frame_size, bit_rate = struct.unpack_from("<BIBHHH", raw)
    if version != 1:
        raise ValueError(f"Unsupported vendor recording version {version}; only Apollo version 1 was recovered")
    if channels not in (1, 2):
        raise ValueError(f"Unsupported channel count {channels}; Ogg mapping family 0 permits 1 or 2")
    if duration not in (5, 10, 20, 40, 60, 80, 100, 120):
        raise ValueError(f"Unsupported Opus frame duration {duration} ms")
    if not 1 <= frame_size <= 65024:
        raise ValueError(f"Invalid fixed Opus frame size {frame_size}")
    packets, trailing = divmod(len(raw) - 16, frame_size)
    if not packets:
        raise ValueError("Recording has no complete Opus frames")
    metadata = OpusMetadata(version, frequency, channels, duration, frame_size, bit_rate, packets, trailing)
    # Android deliberately uses 48 kHz for Ogg granules and OpusHead input rate.
    opus_head = struct.pack("<8sBBHIhB", b"OpusHead", 1, channels, 3200, 48000, 0, 0)
    vendor = b"EIOT Opus Encoder"
    opus_tags = b"OpusTags" + struct.pack("<I", len(vendor)) + vendor + struct.pack("<I", 0)
    pages = [_page(opus_head, 0, 0, 2), _page(opus_tags, 0, 1, 0)]
    samples_per_packet = 48000 * duration // 1000
    for index in range(packets):
        start = 16 + index * frame_size
        pages.append(_page(raw[start:start + frame_size], samples_per_packet * (index + 1), index + 2, 0))
    pages.append(_page(None, samples_per_packet * packets, packets + 2, 4))
    return b"".join(pages), metadata
