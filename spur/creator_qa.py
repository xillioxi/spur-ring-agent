"""Explicit, isolated, live-provider creator walkthrough. Uses paid calls when invoked."""
import argparse
import asyncio
import json
from dataclasses import replace
from pathlib import Path

import httpx
from fastapi.testclient import TestClient

from spur.config import settings
from spur.credentials import selected_connection
from spur.creator_catalog import CREATOR_AGENTS
from spur.store import Store


async def walkthrough(round_number,only_agent=None):
    import spur.api as api
    import spur.worker as worker
    production=Store(settings.db_path)
    connection=selected_connection(production,settings)
    config=replace(settings,db_path='data/creator-qa.db',api_key='qa-local-session',local_ui=False,
                   provider=connection['provider'],model=connection['model'])
    api.settings=worker.settings=config
    result_path=Path(f'data/creator-qa-round-{round_number}.json')
    results=json.loads(result_path.read_text(encoding='utf-8')) if only_agent and result_path.exists() else []
    with TestClient(api.app) as app:
        headers={'X-API-Key':'qa-local-session'}
        brief={'channel_name':'Paris Pocket','niche':'Affordable, practical Paris travel',
               'audience':'English-speaking first-time visitors, age 20-35',
               'voice':'Friendly, specific, calm; no exaggerated claims',
               'platforms':'YouTube and Shorts',
               'production_constraints':'One creator, phone camera, 6 editing hours per week; film on Saturday'}
        app.put('/creator-brief',headers=headers,json=brief).raise_for_status()
        qa=api.app.state.store
        qa.set_runtime('connection',connection)
        # Seed public evidence already collected by the real application, not invented metrics.
        if not qa.items(0,10**12):
            for source in production.sources()[:2]:
                target=qa.add_source(source['channel_id'],source['name'])
                videos=[v for v in production.mission_evidence([source['channel_id']])]
                qa.save_items(target['id'],videos)
        async with httpx.AsyncClient() as network:
            profiles=list(CREATOR_AGENTS)
            if round_number==2:
                profiles.append({'id':'coordinator','example':'Use Idea Strategist to propose three Paris travel concepts, then Script Writer to write a 60-second script for one concept, then Title & Hook Lab to package that script. Pass the complete deliverables between agents. Do not discover channels.'})
            if only_agent:profiles=[p for p in profiles if p['id'] in only_agent.split(',')]
            for profile in profiles:
                prompt=profile['example']
                if round_number==2:
                    prompt+='\nRevision brief: Make the output immediately usable by a solo creator. Avoid unsupported prices or promises. State assumptions and verification tasks.'
                if profile['id']=='channel-scout':
                    prompt='Find and follow '+('2' if round_number==2 else '1')+' Paris travel channels for first-time visitors. Explain why each fits.'
                if round_number==2 and profile['id']=='research-analyst':
                    prompt='Compare the positioning of our saved Paris travel channels using their historical video metadata, even if it predates the current lookback. Date the evidence clearly; do not claim current trends or performance. Give three practical format lessons.'
                body={'topic':prompt,'agent_id':profile['id'],'days':30}
                if round_number==2 and profile['id']=='shorts-producer':
                    scripts=[r for r in qa.reports() if r.get('artifact_kind')=='script']
                    if scripts:body['input_report_id']=scripts[0]['id'];body['topic']='Adapt the supplied complete script into 3 original 30-second Shorts. Include spoken lines and shot beats. Do not claim to have cut footage.'
                response=app.post('/missions',headers=headers,json=body);response.raise_for_status()
                mid=response.json()['mission_id']
                outcome={'agent_id':profile['id'],'round':round_number,'mission_id':mid}
                for step_number in range(60 if profile['id']=='coordinator' else 35):
                    # Test driver advances saved polling deadlines, not mission state.
                    with qa.connect() as db:db.execute("UPDATE jobs SET available=0 WHERE status='queued'")
                    job=qa.claim()
                    if not job:break
                    try:
                        await asyncio.wait_for(worker.execute(qa,job,network),timeout=180)
                    except Exception as error:
                        qa.fail(job,f'{type(error).__name__}: {error}')
                        outcome['error']=f'{type(error).__name__}: {error}'[:1200]
                        break
                    mission=qa.mission(mid)
                    if mission['status']!='active':break
                mission=qa.mission(mid)
                outcome['status']=mission['status']
                report_id=mission['state'].get('report_id')
                if report_id:
                    report=app.get('/reports/'+report_id,headers=headers).json()
                    outcome['report_id']=report_id
                    outcome['content']=report['content']
                results=[r for r in results if r['agent_id']!=profile['id']]+[outcome]
                Path(f'data/creator-qa-round-{round_number}.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
                print(json.dumps({k:v for k,v in outcome.items() if k!='content'},ensure_ascii=True),flush=True)
                # A failed run must not monopolize the next specialist's test.
                if mission['status']=='active':
                    qa.control_mission(mid,'cancel')
    return results


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--round',type=int,choices=[1,2],required=True)
    parser.add_argument('--agent',default=None)
    args=parser.parse_args();asyncio.run(walkthrough(args.round,args.agent))
