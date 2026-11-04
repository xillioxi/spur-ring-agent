import re
from datetime import datetime

import httpx
from defusedxml import ElementTree

CHANNEL_PATTERN = r"^UC[A-Za-z0-9_-]{22}$"
NS = {"a": "http://www.w3.org/2005/Atom", "yt": "http://www.youtube.com/xml/schemas/2015",
      "media": "http://search.yahoo.com/mrss/"}


def parse_feed(content):
    root = ElementTree.fromstring(content)
    if root.tag != "{http://www.w3.org/2005/Atom}feed":
        raise ValueError("Expected a YouTube Atom feed")
    items = []
    for entry in root.findall("a:entry", NS):
        video_id = entry.findtext("yt:videoId", namespaces=NS)
        published = entry.findtext("a:published", namespaces=NS)
        if not video_id or not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id) or not published:
            continue
        stamp = datetime.fromisoformat(published.replace("Z", "+00:00"))
        if stamp.tzinfo is None:
            raise ValueError("Feed date has no timezone")
        items.append({"id": video_id, "title": (entry.findtext("a:title", namespaces=NS) or "")[:1000],
                      "channel_name": (entry.findtext("a:author/a:name", namespaces=NS) or root.findtext("a:author/a:name", namespaces=NS) or "")[:200],
                      "description": (entry.findtext("media:group/media:description", namespaces=NS) or "")[:12000],
                      "url": f"https://www.youtube.com/watch?v={video_id}", "published": stamp.timestamp()})
    return items


async def collect(client: httpx.AsyncClient, channel_id):
    if not re.fullmatch(CHANNEL_PATTERN, channel_id):
        raise ValueError("Expected a YouTube UC channel ID")
    # Fixed destination; neither users nor the model can fetch arbitrary URLs.
    async with client.stream("GET", "https://www.youtube.com/feeds/videos.xml",
                             params={"channel_id": channel_id}, follow_redirects=False, timeout=30) as response:
        response.raise_for_status()
        data = bytearray()
        async for chunk in response.aiter_bytes():
            data.extend(chunk)
            if len(data) > 2_000_000:
                raise ValueError("Feed exceeds 2 MB")
    return parse_feed(bytes(data))
