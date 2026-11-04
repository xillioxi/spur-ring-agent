import asyncio
import json
import re
import time
from dataclasses import replace
from datetime import date
from urllib.parse import parse_qs,urlparse

import httpx
import pytest
from fastapi.testclient import TestClient

from spur.auth import Accounts,COOKIE
from spur.config import Settings
from spur.social import SocialStore,SocialError,begin_oauth,consume_oauth,sync,analytics_brief,access_token
from spur.store import Store

CHANNEL='UC'+'a'*22


@pytest.fixture(autouse=True)
def test_encryption(monkeypatch):
    # Test-only cipher; production uses Windows DPAPI (tested separately).
    monkeypatch.setattr('spur.social.protect',lambda data,decrypt=False:bytes(data)[::-1])


@pytest.fixture
def client(tmp_path,monkeypatch):
    import spur.api as api
    monkeypatch.setattr(api,'settings',replace(Settings(),db_path=str(tmp_path/'root.db'),api_key='service'))
    with TestClient(api.app) as client:
        response=client.post('/auth/register',headers={'X-Spur-Auth':'1'},json={'username':'owner','display_name':'Owner','password':'test-passphrase-long'})
        client.csrf={'X-CSRF-Token':response.json()['csrf_token']}
        yield client


def prepare(store,platform='youtube',expires=3600):
    repo=SocialStore(store);repo.save_app(platform,'app-id','app-secret','http://testserver/social/'+platform+'/callback','v24.0')
    repo.connect(platform,{'access_token':'access-secret','refresh_token':'refresh-secret','expires_in':expires},
                 [{'id':CHANNEL if platform=='youtube' else '123456789','name':'My channel'}])
    return repo


def test_developer_token_connection_requires_session_and_csrf(client,monkeypatch):
    calls=[]
    async def verified(db,token,transport):
        calls.append(token)
        return {'status':'connected','account_name':'studio'}
    monkeypatch.setattr('spur.instagram_auth.connect_developer_token',verified)
    body={'access_token':'fictional-token-for-api-test'}
    assert client.post('/social/instagram/developer-token',json=body).status_code==403
    result=client.post('/social/instagram/developer-token',headers=client.csrf,json=body)
    assert result.status_code==200 and result.json()['account_name']=='studio'
    assert calls==[body['access_token']]
    client.cookies.clear()
    assert client.post('/social/instagram/developer-token',json=body).status_code==401


def run_sync(store,job,handler):
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:await sync(store,job,client)
    asyncio.run(run())


def youtube_handler(request):
    assert request.headers['authorization']=='Bearer access-secret'
    assert 'access_token' not in request.url.params
    if request.url.path=='/youtube/v3/videos':return httpx.Response(200,json={'items':[{'id':'video-1','snippet':{'title':'Paris walking route'}}]})
    params=request.url.params;metrics=params['metrics'].split(',')
    values=[100,200,120,5,1,10,2,3]
    dimensions=params.get('dimensions')
    if dimensions=='day':
        names=['day']+metrics;rows=[['2026-10-01']+values,['2026-10-02']+values]
    elif dimensions=='video':names=['video']+metrics;rows=[['video-1']+values]
    else:names=metrics;rows=[values]
    return httpx.Response(200,json={'columnHeaders':[{'name':name} for name in names],'rows':rows})


def test_oauth_setup_callback_and_secrets_are_private(client,monkeypatch):
    import spur.api as api
    assert client.put('/social/youtube/app',json={'client_id':'google-app','client_secret':'app-secret'}).status_code==403
    result=client.put('/social/youtube/app',headers=client.csrf,json={'client_id':'google-app','client_secret':'app-secret'})
    assert result.status_code==200 and 'app-secret' not in result.text
    connect=client.post('/social/youtube/connect',headers=client.csrf)
    assert connect.status_code==200 and 'SameSite=lax' in connect.headers['set-cookie']
    query=parse_qs(urlparse(connect.json()['authorization_url']).query)
    assert query['code_challenge_method']==['S256'] and 'yt-analytics.readonly' in query['scope'][0]
    assert 'publish' not in query['scope'][0] and 'app-secret' not in connect.text
    original_async=httpx.AsyncClient
    def handler(request):
        if request.url.host=='oauth2.googleapis.com':
            body=parse_qs(request.content.decode());assert body['client_secret']==['app-secret'] and body['code_verifier']
            return httpx.Response(200,json={'access_token':'access-secret','refresh_token':'refresh-secret','expires_in':3600})
        return httpx.Response(200,json={'items':[{'id':CHANNEL,'snippet':{'title':'My owned channel'}}]})
    monkeypatch.setattr(api.httpx,'AsyncClient',lambda **kwargs:original_async(transport=httpx.MockTransport(handler),**kwargs))
    login_cookie=client.cookies.get(COOKIE)
    client.cookies.delete(COOKIE)  # Simulate Strict cookie withheld on cross-site callback.
    response=client.get('/social/youtube/callback',params={'state':query['state'][0],'code':'one-time-code'})
    assert response.status_code==200 and 'social-return.js' in response.text
    assert 'access-secret' not in response.text
    client.cookies.set(COOKIE,login_cookie,domain='testserver.local',path='/')
    public=client.get('/social/connections').json()['connections'][0]
    assert public['status']=='connected' and public['account_name']=='My owned channel'
    assert 'access-secret' not in json.dumps(public) and 'app-secret' not in json.dumps(public)
    with client.app.state.store.connect() as db:
        assert db.execute('SELECT COUNT(*) FROM social_oauth_tickets').fetchone()[0]==0
        assert b'access-secret' not in bytes(db.execute('SELECT tokens FROM social_connections').fetchone()[0])
    assert client.get('/social/youtube/callback',params={'state':query['state'][0],'code':'one-time-code'}).status_code==400


def test_tickets_are_session_bound_and_single_use(tmp_path):
    store=Store(str(tmp_path/'state.db'));accounts=Accounts(store)
    user=accounts.create_user('owner','Owner','test-passphrase-long');session=accounts.create_session(user['id'])
    SocialStore(store).save_app('youtube','google-app','app-secret','http://testserver/social/youtube/callback','v24.0')
    result=begin_oauth(store,store,user['id'],session['token'],'youtube');state=parse_qs(urlparse(result['url']).query)['state'][0]
    with pytest.raises(SocialError):consume_oauth(store,'youtube',result['ticket'],'wrong-state')
    assert consume_oauth(store,'youtube',result['ticket'],state)['user_id']==user['id']
    with pytest.raises(SocialError):consume_oauth(store,'youtube',result['ticket'],state)
    result=begin_oauth(store,store,user['id'],session['token'],'youtube');state=parse_qs(urlparse(result['url']).query)['state'][0]
    accounts.logout(session['token'])
    with pytest.raises(SocialError,match='expired'):consume_oauth(store,'youtube',result['ticket'],state)


def test_youtube_sync_persists_real_metrics_and_brief(tmp_path):
    store=Store(str(tmp_path/'sync.db'));repo=prepare(store)
    jid=repo.enqueue_sync('youtube',28);assert repo.enqueue_sync('youtube',28)==jid
    run_sync(store,store.claim(),youtube_handler)
    snapshot=repo.latest('youtube',28)
    assert store.job(jid)['status']=='succeeded' and snapshot['totals']['views']==100
    assert snapshot['content'][0]['title']=='Paris walking route' and len(snapshot['series'])==2
    brief=analytics_brief(snapshot)
    assert brief['observations'][0]['value']==100 and brief['observations'][0]['change_percent']==0
    assert brief['top_content'][0]['id']=='video-1'
    repo.disconnect('youtube',True);assert repo.latest('youtube',28) is None


def test_disconnect_during_sync_cannot_restore_deleted_data(tmp_path):
    store=Store(str(tmp_path/'race.db'));repo=prepare(store);jid=repo.enqueue_sync('youtube',28)
    calls=[]
    def handler(request):
        if not calls:repo.disconnect('youtube',True)
        calls.append(request)
        return youtube_handler(request)
    run_sync(store,store.claim(),handler)
    assert store.job(jid)['result']['skipped']=='Connection changed'
    assert repo.connection('youtube') is None and repo.latest('youtube',28) is None


def test_instagram_missing_metrics_are_not_zero_and_media_is_labelled(tmp_path):
    store=Store(str(tmp_path/'instagram.db'));repo=prepare(store,'instagram');repo.enqueue_sync('instagram',28)
    def handler(request):
        if request.url.path.endswith('/insights'):
            metric=request.url.params['metric']
            if metric=='views':return httpx.Response(400,json={'error':{'message':'unsupported'}})
            return httpx.Response(200,json={'data':[{'name':metric,'total_value':{'value':250}}]})
        return httpx.Response(200,json={'data':[{'id':'media-1','caption':'Paris tips','timestamp':str(date.today())+'T12:00:00+0000','permalink':'https://www.instagram.com/p/example/','like_count':3,'comments_count':0}]})
    run_sync(store,store.claim(),handler);snapshot=repo.latest('instagram',28)
    assert snapshot['totals']['reach']==250 and 'views' not in snapshot['totals']
    assert snapshot['content'][0]['metrics']=={'likes':3.0,'comments':0.0}
    assert any('lifetime' in note for note in snapshot['limitations'])
    assert any('views is unavailable' in note for note in snapshot['limitations'])


def test_refresh_tokens_and_expired_instagram(tmp_path):
    store=Store(str(tmp_path/'refresh.db'));repo=prepare(store,expires=-1)
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request:httpx.Response(200,json={'access_token':'renewed-secret','expires_in':3600}))) as client:
            assert await access_token(repo,repo.connection('youtube'),client)=='renewed-secret'
            prepare(store,'instagram',expires=-1)
            with pytest.raises(SocialError,match='expired'):await access_token(repo,repo.connection('instagram'),client)
    asyncio.run(run())
    assert repo.connection('youtube')['tokens']['refresh_token']=='refresh-secret'


def test_social_api_isolation_account_selection_and_saved_analysis(client):
    root=client.app.state.store;repo=prepare(root)
    repo.connect('instagram',{'access_token':'private','expires_in':3600},[{'id':'123','name':'One'},{'id':'456','name':'Two'}])
    assert client.post('/social/instagram/sync',headers=client.csrf,json={'days':28}).status_code==422
    assert client.post('/social/instagram/account',headers=client.csrf,json={'account_id':'unknown'}).status_code==422
    assert client.post('/social/instagram/account',headers=client.csrf,json={'account_id':'456'}).status_code==200
    jid=repo.enqueue_sync('youtube',28);run_sync(root,root.claim(),youtube_handler)
    response=client.post('/social/youtube/brief',headers=client.csrf,json={'days':28})
    assert response.status_code==200 and client.get('/knowledge').json()[0]['id']==response.json()['knowledge_id']
    client.cookies.clear()
    fresh=client.post('/auth/register',headers={'X-Spur-Auth':'1'},json={'username':'new-user','display_name':'New','password':'test-passphrase-long'})
    assert fresh.status_code==201
    connections=client.get('/social/connections').json()['connections']
    assert connections[0]['configured']
    assert all(item['status']=='disconnected' and not item['can_manage'] for item in connections)
    assert all('client_id' not in item and 'callback_url' not in item for item in connections)
    assert client.get('/social/youtube/analytics').json()['snapshot'] is None
    assert client.get('/jobs/'+jid).status_code==404


def test_provider_errors_do_not_save_tokens_in_job_errors(tmp_path):
    store=Store(str(tmp_path/'error.db'));repo=prepare(store);repo.enqueue_sync('youtube',28);job=store.claim()
    with pytest.raises(SocialError,match='denied'):
        run_sync(store,job,lambda request:httpx.Response(403,json={'error':{'message':'private access-secret'}}))
    assert 'access-secret' not in repo.public('youtube')['error']
    assert repo.latest('youtube',28) is None


@pytest.mark.parametrize('reason,expected',[
    ('youtubeSignupRequired','has no YouTube channel'),
    ('SERVICE_DISABLED','YouTube Data API v3 is disabled'),
    ('insufficientPermissions','permissions are missing'),
    ('quotaExceeded','quota or rate limit'),
])
def test_google_errors_are_actionable_without_exposing_provider_payload(reason,expected):
    from spur.social import request_json
    async def run():
        def handler(request):
            return httpx.Response(403,json={'error':{'message':'private-token-and-email',
                'errors':[{'reason':reason}],'details':[{'reason':reason}]}})
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            with pytest.raises(SocialError,match=expected) as exc:
                await request_json(http,'GET','https://www.googleapis.com/youtube/v3/channels')
            assert 'private-token-and-email' not in str(exc.value)
    asyncio.run(run())


@pytest.mark.parametrize('channel_error',[True,False])
def test_channel_discovery_failure_explains_account_requirement_without_saving_tokens(client,monkeypatch,channel_error):
    import spur.api as api
    assert client.put('/social/youtube/app',headers=client.csrf,
                      json={'client_id':'google-app','client_secret':'app-secret'}).status_code==200
    connect=client.post('/social/youtube/connect',headers=client.csrf)
    state=parse_qs(urlparse(connect.json()['authorization_url']).query)['state'][0]
    original=httpx.AsyncClient
    def handler(request):
        if request.url.host=='oauth2.googleapis.com':
            return httpx.Response(200,json={'access_token':'private-token','refresh_token':'private-refresh','expires_in':3600})
        if channel_error:
            return httpx.Response(401,json={'error':{'message':'private-token',
                'errors':[{'reason':'youtubeSignupRequired'}]}})
        return httpx.Response(200,json={'items':[]})
    monkeypatch.setattr(api.httpx,'AsyncClient',lambda **kwargs:original(transport=httpx.MockTransport(handler),**kwargs))
    response=client.get('/social/youtube/callback',params={'state':state,'code':'private-code'})
    assert response.status_code==400 and 'YouTube channel' in response.text
    assert all(value not in response.text for value in ('private-token','private-refresh','private-code'))
    assert SocialStore(client.app.state.store).connection('youtube') is None
    notice=client.app.state.store.get_runtime('social_notice',{})
    assert 'YouTube channel' in notice['message'] and 'private-token' not in str(notice)


def test_missing_oauth_cookie_finishes_only_for_original_session_with_csrf(client,monkeypatch):
    import spur.api as api
    client.put('/social/youtube/app',headers=client.csrf,json={'client_id':'google-app','client_secret':'app-secret'})
    connect=client.post('/social/youtube/connect',headers=client.csrf)
    state=parse_qs(urlparse(connect.json()['authorization_url']).query)['state'][0]
    owner_cookies=dict(client.cookies);owner_csrf=dict(client.csrf)
    client.cookies.clear()  # No Lax OAuth cookie or Strict login cookie on provider return.
    returned=client.get('/social/youtube/callback',params={'state':state,'code':'private-authorization-code'})
    assert returned.status_code==200 and 'social-complete.js' in returned.text
    assert 'private-authorization-code' not in returned.text
    nonce=re.search(r'data-continuation="([A-Za-z0-9_-]+)"',returned.text)[1]
    body={'continuation':nonce};root=client.app.state.store
    with root.connect() as db:
        encrypted=bytes(db.execute('SELECT payload FROM social_oauth_returns').fetchone()[0])
        assert b'private-authorization-code' not in encrypted
    assert client.post('/social/youtube/complete',json=body).status_code==401
    other=client.post('/auth/register',headers={'X-Spur-Auth':'1'},json={
        'username':'another-user','display_name':'Another','password':'test-passphrase-long'})
    other_csrf={'X-CSRF-Token':other.json()['csrf_token']}
    denied=client.post('/social/youtube/complete',headers=other_csrf,json=body)
    assert denied.status_code==422 and 'different sign-in' in denied.text
    client.cookies.clear();client.cookies.update(owner_cookies)
    assert client.post('/social/youtube/complete',json=body).status_code==403
    original=httpx.AsyncClient;calls=[]
    def handler(request):
        calls.append(request.url.host)
        if request.url.host=='oauth2.googleapis.com':
            assert parse_qs(request.content.decode())['code']==['private-authorization-code']
            return httpx.Response(200,json={'access_token':'private-access','refresh_token':'private-refresh','expires_in':3600})
        return httpx.Response(200,json={'items':[{'id':CHANNEL,'snippet':{'title':'Owned channel'}}]})
    monkeypatch.setattr(api.httpx,'AsyncClient',lambda **kwargs:original(transport=httpx.MockTransport(handler),**kwargs))
    result=client.post('/social/youtube/complete',headers=owner_csrf,json=body)
    assert result.status_code==200 and result.json()['success']
    assert len(calls)==2 and 'private-access' not in result.text
    assert client.post('/social/youtube/complete',headers=owner_csrf,json=body).status_code==422
    assert len(calls)==2
    assert SocialStore(root).connection('youtube')['account_name']=='Owned channel'
    with root.connect() as db:
        assert db.execute('SELECT count(*) FROM social_oauth_returns').fetchone()[0]==0
        assert db.execute('SELECT count(*) FROM social_oauth_tickets').fetchone()[0]==0


def test_oauth_return_expiry_and_original_session_binding(client):
    from spur.social import stage_oauth_return,consume_oauth_return
    root=client.app.state.store;user=client.get('/auth/me').json()['user'];session=client.cookies.get(COOKIE)
    SocialStore(root).save_app('youtube','app-id','secret','http://testserver/social/youtube/callback','v24.0')
    flow=begin_oauth(root,root,user['id'],session,'youtube')
    state=parse_qs(urlparse(flow['url']).query)['state'][0]
    with pytest.raises(SocialError):stage_oauth_return(root,'youtube','wrong-state','code','')
    nonce=stage_oauth_return(root,'youtube',state,'code','')
    with pytest.raises(SocialError,match='different sign-in'):
        consume_oauth_return(root,'youtube',nonce,user['id'],'different-session')
    with root.connect() as db:db.execute('UPDATE social_oauth_returns SET expires=0')
    with pytest.raises(SocialError,match='expired'):
        consume_oauth_return(root,'youtube',nonce,user['id'],session)
