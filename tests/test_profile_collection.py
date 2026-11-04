import asyncio,time
import pytest
from spur.store import Store
from spur.mock_profiles import Profiles,MockProfileInput,media
from spur.profile_collection import start,step
from spur.video_search import SearchError


def workspace(tmp_path):
    root=Store(str(tmp_path/'root.db'));registry=Profiles(root);info=registry.create(MockProfileInput())
    info.update(mode='public',platform='youtube');registry.update(info)
    return root,registry,registry.workspace(info['id'])


def test_details_are_durable_idempotent_and_preserve_missing_fields(tmp_path,monkeypatch):
    root,registry,child=workspace(tmp_path)
    run=start(child,'request-1');assert run['total']==48 and 'pending' not in run
    assert start(child,'request-1')['id']==run['id']
    original=media(child)[0]
    async def details(identifier):return {'id':identifier,'published':1114313512,'description':'Actual source description','observed_at':time.time(),'metrics':{'views':123,'likes':None,'comments':None},'detail_status':'collected'}
    monkeypatch.setattr('spur.public_youtube.video_details',details)
    asyncio.run(step(child,child.claim()))
    saved=next(r for r in media(child) if r['id']==original['id'])
    assert saved['published']==1114313512 and saved['metrics']['views']==123
    assert saved['metrics']['likes']==original['metrics']['likes']
    assert root.items(0,time.time()+1)==[]
    stopped=start(child,stop=True);assert stopped['status']=='paused'
    with child.connect() as db:db.execute('UPDATE jobs SET available=0')
    job=child.claim();asyncio.run(step(child,job));assert child.job(job['id'])['result']['skipped']


def test_block_pauses_and_materializes_partial_progress(tmp_path,monkeypatch):
    _,registry,child=workspace(tmp_path);start(child)
    async def blocked(identifier):raise SearchError('Sign in to confirm you are not a bot')
    monkeypatch.setattr('spur.public_youtube.video_details',blocked)
    asyncio.run(step(child,child.claim()))
    state=registry.get(child.mock_profile['id'])['metadata_collection']
    assert state['status']=='paused' and state['failed']==1 and state['processed']==1
    with child.connect() as db:assert db.execute("SELECT COUNT(*) FROM jobs WHERE status='queued'").fetchone()[0]==0


def test_synthetic_cannot_start_external_collection(tmp_path):
    root=Store(str(tmp_path/'root.db'));registry=Profiles(root);info=registry.create(MockProfileInput())
    with pytest.raises(SearchError):start(registry.workspace(info['id']))


def test_completed_catalog_is_not_replaced_by_a_zero_record_collection(tmp_path):
    from spur.mock_profiles import put_media
    _,registry,child=workspace(tmp_path);rows=media(child)
    for row in rows:row['detail_status']='collected'
    put_media(child,rows)
    result=start(child)
    assert result['status']=='nothing_pending' and result['already_collected']==48
    assert 'No new requests' in result['message']
    assert registry.get(child.mock_profile['id']).get('metadata_collection') is None
