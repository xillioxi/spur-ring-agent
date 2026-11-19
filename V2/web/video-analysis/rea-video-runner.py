"""Run the pinned rea-video pipeline locally, with network and model downloads disabled.

Only bounded report excerpts and re-encoded reference images go back to Spur.
Raw native reports stay in the per-run directory; private paths are redacted.
"""
from __future__ import annotations

import argparse
import base64
import contextlib
import io
import json
import math
import os
from pathlib import Path
import re
import socket
import subprocess
import sys


def offline(*_args, **_kwargs):
    raise OSError("Network and model downloads are disabled in Spur's local rea-video workflow")


def text(value, maximum=2000):
    return " ".join(str(value or "").split())[:maximum]


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def local_sections(output, breakdown, private_paths):
    """Keep native reports as bounded plaintext, never trusted HTML or interpreted facts."""
    def safe(value):
        value = str(value or "")
        for private in private_paths:
            value = value.replace(str(private), "[local path]").replace(str(private).replace("\\", "/"), "[local path]")
        value = re.sub(r"\A\ufeff?---\s*\r?\n.*?\r?\n---\s*(?:\r?\n|$)", "", value, count=1, flags=re.S)
        return value.strip()[:16000]

    def read(name):
        target = (output / "video" / (name + ".md")).resolve()
        if not target.is_relative_to(output) or not target.is_file() or target.stat().st_size > 256 * 1024:
            return ""
        return target.read_text(encoding="utf-8")

    notice = "Unreviewed local heuristics. These estimates can be wrong; no vision model, OCR or speech recognition checked their meaning.\n\n"
    values = []
    for identity, title in (("look", "Camera, lighting and colour"), ("sound", "Sound and rhythm"),
                            ("packaging", "Captions, graphics and overlays"), ("remake", "Suggested filming and remake plan")):
        body = safe(read(identity))
        if identity == "packaging":
            body = "OCR is disabled. Empty caption or sticker results do not establish that none appear in the video.\n\n" + body
        if body:
            values.append({"id": identity, "title": title, "body": notice + body})
    editing_lines = ((breakdown.get("aspects") or {}).get("editing") or {}).get("lines") or []
    editing = "\n".join(text(line, 2000) for line in editing_lines[:12] if isinstance(line, str))
    timeline = safe(read("timeline"))
    if editing or timeline:
        values.append({"id": "editing", "title": "Editing and shot timeline", "body": notice + safe(editing + "\n\n" + timeline)})
    materials = []
    for index, shot in enumerate((breakdown.get("shots") or [])[:2000]):
        material = shot.get("material") or {}
        for item in (material.get("items") or [])[:8]:
            if not isinstance(item, dict):
                continue
            kind = text(item.get("kind_zh") or item.get("kind"), 300)
            region = text(item.get("region"), 100)
            if kind:
                materials.append(f"Shot {index + 1}: {kind}" + (f" ({region})" if region else ""))
        if len(materials) >= 80:
            break
    values.append({"id": "materials", "title": "Source material and references", "body": notice + safe(
        "Source ownership and origin are not verified. Confirm each suggested material against the original video.\n\n" +
        ("\n".join(materials[:80]) or "No source-material candidates were returned."))})
    source = breakdown.get("source") or {}
    metadata = []
    for key in ("width", "height", "fps", "duration"):
        if number(source.get(key)):
            metadata.append(f"{key}: {source[key]}")
    values.append({"id": "provenance", "title": "How this report was made", "body": safe(
        "Native rea-video local measurements, packaging candidates and report templates. Network, vision models, OCR, speech recognition, speaker detection, stem separation and learned corrections are disabled.\n\n" +
        "Input metadata: " + "; ".join(metadata) + ".\n\nOriginal video and private source paths are omitted. Suggestions have not been visually reviewed.")})
    for value in values:
        value["body"] = value["body"][:16000]
    return values


def sound_candidates(breakdown):
    audio = breakdown.get("audio") or {}
    events = ((breakdown.get("audio_plan") or {}).get("sfx_merged") or (audio.get("sfx") or {}).get("events") or [])
    duration = (breakdown.get("source") or {}).get("duration")
    if not number(duration) or duration <= 0:
        return []
    candidates = []
    for event in events:
        if not isinstance(event, dict) or event.get("source") == "vlm":
            continue
        start, length = event.get("t"), event.get("dur")
        if not number(start) or not number(length) or start < 0 or length <= 0 or start >= duration:
            continue
        description = text(event.get("description") or event.get("type"), 500)
        if not description:
            continue
        end = min(start + length, duration)
        if round(end, 3) <= round(start, 3):
            continue
        candidates.append({"startSeconds": round(start, 3), "endSeconds": round(end, 3), "description": description})
        if len(candidates) >= 60:
            break
    return candidates


def report_images(output, breakdown):
    from PIL import Image
    images = []
    asset_map = breakdown.get("assets") or {}
    sources = [("storyboard", "Storyboard", asset_map.get("storyboard")),
               ("audio-chart", "Audio energy and event chart", asset_map.get("audio_timeline"))]
    for position, shot in enumerate((breakdown.get("shots") or [])[:6]):
        sources.append((f"shot-{position + 1:03d}", f"Shot {position + 1} contact sheet", (shot.get("assets") or {}).get("sheet")))
    total = 0
    for identity, label, relative in sources:
        if not isinstance(relative, str) or Path(relative).is_absolute():
            continue
        target = (output / relative).resolve()
        if not target.is_relative_to(output) or not target.is_file() or target.stat().st_size > 20 * 1024 ** 2:
            continue
        try:
            with Image.open(target) as original:
                if original.width * original.height > 40_000_000:
                    continue
                image = original.convert("RGB")
                image.thumbnail((1400, 1400))
                encoded = b""
                for _attempt in range(8):
                    buffer = io.BytesIO()
                    image.save(buffer, format="JPEG", quality=82, optimize=True)
                    encoded = buffer.getvalue()
                    if len(encoded) <= 256 * 1024:
                        break
                    image.thumbnail((max(100, int(image.width * .8)), max(100, int(image.height * .8))))
                if not encoded or len(encoded) > 256 * 1024 or total + len(encoded) > 1024 ** 2:
                    continue
                images.append({"id": identity, "label": label, "contentType": "image/jpeg", "dataBase64": base64.b64encode(encoded).decode("ascii")})
                total += len(encoded)
        except (OSError, ValueError, Image.DecompressionBombError):
            continue
    return images


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--video", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--ffmpeg", required=True)
    parser.add_argument("--ffprobe", required=True)
    args = parser.parse_args()
    source, video, output = (Path(v).resolve() for v in (args.source, args.video, args.out))
    output.mkdir(parents=True, exist_ok=True)
    sys.path.insert(0, str(source))
    # No user prefs, prior corrections, model credentials or shared model cache.
    os.environ["REA_VIDEO_HOME"] = str(output / "home")
    os.environ["REA_VIDEO_MODELS"] = str(output / "models")
    os.environ["PYTHONIOENCODING"] = "utf-8"
    os.environ["PATH"] = os.pathsep.join(dict.fromkeys([str(Path(args.ffmpeg).parent), str(Path(args.ffprobe).parent), os.environ.get("PATH", "")]))
    socket.socket.connect = offline
    socket.socket.connect_ex = offline
    socket.create_connection = offline

    tools = {"ffmpeg": str(Path(args.ffmpeg).resolve()), "ffprobe": str(Path(args.ffprobe).resolve())}
    original_popen = subprocess.Popen

    def media_popen(command, *pargs, **kwargs):
        if isinstance(command, (str, bytes)) or not command or kwargs.get("shell"):
            raise OSError("Only fixed media tool subprocesses are allowed")
        name = Path(str(command[0])).stem.lower()
        if name not in tools:
            raise OSError("Unsupported local rea-video subprocess")
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
        raise RuntimeError("rea-video import did not use the configured source")
    rea_video.util.fetch = offline
    from rea_video.pipeline import decompose

    with contextlib.redirect_stdout(sys.stderr):
        breakdown = decompose(video, output, use_vlm=False, whole_vlm=False, ocr=False,
                              workers=2, stems=False, memory=False, packaging=True,
                              asr=False, speakers=False, lang="en")
    shots = []
    for position, shot in enumerate(breakdown.get("shots", [])[:2000]):
        start, end = shot.get("start"), shot.get("end")
        if not number(start) or not number(end) or end <= start:
            continue
        base = shot.get("base") or {}
        evidence = base.get("evidence") or (shot.get("deterministic") or {}).get("evidence") or []
        if not isinstance(evidence, list):
            evidence = []
        safe_evidence = []
        for item in evidence[:12]:
            value = text(item.get("text") or item.get("reason") or item.get("feature") if isinstance(item, dict) else item, 500)
            for private in (str(source), str(video), str(output)):
                value = value.replace(private, "[local path]")
            if value:
                safe_evidence.append(value)
        confidence = base.get("confidence")
        shots.append({"index": position, "startSeconds": round(start, 3), "endSeconds": round(end, 3),
                      "label": text(base.get("label") or "unknown", 80),
                      "confidence": round(max(0, min(1, confidence)), 4) if number(confidence) else None,
                      "evidence": safe_evidence})
    verdict = text((breakdown.get("summary") or {}).get("verdict"), 6000)
    result = {"schemaVersion": 1, "toolVersion": text(rea_video.__version__, 80),
              "verdict": verdict, "technicalShots": shots, "vlmStatus": "not_requested",
              "reviewStatus": "unreviewed", "networkEnabled": False,
              "sections": local_sections(output, breakdown, (source, video, output)),
              "soundCandidates": sound_candidates(breakdown),
              "assets": report_images(output, breakdown),
              "limitations": [
                  "Local technical analysis only; no vision model or agent review has interpreted the actions, story or payoff.",
                  "Production-source labels and their scores are heuristic estimates, not proof that footage is filmed or AI-generated.",
                  "OCR, speech recognition and audio stem models are disabled; no dialogue or visible wording was transcribed.",
                  "Measured cuts are candidates; continuous action changes may occur within a single detected shot.",
              ]}
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        # Raw exception messages can contain input paths or package/config data.
        print(f"Local rea-video runner failed ({type(exc).__name__}).", file=sys.stderr)
        sys.exit(1)
