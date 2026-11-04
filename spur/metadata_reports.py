"""Deterministic metadata reports: measured values, explicit formulas, no video inference."""
import json
import math
import re
import statistics
import time
import uuid
from pydantic import BaseModel,Field,ConfigDict
from spur.video_search import SearchStore,SearchError


class MetadataReportInput(BaseModel):
    model_config=ConfigDict(extra='forbid')
    search_id:str=Field(pattern=r'^[a-f0-9]{32}$')
    selected_ids:list[str]|None=Field(default=None,max_length=20)


class AnalyticsPermissionInput(BaseModel):
    youtube_approved:bool=False
    approval_reference:str=Field(default='',max_length=200)


def permissions(store):
    root=getattr(store,'platform_store',store)
    saved=root.get_runtime('metadata_analytics_permissions',{'youtube_approved':False,'approval_reference':''})
    with root.connect() as db:app=db.execute("SELECT client_id FROM social_apps WHERE platform='youtube'").fetchone()
    return {**saved,'youtube_approved':bool(saved.get('youtube_approved') and app and saved.get('youtube_client_id')==app['client_id'])}


def number(value):
    if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or value<0:return None
    return float(value)


def field_coverage(rows):
    """Presence counts over the complete input, independent of model preview limits."""
    return {'total_records':len(rows),'metrics_available':{key:sum(number(row.get('metrics',{}).get(key)) is not None for row in rows) for key in ('views','likes','comments')},'publication_dates_available':sum(number(row.get('published')) is not None and row.get('published')>0 for row in rows)}


def derived_allowed(store,snapshot):
    # The existing API-use approval applies to API-sourced YouTube records.
    if not snapshot['items']:return snapshot['provider'] in ('demo_synthetic','youtube_public') or snapshot['platform']!='youtube' or permissions(store)['youtube_approved']
    return all(r.get('platform',snapshot['platform'])!='youtube' or r.get('provider',snapshot['provider']) in ('demo_synthetic','youtube_public') for r in snapshot['items']) or permissions(store)['youtube_approved']


def distribution(values):
    values=sorted(v for v in values if v is not None)
    if not values:return {'available':0,'mean':None,'median':None,'q1':None,'q3':None,'minimum':None,'maximum':None}
    def percentile(p):
        position=(len(values)-1)*p;lo=int(position);hi=min(lo+1,len(values)-1)
        return values[lo]+(values[hi]-values[lo])*(position-lo)
    return {'available':len(values),'mean':statistics.mean(values),'median':statistics.median(values),'q1':percentile(.25),'q3':percentile(.75),'minimum':values[0],'maximum':values[-1]}


def age_band(days):
    if days is None:return 'unknown'
    return '0–2 days' if days<2 else '2–7 days' if days<7 else '7–30 days' if days<30 else '30+ days'


def length_band(row):
    seconds=number(row.get('duration_seconds'))
    if seconds is None and isinstance(row.get('duration'),str):
        match=re.fullmatch(r'PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?',row['duration'])
        if match and any(match.groups()):seconds=sum(float(v or 0)*factor for v,factor in zip(match.groups(),(3600,60,1)))
    if not seconds:return 'unknown duration'
    return '<1 min' if seconds<60 else '1–3 min' if seconds<180 else '3–10 min' if seconds<600 else '10+ min'


def compute(snapshot,selected_ids=None,derived_allowed=True,observations=None):
    rows=snapshot['items']
    if selected_ids is not None:
        if not selected_ids or len(set(selected_ids))!=len(selected_ids) or set(selected_ids)-{r['id'] for r in rows}:raise SearchError('Select unique video IDs from this saved search.')
        rows=[r for r in rows if r['id'] in set(selected_ids)]
    if not rows:raise SearchError('This search has no content to report on. Search again or select some results.')
    observed=snapshot['observed_at'];evidence=[];cohorts={}
    for row in rows:
        published=number(row.get('published'));age=(observed-published)/86400 if published is not None and published<=observed else None
        metrics={k:number(v) for k,v in row.get('metrics',{}).items()}
        views=metrics.get('views');likes=metrics.get('likes');comments=metrics.get('comments')
        item={**row,'metrics':metrics,'age_days':round(age,2) if derived_allowed and age is not None else None,'date_status':'valid' if age is not None else 'unknown_or_future','observed_interactions_per_view_pct':None,'sample_outlier_z':None,'sample_outlier':False,'growth':None}
        if derived_allowed:
            if views is not None and views>0 and likes is not None and comments is not None:item['observed_interactions_per_view_pct']=100*(likes+comments)/views
            group=(row['platform'],row.get('channel_profile_id'),row.get('format','unknown'),age_band(age),length_band(row));cohorts.setdefault(group,[]).append(item)
            history=sorted((r for r in (observations or {}).get((row['platform'],row['id'],row['provider']),[]) if r['observed_at']<=row.get('observed_at',observed)-3600 and (row['provider']!='youtube_public' or (r.get('detail_status')=='collected')==(row.get('detail_status')=='collected'))),key=lambda r:r['observed_at'])
            if views is not None and history:
                prior=history[-1];before=number(prior.get('metrics',{}).get('views'))
                if before is not None:
                    delta=views-before;hours=(row.get('observed_at',observed)-prior['observed_at'])/3600
                    item['growth']={'previous_observed_at':prior['observed_at'],'previous_views':before,'delta_views':delta,'hours':hours,'observed_views_per_hour':delta/hours if delta>=0 else None,'change_pct':100*delta/before if before>0 and delta>=0 else None,'counter_correction':delta<0}
        evidence.append(item)
    cohort_results=[]
    if derived_allowed:
        for (platform,channel_profile_id,format,band,length),members in cohorts.items():
            eligible=[r for r in members if r['metrics'].get('views') is not None]
            enough=len(eligible)>=5 and band!='unknown' and length!='unknown duration';mad=None
            if enough:
                logs=[math.log1p(r['metrics']['views']) for r in eligible];median=statistics.median(logs);mad=statistics.median(abs(v-median) for v in logs)
                if mad>0:
                    for item,value in zip(eligible,logs):item['sample_outlier_z']=.6745*(value-median)/mad;item['sample_outlier']=item['sample_outlier_z']>=3.5
            cohort_results.append({'platform':platform,'channel_profile_id':channel_profile_id,'format':format,'age_band':band,'length_band':length,'size':len(members),'views_available':len(eligible),'outlier_status':'calculated' if enough and mad else 'insufficient_or_constant_data'})
    metrics=sorted({key for r in evidence for key in r['metrics']})
    limitations=list(snapshot.get('warnings',[]))+[
        'Metadata only: no video frames, audio, opening hooks, transcripts, retention, reach, CTR or audience demographics were inspected.',
        'Search-selected samples are not representative of a platform or niche. These results cannot explain why a video performed well.',
        'Public counts are current lifetime observations. Ratios are observed likes plus comments per view, not total engagement or unique engaged people.',
        'A sample outlier is not a viral prediction or a channel-relative breakout. Cohorts use platform, provider format, duration and broad video-age bands; at least five known view counts and known ages/durations are required. Duration bands do not identify YouTube Shorts.',
        'Growth needs two observations of the same item and provider, at least one hour apart. Provider reporting delays and counter corrections can affect it.',
        'Quartiles use linear interpolation. Outlier threshold is a heuristic, not a calibrated probability. Unique video age and sample selection still affect comparisons.',
    ]
    if not derived_allowed:limitations.append('Custom YouTube calculations are locked until the installation owner records the required approved analytics use case / developer-policy amendment. Source values remain available; no custom score was calculated.')
    available_growth=any(r['growth'] for r in evidence)
    return {'mode':'mathematical_analysis' if derived_allowed else 'source_evidence_only','query':snapshot['query'],'platform':snapshot['platform'],'provider':snapshot['provider'],'observed_at':observed,'evidence':evidence,'descriptive':{key:distribution([r['metrics'].get(key) for r in evidence]) for key in metrics} if derived_allowed else {},'cohorts':cohort_results,'growth_status':'observations_available' if available_growth else 'needs_two_observations','limitations':limitations,
            'formulas':{'interactions_pct':'100 × (likes + comments) / views; all three values required and views > 0','outlier':'z = 0.6745 × (log(1 + views) − cohort median log views) / MAD(log views); flag z ≥ 3.5','growth':'(current views − previous views) / elapsed hours; counter decreases are flagged and excluded from growth rates'} if derived_allowed else {}}


def generate(store,value):
    repo=SearchStore(store);snapshot=repo.run(value.search_id)
    allowed=derived_allowed(store,snapshot);history={}
    if allowed:
        with store.connect() as db:
            for row in db.execute('SELECT payload FROM discovery_runs WHERE created<? AND expires>? ORDER BY created DESC LIMIT 200',(snapshot['observed_at'],time.time())):
                previous=json.loads(row['payload'])
                for item in previous['items']:history.setdefault((item['platform'],item['id'],item['provider']),[]).append(item)
    analysis=compute(snapshot,value.selected_ids,allowed,history)
    if snapshot['provider']=='demo_synthetic':analysis['limitations'].insert(0,'SYNTHETIC DEMO: these content records and mathematical results are fictional scenario data, not YouTube or Instagram API statistics.')
    mode=analysis['mode'];n=len(analysis['evidence'])
    summary=(f'Metadata analysis of {n} retrieved items for “{snapshot["query"]}”. Calculations describe this search sample only.' if allowed else f'Source-evidence report for {n} retrieved YouTube items. Custom mathematical analysis awaits the required analytics approval.')
    if allowed:
        views=analysis['descriptive'].get('views',{})
        if views.get('median') is not None:summary+=f' View counts are available for {views["available"]}/{n} items; median views are {views["median"]:,.2f}.'
        candidates=[r for r in analysis['evidence'] if r['sample_outlier']]
        eligible=any(c['outlier_status']=='calculated' for c in analysis['cohorts'])
        summary+=f' {len(candidates)} item(s) meet the sample-outlier heuristic.' if eligible else ' The sample does not support a comparable-cohort outlier calculation.'
        if analysis['growth_status']=='needs_two_observations':summary+=' Growth cannot be assessed yet: another valid observation at least one hour apart is needed.'
    report={'title':'Metadata report · '+snapshot['query'],'topic':snapshot['query'],'summary':summary,'provider':'local','model':'deterministic-metadata-v1','agent_id':'coordinator','workflow':'metadata_analysis','artifact':{'kind':'metadata_analysis','data':analysis},'assumptions':['Only the saved provider response is evidence. No additional search or model call was made.'],'verification_needed':['Review source coverage and metadata limitations before making content decisions.'],'source_search_id':value.search_id,'expires_at':snapshot['expires_at']}
    if snapshot['provider']=='demo_synthetic':
        report['title']='SYNTHETIC DEMO · '+report['title']
        report['summary']='Fictional scenario data for testing. '+report['summary']
    identifier=uuid.uuid4().hex
    with store.connect() as db:
        db.execute('INSERT INTO reports VALUES(?,?,?,?)',(identifier,'metadata:'+identifier,json.dumps(report),time.time()))
    return store.reports(identifier)
