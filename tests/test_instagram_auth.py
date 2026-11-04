import asyncio
import logging
import time

import httpx
import pytest

from spur.instagram_auth import connect_developer_token
from spur.publishing import Posts
from spur.social import SocialStore, SocialError
from spur.store import Store

TOKEN='developer-secret-token-do-not-log'


@pytest.fixture
def db(tmp_path,monkeypatch):
    monkeypatch.setattr('spur.social.protect',lambda b,decrypt=False:bytes(b)[::-1])
    store=Store(tmp_path/'root.db')
    SocialStore(store).save_app('instagram','12345','app-secret','http://127.0.0.1:8000/social/instagram/callback','v24.0')
    return store


def connect(db,handler):
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await connect_developer_token(db,TOKEN,client)
    return asyncio.run(run())


def handler(request):
    assert request.url.host=='graph.facebook.com'
    if request.url.path.endswith('/debug_token'):
        assert request.url.params['input_token']==TOKEN
        assert request.headers['authorization']=='Bearer 12345|app-secret'
        return httpx.Response(200,json={'data':{'app_id':'12345','is_valid':True,'type':'USER','expires_at':time.time()+3500}})
    assert request.headers['authorization']=='Bearer '+TOKEN
    assert 'access_token' not in request.url.params
    if request.url.path.endswith('/permissions'):
        return httpx.Response(200,json={'data':[{'permission':p,'status':'granted'} for p in ['instagram_basic','pages_show_list','pages_read_engagement','instagram_content_publish','instagram_manage_insights']]})
    return httpx.Response(200,json={'data':[{'id':'99','access_token':'private-page-token','instagram_business_account':{'id':'1234','username':'studio'}}]})


def test_verified_local_connection_supports_live_publishing_and_never_logs_token(db,caplog):
    with caplog.at_level(logging.INFO,logger='httpx'):result=connect(db,handler)
    assert TOKEN not in caplog.text and 'app-secret' not in caplog.text
    assert result['status']=='connected' and result['account_name']=='studio'
    assert 'tokens' not in result and 'access_token' not in result
    c=SocialStore(db).connection('instagram')
    assert c['tokens']['auth_method']=='developer_token'
    assert c['tokens']['page_tokens']=={'1234':'private-page-token'}
    assert 'private-page-token' not in str(result)
    ready=Posts(db).readiness()
    assert ready['connected'] and ready['publish_permission'] and ready['authorization_current']
    assert ready['setup_issue']==''


@pytest.mark.parametrize('change',[{'app_id':'999'},{'is_valid':False},{'type':'PAGE'},{'expires_at':0},{'data_access_expires_at':time.time()-10}])
def test_rejects_wrong_app_type_or_expiry_without_overwriting_connection(db,change):
    def bad(request):
        if request.url.path.endswith('/debug_token'):
            return httpx.Response(200,json={'data':{'app_id':'12345','type':'USER','is_valid':True,'expires_at':time.time()+3500,**change}})
        pytest.fail('Invalid token must be rejected before querying account data')
    with pytest.raises(SocialError):connect(db,bad)
    assert SocialStore(db).connection('instagram') is None


def test_no_linked_professional_account_is_actionable_and_not_saved(db):
    def empty(request):
        return httpx.Response(200,json={'data':[]}) if request.url.path.endswith('/accounts') else handler(request)
    with pytest.raises(SocialError,match='Link your Business or Creator'):connect(db,empty)
    assert SocialStore(db).connection('instagram') is None


def test_missing_scope_does_not_save(db):
    def missing(request):
        return httpx.Response(200,json={'data':[]}) if request.url.path.endswith('/permissions') else handler(request)
    with pytest.raises(SocialError,match='required permissions'):connect(db,missing)
    assert SocialStore(db).connection('instagram') is None


@pytest.mark.parametrize('linked_id,expected', [('1234', True), ('4321', False)])
def test_granular_portfolio_grant_with_empty_page_list(db, linked_id, expected):
    def portfolio(request):
        path = request.url.path
        if path.endswith('/debug_token'):
            info = handler(request).json()['data']
            info['granular_scopes'] = [
                {'scope': 'pages_show_list', 'target_ids': ['99']},
                {'scope': 'instagram_basic', 'target_ids': ['1234']},
            ]
            return httpx.Response(200, json={'data': info})
        if path.endswith('/accounts'):
            return httpx.Response(200, json={'data': []})
        if path.endswith('/99'):
            return httpx.Response(200, json={'id': '99', 'access_token': 'page-grant',
                'instagram_business_account': {'id': linked_id, 'username': 'studio'}})
        return handler(request)

    if expected:
        assert connect(db, portfolio)['account_name'] == 'studio'
        assert SocialStore(db).connection('instagram')['tokens']['page_tokens'] == {'1234': 'page-grant'}
    else:
        with pytest.raises(SocialError):
            connect(db, portfolio)
        assert SocialStore(db).connection('instagram') is None


def test_account_pagination_uses_fixed_host_and_returns_account_choice(db):
    def pages(request):
        if request.url.path.endswith('/accounts'):
            if 'after' in request.url.params:
                assert request.url.params['after']=='cursor'
                return httpx.Response(200,json={'data':[{'instagram_business_account':{'id':'5678','username':'second'}}]})
            return httpx.Response(200,json={'data':[{'instagram_business_account':{'id':'1234','username':'first'}}],
                'paging':{'next':'https://evil.invalid/?access_token=never-follow','cursors':{'after':'cursor'}}})
        return handler(request)
    result=connect(db,pages)
    assert result['status']=='choose_account' and len(result['accounts'])==2
