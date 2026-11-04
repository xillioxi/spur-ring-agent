import json,time
import httpx,pytest
from spur.public_instagram import parse_html,page,PublicPageBlocked,STATE_KEY
from spur.mock_profiles import Profiles,MockProfileInput,import_step,media,put_media
from spur.store import Store
from spur.video_search import SearchError
from tests.test_mock_profiles import run


def html():
    return '<script type="application/json">'+json.dumps({'user':{'username':'studio','edge_owner_to_timeline_media':{'edges':[{'node':{'id':'123','shortcode':'abc','is_video':True,'taken_at_timestamp':1700000000,'video_view_count':0,'video_url':'https://video.cdninstagram.com/video.mp4','display_url':'https://image.cdninstagram.com/photo.jpg','edge_media_preview_like':{'count':0},'edge_media_to_comment':{'count':2},'edge_media_to_caption':{'edges':[{'node':{'text':'A real caption'}}]}}}]}},'recommendation':{'owner':{'username':'unrelated'},'id':'456','shortcode':'other'}})+'</script>'


def test_parses_only_requested_creator_and_preserves_zeroes_and_partial_coverage():
    result=parse_html(html(),'studio');assert result['partial'] and result['cursor'] is None
    assert len(result['rows'])==1
    row=result['rows'][0]
    assert row['metrics']=={'views':0,'likes':0,'comments':2}
    assert row['media_url']=='https://video.cdninstagram.com/video.mp4' and row['description']=='A real caption'
    assert row['provider']=='instagram_public_page'


@pytest.mark.parametrize('body',['<html>Log in to see posts</html>','<a href="/challenge/">Challenge</a>','{"is_private": true}'])
def test_login_challenge_private_or_no_data_stops(body):
    with pytest.raises(PublicPageBlocked):parse_html(body,'studio')


def test_robots_disallow_stops_before_profile_request(tmp_path):
    root=Store(str(tmp_path/'root.db'));calls=[]
    def handler(request):calls.append(request);return httpx.Response(200,text='User-agent: *\nDisallow: /')
    with pytest.raises(PublicPageBlocked,match='robots'):run(lambda client:page(root,'studio',client),handler)
    assert len(calls)==1 and calls[0].url.path=='/robots.txt'


def test_no_cookies_no_auth_no_media_requests_and_persisted_global_cooldown(tmp_path):
    root=Store(str(tmp_path/'root.db'));calls=[]
    def handler(request):
        calls.append(request);assert not request.headers.get('cookie') and not request.headers.get('authorization')
        return httpx.Response(200,text='User-agent: *\nAllow: /') if request.url.path=='/robots.txt' else httpx.Response(200,text=html())
    result=run(lambda client:page(root,'studio',client),handler)
    assert len(result['rows'])==1 and len(calls)==2
    with pytest.raises(PublicPageBlocked,match='cooldown'):run(lambda client:page(Store(root.path),'anothercreator',client))
    assert len(calls)==2


@pytest.mark.parametrize('status',[302,403,429,503])
def test_restrictions_not_followed_or_retried(tmp_path,status):
    root=Store(str(tmp_path/'root.db'));calls=[]
    def handler(request):
        calls.append(request)
        return httpx.Response(200,text='User-agent: *\nAllow: /') if request.url.path=='/robots.txt' else httpx.Response(status,headers={'Location':'https://www.instagram.com/accounts/login/'})
    with pytest.raises(PublicPageBlocked,match='stopped at HTTP'):run(lambda client:page(root,'studio',client),handler)
    assert len(calls)==2


def test_explicit_opt_in_required(tmp_path):
    registry=Profiles(Store(str(tmp_path/'root.db')))
    with pytest.raises(SearchError,match='opt-in'):registry.create(MockProfileInput(platform='instagram',mode='public',provider='public_pages',source='@studio'))
    assert registry.list()==[]


def test_worker_stops_without_retry_and_preserves_previous_records(tmp_path):
    root=Store(str(tmp_path/'root.db'));registry=Profiles(root)
    info=registry.create(MockProfileInput(platform='instagram',mode='public',provider='public_pages',public_page_ack=True,source='@studio'))
    child=registry.workspace(info['id']);put_media(child,parse_html(html(),'studio')['rows'])
    job=child.claim()
    run(lambda client:import_step(child,job,client),lambda request:httpx.Response(429))
    assert registry.get(info['id'])['status']=='paused' and not registry.get(info['id'])['complete']
    assert len(media(child))==1 and child.job(job['id'])['status']=='succeeded'
    assert child.claim() is None


def test_worker_partial_snapshot_never_claims_complete_catalog(tmp_path):
    root=Store(str(tmp_path/'root.db'));registry=Profiles(root)
    info=registry.create(MockProfileInput(platform='instagram',mode='public',provider='public_pages',public_page_ack=True,source='@studio'))
    child=registry.workspace(info['id'])
    run(lambda client:import_step(child,child.claim(),client),lambda request:httpx.Response(200,text='User-agent: *\nAllow: /' if request.url.path=='/robots.txt' else html()))
    saved=registry.get(info['id']);assert saved['status']=='partial' and saved['imported']==1 and not saved['complete']
    assert child.claim() is None
