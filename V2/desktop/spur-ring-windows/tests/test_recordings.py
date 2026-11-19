"""Synthetic source-derived protocol vectors; these do not emulate real BLE."""
from pathlib import Path
import json
import struct
import tempfile
import unittest
from unittest.mock import patch

from spur_ring.ogg import ogg_crc, opus_to_ogg
from spur_ring.recordings import (
    RecordingTransfer, end_ack, packet_ack, parse_end_packet, parse_file_packet,
    parse_storage_summary, request_recording,
)


# A standard three-byte Opus silence packet, wrapped in the recovered vendor
# header: version1, 16 kHz source, mono, 20 ms, frameSize3, bitrate12000.
RAW = bytes.fromhex("01803E00000114000300E02E00000000F8FFFEF8FFFE")
STAMP = 0x6553F100


def file_packet(data: bytes, number: int = 1, total: int = 1, *, timestamp: int = STAMP,
                resend: int = 0, counters: bytes = b"\x00\x10\x03") -> bytes:
    return (b"\xAC\x22" + struct.pack(">BIIIBHB", 1, timestamp, total, number,
                                      int(number == total), len(data), resend)
            + counters + b"\0\0" + data)


def end_packet(*, timestamp: int = STAMP, total: int = 1, checksum: int = 0,
               more: int = 0) -> bytes:
    return b"\xAC\x24" + struct.pack(">BIIQB", 1, timestamp, total, checksum, more)


def pages(blob: bytes) -> list[bytes]:
    result = []
    position = 0
    while position < len(blob):
        assert blob[position:position + 4] == b"OggS"
        segments = blob[position + 26]
        header_end = position + 27 + segments
        page_end = header_end + sum(blob[position + 27:header_end])
        result.append(blob[position:page_end])
        position = page_end
    return result


class ProtocolVectors(unittest.TestCase):
    def test_command_vectors_from_vendor_bytecode(self):
        self.assertEqual(request_recording().hex(), "ac210101ffffffff00000001ffffffff")
        self.assertEqual(request_recording(resume=True, timestamp=STAMP, start_packet=3).hex(),
                         "ac2102016553f10000000003ffffffff")
        self.assertEqual(packet_ack(1, STAMP, 7, False).hex(), "ac23016553f1000000000700")
        self.assertEqual(end_ack(1, STAMP, True).hex(), "ac25016553f10001")

    def test_header_and_storage_vectors(self):
        summary = parse_storage_summary(bytes.fromhex("AA1401000200010203"))
        self.assertEqual((summary.data_type, summary.file_count, summary.total_bytes), (1, 2, 66051))
        packet = parse_file_packet(file_packet(b"abc", 2, 3))
        self.assertEqual((packet.timestamp, packet.total_packets, packet.packet, packet.current_file,
                          packet.total_files, packet.data), (STAMP, 3, 2, 2, 3, b"abc"))
        self.assertEqual(parse_end_packet(end_packet(checksum=0xFFFFFFFFFFFFFFFF)).checksum, 0)
        self.assertEqual(parse_file_packet(file_packet(b"abc", counters=b"\xFF" * 3)).current_file, 0)

    def test_truncated_and_invalid_packets_fail(self):
        for blob in (b"", file_packet(b"abc")[:23], file_packet(b"abc")[:-1], file_packet(b"", 1, 1)):
            with self.assertRaises(ValueError):
                parse_file_packet(blob)
        with self.assertRaises(ValueError):
            parse_file_packet(file_packet(b"abc", 0, 1))
        with self.assertRaises(ValueError):
            parse_storage_summary(bytes.fromhex("AA1401"))
        with self.assertRaisesRegex(ValueError, "has-more flag"):
            parse_end_packet(end_packet(more=2))
        with self.assertRaises(ValueError):
            parse_end_packet(end_packet()[:-1])


class OggMuxTests(unittest.TestCase):
    def test_crc_fixed_vector(self):
        self.assertEqual(ogg_crc(b"123456789"), 0x89A1897F)

    def test_vendor_header_and_ogg_crc_granules(self):
        blob, meta = opus_to_ogg(RAW)
        self.assertEqual((meta.sample_frequency, meta.channels, meta.frame_duration_ms,
                          meta.frame_size, meta.packet_count, meta.duration_ms), (16000, 1, 20, 3, 2, 40))
        ogg_pages = pages(blob)
        self.assertEqual(len(ogg_pages), 5)
        self.assertEqual([page[5] for page in ogg_pages], [2, 0, 0, 0, 4])
        self.assertEqual([struct.unpack_from("<Q", page, 6)[0] for page in ogg_pages], [0, 0, 960, 1920, 1920])
        self.assertIn(bytes.fromhex("4F707573486561640101800C80BB0000000000"), ogg_pages[0])
        for index, page in enumerate(ogg_pages):
            self.assertEqual(struct.unpack_from("<I", page, 18)[0], index)
            zero_crc = bytearray(page)
            expected_crc = struct.unpack_from("<I", page, 22)[0]
            zero_crc[22:26] = b"\0" * 4
            self.assertEqual(ogg_crc(zero_crc), expected_crc)

    def test_lacing_exact_multiple_of_255_terminates_packet(self):
        raw = struct.pack("<BIBHHH", 1, 16000, 1, 20, 255, 12000) + b"\0" * 4 + b"x" * 255
        blob, _ = opus_to_ogg(raw)
        page = pages(blob)[2]
        self.assertEqual(page[26:29], b"\x02\xFF\0")

    def test_unknown_format_and_zero_frame_size_rejected(self):
        with self.assertRaisesRegex(ValueError, "version 2"):
            opus_to_ogg(b"\x02" + RAW[1:])
        bad = bytearray(RAW)
        bad[8:10] = b"\0\0"
        with self.assertRaisesRegex(ValueError, "frame size"):
            opus_to_ogg(bytes(bad))
        blob, metadata = opus_to_ogg(RAW + b"x")
        self.assertTrue(blob)
        self.assertEqual(metadata.trailing_bytes, 1)


class TransferTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent)
        self.addCleanup(self.temp.cleanup)
        self.output = Path(self.temp.name)
        self.transfer = RecordingTransfer(self.output)
        self.transfer.start(False)

    def test_complete_persists_before_ack_and_next_file(self):
        self.assertFalse(self.transfer.feed(file_packet(RAW)).commands)
        result = self.transfer.feed(end_packet(more=1))
        self.assertEqual(result.commands, [end_ack(1, STAMP, True), request_recording()])
        self.assertFalse(result.finished)
        saved = result.completed[0]
        self.assertEqual(saved.raw_path.read_bytes(), RAW)
        self.assertTrue(saved.ogg_path.read_bytes().startswith(b"OggS"))
        self.assertEqual(saved.metadata.duration_ms, 40)

    def test_missing_packet_retransmission_waits_for_next_end(self):
        self.transfer.feed(file_packet(RAW[8:], 2, 2))
        first_end = self.transfer.feed(end_packet(total=2))
        self.assertEqual(first_end.commands, [packet_ack(1, STAMP, 1, False)])
        resent = self.transfer.feed(file_packet(RAW[:8], 1, 2, resend=1))
        self.assertEqual(resent.commands, [packet_ack(1, STAMP, 2, True)])
        self.assertFalse(resent.completed)
        final = self.transfer.feed(end_packet(total=2))
        self.assertTrue(final.finished)
        self.assertEqual(final.completed[0].raw_path.read_bytes(), RAW)

    def test_resume_in_memory_and_fresh_reset(self):
        self.transfer.feed(file_packet(RAW[:8], 1, 2))
        self.transfer.stop()
        self.assertEqual(self.transfer.start(), [request_recording(resume=True, timestamp=STAMP, start_packet=2)])
        self.assertEqual(self.transfer.start(False), [request_recording()])
        result = self.transfer.feed(end_packet(total=2))
        self.assertIn("does not match", result.error)
        self.assertEqual(result.commands[0], end_ack(1, STAMP, False))

    def test_nonzero_checksum_preserves_raw_without_success_ack(self):
        strict = RecordingTransfer(self.output, checksum_policy="strict")
        strict.start(False)
        strict.feed(file_packet(RAW))
        result = strict.feed(end_packet(checksum=123))
        self.assertIn("Unsupported nonzero recording checksum", result.error)
        self.assertEqual(result.commands, [])
        self.assertEqual(next(self.output.glob("*.aizo-opus")).read_bytes(), RAW)
        self.assertEqual(list(self.output.glob("*.ogg")), [])
        info = json.loads(next(self.output.glob("*.strict.json")).read_text())
        self.assertEqual(info["checksum"]["validation"], "rejected-unverified")

    def test_ios_nonzero_checksum_policy_persists_evidence_before_ack(self):
        self.transfer.feed(file_packet(RAW))
        result = self.transfer.feed(end_packet(checksum=0x1234))
        self.assertIsNone(result.error)
        self.assertTrue(result.finished)
        self.assertEqual(result.commands, [end_ack(1, STAMP, True)])
        self.assertEqual(len(result.warnings), 1)
        recording = result.completed[0]
        self.assertEqual(recording.raw_path.read_bytes(), RAW)
        self.assertTrue(recording.ogg_path.exists())
        info = json.loads(recording.metadata_path.read_text())
        self.assertEqual(info["checksum"]["value"], "0x0000000000001234")
        self.assertEqual(info["checksum"]["policy"], "ios")
        self.assertFalse(info["checksum"]["whole_file_verified"])
        self.assertEqual(info["audio"]["duration_ms"] if "duration_ms" in info["audio"] else
                         info["audio"]["frame_duration_ms"] * info["audio"]["packet_count"], 40)

    def test_unsupported_container_preserves_raw_without_success_ack(self):
        self.transfer.feed(file_packet(b"\x02" + RAW[1:]))
        result = self.transfer.feed(end_packet())
        self.assertIn("version 2", result.error)
        self.assertEqual(result.commands, [])
        self.assertEqual(len(list(self.output.glob("*.aizo-opus"))), 1)

    def test_disk_failure_never_returns_success_ack(self):
        self.transfer.feed(file_packet(RAW))
        with patch("spur_ring.recordings._atomic_write", side_effect=OSError("disk full")):
            result = self.transfer.feed(end_packet())
        self.assertEqual(result.error, "disk full")
        self.assertEqual(result.commands, [])

    def test_ogg_write_failure_preserves_raw_and_never_acknowledges(self):
        from spur_ring.recordings import _atomic_write
        self.transfer.feed(file_packet(RAW))
        def fail_ogg(path, data):
            if path.suffix == ".ogg":
                raise OSError("OGG disk full")
            _atomic_write(path, data)
        with patch("spur_ring.recordings._atomic_write", side_effect=fail_ogg):
            result = self.transfer.feed(end_packet())
        self.assertEqual(result.error, "OGG disk full")
        self.assertEqual(result.commands, [])
        self.assertEqual(next(self.output.glob("*.aizo-opus")).read_bytes(), RAW)

    def test_bounded_memory_and_conflicting_duplicate(self):
        small = RecordingTransfer(self.output, max_file_bytes=16, max_packets=2)
        small.start()
        self.assertIn("packet limit", small.feed(file_packet(b"x", 1, 3)).error)
        self.assertIn("byte limit", small.feed(file_packet(b"x" * 17)).error)
        self.transfer.feed(file_packet(b"abc"))
        self.assertIsNone(self.transfer.feed(file_packet(b"abc")).error)
        self.assertIn("Conflicting", self.transfer.feed(file_packet(b"xyz")).error)

    def test_empty_transfer_and_inactive_payloads(self):
        result = self.transfer.feed(end_packet(timestamp=0xFFFFFFFF, total=0))
        self.assertTrue(result.finished)
        self.assertEqual(result.commands, [end_ack(1, 0xFFFFFFFF, True)])
        self.assertFalse(self.transfer.feed(file_packet(RAW)).commands)
        self.assertEqual(list(self.output.iterdir()), [])

    def test_session_limits_block_additional_success_ack(self):
        transfer = RecordingTransfer(self.output, max_files_per_sync=1)
        transfer.start(False)
        transfer.feed(file_packet(RAW))
        self.assertTrue(transfer.feed(end_packet(more=1)).completed)
        transfer.feed(file_packet(RAW, timestamp=STAMP + 1))
        result = transfer.feed(end_packet(timestamp=STAMP + 1))
        self.assertIn("session file/byte limit", result.error)
        self.assertEqual(result.commands, [])


if __name__ == "__main__":
    unittest.main()
