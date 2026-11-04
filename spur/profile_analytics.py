"""Deterministic analytics over the active reference catalog; no model/network calls."""
import json,time
from collections import defaultdict
from typing import Literal
from pydantic import BaseModel,Field,ConfigDict

class AnalyticsQuery(BaseModel):
    model_config=ConfigDict(extra='forbid')
    days:int=Field(default=0,ge=0,le=3650)
    format:Literal['all','video','short','live','image']='all'
    sort:Literal['performance','views','interactions','growth','recent']='performance'
    platform:Literal['all','youtube','instagram','tiktok']='all'

from datetime import datetime,timezone
from spur.mock_profiles import media,context
from spur.metadata_reports import compute,distribution,field_coverage,derived_allowed,number,age_band,length_band
from spur.video_search import SearchError,SearchStore


def peer_key(row):
    age=row.get('age_days')
    band='unknown' if age is None else next((label for ceiling,label in ((2,'0–2d'),(7,'2–7d'),(30,'7–30d'),(90,'30–90d'),(180,'90–180d'),(365,'180–365d'),(730,'1–2y'),(1825,'2–5y')) if age<ceiling),'5y+')
    return (row.get('platform'),row.get('channel_profile_id'),row.get('format'),band,length_band(row))


def analyze(store,days=0,format='all',sort='views',offset=0,limit=50,platform='all'):
    profile=context(store)
    if not profile:raise SearchError('Open a mock/reference profile first.')
    all_rows=media(store);now=time.time();rows=[r for r in all_rows if (platform=='all' or r.get('platform')==platform) and (format=='all' or r.get('format')==format) and (not days or r.get('published') and now-days*86400<=r['published']<=now)]
    provider='demo_synthetic' if profile['mode']=='synthetic' else 'youtube_public' if profile.get('import_method')=='anonymous_public' and profile['platform']=='youtube' else 'youtube_official' if profile['platform']=='youtube' else 'tikhub'
    snapshot={'items':rows,'provider':provider,'platform':profile['platform'],'query':profile['name'],'observed_at':now,'warnings':[]}
    allowed=derived_allowed(store,snapshot);history=defaultdict(list)
    SearchStore(store)
    with store.connect() as db:
        for saved in db.execute('SELECT payload FROM discovery_runs WHERE expires>? ORDER BY created DESC LIMIT 200',(now,)):
            for item in json.loads(saved['payload']).get('items',[]):history[(item['platform'],item['id'],item['provider'])].append(item)
    # Each record has its own fetch time. Avoid treating a mixed-age catalog as one observation.
    evidence=[]
    if rows:
        for row in rows:
            result=compute({**snapshot,'items':[row],'observed_at':row['observed_at']},derived_allowed=allowed,observations=history)
            evidence.extend(result['evidence'])
        cohort_analysis=compute(snapshot,derived_allowed=allowed)
        cohort_by_id={r['id']:r for r in cohort_analysis['evidence']}
        peers=defaultdict(list)
        for item in cohort_analysis['evidence']:
            peers[peer_key(item)].append(item)
        for row in evidence:
            group=peers[peer_key(row)]
            row['peer_age_band']=peer_key(row)[3]
            counts=[number(r['metrics'].get('views')) for r in group if number(r['metrics'].get('views')) is not None]
            typical=distribution(counts)['median'] if len(counts)>=5 and row['age_days'] is not None and length_band(row)!='unknown duration' else None
            row['peer_count']=len(counts);row['peer_median_views']=typical
            row['views_vs_peer_median']=row['metrics'].get('views')/typical if typical and row['metrics'].get('views') is not None else None
            row['sample_outlier_z']=cohort_by_id[row['id']]['sample_outlier_z'];row['sample_outlier']=cohort_by_id[row['id']]['sample_outlier']
    else:cohort_analysis={'cohorts':[]}
    formats=[];months=defaultdict(int)
    for channel_platform,kind in sorted({(r['platform'],r.get('format','unknown')) for r in rows}):
        group=[r for r in rows if r['platform']==channel_platform and r.get('format','unknown')==kind];formats.append({'platform':channel_platform,'format':kind,'records':len(group),'views':distribution([number(r['metrics'].get('views')) for r in group]) if allowed else {}})
    for row in rows:
        if row.get('published') and row['published']<=now:months[datetime.fromtimestamp(row['published'],timezone.utc).strftime('%Y-%m')]+=1
    def value(row):
        if sort=='performance':return row.get('views_vs_peer_median')
        if sort=='interactions':return row.get('observed_interactions_per_view_pct')
        if sort=='growth':return (row.get('growth') or {}).get('observed_views_per_hour')
        if sort=='recent':return row.get('published')
        return row['metrics'].get('views')
    if allowed:evidence.sort(key=lambda r:(value(r) is not None,value(r) if value(r) is not None else -1),reverse=True)
    overall={key:distribution([number(r['metrics'].get(key)) for r in rows]) for key in ('views','likes','comments')} if allowed else {}
    totals={key:sum(number(r['metrics'].get(key)) for r in rows if number(r['metrics'].get(key)) is not None) if any(number(r['metrics'].get(key)) is not None for r in rows) else None for key in ('views','likes','comments')} if allowed else {}
    return {'profile':{k:profile[k] for k in ('id','name','platform','mode','metadata_collection')},'derived_allowed':allowed,'coverage':field_coverage(all_rows),'selected_coverage':field_coverage(rows),'filters':{'days':days,'format':format,'sort':sort,'platform':platform},'distributions':overall,'totals':totals,'formats':formats,'upload_months':[{'month':m,'uploads':months[m]} for m in sorted(months)[-24:]] if allowed else [],'cohorts':cohort_analysis['cohorts'],'growth_available':sum(bool(r['growth']) for r in evidence),'rows':evidence[offset:offset+limit],'total':len(evidence),'offset':offset,'limit':limit,'limitations':['Public lifetime counts, not views earned during the selected publication window.','Missing values are excluded and coverage is shown. Public catalog view counts may be rounded.','Publication-window filters exclude undated videos. Monthly uploads use known dates in UTC; chart shows the latest 24 months present in the selection.','Format medians are descriptive; age and publication mix can differ. Outlier comparisons use format, age and duration cohorts with at least five measured videos.','Growth uses same-provider observations at least one hour apart, per-video fetch times, and excludes decreasing counters. A first enrichment is not a second precise observation.','No private CTR, retention, revenue or demographics, and no causal explanation of performance.']}



def model_context(store,days=0,format='all',sort='performance',limit=10,platform='all'):
    if not getattr(store,'mock_profile',None):return None
    value=analyze(store,days,format,sort,limit=limit,platform=platform)
    sources=store.sources();source_id=sources[0]['id'] if sources else value['profile']['id']
    value['evidence_preview']=[{'source_id':source_id,'description':(r.get('description') or '')[:1000],**{k:r.get(k) for k in ('id','title','url','platform','channel_profile_id','format','published','metrics','age_days','peer_count','peer_age_band','peer_median_views','views_vs_peer_median','observed_interactions_per_view_pct','growth','sample_outlier')}} for r in value.pop('rows')]
    value['preview_is_truncated']=value['total']>len(value['evidence_preview'])
    value['method']='Performance ranking = views / median views among at least 5 same-channel, same-platform, same-format, same age-band, same duration-band videos in the active channel and publication filter. Descriptive comparison, not causal proof or prediction. Missing peers or dates produce no score. Full-catalog coverage is distinct from the preview.'
    return value


def compare(store,identifiers):
    if not identifiers or len(identifiers)>10 or len(set(identifiers))!=len(identifiers):raise SearchError('Select 1-10 unique video IDs.')
    value=analyze(store,sort='performance',limit=max(1,len(media(store))))
    found={r['id']:r for r in value.pop('rows')}
    if set(identifiers)-set(found):raise SearchError('Video IDs must belong to the active profile.')
    value['evidence_preview']=[{k:found[identifier].get(k) for k in ('id','title','url','platform','channel_profile_id','format','published','metrics','age_days','peer_count','peer_age_band','peer_median_views','views_vs_peer_median','observed_interactions_per_view_pct','growth')} for identifier in identifiers]
    value['comparison_count']=len(identifiers)
    return value



def data_status(store):
    if not getattr(store,'mock_profile',None):return None
    profile=context(store);rows=media(store);observations=[r.get('observed_at') for r in rows if r.get('observed_at')]
    return {'source':'synthetic_demo' if profile['mode']=='synthetic' else 'public_youtube_pages' if profile['platform']=='youtube' else 'public_reference_provider',
        'youtube_analytics_api_used':False,'private_youtube_studio_metrics_available':False,'public_performance_analytics_available':profile['derived_analytics_allowed'],
        'coverage':field_coverage(rows),'detailed_video_records':sum(r.get('detail_status')=='collected' for r in rows),
        'descriptions_available':sum(bool(r.get('description')) for r in rows),'earliest_observation':min(observations) if observations else None,'latest_observation':max(observations) if observations else None,
        'freshness':'Saved observations. Analytics calculations read the saved catalog, not a live platform request on every answer. There is no continuous automatic metric refresh. Enrichment collects details for records not yet collected; an empty pending queue does not mean the catalog is empty.',
        'available_analysis':['public view distributions','format summaries','comparable-video baselines','likes plus comments per view when available','observed growth only with repeat comparable observations'],
        'unavailable':['private watch time','CTR','retention','revenue','audience demographics','video watching or transcripts']}
