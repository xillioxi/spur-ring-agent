"""Live search and restricted YouTube channel resolution; never downloads video."""
import html
import re
from urllib.parse import urlparse, parse_qs, quote

from spur.credentials import load_key
from spur.youtube import CHANNEL_PATTERN


def youtube_url(value):
    url = urlparse(value)
    if url.scheme != "https" or url.hostname not in ("youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"):
        raise ValueError("Search result is not a public YouTube URL")
    if url.username or url.password or url.port not in (None, 443):
        raise ValueError("Invalid YouTube URL")
    path = url.path.rstrip("/")
    if url.hostname == "youtu.be":
        video_id = path.lstrip("/")
        if re.fullmatch(r"[\w-]{11}", video_id):
            return "https://www.youtube.com/watch?v=" + video_id
    if re.fullmatch(r"/channel/UC[\w-]{22}", path):
        return "https://www.youtube.com" + path
    if re.fullmatch(r"/@[^/?#<>\s]{1,100}(?:/(?:videos|about|featured))?", path):
        handle = path.split("/")[1]
        return "https://www.youtube.com/" + quote(handle, safe="@-._~%")
    video_id = parse_qs(url.query).get("v", [""])[0] if path == "/watch" else path.split("/")[-1] if path.startswith("/shorts/") else ""
    if re.fullmatch(r"[\w-]{11}", video_id):
        return "https://www.youtube.com/watch?v=" + video_id
    raise ValueError("YouTube result is not a channel or video")


async def search_channels(client, settings, query):
    key = load_key(settings, "deepseek")
    if not key:
        raise ValueError("Discovery needs the saved DeepSeek key for its Search API")
    query = query.strip()[:100] + " site:youtube.com"
    response = await client.post("https://api.deepseek.com/v1/tools/search",
                                 headers={"Authorization": "Bearer " + key},
                                 json={"query": query[:128], "count": 50, "need_content": False}, timeout=60)
    if not response.is_success:
        raise ValueError(f"DeepSeek search returned HTTP {response.status_code}. Check search access and API balance.")
    results = []
    seen = set()
    for item in response.json().get("results", []):
        try:
            url = youtube_url(item["url"])
        except (ValueError, KeyError):
            continue
        if url not in seen:
            results.append({"url": url, "title": item.get("title", "")[:300],
                            "summary": (item.get("summary") or item.get("snippet") or "")[:1500]})
            seen.add(url)
    return results


async def resolve_channel(client, value):
    url = youtube_url(value)
    direct = re.search(r"/channel/(UC[\w-]{22})$", url)
    if direct:
        return direct[1]
    async with client.stream("GET", url, follow_redirects=False, timeout=30) as response:
        response.raise_for_status()
        content = bytearray()
        async for chunk in response.aiter_bytes():
            content.extend(chunk)
            if len(content) > 4_000_000:
                raise ValueError("YouTube page exceeded the channel-resolution limit")
    text = html.unescape(content.decode("utf-8", errors="replace"))
    # Prefer page metadata/video owner over recommendation channel IDs.
    patterns = [r'<meta[^>]+itemprop="channelId"[^>]+content="(UC[\w-]{22})"',
                r'"externalId"\s*:\s*"(UC[\w-]{22})"',
                r'"videoDetails"\s*:\s*\{.*?"channelId"\s*:\s*"(UC[\w-]{22})"',
                r'<link[^>]+rel="canonical"[^>]+href="https://www.youtube.com/channel/(UC[\w-]{22})"']
    for pattern in patterns:
        match = re.search(pattern, text, re.DOTALL)
        if match and re.fullmatch(CHANNEL_PATTERN, match[1]):
            return match[1]
    raise ValueError("YouTube did not expose a verifiable channel ID")
