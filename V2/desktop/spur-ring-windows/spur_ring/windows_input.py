"""Insert dictated text into the window selected when dictation starts.

Only Unicode text events are sent. This module never changes focus, uses the
clipboard, or sends command keys. Windows can refuse insertion into elevated
applications; a successful SendInput call means events were queued, not that a
particular application accepted them.

Native definitions follow Microsoft's INPUT, KEYBDINPUT and SendInput docs:
https://learn.microsoft.com/windows/win32/api/winuser/ns-winuser-input
https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-sendinput
"""

from __future__ import annotations

import ctypes
from functools import lru_cache
import os
import struct
import sys
import threading
import time
from typing import Any


# Windows uses LLP64: DWORD/LONG stay 32 bits on a 64-bit host. Explicit
# widths also keep these importable structs correct in macOS/Linux mock tests,
# whose native c_long/c_ulong are 64 bits (LP64).
_DWORD = ctypes.c_uint32
_LONG = ctypes.c_int32
_WORD = ctypes.c_uint16
_HWND = ctypes.c_void_p
_ULONG_PTR = ctypes.c_size_t
_INPUT_KEYBOARD = 1
_KEYEVENTF_KEYUP = 0x0002
_KEYEVENTF_UNICODE = 0x0004
_MODIFIERS = (0x10, 0x11, 0x12, 0x5B, 0x5C)  # Shift, Ctrl, Alt, both Win keys.
_MODIFIER_TIMEOUT = 1.0
_INPUT_LOCK = threading.Lock()


class _MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", _LONG), ("dy", _LONG), ("mouseData", _DWORD),
                ("dwFlags", _DWORD), ("time", _DWORD), ("dwExtraInfo", _ULONG_PTR)]


class _KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", _WORD), ("wScan", _WORD), ("dwFlags", _DWORD),
                ("time", _DWORD), ("dwExtraInfo", _ULONG_PTR)]


class _HARDWAREINPUT(ctypes.Structure):
    _fields_ = [("uMsg", _DWORD), ("wParamL", _WORD), ("wParamH", _WORD)]


class _INPUTUNION(ctypes.Union):
    _fields_ = [("mi", _MOUSEINPUT), ("ki", _KEYBDINPUT), ("hi", _HARDWAREINPUT)]


class _INPUT(ctypes.Structure):
    _anonymous_ = ("data",)
    _fields_ = [("type", _DWORD), ("data", _INPUTUNION)]


class _RECT(ctypes.Structure):
    _fields_ = [("left", _LONG), ("top", _LONG), ("right", _LONG), ("bottom", _LONG)]


class _GUITHREADINFO(ctypes.Structure):
    _fields_ = [("cbSize", _DWORD), ("flags", _DWORD), ("hwndActive", _HWND),
                ("hwndFocus", _HWND), ("hwndCapture", _HWND), ("hwndMenuOwner", _HWND),
                ("hwndMoveSize", _HWND), ("hwndCaret", _HWND), ("rcCaret", _RECT)]


class _WindowsAPI:
    def __init__(self) -> None:
        if sys.platform != "win32":
            raise RuntimeError("Typing at the cursor is available on Windows only.")
        self.user32 = ctypes.WinDLL("user32", use_last_error=True)
        self.kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        self.kernel32.GetCurrentThreadId.argtypes = []
        self.kernel32.GetCurrentThreadId.restype = _DWORD
        signatures = {
            "GetForegroundWindow": ([], _HWND),
            "IsWindow": ([_HWND], ctypes.c_int),
            "GetWindowThreadProcessId": ([_HWND, ctypes.POINTER(_DWORD)], _DWORD),
            "GetWindowTextLengthW": ([_HWND], ctypes.c_int),
            "GetWindowTextW": ([_HWND, ctypes.c_wchar_p, ctypes.c_int], ctypes.c_int),
            "GetAsyncKeyState": ([ctypes.c_int], ctypes.c_int16),
            "GetGUIThreadInfo": ([_DWORD, ctypes.POINTER(_GUITHREADINFO)], ctypes.c_int),
            "GetClassNameW": ([_HWND, ctypes.c_wchar_p, ctypes.c_int], ctypes.c_int),
            "GetWindowLongW": ([_HWND, ctypes.c_int], _LONG),
            "SendInput": ([_DWORD, ctypes.POINTER(_INPUT), ctypes.c_int], _DWORD),
            "GetThreadDesktop": ([_DWORD], ctypes.c_void_p),
            "GetUserObjectInformationW": ([ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p,
                                            _DWORD, ctypes.POINTER(_DWORD)], ctypes.c_int),
        }
        for name, (args, result) in signatures.items():
            function = getattr(self.user32, name)
            function.argtypes = args
            function.restype = result

    def foreground(self) -> int:
        return int(self.user32.GetForegroundWindow() or 0)

    def interactive_desktop(self) -> bool:
        desktop = self.user32.GetThreadDesktop(self.kernel32.GetCurrentThreadId())
        receives_input = ctypes.c_int()
        required = _DWORD()
        # UOI_IO identifies whether this desktop currently receives user input.
        return bool(desktop and self.user32.GetUserObjectInformationW(
            desktop, 6, ctypes.byref(receives_input), ctypes.sizeof(receives_input),
            ctypes.byref(required)) and receives_input.value)

    def valid_window(self, handle: int) -> bool:
        return bool(self.user32.IsWindow(handle))

    def process_id(self, handle: int) -> int:
        process_id = _DWORD()
        if not self.user32.GetWindowThreadProcessId(handle, ctypes.byref(process_id)):
            raise RuntimeError("The selected application window is no longer available.")
        return int(process_id.value)

    def title(self, handle: int) -> str:
        # This reads only the top-level title, never an application's text field.
        length = min(self.user32.GetWindowTextLengthW(handle), 1024)
        buffer = ctypes.create_unicode_buffer(max(1, length + 1))
        self.user32.GetWindowTextW(handle, buffer, len(buffer))
        return buffer.value.strip() or "Selected application"

    def modifiers_pressed(self) -> bool:
        return any(self.user32.GetAsyncKeyState(key) & 0x8000 for key in _MODIFIERS)

    def password_field_focused(self) -> bool:
        # Best effort for native EDIT controls. Browser/custom password controls
        # do not expose this style, so this is not a general password detector.
        info = _GUITHREADINFO(cbSize=ctypes.sizeof(_GUITHREADINFO))
        if not self.user32.GetGUIThreadInfo(0, ctypes.byref(info)) or not info.hwndFocus:
            return False
        name = ctypes.create_unicode_buffer(128)
        if not self.user32.GetClassNameW(info.hwndFocus, name, len(name)):
            return False
        native_edit = name.value.casefold() == "edit" or name.value.casefold().startswith("richedit")
        return native_edit and bool(self.user32.GetWindowLongW(info.hwndFocus, -16) & 0x0020)

    def send(self, events: Any) -> tuple[int, int]:
        ctypes.set_last_error(0)
        written = int(self.user32.SendInput(len(events), events, ctypes.sizeof(_INPUT)))
        return written, ctypes.get_last_error()


@lru_cache(maxsize=1)
def _get_api() -> _WindowsAPI:
    return _WindowsAPI()


def capture_target(excluded_process_ids: list[int] | None = None) -> dict[str, Any]:
    """Capture the foreground application without moving focus.

    The backend itself and any supplied process IDs (normally the Electron
    shell) are excluded. Call from a global hotkey while the desired editor is
    foreground, before opening any Spur window.
    """
    api = _get_api()
    if not api.interactive_desktop():
        raise RuntimeError("Dictation requires the unlocked, active Windows desktop.")
    handle = api.foreground()
    if not handle or not api.valid_window(handle):
        raise RuntimeError("Click in a text field in another application, then start dictation.")
    process_id = api.process_id(handle)
    excluded = {os.getpid(), *(excluded_process_ids or [])}
    if process_id in excluded:
        raise RuntimeError("Select a text field in another application before starting dictation.")
    if api.password_field_focused():
        raise RuntimeError("Dictation is unavailable in a password field.")
    return {"handle": handle, "processId": process_id, "label": api.title(handle)}


def _plain_text(text: str) -> str:
    if not isinstance(text, str):
        raise TypeError("Dictation text must be a string.")
    # Text-only dictation never synthesizes Return, Tab, Escape or control keys.
    text = text.replace("\r\n", " ").replace("\r", " ").replace("\n", " ").replace("\t", " ")
    return "".join(character for character in text if ord(character) >= 32 and ord(character) != 127)


def _unicode_events(text: str) -> Any:
    wire = text.encode("utf-16-le")
    units = struct.unpack(f"<{len(wire) // 2}H", wire)
    events = (_INPUT * (len(units) * 2))()
    for index, unit in enumerate(units):
        for offset, flags in ((0, _KEYEVENTF_UNICODE), (1, _KEYEVENTF_UNICODE | _KEYEVENTF_KEYUP)):
            event = events[index * 2 + offset]
            event.type = _INPUT_KEYBOARD
            event.ki = _KEYBDINPUT(0, unit, flags, 0, 0)
    return events


def _target_matches(api: _WindowsAPI, handle: int, process_id: int) -> bool:
    return bool(api.valid_window(handle) and api.foreground() == handle
                and api.process_id(handle) == process_id)


def insert_text(target: dict[str, Any], text: str) -> dict[str, Any]:
    """Queue Unicode text only while the captured application is foreground.

    Call through asyncio.to_thread: releasing hotkey modifiers can take up to
    one second. A focus change keeps the text in Spur for manual use instead.
    A partial SendInput failure is never retried, to avoid duplicate text.
    """
    if not isinstance(target, dict):
        raise ValueError("A dictation target must first be selected.")
    try:
        handle = int(target["handle"])
        process_id = int(target["processId"])
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError("The dictation target is invalid; start dictation again.") from error
    if handle <= 0 or process_id <= 0:
        raise ValueError("The dictation target is invalid; start dictation again.")
    plain = _plain_text(text)
    if not plain:
        return {"inserted": False, "count": 0, "reason": "No text to insert."}
    events = _unicode_events(plain)
    api = _get_api()
    with _INPUT_LOCK:
        if not api.interactive_desktop():
            return {"inserted": False, "count": 0, "reason": "Dictation requires the unlocked, active Windows desktop."}
        if not _target_matches(api, handle, process_id):
            return {"inserted": False, "count": 0, "reason": "The selected application is no longer in front."}
        deadline = time.monotonic() + _MODIFIER_TIMEOUT
        while api.modifiers_pressed():
            if not _target_matches(api, handle, process_id):
                return {"inserted": False, "count": 0, "reason": "The selected application is no longer in front."}
            if time.monotonic() >= deadline:
                return {"inserted": False, "count": 0, "reason": "Release Ctrl, Shift, Alt and Windows keys to type dictation."}
            time.sleep(0.02)
        if not _target_matches(api, handle, process_id):
            return {"inserted": False, "count": 0, "reason": "The selected application is no longer in front."}
        if api.password_field_focused():
            return {"inserted": False, "count": 0, "reason": "Dictation is unavailable in a password field."}
        written, error = api.send(events)
    if written != len(events):
        detail = f" Windows error {error}." if error else ""
        partial = " Some text may already have been inserted; it was not retried." if written else ""
        raise RuntimeError(
            f"Windows accepted {written} of {len(events)} dictation input events.{detail}"
            " The selected application may be running as administrator or may block synthetic input."
            f"{partial}"
        )
    return {"inserted": True, "count": len(plain), "text": plain}


def input_self_test() -> dict[str, Any]:
    """Verify Unicode insertion in a disposable native window owned by this process.

    Explicit diagnostic only. The small temporary test window receives focus;
    no existing application receives input, and the test window is destroyed.
    """
    api = _get_api()
    if not api.interactive_desktop():
        raise RuntimeError("The native input self-test requires the unlocked, active Windows desktop.")
    user32 = api.user32
    signatures = {
        "CreateWindowExW": ([_DWORD, ctypes.c_wchar_p, ctypes.c_wchar_p, _DWORD,
                            ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                            _HWND, _HWND, _HWND, ctypes.c_void_p], _HWND),
        "DestroyWindow": ([_HWND], ctypes.c_int),
        "SetForegroundWindow": ([_HWND], ctypes.c_int),
        "SetFocus": ([_HWND], _HWND),
        "PeekMessageW": ([ctypes.c_void_p, _HWND, _DWORD, _DWORD, _DWORD], ctypes.c_int),
        "TranslateMessage": ([ctypes.c_void_p], ctypes.c_int),
        "DispatchMessageW": ([ctypes.c_void_p], ctypes.c_ssize_t),
    }
    for name, (args, result) in signatures.items():
        function = getattr(user32, name)
        function.argtypes, function.restype = args, result
    root = user32.CreateWindowExW(0, "EDIT", "", 0x10CF0044,
                                 100, 100, 520, 180, None, None, None, None)
    if not root:
        raise RuntimeError("Could not create the disposable dictation test window.")
    try:
        edit = root
        message = (ctypes.c_size_t * 8)()
        user32.SetForegroundWindow(root)  # Only this owned, explicitly requested test window.
        # Activation messages can otherwise restore focus to the parent after
        # SetFocus. Finish those messages before selecting our own EDIT child.
        settle = time.monotonic() + 0.1
        while time.monotonic() < settle:
            while user32.PeekMessageW(ctypes.byref(message), None, 0, 0, 1):
                user32.TranslateMessage(ctypes.byref(message))
                user32.DispatchMessageW(ctypes.byref(message))
            time.sleep(0.01)
        user32.SetFocus(edit)
        focus_info = _GUITHREADINFO(cbSize=ctypes.sizeof(_GUITHREADINFO))
        if (not user32.GetGUIThreadInfo(0, ctypes.byref(focus_info))
                or focus_info.hwndFocus != edit):
            raise RuntimeError("The disposable input field could not receive keyboard focus.")
        expected = "Spur voice check — 你好 🎤"
        target = {"handle": int(root), "processId": os.getpid(), "label": "Disposable test window"}
        result = insert_text(target, expected)
        # MSG is at most 48 bytes on supported Windows architectures. Aligned
        # pointer-sized storage avoids making a second platform-specific struct.
        deadline = time.monotonic() + 1.0
        while time.monotonic() < deadline:
            while user32.PeekMessageW(ctypes.byref(message), None, 0, 0, 1):
                user32.TranslateMessage(ctypes.byref(message))
                user32.DispatchMessageW(ctypes.byref(message))
            observed = api.title(edit)
            if observed == expected:
                return {"verified": True, "inserted": result["count"], "unicode": True, "ownWindowOnly": True}
            time.sleep(0.01)
        raise RuntimeError(f"The disposable field did not receive the expected Unicode text: {observed!r}.")
    finally:
        user32.DestroyWindow(root)
