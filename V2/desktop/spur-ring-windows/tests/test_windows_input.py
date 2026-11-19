"""Cursor insertion regressions; fake native API never types into other apps."""

import ctypes
import os
import unittest
from unittest.mock import patch

from spur_ring import windows_input as win


class FakeAPI:
    def __init__(self):
        self.handle = 0x123456789
        self.pid = os.getpid() + 100
        self.valid = True
        self.password = False
        self.modifiers = False
        self.events = None
        self.written = None
        self.error = 0
        self.interactive = True

    def interactive_desktop(self):
        return self.interactive

    def foreground(self):
        return self.handle

    def valid_window(self, handle):
        return self.valid

    def process_id(self, handle):
        return self.pid

    def title(self, handle):
        return "Example editor"

    def password_field_focused(self):
        return self.password

    def modifiers_pressed(self):
        return self.modifiers

    def send(self, events):
        self.events = events
        return (len(events) if self.written is None else self.written, self.error)


class WindowsInputTests(unittest.TestCase):
    def setUp(self):
        self.api = FakeAPI()
        self.patcher = patch.object(win, "_get_api", return_value=self.api)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)
        self.target = {"handle": self.api.handle, "processId": self.api.pid, "label": "Example editor"}

    def test_input_uses_windows_native_alignment(self):
        expected = 40 if ctypes.sizeof(ctypes.c_void_p) == 8 else 28
        self.assertEqual(ctypes.sizeof(win._INPUT), expected)
        self.assertEqual(ctypes.sizeof(win._KEYBDINPUT), 24 if expected == 40 else 16)

    def test_fixed_windows_scalar_widths_and_offsets_are_portable_to_lp64(self):
        # ctypes.wintypes DWORD/LONG can follow the host c_ulong/c_long on
        # non-Windows systems. These layouts must still use the Windows ABI.
        self.assertEqual(ctypes.sizeof(win._DWORD), 4)
        self.assertEqual(ctypes.sizeof(win._LONG), 4)
        self.assertEqual(ctypes.sizeof(win._WORD), 2)
        self.assertEqual(win._DWORD(0xFFFFFFFF).value, 0xFFFFFFFF)
        self.assertEqual(win._LONG(-1).value, -1)
        is_64bit = ctypes.sizeof(ctypes.c_void_p) == 8
        self.assertEqual(win._INPUT.data.offset, 8 if is_64bit else 4)
        self.assertEqual(win._KEYBDINPUT.dwFlags.offset, 4)
        self.assertEqual(win._KEYBDINPUT.dwExtraInfo.offset, 16 if is_64bit else 12)
        self.assertEqual(win._MOUSEINPUT.dy.offset, 4)
        self.assertEqual(win._MOUSEINPUT.dwExtraInfo.offset, 24 if is_64bit else 20)
        self.assertEqual(ctypes.sizeof(win._RECT), 16)
        self.assertEqual(ctypes.sizeof(win._GUITHREADINFO), 72 if is_64bit else 48)

    def test_capture_preserves_full_64_bit_handle(self):
        self.assertEqual(win.capture_target(), self.target)

    def test_capture_excludes_shell_and_backend(self):
        with self.assertRaisesRegex(RuntimeError, "another application"):
            win.capture_target([self.api.pid])
        self.api.pid = os.getpid()
        with self.assertRaisesRegex(RuntimeError, "another application"):
            win.capture_target()

    def test_capture_rejects_absent_or_password_target(self):
        self.api.valid = False
        with self.assertRaises(RuntimeError):
            win.capture_target()
        self.api.valid = True
        self.api.password = True
        with self.assertRaisesRegex(RuntimeError, "password"):
            win.capture_target()

    def test_unicode_surrogate_pair_and_no_virtual_command_keys(self):
        result = win.insert_text(self.target, "A你🎤")
        self.assertEqual(result, {"inserted": True, "count": 3, "text": "A你🎤"})
        self.assertEqual([event.ki.wScan for event in self.api.events],
                         [0x41, 0x41, 0x4F60, 0x4F60, 0xD83C, 0xD83C, 0xDFA4, 0xDFA4])
        self.assertEqual([event.ki.dwFlags for event in self.api.events], [4, 6] * 4)
        self.assertTrue(all(event.type == 1 and event.ki.wVk == 0 for event in self.api.events))

    def test_control_characters_do_not_trigger_commands(self):
        result = win.insert_text(self.target, "first\r\nsecond\tthird\n\x1b\x00\x7f")
        self.assertEqual(result["text"], "first second third ")
        self.assertTrue(all(event.ki.wScan >= 32 for event in self.api.events))

    def test_focus_change_or_reused_handle_refuses_input(self):
        self.api.handle += 1
        self.assertFalse(win.insert_text(self.target, "hello")["inserted"])
        self.assertIsNone(self.api.events)
        self.api.handle = self.target["handle"]
        self.api.pid += 1
        self.assertFalse(win.insert_text(self.target, "hello")["inserted"])
        self.assertIsNone(self.api.events)

    def test_modifier_release_is_bounded_and_no_input_sent(self):
        self.api.modifiers = True
        with patch.object(win.time, "monotonic", side_effect=[0, 0, 1.1]), patch.object(win.time, "sleep"):
            result = win.insert_text(self.target, "hello")
        self.assertFalse(result["inserted"])
        self.assertIn("Release", result["reason"])
        self.assertIsNone(self.api.events)

    def test_rechecks_focus_after_modifiers_release(self):
        def released():
            self.api.handle += 1
            return False
        self.api.modifiers_pressed = released
        self.assertFalse(win.insert_text(self.target, "hello")["inserted"])
        self.assertIsNone(self.api.events)

    def test_native_password_field_checked_again_at_insert(self):
        self.api.password = True
        self.assertFalse(win.insert_text(self.target, "hello")["inserted"])
        self.assertIsNone(self.api.events)

    def test_partial_input_is_reported_and_never_retried(self):
        self.api.written = 1
        self.api.error = 5
        with self.assertRaisesRegex(RuntimeError, "1 of 10.*Windows error 5.*not retried"):
            win.insert_text(self.target, "hello")

    def test_blocked_input_reports_elevation_limit(self):
        self.api.written = 0
        with self.assertRaisesRegex(RuntimeError, "administrator"):
            win.insert_text(self.target, "hello")

    def test_empty_text_no_input_or_api_access(self):
        self.assertFalse(win.insert_text(self.target, "\x00")["inserted"])
        self.assertIsNone(self.api.events)

    def test_invalid_target_rejected(self):
        for target in (None, {}, {"handle": -1, "processId": self.api.pid}):
            with self.assertRaises(ValueError):
                win.insert_text(target, "hello")

    def test_inactive_desktop_never_receives_input(self):
        self.api.interactive = False
        with self.assertRaisesRegex(RuntimeError, "active Windows desktop"):
            win.capture_target()
        self.assertFalse(win.insert_text(self.target, "hello")["inserted"])
        self.assertIsNone(self.api.events)


if __name__ == "__main__":
    unittest.main()
