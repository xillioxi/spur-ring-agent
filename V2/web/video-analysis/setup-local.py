"""Install bounded, project-local video analysis tools from their official sources.

Run with Python 3.10+: python V2/web/video-analysis/setup-local.py
Ollama itself must already be installed; its vision model is pulled separately.
"""
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
import json
from pathlib import Path
import shutil
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[3]
TOOLS = ROOT / ".build-tools" / "media"
MODELS = ROOT / ".build-tools" / "models"
CACHE = TOOLS / "downloads"
HEADERS = {"User-Agent": "Spur-Video-Analysis-Setup/1.0"}


def fetch(url, limit=2_000_000):
    with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=90) as response:
        value = response.read(limit + 1)
    if len(value) > limit:
        raise RuntimeError("Download metadata exceeded its size limit")
    return value


def download(url, destination, limit, expected=None):
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() and (not expected or sha256(destination.read_bytes()).hexdigest() == expected):
        print(f"Already present: {destination.name}", flush=True)
        return destination
    temporary = destination.with_suffix(destination.suffix + ".partial")
    try:
        size = 0
        digest = sha256()
        with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=120) as response, temporary.open("wb") as output:
            while chunk := response.read(1024 * 1024):
                size += len(chunk)
                if size > limit:
                    raise RuntimeError(f"Download exceeded limit: {destination.name}")
                digest.update(chunk)
                output.write(chunk)
        if expected and digest.hexdigest() != expected:
            raise RuntimeError(f"Checksum did not match: {destination.name}")
        temporary.replace(destination)
        print(f"Installed download: {destination.name} ({size / 1_000_000:.1f} MB)", flush=True)
        return destination
    finally:
        temporary.unlink(missing_ok=True)


def ffmpeg():
    folder = TOOLS / "ffmpeg" / "bin"
    if (folder / "ffmpeg.exe").exists() and (folder / "ffprobe.exe").exists():
        return
    url = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
    checksum = fetch(url + ".sha256").decode().split()[0]
    archive = download(url, CACHE / "ffmpeg-essentials.zip", 160_000_000, checksum)
    folder.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as bundle:
        for executable in ("ffmpeg.exe", "ffprobe.exe"):
            matches = [name for name in bundle.namelist() if name.endswith("/bin/" + executable)]
            if len(matches) != 1:
                raise RuntimeError("Unexpected FFmpeg archive layout")
            with bundle.open(matches[0]) as source, (folder / executable).open("wb") as target:
                shutil.copyfileobj(source, target)
    archive.unlink()


def whisper():
    folder = TOOLS / "whisper"
    if (folder / "whisper-cli.exe").exists():
        return
    release = json.loads(fetch("https://api.github.com/repos/ggml-org/whisper.cpp/releases/tags/b5454"))
    asset = next(item for item in release["assets"] if item["name"] == "whisper-bin-x64.zip")
    expected = (asset.get("digest") or "").removeprefix("sha256:") or None
    archive = download(asset["browser_download_url"], CACHE / "whisper-bin-x64.zip", 30_000_000, expected)
    folder.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as bundle:
        for member in bundle.infolist():
            if member.is_dir() or Path(member.filename).suffix.lower() not in (".exe", ".dll"):
                continue
            if member.file_size > 100_000_000:
                raise RuntimeError("Unexpected Whisper executable size")
            with bundle.open(member) as source, (folder / Path(member.filename).name).open("wb") as target:
                shutil.copyfileobj(source, target)
    archive.unlink()


def ytdlp():
    base = "https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/"
    sums = dict(line.split(maxsplit=1)[::-1] for line in fetch(base + "SHA2-256SUMS").decode().splitlines() if line.strip())
    checksum = sums.get("yt-dlp.exe") or sums.get("*yt-dlp.exe")
    if not checksum:
        raise RuntimeError("yt-dlp checksum not found")
    download(base + "yt-dlp.exe", TOOLS / "yt-dlp.exe", 40_000_000, checksum)


def model(repo, filename, limit):
    entries = json.loads(fetch(f"https://huggingface.co/api/models/{repo}/tree/main"))
    entry = next(item for item in entries if item["path"] == filename)
    expected = entry.get("lfs", {}).get("oid")
    download(f"https://huggingface.co/{repo}/resolve/main/{filename}", MODELS / filename, limit, expected)


if __name__ == "__main__":
    CACHE.mkdir(parents=True, exist_ok=True)
    tasks = [ffmpeg, whisper, ytdlp,
             lambda: model("ggerganov/whisper.cpp", "ggml-base-q5_1.bin", 80_000_000),
             lambda: model("ggml-org/whisper-vad", "ggml-silero-v5.1.2.bin", 2_000_000)]
    with ThreadPoolExecutor(max_workers=3) as pool:
        for result in pool.map(lambda task: task(), tasks):
            pass
    manifest = {"ffmpeg": str(TOOLS / "ffmpeg/bin/ffmpeg.exe"), "ffprobe": str(TOOLS / "ffmpeg/bin/ffprobe.exe"),
                "whisper": str(TOOLS / "whisper/whisper-cli.exe"), "whisperModel": str(MODELS / "ggml-base-q5_1.bin"),
                "whisperVad": str(MODELS / "ggml-silero-v5.1.2.bin"), "ytDlp": str(TOOLS / "yt-dlp.exe")}
    (TOOLS / "installed.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print("Local media tools ready.", flush=True)
