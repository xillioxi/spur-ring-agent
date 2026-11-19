"""Desktop IPC dispatch checks without Bluetooth or native input side effects."""

import asyncio
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from spur_ring.desktop_service import DesktopService, MAX_LINE_BYTES, default_data_dir


class FakeClient:
    def __init__(self, data_dir, on_event):
        self.data_dir = data_dir
        self.on_event = on_event
        self.calls = []
        self.scan_started = asyncio.Event()
        self.finish_scan = asyncio.Event()

    async def scan(self):
        self.calls.append("scan")
        self.scan_started.set()
        await self.finish_scan.wait()
        self.on_event({"type": "log", "message": "Scan complete"})
        return [{"id": "AA:BB", "name": "AIZO-RING"}]

    async def connect(self, address):
        self.calls.append(("connect", address))

    async def disconnect(self):
        self.calls.append("disconnect")

    async def sync(self):
        self.calls.append("sync")

    async def arm_dictation(self):
        self.calls.append("arm")

    async def disarm_dictation(self):
        self.calls.append("disarm")

    def list_recordings(self):
        return [{"name": "voice.ogg", "path": "C:/owned/voice.ogg"}]


class DesktopServiceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.output = []
        self.service = DesktopService(Path(self.temporary.name), self.output.append, FakeClient)

    async def asyncTearDown(self):
        await self.service.close()

    async def request(self, method, params=None, request_id="one"):
        self.service.accept(json.dumps({"id": request_id, "method": method, "params": params or {}}))
        task = self.service._pending.get(request_id)
        if task:
            await task
        return next(record for record in reversed(self.output) if record.get("id") == request_id)

    async def test_info_does_not_start_bluetooth(self):
        response = await self.request("getInfo")
        self.assertIn("version", response["result"])
        self.assertEqual(self.service.client.calls, [])

    async def test_explicit_connection_and_sync(self):
        self.assertEqual((await self.request("connect", {"address": "AA:BB"}))["result"], {"connected": True})
        result = await self.request("sync")
        self.assertEqual(result["result"][0]["name"], "voice.ogg")
        self.assertEqual(self.service.client.calls, [("connect", "AA:BB"), "sync"])

    async def test_disconnect_can_run_while_scan_is_waiting(self):
        self.service.accept(json.dumps({"id": "scan", "method": "scan"}))
        await self.service.client.scan_started.wait()
        await self.request("disconnect")
        self.assertIn("disconnect", self.service.client.calls)
        self.service.client.finish_scan.set()
        await self.service._pending["scan"]
        self.assertIn({"kind": "event", "event": {"type": "log", "message": "Scan complete"}}, self.output)

    async def test_native_input_delegated_with_exact_target(self):
        target = {"handle": 123, "processId": 999, "label": "Editor"}
        with patch("spur_ring.desktop_service.sys.platform", "win32"), patch("spur_ring.desktop_service.windows_input.capture_target", return_value=target) as capture:
            self.assertEqual((await self.request("captureTarget", {"excludedProcessIds": [1234]}))["result"], target)
            capture.assert_called_once_with([1234])
        with patch("spur_ring.desktop_service.sys.platform", "win32"), patch("spur_ring.desktop_service.windows_input.insert_text", return_value={"inserted": True, "count": 2}) as insert:
            result = await self.request("insertText", {"target": target, "text": "你好"})
            self.assertTrue(result["result"]["inserted"])
            insert.assert_called_once_with(target, "你好")

    async def test_ring_dictation_arm_and_disarm_are_explicit(self):
        self.assertEqual((await self.request("armDictation"))["result"], {"armed": True})
        self.assertEqual((await self.request("disarmDictation"))["result"], {"armed": False})
        self.assertEqual(self.service.client.calls, ["arm", "disarm"])

    async def test_owned_native_self_test_only_runs_when_requested(self):
        with patch("spur_ring.desktop_service.sys.platform", "win32"), patch("spur_ring.desktop_service.windows_input.input_self_test", return_value={"verified": True}) as check:
            await self.request("getInfo")
            check.assert_not_called()
            self.assertEqual((await self.request("inputSelfTest"))["result"], {"verified": True})
            check.assert_called_once_with()

    async def test_macos_info_reports_supported_cursor_and_permission_without_prompt(self):
        permission = {"supported": True, "available": True, "required": True, "granted": False}
        with patch("spur_ring.desktop_service.sys.platform", "darwin"), patch("spur_ring.desktop_service.macos_input.permission_status", return_value=permission) as check:
            result = (await self.request("getInfo"))["result"]
            self.assertTrue(result["capabilities"]["cursorInsertion"])
            self.assertEqual(result["permissions"]["accessibility"], permission)
            check.assert_called_once_with(prompt=False)

    async def test_macos_explicit_permission_request_and_capture_use_mac_adapter(self):
        target = {"handle": 123, "processId": 123, "bundleIdentifier": "com.example.Editor", "label": "Editor"}
        with patch("spur_ring.desktop_service.sys.platform", "darwin"), patch("spur_ring.desktop_service.macos_input.permission_status", return_value={"granted": False}) as permissions, patch("spur_ring.desktop_service.macos_input.capture_target", return_value=target) as capture:
            await self.request("getInputPermissions")
            await self.request("requestInputPermissions")
            self.assertEqual([call.kwargs["prompt"] for call in permissions.call_args_list], [False, True])
            self.assertEqual((await self.request("captureTarget", {"excludedProcessIds": [999]}))["result"], target)
            capture.assert_called_once_with([999])

    async def test_macos_service_profile_uses_application_support(self):
        with patch("spur_ring.desktop_service.sys.platform", "darwin"), patch("spur_ring.desktop_service.Path.home", return_value=Path(self.temporary.name)):
            self.assertEqual(default_data_dir(), Path(self.temporary.name) / "Library" / "Application Support" / "Spur" / "RingDesktop")

    async def test_unsafe_or_unknown_method_is_not_evaluated(self):
        for method in ("__dict__", "eval", "__import__('os').system('anything')"):
            response = await self.request(method)
            self.assertIn("Unknown", response["error"])
        self.assertEqual(self.service.client.calls, [])

    async def test_invalid_native_parameters_rejected(self):
        self.assertIn("error", await self.request("captureTarget", {"excludedProcessIds": [True]}))
        self.assertIn("error", await self.request("insertText", {"target": {}, "text": 123}))
        self.assertIn("error", await self.request("connect", {"address": []}))

    async def test_duplicate_request_id_does_not_replace_running_request(self):
        self.service.accept(json.dumps({"id": "running", "method": "scan"}))
        running = self.service._pending["running"]
        self.service.accept(json.dumps({"id": "running", "method": "disconnect"}))
        self.assertIs(self.service._pending["running"], running)
        self.assertIn("already running", self.output[-1]["error"])
        self.assertEqual(self.service.client.calls, [])

    async def test_malformed_and_oversized_lines_report_structured_errors(self):
        for raw in (b"not json", b"[]", b"\xff", b"x" * (MAX_LINE_BYTES + 1)):
            self.service.accept(raw)
            self.assertEqual(self.output[-1]["kind"], "result")
            self.assertIn("error", self.output[-1])

    async def test_eof_processes_immediate_request_and_disconnects(self):
        raw = b'{"id":"info","method":"getInfo"}\n'
        await self.service.run(io.BytesIO(raw))
        self.assertTrue(any(record.get("id") == "info" and "result" in record for record in self.output))
        self.assertIn("disconnect", self.service.client.calls)

    async def test_shutdown_does_not_require_stdin_eof(self):
        raw = b'{"id":"stop","method":"shutdown"}\n'
        await asyncio.wait_for(self.service.run(io.BytesIO(raw)), timeout=2)
        self.assertIn({"kind": "result", "id": "stop", "result": {"stopping": True}}, self.output)


if __name__ == "__main__":
    unittest.main()
