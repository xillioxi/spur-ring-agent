import time
from spur.store import Store
from spur.mock_profiles import Profiles,MockProfileInput,media,put_media
from spur.config import Settings
from spur.proactive_insights import maybe_schedule,feed,configure


def ready(tmp_path):
    root=Store(str(tmp_path/'root.db'));root.set_runtime('connection',{'provider':'deepseek','model':'deepseek-flash'})
    registry=Profiles(root);info=registry.create(MockProfileInput());info['mode']='public';registry.update(info)
    child=registry.workspace(info['id']);rows=media(child)
    for i,r in enumerate(rows):
        if i<10:r['detail_status']='collected'
    put_media(child,rows);return child,rows


def test_automatic_briefing_is_durable_bounded_and_no_user_prompt_needed(tmp_path):
    child,rows=ready(tmp_path)
    identifier=maybe_schedule(child,Settings(),True);assert identifier
    assert maybe_schedule(child,Settings(),True) is None
    state=feed(child);assert state['entries'][0]['milestone']=='initial' and state['entries'][0]['status']=='active'
    # Crossing a coverage milestone cannot overlap an already active briefing.
    for r in rows[:25]:r['detail_status']='collected'
    put_media(child,rows);assert maybe_schedule(child,Settings(),True) is None
    with child.connect() as db:db.execute("UPDATE missions SET status='completed' WHERE id=?",(identifier,))
    second=maybe_schedule(child,Settings(),True);assert second and second!=identifier
    configure(child,False)
    with child.connect() as db:db.execute("UPDATE missions SET status='completed'")
    for r in rows:r['detail_status']='collected'
    put_media(child,rows);assert maybe_schedule(child,Settings(),True) is None
    configure(child,True);third=maybe_schedule(child,Settings(),True);assert third
    assert len(feed(child)['entries'])==3
    with child.connect() as db:db.execute("UPDATE missions SET status='completed'")
    assert maybe_schedule(child,Settings(),True) is None


def test_no_model_or_insufficient_measurements_does_not_spend_model_calls(tmp_path):
    child,rows=ready(tmp_path);child.profile_parent.set_runtime('connection',{'provider':'ollama','model':''})
    assert maybe_schedule(child,Settings(),True) is None
    assert 'model' in feed(child)['waiting']
    child.profile_parent.set_runtime('connection',{'provider':'deepseek','model':'test'})
    for r in rows:r['published']=None
    put_media(child,rows);assert maybe_schedule(child,Settings(),True) is None
    assert 'enough' in feed(child)['waiting'] and child.missions()==[]


def test_automatic_briefing_finishes_in_the_feed_without_chat(tmp_path):
    import asyncio,json,httpx
    from spur.missions import step
    child,rows=ready(tmp_path);identifier=maybe_schedule(child,Settings(),True);final_round=[0]
    def handler(request):
        body=json.loads(request.content)
        if 'format' not in body:return httpx.Response(200,json={'message':{'role':'assistant','content':'Evidence is ready.'}})
        final_round[0]+=1
        return httpx.Response(200,json={'message':{'role':'assistant','content':json.dumps({'summary':'A recurring budget theme is worth testing with a new variation.','developments':[{'title':'A useful theme to test','observation':'Several saved titles use budget framing.','implication':'Test a fresh budget challenge and measure comparable results.','evidence_ids':['not-retrieved' if final_round[0]==1 else rows[0]['id']]}],'potential_trends':[],'limitations':['Title metadata supports a hypothesis, not proof of causation.']})}})
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            await step(child,Settings(model='test'),child.claim(),client)
            await step(child,Settings(model='test'),child.claim(),client)
    asyncio.run(run());entry=feed(child)['entries'][0]
    assert entry['status']=='completed' and entry['report_id']
    assert entry['summary'].startswith('A recurring') and entry['findings'][0]['implication']
    assert child.chat('youtube-research')==[] and final_round[0]==2
