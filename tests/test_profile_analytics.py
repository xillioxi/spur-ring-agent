import asyncio,json,time,uuid
from dataclasses import replace
import httpx,pytest
from spur.store import Store
from spur.mock_profiles import Profiles,MockProfileInput,put_media
from spur.profile_analytics import analyze,compare,model_context
from spur.metadata_reports import derived_allowed
from spur.config import Settings


def catalog(tmp_path):
    root=Store(str(tmp_path/'root.db'));registry=Profiles(root);info=registry.create(MockProfileInput())
    info['mode']='public';registry.update(info);child=registry.workspace(info['id'])
    with child.connect() as db:db.execute('DELETE FROM profile_media')
    rows=[]
    for i in range(12):
        rows.append({'id':'video'+str(i).zfill(6),'platform':'youtube','provider':'youtube_public','title':'Video '+str(i),'creator':'Creator','url':'https://www.youtube.com/watch?v=video'+str(i).zfill(6),'published':time.time()-10*86400 if i!=11 else None,'observed_at':time.time(),'duration_seconds':240,'format':'video' if i<6 else 'short','metrics':{'views':10000 if i in (0,6) else 100,'likes':10 if i<6 else None,'comments':0},'detail_status':'collected'})
    put_media(child,rows);return child,rows


def test_full_catalog_scores_use_comparable_peers_and_coverage(tmp_path):
    child,rows=catalog(tmp_path);r=analyze(child,sort='performance',limit=2)
    assert r['total']==12 and r['coverage']['metrics_available']['views']==12
    assert r['coverage']['metrics_available']['likes']==6
    assert r['coverage']['publication_dates_available']==11
    assert r['rows'][0]['views_vs_peer_median']==100 and r['rows'][0]['peer_count']==6
    assert analyze(child,days=28)['total']==11
    shorts=analyze(child,format='short',sort='performance');assert shorts['total']==6
    unknown=next(row for row in shorts['rows'] if row['published'] is None)
    assert unknown['views_vs_peer_median'] is None
    result=compare(child,[rows[0]['id'],rows[1]['id']]);assert result['comparison_count']==2
    assert result['evidence_preview'][0]['views_vs_peer_median']==100
    with pytest.raises(ValueError):compare(child,['otherprofile'])
    assert model_context(child,limit=2)['preview_is_truncated']
    assert not derived_allowed(child,{'platform':'youtube','provider':'youtube_public','items':[{'provider':'youtube_official'}]})


def test_data_status_distinguishes_public_analysis_from_studio_and_preserves_zero_counts(tmp_path):
    from spur.profile_analytics import data_status
    child,rows=catalog(tmp_path);status=data_status(child)
    assert status['source']=='public_youtube_pages' and status['public_performance_analytics_available']
    assert status['youtube_analytics_api_used'] is False and status['private_youtube_studio_metrics_available'] is False
    assert status['coverage']['metrics_available']=={'views':12,'likes':6,'comments':12}
    assert status['coverage']['publication_dates_available']==11 and status['detailed_video_records']==12
    assert status['latest_observation'] and 'no continuous automatic metric refresh' in status['freshness']


def test_first_enrichment_does_not_turn_rounded_counts_into_growth(tmp_path):
    from spur.video_search import SearchStore
    child,rows=catalog(tmp_path);old={**rows[0],'observed_at':time.time()-7200,'detail_status':None,'metrics':{'views':90,'likes':None,'comments':None}}
    SearchStore(child).save_run({'items':[old],'platform':'youtube','provider':'youtube_public','query':'old','observed_at':old['observed_at']})
    assert next(row for row in analyze(child)['rows'] if row['id']==old['id'])['growth'] is None
    old['detail_status']='collected';SearchStore(child).save_run({'items':[old],'platform':'youtube','provider':'youtube_public','query':'old','observed_at':old['observed_at']})
    assert next(row for row in analyze(child)['rows'] if row['id']==old['id'])['growth']['delta_views']==9910


def test_harness_queries_then_compares_backend_analytics(tmp_path):
    from spur.chat import reply
    child,rows=catalog(tmp_path);child.enqueue_chat('coordinator','Which videos get good viewership? Compare the top two.',uuid.uuid4().hex);job=child.claim();calls=[]
    def handler(request):
        body=json.loads(request.content);calls.append(body)
        if len(calls)==1:
            assert 'computed_profile_analytics' in body['messages'][0]['content']
            function={'name':'get_profile_analytics','arguments':{'days':0,'format':'all','sort':'performance'}}
        elif len(calls)==2:
            data=json.loads(body['messages'][-1]['content']);assert data['total']==12 and len(data['evidence_preview'])==10
            function={'name':'compare_profile_videos','arguments':{'video_ids':[r['id'] for r in data['evidence_preview'][:2]]}}
        else:
            assert json.loads(body['messages'][-1]['content'])['comparison_count']==2
            return httpx.Response(200,json={'message':{'role':'assistant','content':'The measured leaders outperform comparable channel videos. Coverage is incomplete; this does not establish causality.'}})
        return httpx.Response(200,json={'message':{'role':'assistant','content':'','tool_calls':[{'function':function}]}})
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:await reply(child,replace(Settings(),model='test'),job,client)
    asyncio.run(run());assert len(calls)==3 and child.job(job['id'])['status']=='succeeded'


def test_insight_report_can_cite_analytics_records_with_valid_provenance(tmp_path):
    from spur.agent import generate_report
    child,rows=catalog(tmp_path);calls=[]
    def handler(request):
        body=json.loads(request.content);calls.append(body)
        assert 'readable insight report' in body['messages'][0]['content']
        if 'format' not in body:return httpx.Response(200,json={'message':{'role':'assistant','content':'Ready to summarize the evidence.'}})
        result={'summary':'One upload substantially exceeds comparable videos. Test the creative framing before assuming it causes better performance.','developments':[{'title':'A strong observed performer','observation':'The saved comparison shows unusually high views relative to its channel peers.','implication':'Develop a new variation and compare it with a similar upload.','evidence_ids':[rows[0]['id']]}],'potential_trends':[],'limitations':['Public metadata describes outcomes and cannot prove their causes.']}
        return httpx.Response(200,json={'message':{'role':'assistant','content':json.dumps(result)}})
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:return await generate_report(child,replace(Settings(),model='test'),{'topic':'Write a practical insights report','days':30},client)
    report=asyncio.run(run())
    assert report['sources'][rows[0]['id']]['source_id']==child.sources()[0]['id']
    assert report['developments'][0]['implication'] and len(calls)==2
