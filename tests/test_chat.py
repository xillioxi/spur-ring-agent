import asyncio
import json
import uuid
from dataclasses import replace

import httpx
import pytest
from fastapi.testclient import TestClient

from spur.chat import reply
from spur.config import Settings
from spur.providers import ModelSession
from spur.store import Store


def send(store,agent='title-lab',content='Hello'):
    return store.enqueue_chat(agent,content,uuid.uuid4().hex)


def run_reply(store,job,handler):
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            await reply(store,replace(Settings(),model='test-model'),job,client)
    asyncio.run(run())


def test_chat_is_durable_separate_and_idempotent(tmp_path):
    path=str(tmp_path/'chat.db');store=Store(path)
    request=uuid.uuid4().hex
    jid=store.enqueue_chat('title-lab','My Paris channel',request)
    assert store.enqueue_chat('title-lab','My Paris channel',request)==jid
    with pytest.raises(ValueError,match='already used'):store.enqueue_chat('script-writer','My Paris channel',request)
    with pytest.raises(ValueError,match='still replying'):send(store)
    send(store,'script-writer','A different conversation')
    job=store.claim();assert job['id']==jid
    store.finish_chat(job,'Let’s discuss titles.',{'model':'test-model','mission_ids':[]})
    restored=Store(path)
    assert [m['role'] for m in restored.chat('title-lab')]==['user','assistant']
    assert len(restored.chat('script-writer'))==1
    assert restored.chat('channel-scout')==[]
    assert restored.job(jid)['status']=='succeeded'


def test_chat_lease_retry_and_old_context_bound(tmp_path):
    store=Store(str(tmp_path/'retry.db'));old_id=send(store,content='Original context')
    job=store.claim()
    with pytest.raises(RuntimeError,match='ownership'):store.finish_chat({**job,'token':'wrong'},'Wrong',{})
    with store.connect() as db:db.execute("UPDATE jobs SET status='failed' WHERE id=?",(old_id,))
    for i in range(24):
        send(store,content='Future message '+str(i));next_job=store.claim();store.finish_chat(next_job,'Future reply',{})
    store.retry_chat('title-lab',old_id)
    retried=store.claim();assert retried['id']==old_id
    def handler(request):
        messages=json.loads(request.content)['messages']
        assert messages[-1]['content']=='Original context'
        assert 'Future message' not in json.dumps(messages)
        return httpx.Response(200,json={'message':{'role':'assistant','content':'Recovered'}})
    run_reply(store,retried,handler)
    assert store.chat('title-lab')[-1]['content']=='Recovered'
    with pytest.raises(ValueError,match='Only a failed'):store.retry_chat('title-lab',old_id)


def test_followup_includes_own_assistant_and_shared_brief(tmp_path):
    store=Store(str(tmp_path/'context.db'));store.set_runtime('creator_brief',{'audience':'Paris students'})
    send(store,'script-writer','Secret script discussion');other=store.claim();store.finish_chat(other,'Unrelated script',{})
    send(store,content='Suggest a title angle')
    run_reply(store,store.claim(),lambda r:httpx.Response(200,json={'message':{'role':'assistant','content':'Try a quiet Paris walking route.'}}))
    send(store,content='Make that more specific')
    def handler(request):
        body=json.loads(request.content);messages=body['messages']
        assert [m['role'] for m in messages]==['system','user','assistant','user']
        assert messages[2]['content']=='Try a quiet Paris walking route.'
        assert 'Paris students' in messages[0]['content']
        assert 'Secret script' not in json.dumps(messages)
        return httpx.Response(200,json={'message':{'role':'assistant','content':'Walk the Latin Quarter before 9 AM.'}})
    run_reply(store,store.claim(),handler)
    assert len(store.chat('title-lab'))==4
    assert store.missions()==[]


def test_chat_handoff_is_linked_and_not_duplicated_on_retry(tmp_path):
    store=Store(str(tmp_path/'handoff.db'));send(store,content='Create and save four Paris titles')
    job=store.claim();rounds=[]
    def handler(request):
        body=json.loads(request.content);rounds.append(body)
        if len(rounds)%2:
            return httpx.Response(200,json={'message':{'role':'assistant','content':'','tool_calls':[
                {'id':'task-call','type':'function','function':{'name':'start_background_task','arguments':json.dumps({'instruction':'Create and save four Paris titles'})}}]}})
        result=json.loads(body['messages'][-1]['content']);assert result['mission_id']
        return httpx.Response(200,json={'message':{'role':'assistant','content':'Your title task is queued.'}})
    run_reply(store,job,handler)
    assert len(store.missions())==1
    assert store.missions()[0]['state']['agent_id']=='title-lab'
    assert 'Conversation context' in store.missions()[0]['prompt']
    assert store.chat('title-lab')[-1]['metadata']['mission_ids']==[store.missions()[0]['id']]
    # Recover from a worker crash after the task was committed but before its reply.
    with store.connect() as db:
        db.execute("DELETE FROM chat_messages WHERE role='assistant'")
        db.execute("UPDATE jobs SET status='failed' WHERE id=?",(job['id'],))
    store.retry_chat('title-lab',job['id']);run_reply(store,store.claim(),handler)
    assert len(store.missions())==1
    assert len(store.chat('title-lab'))==2


def test_chat_is_prioritized_over_queued_background_steps(tmp_path):
    store=Store(str(tmp_path/'priority.db'));store.create_mission('Create titles',7,'title-lab')
    jid=send(store);assert store.claim()['id']==jid


def test_chat_can_call_real_search_interface_and_read_provider_results(tmp_path,monkeypatch):
    store=Store(str(tmp_path/'search-chat.db'));send(store,content='Find Paris budget travel videos on YouTube this week')
    job=store.claim();called=[]
    async def search(db,value,client,key):
        assert db is store and value.platform=='youtube' and value.days==7 and key=='chat:'+job['id']
        called.append(value.query)
        return {'items':[{'id':'abcdefghijk','title':'Paris on a budget','url':'https://www.youtube.com/watch?v=abcdefghijk'}],'provider':'youtube_official','warnings':['One page only']}
    monkeypatch.setattr('spur.chat.search_once',search)
    rounds=[]
    def handler(request):
        body=json.loads(request.content);rounds.append(body)
        if len(rounds)==1:
            assert 'search_videos' in [t['function']['name'] for t in body['tools']]
            return httpx.Response(200,json={'message':{'role':'assistant','content':'','tool_calls':[{'id':'search-1','type':'function','function':{'name':'search_videos','arguments':json.dumps({'platform':'youtube','query':'Paris budget travel','days':7})}}]}})
        tool=json.loads(body['messages'][-1]['content']);assert tool['provider']=='youtube_official' and tool['items'][0]['id']=='abcdefghijk'
        return httpx.Response(200,json={'message':{'role':'assistant','content':'Here is a sourced Paris budget-travel video.'}})
    run_reply(store,job,handler)
    assert called==['Paris budget travel'] and store.missions()==[]
    assert store.chat('title-lab')[-1]['content']=='Here is a sourced Paris budget-travel video.'


def test_chat_can_generate_a_report_from_saved_metadata(tmp_path):
    from spur.video_search import SearchStore
    import time
    store=Store(str(tmp_path/'metadata-chat.db'));now=time.time()
    sid=SearchStore(store).save_run({'query':'Paris','platform':'tiktok','provider':'tikhub','observed_at':now,'window_days':7,'warnings':[], 'items':[{'id':'123','title':'A Paris video','creator':'Creator','platform':'tiktok','provider':'tikhub','observed_at':now,'published':now-86400,'format':'video','metrics':{'views':100,'likes':10,'comments':0}}]})
    send(store,content='Generate a metadata report from saved search '+sid);rounds=[]
    def handler(request):
        body=json.loads(request.content);rounds.append(body)
        if len(rounds)==1:return httpx.Response(200,json={'message':{'role':'assistant','content':'','tool_calls':[{'id':'report-call','type':'function','function':{'name':'generate_metadata_report','arguments':json.dumps({'search_id':sid})}}]}})
        result=json.loads(body['messages'][-1]['content']);assert result['analysis']['descriptive']['views']['median']==100
        return httpx.Response(200,json={'message':{'role':'assistant','content':'Your sourced metadata report is saved.'}})
    run_reply(store,store.claim(),handler)
    assert len(store.reports())==1 and store.chat('title-lab')[-1]['content']=='Your sourced metadata report is saved.'


def test_chat_api_auth_validation_and_pagination(tmp_path,monkeypatch):
    import spur.api as api
    monkeypatch.setattr(api,'settings',replace(Settings(),db_path=str(tmp_path/'api.db'),model='test-model',api_key='auth'))
    with TestClient(api.app) as client:
        url='/agents/title-lab/chat';headers={'X-API-Key':'auth'}
        assert client.get(url).status_code==401
        assert client.get(url,headers=headers).json()==[]
        assert client.get('/agents/missing/chat',headers=headers).status_code==404
        body={'content':'Hello','request_id':'request-one'}
        result=client.post(url,headers=headers,json=body);assert result.status_code==202
        assert client.post(url,headers=headers,json=body).json()==result.json()
        assert client.post(url,headers=headers,json={**body,'request_id':'request-two'}).status_code==409
        assert client.post(url,headers=headers,json={**body,'content':'  '}).status_code==422
        assert client.post(url,headers=headers,json={**body,'content':'x'*10001}).status_code==422
        store=api.app.state.store;job=store.claim();store.finish_chat(job,'Hello creator!',{'mission_ids':[]})
        messages=client.get(url,headers=headers).json();assert len(messages)==2
        assert client.get(url+'?before='+str(messages[-1]['id']),headers=headers).json()==messages[:1]
        assert client.get(url+'?before=0',headers=headers).status_code==422
        assert client.post('/agents/script-writer/chat/'+job['id']+'/retry',headers=headers).status_code==409


def test_openai_preserves_saved_assistant_chat_history(tmp_path,monkeypatch):
    import spur.providers as providers
    monkeypatch.setattr(providers,'load_key',lambda *args:'test-key')
    bodies=[]
    def handler(request):
        body=json.loads(request.content);bodies.append(body)
        assert body['input'][2]=={'role':'assistant','content':'Quiet Paris walk'}
        return httpx.Response(200,json={'output':[{'type':'message','role':'assistant','content':[{'type':'output_text','text':'Latin Quarter'}]}]})
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            session=ModelSession(replace(Settings(),provider='openai',model='test-model'),client)
            messages=[{'role':'system','content':'Help creators'},{'role':'user','content':'Suggest an angle'},
                      {'role':'assistant','content':'Quiet Paris walk'},{'role':'user','content':'Which neighborhood?'}]
            answer=await session.chat(messages);assert answer['content']=='Latin Quarter'
            messages+=[answer,{'role':'user','content':'Shorten it'}]
            await session.chat(messages)
            assert sum(x.get('role')=='assistant' and x.get('content')=='Quiet Paris walk' for x in bodies[1]['input'])==1
    asyncio.run(run())


def test_marketing_lead_chat_knows_registered_team(tmp_path):
    store=Store(str(tmp_path/'lead-chat.db'))
    custom=store.add_agent('Travel Analyst','Research travel positioning','Analyze existing travel evidence')
    send(store,'coordinator','Who can you delegate to?')
    def handler(request):
        system=json.loads(request.content)['messages'][0]['content']
        assert 'Marketing Lead' in system and 'available_specialists' in system
        assert custom['id'] in system and 'Title & Hook Lab' in system and 'Channel Scout' in system
        return httpx.Response(200,json={'message':{'role':'assistant','content':'I can coordinate your registered team.'}})
    run_reply(store,store.claim(),handler)
    assert store.chat('coordinator')[-1]['role']=='assistant'
