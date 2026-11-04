import asyncio
import json
from dataclasses import replace

import httpx
import pytest
from fastapi.testclient import TestClient
from spur.config import Settings
from spur.store import Store
from spur.social import SocialStore
from spur.video_search import SearchStore,SearchInput,DataProviderInput,SearchError,search_videos,search_once,unpack


@pytest.fixture(autouse=True)
def cipher(monkeypatch):monkeypatch.setattr('spur.social.protect',lambda data,decrypt=False:bytes(data)[::-1])


def provider(store,cost=0.01,**kw):
    repo=SearchStore(store);repo.save(DataProviderInput(api_key='provider-secret-key',enabled=True,max_request_cost_usd=cost,**kw));return repo


def invoke(store,value,handler,once=None):
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await (search_once(store,value,client,once) if once else search_videos(store,value,client))
    return asyncio.run(run())


def test_official_youtube_search_and_metadata(tmp_path):
    store=Store(str(tmp_path/'search.db'));social=SocialStore(store)
    social.save_app('youtube','client','secret','http://testserver/social/youtube/callback','')
    social.connect('youtube',{'access_token':'youtube-token','expires_in':3600},[{'id':'UC'+'a'*22,'name':'Creator'}])
    calls=[]
    def handler(request):
        calls.append(request);assert request.headers['authorization']=='Bearer youtube-token'
        assert 'access_token' not in request.url.params
        if request.url.path.endswith('/search'):
            assert request.url.params['q']=='Paris cheap eats' and 'publishedAfter' in request.url.params
            return httpx.Response(200,json={'items':[{'id':{'videoId':'abcdefghijk'}}],'nextPageToken':'more'})
        return httpx.Response(200,json={'items':[{'id':'abcdefghijk','snippet':{'title':'A real result','channelTitle':'Creator','publishedAt':'2099-01-01T00:00:00Z'},'statistics':{'viewCount':'100','likeCount':'0'}}]})
    result=invoke(store,SearchInput(query='Paris cheap eats'),handler)
    assert len(calls)==2 and result['provider']=='youtube_official'
    assert result['items'][0]['metrics']=={'views':100,'likes':0,'comments':None}
    assert result['items'][0]['url']=='https://www.youtube.com/watch?v=abcdefghijk'
    assert any('More search pages' in w for w in result['warnings'])


@pytest.mark.parametrize('platform,payload',[('tiktok',{'data':{'data':[{'aweme_info':{'aweme_id':'123','desc':'Food','author':{'unique_id':'creator'},'statistics':{'play_count':100}}}]}}),('instagram',{'data':{'items':[{'media':{'pk':'123','code':'short-code','caption':{'text':'Food'},'play_count':100}}]}}),('rednote',{'data':{'items':[{'id':'abc123','note_card':{'display_title':'Food','type':'video','interact_info':{'liked_count':'12'}}}]}})])
def test_tikhub_adapters_use_fixed_endpoints_and_preserve_missing_dates(tmp_path,platform,payload):
    store=Store(str(tmp_path/'search.db'));repo=provider(store)
    calls=[]
    def handler(request):
        calls.append(request);assert request.url.host=='api.tikhub.io'
        assert request.headers['authorization']=='Bearer provider-secret-key'
        assert request.url.params['keyword']=='Food'
        return httpx.Response(200,json={'code':200,**payload})
    result=invoke(store,SearchInput(platform=platform,query='Food'),handler)
    assert len(calls)==1 and len(result['items'])==1
    assert result['items'][0]['published'] is None and not result['items'][0]['date_verified']
    assert 'provider-secret-key' not in json.dumps(result)
    assert repo.usage()['requests']==1


def test_disabled_provider_and_unsupported_platform_do_not_make_requests(tmp_path):
    store=Store(str(tmp_path/'search.db'))
    def forbidden(request):raise AssertionError('Network must not be used')
    with pytest.raises(SearchError,match='Configure and enable'):invoke(store,SearchInput(platform='rednote',query='Food'),forbidden)
    with pytest.raises(SearchError,match='LinkedIn'):invoke(store,SearchInput(platform='linkedin',query='Food'),forbidden)
    assert SearchStore(store).usage()['requests']==0


def test_budget_is_reserved_even_on_failure_and_key_rotation_does_not_reset(tmp_path):
    store=Store(str(tmp_path/'search.db'));repo=provider(store,cost=15)
    def handler(request):return httpx.Response(429,json={'secret':'private-vendor-body'})
    value=SearchInput(platform='instagram',query='Food')
    with pytest.raises(SearchError,match='429'):invoke(store,value,handler)
    assert repo.usage()['reserved_usd']==15
    repo.save(DataProviderInput(api_key='replacement-key',enabled=True,max_request_cost_usd=15))
    with pytest.raises(SearchError,match='budget reached'):invoke(store,value,lambda req:pytest.fail('Budget must block network'))
    assert repo.usage()['requests']==1 and 'api_key' not in repo.public()


def test_schema_failure_is_distinct_from_empty_search(tmp_path):
    with pytest.raises(SearchError,match='connector error'):unpack('tiktok',{'data':{'unexpected':[]}})
    assert unpack('instagram',{'data':{'items':[]}})==([],0)
    with pytest.raises(SearchError,match='unsupported format'):unpack('rednote',{'data':{'items':[{'unknown':'shape'}]}})


def test_job_retry_reuses_results_and_failed_attempt_does_not_charge_again(tmp_path):
    store=Store(str(tmp_path/'search.db'));repo=provider(store)
    value=SearchInput(platform='instagram',query='Food')
    def handler(request):return httpx.Response(200,json={'code':200,'data':{'items':[]}})
    assert invoke(store,value,handler,once='job-1')['items']==[]
    assert invoke(store,value,lambda req:pytest.fail('Must reuse previous result'),once='job-1')['items']==[]
    assert repo.usage()['requests']==1
    with pytest.raises(SearchError):invoke(store,value,lambda req:httpx.Response(500,json={}),once='job-2')
    with pytest.raises(SearchError):invoke(store,value,lambda req:pytest.fail('Must not retry uncertain/failed paid request'),once='job-2')
    assert repo.usage()['requests']==2


def test_search_routes_require_auth_csrf_and_keep_provider_credentials_private(tmp_path,monkeypatch):
    import spur.api as api
    monkeypatch.setattr(api,'settings',replace(Settings(),db_path=str(tmp_path/'root.db'),api_key='service'))
    with TestClient(api.app) as client:
        assert client.get('/search/providers').status_code==401
        response=client.post('/auth/register',headers={'X-Spur-Auth':'1'},json={'username':'owner','display_name':'Owner','password':'test-passphrase-long'})
        csrf={'X-CSRF-Token':response.json()['csrf_token']}
        body={'api_key':'provider-secret-key','enabled':True,'max_request_cost_usd':0.05}
        assert client.put('/search/providers/tikhub',json=body).status_code==403
        saved=client.put('/search/providers/tikhub',json=body,headers=csrf)
        assert saved.status_code==200 and 'provider-secret-key' not in saved.text
        assert client.post('/search/videos',json={'query':'Food'}).status_code==403
        client.cookies.clear()
        client.post('/auth/register',headers={'X-Spur-Auth':'1'},json={'username':'other','display_name':'Other','password':'test-passphrase-long'})
        public=client.get('/search/providers').json()
        assert not public['tikhub']['configured'] and public['tikhub']['usage']['requests']==0


def test_paid_search_requires_verified_price(tmp_path):
    store=Store(str(tmp_path/'search.db'))
    with pytest.raises(SearchError,match='maximum per-request price'):SearchStore(store).save(DataProviderInput(api_key='provider-secret-key',enabled=True))
