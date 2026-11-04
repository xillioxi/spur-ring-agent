from dataclasses import replace
import asyncio
import httpx
from fastapi.testclient import TestClient
from spur.config import Settings
from spur.store import Store
from spur.worker import execute


def test_live_trace_is_persisted_and_visible_in_activity_and_mission(tmp_path,monkeypatch):
    import spur.api as api
    monkeypatch.setattr(api,'settings',replace(Settings(),db_path=str(tmp_path/'trace.db'),api_key='auth'))
    with TestClient(api.app) as c:
        headers={'X-API-Key':'auth'}
        db=api.app.state.store
        mission_id=db.create_mission('Clear my watchlist',7)
        job=db.claim()
        async def run():
            async with httpx.AsyncClient(transport=httpx.MockTransport(lambda req: (_ for _ in ()).throw(AssertionError('No network expected')))) as client:
                await execute(db,job,client)
        asyncio.run(run())
        assert c.get('/jobs/'+job['id']+'/events').status_code==401
        events=c.get('/jobs/'+job['id']+'/events',headers=headers).json()
        assert any(e['kind']=='decision' and 'clear-watchlist' in e['title'] for e in events)
        assert events[0]['title']=='Step finished'
        dashboard=c.get('/dashboard',headers=headers).json()
        assert len(dashboard['jobs'][0]['events'])==3
        mission=c.get('/missions/'+mission_id,headers=headers).json()
        assert any(e['kind']=='decision' for e in mission['events'])
        assert any(e['kind']=='checkpoint' for e in mission['events'])
        assert c.get('/jobs/missing/events',headers=headers).status_code==404
    restarted=Store(str(tmp_path/'trace.db'))
    assert len(restarted.job_events(job['id']))==3
