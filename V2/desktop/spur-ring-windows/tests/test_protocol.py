"""Protocol vectors include output executed directly from the original SDK JAR."""

from datetime import datetime, timedelta, timezone
import unittest

from spur_ring.protocol import (
    ACK_UUID, RESPONSE_UUID, AuthenticationError, MAX_SEQUENCE, Packet, PacketCodec,
    ProtocolError, binding_confirmation, build_binding_request, crc16,
    encode_packet, expected_password, fragment_packet, make_ack, next_sequence,
    parse_binding_response, validate_binding_response,
)


class FramingTests(unittest.TestCase):
    def test_original_jar_normal_frame_vector(self):
        # GoldenVectors.java invoked the original BtPackage.tEU method.
        self.assertEqual(encode_packet(Packet(b"\x81\x03", 0x1234)).hex(),
                         "000483401234810305c5")

    def test_original_jar_ack_and_crc_vectors(self):
        self.assertEqual(encode_packet(make_ack(Packet(b"x", 0x1234))).hex(),
                         "00038350123400e1f0")
        self.assertEqual(crc16(b"123456789"), 0x29B1)

    def test_all_notification_split_points(self):
        packet = Packet(b"\x70\x70\x01ABCDEF;AE6838A87CE3;0", 17, sender=0,
                        destination=2, ack_required=True)
        wire = encode_packet(packet)
        for split in range(1, len(wire)):
            codec = PacketCodec()
            self.assertEqual(codec.feed(RESPONSE_UUID, wire[:split]), [])
            decoded, = codec.feed(RESPONSE_UUID, wire[split:])
            self.assertEqual(decoded.payload, packet.payload)
            self.assertEqual(decoded.sequence, 17)
            self.assertTrue(decoded.ack_required)
            self.assertTrue(decoded.crc_valid)

    def test_fragmentation_is_contiguous_slicing(self):
        packet = Packet(bytes(range(100)), 7)
        chunks = fragment_packet(packet, 20)
        self.assertTrue(all(len(chunk) <= 20 for chunk in chunks))
        self.assertEqual(b"".join(chunks), encode_packet(packet))
        codec = PacketCodec()
        results = []
        for chunk in chunks:
            results.extend(codec.feed(RESPONSE_UUID, chunk))
        self.assertEqual([item.payload for item in results], [packet.payload])

    def test_coalesced_packets_and_separate_channels(self):
        wire1 = encode_packet(Packet(b"\x81\x03", 1))
        wire2 = encode_packet(make_ack(Packet(b"x", 2)))
        codec = PacketCodec()
        self.assertEqual(codec.feed(RESPONSE_UUID, wire1[:3]), [])
        ack, = codec.feed(ACK_UUID, wire2)
        self.assertTrue(ack.is_ack)
        self.assertEqual(ack.ack_status, 0)
        decoded = codec.feed(RESPONSE_UUID, wire1[3:] + wire1)
        self.assertEqual([item.sequence for item in decoded], [1, 1])

    def test_corrupt_crc_is_never_success_acknowledged(self):
        wire = bytearray(encode_packet(Packet(b"\x81\x03", 8, ack_required=True)))
        wire[-1] ^= 1
        decoded, = PacketCodec().feed(RESPONSE_UUID, wire)
        self.assertFalse(decoded.crc_valid)
        with self.assertRaises(ProtocolError):
            make_ack(decoded)
        self.assertEqual(make_ack(decoded, 1).payload, b"\x01")

    def test_invalid_length_clears_stream(self):
        codec = PacketCodec()
        with self.assertRaises(ProtocolError):
            codec.feed(RESPONSE_UUID, b"\x00\x01")
        packet, = codec.feed(RESPONSE_UUID, encode_packet(Packet(b"x", 1)))
        self.assertEqual(packet.payload, b"x")

    def test_reset_discards_partial_frames(self):
        codec = PacketCodec()
        wire = encode_packet(Packet(b"hello", 3))
        codec.feed(RESPONSE_UUID, wire[:5])
        codec.reset()
        packet, = codec.feed(RESPONSE_UUID, wire)
        self.assertEqual(packet.sequence, 3)

    def test_sequence_vendor_wrap(self):
        self.assertEqual(MAX_SEQUENCE, 0xC7C7)
        self.assertEqual(next_sequence(MAX_SEQUENCE), 0)
        self.assertEqual(next_sequence(0), 1)

    def test_incoming_version_and_endpoint_fields_are_metadata(self):
        # The original parser stores the 4-bit version and sender/destination;
        # it does not require them to equal the desktop's outgoing header.
        for sender, destination, version in ((2, 0, 2), (0, 0, 1), (3, 1, 15)):
            packet = Packet(b"\x70\x70\x01ABC;AE6838A87CE3;0", 91,
                            sender=sender, destination=destination, version=version)
            decoded, = PacketCodec().feed(RESPONSE_UUID, encode_packet(packet))
            self.assertEqual((decoded.sender, decoded.destination, decoded.version),
                             (sender, destination, version))
            self.assertTrue(decoded.crc_valid)
            self.assertEqual(decoded.payload, packet.payload)

    def test_encoding_rejects_out_of_range_values(self):
        for packet in (Packet(b"", 0), Packet(b"x", -1), Packet(b"x", 65536),
                       Packet(b"x", 1, version=16)):
            with self.assertRaises(ValueError):
                encode_packet(packet)
        with self.assertRaises(ValueError):
            fragment_packet(Packet(b"x", 1), 0)


class BindingTests(unittest.TestCase):
    def setUp(self):
        self.request = build_binding_request(
            "0123456789abcdef0123456789abcdef",
            datetime(2026, 11, 12, 15, 44, 9, tzinfo=timezone(timedelta(hours=8))),
        )

    def test_original_jar_challenge_vector(self):
        self.assertEqual(expected_password(bytes([26, 11, 12, 15, 44, 9])), "AE6838A87CE3")
        self.assertEqual(self.request.expected_password, "AE6838A87CE3")

    def test_binding_payload_layout(self):
        self.assertEqual(self.request.payload, (
            b"\x30\x30\x01\x1a\x0b\x0c\x0f\x2c\x09\x20\x00\x00"
            b"0123456789abcdef0123456789abcdef;2.1.2;A1013D00CN1218HE;"
        ))

    def test_negative_timezone_and_other_locale(self):
        request = build_binding_request(
            self.request.app_id, datetime(2026, 11, 12, 1, 2, 3),
            utc_offset_minutes=-330, language="en-US",
        )
        self.assertEqual(request.payload[9:12], bytes([234, 1, 0]))

    def test_challenge_success_requires_match(self):
        response = parse_binding_response(b"\x70\x70\x01AABBCCDDEEFF;ae6838a87ce3;0;")
        validate_binding_response(self.request, response)
        self.assertEqual(binding_confirmation(self.request, response), b"\x70\x71\x01")
        mismatch = parse_binding_response(b"\x70\x70\x01AABBCCDDEEFF;000000000000;0")
        with self.assertRaises(AuthenticationError):
            binding_confirmation(self.request, mismatch)

    def test_vendor_type_four_branch_omits_time_challenge(self):
        # Explicit source branch: SDK checks encodeTime only for device types 0..3.
        response = parse_binding_response(b"\x70\x70\x01AABBCCDDEEFF;;4")
        validate_binding_response(self.request, response)
        self.assertIsNone(binding_confirmation(self.request, response))

    def test_vendor_rejections_remain_rejections(self):
        for status in (0, 2, 3, 4, 5, 255):
            response = parse_binding_response(b"\x70\x70" + bytes([status]))
            self.assertEqual(response.status, status)
            with self.assertRaises(AuthenticationError):
                validate_binding_response(self.request, response)

    def test_malformed_success_never_authenticates(self):
        for payload in (b"", b"\x70\x71\x01", b"\x70\x70\x01", b"\x70\x70\x01MAC;pass;-1",
                        b"\x70\x70\x01MAC;pass;unknown", b"\x70\x70\x01\xff;pass;4",
                        b"\x70\x70\x01;pass;4", b"\x70\x70\x01MAC;pass;9999999999"):
            with self.assertRaises(AuthenticationError):
                parse_binding_response(payload)

    def test_persistent_identity_and_time_required(self):
        with self.assertRaises(ValueError):
            build_binding_request("invalid")
        with self.assertRaises(ValueError):
            build_binding_request(self.request.app_id, datetime(2026, 1, 1))


if __name__ == "__main__":
    unittest.main()
