import pytest
import httpx
from spur.mock_profiles import Profiles,MockProfileInput,import_step,media,reference
from spur.video_search import SearchStore,DataProviderInput,SearchError
from spur.store import Store
from spur.public_social_profiles import parse_page
from tests.test_mock_profiles import run,cipher


@pytest.mark.parametrize('platform,url,expected',[
    ('tiktok','https://www.tiktok.com/@studio','studio'),
    ('instagram','https://www.instagram.com/studio/reels/','studio'),
])
def test_profile_urls(platform,url,expected):assert reference(platform,url)==expected


@pytest.mark.parametrize('platform,url',[
    ('tiktok','https://www.tiktok.com/@studio/video/123'),
    ('instagram','https://www.instagram.com/p/abc/'),
    ('instagram','https://instagram.com/accounts/'),
    ('tiktok','https://evil.test/@studio'),
])
def test_reject_posts_and_foreign_urls(platform,url):
    with pytest.raises(SearchError):reference(platform,url)


def item(platform,identifier):
    if platform=='tiktok':
        return {'aweme_id':identifier,'desc':'Studio shoot','author':{'unique_id':'studio'},'create_time':1700000000,
                'video':{'duration':45000,'cover':{'url_list':['https://cdn.example/cover.jpg']}},
                'statistics':{'play_count':1000,'digg_count':50,'comment_count':3,'share_count':4}}
    return {'pk':identifier,'code':'post'+identifier,'caption':{'text':'Studio shoot'},'user':{'username':'studio'},
            'taken_at':1700000000,'media_type':2 if identifier=='1' else 8,'video_duration':45,
            'play_count':1000 if identifier=='1' else None,'like_count':50,'comment_count':3}


@pytest.mark.parametrize('platform',['instagram','tiktok'])
def test_import_pages_reports_library_analytics_and_agent_access(tmp_path,platform):
    root=Store(str(tmp_path/'root.db'));budget=SearchStore(root)
    budget.save(DataProviderInput(api_key='unit-test-provider',enabled=True,max_request_cost_usd=.01))
    registry=Profiles(root);info=registry.create(MockProfileInput(platform=platform,mode='public',source='@studio'))
    child=registry.workspace(info['id']);calls=[]
    def handler(request):
        calls.append(request)
        assert request.url.host=='api.tikhub.io'
        assert request.url.params['username' if platform=='instagram' else 'unique_id']=='studio'
        if len(calls)==1:rows=[item(platform,'1')]
        else:rows=[item(platform,'1'),item(platform,'2')]  # Provider overlap must not duplicate records.
        data={'items':rows,'pagination_token':'next' if len(calls)==1 else None} if platform=='instagram' else {'aweme_list':rows,'has_more':1 if len(calls)==1 else 0,'max_cursor':100}
        return httpx.Response(200,json={'code':200,'data':data})
    run(lambda client:import_step(child,child.claim(),client),handler)
    assert not registry.get(info['id'])['complete']
    run(lambda client:import_step(child,child.claim(),client),handler)
    state=registry.get(info['id']);assert state['complete'] and state['imported']==2
    assert len(calls)==2 and budget.usage()['requests']==2
    rows=media(child);assert rows[0]['duration_seconds']==45
    assert rows[0]['metrics']['likes']==50
    from spur.profile_analytics import analyze
    assert analyze(child)['coverage']['total_records']==2
    from spur.catalog_tools import browse,BrowseInput,read,VideoInput
    assert browse(child,BrowseInput())['catalog_records']==2
    assert read(child,VideoInput(video_id='1'))['video']['metrics']['views']==1000
    from spur.metadata_reports import generate,MetadataReportInput
    assert len(generate(child,MetadataReportInput(search_id=state['search_id']))['content']['artifact']['data']['evidence'])==2
    from spur.library import Library
    formats={r['format'] for r in Library(child).list()}
    assert formats==({'tiktok_video'} if platform=='tiktok' else {'instagram_reel','instagram_carousel'})
    assert root.items(0,1800000000)==[]


@pytest.mark.parametrize('data',[
    {'aweme_list':[]},
    {'aweme_list':[],'has_more':1},
    {'aweme_list':[],'has_more':0,'status_code':102},
])
def test_unknown_or_denied_response_not_marked_complete(data):
    with pytest.raises(SearchError):parse_page('tiktok',{'code':200,'data':data},'studio')


@pytest.mark.parametrize('platform',['instagram','tiktok'])
def test_missing_provider_does_not_create_empty_mock(tmp_path,platform):
    registry=Profiles(Store(str(tmp_path/'root.db')))
    with pytest.raises(SearchError,match='TikHub'):registry.create(MockProfileInput(platform=platform,mode='public',source='@studio'))
    assert registry.list()==[]


@pytest.mark.parametrize('platform',['instagram','tiktok'])
def test_uncertain_response_never_repeats_paid_request(tmp_path,platform):
    root=Store(str(tmp_path/'root.db'));budget=SearchStore(root)
    budget.save(DataProviderInput(api_key='unit-test-provider',enabled=True,max_request_cost_usd=.01))
    registry=Profiles(root);info=registry.create(MockProfileInput(platform=platform,mode='public',source='@studio'))
    child=registry.workspace(info['id']);job=child.claim();calls=[]
    def handler(request):calls.append(request);return httpx.Response(200,json={'code':200,'data':{}})
    with pytest.raises(SearchError):run(lambda client:import_step(child,job,client),handler)
    with pytest.raises(SearchError,match='uncertain'):run(lambda client:import_step(child,job,client))
    assert len(calls)==1 and not registry.get(info['id'])['complete']


def test_budget_stops_pagination_and_keeps_partial_catalog(tmp_path):
    root=Store(str(tmp_path/'root.db'));budget=SearchStore(root)
    budget.save(DataProviderInput(api_key='unit-test-provider',enabled=True,max_request_cost_usd=.01,daily_requests=1))
    registry=Profiles(root);info=registry.create(MockProfileInput(platform='tiktok',mode='public',source='@studio'))
    child=registry.workspace(info['id'])
    run(lambda client:import_step(child,child.claim(),client),lambda request:httpx.Response(200,json={'code':200,'data':{'aweme_list':[item('tiktok','1')],'has_more':1,'max_cursor':100}}))
    with pytest.raises(SearchError,match='limit reached'):run(lambda client:import_step(child,child.claim(),client))
    state=registry.get(info['id'])
    assert state['status']=='partial' and not state['complete'] and len(media(child))==1
    assert budget.usage()['requests']==1


@pytest.mark.parametrize('platform',['instagram','tiktok'])
def test_one_page_trial_materializes_without_fetching_next_page(tmp_path,platform):
    root=Store(str(tmp_path/'root.db'));budget=SearchStore(root)
    budget.save(DataProviderInput(api_key='unit-test-provider',enabled=True,max_request_cost_usd=.002))
    registry=Profiles(root)
    info=registry.create(MockProfileInput(platform=platform,mode='public',source='@studio',page_limit=1))
    child=registry.workspace(info['id']);calls=[]
    def handler(request):
        calls.append(request)
        data={'items':[item(platform,'1')],'pagination_token':'next'} if platform=='instagram' else {'aweme_list':[item(platform,'1')],'has_more':1,'max_cursor':100}
        return httpx.Response(200,json={'code':200,'data':data})
    run(lambda client:import_step(child,child.claim(),client),handler)
    state=registry.get(info['id'])
    assert state['status']=='partial' and not state['complete'] and state['pages']==1
    assert state['search_id'] and budget.usage()['requests']==1 and len(calls)==1
    assert '1-page batch' in state['error']
    assert child.claim() is None
    from spur.catalog_tools import browse,BrowseInput
    assert browse(child,BrowseInput())['catalog_records']==1
    # Resume continues from the saved cursor rather than restarting the catalog.
    state=registry.resume(info['id'],page_limit=1)
    assert state['page_limit']==2 and state['cursor'] in ('next',100)


@pytest.mark.parametrize('limit',[0,201,True,'1',None])
def test_sync_batch_rejects_invalid_limits_before_queuing(tmp_path,limit):
    registry=Profiles(Store(str(tmp_path/'root.db')))
    with pytest.raises(SearchError,match='between 1 and 200'):
        registry.resume('not-a-profile',page_limit=limit)

@pytest.mark.parametrize('status,message,expected',[
 (402,'Insufficient balance','insufficient usable balance'),
 (403,'This endpoint does not support free credit','requires paid balance'),
 (401,'Invalid API key: DO-NOT-ECHO','rejected the API key'),
 (429,'Rate limited','rate limit reached'),
])
def test_provider_failure_is_actionable_without_exposing_response(status,message,expected):
    from spur.public_social_profiles import check_response
    with pytest.raises(SearchError,match=expected) as error:
        check_response(httpx.Response(status,text=message))
    assert 'DO-NOT-ECHO' not in str(error.value)
    assert f'HTTP {status}' in str(error.value)
