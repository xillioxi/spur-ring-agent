"""macOS Unicode dictation at the cursor, with no clipboard or focus changes.

PyObjC frameworks are loaded lazily so Windows builds and portable tests do not
need macOS packages. AX trust is checked without prompting during diagnostics;
the permission prompt is only requested by an explicit permission/start action.
CGEventPost queues events and does not confirm that an editor accepted them.

Native API references:
https://developer.apple.com/documentation/appkit/nsworkspace/frontmostapplication
https://developer.apple.com/documentation/applicationservices/axuielement_h
https://developer.apple.com/documentation/coregraphics/cgevent/keyboardsetunicodestring(stringlength:unicodestring:)
"""

from __future__ import annotations

from functools import lru_cache
import os
import sys
import threading
import time
from typing import Any


_MODIFIER_TIMEOUT = 1.0
_MAX_UNITS_PER_EVENT = 20
_INPUT_LOCK = threading.Lock()
_PERMISSION_MESSAGE = (
    "Allow Spur Desktop in System Settings > Privacy & Security > Accessibility, "
    "then try dictation again. If macOS lists the Spur Ring service separately, "
    "allow that bundled helper as well."
)
_LOCK_SCREEN_BUNDLES = {"com.apple.loginwindow", "com.apple.ScreenSaver.Engine"}


class _MacOSAPI:
    def __init__(self) -> None:
        if sys.platform != "darwin":
            raise RuntimeError("The macOS cursor adapter requires macOS.")
        try:
            import AppKit
            import ApplicationServices
            import Quartz
        except ImportError as error:
            raise RuntimeError(
                "The macOS cursor adapter is missing its PyObjC Cocoa, Quartz or ApplicationServices framework."
            ) from error
        self.appkit = AppKit
        self.ax = ApplicationServices
        self.quartz = Quartz

    def accessibility_trusted(self, prompt: bool = False) -> bool:
        if prompt:
            return bool(self.ax.AXIsProcessTrustedWithOptions({self.ax.kAXTrustedCheckOptionPrompt: True}))
        return bool(self.ax.AXIsProcessTrusted())

    def event_posting_allowed(self) -> bool:
        preflight = getattr(self.quartz, "CGPreflightPostEventAccess", None)
        return bool(preflight()) if preflight is not None else True

    def frontmost(self) -> dict[str, Any] | None:
        app = self.appkit.NSWorkspace.sharedWorkspace().frontmostApplication()
        if app is None or app.isTerminated():
            return None
        return {"processId": int(app.processIdentifier()),
                "bundleIdentifier": str(app.bundleIdentifier() or ""),
                "label": str(app.localizedName() or "Selected application")}

    def session_active(self) -> bool:
        # Public session flags identify console/login state. The frontmost-app
        # check also rejects loginwindow/screensaver. No private screen-lock
        # dictionary keys or secure-input bypasses are used.
        session = self.quartz.CGSessionCopyCurrentDictionary()
        if session is None:
            return False
        console_key = self.quartz.kCGSessionOnConsoleKey
        login_key = self.quartz.kCGSessionLoginDoneKey
        return bool(session.get(console_key, False) and session.get(login_key, False))

    def modifiers_pressed(self) -> bool:
        q = self.quartz
        mask = (q.kCGEventFlagMaskShift | q.kCGEventFlagMaskControl
                | q.kCGEventFlagMaskAlternate | q.kCGEventFlagMaskCommand
                | q.kCGEventFlagMaskSecondaryFn)
        return bool(q.CGEventSourceFlagsState(q.kCGEventSourceStateCombinedSessionState) & mask)

    def _attribute(self, element: Any, name: str) -> Any:
        error, value = self.ax.AXUIElementCopyAttributeValue(element, name, None)
        return value if error == self.ax.kAXErrorSuccess else None

    def password_field_focused(self, process_id: int) -> bool:
        # Only focused-element metadata is inspected; never its value/text.
        # Some custom editors do not publish AX subroles, so this remains a
        # best-effort safeguard, not a universal password-field detector.
        try:
            app = self.ax.AXUIElementCreateApplication(process_id)
            self.ax.AXUIElementSetMessagingTimeout(app, 0.2)
            focused = self._attribute(app, self.ax.kAXFocusedUIElementAttribute)
            if focused is None:
                return False
            self.ax.AXUIElementSetMessagingTimeout(focused, 0.2)
            return self._attribute(focused, self.ax.kAXSubroleAttribute) == self.ax.kAXSecureTextFieldSubrole
        except (AttributeError, RuntimeError, ValueError):
            return False

    def post_unicode(self, text: str) -> None:
        q = self.quartz
        # PyObjC accepts a Python str for UniChar*. Its explicit length is the
        # UTF-16 unit count, not Python's code-point count (emoji use two units).
        length = len(text.encode("utf-16-le")) // 2
        down = q.CGEventCreateKeyboardEvent(None, 0, True)
        up = q.CGEventCreateKeyboardEvent(None, 0, False)
        if down is None or up is None:
            raise RuntimeError("macOS could not allocate dictation keyboard events.")
        for event in (down, up):
            q.CGEventSetFlags(event, 0)
            q.CGEventKeyboardSetUnicodeString(event, length, text)
        q.CGEventPost(q.kCGSessionEventTap, down)
        q.CGEventPost(q.kCGSessionEventTap, up)


@lru_cache(maxsize=1)
def _get_api() -> _MacOSAPI:
    return _MacOSAPI()


def permission_status(prompt: bool = False) -> dict[str, Any]:
    """Read native Accessibility state; prompting is always explicit."""
    if sys.platform != "darwin":
        return {"supported": False, "available": False, "required": True, "granted": False,
                "message": "The macOS cursor adapter requires macOS."}
    try:
        api = _get_api()
        trusted = api.accessibility_trusted(prompt)
        posting = api.event_posting_allowed()
        result = {"supported": True, "available": True, "required": True,
                  "granted": trusted and posting, "accessibilityTrusted": trusted,
                  "eventPostingAllowed": posting, "processId": os.getpid()}
        if not result["granted"]:
            result["message"] = _PERMISSION_MESSAGE
        return result
    except Exception as error:
        return {"supported": True, "available": False, "required": True, "granted": False,
                "message": str(error) or "The macOS cursor adapter could not start."}


def _require_permission(api: _MacOSAPI, prompt: bool = False) -> None:
    if not api.accessibility_trusted(prompt) or not api.event_posting_allowed():
        raise RuntimeError(_PERMISSION_MESSAGE)


def _active_app(api: _MacOSAPI) -> dict[str, Any] | None:
    if not api.session_active():
        return None
    app = api.frontmost()
    if app is None or app["bundleIdentifier"] in _LOCK_SCREEN_BUNDLES:
        return None
    return app


def capture_target(excluded_process_ids: list[int] | None = None) -> dict[str, Any]:
    """Capture the frontmost application after an explicit dictation start.

    macOS has no Windows HWND. ``handle`` carries the PID for compatibility;
    insertion also requires the original PID and bundle ID to remain frontmost.
    """
    api = _get_api()
    # Only explicit capture/start reaches this path. Startup getInfo never
    # requests TCC prompts, and an already granted client is never re-prompted.
    if not api.accessibility_trusted():
        _require_permission(api, prompt=True)
    else:
        _require_permission(api)
    app = _active_app(api)
    if not app or app["processId"] <= 0:
        raise RuntimeError("Dictation requires the unlocked, active macOS desktop.")
    if app["processId"] in {os.getpid(), *(excluded_process_ids or [])}:
        raise RuntimeError("Select a text field in another application before starting dictation.")
    if api.password_field_focused(app["processId"]):
        raise RuntimeError("Dictation is unavailable in a password field.")
    return {"handle": app["processId"], **app}


def _plain_text(text: str) -> str:
    if not isinstance(text, str):
        raise TypeError("Dictation text must be a string.")
    text = text.replace("\r\n", " ").replace("\r", " ").replace("\n", " ").replace("\t", " ")
    return "".join(character for character in text if ord(character) >= 32 and ord(character) != 127)


def _batches(text: str):
    """Bound each event while keeping every UTF-16 surrogate pair together."""
    batch: list[str] = []
    units = 0
    for character in text:
        width = len(character.encode("utf-16-le")) // 2
        if batch and units + width > _MAX_UNITS_PER_EVENT:
            yield "".join(batch)
            batch, units = [], 0
        batch.append(character)
        units += width
    if batch:
        yield "".join(batch)


def _matches(app: dict[str, Any] | None, target: dict[str, Any]) -> bool:
    return bool(app and app["processId"] == target["processId"]
                and app["bundleIdentifier"] == target["bundleIdentifier"])


def insert_text(target: dict[str, Any], text: str) -> dict[str, Any]:
    """Queue text only while the captured app remains frontmost.

    This synchronous function belongs on a worker thread. Modifier release is
    bounded by one second. If focus changes between batches, no further text is
    queued. macOS offers no delivery acknowledgement, so events are not retried.
    """
    if (not isinstance(target, dict) or type(target.get("processId")) is not int
            or type(target.get("handle")) is not int
            or target["processId"] <= 0 or target.get("handle") != target["processId"]
            or not isinstance(target.get("bundleIdentifier"), str)):
        raise ValueError("The dictation target is invalid; start dictation again.")
    plain = _plain_text(text)
    if not plain:
        return {"inserted": False, "count": 0, "reason": "No text to insert."}
    # Validate encoding before any native event is posted.
    plain.encode("utf-16-le")
    api = _get_api()
    count = 0
    with _INPUT_LOCK:
        _require_permission(api)
        deadline = time.monotonic() + _MODIFIER_TIMEOUT
        while api.modifiers_pressed():
            if not _matches(_active_app(api), target):
                return {"inserted": False, "count": 0, "reason": "The selected application is no longer in front."}
            if time.monotonic() >= deadline:
                return {"inserted": False, "count": 0, "reason": "Release Command, Control, Option, Shift and Fn to type dictation."}
            time.sleep(0.02)
        for batch in _batches(plain):
            _require_permission(api)
            if not _matches(_active_app(api), target):
                return {"inserted": False, "count": count, "text": plain[:count],
                        "reason": "The selected application is no longer in front. Remaining text was not inserted."}
            if api.modifiers_pressed():
                return {"inserted": False, "count": count, "text": plain[:count],
                        "reason": "A modifier key was pressed. Remaining text was not inserted."}
            if api.password_field_focused(target["processId"]):
                return {"inserted": False, "count": count, "text": plain[:count],
                        "reason": "Dictation is unavailable in a password field."}
            try:
                api.post_unicode(batch)
            except Exception as error:
                raise RuntimeError(
                    f"macOS could not queue all dictation text after {count} characters. "
                    "Some text may already have been inserted; it was not retried."
                ) from error
            count += len(batch)
    return {"inserted": True, "count": count, "text": plain, "delivery": "queued"}


def input_self_test() -> dict[str, Any]:
    raise RuntimeError(
        "Automated native typing verification is currently Windows-only. "
        "macOS cursor insertion needs a live Mac acceptance check with Accessibility permission."
    )
