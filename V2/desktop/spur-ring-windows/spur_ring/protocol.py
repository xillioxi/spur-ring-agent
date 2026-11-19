"""AIZO ring framing and binding, recovered from the bundled Android SDK.

This module performs no Bluetooth, network, pairing, reset, or device writes.
Transport feeds each notification channel independently to ``PacketCodec`` and
writes encoded commands to COMMAND_UUID and protocol acknowledgements to ACK_UUID.
See ../PROTOCOL_AUTH.md for the bytecode evidence and compatibility limits.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import hmac
import re
import struct


SERVICE_UUID = "0000fe02-0000-1000-8000-00805f9b34fb"
ADVERTISED_SERVICE_UUID = "0000df31-0000-1000-8000-00805f9b34fb"
COMMAND_UUID = "00000101-0000-1000-8000-00805f9b34fb"
RESPONSE_UUID = "0000010a-0000-1000-8000-00805f9b34fb"
ACK_UUID = "0000010b-0000-1000-8000-00805f9b34fb"
SECOND_COMMAND_UUID = "00000131-0000-1000-8000-00805f9b34fb"
SECOND_RESPONSE_UUID = "0000013a-0000-1000-8000-00805f9b34fb"
VENDOR_ID = "A1013D00CN1218HE"
VENDOR_APP_ID = "com.aierdream.dreamering"
SDK_VERSION = "2.1.2"
MAX_SEQUENCE = 0xC7C7
MAX_PAYLOAD_SIZE = 0xFFFF - 2


class ProtocolError(ValueError):
    """An invalid wire frame or payload was received."""


class AuthenticationError(ProtocolError):
    """Binding was rejected, malformed, or the ring challenge did not match."""


@dataclass(frozen=True)
class Packet:
    payload: bytes
    sequence: int
    sender: int = 2
    destination: int = 0
    version: int = 3
    payload_type: int = 1
    ack_required: bool = False
    command_type: int = 0
    reserved: int = 0
    crc_valid: bool = True
    channel: str = ""

    @property
    def is_ack(self) -> bool:
        return self.command_type == 2

    @property
    def ack_status(self) -> int | None:
        return self.payload[0] if self.is_ack and self.crc_valid and len(self.payload) == 1 else None


def crc16(data: bytes) -> int:
    """CRC16-CCITT-FALSE (init FFFF); vendor sends high byte first."""
    crc = 0xFFFF
    for value in data:
        crc = ((crc >> 8) | (crc << 8)) & 0xFFFF
        crc ^= value
        crc ^= (crc & 0xFF) >> 4
        crc ^= (crc << 12) & 0xFFFF
        crc ^= ((crc & 0xFF) << 5) & 0xFFFF
    return crc & 0xFFFF


def next_sequence(sequence: int) -> int:
    """Return the next vendor request SN, wrapping after C7C7."""
    if not 0 <= sequence <= MAX_SEQUENCE:
        raise ValueError("sequence is outside the vendor request range")
    return 0 if sequence == MAX_SEQUENCE else sequence + 1


def encode_packet(packet: Packet) -> bytes:
    """Encode one complete frame; fragmentation adds no further headers."""
    for name, value, bits in (
        ("sequence", packet.sequence, 16), ("sender", packet.sender, 2),
        ("destination", packet.destination, 2), ("version", packet.version, 4),
        ("payload_type", packet.payload_type, 2), ("command_type", packet.command_type, 2),
        ("reserved", packet.reserved, 3),
    ):
        if not isinstance(value, int) or not 0 <= value < 1 << bits:
            raise ValueError(f"invalid {name}")
    if not isinstance(packet.payload, bytes) or not 1 <= len(packet.payload) <= MAX_PAYLOAD_SIZE:
        raise ValueError("packet payload must contain 1..65533 bytes")
    flags = (packet.sender << 14 | packet.destination << 12 | packet.version << 8
             | packet.payload_type << 6 | int(packet.ack_required) << 5
             | packet.command_type << 3 | packet.reserved)
    return (struct.pack(">HHH", len(packet.payload) + 2, flags, packet.sequence)
            + packet.payload + struct.pack(">H", crc16(packet.payload)))


def fragment_packet(packet: Packet, max_write_size: int) -> list[bytes]:
    """Slice a complete encoded frame into consecutive ATT value writes."""
    if not isinstance(max_write_size, int) or max_write_size < 1:
        raise ValueError("max_write_size must be a positive integer")
    wire = encode_packet(packet)
    return [wire[offset:offset + max_write_size] for offset in range(0, len(wire), max_write_size)]


class PacketCodec:
    """Reassemble length-delimited frames independently for each GATT channel.

    A bad CRC yields a Packet with ``crc_valid=False`` so transport can return
    ``make_ack(packet, 1)`` without treating the payload as a command. Malformed
    lengths or unsupported headers clear that channel and raise ProtocolError;
    the decoder does not guess a new frame boundary. Reset on disconnect/timeouts.
    """

    def __init__(self, max_payload_size: int = MAX_PAYLOAD_SIZE) -> None:
        if not 1 <= max_payload_size <= MAX_PAYLOAD_SIZE:
            raise ValueError("invalid maximum payload size")
        self.max_payload_size = max_payload_size
        self._buffers: dict[str, bytearray] = {}

    def reset(self, channel: str | None = None) -> None:
        if channel is None:
            self._buffers.clear()
        else:
            self._buffers.pop(str(channel).lower(), None)

    def feed(self, channel: str, data: bytes) -> list[Packet]:
        key = str(channel).lower()
        buffer = self._buffers.setdefault(key, bytearray())
        buffer.extend(data)
        packets: list[Packet] = []
        while len(buffer) >= 2:
            length = int.from_bytes(buffer[:2], "big")
            if not 3 <= length <= self.max_payload_size + 2:
                self.reset(key)
                raise ProtocolError(f"invalid AIZO packet length: {length}")
            total = length + 6
            if len(buffer) < total:
                break
            wire = bytes(buffer[:total])
            del buffer[:total]
            _, flags, sequence = struct.unpack(">HHH", wire[:6])
            packet = Packet(
                payload=wire[6:-2], sequence=sequence,
                sender=(flags >> 14) & 3, destination=(flags >> 12) & 3,
                version=(flags >> 8) & 15, payload_type=(flags >> 6) & 3,
                ack_required=bool(flags & 0x20), command_type=(flags >> 3) & 3,
                reserved=flags & 7,
                crc_valid=crc16(wire[6:-2]) == int.from_bytes(wire[-2:], "big"),
                channel=key,
            )
            # Incoming versions are metadata in the original SDK, rather than
            # a reason to discard a CRC-valid binding reply. Outgoing stays v3.
            if packet.command_type not in (0, 2) or packet.payload_type not in (0, 1):
                self.reset(key)
                raise ProtocolError("unsupported AIZO packet header")
            packets.append(packet)
        return packets


def make_ack(packet: Packet, status: int = 0) -> Packet:
    """Protocol ACK: status 0 success, 1 bad CRC, or 2 request retransmission."""
    if status not in (0, 1, 2):
        raise ValueError("unknown acknowledgement status")
    if status == 0 and not packet.crc_valid:
        raise ProtocolError("cannot acknowledge a corrupt payload as successful")
    return Packet(bytes([status]), packet.sequence, command_type=2)


@dataclass(frozen=True)
class BindingRequest:
    payload: bytes
    time_bytes: bytes
    expected_password: str
    app_id: str
    vendor_id: str = VENDOR_ID


@dataclass(frozen=True)
class BindingResponse:
    status: int
    device_id: str
    password: str
    device_type: int

    @property
    def requires_password_verification(self) -> bool:
        return 0 <= self.device_type < 4


def expected_password(time_bytes: bytes) -> str:
    """Port of AizoComUtil.encodeTime; this is the original challenge transform."""
    if len(time_bytes) != 6:
        raise ValueError("binding time must contain six calendar bytes")
    return bytes((time_bytes[index] + addend) & 0xFF for index, addend in
                 ((1, 163), (2, 92), (0, 30), (5, 159), (3, 109), (4, 183))).hex().upper()


def build_binding_request(
    app_id: str,
    now: datetime | None = None,
    utc_offset_minutes: int | None = None,
    language: str = "ZH",
    rom: int = 0,
) -> BindingRequest:
    """Create the original 30 30 binding request using a persistent client ID.

    ``app_id`` is the vendor Bluetooth client identity (32 hex characters),
    distinct from VENDOR_APP_ID. A new computer identity may be rejected by an
    already-bound ring; this module never unbinds or substitutes another identity.
    Timezone units on the wire are signed quarter-hours. ROM 0 is the vendor's
    generic manufacturer value, appropriate to Windows. Calendar bytes are local.
    """
    if not re.fullmatch(r"[0-9a-fA-F]{32}", app_id):
        raise ValueError("app_id must be a persistent 32-character hexadecimal client identity")
    now = datetime.now().astimezone() if now is None else now
    if utc_offset_minutes is None:
        offset = now.utcoffset()
        if offset is None:
            raise ValueError("a timezone-aware datetime or explicit UTC offset is required")
        utc_offset_minutes = int(offset.total_seconds() / 60)
    if not isinstance(utc_offset_minutes, int) or not -24 * 60 <= utc_offset_minutes <= 24 * 60:
        raise ValueError("UTC offset is out of range")
    if not 0 <= rom <= 4:
        raise ValueError("unsupported manufacturer ROM code")
    time_bytes = bytes((now.year % 100, now.month, now.day, now.hour, now.minute, now.second))
    quarter_hours = int(utc_offset_minutes / 15)
    lang = language.upper().split("-")[0].split("_")[0]
    language_code = 0 if lang in ("ZH", "HK", "TW") else 2 if lang == "RU" else 1
    payload = (b"\x30\x30\x01" + time_bytes
               + bytes((quarter_hours & 0xFF, language_code, rom))
               + app_id.encode("ascii") + f";{SDK_VERSION};{VENDOR_ID};".encode("ascii"))
    return BindingRequest(payload, time_bytes, expected_password(time_bytes), app_id)


def parse_binding_response(payload: bytes) -> BindingResponse:
    """Decode 70 70, status, and UTF-8 ``deviceId;password;deviceType``."""
    if len(payload) < 3 or payload[:2] != b"\x70\x70":
        raise AuthenticationError("expected a 70 70 binding response")
    # Preserve every explicit rejection, even if a rejected device omits details.
    if payload[2] != 1:
        return BindingResponse(payload[2], "", "", -1)
    try:
        fields = payload[3:].decode("utf-8", errors="strict").split(";")
        if len(fields) < 3 or not fields[0] or not re.fullmatch(r"[0-9]+", fields[2]):
            raise ValueError("missing device identity or type")
        device_type = int(fields[2])
        if device_type > 0x7FFFFFFF:
            raise ValueError("device type exceeds the SDK integer range")
        return BindingResponse(1, fields[0], fields[1].upper(), device_type)
    except (UnicodeDecodeError, ValueError) as error:
        raise AuthenticationError("malformed successful binding response") from error


def validate_binding_response(request: BindingRequest, response: BindingResponse) -> None:
    """Require the ring's success status and preserve its device-type auth branch."""
    if response.status != 1:
        raise AuthenticationError(f"ring rejected binding (vendor status {response.status}); no unbind was attempted")
    if not response.device_id or not 0 <= response.device_type <= 0x7FFFFFFF:
        raise AuthenticationError("binding response has no valid device identity/type")
    if response.requires_password_verification and (
        not re.fullmatch(r"[0-9A-Fa-f]{12}", response.password)
        or not hmac.compare_digest(response.password.upper(), request.expected_password)
    ):
        raise AuthenticationError("ring authentication challenge did not match")
    # The vendor explicitly omits 70 71 for device types >= 4. Do not invent a
    # challenge or acknowledgement for that source-defined branch.


def binding_confirmation(request: BindingRequest, response: BindingResponse) -> bytes | None:
    """Return 70 71 01 after a valid type 0..3 challenge, otherwise None.

    A rejection/mismatch raises AuthenticationError. The caller may send
    ``b'\x70\x71\x00'`` to report a challenge mismatch, then must disconnect.
    The mobile SDK awaits no command-specific reply to 70 71.
    """
    validate_binding_response(request, response)
    return b"\x70\x71\x01" if response.requires_password_verification else None
