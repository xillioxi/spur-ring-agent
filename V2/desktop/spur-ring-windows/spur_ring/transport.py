"""Bleak Bluetooth transport for Windows and macOS.

Protocol work is derived from the embedded Android SDK. Each host platform
needs its own real-device acceptance run; diagnostics never scan or connect.
"""
from __future__ import annotations

import asyncio
from contextlib import suppress
from datetime import datetime
import importlib.metadata
from pathlib import Path
import platform
from typing import Callable

from . import __version__
from .live_audio import STATE_NAMES, dictation_capability, parse_touch_events
from .protocol import (
    ACK_UUID, ADVERTISED_SERVICE_UUID, COMMAND_UUID, RESPONSE_UUID, SERVICE_UUID,
    Packet, PacketCodec, binding_confirmation, build_binding_request,
    encode_packet, make_ack, next_sequence, parse_binding_response,
    validate_binding_response,
)
from .recordings import RecordingTransfer
from .storage import DesktopStorage

SECOND_RESPONSE_UUID = '0000013a-0000-1000-8000-00805f9b34fb'
AUTHENTICATION_TIMEOUT = 60
TOUCH_REPORT_TIMEOUT = 8


async def diagnose() -> dict:
    """Inspect host support without scanning, connecting, or requesting consent."""
    system = platform.system()
    result = {'app_version': __version__, 'platform': platform.platform(),
              'architecture': platform.machine(), 'hardware_validated': False,
              'backend': {'Windows': 'Windows WinRT via Bleak',
                          'Darwin': 'macOS CoreBluetooth via Bleak'}.get(system, 'unsupported'),
              'radios': []}
    try:
        result['bleak_version'] = importlib.metadata.version('bleak')
        if system == 'Darwin':
            # Query the class authorization property only. Creating a central
            # manager here would request permission before the user chose Scan.
            from CoreBluetooth import CBManager
            authorization = int(CBManager.authorization())
            result['bluetooth_authorization'] = {
                0: 'not-determined', 1: 'restricted', 2: 'denied', 3: 'allowed',
            }.get(authorization, 'unknown')
            result['radio_state'] = 'not-checked'
            result['message'] = 'Bluetooth power and availability are checked when you scan for a ring.'
            if authorization in (1, 2):
                result['error'] = 'Bluetooth access is restricted or denied. Allow Spur Ring in System Settings → Privacy & Security → Bluetooth.'
            elif authorization == 0:
                result['message'] = 'Choose Scan to request Bluetooth access. The app must include NSBluetoothAlwaysUsageDescription.'
            return result
        if system != 'Windows':
            result['error'] = 'This desktop build supports Windows and macOS.'
            return result
        from winrt.windows.devices.radios import Radio, RadioKind
        radios = await asyncio.wait_for(Radio.get_radios_async(), timeout=6)
        result['radios'] = [{'name': radio.name, 'kind': str(radio.kind),
                             'state': str(radio.state)} for radio in radios
                            if radio.kind == RadioKind.BLUETOOTH]
        if not result['radios']:
            result['error'] = 'No Bluetooth radio was reported by Windows.'
    except Exception as error:
        result['error'] = f'{type(error).__name__}: {error}' or 'Bluetooth query failed.'
    return result


def _scan_options() -> dict:
    """CoreBluetooth on macOS 12.0–12.2 requires an advertised-service filter."""
    if platform.system() == 'Darwin' and platform.mac_ver()[0].split('.')[:2] in (
            ['12', '0'], ['12', '1'], ['12', '2']):
        return {'service_uuids': [ADVERTISED_SERVICE_UUID, SERVICE_UUID]}
    return {}


async def test_connection(address: str, data_dir: Path) -> dict:
    """Explicit diagnostic: authenticate and read counts, without downloading."""
    from bleak import BleakScanner
    report = {'app_version': __version__, 'authenticated': False, 'events': []}
    client = RingClient(data_dir, report['events'].append)
    try:
        device = await BleakScanner.find_device_by_address(address, timeout=25, **_scan_options())
        if device is None:
            raise RuntimeError('The selected ring was not advertising during the scan.')
        client._devices[device.address] = device
        await client.connect(device.address)
        report['authenticated'] = client._authenticated
        report['mtu'] = client._ble.mtu_size
        client._summary_future = asyncio.get_running_loop().create_future()
        await client._send(bytes.fromhex('AA1301'))
        report['recording_summary'] = await asyncio.wait_for(client._summary_future, 10)
        client._summary_future = None
    except Exception as error:
        report['error'] = f'{type(error).__name__}: {error}'
    finally:
        await client.disconnect()
    return report


class RingClient:
    def __init__(self, data_dir: Path, on_event: Callable[[dict], None]):
        self.storage = DesktopStorage(data_dir)
        self.on_event = on_event
        self._ble = None
        self._devices = {}
        self._codec = PacketCodec()
        self._sequence = 0
        self._generation = 0
        self._authenticated = False
        self._working_state: int | None = None
        self._binding = None
        self._auth_future = None
        self._sync_future = None
        self._summary_future = None
        self._transfer = None
        self._reader = None
        self._queue = None
        self._write_lock = asyncio.Lock()
        self._lifecycle_lock = asyncio.Lock()
        self._status = 'disconnected'
        self._last_sync_activity = 0.0
        self._missing_ack_logged = False
        self._dictation_armed = False
        self._dictation_intent = 0
        self._touch_reporting_requested = False
        self._touch_future = None

    def _emit(self, event_type: str, **values):
        self.on_event({'type': event_type, **values})

    def _log(self, message: str):
        self._emit('log', message=message)

    def _state(self, status: str, message: str = ''):
        self._status = status
        self._emit('status', status=status, message=message)

    def list_recordings(self):
        return self.storage.list_recordings()

    def live_audio_capability(self) -> dict:
        """Describe AIZO controls separately from the source of live audio."""
        return dictation_capability()

    async def arm_dictation(self):
        """Explicitly enable ring controls; does not capture microphone audio."""
        self._dictation_intent += 1
        intent = self._dictation_intent
        async with self._lifecycle_lock:
            if intent != self._dictation_intent:
                return
            if not self._authenticated or self._ble is None or not self._ble.is_connected:
                raise RuntimeError('Connect and authenticate the ring before arming dictation.')
            if self._dictation_armed:
                return
            await self._set_touch_reporting(True)
            if intent != self._dictation_intent:
                return
            self._dictation_armed = True
            self._emit('dictation-state', armed=True)

    async def disarm_dictation(self):
        """Stop emitting capture triggers, then disable ring touch reporting."""
        self._dictation_intent += 1
        self._dictation_armed = False
        self._emit('dictation-state', armed=False)
        async with self._lifecycle_lock:
            self._dictation_armed = False
            if (self._touch_reporting_requested and self._authenticated and
                    self._ble is not None and self._ble.is_connected):
                await self._set_touch_reporting(False)

    async def _set_touch_reporting(self, enabled: bool):
        future = asyncio.get_running_loop().create_future()
        self._touch_future = future
        # If the reply is lost, disconnect still attempts the disable command.
        if enabled:
            self._touch_reporting_requested = True
        try:
            await self._send(b'\x81\x63' + bytes([enabled]))
            await asyncio.wait_for(future, timeout=TOUCH_REPORT_TIMEOUT)
            self._touch_reporting_requested = enabled
        except asyncio.TimeoutError as error:
            raise RuntimeError('The ring did not confirm touch reporting (8164). This firmware may not support ring dictation controls; retry or use the computer microphone button.') from error
        finally:
            if future.done() and not future.cancelled():
                future.exception()
            elif not future.done():
                future.cancel()
            self._touch_future = None

    async def scan(self) -> list[dict]:
        from bleak import BleakScanner
        if self._ble is not None:
            raise RuntimeError('Disconnect the ring before scanning again.')
        self._log('Scanning nearby Bluetooth advertisements for 8 seconds…')
        try:
            results = await asyncio.wait_for(
                BleakScanner.discover(timeout=8, return_adv=True, **_scan_options()), timeout=15)
        except Exception as error:
            guidance = ('Allow Spur Ring in System Settings → Privacy & Security → Bluetooth, and check Bluetooth is enabled.'
                        if platform.system() == 'Darwin' else
                        'Check Bluetooth is enabled and a BLE adapter is available.')
            raise RuntimeError(f'Bluetooth scan failed: {error}. {guidance}') from error
        found = []
        self._devices.clear()
        for device, advertisement in results.values():
            name = advertisement.local_name or device.name or 'Unnamed Bluetooth device'
            services = {value.lower() for value in advertisement.service_uuids}
            compatible = (ADVERTISED_SERVICE_UUID.lower() in services or
                          SERVICE_UUID.lower() in services or
                          ('RING' in name.upper() and any(word in name.upper() for word in ('AIZO', 'DREAME', 'SPUR'))))
            if not compatible:
                continue
            self._devices[device.address] = device
            found.append({'id': device.address, 'name': name,
                          'rssi': advertisement.rssi, 'compatible': True})
        found.sort(key=lambda item: item['rssi'], reverse=True)
        self._log(f'Found {len(found)} possible Spur/AIZO ring(s).')
        return found

    async def connect(self, address: str):
        async with self._lifecycle_lock:
            await self._connect(address)

    async def _connect(self, address: str):
        from bleak import BleakClient
        if self._ble is not None:
            raise RuntimeError('A connection is already open or in progress.')
        device = self._devices.get(address)
        if device is None:
            raise RuntimeError('Scan and select a compatible ring first.')
        self._generation += 1
        generation = self._generation
        self._codec.reset()
        self._working_state = None
        self._authenticated = False
        self._binding = None
        self._missing_ack_logged = False
        loop = asyncio.get_running_loop()
        self._queue = asyncio.Queue(maxsize=2048)
        self._auth_future = loop.create_future()
        backend_options = {'winrt': {'use_cached_services': False}} if platform.system() == 'Windows' else {}
        client = BleakClient(device, disconnected_callback=lambda closed: loop.call_soon_threadsafe(
            self._connection_lost, generation), timeout=20, **backend_options)
        self._ble = client
        self._state('connecting', 'Opening the ring’s Bluetooth service…')
        try:
            await asyncio.wait_for(client.connect(), timeout=25)
            service = client.services.get_service(SERVICE_UUID)
            if service is None:
                raise RuntimeError('This device does not expose the expected AIZO FE02 service.')
            # The original SDK's addGattHelper silently skips an absent 010B.
            # Some AIZO firmware exposes only the command/notification pair.
            for required in (COMMAND_UUID, RESPONSE_UUID):
                if client.services.get_characteristic(required) is None:
                    raise RuntimeError(f'Required AIZO characteristic is missing: {required}')
            self._reader = asyncio.create_task(self._read_notifications(generation))
            for channel in (RESPONSE_UUID, SECOND_RESPONSE_UUID):
                characteristic = client.services.get_characteristic(channel)
                if characteristic is None:
                    continue
                if not any(flag in characteristic.properties for flag in ('notify', 'indicate')):
                    raise RuntimeError(f'Response characteristic is not notifiable: {channel}')
                await asyncio.wait_for(client.start_notify(characteristic,
                    lambda sender, data, channel=channel: self._enqueue(loop, generation, channel, data)), timeout=10)
            self._state('authenticating', 'Authenticating with the ring…')
            # Match the original SDK's GATT-settle delay and auth timeout.
            await asyncio.sleep(0.5)
            now = datetime.now().astimezone()
            self._binding = build_binding_request(self.storage.app_id, now,
                int(now.utcoffset().total_seconds() // 60))
            await self._send(self._binding.payload)
            await asyncio.wait_for(self._auth_future, timeout=AUTHENTICATION_TIMEOUT)
            if generation != self._generation:
                raise RuntimeError('Connection was cancelled.')
            self._authenticated = True
            self._state('connected', 'Ring authentication succeeded. Ready to sync.')
            self._log('Authenticated directly over Bluetooth. No phone or cloud connection is used.')
        except asyncio.TimeoutError as error:
            phase = self._status
            await self._disconnect()
            if phase == 'authenticating':
                raise RuntimeError('The ring did not complete authentication. Keep it awake and near the PC, and make sure its mobile connection is closed.') from error
            raise RuntimeError('The Bluetooth connection timed out. Keep the ring awake and near the PC, then try again.') from error
        except BaseException:
            await self._disconnect()
            raise
        finally:
            if self._auth_future is not None and self._auth_future.done() and not self._auth_future.cancelled():
                self._auth_future.exception()
            self._auth_future = None

    def _enqueue(self, loop, generation, channel, data):
        def enqueue():
            if generation != self._generation or self._queue is None:
                return
            try:
                self._queue.put_nowait((channel, bytes(data)))
            except asyncio.QueueFull:
                self._abort(RuntimeError('Bluetooth receive queue overflowed; sync was stopped.'))
                asyncio.create_task(self._disconnect_generation(generation))
        loop.call_soon_threadsafe(enqueue)

    def _connection_lost(self, generation):
        if generation != self._generation:
            return
        self._authenticated = False
        self._dictation_intent += 1
        self._dictation_armed = False
        self._emit('dictation-state', armed=False)
        self._abort(RuntimeError('The ring disconnected. Saved recordings are retained.'))
        self._state('disconnected', 'The ring disconnected.')
        # Clear this connection before permitting another explicit Connect action.
        asyncio.create_task(self._disconnect_generation(generation))

    def _abort(self, error: Exception):
        for future in (self._auth_future, self._summary_future, self._sync_future, self._touch_future):
            if future is not None and not future.done():
                future.set_exception(error)

    async def _read_notifications(self, generation):
        try:
            while generation == self._generation:
                channel, data = await self._queue.get()
                packets = self._codec.feed(channel, data)
                for packet in packets:
                    if not packet.crc_valid:
                        if packet.ack_required:
                            await self._write_packet(make_ack(packet, 1), ACK_UUID)
                        self._log('Discarded a corrupt Bluetooth frame; waiting for retransmission.')
                        continue
                    # The vendor retains sender/destination/version as metadata;
                    # it dispatches hex responses regardless of those fields.
                    if packet.payload_type != 1:
                        self._log('Ignored a non-hex protocol message.')
                        continue
                    if packet.command_type == 2 and len(packet.payload) == 1:
                        # The manufacturer decoder does not interpret this byte
                        # as an authentication result. This firmware sends FF;
                        # keep waiting for the validated 70 70 binding reply.
                        self._log(f'Ring transport ACK 0x{packet.payload[0]:02X} (sequence {packet.sequence}, protocol {packet.version}).')
                        continue
                    if packet.ack_required:
                        await self._write_packet(make_ack(packet), ACK_UUID)
                    await self._handle_payload(packet.payload)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            if generation != self._generation:
                return
            self._log(f'Protocol receive failed: {error}')
            self._emit('error', message=str(error))
            self._abort(error)
            # Framing errors must not leave the UI claiming a usable connection.
            asyncio.create_task(self._disconnect_generation(generation))

    async def _handle_payload(self, payload: bytes):
        if payload.startswith(b'\x70\x70'):
            if self._binding is None or self._auth_future is None or self._auth_future.done():
                return
            response = parse_binding_response(payload)
            validate_binding_response(self._binding, response)
            confirmation = binding_confirmation(self._binding, response)
            if confirmation is not None:
                await self._send(confirmation)
            self._auth_future.set_result(None)
            return
        if payload.startswith(b'\x81\x64'):
            if self._touch_future is not None and not self._touch_future.done():
                if len(payload) >= 3 and payload[2] == 1:
                    self._touch_future.set_result(None)
                else:
                    self._touch_future.set_exception(RuntimeError('The ring rejected touch reporting (8164).'))
            return
        if payload.startswith(b'\x81\x61'):
            try:
                events = parse_touch_events(payload)
            except ValueError:
                await self._send(b'\x81\x62\x02')
                self._log('Ignored an incomplete ring touch-event notification.')
                return
            await self._send(b'\x81\x62\x01')
            if self._authenticated:
                for event in events:
                    self._emit('ring-touch', event=event.event, action=event.action,
                               time_bytes=event.time_bytes.hex())
                    if self._dictation_armed and event.dictation_action:
                        self._emit('dictation-trigger', action=event.dictation_action, source='touch')
            return
        if payload.startswith(b'\xaa\x11'):
            if len(payload) < 4:
                await self._send(b'\xaa\x12\x00')
                return
            await self._send(b'\xaa\x12\x01')
            if payload[2] == 1:
                self._working_state = payload[3]
                name = STATE_NAMES.get(payload[3], f'unknown ({payload[3]})')
                self._log('Ring state: ' + name)
                if self._authenticated:
                    self._emit('ring-state', state=payload[3], name=name,
                               remaining_time=int.from_bytes(payload[4:6], 'big') if len(payload) >= 6 else None)
                    if self._dictation_armed and payload[3] in (2, 4):
                        self._emit('dictation-trigger', action='start' if payload[3] == 2 else 'stop', source='state')
                if payload[3] in (2, 3) and self._sync_future is not None:
                    self._abort(RuntimeError('The ring is recording or paused; stop recording before syncing.'))
            return
        if payload.startswith(b'\xaa\x14'):
            if self._summary_future is not None and not self._summary_future.done():
                if len(payload) < 9 or payload[2] != 1:
                    self._summary_future.set_exception(RuntimeError('Invalid ring recording-storage response.'))
                else:
                    self._summary_future.set_result({'count': int.from_bytes(payload[3:5], 'big'),
                                                     'bytes': int.from_bytes(payload[5:9], 'big')})
            return
        if payload[:2] in (b'\xac\x22', b'\xac\x24'):
            if self._sync_future is None or self._sync_future.done() or self._transfer is None:
                return
            generation, transfer, future = self._generation, self._transfer, self._sync_future
            # The transfer layer persists bytes before emitting a successful end ACK.
            update = await asyncio.to_thread(transfer.feed, payload)
            if generation != self._generation or future is not self._sync_future or future.done():
                return
            if update.error:
                raise RuntimeError(update.error)
            for warning in update.warnings:
                self._log(warning)
            self._last_sync_activity = asyncio.get_running_loop().time()
            for command in update.commands:
                await self._send(command)
            if update.progress:
                self._emit('progress', progress=update.progress.percent)
            for file in update.completed:
                if file.ogg_path is not None:
                    self._emit('recording', file={'name': file.ogg_path.name,
                        'path': str(file.ogg_path), 'size': file.ogg_path.stat().st_size,
                        'timestamp': file.timestamp})
                self._log(f'Saved recording {file.raw_path.name}.')
                if file.metadata and file.metadata.trailing_bytes:
                    self._log(f'The vendor audio container included {file.metadata.trailing_bytes} trailing bytes; they remain in the saved raw file.')
            if update.finished and not self._sync_future.done():
                self._sync_future.set_result(None)
            return
        self._log(f'Received ring message {payload[:2].hex().upper()} ({len(payload)} bytes).')

    async def _write_packet(self, packet: Packet, channel=COMMAND_UUID):
        client = self._ble
        if client is None or not client.is_connected:
            raise RuntimeError('The ring is not connected.')
        characteristic = client.services.get_characteristic(channel)
        if characteristic is None:
            if channel == ACK_UUID:
                if not self._missing_ack_logged:
                    self._log('This ring omits the optional 010B ACK channel; using the manufacturer SDK behavior.')
                    self._missing_ack_logged = True
                return
            raise RuntimeError(f'Required AIZO write characteristic is missing: {channel}')
        response = 'write-without-response' not in characteristic.properties
        wire = encode_packet(packet)
        async with self._write_lock:
            def write_limit():
                return (client.mtu_size - 3 if response else
                        characteristic.max_write_without_response_size)

            # The host negotiates the ATT size. The working mobile SDK requests
            # MTU 247 and sends this ring's 76-byte binding frame in one write.
            # Arbitrary 20-byte slicing provokes ACK FF and no binding response.
            deadline = asyncio.get_running_loop().time() + 2
            limit = write_limit()
            while len(wire) > limit and asyncio.get_running_loop().time() < deadline:
                await asyncio.sleep(0.05)
                limit = write_limit()
            if len(wire) > limit:
                raise RuntimeError(f'The Bluetooth write size is too small ({limit} bytes; this command needs {len(wire)}). Reconnect the ring to renegotiate its packet size.')
            await asyncio.wait_for(client.write_gatt_char(characteristic, wire, response=response), timeout=8)
            await asyncio.sleep(0.1)

    async def _send(self, payload: bytes):
        sequence = self._sequence
        self._sequence = next_sequence(sequence)
        await self._write_packet(Packet(payload=payload, sequence=sequence))

    async def sync(self):
        if not self._authenticated or self._ble is None or not self._ble.is_connected:
            raise RuntimeError('Connect and authenticate the ring first.')
        if self._sync_future is not None:
            raise RuntimeError('A recording sync is already running.')
        if self._working_state not in (None, 1, 4):
            raise RuntimeError('Stop recording and wait until the ring is idle before syncing.')
        loop = asyncio.get_running_loop()
        self._sync_future = loop.create_future()
        self._summary_future = loop.create_future()
        self._state('syncing', 'Checking ring recordings…')
        self._emit('progress', progress=0)
        try:
            await self._send(b'\xaa\x13\x01')
            summary = await asyncio.wait_for(self._summary_future, timeout=10)
            self._log(f'Ring reports {summary["count"]} recording(s), {summary["bytes"]} bytes.')
            if summary['count'] == 0:
                self._log('There are no recordings to download.')
                return
            # Isolate transfer caches by device; do not mix cached data from two rings.
            address = ''.join(character for character in self._ble.address if character.isalnum())
            output = self.storage.recordings / address
            self._transfer = RecordingTransfer(output)
            self._last_sync_activity = loop.time()
            for command in self._transfer.start(resume=False):
                await self._send(command)
            while not self._sync_future.done():
                await asyncio.wait((self._sync_future,), timeout=1)
                if loop.time() - self._last_sync_activity > 180:
                    raise asyncio.TimeoutError()
            await self._sync_future
            self._emit('progress', progress=100)
            self._log('Recording sync completed.')
        except asyncio.TimeoutError as error:
            raise RuntimeError('The ring stopped responding during sync. Completed recordings are retained; retry sync to download again.') from error
        finally:
            # Consume a failure that may have arrived while awaiting the summary.
            if self._sync_future is not None and self._sync_future.done() and not self._sync_future.cancelled():
                self._sync_future.exception()
            elif self._sync_future is not None:
                self._sync_future.cancel()
            if self._summary_future is not None and self._summary_future.done() and not self._summary_future.cancelled():
                self._summary_future.exception()
            self._sync_future = None
            self._summary_future = None
            if self._transfer is not None:
                self._transfer.stop()
            self._transfer = None
            if self._authenticated:
                self._state('connected', 'Ready to sync.')

    async def disconnect(self):
        async with self._lifecycle_lock:
            await self._disconnect()

    async def _disconnect_generation(self, generation):
        async with self._lifecycle_lock:
            if generation == self._generation:
                await self._disconnect()

    async def _disconnect(self):
        self._dictation_intent += 1
        self._dictation_armed = False
        self._emit('dictation-state', armed=False)
        # Disable only if this explicit dictation session requested reporting.
        # Do not wait on a reply while tearing down the notification reader.
        if self._touch_reporting_requested and self._ble is not None and self._ble.is_connected:
            with suppress(Exception):
                await self._send(b'\x81\x63\x00')
        self._touch_reporting_requested = False
        self._generation += 1
        self._authenticated = False
        self._abort(RuntimeError('Connection closed.'))
        client, self._ble = self._ble, None
        reader, self._reader = self._reader, None
        if reader is not None and reader is not asyncio.current_task():
            reader.cancel()
            with suppress(asyncio.CancelledError, Exception):
                await reader
        if client is not None:
            with suppress(Exception):
                await asyncio.wait_for(client.disconnect(), timeout=5)
        self._queue = None
        self._binding = None
        self._codec.reset()
        self._state('disconnected', 'Ring disconnected.')
