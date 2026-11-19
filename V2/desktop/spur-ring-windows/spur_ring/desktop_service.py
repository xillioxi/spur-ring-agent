"""Private JSON-lines stdio bridge for the TypeScript desktop shell.

The process reads explicit method names from its parent; it never evaluates
source text, starts shell commands, or scans/connects without a request. Stdout
contains protocol records only. Run through service_launcher.py when frozen.
"""

from __future__ import annotations

import argparse
import asyncio
from contextlib import suppress
import json
import os
from pathlib import Path
import sys
import threading
from typing import Any, BinaryIO, Callable

from . import __version__
from .transport import RingClient, diagnose
from . import macos_input, windows_input


MAX_LINE_BYTES = 65536
MAX_PENDING_REQUESTS = 32
_EOF = object()


def default_data_dir() -> Path:
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Spur" / "RingDesktop"
    base = Path(os.environ.get("LOCALAPPDATA", str(Path.home() / ".local" / "share")))
    return base / "Spur" / "RingDesktop"


def _input_adapter():
    if sys.platform == "darwin":
        return macos_input
    if sys.platform == "win32":
        return windows_input
    raise RuntimeError("Cursor insertion is available on Windows and macOS only.")


def _input_permissions(prompt: bool = False) -> dict:
    if sys.platform == "darwin":
        return {"accessibility": macos_input.permission_status(prompt=prompt)}
    if sys.platform == "win32":
        return {"accessibility": {"supported": True, "available": True, "required": False, "granted": True}}
    return {"accessibility": {"supported": False, "available": False, "required": False, "granted": False,
                              "message": "Cursor insertion is available on Windows and macOS only."}}


def _stdout_record(record: dict) -> None:
    # ensure_ascii avoids depending on a console code page or UTF-8 mode.
    sys.stdout.write(json.dumps(record, ensure_ascii=True, allow_nan=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


class DesktopService:
    def __init__(self, data_dir: Path | None = None,
                 write: Callable[[dict], None] = _stdout_record,
                 client_factory: Callable[..., Any] = RingClient):
        self.write = write
        self.data_dir = Path(data_dir) if data_dir is not None else default_data_dir()
        self.client = client_factory(self.data_dir, self._event)
        self._shutdown = asyncio.Event()
        self._pending: dict[str, asyncio.Task] = {}
        self._loop: asyncio.AbstractEventLoop | None = None

    def _event(self, event: dict) -> None:
        record = {"kind": "event", "event": event}
        if self._loop is not None and threading.current_thread() is not threading.main_thread():
            self._loop.call_soon_threadsafe(self.write, record)
        else:
            self.write(record)

    def _failure(self, request_id: str, error: str) -> None:
        self.write({"kind": "result", "id": request_id, "error": error})

    async def dispatch(self, method: str, params: dict[str, Any]) -> Any:
        """Explicit public operations; arbitrary attributes are never invoked."""
        if method == "getInfo":
            return {"version": __version__, "platform": sys.platform,
                    "permissions": _input_permissions(),
                    "capabilities": {"cursorInsertion": sys.platform in ("win32", "darwin"),
                                     "ring_triggered_dictation": hasattr(self.client, "arm_dictation"),
                                     "ring_live_audio": False}}
        if method in ("getInputPermissions", "requestInputPermissions"):
            return await asyncio.to_thread(_input_permissions, method == "requestInputPermissions")
        if method == "scan":
            return await self.client.scan()
        if method == "diagnose":
            return await diagnose()
        if method == "connect":
            address = params.get("address")
            if not isinstance(address, str) or not address or len(address) > 128:
                raise ValueError("A valid ring address is required.")
            await self.client.connect(address)
            return {"connected": True}
        if method == "disconnect":
            await self.client.disconnect()
            return {"connected": False}
        if method == "sync":
            await self.client.sync()
            return self.client.list_recordings()
        if method == "listRecordings":
            return self.client.list_recordings()
        if method in ("armDictation", "disarmDictation"):
            operation = (getattr(self.client, "arm_dictation", None) if method == "armDictation"
                         else getattr(self.client, "disarm_dictation", None))
            if operation is None:
                raise RuntimeError("This backend does not yet support ring dictation controls.")
            await operation()
            return {"armed": method == "armDictation"}
        if method == "captureTarget":
            excluded = params.get("excludedProcessIds", [])
            if (not isinstance(excluded, list) or len(excluded) > 64
                    or any(type(value) is not int or value <= 0 or value > 0xFFFFFFFF for value in excluded)):
                raise ValueError("Excluded process IDs must be positive integers.")
            return await asyncio.to_thread(_input_adapter().capture_target, excluded)
        if method == "insertText":
            text = params.get("text")
            target = params.get("target")
            if not isinstance(text, str) or len(text) > 32768 or not isinstance(target, dict):
                raise ValueError("A valid target and dictation text are required.")
            return await asyncio.to_thread(_input_adapter().insert_text, target, text)
        if method == "inputSelfTest":
            return await asyncio.to_thread(_input_adapter().input_self_test)
        if method == "shutdown":
            self._shutdown.set()
            return {"stopping": True}
        raise ValueError(f"Unknown desktop service method: {method}")

    async def _handle(self, request_id: str, method: str, params: dict) -> None:
        try:
            result = await self.dispatch(method, params)
            self.write({"kind": "result", "id": request_id, "result": result})
        except asyncio.CancelledError:
            self._failure(request_id, "The desktop service is shutting down.")
            raise
        except Exception as error:
            self._failure(request_id, str(error) or type(error).__name__)
        finally:
            self._pending.pop(request_id, None)

    def accept(self, raw: bytes | str) -> None:
        request_id = ""
        try:
            if isinstance(raw, bytes):
                if len(raw) > MAX_LINE_BYTES:
                    raise ValueError("Desktop service request exceeds 64 KiB.")
                raw = raw.decode("utf-8")
            elif len(raw.encode("utf-8")) > MAX_LINE_BYTES:
                raise ValueError("Desktop service request exceeds 64 KiB.")
            request = json.loads(raw)
            if not isinstance(request, dict):
                raise ValueError("Desktop service requests must be JSON objects.")
            request_id = request.get("id", "")
            if not isinstance(request_id, str) or not request_id or len(request_id) > 128:
                request_id = ""
                raise ValueError("A string request ID of 1–128 characters is required.")
            method = request.get("method")
            params = request.get("params", {})
            if not isinstance(method, str) or not isinstance(params, dict):
                raise ValueError("A method name and object parameters are required.")
            if request_id in self._pending:
                raise ValueError("This desktop service request ID is already running.")
            if len(self._pending) >= MAX_PENDING_REQUESTS:
                raise ValueError("Too many desktop service requests are running.")
            task = asyncio.create_task(self._handle(request_id, method, params))
            self._pending[request_id] = task
        except (ValueError, TypeError, UnicodeError) as error:
            self._failure(request_id, str(error))

    async def close(self) -> None:
        tasks = list(self._pending.values())
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        with suppress(Exception):
            await asyncio.wait_for(self.client.disconnect(), timeout=8)

    async def run(self, stdin: BinaryIO | None = None) -> None:
        """Read from a daemon thread so shutdown never waits on an open stdin."""
        self._loop = asyncio.get_running_loop()
        stream = stdin if stdin is not None else sys.stdin.buffer
        messages: asyncio.Queue = asyncio.Queue(maxsize=64)

        def enqueue(value: Any) -> None:
            if self._shutdown.is_set():
                return
            try:
                messages.put_nowait(value)
            except asyncio.QueueFull:
                self._failure("", "Desktop service input queue is full.")
                self._shutdown.set()

        def read_stdin() -> None:
            try:
                while not self._shutdown.is_set():
                    line = stream.readline(MAX_LINE_BYTES + 1)
                    if not line:
                        self._loop.call_soon_threadsafe(enqueue, _EOF)
                        return
                    if len(line) > MAX_LINE_BYTES:
                        # Discard the rest in bounded pieces before accepting a
                        # new message. Never parse a tail as a separate request.
                        while line and not line.endswith(b"\n"):
                            line = stream.readline(MAX_LINE_BYTES + 1)
                        self._loop.call_soon_threadsafe(self._failure, "", "Desktop service request exceeds 64 KiB.")
                        continue
                    self._loop.call_soon_threadsafe(enqueue, line)
            except (OSError, ValueError) as error:
                if not self._loop.is_closed():
                    self._loop.call_soon_threadsafe(self._failure, "", f"Desktop service input closed: {error}")
                    self._loop.call_soon_threadsafe(enqueue, _EOF)

        threading.Thread(target=read_stdin, name="SpurServiceInput", daemon=True).start()
        stopping = asyncio.create_task(self._shutdown.wait())
        incoming: asyncio.Task | None = None
        try:
            while not self._shutdown.is_set():
                incoming = asyncio.create_task(messages.get())
                done, _ = await asyncio.wait((incoming, stopping), return_when=asyncio.FIRST_COMPLETED)
                if stopping in done:
                    break
                raw = incoming.result()
                incoming = None
                if raw is _EOF:
                    # Let already queued, immediate requests return before
                    # cancelling any long-running radio operations on EOF.
                    await asyncio.sleep(0)
                    break
                self.accept(raw)
        finally:
            self._shutdown.set()
            for task in (incoming, stopping):
                if task is not None:
                    task.cancel()
            await asyncio.gather(*(task for task in (incoming, stopping) if task is not None), return_exceptions=True)
            await self.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Spur Ring private desktop service")
    parser.add_argument("--data-dir", type=Path, default=None)
    args = parser.parse_args(argv)
    try:
        asyncio.run(DesktopService(args.data_dir).run())
        return 0
    except KeyboardInterrupt:
        return 0
    except Exception as error:
        # Startup failures also use the stdout protocol, rather than printing a
        # traceback into the parent's JSON parser. stderr remains for logging.
        _stdout_record({"kind": "event", "event": {"type": "error", "message": str(error)}})
        return 1
