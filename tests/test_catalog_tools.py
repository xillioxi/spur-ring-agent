import asyncio,json,time,uuid
from dataclasses import replace
import httpx,pytest
from spur.store import Store
from spur.mock_profiles import Profiles,MockProfileInput,media,put_media
from spur.catalog_tools import browse,read,BrowseInput,VideoInput
from spur.config import Settings


def catalog(tmp_path):
    root=Store(str(tmp_path/'root.db'));profiles=Profiles(root);info=profiles.create(MockProfileInput());child=profiles.workspace(info['id'])
    rows=media(child);rows[0].update(title='Older campaign reference',description='Detailed old campaign description '+('x'*600),published=time.time()-10*365*86400,metrics={'views':5000,'likes':100,'comments':12})
    put_media(child,rows);return root,child,rows[0]


def test_browse_pages_entire_catalog_and_reads_old_record_without_network(tmp_path):
    _,child,old=catalog(tmp_path);seen=[];offset=0
    while True:
        page=browse(child,BrowseInput(offset=offset,limit=20));seen.extend(r['id'] for r in page['items'])
        assert page['catalog_records']==48
        if page['next_offset'] is None:break
        offset=page['next_offset']
    assert len(set(seen))==48 and old['id'] in seen
    result=browse(child,BrowseInput(query='old campaign'));assert result['matching_records']==1
    assert result['items'][0]['description_is_excerpt']
    detail=read(child,VideoInput(video_id=old['id']))['video']
    assert detail['metrics']['views']==5000 and detail['description']==old['description']


def test_catalog_access_stays_in_active_profile(tmp_path):
    root,child,old=catalog(tmp_path);other=Profiles(root).workspace(Profiles(root).create(MockProfileInput())['id'])
    assert browse(other,BrowseInput(query='Older campaign reference'))['matching_records']==0
    with pytest.raises(ValueError):read(child,VideoInput(video_id='not-in-this-profile'))
    with pytest.raises(ValueError):browse(root,BrowseInput())


def test_chat_can_find_and_open_collected_video_via_harness(tmp_path):
    from spur.chat import reply
    _,child,old=catalog(tmp_path);child.enqueue_chat('youtube-research','Find the older campaign video and read its saved metrics and description.',uuid.uuid4().hex);job=child.claim();calls=[]
    def handler(request):
        body=json.loads(request.content);calls.append(body)
        if len(calls)==1:
            names={t['function']['name'] for t in body['tools']}
            assert {'browse_collected_videos','read_collected_video'}<=names
            function={'name':'browse_collected_videos','arguments':{'query':'older campaign','offset':0,'limit':20}}
        elif len(calls)==2:
            result=json.loads(body['messages'][-1]['content']);assert result['matching_records']==1
            function={'name':'read_collected_video','arguments':{'video_id':result['items'][0]['id']}}
        else:
            video=json.loads(body['messages'][-1]['content'])['video'];assert video['description']==old['description'] and video['metrics']['views']==5000
            return httpx.Response(200,json={'message':{'role':'assistant','content':'I found the saved older campaign video: 5,000 views, 100 likes and 12 comments. Its stored description is available too.'}})
        return httpx.Response(200,json={'message':{'role':'assistant','content':'','tool_calls':[{'function':function}]}})
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:await reply(child,replace(Settings(),model='test'),job,client)
    asyncio.run(run());assert child.job(job['id'])['status']=='succeeded' and len(calls)==3
