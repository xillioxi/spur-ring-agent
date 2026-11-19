"""Synthetic BLE integration checks; no Windows radio or physical ring is used.

The fake ring accepts fragmented GATT writes, decodes real wire frames, then
responds with encoded/fragmented notifications. Storage and Ogg output are real.
These checks establish transport orchestration, not firmware compatibility.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
import gc
from pathlib import Path
import struct
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch

from spur_ring.protocol import (
    ACK_UUID, ADVERTISED_SERVICE_UUID, COMMAND_UUID, RESPONSE_UUID,
    SECOND_RESPONSE_UUID, SERVICE_UUID, AuthenticationError, Packet, PacketCodec,
    encode_packet, expected_password,
)
from spur_ring.transport import RingClient


ADDRESS_A = "AA:BB:CC:DD:EE:01"
ADDRESS_B = "AA:BB:CC:DD:EE:02"
STAMP = 0x6553F100
# Vendor header + two standard 20-ms Opus silence packets.
RAW = bytes.fromhex("01803E00000114000300E02E00000000F8FFFEF8FFFE")


@dataclass
class Behavior:
    bad_challenge: bool = False
    auth_status: int = 1
    auto_auth: bool = True
    missing_service: bool = False
    missing_characteristic: str | None = None
    sender: int = 0
    destination: int = 2
    version: int = 3
    ack_required_notifications: bool = False
    binding_command_type: int = 0
    mtu_size: int = 247
    max_write_without_response_size: int = 244
    require_complete_att_frames: bool = False
    auto_touch_reply: bool = True
    touch_status: int = 1


class FakeServices:
    def __init__(self, behavior: Behavior):
        self.behavior = behavior
        self.characteristics = {
            COMMAND_UUID: SimpleNamespace(uuid=COMMAND_UUID, properties=["write-without-response"],
                max_write_without_response_size=behavior.max_write_without_response_size),
            ACK_UUID: SimpleNamespace(uuid=ACK_UUID, properties=["write-without-response"],
                max_write_without_response_size=behavior.max_write_without_response_size),
            RESPONSE_UUID: SimpleNamespace(uuid=RESPONSE_UUID, properties=["notify"]),
            SECOND_RESPONSE_UUID: SimpleNamespace(uuid=SECOND_RESPONSE_UUID, properties=["notify"]),
        }
        self.characteristics.pop(behavior.missing_characteristic, None)

    def get_service(self, uuid):
        return object() if str(uuid).lower() == SERVICE_UUID and not self.behavior.missing_service else None

    def get_characteristic(self, uuid):
        return self.characteristics.get(str(uuid).lower())


class FakeBleClient:
    def __init__(self, owner, device, *, disconnected_callback, **kwargs):
        self.owner = owner
        self.connection_options = kwargs
        self.address = device.address
        self.behavior = owner.behaviors.get(self.address, Behavior())
        self.mtu_size = self.behavior.mtu_size
        self.disconnected_callback = disconnected_callback
        self.services = FakeServices(self.behavior)
        self.is_connected = False
        self.notifications = {}
        self.codec = PacketCodec()
        self.sent: list[tuple[str, Packet]] = []
        self.writes: list[tuple[str, bytes, bool]] = []
        self.sequence = 100
        self.binding_sent = asyncio.Event()
        self.end_ack_files: list[tuple[Path, bytes]] = []
        self.disconnect_count = 0

    async def connect(self):
        self.is_connected = True
        return True

    async def disconnect(self):
        self.disconnect_count += 1
        self.is_connected = False
        # Windows may report disconnect after explicit closure too. Its captured
        # generation must not be allowed to affect a later connection.
        self.disconnected_callback(self)

    async def start_notify(self, characteristic, callback):
        self.notifications[characteristic.uuid] = callback

    def notify(self, payload: bytes, *, ack_required=None, corrupt=False,
               channel=RESPONSE_UUID, command_type=0):
        if ack_required is None:
            ack_required = self.behavior.ack_required_notifications
        wire = bytearray(encode_packet(Packet(
            payload, self.sequence, sender=self.behavior.sender,
            destination=self.behavior.destination, version=self.behavior.version,
            ack_required=ack_required, command_type=command_type,
        )))
        self.sequence += 1
        if corrupt:
            wire[-1] ^= 0x01
        callback = self.notifications[channel]
        # A deliberately awkward fragment length exercises header/payload/CRC
        # reassembly without assuming notification boundaries equal frames.
        for position in range(0, len(wire), 7):
            callback(self.services.get_characteristic(channel), bytearray(wire[position:position + 7]))

    async def write_gatt_char(self, characteristic, data, *, response):
        channel = characteristic.uuid
        self.writes.append((channel, bytes(data), response))
        if self.behavior.require_complete_att_frames and (
            len(data) < 6 or int.from_bytes(data[:2], "big") + 6 != len(data)
        ):
            raise RuntimeError("This ring requires a complete framed command in one ATT write")
        for packet in self.codec.feed(channel, bytes(data)):
            self.sent.append((channel, packet))
            if packet.is_ack:
                continue
            payload = packet.payload
            if payload.startswith(b"\x30\x30"):
                self.binding_sent.set()
                if self.behavior.auto_auth:
                    if self.behavior.auth_status != 1:
                        self.notify(b"\x70\x70" + bytes([self.behavior.auth_status]))
                    else:
                        password = "000000000000" if self.behavior.bad_challenge else expected_password(payload[3:9])
                        self.notify(b"\x70\x70\x01" + self.address.encode("ascii")
                                    + b";" + password.encode("ascii") + b";0;",
                                    command_type=self.behavior.binding_command_type)
            elif payload == b"\xAA\x13\x01":
                self.notify(b"\xAA\x14" + struct.pack(">BHI", 1, 1, len(RAW)))
            elif payload.startswith(b"\x81\x63") and self.behavior.auto_touch_reply:
                self.notify(b"\x81\x64" + bytes([self.behavior.touch_status]))
            elif payload.startswith(b"\xAC\x21"):
                file_header = struct.pack(">BIIIBHB", 1, STAMP, 1, 1, 1, len(RAW), 0)
                self.notify(b"\xAC\x22" + file_header + b"\xFF" * 3 + b"\0\0" + RAW)
                self.notify(b"\xAC\x24" + struct.pack(">BIIQB", 1, STAMP, 1, 0, 0))
            elif payload.startswith(b"\xAC\x25") and payload[-1] == 1:
                # Capture filesystem contents at the precise moment the ring
                # receives success. A later-created file cannot satisfy this.
                folder = self.owner.client.storage.recordings / "".join(
                    value for value in self.address if value.isalnum())
                self.end_ack_files = [(file, file.read_bytes()) for file in folder.glob("*.ogg")]


class TransportTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent)
        self.events: list[dict] = []
        self.behaviors: dict[str, Behavior] = {}
        self.instances: list[FakeBleClient] = []
        self.scanner_calls = []
        self.loop_errors = []
        self.loop = asyncio.get_running_loop()
        self.previous_exception_handler = self.loop.get_exception_handler()
        self.loop.set_exception_handler(lambda loop, context: self.loop_errors.append(context))
        self.client = RingClient(Path(self.temp.name), self.events.append)
        self.advertisements = {}
        self.add_device(ADDRESS_A, "DREAME RING", [ADVERTISED_SERVICE_UUID], -40)
        self.add_device(ADDRESS_B, "Spur Ring", [SERVICE_UUID], -50)

        async def discover(**kwargs):
            self.scanner_calls.append(kwargs)
            return self.advertisements

        def make_client(device, **kwargs):
            instance = FakeBleClient(self, device, **kwargs)
            self.instances.append(instance)
            return instance

        module = ModuleType("bleak")
        module.BleakScanner = SimpleNamespace(discover=discover)
        module.BleakClient = make_client
        self.module_patch = patch.dict(sys.modules, {"bleak": module})
        self.module_patch.start()

    async def asyncTearDown(self):
        await self.client.disconnect()
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        self.module_patch.stop()
        self.loop.set_exception_handler(self.previous_exception_handler)
        self.temp.cleanup()

    def add_device(self, address, name, uuids, rssi):
        self.advertisements[address] = (
            SimpleNamespace(address=address, name=name),
            SimpleNamespace(local_name=name, service_uuids=uuids, rssi=rssi),
        )

    async def connect(self, address=ADDRESS_A):
        await self.client.scan()
        await asyncio.wait_for(self.client.connect(address), timeout=5)
        return self.instances[-1]

    async def wait_until(self, predicate, timeout=3):
        async def poll():
            while not predicate():
                await asyncio.sleep(0.01)
        await asyncio.wait_for(poll(), timeout)

    def statuses(self):
        return [event["status"] for event in self.events if event["type"] == "status"]

    async def test_scan_filters_compatible_advertisements_and_sorts(self):
        self.add_device("01:02:03:04:05:06", "Unrelated headphones", [], -10)
        self.add_device("01:02:03:04:05:07", "Ring", [], -15)
        self.add_device("01:02:03:04:05:08", "Vendor device", [ADVERTISED_SERVICE_UUID.upper()], -60)
        self.add_device("01:02:03:04:05:09", "AIZO RING", [], -70)
        found = await self.client.scan()
        self.assertEqual([item["id"] for item in found], [ADDRESS_A, ADDRESS_B,
                         "01:02:03:04:05:08", "01:02:03:04:05:09"])
        self.assertTrue(all(item["compatible"] for item in found))
        self.assertEqual(self.scanner_calls, [{"timeout": 8, "return_adv": True}])
        self.assertEqual(self.instances, [], "Scanning must not open a BLE connection")

    async def test_macos_uuid_connects_and_syncs_using_negotiated_att_size(self):
        identifier = '243E23AE-4A99-406C-B317-18F1BD7B4CBE'
        self.add_device(identifier, 'AIZO-RING', [SERVICE_UUID], -30)
        self.behaviors[identifier] = Behavior(mtu_size=185,
            max_write_without_response_size=182, require_complete_att_frames=True)
        with patch('spur_ring.transport.platform.system', return_value='Darwin'), \
                patch('spur_ring.transport.platform.mac_ver', return_value=('13.0', ('', '', ''), 'arm64')):
            ring = await self.connect(identifier)
            await self.client.sync()
        self.assertNotIn('winrt', ring.connection_options)
        binding_writes = [data for _, data, _ in ring.writes if data[6:8] == b'\x30\x30']
        self.assertEqual(len(binding_writes), 1)
        self.assertEqual(len(binding_writes[0]), 76)
        self.assertTrue(self.client._authenticated)
        path, = [path for path, _ in ring.end_ack_files]
        self.assertEqual(path.parent.name, identifier.replace('-', ''))

    async def test_macos_12_2_scan_supplies_required_service_filter(self):
        with patch('spur_ring.transport.platform.system', return_value='Darwin'), \
                patch('spur_ring.transport.platform.mac_ver', return_value=('12.2.1', ('', '', ''), 'x86_64')):
            await self.client.scan()
        self.assertEqual(self.scanner_calls[-1], {'timeout': 8, 'return_adv': True,
            'service_uuids': [ADVERTISED_SERVICE_UUID, SERVICE_UUID]})

    async def test_macos_scan_error_explains_system_bluetooth_permissions(self):
        async def denied(**kwargs):
            raise RuntimeError('User denied Bluetooth access')
        module = ModuleType('bleak')
        module.BleakScanner = SimpleNamespace(discover=denied)
        with patch.dict(sys.modules, {'bleak': module}), \
                patch('spur_ring.transport.platform.system', return_value='Darwin'):
            with self.assertRaisesRegex(RuntimeError, 'Privacy & Security → Bluetooth'):
                await self.client.scan()

    async def test_successful_handshake_and_sync_persist_before_end_ack(self):
        ring = await self.connect()
        self.assertTrue(self.client._authenticated)
        self.assertEqual(self.statuses()[-1], "connected")
        commands = [packet.payload for channel, packet in ring.sent if channel == COMMAND_UUID]
        self.assertTrue(commands[0].startswith(b"\x30\x30\x01"))
        self.assertIn(b"\x70\x71\x01", commands)
        self.assertTrue(all(not response for _, _, response in ring.writes))
        await asyncio.wait_for(self.client.sync(), timeout=5)
        self.assertEqual(len(ring.end_ack_files), 1, "Playable output must exist before AC25 success")
        path, captured = ring.end_ack_files[0]
        self.assertTrue(captured.startswith(b"OggS"))
        self.assertIn(b"OpusHead", captured)
        self.assertEqual(path.read_bytes(), captured)
        self.assertEqual(next(path.parent.glob("*.aizo-opus")).read_bytes(), RAW)
        self.assertEqual(len(self.client.list_recordings()), 1)
        self.assertEqual(self.statuses()[-1], "connected")
        self.assertTrue(any(event["type"] == "progress" and event["progress"] == 100 for event in self.events))

    async def test_negotiated_mtu_sends_complete_binding_in_one_att_write(self):
        # Real AIZO firmware rejected the old four 20-byte pieces. The Android
        # baseline negotiates MTU247 and emits this entire 76-byte frame once.
        self.behaviors[ADDRESS_A] = Behavior(require_complete_att_frames=True)
        ring = await self.connect()
        binding_writes = [data for channel, data, _ in ring.writes
                          if channel == COMMAND_UUID and data[6:8] == b"\x30\x30"]
        self.assertEqual(len(binding_writes), 1)
        self.assertEqual(len(binding_writes[0]), 76)
        self.assertEqual(int.from_bytes(binding_writes[0][:2], "big"), 70)
        self.assertEqual(binding_writes[0][6:9], b"\x30\x30\x01")
        self.assertLessEqual(len(binding_writes[0]), ring.mtu_size - 3)
        self.assertTrue(self.client._authenticated)
        await asyncio.wait_for(self.client.sync(), timeout=5)
        self.assertEqual(len(ring.end_ack_files), 1)

    async def test_small_att_write_limit_refuses_partial_binding_before_any_write(self):
        self.behaviors[ADDRESS_A] = Behavior(
            mtu_size=23, max_write_without_response_size=20,
            require_complete_att_frames=True,
        )
        with self.assertRaisesRegex(RuntimeError, "(?i)MTU|ATT|fragment|write.*size|packet"):
            await self.connect()
        ring = self.instances[-1]
        self.assertEqual(ring.writes, [], "Do not transmit an incomplete binding frame")
        self.assertFalse(self.client._authenticated)
        self.assertNotIn("connected", self.statuses())
        self.assertIsNone(self.client._ble)

    async def test_bad_authentication_challenge_never_connects(self):
        self.behaviors[ADDRESS_A] = Behavior(bad_challenge=True)
        with self.assertRaisesRegex(AuthenticationError, "challenge did not match"):
            await self.connect()
        ring = self.instances[-1]
        self.assertFalse(self.client._authenticated)
        self.assertNotIn("connected", self.statuses())
        self.assertIsNone(self.client._ble)
        self.assertFalse(ring.is_connected)
        self.assertNotIn(b"\x70\x71\x01", [packet.payload for _, packet in ring.sent])

    async def test_vendor_rejected_binding_never_connects(self):
        self.behaviors[ADDRESS_A] = Behavior(auth_status=3)
        with self.assertRaisesRegex(AuthenticationError, "vendor status 3"):
            await self.connect()
        self.assertNotIn("connected", self.statuses())
        self.assertFalse(self.client._authenticated)
        self.assertIsNone(self.client._ble)

    async def test_bad_crc_is_nacked_on_ack_characteristic_without_processing(self):
        ring = await self.connect()
        ring.notify(b"\xAA\x11\x01\x02", ack_required=True, corrupt=True)
        await self.wait_until(lambda: any(packet.is_ack and packet.payload == b"\x01"
                                          for _, packet in ring.sent))
        ack_channel, ack = next((channel, packet) for channel, packet in ring.sent if packet.is_ack)
        self.assertEqual(ack_channel, ACK_UUID)
        self.assertEqual(ack.payload, b"\x01")
        self.assertIsNone(self.client._working_state)
        self.assertNotIn(b"\xAA\x12\x01", [packet.payload for _, packet in ring.sent])
        self.assertTrue(self.client._authenticated)

    async def test_optional_ack_characteristic_missing_still_connects_and_syncs(self):
        # The SDK's addGattHelper silently skips a missing 010B and keeps 0101.
        self.behaviors[ADDRESS_A] = Behavior(missing_characteristic=ACK_UUID)
        ring = await self.connect()
        await asyncio.wait_for(self.client.sync(), timeout=5)
        self.assertTrue(self.client._authenticated)
        self.assertEqual(len(ring.end_ack_files), 1)
        self.assertTrue(ring.end_ack_files[0][1].startswith(b"OggS"))
        self.assertTrue(all(channel == COMMAND_UUID for channel, _ in ring.sent))
        self.assertTrue(all(not packet.is_ack for _, packet in ring.sent))

    async def test_ack_required_traffic_without_optional_ack_is_still_dispatched(self):
        # Vendor writeAck returns null when 010B is absent; CRC-valid application
        # payloads still dispatch. Do not invent a low-level ACK on command0101.
        self.behaviors[ADDRESS_A] = Behavior(
            missing_characteristic=ACK_UUID, ack_required_notifications=True)
        ring = await self.connect()
        ring.notify(b"\xAA\x11\x01\x04")
        await self.wait_until(lambda: self.client._working_state == 4)
        await self.wait_until(lambda: any(packet.payload == b"\xAA\x12\x01"
                                          for _, packet in ring.sent))
        await asyncio.wait_for(self.client.sync(), timeout=5)
        self.assertEqual(len(ring.end_ack_files), 1)
        self.assertTrue(self.client._authenticated)
        self.assertTrue(all(channel == COMMAND_UUID for channel, _ in ring.sent))
        self.assertTrue(all(not packet.is_ack for _, packet in ring.sent))

    async def test_corrupt_frame_without_optional_ack_is_still_discarded(self):
        self.behaviors[ADDRESS_A] = Behavior(missing_characteristic=ACK_UUID)
        ring = await self.connect()
        ring.notify(b"\xAA\x11\x01\x02", ack_required=True, corrupt=True)
        await self.wait_until(lambda: any(event["type"] == "log"
            and "Discarded a corrupt Bluetooth frame" in event.get("message", "")
            for event in self.events))
        self.assertIsNone(self.client._working_state)
        self.assertNotIn(b"\xAA\x12\x01", [packet.payload for _, packet in ring.sent])
        self.assertTrue(all(not packet.is_ack for _, packet in ring.sent))
        self.assertTrue(self.client._authenticated)

    async def test_incoming_alternate_endpoint_metadata_and_version_two_authenticate(self):
        # BtPackage stores these fields; deviceSendHexData does not gate command
        # delivery on a guessed direction or equality with outgoing version3.
        self.behaviors[ADDRESS_A] = Behavior(sender=2, destination=0, version=2)
        ring = await self.connect()
        await asyncio.wait_for(self.client.sync(), timeout=5)
        self.assertTrue(self.client._authenticated)
        self.assertEqual(len(ring.end_ack_files), 1)
        self.assertTrue(all(packet.version == 3 for _, packet in ring.sent),
                        "Outgoing commands retain the SDK's configured version3")

    async def test_unsolicited_ack_ff_does_not_authenticate_or_abort_binding(self):
        # This models the physical ring's v1 single-byte type2 FF observation.
        # Its meaning is undocumented; it must not replace the 7070 challenge.
        self.behaviors[ADDRESS_A] = Behavior(auto_auth=False, version=1)
        await self.client.scan()
        task = asyncio.create_task(self.client.connect(ADDRESS_A))
        try:
            await self.wait_until(lambda: bool(self.instances) and self.instances[-1].binding_sent.is_set())
            ring = self.instances[-1]
            ring.notify(b"\xFF", command_type=2)
            await self.wait_until(lambda: any(event["type"] == "log"
                and "transport ACK 0xFF" in event.get("message", "")
                for event in self.events))
            self.assertFalse(task.done(), "An unsolicited ACK must leave binding pending")
            self.assertFalse(self.client._authenticated)
            self.assertNotIn("connected", self.statuses())
            self.assertNotIn(b"\x70\x71\x01", [packet.payload for _, packet in ring.sent])
            password = self.client._binding.expected_password.encode("ascii")
            ring.notify(b"\x70\x70\x01" + ADDRESS_A.encode("ascii") + b";" + password + b";0;")
            await asyncio.wait_for(task, timeout=3)
            self.assertTrue(self.client._authenticated)
            self.assertIn(b"\x70\x71\x01", [packet.payload for _, packet in ring.sent])
        finally:
            if not task.done():
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
            elif not task.cancelled():
                task.exception()

    async def test_type_two_frame_with_full_binding_reply_still_validates_challenge(self):
        # The original BtPackage entity does not retain commandType after parsing
        # 0/2; a full two-byte application opcode still dispatches normally.
        self.behaviors[ADDRESS_A] = Behavior(binding_command_type=2, version=1)
        ring = await self.connect()
        self.assertTrue(self.client._authenticated)
        self.assertEqual(self.statuses()[-1], "connected")
        self.assertIn(b"\x70\x71\x01", [packet.payload for _, packet in ring.sent])

    async def test_setup_failure_closes_ble_and_consumes_future_exception(self):
        self.behaviors[ADDRESS_A] = Behavior(missing_service=True)
        with self.assertRaisesRegex(RuntimeError, "expected AIZO FE02 service"):
            await self.connect()
        self.assertIsNone(self.client._ble)
        self.assertIsNone(self.client._queue)
        self.assertFalse(self.instances[-1].is_connected)
        self.assertEqual(self.instances[-1].sent, [])
        gc.collect()
        await asyncio.sleep(0)
        self.assertFalse(self.loop_errors, "Setup errors must not leave an unobserved auth future")

    async def test_cancelled_authentication_cleans_up(self):
        self.behaviors[ADDRESS_A] = Behavior(auto_auth=False)
        await self.client.scan()
        task = asyncio.create_task(self.client.connect(ADDRESS_A))
        await self.wait_until(lambda: bool(self.instances) and self.instances[-1].binding_sent.is_set())
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertIsNone(self.client._ble)
        self.assertIsNone(self.client._reader)
        self.assertIsNone(self.client._queue)
        self.assertFalse(self.instances[-1].is_connected)
        self.assertFalse(self.client._authenticated)

    async def test_authentication_timeout_is_explained_and_cleans_up(self):
        self.behaviors[ADDRESS_A] = Behavior(auto_auth=False)
        with patch('spur_ring.transport.AUTHENTICATION_TIMEOUT', 0.05):
            with self.assertRaisesRegex(RuntimeError, 'did not complete authentication'):
                await self.connect()
        self.assertIsNone(self.client._ble)
        self.assertIsNone(self.client._reader)
        self.assertFalse(self.client._authenticated)

    async def test_late_old_disconnect_callback_cannot_close_new_session(self):
        old_ring = await self.connect()
        await self.client.disconnect()
        new_ring = await self.connect(ADDRESS_B)
        old_ring.disconnected_callback(old_ring)
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        self.assertIs(self.client._ble, new_ring)
        self.assertTrue(new_ring.is_connected)
        self.assertTrue(self.client._authenticated)
        self.assertEqual(self.statuses()[-1], "connected")

    async def test_ring_controls_never_arm_or_emit_capture_on_connect(self):
        ring = await self.connect()
        ring.notify(bytes.fromhex('81611A0B0C0F2C090103'))
        ring.notify(bytes.fromhex('AA110102000A'))
        await self.wait_until(lambda: any(event['type'] == 'ring-state' for event in self.events))
        self.assertFalse(self.client._dictation_armed)
        self.assertFalse(any(event['type'] == 'dictation-trigger' for event in self.events))
        self.assertNotIn(b'\x81\x63\x01', [packet.payload for _, packet in ring.sent])
        self.assertIn(b'\x81\x62\x01', [packet.payload for _, packet in ring.sent])
        state = next(event for event in self.events if event['type'] == 'ring-state')
        self.assertEqual((state['state'], state['name'], state['remaining_time']), (2, 'recording', 10))

    async def test_armed_touch_and_state_controls_emit_start_stop_then_disarm(self):
        ring = await self.connect()
        await self.client.arm_dictation()
        self.assertTrue(self.client._dictation_armed)
        self.assertIn(b'\x81\x63\x01', [packet.payload for _, packet in ring.sent])
        ring.notify(bytes.fromhex('81611A0B0C0F2C0901031A0B0C0F2C0A0106'))
        ring.notify(bytes.fromhex('AA110102'))
        ring.notify(bytes.fromhex('AA110104'))
        await self.wait_until(lambda: len([e for e in self.events if e['type'] == 'dictation-trigger']) == 4)
        triggers = [(e['action'], e['source']) for e in self.events if e['type'] == 'dictation-trigger']
        self.assertEqual(triggers, [('start', 'touch'), ('stop', 'touch'), ('start', 'state'), ('stop', 'state')])
        await self.client.disarm_dictation()
        self.assertFalse(self.client._dictation_armed)
        self.assertIn(b'\x81\x63\x00', [packet.payload for _, packet in ring.sent])
        ring.notify(bytes.fromhex('81611A0B0C0F2C090103'))
        await asyncio.sleep(0.2)
        self.assertEqual(len([e for e in self.events if e['type'] == 'dictation-trigger']), 4)
        self.assertFalse(any(e['type'] == 'audio' for e in self.events), 'Ring controls must not manufacture microphone audio')

    async def test_touch_rejection_and_timeout_do_not_arm(self):
        ring = await self.connect()
        ring.behavior.touch_status = 2
        with self.assertRaisesRegex(RuntimeError, 'rejected touch reporting'):
            await self.client.arm_dictation()
        self.assertFalse(self.client._dictation_armed)
        ring.behavior.auto_touch_reply = False
        with patch('spur_ring.transport.TOUCH_REPORT_TIMEOUT', 0.02):
            with self.assertRaisesRegex(RuntimeError, 'did not confirm touch reporting'):
                await self.client.arm_dictation()
        self.assertFalse(self.client._dictation_armed)
        self.assertIsNone(self.client._touch_future)
        self.assertTrue(self.client._authenticated)

    async def test_disarm_requested_during_enable_never_emits_late_armed_state(self):
        ring = await self.connect()
        ring.behavior.auto_touch_reply = False
        arm = asyncio.create_task(self.client.arm_dictation())
        await self.wait_until(lambda: b'\x81\x63\x01' in [p.payload for _, p in ring.sent])
        disarm = asyncio.create_task(self.client.disarm_dictation())
        await self.wait_until(lambda: any(e['type'] == 'dictation-state' and not e['armed'] for e in self.events))
        # The late enable acknowledgment must not reverse the newer user intent.
        ring.notify(b'\x81\x64\x01')
        await asyncio.wait_for(arm, 2)
        await self.wait_until(lambda: b'\x81\x63\x00' in [p.payload for _, p in ring.sent])
        ring.notify(b'\x81\x64\x01')
        await asyncio.wait_for(disarm, 2)
        self.assertFalse(self.client._dictation_armed)
        self.assertFalse(self.client._touch_reporting_requested)
        self.assertFalse(any(e['type'] == 'dictation-state' and e['armed'] for e in self.events))

    async def test_incomplete_or_corrupt_touch_does_not_trigger(self):
        ring = await self.connect()
        await self.client.arm_dictation()
        ring.notify(bytes.fromhex('81611A0B0C0F2C09010300'))
        await self.wait_until(lambda: b'\x81\x62\x02' in [p.payload for _, p in ring.sent])
        ring.notify(bytes.fromhex('81611A0B0C0F2C090103'), corrupt=True)
        await self.wait_until(lambda: any('corrupt Bluetooth frame' in e.get('message', '') for e in self.events))
        self.assertFalse(any(e['type'] == 'dictation-trigger' for e in self.events))
        self.assertTrue(self.client._authenticated)

    async def test_disconnect_disables_only_previously_requested_touch_reporting(self):
        ring = await self.connect()
        await self.client.arm_dictation()
        await self.client.disconnect()
        self.assertIn(b'\x81\x63\x00', [packet.payload for _, packet in ring.sent])
        self.assertFalse(self.client._dictation_armed)
        self.assertFalse(self.client._touch_reporting_requested)
        await self.connect(ADDRESS_B)
        self.assertFalse(self.client._dictation_armed)
        self.assertFalse(self.client._touch_reporting_requested)

    async def test_two_rings_with_same_recording_timestamp_have_separate_folders(self):
        first = await self.connect()
        await asyncio.wait_for(self.client.sync(), timeout=5)
        await self.client.disconnect()
        second = await self.connect(ADDRESS_B)
        await asyncio.wait_for(self.client.sync(), timeout=5)
        path_a, = [path for path, _ in first.end_ack_files]
        path_b, = [path for path, _ in second.end_ack_files]
        self.assertEqual(path_a.name, path_b.name)
        self.assertNotEqual(path_a.parent, path_b.parent)
        self.assertEqual(path_a.parent.name, ADDRESS_A.replace(":", ""))
        self.assertEqual(path_b.parent.name, ADDRESS_B.replace(":", ""))
        self.assertEqual(len(self.client.list_recordings()), 2)


if __name__ == "__main__":
    unittest.main()
