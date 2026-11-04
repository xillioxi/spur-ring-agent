"""Isolated, local-only fixture workspace for manual browser QA. Never uses real accounts."""
import secrets
from dataclasses import replace
from pathlib import Path

import uvicorn
import spur.api as api
from spur.auth import Accounts
from spur.library import Library
from spur.store import Store


def main():
    path=str(Path('data/library-ui-qa/workspace.db').resolve())
    store=Store(path);accounts=Accounts(store)
    if not accounts.has_users():
        user=accounts.create_user('library-preview','Library preview','local-preview-only-passphrase')
        accounts.complete_onboarding(user['id'])
    library=Library(store)
    examples=[
        {'title':'Paris on €30: a day worth filming','campaign':'Paris autumn','objective':'Help first-time visitors plan a memorable day on a small budget.','owner_agent_id':'script-writer','stage':'production','brief':'Test fixture only. Build a practical route with a morning market, a free viewpoint, and an evening walk. Verify prices before filming.','tags':['Paris','budget travel']},
        {'title':'Five quiet corners of Montmartre','format':'instagram_carousel','campaign':'Paris autumn','owner_agent_id':'thumbnail-director','stage':'review','brief':'Test fixture only. A five-slide visual guide, with one location per slide and a save-worthy final checklist.','tags':['Paris','carousel']},
        {'title':'A slow Sunday along the Seine','format':'instagram_reel','campaign':'Weekend stories','owner_agent_id':'shorts-producer','stage':'scheduled','publish_date':'2026-11-01','brief':'Test fixture only. A 30-second Reel. Start with the river at sunrise and end on a question for the audience.'},
    ]
    for i,item in enumerate(examples):library.create(item,'preview:'+str(i))
    api.settings=replace(api.settings,db_path=path,api_key=secrets.token_urlsafe(24),local_ui=True,allow_env_keys=False,provider='ollama',model='')
    uvicorn.run(api.app,host='127.0.0.1',port=8001,proxy_headers=False)


if __name__=='__main__':main()
