import asyncio
import time
from dataclasses import replace

import httpx
import pytest
from fastapi.testclient import TestClient
from spur.config import Settings
from spur.store import Store
from spur.social import SocialStore
from spur.video_search import SearchInput,search_videos
from spur.metadata_reports import generate,MetadataReportInput
from spur.mock_profiles import Profiles,MockProfileInput,import_step,media
from spur.worker import discover_workspaces,execute_step


@pytest.fixture(autouse=True)
def cipher(monkeypatch):monkeypatch.setattr('spur.social.protect',lambda value,decrypt=False:bytes(value)[::-1])


def run(work,handler=None):
    async def invoke():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler or (lambda r:pytest.fail('No network expected')))) as client:return await work(client)
    return asyncio.run(invoke())


@pytest.mark.parametrize('platform',['youtube','instagram','tiktok'])
def test_synthetic_creator_catalog_library_and_math_are_isolated(tmp_path,platform):
    root=Store(str(tmp_path/'root.db'));root.set_runtime('connection',{'provider':'deepseek','model':'deepseek-chat'})
    registry=Profiles(root);info=registry.create(MockProfileInput(platform=platform));child=registry.workspace(info['id'])
    assert len(media(child))==48 and root.items(0,time.time()+1)==[]
    assert child.dashboard()['counts']['videos']==48
    from spur.library import Library
    assert len(Library(child).list())==48 and len(Library(root).list())==0
    result=run(lambda client:search_videos(child,SearchInput(platform=platform,query='all videos',days=30),client))
    assert result['provider']=='demo_synthetic' and result['items'][0]['synthetic']
    report=generate(child,MetadataReportInput(search_id=info['search_id']))
    assert report['content']['artifact']['data']['mode']=='mathematical_analysis'
    assert len(report['content']['artifact']['data']['evidence'])==48 and root.reports()==[]
    assert 'SYNTHETIC' in report['content']['artifact']['data']['limitations'][0]


def test_advancing_only_changes_synthetic_scenario_and_supports_growth(tmp_path):
    root=Store(str(tmp_path/'root.db'));registry=Profiles(root);info=registry.create(MockProfileInput())
    child=registry.workspace(info['id']);old=media(child);updated=registry.resume(info['id'],advance=True);new=media(child)
    assert updated['scenario_day']==1 and new[0]['observed_at']-old[0]['observed_at']==86400
    report=generate(child,MetadataReportInput(search_id=updated['search_id']))
    assert any(r['growth'] for r in report['content']['artifact']['data']['evidence'])


def test_worker_discovers_mock_workspaces_and_reuses_parent_model(tmp_path):
    root=Store(str(tmp_path/'root.db'));root.set_runtime('connection',{'provider':'deepseek','model':'deepseek-chat'})
    Profiles(root).create(MockProfileInput());cache={};stores=discover_workspaces(root,cache)
    child=next(s for s in stores if getattr(s,'mock_profile',None))
    assert child.profile_parent.path==root.path
    from spur.credentials import selected_connection
    assert selected_connection(child,Settings())['provider']=='deepseek'
    root.set_runtime('connection',{'provider':'openai','model':'new-parent-model'})
    assert selected_connection(child,Settings())['model']=='new-parent-model'
    child.enqueue('collect',{});job=child.claim();run(lambda client:execute_step(child,job,client))
    assert child.job(job['id'])['status']=='succeeded'


def test_anonymous_channel_import_needs_no_connection_and_finishes_all_tabs(tmp_path,monkeypatch):
    root=Store(str(tmp_path/'root.db'));registry=Profiles(root)
    info=registry.create(MockProfileInput(mode='public',source='@realcreator'))
    child=registry.workspace(info['id']);seen=[]
    async def page(source,cursor):
        seen.append(cursor)
        return {'rows':[{'id':'abcdefghij1','title':'Actual public title','description':'','creator':'Reference creator','platform':'youtube','provider':'youtube_public','url':'https://www.youtube.com/watch?v=abcdefghij1','thumbnail':'','published':None,'observed_at':time.time(),'metrics':{'views':100,'likes':None,'comments':None},'format':'video'}] if cursor is None else [],'cursor':{'tab':1,'offset':0} if cursor is None else None,'visited':1 if cursor is None else 0,'name':'Reference creator','channel_id':None}
    monkeypatch.setattr('spur.public_youtube.public_page',page)
    run(lambda client:import_step(child,child.claim(),client))
    assert not registry.get(info['id'])['complete']
    run(lambda client:import_step(child,child.claim(),client))
    assert registry.get(info['id'])['complete'] and len(media(child))==1
    assert SocialStore(root).connection('youtube') is None
    assert media(child)[0]['published'] is None
    assert child.items(0,time.time()+1)[0]['published']==0


def test_public_youtube_import_paginates_and_skips_private_content(tmp_path):
    root=Store(str(tmp_path/'root.db'));social=SocialStore(root)
    social.save_app('youtube','client','secret','http://localhost/callback','')
    social.connect('youtube',{'access_token':'token','expires_in':3600},[{'id':'UC'+'a'*22,'name':'Own channel'}])
    registry=Profiles(root);info=registry.create(MockProfileInput(mode='public',source='https://www.youtube.com/@reference'))
    info['import_method']='official';registry.update(info)
    child=registry.workspace(info['id'])
    def handler(request):
        assert request.url.host=='www.googleapis.com' and request.headers['authorization']=='Bearer token'
        if request.url.path.endswith('/channels'):
            assert request.url.params['forHandle']=='@reference'
            return httpx.Response(200,json={'items':[{'id':'UC'+'b'*22,'snippet':{'title':'Reference creator'},'contentDetails':{'relatedPlaylists':{'uploads':'UU-test'}}}]})
        second=request.url.params.get('pageToken')=='page2'
        if request.url.path.endswith('/playlistItems'):return httpx.Response(200,json={'items':[{'contentDetails':{'videoId':'abcdefghij2' if second else 'abcdefghij1'}}],**({} if second else {'nextPageToken':'page2'})})
        identifier=request.url.params['id'];public=identifier.endswith('1')
        return httpx.Response(200,json={'items':[{'id':identifier,'snippet':{'title':'Actual reference video','description':'Public metadata','publishedAt':'2026-10-20T00:00:00Z'},'statistics':{'viewCount':'100'},'contentDetails':{'duration':'PT4M'},'status':{'privacyStatus':'public' if public else 'private'}}]})
    first=child.claim();run(lambda client:import_step(child,first,client),handler)
    assert not registry.get(info['id'])['complete']
    second=child.claim();run(lambda client:import_step(child,second,client),handler)
    state=registry.get(info['id']);assert state['complete'] and state['imported']==1 and state['skipped']==1
    assert len(media(child))==1 and media(child)[0]['title']=='Actual reference video'
    assert root.items(0,time.time()+1)==[] and SocialStore(child).connection('youtube') is None
    report=generate(child,MetadataReportInput(search_id=state['search_id']))
    assert report['content']['artifact']['data']['mode']=='source_evidence_only'


@pytest.fixture
def client(tmp_path,monkeypatch):
    import spur.api as api
    monkeypatch.setattr(api,'settings',replace(Settings(),db_path=str(tmp_path/'api.db'),api_key='service'))
    with TestClient(api.app) as client:
        auth=client.post('/auth/register',headers={'X-Spur-Auth':'1'},json={'username':'owner','display_name':'Owner','password':'test-passphrase-long'}).json()
        client.csrf={'X-CSRF-Token':auth['csrf_token']};yield client


def test_profile_switching_auth_csrf_cross_tab_guard_and_external_write_boundary(client):
    assert client.post('/mock-profiles',json={}).status_code==403
    created=client.post('/mock-profiles',headers=client.csrf,json={'platform':'instagram'});assert created.status_code==201
    identifier=created.json()['id']
    assert client.post('/mock-profiles/activate',headers=client.csrf,json={'profile_id':identifier}).status_code==200
    assert client.get('/auth/me').json()['mock_profile']['id']==identifier
    assert client.get('/content').json()['items']
    stale=client.post('/knowledge',headers={**client.csrf,'X-Spur-Profile':'personal'},json={'title':'Wrong workspace','content':'Must not write'})
    assert stale.status_code==409 and stale.headers['X-Spur-Session-Error']=='workspace'
    assert client.post('/social/instagram/connect',headers=client.csrf).status_code==403
    assert client.put('/settings/provider',headers=client.csrf,json={'provider':'deepseek','model':'deepseek-chat','api_key':'wrong'}).status_code==403
    assert client.get('/admin/integrations').status_code==403
    assert client.post('/office/google/actions',headers=client.csrf,json={'resource':'events'}).status_code in (403,422)
    context=client.get('/mock-profile/context').json()['profile'];assert context['catalog_size']==48
    analytics=client.get('/mock-profile/analytics').json()
    assert analytics['total']==48 and analytics['coverage']['total_records']==48
    report=client.post('/search/reports',headers=client.csrf,json={'search_id':context['search_id']});assert report.status_code==200
    assert client.get('/reports').json()
    assert client.post('/mock-profiles/activate',headers=client.csrf,json={'profile_id':None}).status_code==200
    assert client.get('/reports').json()==[] and client.get('/content').json()['items']==[]


def test_other_user_cannot_activate_or_read_someone_elses_mock(client):
    identifier=client.post('/mock-profiles',headers=client.csrf,json={}).json()['id']
    client.cookies.clear();auth=client.post('/auth/register',headers={'X-Spur-Auth':'1'},json={'username':'other','display_name':'Other','password':'test-passphrase-long'}).json();csrf={'X-CSRF-Token':auth['csrf_token']}
    assert client.get('/mock-profiles').json()['profiles']==[]
    assert client.post('/mock-profiles/activate',headers=csrf,json={'profile_id':identifier}).status_code==422
    assert client.post('/mock-profiles/'+identifier+'/refresh',headers=csrf).status_code==422


def test_mock_can_change_model_with_saved_key_without_changing_parent(client,monkeypatch):
    monkeypatch.setattr('spur.api.load_key',lambda *args:'unit-test-saved-key')
    assert client.put('/settings/provider',headers=client.csrf,json={'provider':'deepseek','model':'deepseek-flash'}).status_code==200
    identifier=client.post('/mock-profiles',headers=client.csrf,json={}).json()['id']
    client.post('/mock-profiles/activate',headers=client.csrf,json={'profile_id':identifier})
    response=client.put('/settings/provider',headers=client.csrf,json={'provider':'deepseek','model':'deepseek-v4-pro'})
    assert response.status_code==200 and response.json()['model']=='deepseek-v4-pro'
    assert client.get('/settings/provider').json()['model']=='deepseek-v4-pro'
    assert client.put('/settings/provider',headers=client.csrf,json={'provider':'deepseek','model':'deepseek-v4-pro','api_key':'new-secret'}).status_code==403
    client.post('/mock-profiles/activate',headers=client.csrf,json={'profile_id':None})
    assert client.get('/settings/provider').json()['model']=='deepseek-flash'
    client.post('/mock-profiles/activate',headers=client.csrf,json={'profile_id':identifier})
    assert client.get('/settings/provider').json()['model']=='deepseek-v4-pro'


def test_instagram_failed_request_never_automatically_repeats_paid_call(tmp_path):
    from spur.video_search import SearchStore,DataProviderInput,SearchError
    root=Store(str(tmp_path/'root.db'))
    budget=SearchStore(root);budget.save(DataProviderInput(api_key='unit-test-provider',enabled=True,max_request_cost_usd=.01))
    registry=Profiles(root);info=registry.create(MockProfileInput(platform='instagram',mode='public',source='@reference'))
    child=registry.workspace(info['id']);job=child.claim();calls=[]
    def failure(request):calls.append(request);return httpx.Response(503,json={})
    with pytest.raises(SearchError):run(lambda client:import_step(child,job,client),failure)
    with pytest.raises(SearchError,match='uncertain'):run(lambda client:import_step(child,job,client))
    assert len(calls)==1 and budget.usage()['requests']==1
    assert not registry.get(info['id'])['complete']


def test_chat_uses_profile_catalog_and_saves_full_report_without_searching(tmp_path):
    import json,uuid
    from spur.chat import reply
    root=Store(str(tmp_path/'root.db'));registry=Profiles(root);info=registry.create(MockProfileInput(platform='instagram'))
    child=registry.workspace(info['id']);child.enqueue_chat('coordinator','Generate a metadata report for the full profile.',uuid.uuid4().hex);job=child.claim();calls=[]
    def handler(request):
        body=json.loads(request.content);calls.append(body)
        if len(calls)==1:
            assert info['search_id'] in body['messages'][0]['content'] and 'mock_creator_profile' in body['messages'][0]['content']
            return httpx.Response(200,json={'message':{'role':'assistant','content':'','tool_calls':[{'function':{'name':'generate_metadata_report','arguments':{'search_id':info['search_id']}}}]}})
        tool=json.loads(body['messages'][-1]['content'])
        assert tool['coverage']['metrics_available']['views']==48
        assert len(tool['evidence_preview'])==20 and tool['total_evidence']==48
        assert 'evidence' not in tool['analysis']
        return httpx.Response(200,json={'message':{'role':'assistant','content':'Saved the synthetic profile report with 48 fictional records.'}})
    run(lambda client:reply(child,replace(Settings(),model='test'),job,client),handler)
    assert len(child.reports(child.reports()[0]['id'])['content']['artifact']['data']['evidence'])==48
    assert root.reports()==[] and root.chat('coordinator')==[]


def test_expired_public_reference_can_refresh_without_losing_local_script(tmp_path):
    from spur.mock_profiles import put_media,materialize,expire_public_metadata
    from spur.library import Library
    root=Store(str(tmp_path/'root.db'));registry=Profiles(root);info=registry.create(MockProfileInput());child=registry.workspace(info['id'])
    info.update(mode='public');rows=media(child)
    for row in rows:row.update(provider='youtube_official',observed_at=time.time()-30*86400)
    put_media(child,rows);materialize(child,info)
    item=Library(child).list()[0]
    with child.connect() as db:
        db.execute("UPDATE content_library SET document=json_set(document,'$.script','My original local script') WHERE id=?",(item['id'],))
        expire_public_metadata(child,db,time.time())
    assert media(child)==[] and Library(child).get(item['id'])['title']=='Expired source metadata'
    for row in rows:row['observed_at']=time.time()
    put_media(child,rows);materialize(child,info)
    restored=Library(child).get(item['id'])
    assert restored['title']!='Expired source metadata' and restored['script']=='My original local script'
