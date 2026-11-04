"""Bounded automatic briefings at metadata milestones, through the existing harness."""
import time
from spur.mock_profiles import Profiles
from spur.credentials import selected_connection


def feed(store):
    state=store.get_runtime('proactive_insights',{'enabled':True,'entries':[]});entries=[]
    for entry in reversed(state.get('entries',[])[-3:]):
        mission=store.mission(entry['mission_id'])
        if not mission:continue
        report=store.reports(mission['state']['report_id']) if mission['state'].get('report_id') else None
        doc=report['content'] if report else {}
        entries.append({**entry,'status':mission['status'],'report_id':report['id'] if report else None,'summary':doc.get('summary',''),'findings':[{'title':f['title'],'implication':f['implication']} for f in doc.get('developments',[])[:3]]})
    return {'enabled':state.get('enabled',True),'entries':entries,'waiting':state.get('waiting'),'policy':'Automatic briefings at initial usable data, halfway enrichment and completed collection. At most three per import generation; one active briefing at a time. Uses the configured model.'}


def configure(store,enabled):
    state=store.get_runtime('proactive_insights',{'entries':[]})
    paused=[]
    for entry in state.get('entries',[]):
        mission=store.mission(entry['mission_id'])
        if not mission:continue
        try:
            if not enabled and mission['status']=='active':store.control_mission(mission['id'],'pause');paused.append(mission['id'])
            elif enabled and mission['status']=='paused' and mission['id'] in state.get('paused_by_setting',[]):store.control_mission(mission['id'],'resume')
        except ValueError:pass  # A worker can complete between the read and control operation.
    state.update(enabled=enabled,paused_by_setting=paused if not enabled else [])
    store.set_runtime('proactive_insights',state);return feed(store)


def maybe_schedule(store,config,force_check=False):
    if not getattr(store,'mock_profile',None):return
    now=time.time()
    if not force_check and now-getattr(store,'_insight_checked',0)<60:return
    store._insight_checked=now
    from spur.mock_profiles import context,media
    info=context(store)
    if not info or info['mode']!='public' or not info['complete']:return
    state=store.get_runtime('proactive_insights',{'enabled':True,'entries':[]})
    if not state.get('enabled',True):return
    if not selected_connection(store,config).get('model'):
        state['waiting']='Connect a model to receive automatic insights.';store.set_runtime('proactive_insights',state);return
    rows=media(store)
    counts={'total':len(rows),'dated':sum(bool(r.get('published')) for r in rows),'detailed':sum(r.get('detail_status')=='collected' for r in rows),'measured':sum(r.get('metrics',{}).get('views') is not None for r in rows)}
    total=counts['total'];dated=counts['dated'] or 0;detailed=counts['detailed'] or 0
    if not total or (counts['measured'] or 0)<5 or dated<5:
        state['waiting']='Gathering enough dated, measured videos for useful comparisons.';store.set_runtime('proactive_insights',state);return
    milestone='complete' if detailed==total or info.get('metadata_collection',{}).get('status') in ('completed','completed_with_gaps') else 'halfway' if detailed>=total/2 else 'initial'
    generation=info['generation']
    if len(info.get('channels',[]))>1:
        import hashlib
        channels=Profiles(store.profile_parent).channels(info['id'])
        generation+=':'+hashlib.sha256('|'.join(sorted(c['id']+':'+c['generation'] for c in channels)).encode()).hexdigest()[:16]
    key='proactive:'+info['id']+':'+generation+':'+milestone
    if any(e['key']==key for e in state['entries']):return
    if any((m:=store.mission(e['mission_id'])) and m['status'] in ('active','paused') for e in state['entries']):return
    prompt=(f'Automatic insight briefing for {info["name"]}. Current milestone: {milestone}; {dated}/{total} videos have dates and {detailed}/{total} have detailed metadata. '
        'Use the active profile catalog and computed analytics. Proactively identify up to three useful observations, explain their practical meaning, and recommend a concrete next test. '
        'Write like a helpful colleague; keep the summary under 180 words. Use named video examples with evidence IDs in the structured fields. '
        'Separate measurements from creative hypotheses. A single channel does not establish an industry trend. Do not invent a finding when data is insufficient. '
        'Do not ask the user to request insights, do not issue tool instructions, and do not publish, send messages or change external services. Save this report to Outputs.')
    identifier=store.create_mission(prompt,90,'youtube-research' if info['platform']=='youtube' else 'research-analyst',request_key=key)
    state['entries'].append({'key':key,'mission_id':identifier,'milestone':milestone,'created':now});state['waiting']=None;store.set_runtime('proactive_insights',state)
    with store.connect() as db:
        row=db.execute('SELECT state FROM missions WHERE id=?',(identifier,)).fetchone()
        if row:
            import json
            mission_state=json.loads(row[0]);mission_state['proactive_insight']=True;mission_state['proactive_profile_name']=info['name'];db.execute('UPDATE missions SET state=? WHERE id=?',(json.dumps(mission_state),identifier))
    return identifier
