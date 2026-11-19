"""Native Windows interface for the Spur AIZO ring protocol adapter.

Bluetooth work stays on one asyncio thread. Tk is updated only from its own
thread through the event queue; creating the window never scans or connects.
"""

from __future__ import annotations

import argparse
import asyncio
import concurrent.futures
from datetime import datetime
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import tkinter as tk
from tkinter import filedialog, messagebox, ttk
from typing import Any, Callable, Coroutine

from . import __version__


BACKGROUND = "#F5F3ED"
WHITE = "#FFFFFF"
INK = "#182B3A"
NAVY = "#142E40"
MUTED = "#687782"
LINE = "#E2E6E6"
TEAL = "#18736D"
TEAL_LIGHT = "#E5F2ED"
ERROR = "#A33F35"


def default_data_dir() -> Path:
    base = Path(os.environ.get("LOCALAPPDATA", str(Path.home() / ".local" / "share")))
    return base / "Spur" / "RingDesktop"


def format_size(size: Any) -> str:
    try:
        number = max(0, int(size))
    except (TypeError, ValueError):
        return "—"
    if number < 1024:
        return f"{number} B"
    if number < 1024 * 1024:
        return f"{number / 1024:.1f} KB"
    return f"{number / (1024 * 1024):.1f} MB"


def format_date(value: Any) -> str:
    if value in (None, ""):
        return "—"
    try:
        if isinstance(value, (int, float)):
            stamp = datetime.fromtimestamp(value / 1000 if value > 10**11 else value)
        else:
            stamp = datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone()
        return stamp.strftime("%d %b %Y, %H:%M")
    except (ValueError, OSError, TypeError, OverflowError):
        return str(value)


class AsyncWorker:
    """Own the Bluetooth asyncio loop and stop it without leaving pending tasks."""

    def __init__(self) -> None:
        self.loop: asyncio.AbstractEventLoop | None = None
        self.startup_error: Exception | None = None
        self.stop_requested = threading.Event()
        self.ready = threading.Event()
        self.thread = threading.Thread(target=self._run, name="Spur Bluetooth", daemon=True)
        self.thread.start()
        if not self.ready.wait(timeout=5):
            self.stop_requested.set()
            raise RuntimeError("The Windows Bluetooth worker could not start within 5 seconds. Check this app's local networking permissions, then try again.")
        if self.startup_error is not None:
            raise RuntimeError(f"The Windows Bluetooth worker could not start: {self.startup_error}") from self.startup_error

    def _run(self) -> None:
        try:
            self.loop = asyncio.new_event_loop()
        except Exception as error:
            self.startup_error = error
            self.ready.set()
            return
        asyncio.set_event_loop(self.loop)
        if self.stop_requested.is_set():
            self.ready.set()
            self.loop.close()
            return
        self.loop.call_soon(self.ready.set)
        try:
            self.loop.run_forever()
        finally:
            pending = asyncio.all_tasks(self.loop)
            for task in pending:
                task.cancel()
            if pending:
                self.loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
            self.loop.run_until_complete(self.loop.shutdown_asyncgens())
            self.loop.close()

    def submit(self, coroutine: Coroutine[Any, Any, Any]) -> concurrent.futures.Future:
        if self.loop is None or not self.loop.is_running():
            coroutine.close()
            raise RuntimeError("The Bluetooth worker is not running.")
        return asyncio.run_coroutine_threadsafe(coroutine, self.loop)

    def stop(self) -> None:
        self.stop_requested.set()
        if self.loop is not None and self.loop.is_running():
            self.loop.call_soon_threadsafe(self.loop.stop)


class SpurRingApp:
    def __init__(
        self,
        root: tk.Tk,
        data_dir: Path | None = None,
        client_factory: Callable[..., Any] | None = None,
    ) -> None:
        self.root = root
        self.data_dir = Path(data_dir or default_data_dir())
        self.events: queue.Queue[dict[str, Any]] = queue.Queue()
        self.worker = AsyncWorker()
        self.connection_state = "disconnected"
        self.operation: str | None = None
        self.device_rows: dict[str, dict[str, Any]] = {}
        self.recording_rows: dict[str, dict[str, Any]] = {}
        self.connected_name = "Your ring is offline"
        self.closing = False
        self._poll_id: str | None = None
        self._log_expanded = False
        self._shutdown_future: concurrent.futures.Future | None = None
        self.status_var = tk.StringVar(value="Disconnected")
        self.detail_var = tk.StringVar(value="Scan for your ring to get started.")
        self.ring_var = tk.StringVar(value=self.connected_name)
        self.device_hint = tk.StringVar(value="No scan yet · Keep your ring nearby and Bluetooth on.")
        self.library_hint = tk.StringVar(value="0 recordings saved on this computer")
        self.progress_var = tk.DoubleVar(value=0)
        self.progress_text = tk.StringVar(value="Ready when you are")
        self.notice_var = tk.StringVar(value="")
        self.root.title(f"Spur Ring — Desktop {__version__}")
        self.root.geometry("1120x780")
        self.root.minsize(960, 680)
        self.root.configure(background=BACKGROUND)
        self.root.protocol("WM_DELETE_WINDOW", self.close)
        self._style()
        self._build_ui()
        if client_factory is None:
            from .transport import RingClient

            client_factory = RingClient
        try:
            self.client = client_factory(data_dir=self.data_dir, on_event=self.events.put)
        except Exception:
            self.worker.stop()
            raise
        self.refresh_recordings()
        self._update_controls()
        self._log("Spur Ring Desktop opened. Scan to discover nearby AIZO rings.")
        self._poll_id = self.root.after(75, self._drain_events)

    def _style(self) -> None:
        style = ttk.Style(self.root)
        style.theme_use("clam")
        style.configure(".", font=("Segoe UI", 10), foreground=INK)
        style.configure("TFrame", background=BACKGROUND)
        style.configure("Card.TFrame", background=WHITE)
        style.configure("TLabel", background=BACKGROUND, foreground=INK)
        style.configure("Card.TLabel", background=WHITE)
        style.configure("Muted.TLabel", foreground=MUTED)
        style.configure("CardMuted.TLabel", foreground=MUTED, background=WHITE)
        style.configure("Title.TLabel", font=("Segoe UI Semibold", 25))
        style.configure("Section.TLabel", font=("Segoe UI Semibold", 15), background=WHITE)
        style.configure("TButton", background=WHITE, foreground=INK, padding=(14, 9), borderwidth=1)
        style.map("TButton", background=[("active", "#EAF0EE"), ("disabled", "#F1F2F1")], foreground=[("disabled", "#A0A8AA")])
        style.configure("Primary.TButton", background=TEAL, foreground=WHITE, borderwidth=0)
        style.map("Primary.TButton", background=[("active", "#145E59"), ("disabled", "#C7D8D2")], foreground=[("disabled", "#F8FAF9")])
        style.configure("Small.TButton", padding=(11, 5))
        style.configure("Treeview", background=WHITE, fieldbackground=WHITE, foreground=INK, rowheight=34, borderwidth=0, font=("Segoe UI", 10))
        style.configure("Treeview.Heading", background="#F7F8F6", foreground=MUTED, font=("Segoe UI", 9), padding=(9, 8), relief="flat")
        style.map("Treeview", background=[("selected", TEAL_LIGHT)], foreground=[("selected", INK)])
        style.configure("Horizontal.TProgressbar", background=TEAL, troughcolor="#E9EEEA", borderwidth=0, thickness=6)
        style.configure("Vertical.TScrollbar", background="#DDE3DF", troughcolor=WHITE, borderwidth=0, arrowsize=12)

    def _build_ui(self) -> None:
        self.root.grid_columnconfigure(1, weight=1)
        self.root.grid_rowconfigure(0, weight=1)
        sidebar = tk.Frame(self.root, width=218, bg=NAVY, padx=24, pady=29)
        sidebar.grid(row=0, column=0, sticky="nsew")
        sidebar.grid_propagate(False)
        sidebar.grid_columnconfigure(0, weight=1)
        tk.Label(sidebar, text="spur", font=("Segoe UI Semibold", 35), bg=NAVY, fg="#F7F7EE", anchor="w").grid(row=0, column=0, sticky="w")
        tk.Label(sidebar, text="RING DESKTOP", font=("Segoe UI", 9), bg=NAVY, fg="#A9C5C9", anchor="w").grid(row=1, column=0, sticky="w", pady=(0, 31))
        ring = tk.Canvas(sidebar, width=152, height=146, bg=NAVY, highlightthickness=0)
        ring.grid(row=2, column=0, sticky="w")
        ring.create_oval(22, 20, 128, 126, outline="#385769", width=18)
        ring.create_oval(17, 14, 124, 122, outline="#B9C9B4", width=11)
        ring.create_arc(17, 14, 124, 122, start=30, extent=99, outline="#F7E9BC", width=11, style="arc")
        self.sidebar_status = tk.Label(sidebar, textvariable=self.status_var, bg="#294454", fg="#E6EBDD", font=("Segoe UI Semibold", 10), padx=12, pady=7)
        self.sidebar_status.grid(row=3, column=0, sticky="w", pady=(15, 10))
        tk.Label(sidebar, textvariable=self.ring_var, wraplength=170, justify="left", font=("Segoe UI", 10), bg=NAVY, fg="#C1D0D4").grid(row=4, column=0, sticky="w")
        tk.Frame(sidebar, height=1, bg="#345061").grid(row=5, column=0, sticky="ew", pady=26)
        tk.Label(sidebar, text="IDEAS GO PLACES.", font=("Segoe UI Semibold", 9), bg=NAVY, fg="#D7DFC8").grid(row=6, column=0, sticky="w")
        tk.Label(sidebar, text="Keep the moments.\nMake something of them.", justify="left", font=("Segoe UI", 10), bg=NAVY, fg="#A9BEC7", pady=10).grid(row=7, column=0, sticky="w")
        sidebar.grid_rowconfigure(8, weight=1)
        tk.Label(sidebar, text=f"Windows preview · {__version__}\nRing connection verified\nRecording download pending", font=("Segoe UI", 9), justify="left", bg=NAVY, fg="#91AAB6").grid(row=9, column=0, sticky="sw")

        main = ttk.Frame(self.root, padding=(30, 25, 30, 20))
        main.grid(row=0, column=1, sticky="nsew")
        main.grid_columnconfigure(0, weight=1)
        main.grid_rowconfigure(4, weight=1)
        ttk.Label(main, text="Your ideas, within reach.", style="Title.TLabel").grid(row=0, column=0, sticky="w")
        ttk.Label(main, text="Connect your ring and bring your recordings to this computer.", style="Muted.TLabel").grid(row=1, column=0, sticky="w", pady=(7, 16))

        self.notice = tk.Label(main, textvariable=self.notice_var, bg="#FAE9E1", fg=ERROR, font=("Segoe UI", 10), wraplength=720, justify="left", anchor="w", padx=12, pady=9)
        self.notice.grid(row=2, column=0, sticky="ew", pady=(0, 12))
        self.notice.grid_remove()

        device_card = ttk.Frame(main, style="Card.TFrame", padding=18)
        device_card.grid(row=3, column=0, sticky="ew", pady=(0, 16))
        device_card.grid_columnconfigure(0, weight=1)
        device_header = ttk.Frame(device_card, style="Card.TFrame")
        device_header.grid(row=0, column=0, sticky="ew")
        device_header.grid_columnconfigure(0, weight=1)
        ttk.Label(device_header, text="01  Your ring", style="Section.TLabel").grid(row=0, column=0, sticky="w")
        self.scan_button = ttk.Button(device_header, text="Scan for rings", style="Primary.TButton", command=self.scan)
        self.scan_button.grid(row=0, column=1, padx=(10, 0))
        self.devices = ttk.Treeview(device_card, columns=("name", "signal", "support"), show="headings", height=3, selectmode="browse")
        self.devices.heading("name", text="NEARBY DEVICE", anchor="w")
        self.devices.heading("signal", text="SIGNAL", anchor="w")
        self.devices.heading("support", text="COMPATIBILITY", anchor="w")
        self.devices.column("name", minwidth=180, width=335, stretch=True)
        self.devices.column("signal", minwidth=85, width=90, stretch=False)
        self.devices.column("support", minwidth=130, width=135, stretch=False)
        self.devices.tag_configure("unsupported", foreground="#929C9F")
        self.devices.grid(row=1, column=0, sticky="ew", pady=(14, 8))
        self.devices.bind("<<TreeviewSelect>>", lambda _: self._update_controls())
        device_footer = ttk.Frame(device_card, style="Card.TFrame")
        device_footer.grid(row=2, column=0, sticky="ew")
        device_footer.grid_columnconfigure(0, weight=1)
        ttk.Label(device_footer, textvariable=self.device_hint, style="CardMuted.TLabel", wraplength=350).grid(row=0, column=0, sticky="w")
        self.disconnect_button = ttk.Button(device_footer, text="Disconnect", style="Small.TButton", command=self.disconnect)
        self.disconnect_button.grid(row=0, column=1, padx=(8, 0))
        self.connect_button = ttk.Button(device_footer, text="Connect", style="Small.TButton", command=self.connect)
        self.connect_button.grid(row=0, column=2, padx=(8, 0))

        library = ttk.Frame(main, style="Card.TFrame", padding=18)
        library.grid(row=4, column=0, sticky="nsew")
        library.grid_columnconfigure(0, weight=1)
        library.grid_rowconfigure(2, weight=1)
        library_header = ttk.Frame(library, style="Card.TFrame")
        library_header.grid(row=0, column=0, sticky="ew")
        library_header.grid_columnconfigure(0, weight=1)
        ttk.Label(library_header, text="02  Your recordings", style="Section.TLabel").grid(row=0, column=0, sticky="w")
        self.sync_button = ttk.Button(library_header, text="Sync recordings", style="Primary.TButton", command=self.sync)
        self.sync_button.grid(row=0, column=1, padx=(10, 0))
        ttk.Label(library, textvariable=self.library_hint, style="CardMuted.TLabel").grid(row=1, column=0, sticky="w", pady=(7, 12))
        list_frame = ttk.Frame(library, style="Card.TFrame")
        list_frame.grid(row=2, column=0, sticky="nsew")
        list_frame.grid_columnconfigure(0, weight=1)
        list_frame.grid_rowconfigure(0, weight=1)
        self.recordings = ttk.Treeview(list_frame, columns=("name", "date", "size"), show="headings", height=4, selectmode="browse")
        self.recordings.heading("name", text="RECORDING", anchor="w")
        self.recordings.heading("date", text="SAVED", anchor="w")
        self.recordings.heading("size", text="SIZE", anchor="w")
        self.recordings.column("name", minwidth=175, width=300, stretch=True)
        self.recordings.column("date", minwidth=150, width=155, stretch=False)
        self.recordings.column("size", minwidth=70, width=75, stretch=False)
        self.recordings.grid(row=0, column=0, sticky="nsew")
        scrollbar = ttk.Scrollbar(list_frame, orient="vertical", command=self.recordings.yview)
        scrollbar.grid(row=0, column=1, sticky="ns")
        self.recordings.configure(yscrollcommand=scrollbar.set)
        self.empty_library = ttk.Label(list_frame, text="Your next idea starts here.\nConnect your ring, then sync to save its recordings.", style="CardMuted.TLabel", justify="center", anchor="center")
        self.empty_library.place(relx=0.5, rely=0.60, anchor="center")
        self.recordings.bind("<<TreeviewSelect>>", lambda _: self._update_controls())
        self.recordings.bind("<Double-1>", lambda _: self.play_recording())
        progress_row = ttk.Frame(library, style="Card.TFrame")
        progress_row.grid(row=3, column=0, sticky="ew", pady=(13, 12))
        progress_row.grid_columnconfigure(0, weight=1)
        ttk.Progressbar(progress_row, maximum=100, variable=self.progress_var).grid(row=0, column=0, sticky="ew", padx=(0, 12))
        ttk.Label(progress_row, textvariable=self.progress_text, style="CardMuted.TLabel").grid(row=0, column=1, sticky="e")
        actions = ttk.Frame(library, style="Card.TFrame")
        actions.grid(row=4, column=0, sticky="ew")
        actions.grid_columnconfigure(2, weight=1)
        self.play_button = ttk.Button(actions, text="Play", style="Small.TButton", command=self.play_recording)
        self.play_button.grid(row=0, column=0, sticky="w")
        self.export_button = ttk.Button(actions, text="Export…", style="Small.TButton", command=self.export_recording)
        self.export_button.grid(row=0, column=1, sticky="w", padx=8)
        ttk.Button(actions, text="Open folder", style="Small.TButton", command=self.open_folder).grid(row=0, column=3, sticky="e")
        ttk.Button(actions, text="↻", style="Small.TButton", width=3, command=self.refresh_recordings).grid(row=0, column=4, sticky="e", padx=(8, 0))

        self.log_toggle = ttk.Button(main, text="▸  Activity", style="Small.TButton", command=self.toggle_log)
        self.log_toggle.grid(row=5, column=0, sticky="w", pady=(13, 0))
        self.log_frame = ttk.Frame(main)
        self.log_frame.grid(row=6, column=0, sticky="ew", pady=(8, 0))
        self.log_frame.grid_columnconfigure(0, weight=1)
        self.log_box = tk.Text(self.log_frame, height=5, bg="#ECF0EC", fg="#4A6069", relief="flat", wrap="word", font=("Consolas", 9), padx=10, pady=8, state="disabled")
        self.log_box.grid(row=0, column=0, sticky="ew")
        self.log_frame.grid_remove()
        ttk.Label(main, textvariable=self.detail_var, style="Muted.TLabel", wraplength=730).grid(row=7, column=0, sticky="w", pady=(10, 0))

    def _log(self, message: str) -> None:
        stamp = datetime.now().strftime("%H:%M:%S")
        self.log_box.configure(state="normal")
        self.log_box.insert("end", f"{stamp}  {message}\n")
        if int(self.log_box.index("end-1c").split(".")[0]) > 700:
            self.log_box.delete("1.0", "101.0")
        self.log_box.see("end")
        self.log_box.configure(state="disabled")

    def toggle_log(self) -> None:
        self._log_expanded = not self._log_expanded
        if self._log_expanded:
            self.log_frame.grid()
            self.log_toggle.configure(text="▾  Activity")
        else:
            self.log_frame.grid_remove()
            self.log_toggle.configure(text="▸  Activity")

    def _notice(self, message: str = "") -> None:
        self.notice_var.set(message)
        if message:
            self.notice.grid()
        else:
            self.notice.grid_remove()

    def _selected_device(self) -> dict[str, Any] | None:
        selection = self.devices.selection()
        return self.device_rows.get(selection[0]) if selection else None

    def _selected_recording(self) -> dict[str, Any] | None:
        selection = self.recordings.selection()
        return self.recording_rows.get(selection[0]) if selection else None

    @staticmethod
    def _enabled(button: ttk.Button, enabled: bool) -> None:
        button.configure(state="normal" if enabled else "disabled")

    def _update_controls(self) -> None:
        idle = self.operation is None and not self.closing
        connected = self.connection_state in {"connected", "syncing"}
        selected = self._selected_device()
        self._enabled(self.scan_button, idle and not connected)
        self._enabled(self.connect_button, idle and not connected and bool(selected and selected.get("compatible")))
        self._enabled(self.disconnect_button, idle and connected)
        self._enabled(self.sync_button, idle and self.connection_state == "connected")
        recording = self._selected_recording()
        self._enabled(self.play_button, bool(recording) and not self.closing)
        self._enabled(self.export_button, bool(recording) and not self.closing)

    def _submit(self, name: str, coroutine: Coroutine[Any, Any, Any]) -> None:
        if self.operation is not None or self.closing:
            coroutine.close()
            return
        self._notice()
        self.operation = name
        self._update_controls()
        future = self.worker.submit(coroutine)

        def completed(done: concurrent.futures.Future) -> None:
            try:
                event = {"type": "operation_complete", "operation": name, "result": done.result()}
            except (Exception, concurrent.futures.CancelledError) as error:
                event = {"type": "operation_complete", "operation": name, "error": str(error) or error.__class__.__name__}
            self.events.put(event)

        future.add_done_callback(completed)

    def scan(self) -> None:
        self.device_hint.set("Scanning nearby Bluetooth devices…")
        self.detail_var.set("Keep the ring close and wait for the scan to finish.")
        self.scan_button.configure(text="Scanning…")
        self._submit("scan", self.client.scan())

    def connect(self) -> None:
        selected = self._selected_device()
        if not selected or not selected.get("compatible"):
            return
        self.connected_name = str(selected.get("name") or "Spur Ring")
        self.ring_var.set(self.connected_name)
        self._submit("connect", self.client.connect(str(selected["id"])))

    def disconnect(self) -> None:
        self._submit("disconnect", self.client.disconnect())

    def sync(self) -> None:
        self.progress_var.set(0)
        self.progress_text.set("Starting sync…")
        self._submit("sync", self.client.sync())

    def _render_devices(self, devices: list[dict[str, Any]]) -> None:
        self.devices.delete(*self.devices.get_children())
        self.device_rows.clear()
        for index, device in enumerate(devices):
            if not device.get("id"):
                continue
            row = f"device_{index}"
            self.device_rows[row] = device
            signal = f"{device['rssi']} dBm" if device.get("rssi") is not None else "—"
            compatible = bool(device.get("compatible"))
            self.devices.insert("", "end", iid=row, values=(device.get("name") or device["id"], signal, "AIZO ring" if compatible else "Unsupported"), tags=() if compatible else ("unsupported",))
        count = sum(bool(item.get("compatible")) for item in self.device_rows.values())
        self.device_hint.set(f"{count} compatible ring{'s' if count != 1 else ''} found · Select a ring to connect." if count else "No compatible rings found · Bring the ring closer and scan again.")
        self.detail_var.set("The ring may need to be disconnected from its mobile app before it can connect here.")

    def refresh_recordings(self) -> None:
        selected = self._selected_recording()
        selected_path = str(selected.get("path")) if selected else None
        try:
            files = self.client.list_recordings()
        except Exception as error:
            self._notice(f"Could not load saved recordings: {error}")
            self._log(f"Library error: {error}")
            return
        self.recordings.delete(*self.recordings.get_children())
        self.recording_rows.clear()
        for index, recording in enumerate(files):
            row = f"recording_{index}"
            self.recording_rows[row] = recording
            self.recordings.insert("", "end", iid=row, values=(recording.get("name", Path(str(recording.get("path", "Recording"))).name), format_date(recording.get("timestamp")), format_size(recording.get("size"))))
            if str(recording.get("path")) == selected_path:
                self.recordings.selection_set(row)
        count = len(self.recording_rows)
        self.library_hint.set(f"{count} recording{'s' if count != 1 else ''} saved on this computer")
        if count:
            self.empty_library.place_forget()
        else:
            self.empty_library.place(relx=0.5, rely=0.60, anchor="center")
        self._update_controls()

    def _recording_path(self) -> Path | None:
        recording = self._selected_recording()
        if not recording or not recording.get("path"):
            return None
        path = Path(str(recording["path"]))
        if not path.is_file():
            self._notice("This recording is no longer on this computer. Refresh the library to update the list.")
            return None
        return path.resolve()

    @staticmethod
    def _open_path(path: Path) -> None:
        if sys.platform == "win32":
            os.startfile(str(path))
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(path)])
        else:
            subprocess.Popen(["xdg-open", str(path)])

    def play_recording(self) -> None:
        path = self._recording_path()
        if path is None:
            return
        try:
            self._open_path(path)
            self._log(f"Opened recording: {path.name}")
        except OSError as error:
            self._notice(f"Could not open the recording. Choose a media player for {path.suffix or 'this file type'} in Windows. {error}")

    def export_recording(self) -> None:
        source = self._recording_path()
        if source is None:
            return
        destination = filedialog.asksaveasfilename(parent=self.root, title="Export recording", initialfile=source.name, defaultextension=source.suffix, filetypes=[("Recording", f"*{source.suffix}"), ("All files", "*.*")])
        if not destination:
            return
        try:
            if Path(destination).resolve() != source:
                shutil.copy2(source, destination)
            self._notice()
            self.detail_var.set(f"Exported {source.name}.")
            self._log(f"Exported recording to {destination}")
        except OSError as error:
            self._notice(f"The recording could not be exported: {error}")

    def open_folder(self) -> None:
        try:
            folder = self.data_dir / "recordings"
            folder.mkdir(parents=True, exist_ok=True)
            self._open_path(folder.resolve())
        except OSError as error:
            self._notice(f"Could not open the recordings folder: {error}")

    def _handle_event(self, event: dict[str, Any]) -> None:
        kind = event.get("type")
        if kind == "status":
            state = str(event.get("status", "disconnected"))
            self.connection_state = state
            self.status_var.set({"disconnected": "Disconnected", "connecting": "Connecting…", "authenticating": "Authenticating…", "connected": "Connected", "syncing": "Syncing recordings…"}.get(state, state.title()))
            self.sidebar_status.configure(bg=TEAL if state == "connected" else "#294454")
            if state == "disconnected":
                self.ring_var.set("Your ring is offline")
            elif state == "connected":
                self.ring_var.set(self.connected_name)
            message = event.get("message")
            if message:
                self.detail_var.set(str(message))
                self._log(str(message))
            self._update_controls()
        elif kind == "log":
            self._log(str(event.get("message", "")))
        elif kind == "progress":
            try:
                progress = min(100.0, max(0.0, float(event.get("progress", 0))))
            except (TypeError, ValueError):
                progress = 0
            self.progress_var.set(progress)
            self.progress_text.set(str(event.get("message") or f"{progress:.0f}%"))
        elif kind == "recording":
            self.refresh_recordings()
        elif kind == "error":
            message = str(event.get("message") or "An unexpected error occurred.")
            self._notice(message)
            self.detail_var.set("Open Activity for connection details.")
            self._log(f"Error: {message}")
        elif kind == "devices":
            self._render_devices(event.get("devices", []))
        elif kind == "operation_complete":
            operation = event.get("operation")
            self.operation = None
            self.scan_button.configure(text="Scan for rings")
            error = event.get("error")
            if error:
                self._notice(str(error))
                self._log(f"{str(operation).capitalize()} failed: {error}")
                if operation == "scan":
                    self.device_hint.set("Scan failed · Check Bluetooth and try again.")
                elif operation == "connect":
                    self.connection_state = "disconnected"
                    self.status_var.set("Disconnected")
                    self.ring_var.set("Your ring is offline")
                elif operation == "sync":
                    self.progress_text.set("Sync interrupted")
            elif operation == "scan":
                self._render_devices(event.get("result") or [])
            elif operation == "sync":
                self.refresh_recordings()
                self.progress_var.set(100)
                self.progress_text.set("Sync complete")
            self._update_controls()

    def _drain_events(self) -> None:
        if self.closing:
            return
        for _ in range(250):
            try:
                event = self.events.get_nowait()
            except queue.Empty:
                break
            self._handle_event(event)
        self._poll_id = self.root.after(75, self._drain_events)

    def close(self) -> None:
        if self.closing:
            return
        self.closing = True
        self._update_controls()
        self.detail_var.set("Disconnecting your ring…")
        if self._poll_id is not None:
            self.root.after_cancel(self._poll_id)
            self._poll_id = None

        async def shutdown() -> None:
            current = asyncio.current_task()
            # End scan/sync before disconnecting so the protocol client is not
            # used concurrently during application shutdown.
            tasks = [task for task in asyncio.all_tasks() if task is not current]
            for task in tasks:
                task.cancel()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
            try:
                await asyncio.wait_for(self.client.disconnect(), timeout=4)
            except Exception:
                pass

        self._shutdown_future = self.worker.submit(shutdown())
        self.root.after(50, self._finish_close)

    def _finish_close(self) -> None:
        if self._shutdown_future is not None and not self._shutdown_future.done():
            self.root.after(50, self._finish_close)
            return
        self.worker.stop()
        self.root.destroy()


def self_test() -> dict[str, Any]:
    """Exercise real widgets and cross-thread events with no hardware or writes."""

    class LocalClient:
        def __init__(self, data_dir: Path, on_event: Callable[[dict], None]) -> None:
            self.on_event = on_event
            self.calls: list[str] = []

        def list_recordings(self) -> list:
            return []

        async def scan(self) -> list:
            self.calls.append("scan")
            return []

        async def disconnect(self) -> None:
            self.calls.append("disconnect")

    window = tk.Tk()
    window.withdraw()
    with tempfile.TemporaryDirectory(prefix="spur-ui-check-") as temporary:
        app = SpurRingApp(window, Path(temporary), LocalClient)
        try:
            assert app.client.calls == [], "Startup must not access Bluetooth"
            assert str(app.connect_button["state"]) == "disabled"
            assert str(app.sync_button["state"]) == "disabled"
            app.scan()
            deadline = time.monotonic() + 3
            while app.operation is not None and time.monotonic() < deadline:
                window.update()
                time.sleep(0.01)
            assert app.operation is None, "Async scan result was not dispatched"
            assert app.client.calls == ["scan"], "Scan must use the async worker"
            assert "No compatible rings" in app.device_hint.get()
            app._handle_event({"type": "progress", "progress": 41})
            assert app.progress_var.get() == 41
            app._handle_event({"type": "error", "message": "Self-test event"})
            assert app.notice_var.get() == "Self-test event"
            app._notice()
            app._render_devices([{"id": "unsupported-test", "name": "Unsupported test device", "rssi": -70, "compatible": False}])
            app.devices.selection_set("device_0")
            app._update_controls()
            assert str(app.connect_button["state"]) == "disabled"
            app._render_devices([])
            app._handle_event({"type": "status", "status": "connected", "message": "Self-test only"})
            assert str(app.sync_button["state"]) == "normal"
            app._handle_event({"type": "status", "status": "disconnected"})
            app.toggle_log()
            app.toggle_log()
            app.events.put({"type": "log", "message": "Queue handling verified"})
            app._drain_events()
            assert "Queue handling verified" in app.log_box.get("1.0", "end")
            window.update_idletasks()
        finally:
            app.close()
            window.mainloop()
            app.worker.thread.join(timeout=5)
            assert not app.worker.thread.is_alive(), "Async worker did not stop"
    return {"ui": "passed", "bluetooth_used": False, "checks": ["startup", "async worker dispatch", "device compatibility", "progress", "error display", "event queue", "clean shutdown"]}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Spur Ring Desktop for Windows")
    parser.add_argument("--self-test", action="store_true", help="Check the UI without Bluetooth or network access")
    parser.add_argument("--diagnose", action="store_true", help="Print local Bluetooth and dependency diagnostics")
    parser.add_argument("--test-connection", metavar="ADDRESS", help="Explicitly authenticate a selected ring and read its recording count")
    parser.add_argument("--report", type=Path, help="Write self-test or diagnostic JSON to this file")
    parser.add_argument("--data-dir", type=Path, default=None, help="Use a custom local recording directory")
    args = parser.parse_args(argv)
    if args.test_connection:
        from .transport import test_connection

        result = asyncio.run(test_connection(args.test_connection, args.data_dir or default_data_dir()))
        report = json.dumps(result, indent=2, default=str)
        if args.report:
            args.report.write_text(report + "\n", encoding="utf-8")
        if sys.stdout is not None:
            print(report)
        return 0 if result.get('authenticated') and 'error' not in result else 1
    if args.self_test:
        report = json.dumps(self_test(), indent=2)
        if args.report:
            args.report.write_text(report + "\n", encoding="utf-8")
        if sys.stdout is not None:
            print(report)
        return 0
    if args.diagnose:
        from .transport import diagnose

        result = diagnose()
        if asyncio.iscoroutine(result):
            result = asyncio.run(result)
        report = json.dumps(result, indent=2, default=str)
        if args.report:
            args.report.write_text(report + "\n", encoding="utf-8")
        if sys.stdout is not None:
            print(report)
        return 0
    window = tk.Tk()
    try:
        SpurRingApp(window, data_dir=args.data_dir)
    except Exception as error:
        messagebox.showerror("Spur Ring could not start", str(error), parent=window)
        window.destroy()
        return 1
    window.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
