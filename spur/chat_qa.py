"""Run an isolated chat walkthrough against the saved model. Makes paid API calls."""
import asyncio
import json
import uuid
from dataclasses import replace
from pathlib import Path

import httpx
from fastapi.testclient import TestClient

from spur.config import settings
from spur.credentials import selected_connection
from spur.store import Store


async def main():
    import spur.api as api
    import spur.worker as worker
    production=Store(settings.db_path);connection=selected_connection(production,settings)
    config=replace(settings,db_path='data/chat-qa-'+uuid.uuid4().hex[:8]+'.db',api_key='chat-qa',local_ui=False,
                   model=connection['model'],provider=connection['provider'])
    api.settings=worker.settings=config
    results={'provider':config.provider,'model':config.model,'checks':{}}
    with TestClient(api.app) as app:
        store=api.app.state.store;store.set_runtime('connection',connection);headers={'X-API-Key':'chat-qa'}
        async with httpx.AsyncClient() as network:
            async def chat(agent,text):
                response=app.post('/agents/'+agent+'/chat',headers=headers,json={'content':text,'request_id':uuid.uuid4().hex})
                response.raise_for_status();job=store.claim();assert job['id']==response.json()['job_id']
                await worker.execute(store,job,network)
                history=app.get('/agents/'+agent+'/chat',headers=headers).json()
                assert history[-1]['role']=='assistant' and history[-1]['content']
                return history[-1]
            await chat('title-lab','My Paris travel series is named Silver Compass. Remember that name for our conversation. Reply briefly; do not start a background task.')
            followup=await chat('title-lab','What did I name my travel series? Reply with only the name.')
            assert 'silver compass' in followup['content'].lower();results['checks']['followup_memory']=True
            other=await chat('script-writer','What have we discussed in this agent’s conversation so far? Reply briefly; do not start a task.')
            assert 'silver compass' not in other['content'].lower();results['checks']['separate_agent_history']=True
            handoff=await chat('title-lab','Create and save four titles for Silver Compass, a Paris travel series for first-time visitors. Calm practical language. Start the background task now.')
            assert handoff['metadata']['mission_ids'];mid=handoff['metadata']['mission_ids'][0]
            results['checks']['chat_to_background_task']=True
            for _ in range(6):
                if store.mission(mid)['status']!='active':break
                job=store.claim()
                if not job:raise RuntimeError('Task has no runnable job')
                await worker.execute(store,job,network)
            mission=store.mission(mid);assert mission['status']=='completed'
            output=store.reports(mission['state']['report_id'])['content']
            assert output['artifact']['kind']=='titles';results['checks']['background_output_completed']=True
            restored=Store(config.db_path);assert len(restored.chat('title-lab'))==6
            results['checks']['history_survives_store_restart']=True
    Path('data/chat-review.json').write_text(json.dumps(results,indent=2),encoding='utf-8')
    print(json.dumps(results),flush=True)


if __name__=='__main__':asyncio.run(main())
