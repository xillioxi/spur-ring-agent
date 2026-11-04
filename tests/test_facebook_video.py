import asyncio

import httpx
import pytest

from spur import facebook_publishing as fb
from spur.library import Library, ContentInput
from spur.publishing import Posts, PostInput
from spur.social import SocialError
from spur.store import Store


def test_authorization_duplicate_queue_and_worker_replay(tmp_path, monkeypatch):
    db = Store(tmp_path / 'workspace.db')
    library = Library(db)
    item = library.create(ContentInput(title='Creator Notes', format='instagram_reel'))
    library.asset_dir.mkdir(exist_ok=True)
    asset = 'a' * 32
    library.asset_path(asset).write_bytes(b'mp4 fixture')
    library.add_asset(item['id'], asset, 'reel.mp4', 'video/mp4', 11, 'footage')
    posts = Posts(db)
    reel = posts.create(PostInput(media_type='reel', content_id=item['id'], asset_id=asset))
    reel.update(status='published', account_id='11')
    posts.save(reel)
    page = {'id':'22', 'name':'Studio', 'authorized':False}

    async def destination(*args):
        return page, {}, 'generation', 'https://graph.facebook.com/v24.0/'

    monkeypatch.setattr(fb, 'destination', destination)
    calls = []

    def provider(request):
        calls.append(request.url.path)
        return httpx.Response(200, json={'id':'33'})

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(provider)) as client:
            with pytest.raises(SocialError):
                await fb.enqueue(db, client, reel['id'], '22')
            page['authorized'] = True
            for _ in range(2):
                await fb.enqueue(db, client, reel['id'], '22')
            with db.connect() as conn:
                rows = conn.execute("SELECT id FROM jobs WHERE kind='facebook_video_publish'").fetchall()
            assert len(rows) == 1
            job = {'id':rows[0][0], 'payload':{'source_id':reel['id'], 'page_id':'22','generation':'generation'}}
            monkeypatch.setattr(db, 'finish', lambda *args: None)
            await fb.step(db, job, client)
            await fb.step(db, job, client)
            assert calls == ['/v24.0/22/videos']
            assert fb.deliveries(db)[0]['video_id'] == '33'
    asyncio.run(run())

