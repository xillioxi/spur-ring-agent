"""Offline face candidate crops, not recognition or identity matching."""
from __future__ import annotations

import argparse
import base64
import io
import json
import math
import os
from pathlib import Path
import socket
import subprocess
import sys
import warnings


def offline(*_args, **_kwargs):
    raise OSError("Network and model downloads are disabled")


def install_offline_tools(ffmpeg=None, ffprobe=None):
    socket.socket.connect = offline
    socket.socket.connect_ex = offline
    socket.create_connection = offline
    tools = {key: str(Path(value).resolve()) for key, value in (("ffmpeg", ffmpeg), ("ffprobe", ffprobe)) if value}
    original_popen = subprocess.Popen

    def fixed_popen(command, *args, **kwargs):
        if isinstance(command, (str, bytes)) or not command or kwargs.get("shell"):
            raise OSError("Only fixed media subprocesses are allowed")
        name = Path(str(command[0])).stem.lower()
        if name not in tools:
            raise OSError("Unsupported media subprocess")
        safe = [tools[name], *command[1:]]
        if "-protocol_whitelist" not in safe:
            safe[1:1] = ["-protocol_whitelist", "file,pipe"]
        if os.name == "nt":
            kwargs["creationflags"] = kwargs.get("creationflags", 0) | subprocess.CREATE_NO_WINDOW
        return original_popen(safe, *args, **kwargs)

    subprocess.Popen = fixed_popen


def read_image(data):
    from PIL import Image, ImageOps
    Image.MAX_IMAGE_PIXELS = 24_000_000
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        with Image.open(data) as image:
            if image.format not in {"JPEG", "PNG", "WEBP"} or image.width * image.height > 24_000_000 or image.width < 16 or image.height < 16 or getattr(image, "n_frames", 1) != 1:
                raise ValueError("Unsupported photo format or dimensions")
            return ImageOps.exif_transpose(image).convert("RGB")


def face_boxes(image):
    import cv2
    import numpy as np
    cv2.setNumThreads(2)
    gray = cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2GRAY)
    scale = min(1.0, 2200 / max(gray.shape))
    if scale < 1:
        gray = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    gray = cv2.equalizeHist(gray)
    minimum = max(20, int(min(gray.shape) * .025))
    found = []
    for model, flip in (("haarcascade_frontalface_default.xml", False), ("haarcascade_profileface.xml", False), ("haarcascade_profileface.xml", True)):
        detector = cv2.CascadeClassifier(str(Path(cv2.data.haarcascades) / model))
        if detector.empty():
            continue
        for x, y, width, height in detector.detectMultiScale(cv2.flip(gray, 1) if flip else gray, scaleFactor=1.1, minNeighbors=5, minSize=(minimum, minimum)):
            if flip:
                x = gray.shape[1] - x - width
            box = tuple(int(round(value / scale)) for value in (x, y, width, height))
            found.append(box)
    selected = []
    for box in sorted(found, key=lambda value: (-value[2] * value[3], value[1], value[0])):
        x, y, width, height = box
        duplicate = False
        for ox, oy, ow, oh in selected:
            intersection = max(0, min(x + width, ox + ow) - max(x, ox)) * max(0, min(y + height, oy + oh) - max(y, oy))
            if intersection / max(1, min(width * height, ow * oh)) > .45:
                duplicate = True
                break
        if not duplicate:
            selected.append(box)
        if len(selected) >= 2:
            break
    return selected


def make_candidate(image, box, time):
    import cv2
    import numpy as np
    if box is None:
        left, top, right, bottom = 0, 0, image.width, image.height
    else:
        x, y, width, height = box
        left, top = max(0, int(x - width * .5)), max(0, int(y - height * .4))
        right, bottom = min(image.width, int(x + width * 1.5)), min(image.height, int(y + height * 2.0))
    crop = image.crop((left, top, right, bottom))
    gray = cv2.cvtColor(np.asarray(crop), cv2.COLOR_RGB2GRAY)
    # Retain small, clean derivatives between samples, not many full-resolution frames.
    crop.thumbnail((768, 768))
    context = image.copy()
    context.thumbnail((960, 960))
    return {"crop": crop, "context": context, "sourceTimeSeconds": time,
            "detection": "face" if box is not None else "manual",
            "cropBox": {"x": left / image.width, "y": top / image.height, "width": (right - left) / image.width, "height": (bottom - top) / image.height},
            "quality": {"sharpness": round(float(cv2.Laplacian(gray, cv2.CV_64F).var()), 3), "brightness": round(float(gray.mean()) / 255, 5)}}


def encode(image, side, budget):
    image = image.copy()
    image.thumbnail((side, side))
    for _ in range(12):
        for quality in (84, 72, 60):
            buffer = io.BytesIO()
            image.save(buffer, "JPEG", quality=quality, optimize=True)
            value = buffer.getvalue()
            if len(value) <= budget:
                return base64.b64encode(value).decode("ascii"), image.width, image.height
        image = image.resize((max(16, int(image.width * .8)), max(16, int(image.height * .8))))
    raise ValueError("Reference image exceeds its size limit")


def finish(candidates, notes):
    candidates = candidates[:12]
    if not candidates:
        raise ValueError("No frames could be decoded")
    budget = (1024 * 1024) // len(candidates)
    output = []
    for candidate in candidates:
        encoded, width, height = encode(candidate.pop("crop"), 768, min(192 * 1024, int(budget * .45)))
        context, cw, ch = encode(candidate.pop("context"), 960, min(192 * 1024, int(budget * .55)))
        output.append({**candidate, "imageBase64": encoded, "contextBase64": context, "width": width, "height": height, "contextWidth": cw, "contextHeight": ch})
    return {"schemaVersion": 1, "networkEnabled": False, "candidates": output, "warnings": notes[:12]}


def video_frames(filename, requested_duration, ffmpeg, ffprobe):
    probe = subprocess.run([ffprobe, "-v", "error", "-show_entries", "format=duration:stream=width,height,codec_type", "-of", "json", str(filename)], capture_output=True, check=True, timeout=15)
    if len(probe.stdout) > 128 * 1024:
        raise ValueError("Oversized video metadata")
    data = json.loads(probe.stdout)
    duration = float((data.get("format") or {}).get("duration") or 0)
    video = next((stream for stream in data.get("streams", []) if stream.get("codec_type") == "video"), {})
    width, height = int(video.get("width") or 0), int(video.get("height") or 0)
    if not math.isfinite(duration) or not 0 < duration <= 300.02 or width < 16 or height < 16 or width * height > 24_000_000:
        raise ValueError("Unsupported local video")
    duration = min(duration, requested_duration)
    for index in range(8):
        time = round(duration * (index + .5) / 8, 3)
        try:
            result = subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-ss", str(time), "-i", str(filename), "-frames:v", "1", "-an", "-q:v", "3", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"], capture_output=True, check=True, timeout=12)
            if not result.stdout or len(result.stdout) > 24 * 1024 ** 2:
                continue
            yield time, read_image(io.BytesIO(result.stdout))
        except (subprocess.SubprocessError, OSError, ValueError):
            continue


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("photo", "video"), required=True)
    parser.add_argument("--input", required=True)
    parser.add_argument("--duration", type=float)
    parser.add_argument("--ffmpeg")
    parser.add_argument("--ffprobe")
    args = parser.parse_args()
    install_offline_tools(args.ffmpeg, args.ffprobe)
    filename = Path(args.input).resolve()
    if not filename.is_file() or not 0 < filename.stat().st_size <= (8 if args.mode == "photo" else 80) * 1024 ** 2:
        raise ValueError("Unsupported input file")
    notes = ["Candidates use generic face detection only. Choose the intended person manually; no identity recognition or matching was performed."]
    candidates = []
    if args.mode == "photo":
        image = read_image(filename)
        boxes = face_boxes(image)
        candidates = [make_candidate(image, box, None) for box in boxes] if boxes else [make_candidate(image, None, None)]
        if not boxes:
            notes.append("No face was detected in this photo. The full photo is available for manual selection.")
    else:
        if args.duration is None or not math.isfinite(args.duration) or not 0 < args.duration <= 300 or not args.ffmpeg or not args.ffprobe:
            raise ValueError("Invalid local video settings")
        fallbacks = []
        for time, image in video_frames(filename, args.duration, args.ffmpeg, args.ffprobe):
            boxes = face_boxes(image)
            for box in boxes:
                candidates.append(make_candidate(image, box, time))
            if len(fallbacks) < 3:
                fallbacks.append(make_candidate(image, None, time))
            if len(candidates) >= 12:
                break
        if not candidates:
            candidates = fallbacks
            notes.append("No faces were detected in the sampled frames. Select a full-frame reference manually or upload a clearer photo.")
        notes.append("Eight frames were sampled at most; brief appearances and small or obscured faces can be missed.")
    print(json.dumps(finish(candidates, notes), allow_nan=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Local face-reference processing failed ({type(error).__name__}).", file=sys.stderr)
        sys.exit(1)
