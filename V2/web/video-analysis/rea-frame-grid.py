"""Bounded, offline native rea-video timestamped frame tiles for Spur."""
from __future__ import annotations

import argparse
import base64
import contextlib
import io
import json
import math
import os
from pathlib import Path
import socket
import subprocess
import sys


def offline(*_args, **_kwargs):
    raise OSError("Network and downloads are disabled for local frame grids")


def main():
    parser = argparse.ArgumentParser()
    for key in ("source", "video", "out", "ffmpeg", "ffprobe"):
        parser.add_argument("--" + key, required=True)
    parser.add_argument("--start", required=True, type=float)
    parser.add_argument("--end", required=True, type=float)
    args = parser.parse_args()
    if not all(math.isfinite(v) for v in (args.start, args.end)) or args.start < 0 or args.end <= args.start or args.end - args.start > 12:
        raise ValueError("Invalid local frame range")
    source, video, output = (Path(value).resolve() for value in (args.source, args.video, args.out))
    output.parent.mkdir(parents=True, exist_ok=True)
    sys.path.insert(0, str(source))
    os.environ["REA_VIDEO_HOME"] = str(output.parent / "home")
    os.environ["REA_VIDEO_MODELS"] = str(output.parent / "models")
    socket.socket.connect = offline
    socket.socket.connect_ex = offline
    socket.create_connection = offline
    tools = {"ffmpeg": str(Path(args.ffmpeg).resolve()), "ffprobe": str(Path(args.ffprobe).resolve())}
    original_popen = subprocess.Popen

    def media_popen(command, *pargs, **kwargs):
        if isinstance(command, (str, bytes)) or not command or kwargs.get("shell"):
            raise OSError("Only fixed media subprocesses are allowed")
        name = Path(str(command[0])).stem.lower()
        if name not in tools:
            raise OSError("Unsupported local media subprocess")
        safe = [tools[name], *command[1:]]
        if "-protocol_whitelist" not in safe:
            safe[1:1] = ["-protocol_whitelist", "file,pipe"]
        if os.name == "nt":
            kwargs["creationflags"] = kwargs.get("creationflags", 0) | subprocess.CREATE_NO_WINDOW
        return original_popen(safe, *pargs, **kwargs)

    subprocess.Popen = media_popen
    import rea_video
    import rea_video.util
    if not Path(rea_video.__file__).resolve().is_relative_to(source):
        raise RuntimeError("The configured rea-video source was not imported")
    rea_video.util.fetch = offline
    from PIL import Image
    from rea_video.cli import cmd_tiles
    from rea_video.media import video_info

    info = video_info(video)
    # Audio and video tracks can end a fraction apart; match the container range
    # accepted by the host, letting native extraction repeat the final frame.
    container_duration = float((info.raw.get("format") or {}).get("duration") or info.duration)
    if not math.isfinite(info.duration) or not math.isfinite(container_duration) or args.end > max(info.duration, container_duration) + 0.02 or not 0 < info.width <= 16384 or not 0 < info.height <= 16384 or info.width * info.height > 40_000_000 or not 0.1 <= info.width / info.height <= 10:
        raise ValueError("Unsupported local video dimensions or range")
    count = min(24, max(2, math.ceil((args.end - args.start) * 4)))
    capture = io.StringIO()
    with contextlib.redirect_stdout(capture):
        cmd_tiles(argparse.Namespace(video=str(video), start=args.start, end=args.end, every=(args.end - args.start) / count, cols=4, max=count, cell=256, out=str(output)))
    result = json.loads(capture.getvalue())
    rows = []
    for name in result.get("tiles", [])[:6]:
        row_path = Path(name).resolve()
        if not row_path.is_relative_to(output.parent) or not row_path.is_file():
            raise ValueError("Invalid local tile output")
        with Image.open(row_path) as original:
            if original.width * original.height > 16_000_000:
                raise ValueError("Local tile output exceeds its dimensions")
            rows.append(original.convert("RGB"))
    if not rows:
        raise ValueError("No local video frames were decoded")
    width, height = max(row.width for row in rows), sum(row.height for row in rows)
    if width * height > 32_000_000:
        raise ValueError("Local tile output exceeds its dimensions")
    image = Image.new("RGB", (width, height), (20, 20, 20))
    top = 0
    for row in rows:
        image.paste(row, (0, top))
        top += row.height
    image.thumbnail((1400, 3600))
    encoded = b""
    for _ in range(12):
        buffer = io.BytesIO()
        image.save(buffer, format="JPEG", quality=82, optimize=True)
        encoded = buffer.getvalue()
        if len(encoded) <= 512 * 1024:
            break
        image = image.resize((max(128, int(image.width * .85)), max(128, int(image.height * .85))))
    if not encoded or len(encoded) > 512 * 1024:
        raise ValueError("Local frame grid exceeds its size limit")
    print(json.dumps({"schemaVersion": 1, "contentType": "image/jpeg", "dataBase64": base64.b64encode(encoded).decode("ascii")}))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"Local frame grid failed ({type(exc).__name__}).", file=sys.stderr)
        sys.exit(1)
