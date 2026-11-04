"""Explicit live smoke test: python -m spur.check_connection."""
import asyncio
import httpx
from spur.config import settings
from spur.credentials import load_key
from spur.discovery import search_channels, resolve_channel
from spur.youtube import collect


async def main():
    async with httpx.AsyncClient() as client:
        response = await client.get('https://api.deepseek.com/models',
            headers={'Authorization': 'Bearer ' + load_key(settings, 'deepseek')}, timeout=20)
        print('Provider credentials HTTP', response.status_code, flush=True)
        results = await search_channels(client, settings, 'Paris travel YouTube channels')
        print('Search candidates', len(results), flush=True)
        for result in results[:3]:
            try:
                channel = await resolve_channel(client, result['url'])
                videos = await collect(client, channel)
                print({'channel_id': channel, 'videos': len(videos),
                       'name': videos[0].get('channel_name') if videos else None}, flush=True)
                return
            except Exception as error:
                print(type(error).__name__, str(error)[:180], flush=True)


if __name__ == '__main__':
    asyncio.run(main())
