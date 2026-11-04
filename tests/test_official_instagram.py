import httpx,pytest
from spur.store import Store
from spur.mock_profiles import Profiles,MockProfileInput,media,import_step
from spur.social import SocialStore
from spur.video_search import SearchError,SearchStore
from spur.official_instagram import page
from tests.test_mock_profiles import run,cipher


def authorized(parent):
    repo=SocialStore(parent);repo.save_app('instagram','app','secret','http://localhost/callback','v24.0')
    repo.connect('instagram',{'access_token':'test-token','expires_in':3600},[{'id':'1234','name':'My studio'}])


def test_official_discovery_pages_and_reports_without_tikhub(tmp_path):
    root=Store(str(tmp_path/'root.db'));authorized(root)
    registry=Profiles(root);info=registry.create(MockProfileInput(platform='instagram',provider='official',mode='public',source='@brand'))
    child=registry.workspace(info['id']);calls=[]
    def handler(request):
        calls.append(request)
        assert request.url.host=='graph.facebook.com' and request.url.path=='/v24.0/1234'
        assert request.headers['Authorization']=='Bearer test-token'
        assert 'business_discovery.username(brand)' in request.url.params['fields']
        if len(calls)==2:assert '.after(next)' in request.url.params['fields']
        return httpx.Response(200,json={'business_discovery':{'id':'999','username':'brand','media':{'data':[{'id':str(len(calls)),'caption':'Brand post','media_type':'VIDEO','timestamp':'2026-10-01T00:00:00Z','permalink':'https://www.instagram.com/reel/test/','like_count':0,'comments_count':2}],**({'paging':{'next':'https://untrusted.invalid/?access_token=never-follow','cursors':{'after':'next'}}} if len(calls)==1 else {})}}})
    run(lambda client:import_step(child,child.claim(),client),handler)
    run(lambda client:import_step(child,child.claim(),client),handler)
    state=registry.get(info['id']);assert state['complete'] and state['imported']==2
    assert SearchStore(root).usage()['requests']==0
    assert all(r['provider']=='instagram_official' and r['metrics']['views'] is None and r['metrics']['likes']==0 for r in media(child))
    snapshot=SearchStore(child).run(state['search_id']);assert snapshot['provider']=='instagram_official'
    assert any('View counts' in w for w in snapshot['warnings'])


def test_unavailable_target_not_claimed_empty_or_fallback(tmp_path):
    root=Store(str(tmp_path/'root.db'));authorized(root)
    with pytest.raises(SearchError,match='requested professional profile'):
        run(lambda client:page(root,'privateprofile',None,client),lambda request:httpx.Response(200,json={'id':'1234'}))
    assert SearchStore(root).usage()['requests']==0


def test_official_attachment_and_switch_wait_for_authorization_without_losing_rows(tmp_path):
    root=Store(str(tmp_path/'root.db'));registry=Profiles(root)
    creator=registry.create(MockProfileInput(mode='public',source='@brand'))
    attached=registry.create(MockProfileInput(platform='instagram',mode='public',source='@brand',workspace_id=creator['id']))
    with pytest.raises(SearchError,match='Professional Instagram'):registry.resume(attached['id'],provider='official')
    saved=registry.get(attached['id']);assert saved['import_method']=='instagram_official' and saved['status']=='needs_setup'
    with registry.workspace(saved['id']).connect() as db:assert db.execute('SELECT COUNT(*) FROM jobs').fetchone()[0]==0


def test_official_tiktok_does_not_promise_handle_access(tmp_path):
    registry=Profiles(Store(str(tmp_path/'root.db')))
    with pytest.raises(SearchError,match='owner to authorize'):
        registry.create(MockProfileInput(platform='tiktok',provider='official',mode='public',source='@brand'))
