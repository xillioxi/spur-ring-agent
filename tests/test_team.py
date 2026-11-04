import asyncio
import json
from dataclasses import replace

import httpx
from fastapi.testclient import TestClient

from spur.config import Settings
from spur.store import Store
from spur.team import TeamPlan, team_step


def test_marketing_lead_upgrade_keeps_existing_conversation(tmp_path):
    path=str(tmp_path/'upgrade.db');db=Store(path)
    db.enqueue_chat('coordinator','Our campaign goal', 'original-message')
    db.finish_chat(db.claim(),'Let’s plan it.',{})
    with db.connect() as conn:
        conn.execute("UPDATE agents SET name='Team Coordinator',instructions='Coordinate bounded research assignments using the available specialists.' WHERE id='coordinator'")
    upgraded=Store(path);lead=upgraded.agents()[0]
    assert lead['id']=='coordinator' and lead['name']=='Marketing Lead' and lead['is_orchestrator']
    assert 'marketing lead' in lead['instructions'] and lead['example']
    assert len(upgraded.agents())==12 and len(upgraded.chat('coordinator'))==2


def test_marketing_lead_can_coordinate_every_specialist(tmp_path,monkeypatch):
    import spur.team as team
    from spur.creator_catalog import CREATOR_AGENTS
    db=Store(str(tmp_path/'whole-team.db'));db.set_runtime('creator_brief',{'audience':'First-time Paris visitors'})
    specialists=[a for a in db.agents() if a['id']!='coordinator']
    parent=db.create_mission('Use the whole team for our Paris campaign',7,'coordinator')
    async def plan(client,settings,instruction,data,schema):
        assert data['creator_brief']['audience']=='First-time Paris visitors'
        assert 'marketing lead' in data['lead_instructions']
        assert {a['id'] for a in data['specialists']}=={a['id'] for a in specialists}
        return TeamPlan(objective='A full Paris campaign',strategy='Teach first-time visitors a practical neighborhood route.',
                        success_criteria=['Every required draft is ready for review'],
                        assignments=[{'agent_id':a['id'],'instruction':'Produce your specialist contribution'} for a in specialists])
    async def report(store,config,payload,client,progress=None):
        assert len(payload['mission_context']['specialist_findings'])==len(specialists)
        assert payload['mission_context']['team_plan']['strategy'].startswith('Teach')
        return {'summary':'Campaign plan and specialist findings','topic':'Paris campaign','sources':{},'limitations':['Drafts for review']}
    monkeypatch.setattr(team,'structured',plan);monkeypatch.setattr(team,'generate_report',report)
    executed=[]
    async def run():
        async with httpx.AsyncClient() as client:
            for _ in range(50):
                with db.connect() as conn:conn.execute("UPDATE jobs SET available=0 WHERE status='queued'")
                job=db.claim();assert job
                if job['payload']['mission_id']==parent:await team_step(db,replace(Settings(),model='test-model'),job,client)
                else:
                    child=db.mission(job['payload']['mission_id']);state=child['state'];executed.append(state['agent_id'])
                    assert 'Marketing strategy: Teach' in child['prompt']
                    if len(executed)>1:assert 'Previous specialist results' in child['prompt']
                    state['phase']='done'
                    db.checkpoint_mission(job,state,'Contribution ready',terminal='completed',report={
                        'topic':'Contribution','summary':'Concrete findings','sources':{},'limitations':['Fixture']})
                if db.mission(parent)['status']=='completed':break
    asyncio.run(run())
    mission=db.mission(parent)
    assert mission['status']=='completed'
    assert executed==[a['id'] for a in specialists]
    assert {p['id'] for p in CREATOR_AGENTS}<=set(executed)
    assert len(db.reports(mission['state']['report_id'])['content']['team_outputs'])==len(specialists)


def test_agent_registry_and_mission_snapshot(tmp_path,monkeypatch):
    import spur.api as api
    monkeypatch.setattr(api,'settings',replace(Settings(),db_path=str(tmp_path/'agents.db'),api_key='auth',model='test-model'))
    with TestClient(api.app) as c:
        h={'X-API-Key':'auth'}
        assert c.get('/agents').status_code==401
        ids={a['id'] for a in c.get('/agents',headers=h).json()}
        assert {'coordinator','youtube-research','channel-scout','research-analyst'}<=ids
        response=c.post('/agents',headers=h,json={'name':'Travel Analyst','description':'Travel research','instructions':'Focus on Paris travel usefulness'})
        assert response.status_code==201
        agent_id=response.json()['id']
        mission=c.post('/missions',headers=h,json={'topic':'Compare travel channels','agent_id':agent_id}).json()
        state=c.get('/missions/'+mission['mission_id'],headers=h).json()['state']
        assert state['agent_id']==agent_id
        assert state['agent_instructions']=='Focus on Paris travel usefulness'
        assert c.post('/missions',headers=h,json={'topic':'Research','agent_id':'missing'}).status_code==404
        assert len(Store(str(tmp_path/'agents.db')).agents())==13


def test_team_handoffs_are_idempotent_and_controls_propagate(tmp_path):
    db=Store(str(tmp_path/'handoff.db'))
    parent=db.create_mission('Research Paris travel',7,'coordinator')
    child=db.delegate_mission(parent,0,'channel-scout','Find channels',7)
    assert db.delegate_mission(parent,0,'channel-scout','Retry',7)==child
    assert len(db.missions())==2
    assert db.mission(child)['state']['parent_mission_id']==parent
    db.control_mission(parent,'pause')
    assert db.mission(child)['status']=='paused'
    db.control_mission(parent,'resume')
    assert db.mission(child)['status']=='active'
    db.control_mission(parent,'cancel')
    assert db.mission(child)['status']=='cancelled'
    assert db.delegate_mission(parent,1,'research-analyst','Analyze',7) is None


def test_coordinator_delegates_then_synthesizes(tmp_path,monkeypatch):
    import spur.team as team
    db=Store(str(tmp_path/'team.db'));settings=replace(Settings(),model='test-model')
    parent=db.create_mission('Find and compare Paris channels',7,'coordinator')
    calls=[]
    async def plan(*args):
        return TeamPlan(objective='Scout then analyze',assignments=[
            {'agent_id':'channel-scout','instruction':'Find 2 Paris channels'},
            {'agent_id':'research-analyst','instruction':'Compare the existing collected channels'}])
    async def report(store,config,payload,client,progress=None):
        calls.append(payload)
        return {'summary':'Combined evidence','topic':payload['topic'],'sources':{},'limitations':['Metadata only']}
    monkeypatch.setattr(team,'structured',plan);monkeypatch.setattr(team,'generate_report',report)

    async def run():
        async with httpx.AsyncClient() as client:
            for _ in range(12):
                # Make parent polling jobs immediately due for this simulation.
                with db.connect() as conn:conn.execute("UPDATE jobs SET available=0 WHERE status='queued'")
                job=db.claim()
                if not job:break
                if job['payload']['mission_id']==parent:
                    await team_step(db,settings,job,client)
                else:
                    mission=db.mission(job['payload']['mission_id']);state=mission['state'];state['phase']='done'
                    if state['agent_id']=='research-analyst':
                        assert 'Previous specialist results' in mission['prompt']
                    db.checkpoint_mission(job,state,'Specialist finished',terminal='completed',report={
                        'summary':'Specialist findings','topic':mission['prompt'],'sources':{},'limitations':['Sample']})
                if db.mission(parent)['status']=='completed':break
    asyncio.run(run())
    mission=db.mission(parent)
    assert mission['status']=='completed'
    assert len(mission['state']['children'])==2
    assert len(calls[0]['mission_context']['specialist_findings'])==2
    assert db.reports(mission['state']['report_id'])['content']['team_assignments']==mission['state']['children']


def test_creative_team_returns_a_package_without_requiring_video_evidence(tmp_path):
    db=Store(str(tmp_path/'package.db'))
    parent=db.create_mission('Create a script and titles',7,'coordinator')
    parent_job=db.claim()
    for index,agent_id in enumerate(['script-writer','title-lab']):
        child=db.delegate_mission(parent,index,agent_id,'Create a draft',7)
        job=db.claim();state=db.mission(child)['state'];state['phase']='done'
        db.checkpoint_mission(job,state,'Draft ready',terminal='completed',report={
            'title':'Specialist draft','summary':'Draft summary','topic':'Create a draft','sources':{},
            'artifact':{'kind':'script' if index==0 else 'titles','data':{'draft':'Concrete content'}},
            'assumptions':['Proposed content'],'verification_needed':['Confirm locations'],'limitations':['Draft only']})
    state=db.mission(parent)['state'];state['phase']='team_report';state['team_plan']={'objective':'Create a package','assignments':[]}
    with db.connect() as conn:conn.execute('UPDATE missions SET state=? WHERE id=?',(json.dumps(state),parent))
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda req: (_ for _ in ()).throw(AssertionError('No inference needed for package assembly')))) as client:
            await team_step(db,replace(Settings(),model='test-model'),parent_job,client)
    asyncio.run(run())
    mission=db.mission(parent)
    output=db.reports(mission['state']['report_id'])['content']
    assert mission['status']=='completed'
    assert output['artifact']['kind']=='creator_package'
    assert len(output['artifact']['data']['deliverables'])==2
    assert len(output['team_outputs'])==2
    assert 'No video evidence' not in output['summary']
