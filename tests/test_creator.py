import asyncio
import json
from dataclasses import replace
from datetime import date, timedelta

import httpx
import pytest
from fastapi.testclient import TestClient

from spur.config import Settings
from spur.creator import validate_deliverable,project_fields,result_schema
from spur.creator_catalog import CREATOR_AGENTS
from spur.store import Store
from spur.worker import execute


def fixture(kind):
    data={
        'ideas':{'concepts':[{'title':f'Paris concept {i}','audience_value':'Practical route','differentiation':'Specific neighborhood','opening_hook':'Skip the queue','production_plan':'One camera and two locations'} for i in range(3)]},
        'script':{'title':'Paris guide','opening_hook':'Plan a calmer trip','scenes':[{'duration_seconds':20,'dialogue':'Start with a neighborhood walk.','visuals':'Street establishing shot'} for _ in range(3)],'call_to_action':'Save the route'},
        'titles':{'options':[{'title':f'Paris route {i}','opening_hook':'See a quieter side','audience_promise':'Practical itinerary','rationale':'Clear audience benefit'} for i in range(4)],'recommended_pair':['Paris route 0','Paris route 1'],'test_plan':'Compare alternatives without inventing results'},
        'thumbnails':{'concepts':[{'concept':'City walk','composition':'Creator left, street right','subject':'Creator','overlay_text':'Paris Made Simple','contrast':'Dark green and cream','mobile_check':'Check at small size','image_prompt':'Editorial city walk composition'} for _ in range(2)]},
        'shorts':{'shorts':[{'title':f'Paris tip {i}','target_seconds':30,'hook':'Start here','spoken_script':'Pick one neighborhood and explore on foot.','shot_beats':['Street intro','Walking shot'],'caption':'A slower Paris walk','call_to_action':'Save this idea'} for i in range(2)],'source_basis':'Original premise, not extracted footage'},
        'seo':{'description':'A proposed Paris walking guide.','keywords':['Paris','travel','walking'],'hashtags':['#Paris'],'proposed_chapters':[{'proposed_time':'0:00','heading':'Introduction'},{'proposed_time':'0:30','heading':'Route'}],'publish_checklist':['Verify facts','Check captions','Review links']},
        'calendar':{'timezone':'Asia/Hong_Kong','entries':[{'publish_date':str(date.today()+timedelta(days=i+1)),'filming_date':str(date.today()),'title':f'Paris video {i}','format':'YouTube','production_tasks':['Film','Edit'],'estimated_hours':2,'dependencies':[]} for i in range(3)],'workload_notes':'Draft production plan'},
        'partnership':{'sponsor_fit':'Fictional travel brand','email_subject':'Proposed creator collaboration','pitch_email':'Hello [Brand contact], I create Paris guides. Audience: [verified audience metrics]. Fee: [rate].','proposed_deliverables':['One video integration','One Short'],'missing_information':['Audience metrics','Approved rate'],'disclosure_checklist':['Mark sponsored content','Check platform settings']}
    }
    return data[kind]


@pytest.mark.parametrize('profile',[p for p in CREATOR_AGENTS if p['kind']!='research'],ids=lambda p:p['id'])
def test_each_creator_agent_produces_its_own_deliverable(tmp_path,profile):
    store=Store(str(tmp_path/'creator.db'))
    store.set_runtime('creator_brief',{'audience':'First-time Paris visitors'})
    mid=store.create_mission(profile['example'],7,profile['id'])
    requests=[]
    def handler(request):
        body=json.loads(request.content);requests.append(body)
        assert request.url.path=='/api/chat'
        assert 'First-time Paris visitors' in body['messages'][1]['content']
        return httpx.Response(200,json={'message':{'role':'assistant','content':json.dumps({
            'title':'Creator test output','summary':'A concrete draft for review','deliverable':fixture(profile['kind']),
            'assumptions':['Original creative draft'],'verification_needed':['Verify location details'],'evidence_ids':[]})}})
    import spur.worker as worker
    old=worker.settings;worker.settings=replace(Settings(),model='test-model')
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:await execute(store,store.claim(),client)
    try:asyncio.run(run())
    finally:worker.settings=old
    mission=store.mission(mid)
    assert mission['status']=='completed'
    output=store.reports(mission['state']['report_id'])['content']
    assert output['artifact']['kind']==profile['kind']
    assert output['assumptions']
    assert store.knowledge_count()==1
    assert len(requests)==1
    assert store.reports()[0]['artifact_kind']==profile['kind']


def test_deliverable_constraints_reject_bad_outputs():
    with pytest.raises(ValueError,match='unknown source'):validate_deliverable('ideas',{},['fake'],{},date.today())
    d=fixture('titles');d['recommended_pair']=['Invented','Invented']
    with pytest.raises(ValueError,match='distinct'):validate_deliverable('titles',d,[],{},date.today())
    d=fixture('thumbnails');d['concepts'][0]['overlay_text']='Way Too Many Words In This Overlay'
    with pytest.raises(ValueError,match='four words'):validate_deliverable('thumbnails',d,[],{},date.today())
    d=fixture('calendar');d['entries'][0]['publish_date']='2000-01-01'
    with pytest.raises(ValueError,match='past'):validate_deliverable('calendar',d,[],{},date.today())


def test_extra_model_notes_do_not_discard_a_valid_deliverable():
    schema=result_schema('ideas')
    value={'title':'Ideas','summary':'Summary','deliverable':{**fixture('ideas'),'notes':'Optional annotation'},
           'assumptions':['Draft'],'verification_needed':[],'evidence_ids':[],'type':'json_object'}
    projected,omitted=project_fields(value,schema)
    assert set(omitted)=={'deliverable.notes','type'}
    assert len(schema.model_validate(projected).deliverable.concepts)==3


def test_creator_pacing_calendar_and_unverified_first_person_claims():
    d=fixture('shorts');d['shorts'][0]['spoken_script']='word ' * 110
    with pytest.raises(ValueError,match='too long'):validate_deliverable('shorts',d,[],{},date.today())
    d=fixture('calendar');d['entries'][0]['filming_date']='2000-01-01'
    with pytest.raises(ValueError,match='Filming dates'):validate_deliverable('calendar',d,[],{},date.today())
    d=fixture('seo');d['description']='I filmed this in Paris. Nothing here is sponsored.'
    with pytest.raises(ValueError,match='without supplied evidence'):validate_deliverable('seo',d,[],{},date.today())
    d['description']='[CONFIRM: I filmed this in Paris. Nothing here is sponsored.]'
    validate_deliverable('seo',d,[],{},date.today())


def test_creator_brief_and_output_handoff_api(tmp_path,monkeypatch):
    import spur.api as api
    monkeypatch.setattr(api,'settings',replace(Settings(),model='test-model',db_path=str(tmp_path/'api.db'),api_key='auth'))
    with TestClient(api.app) as c:
        h={'X-API-Key':'auth'}
        assert c.put('/creator-brief',json={'channel_name':'Paris Pocket'}).status_code==401
        assert c.put('/creator-brief',headers=h,json={'channel_name':'Paris Pocket','audience':'First-time visitors'}).status_code==200
        assert c.get('/creator-brief',headers=h).json()['audience']=='First-time visitors'
        store=api.app.state.store
        job_id=store.enqueue('report',{});job=store.claim()
        store.finish(job,{'report_id':'script-output'},report={'summary':'Script draft','topic':'Paris','sources':{},'artifact':{'kind':'script','data':fixture('script')}})
        response=c.post('/missions',headers=h,json={'topic':'Adapt this into Shorts','agent_id':'shorts-producer','input_report_id':'script-output'})
        assert response.status_code==202
        m=c.get('/missions/'+response.json()['mission_id'],headers=h).json()
        assert m['state']['input_report']['content']['artifact']['data']['title']=='Paris guide'
        assert c.post('/missions',headers=h,json={'topic':'Adapt','agent_id':'shorts-producer','input_report_id':'missing'}).status_code==404
