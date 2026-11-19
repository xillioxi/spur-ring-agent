"""Portable Mac cursor regressions; no macOS app or native events are used."""

import os
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from spur_ring import macos_input as mac


class FakeAPI:
    def __init__(self):
        self.app = {"processId": os.getpid() + 100, "bundleIdentifier": "com.example.Editor", "label": "Editor"}
        self.trusted = True
        self.posting = True
        self.active = True
        self.password = False
        self.modifiers = False
        self.prompts = []
        self.chunks = []

    def accessibility_trusted(self, prompt=False):
        self.prompts.append(prompt)
        return self.trusted

    def event_posting_allowed(self):
        return self.posting

    def frontmost(self):
        return self.app

    def session_active(self):
        return self.active

    def password_field_focused(self, process_id):
        return self.password

    def modifiers_pressed(self):
        return self.modifiers

    def post_unicode(self, text):
        self.chunks.append(text)


class MacOSInputTests(unittest.TestCase):
    def setUp(self):
        self.api = FakeAPI()
        self.target = {"handle": self.api.app["processId"], **self.api.app}
        self.api_patch = patch.object(mac, "_get_api", return_value=self.api)
        self.api_patch.start()
        self.addCleanup(self.api_patch.stop)
        self.platform_patch = patch.object(sys, "platform", "darwin")
        self.platform_patch.start()
        self.addCleanup(self.platform_patch.stop)

    def test_capture_returns_pid_and_bundle_identity(self):
        self.assertEqual(mac.capture_target(), self.target)
        self.assertNotIn(True, self.api.prompts)

    def test_capture_excludes_backend_and_supplied_shell_pid(self):
        with self.assertRaisesRegex(RuntimeError, "another application"):
            mac.capture_target([self.api.app["processId"]])
        self.api.app["processId"] = os.getpid()
        with self.assertRaisesRegex(RuntimeError, "another application"):
            mac.capture_target()

    def test_permission_status_never_prompts_implicitly(self):
        self.api.trusted = False
        status = mac.permission_status()
        self.assertTrue(status["supported"])
        self.assertTrue(status["available"])
        self.assertFalse(status["granted"])
        self.assertIn("Accessibility", status["message"])
        self.assertEqual(self.api.prompts, [False])
        mac.permission_status(prompt=True)
        self.assertEqual(self.api.prompts, [False, True])

    def test_explicit_capture_requests_permission_but_does_not_type(self):
        self.api.trusted = False
        with self.assertRaisesRegex(RuntimeError, "Accessibility"):
            mac.capture_target()
        self.assertIn(True, self.api.prompts)
        self.assertEqual(self.api.chunks, [])

    def test_missing_framework_is_reported_without_crashing_diagnostics(self):
        with patch.object(mac, "_get_api", side_effect=RuntimeError("Missing PyObjC")):
            status = mac.permission_status()
        self.assertTrue(status["supported"])
        self.assertFalse(status["available"])
        self.assertEqual(status["message"], "Missing PyObjC")

    def test_untrusted_or_blocked_event_posting_never_inserts_or_prompts(self):
        for trusted, posting in ((False, True), (True, False)):
            self.api.trusted, self.api.posting = trusted, posting
            with self.assertRaisesRegex(RuntimeError, "Accessibility"):
                mac.insert_text(self.target, "hello")
        self.assertNotIn(True, self.api.prompts)
        self.assertEqual(self.api.chunks, [])

    def test_plain_unicode_text_keeps_emoji_and_removes_command_controls(self):
        result = mac.insert_text(self.target, "Hello\r\n你好 🎤\t\x1b\x00\x7f")
        self.assertTrue(result["inserted"])
        self.assertEqual(result["text"], "Hello 你好 🎤 ")
        self.assertEqual(result["count"], len(result["text"]))
        self.assertEqual("".join(self.api.chunks), result["text"])
        self.assertEqual(result["delivery"], "queued")

    def test_batch_boundaries_never_split_astral_utf16_pair(self):
        text = "a" * 19 + "🎤" + "b" * 20
        self.assertEqual(list(mac._batches(text)), ["a" * 19, "🎤" + "b" * 18, "bb"])
        mac.insert_text(self.target, text)
        self.assertTrue(all(len(chunk.encode("utf-16-le")) // 2 <= 20 for chunk in self.api.chunks))
        self.assertEqual("".join(self.api.chunks), text)

    def test_foreground_pid_or_bundle_change_never_inserts(self):
        self.api.app = {**self.api.app, "processId": self.api.app["processId"] + 1}
        self.assertFalse(mac.insert_text(self.target, "hello")["inserted"])
        self.api.app = {**self.api.app, "processId": self.target["processId"], "bundleIdentifier": "other.app"}
        self.assertFalse(mac.insert_text(self.target, "hello")["inserted"])
        self.assertEqual(self.api.chunks, [])

    def test_checks_focus_before_every_batch_and_reports_partial_count(self):
        def post(text):
            self.api.chunks.append(text)
            self.api.app = {**self.api.app, "processId": self.api.app["processId"] + 1}
        self.api.post_unicode = post
        result = mac.insert_text(self.target, "a" * 30)
        self.assertFalse(result["inserted"])
        self.assertEqual(result["count"], 20)
        self.assertEqual(self.api.chunks, ["a" * 20])

    def test_locked_console_and_loginwindow_are_refused(self):
        self.api.active = False
        with self.assertRaisesRegex(RuntimeError, "active macOS desktop"):
            mac.capture_target()
        self.assertFalse(mac.insert_text(self.target, "hello")["inserted"])
        self.api.active = True
        self.api.app = {**self.api.app, "bundleIdentifier": "com.apple.loginwindow"}
        with self.assertRaisesRegex(RuntimeError, "active macOS desktop"):
            mac.capture_target()
        self.assertEqual(self.api.chunks, [])

    def test_password_metadata_blocks_capture_and_insertion(self):
        self.api.password = True
        with self.assertRaisesRegex(RuntimeError, "password"):
            mac.capture_target()
        self.assertFalse(mac.insert_text(self.target, "hello")["inserted"])
        self.assertEqual(self.api.chunks, [])

    def test_modifier_release_wait_is_bounded(self):
        self.api.modifiers = True
        with patch.object(mac.time, "monotonic", side_effect=[0, 0, 1.1]), patch.object(mac.time, "sleep"):
            result = mac.insert_text(self.target, "hello")
        self.assertFalse(result["inserted"])
        self.assertIn("Release", result["reason"])
        self.assertEqual(self.api.chunks, [])

    def test_failed_native_queue_is_not_retried(self):
        post = Mock(side_effect=RuntimeError("native failure"))
        self.api.post_unicode = post
        with self.assertRaisesRegex(RuntimeError, "not retried"):
            mac.insert_text(self.target, "hello")
        post.assert_called_once_with("hello")

    def test_invalid_target_or_surrogate_never_posts_any_event(self):
        for target in ({}, {**self.target, "processId": True}, {**self.target, "handle": 1}):
            with self.assertRaises(ValueError):
                mac.insert_text(target, "hello")
        with self.assertRaises(UnicodeEncodeError):
            mac.insert_text(self.target, "\ud800")
        self.assertEqual(self.api.chunks, [])

    def test_native_quartz_bridge_uses_utf16_count_and_zero_modifier_flags(self):
        events = []
        q = SimpleNamespace(
            kCGSessionEventTap=1,
            CGEventCreateKeyboardEvent=Mock(side_effect=lambda source, key, down: {"key": key, "down": down}),
            CGEventSetFlags=Mock(), CGEventKeyboardSetUnicodeString=Mock(),
            CGEventPost=Mock(side_effect=lambda tap, event: events.append(event)),
        )
        native = object.__new__(mac._MacOSAPI)
        native.quartz = q
        native.post_unicode("A你🎤")
        self.assertEqual([event["down"] for event in events], [True, False])
        self.assertTrue(all(event["key"] == 0 for event in events))
        self.assertEqual(q.CGEventKeyboardSetUnicodeString.call_count, 2)
        for call in q.CGEventKeyboardSetUnicodeString.call_args_list:
            self.assertEqual(call.args[1:], (4, "A你🎤"))
        self.assertTrue(all(call.args[1] == 0 for call in q.CGEventSetFlags.call_args_list))

    def test_native_ax_probe_reads_only_focused_subrole(self):
        ax = SimpleNamespace(
            AXUIElementCreateApplication=Mock(return_value="app"),
            AXUIElementSetMessagingTimeout=Mock(),
            AXUIElementCopyAttributeValue=Mock(side_effect=[(0, "field"), (0, "AXSecureTextField")]),
            kAXFocusedUIElementAttribute="AXFocusedUIElement", kAXSubroleAttribute="AXSubrole",
            kAXSecureTextFieldSubrole="AXSecureTextField", kAXErrorSuccess=0,
        )
        native = object.__new__(mac._MacOSAPI)
        native.ax = ax
        self.assertTrue(native.password_field_focused(123))
        self.assertEqual([call.args[1] for call in ax.AXUIElementCopyAttributeValue.call_args_list],
                         ["AXFocusedUIElement", "AXSubrole"])


@unittest.skipUnless(sys.platform == "darwin", "Native PyObjC binding check requires macOS")
class NativeMacOSBindingTests(unittest.TestCase):
    """Construct/read native events on Mac CI; never post to another app."""

    def test_native_unicode_event_roundtrip_preserves_astral_character(self):
        native = mac._MacOSAPI()
        q = native.quartz
        event = q.CGEventCreateKeyboardEvent(None, 0, True)
        self.assertIsNotNone(event)
        text = "A你🎤"
        q.CGEventKeyboardSetUnicodeString(event, len(text.encode("utf-16-le")) // 2, text)
        length, observed = q.CGEventKeyboardGetUnicodeString(event, 20, None, None)
        self.assertEqual(length, 4)
        self.assertEqual(observed, text)

    def test_native_permission_diagnostics_load_frameworks_without_prompt(self):
        status = mac.permission_status(prompt=False)
        self.assertTrue(status["available"], status.get("message"))
        self.assertTrue(status["required"])
        self.assertIsInstance(status["granted"], bool)


if __name__ == "__main__":
    unittest.main()
