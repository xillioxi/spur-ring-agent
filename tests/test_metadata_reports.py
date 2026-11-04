import json
import time
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient
from spur.config import Settings
from spur.store import Store
from spur.video_search import SearchStore,SearchError
from spur.metadata_reports import compute,distribution,generate,MetadataReportInput


def sample(platform='tiktok',views=None):
    now=time.time();values=views if views is not None else [100,101,102,103,1000000]
    return {'query':'Travel','platform':platform,'provider':'youtube_official' if platform=='youtube' else 'tikhub','observed_at':now,'window_days':7,'warnings':['Search-selected sample'],
            'items':[{'id':str(i),'title':'Video '+str(i),'creator':'Creator','platform':platform,'provider':'youtube_official' if platform=='youtube' else 'tikhub','format':'video','url':'https://www.tiktok.com/@creator/video/'+str(i),'published':now-3*86400,'observed_at':now,'duration_seconds':30,'metrics':{'views':v,'likes':10,'comments':0}} for i,v in enumerate(values)]}


def test_distributions_use_available_data_and_linear_quartiles():
    result=distribution([10,None,20]);assert result['available']==2
    assert result['median']==15 and result['q1']==12.5 and result['q3']==17.5
    assert distribution([None])['mean'] is None


def test_math_ratios_outliers_and_age_cohorts_are_explicit():
    result=compute(sample())
    assert result['mode']=='mathematical_analysis'
    assert result['evidence'][0]['observed_interactions_per_view_pct']==10
    assert result['evidence'][-1]['sample_outlier']
    assert result['cohorts'][0]['size']==5 and result['cohorts'][0]['outlier_status']=='calculated'
    assert result['growth_status']=='needs_two_observations'


def test_missing_zero_constant_and_small_samples_do_not_create_scores():
    snapshot=sample(views=[0,None,10]);snapshot['items'][2]['metrics']['comments']=None
    result=compute(snapshot)
    assert all(r['sample_outlier_z'] is None for r in result['evidence'])
    assert all(r['observed_interactions_per_view_pct'] is None for r in result['evidence'])
    assert all(r['sample_outlier_z'] is None for r in compute(sample(views=[100]*5))['evidence'])


def test_mixed_lengths_and_unknown_dates_are_not_outlier_cohorts():
    snapshot=sample();snapshot['items'][0]['duration_seconds']=600
    assert all(r['sample_outlier_z'] is None for r in compute(snapshot)['evidence'])
    for row in snapshot['items']:row['published']=None
    result=compute(snapshot);assert all(r['date_status']=='unknown_or_future' and not r['sample_outlier'] for r in result['evidence'])


def test_growth_requires_same_source_and_an_hour_and_handles_corrections():
    snapshot=sample(views=[200]);row=snapshot['items'][0];key=('tiktok','0','tikhub')
    prior={**row,'observed_at':snapshot['observed_at']-3600,'metrics':{'views':100}}
    result=compute(snapshot,observations={key:[prior]});growth=result['evidence'][0]['growth']
    assert growth['delta_views']==100 and growth['observed_views_per_hour']==100 and growth['change_pct']==100
    assert compute(snapshot,observations={('tiktok','0','other'):[prior]})['evidence'][0]['growth'] is None
    assert compute(snapshot,observations={key:[{**prior,'observed_at':snapshot['observed_at']-30}]})['evidence'][0]['growth'] is None
    growth=compute(snapshot,observations={key:[{**prior,'metrics':{'views':300}}]})['evidence'][0]['growth']
    assert growth['counter_correction'] and growth['observed_views_per_hour'] is None


def test_source_evidence_mode_has_no_custom_metrics_and_selection_is_validated():
    result=compute(sample('youtube'),derived_allowed=False)
    assert result['mode']=='source_evidence_only' and not result['descriptive'] and not result['formulas']
    assert all(r['age_days'] is None and r['sample_outlier_z'] is None for r in result['evidence'])
    assert len(compute(sample(),selected_ids=['0'])['evidence'])==1
    for ids in ([],['missing'],['0','0']):
        with pytest.raises(SearchError):compute(sample(),selected_ids=ids)


def test_reports_are_durable_and_expire_with_source_snapshot(tmp_path):
    store=Store(str(tmp_path/'report.db'));repo=SearchStore(store);sid=repo.save_run(sample())
    report=generate(store,MetadataReportInput(search_id=sid))
    assert report['content']['artifact']['kind']=='metadata_analysis' and store.reports(report['id'])
    assert report['content']['source_search_id']==sid
    with store.connect() as db:
        db.execute('UPDATE discovery_runs SET expires=?',(time.time()-1,))
        content=report['content'];content['expires_at']=time.time()-1
        db.execute('UPDATE reports SET content=? WHERE id=?',(json.dumps(content),report['id']))
    store.tick()
    assert store.reports(report['id']) is None
    with store.connect() as db:assert db.execute('SELECT COUNT(*) FROM discovery_runs').fetchone()[0]==0


def test_report_api_is_private_and_only_owner_can_confirm_youtube_permission(tmp_path,monkeypatch):
    import spur.api as api
    monkeypatch.setattr(api,'settings',replace(Settings(),db_path=str(tmp_path/'api.db'),api_key='service'))
    monkeypatch.setattr('spur.social.protect',lambda data,decrypt=False:bytes(data)[::-1])
    with TestClient(api.app) as client:
        response=client.post('/auth/register',headers={'X-Spur-Auth':'1'},json={'username':'owner','display_name':'Owner','password':'test-passphrase-long'})
        csrf={'X-CSRF-Token':response.json()['csrf_token']}
        assert client.put('/social/youtube/app',headers=csrf,json={'client_id':'test-google-client','client_secret':'test-secret'}).status_code==200
        sid=SearchStore(client.app.state.store).save_run(sample('youtube'))
        assert client.post('/search/reports',json={'search_id':sid}).status_code==403
        report=client.post('/search/reports',headers=csrf,json={'search_id':sid}).json()
        assert report['content']['artifact']['data']['mode']=='source_evidence_only'
        assert client.put('/admin/search/analytics-permissions',headers=csrf,json={'youtube_approved':True}).status_code==422
        assert client.put('/admin/search/analytics-permissions',headers=csrf,json={'youtube_approved':True,'approval_reference':'test-only-reference'}).status_code==200
        assert client.post('/search/reports',headers=csrf,json={'search_id':sid}).json()['content']['artifact']['data']['mode']=='mathematical_analysis'
        assert client.put('/social/youtube/app',headers=csrf,json={'client_id':'changed-google-client','client_secret':'test-secret'}).status_code==200
        assert not client.get('/search/analytics-permissions').json()['youtube_approved']
        client.cookies.clear();response=client.post('/auth/register',headers={'X-Spur-Auth':'1'},json={'username':'other','display_name':'Other','password':'test-passphrase-long'})
        csrf={'X-CSRF-Token':response.json()['csrf_token']}
        assert client.get('/search/history').json()['runs']==[]
        assert client.get('/search/history/'+sid).status_code==422
        assert client.post('/search/reports',headers=csrf,json={'search_id':sid}).status_code==422
        assert client.put('/admin/search/analytics-permissions',headers=csrf,json={'youtube_approved':False}).status_code==403
