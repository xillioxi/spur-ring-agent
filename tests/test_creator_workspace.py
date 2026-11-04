import time
import pytest
from spur.store import Store
from spur.mock_profiles import Profiles,MockProfileInput,media,context,materialize,put_media,local_search
from spur.profile_analytics import analyze
from spur.catalog_tools import browse,BrowseInput,read,VideoInput
from spur.video_search import SearchInput,SearchError,SearchStore
from spur.metadata_reports import generate,MetadataReportInput
from tests.test_mock_profiles import cipher,client


def test_creator_owns_three_channels_with_shared_agent_catalog_and_reports(tmp_path):
    parent=Store(str(tmp_path/'root.db'));registry=Profiles(parent)
    yt=registry.create(MockProfileInput(name='Creator'))
    creator=registry.workspace(yt['id']);creator.add_knowledge('Brand voice','Keep our creator brief')
    ig=registry.create(MockProfileInput(platform='instagram',workspace_id=yt['id']))
    tt=registry.create(MockProfileInput(platform='tiktok',workspace_id=yt['id']))
    assert len(registry.creators())==1 and len(context(creator)['channels'])==3
    assert len(media(creator))==144 and len({r['id'] for r in media(creator)})==144
    assert len(media(registry.workspace(ig['id'])))==48  # Connector storage remains private to that channel.
    assert browse(creator,BrowseInput())['catalog_records']==144
    linked=next(r for r in media(creator) if r['platform']=='tiktok')
    assert read(creator,VideoInput(video_id=linked['id']))['video']['platform']=='tiktok'
    for platform in ('youtube','instagram','tiktok'):
        value=analyze(creator,platform=platform)
        assert value['total']==48 and all(r['platform']==platform for r in value['rows'])
    report=generate(creator,MetadataReportInput(search_id=registry.get(yt['id'])['search_id']))
    assert len(report['content']['artifact']['data']['evidence'])==144
    assert creator.knowledge() and len(creator.reports())==1
    assert parent.reports()==[]
    assert len(local_search(creator,SearchInput(platform='instagram',query='all posts',days=90))['items'])==20


def test_channels_do_not_share_peer_baselines_or_escape_creator(tmp_path):
    parent=Store(str(tmp_path/'root.db'));registry=Profiles(parent)
    first=registry.create(MockProfileInput());ig=registry.create(MockProfileInput(platform='instagram',workspace_id=first['id']))
    other=registry.create(MockProfileInput())
    child=registry.workspace(ig['id']);rows=media(child)
    for row in rows:row['metrics']['views']*=1000
    put_media(child,rows)
    base=analyze(registry.workspace(first['id']),platform='youtube')['rows']
    assert all(r['peer_count']<=48 for r in base)
    assert len(media(registry.workspace(other['id'])))==48
    with pytest.raises(SearchError):read(registry.workspace(other['id']),VideoInput(video_id=ig['id']+':'+rows[0]['id']))


def test_attach_real_channel_without_key_records_setup_state_and_preserves_existing_catalog(tmp_path):
    registry=Profiles(Store(str(tmp_path/'root.db')))
    first=registry.create(MockProfileInput(mode='public',source='@creator'))
    instagram=registry.create(MockProfileInput(platform='instagram',mode='public',source='@creator',workspace_id=first['id']))
    assert instagram['status']=='needs_setup' and instagram['workspace_id']==first['id']
    assert len(registry.creators())==1 and not context(registry.workspace(first['id']))['complete']
    with registry.workspace(instagram['id']).connect() as db:assert db.execute('SELECT COUNT(*) FROM jobs').fetchone()[0]==0
    with pytest.raises(SearchError,match='already attached'):
        registry.create(MockProfileInput(platform='instagram',mode='public',source='@creator',workspace_id=first['id']))


def test_channel_activation_opens_shared_creator_and_retains_chat(client):
    headers=client.csrf
    root=client.post('/mock-profiles',headers=headers,json={}).json()
    channel=client.post('/mock-profiles',headers=headers,json={'platform':'instagram','workspace_id':root['id']}).json()
    client.post('/mock-profiles/activate',headers=headers,json={'profile_id':channel['id']})
    assert client.get('/auth/me').json()['mock_profile']['id']==root['id']
    assert client.get('/mock-profile/media').json()['total']==96
    assert len(client.get('/mock-profiles').json()['profiles'])==1
    assert client.get('/mock-profile/analytics?platform=instagram').json()['total']==48
    assert len(client.get('/social/connections').json()['connections'])==2


def test_foreign_workspace_rejected_before_creating_channel(client):
    response=client.post('/mock-profiles',headers=client.csrf,json={'platform':'instagram','workspace_id':'a'*32})
    assert response.status_code==422 and client.get('/mock-profiles').json()['profiles']==[]


def test_public_channel_import_refreshes_shared_report_without_pruning_youtube(tmp_path):
    import httpx
    from tests.test_mock_profiles import run
    from spur.mock_profiles import import_step
    from spur.video_search import DataProviderInput
    parent=Store(str(tmp_path/'root.db'));registry=Profiles(parent)
    SearchStore(parent).save(DataProviderInput(api_key='unit-test-provider',enabled=True,max_request_cost_usd=.01))
    owner=registry.create(MockProfileInput(mode='public',source='@creator'));creator=registry.workspace(owner['id'])
    now=time.time()
    put_media(creator,[{'id':'123','title':'YouTube evidence','description':'','creator':'creator','url':'','platform':'youtube','provider':'youtube_public','format':'video','duration_seconds':45,'published':now-86400,'observed_at':now,'metrics':{'views':100},'import_generation':owner['generation']}])
    owner.update(complete=True,imported=1,status='ready');registry.update(owner);materialize(creator,owner);registry.update(owner)
    attached=registry.create(MockProfileInput(platform='tiktok',mode='public',source='@creator',workspace_id=owner['id']))
    channel=registry.workspace(attached['id'])
    def response(request):return httpx.Response(200,json={'code':200,'data':{'aweme_list':[{'aweme_id':'123','desc':'TikTok evidence','author':{'unique_id':'creator'},'statistics':{'play_count':400},'create_time':now-86400,'video':{'duration':45000}}],'has_more':0}})
    run(lambda client:import_step(channel,channel.claim(),client),response)
    assert len(media(creator))==2 and len(media(creator,own=True))==1
    saved=SearchStore(creator).run(registry.get(owner['id'])['search_id'])
    assert len(saved['items'])==2 and saved['platform']=='multi'
    assert len(generate(creator,MetadataReportInput(search_id=saved['search_id']))['content']['artifact']['data']['evidence'])==2
    registry.resume(attached['id']);run(lambda client:import_step(channel,channel.claim(),client),response)
    assert len(media(creator))==2 and media(creator,own=True)[0]['title']=='YouTube evidence'
