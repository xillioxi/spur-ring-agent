import asyncio
import json
import time
from datetime import datetime,timezone
from urllib.parse import parse_qs,urlparse

import httpx
import pytest
from spur.auth import Accounts
from spur.store import Store
from spur.social import SocialStore,SocialError,begin_oauth,exchange_code,access_token,tiktok_analytics,linkedin_analytics


@pytest.fixture(autouse=True)
def cipher(monkeypatch):
    monkeypatch.setattr('spur.social.protect',lambda data,decrypt=False:bytes(data)[::-1])


def setup(tmp_path,platform,redirect=None):
    store=Store(str(tmp_path/'store.db'));repo=SocialStore(store)
    repo.save_app(platform,'client','secret',redirect or 'https://app.example.test/social/'+platform+'/callback','202602' if platform=='linkedin' else '')
    return store,repo


def run(handler,work):
    async def invoke():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:return await work(client)
    return asyncio.run(invoke())


@pytest.mark.parametrize('platform,scope',[('tiktok','video.list'),('linkedin','rw_organization_admin')])
def test_new_oauth_urls_use_expected_scopes_and_state(tmp_path,platform,scope):
    store,repo=setup(tmp_path,platform);accounts=Accounts(store)
    user=accounts.create_user('owner','Owner','test-password-long');session=accounts.create_session(user['id'])
    result=begin_oauth(store,store,user['id'],session['token'],platform);query=parse_qs(urlparse(result['url']).query)
    assert scope in query['scope'][0] and query['state'] and 'secret' not in result['url']
    assert query['client_key' if platform=='tiktok' else 'client_id']==['client']
    if platform=='linkedin':assert 'openid' not in query['scope'][0]


def test_tiktok_http_callback_blocked_before_oauth_ticket(tmp_path):
    store,repo=setup(tmp_path,'tiktok','http://127.0.0.1:8000/social/tiktok/callback')
    assert repo.public('tiktok')['connect_ready'] is False
    with pytest.raises(SocialError,match='HTTPS'):begin_oauth(store,store,'user','session','tiktok')
    with store.connect() as db:assert db.execute('SELECT COUNT(*) FROM social_oauth_tickets').fetchone()[0]==0


@pytest.mark.parametrize('platform',['tiktok','linkedin'])
def test_exchange_discovers_only_authorized_accounts(tmp_path,platform):
    store,repo=setup(tmp_path,platform)
    def handler(request):
        if 'token' in request.url.path.lower():
            body=parse_qs(request.content.decode());assert body['client_secret']==['secret'] and body['grant_type']==['authorization_code']
            return httpx.Response(200,json={'access_token':'access','expires_in':3600,'scope':'user.info.basic,video.list','open_id':'opaque_tt-id'})
        assert request.headers['authorization']=='Bearer access'
        if request.url.path.endswith('/user/info/'):return httpx.Response(200,json={'data':{'user':{'open_id':'opaque_tt-id','display_name':'Creator'}},'error':{'code':'ok'}})
        if request.url.path.endswith('/organizationAcls'):
            assert request.url.params['role']=='ADMINISTRATOR'
            return httpx.Response(200,json={'elements':[{'role':'ADMINISTRATOR','state':'APPROVED','organization':'urn:li:organization:123'},{'role':'ADMINISTRATOR','state':'REQUESTED','organization':'urn:li:organization:456'},{'role':'CONTENT_ADMIN','state':'APPROVED','organization':'urn:li:organization:789'}]})
        assert request.url.path=='/rest/organizations/123'
        return httpx.Response(200,json={'localizedName':'Spur Ring'})
    app=repo.app(platform);run(handler,lambda client:exchange_code(store,platform,'code',{'client_id':'client','redirect_uri':app['redirect_uri']},client))
    c=repo.connection(platform);assert c['account_id']==('123' if platform=='linkedin' else 'opaque_tt-id')
    assert len(c['candidates'])==1 and 'access' not in json.dumps(repo.public(platform))


def test_tiktok_refresh_rotates_refresh_token(tmp_path):
    store,repo=setup(tmp_path,'tiktok');repo.connect('tiktok',{'access_token':'old','refresh_token':'old-refresh','expires_in':-1},[{'id':'opaque','name':'Creator'}])
    def handler(request):
        assert request.url.host=='open.tiktokapis.com'
        body=parse_qs(request.content.decode());assert body['client_key']==['client'] and body['refresh_token']==['old-refresh']
        return httpx.Response(200,json={'access_token':'new','refresh_token':'rotated','expires_in':3600})
    assert run(handler,lambda client:access_token(repo,repo.connection('tiktok'),client))=='new'
    assert repo.connection('tiktok')['tokens']['refresh_token']=='rotated'


def test_tiktok_lifetime_metrics_publish_filter_and_missing_fields(tmp_path):
    store,repo=setup(tmp_path,'tiktok');repo.connect('tiktok',{'access_token':'access','scope':'user.info.basic,video.list'},[{'id':'opaque','name':'Creator'}])
    def handler(request):
        assert request.url.path=='/v2/video/list/'
        return httpx.Response(200,json={'data':{'videos':[{'id':'recent','title':'Video','create_time':time.time(),'view_count':50,'comment_count':0},{'id':'old','create_time':1,'view_count':900}], 'has_more':False},'error':{'code':'ok'}})
    result=run(handler,lambda client:tiktok_analytics(repo.connection('tiktok'),'access',7,client))
    assert result['totals']['views']==50 and result['totals']['comments']==0
    assert 'likes' not in result['totals'] and 'follower_count' not in result['totals']
    assert len(result['content'])==1 and result['metric_basis']=='lifetime_for_published_videos'


def test_linkedin_company_organic_analytics_and_account_guard(tmp_path):
    store,repo=setup(tmp_path,'linkedin');repo.connect('linkedin',{'access_token':'access'},[{'id':'123','name':'Spur Ring'}])
    def handler(request):
        assert request.headers['LinkedIn-Version']=='202602'
        assert request.url.path.endswith('/organizationalEntityShareStatistics')
        assert request.url.params['organizationalEntity']=='urn:li:organization:123'
        assert 'timeGranularityType:DAY' in request.url.params['timeIntervals']
        return httpx.Response(200,json={'elements':[{'organizationalEntity':'urn:li:organization:123','totalShareStatistics':{'impressionCount':100,'clickCount':2,'likeCount':0,'uniqueImpressionsCount':75}},{'organizationalEntity':'urn:li:organization:123','totalShareStatistics':{'impressionCount':50,'clickCount':3,'likeCount':1,'uniqueImpressionsCount':40}}]})
    result=run(handler,lambda client:linkedin_analytics(repo,repo.connection('linkedin'),'access',28,client))
    assert result['totals']=={'impressions':150,'clicks':5,'likes':1}
    assert result['previous']=={} and result['metric_basis']=='organization_organic_period'
    with pytest.raises(SocialError,match='different Page'):
        run(lambda req:httpx.Response(200,json={'elements':[{'organizationalEntity':'urn:li:organization:999'}]}),lambda client:linkedin_analytics(repo,repo.connection('linkedin'),'access',28,client))


def test_tiktok_http_200_error_is_not_success(tmp_path):
    store,repo=setup(tmp_path,'tiktok');repo.connect('tiktok',{'access_token':'access'},[{'id':'opaque','name':'Creator'}])
    with pytest.raises(SocialError,match='unsuccessful'):
        run(lambda req:httpx.Response(200,json={'error':{'code':'scope_not_authorized','message':'private-provider-detail'}}),lambda client:tiktok_analytics(repo.connection('tiktok'),'access',7,client))
