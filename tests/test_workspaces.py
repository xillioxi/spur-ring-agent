import asyncio
import json
from dataclasses import replace
from pathlib import Path

import httpx
from fastapi.testclient import TestClient

from spur.auth import Accounts,workspace_settings
from spur.config import Settings
from spur.credentials import load_key
from spur.store import Store


def test_public_signup_has_private_content_credentials_and_onboarding(tmp_path,monkeypatch):
    import spur.api as api
    config=replace(Settings(),db_path=str(tmp_path/'root.db'),api_key='service-key')
    monkeypatch.setattr(api,'settings',config)
    monkeypatch.setenv('DEEPSEEK_API_KEY','installation-secret')
    with TestClient(api.app) as client:
        auth={'X-Spur-Auth':'1'}
        def signup(username):
            response=client.post('/auth/register',headers=auth,json={'username':username,'display_name':username,'password':'private-test-passphrase'})
            assert response.status_code==201
            return response.json()
        owner=signup('owner');owner_cookies=dict(client.cookies)
        root=api.app.state.store;root.add_knowledge('Owner private context','Never copy this to new accounts')
        root.add_agent('Owner custom agent','Private agent','Private instructions')
        root.add_source('UC'+'a'*22,'Owner channel')
        root.set_runtime('creator_brief',{'channel_name':'Owner Channel'})
        root.set_runtime('connection',{'provider':'deepseek','model':'deepseek-flash'})
        mid=root.create_mission('Owner strategy',7,'coordinator')
        jid=root.enqueue_chat('coordinator','Owner private message','owner-chat-request')
        with root.connect() as db:db.execute('INSERT INTO reports VALUES(?,?,?,?)',('owner-output','owner-output-job',json.dumps({'topic':'Owner output','summary':'Owner private report'}),1))
        assert client.get('/signup',follow_redirects=False).status_code==303
        client.cookies.clear()
        assert client.get('/signup').status_code==200 and 'Create an account' in client.get('/login').text
        member=signup('newcreator');csrf={'X-CSRF-Token':member['csrf_token']}
        for endpoint in ('knowledge','sources','videos','reports','missions','schedules'):
            assert client.get('/'+endpoint).json()==[]
        assert client.get('/agents/coordinator/chat').json()==[]
        assert len(client.get('/agents').json())==12
        assert client.get('/creator-brief').json().get('channel_name','')==''
        assert client.get('/settings/provider').json()=={'provider':'ollama','model':'','has_key':False}
        assert client.put('/settings/provider',headers=csrf,json={'provider':'deepseek','model':'deepseek-flash'}).status_code==422
        for endpoint,identifier in [('missions',mid),('jobs',jid),('reports','owner-output')]:
            assert client.get('/'+endpoint+'/'+identifier).status_code==404
        assert client.get('/auth/me').json()['onboarding']=={'completed':False}
        assert client.post('/auth/onboarding/complete',headers=csrf).status_code==204
        assert client.get('/auth/me').json()['onboarding']=={'completed':True}
        assert client.post('/knowledge',headers=csrf,json={'title':'New creator note','content':'Private to this account'}).status_code==201
        client.cookies.clear();client.cookies.update(owner_cookies)
        assert client.get('/auth/me').json()['onboarding']=={'completed':False}
        assert client.get('/knowledge').json()[0]['title']=='Owner private context'
        assert client.get('/settings/provider').json()['model']=='deepseek-flash'
        assert len(client.get('/agents').json())==13
        assert client.get('/dashboard',headers={'X-Spur-User':member['user']['id']}).status_code==409
        assert client.post('/knowledge',headers={'X-CSRF-Token':owner['csrf_token'],'X-Spur-User':member['user']['id']},json={'title':'Wrong account','content':'Do not save'}).status_code==409
        assert len(client.get('/knowledge').json())==1
        private_path=Accounts(root).workspace_path(member['user']['id'])
        assert Path(private_path).is_file() and Path(private_path).parent.name==member['user']['id']
        isolated=workspace_settings(config,private_path)
        assert not isolated.allow_env_keys and load_key(isolated,'deepseek')==''


def test_worker_discovers_and_executes_in_each_private_workspace(tmp_path,monkeypatch):
    import spur.worker as worker
    root=Store(str(tmp_path/'root.db'));accounts=Accounts(root)
    owner=accounts.create_user('owner','Owner','private-test-passphrase')
    member=accounts.create_user('member','Member','private-test-passphrase',allow_existing=True)
    stores={};found=worker.discover_workspaces(root,stores)
    assert len(found)==2
    private=next(store for store in found if Path(store.path).resolve()!=Path(root.path).resolve())
    private.set_runtime('connection',{'provider':'ollama','model':'member-model'})
    root.set_runtime('connection',{'provider':'ollama','model':'owner-model'})
    private.enqueue_chat('title-lab','Hello from new creator','member-request')
    seen=[]
    def handler(request):
        body=json.loads(request.content);seen.append(body)
        assert body['model']=='member-model' and 'new creator' in body['messages'][-1]['content']
        return httpx.Response(200,json={'message':{'role':'assistant','content':'Hello, new creator!'}})
    config=replace(Settings(),db_path=root.path)
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            await worker.execute(private,private.claim(),client,workspace_settings(config,private.path))
    asyncio.run(run())
    assert private.chat('title-lab')[-1]['content']=='Hello, new creator!'
    assert root.chat('title-lab')==[] and len(seen)==1
    assert len(worker.discover_workspaces(root,stores))==2
