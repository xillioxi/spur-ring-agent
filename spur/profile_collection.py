"""Persisted, bounded per-video public metadata collection for imported profiles."""
import time,uuid
from spur.mock_profiles import Profiles,media,put_media,materialize
from spur.video_search import SearchError


def start(store,request_key=None,stop=False):
    info=getattr(store,'mock_profile',None)
    if not info or info['mode']!='public' or info['platform']!='youtube':raise SearchError('Open an imported public YouTube profile to collect video details.')
    registry=Profiles(store.profile_parent);info=registry.get(info['id']);run=info.get('metadata_collection',{})
    if stop:
        run.update(status='paused');info['metadata_collection']=run;registry.update(info);return {k:v for k,v in run.items() if k!='pending'}
    if run.get('status')=='running' or request_key and run.get('request_key')==request_key:return {k:v for k,v in run.items() if k!='pending'}
    if not info['complete']:raise SearchError('Finish the catalog import before collecting per-video details.')
    catalog=media(store,own=True)
    pending=[r['id'] for r in catalog if r.get('detail_status')!='collected']
    if not pending:return {'status':'nothing_pending','catalog_records':len(catalog),'already_collected':len(catalog),'message':'All catalog videos already have a collected detail record. No new requests were made; this does not verify that counts are current.'}
    run={'id':uuid.uuid4().hex,'request_key':request_key,'status':'running' if pending else 'completed','pending':pending,'total':len(pending),'processed':0,'succeeded':0,'failed':0,'consecutive_failures':0,'last_error':'','started':time.time()}
    info['metadata_collection']=run;registry.update(info)
    if pending:store.enqueue('profile_metadata',{'run_id':run['id']})
    return {k:v for k,v in run.items() if k!='pending'}


async def step(store,job):
    from spur.public_youtube import video_details
    registry=Profiles(store.profile_parent);info=registry.get(store.mock_profile['id']);run=info.get('metadata_collection',{})
    if run.get('id')!=job['payload']['run_id'] or run.get('status')!='running':store.finish(job,{'skipped':'Collection stopped or superseded'});return
    rows={r['id']:r for r in media(store)};identifier=run['pending'][run['processed']];row=rows.get(identifier);blocked=False
    store.record_event(job,'tool','Read public video metadata',{'video_id':identifier,'position':run['processed']+1,'total':run['total']})
    try:
        if not row:raise SearchError('Video is no longer in this profile catalog.')
        details=await video_details(identifier)
        # Never replace known fields with missing response values.
        previous=row.get('metrics',{});row.update({k:v for k,v in details.items() if k!='metrics' and v is not None and v!=''})
        row['metrics']={k:details['metrics'].get(k) if details['metrics'].get(k) is not None else previous.get(k) for k in ('views','likes','comments')}
        put_media(store,[row]);run['succeeded']+=1;run['consecutive_failures']=0
        store.record_event(job,'result','Saved public video details',{'video_id':identifier,'has_publication_date':bool(row.get('published')),'available_metrics':[k for k,v in details['metrics'].items() if v is not None]})
    except Exception as error:
        message=str(error)[:600];run['failed']+=1;run['consecutive_failures']+=1;run['last_error']=message
        if row:row.update(detail_status='failed',detail_error=message);put_media(store,[row])
        blocked=any(term in message.lower() for term in ('sign in','bot','429','captcha','too many requests')) or run['consecutive_failures']>=3
        store.record_event(job,'error','Video detail collection failed',{'video_id':identifier,'error':message,'paused':blocked})
    run['processed']+=1
    # Respect a pause applied while the request was in flight.
    latest=registry.get(info['id']).get('metadata_collection',{})
    if latest.get('id')!=run['id']:
        store.finish(job,{'skipped':'Collection superseded while request was in flight'});return
    if latest.get('id')==run['id'] and latest.get('status')=='paused':blocked=True
    run['status']='paused' if blocked else ('completed_with_gaps' if run['failed'] else 'completed') if run['processed']>=run['total'] else 'running'
    info['metadata_collection']=run
    if run['status']!='running' or run['processed']%10==0:materialize(store,info)
    registry.update(info)
    if run['status']=='running':
        with store.connect() as db:store._enqueue(db,'profile_metadata',{'run_id':run['id']},time.time()+3)
    store.finish(job,{'processed':run['processed'],'total':run['total'],'status':run['status']})
