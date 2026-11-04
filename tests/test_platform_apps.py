import json
from dataclasses import replace
from urllib.parse import parse_qs,urlparse

import httpx
import pytest
from fastapi.testclient import TestClient

from spur.auth import Accounts
from spur.config import Settings
from spur.office import OfficeStore
from spur.social import SocialStore
from spur.store import Store
from spur.worker import discover_workspaces


@pytest.fixture
def client(tmp_path,monkeypatch):
    import spur.api as api
    monkeypatch.setattr('spur.social.protect',lambda value,decrypt=False:bytes(value)[::-1])
    monkeypatch.setattr(api,'settings',replace(Settings(),db_path=str(tmp_path/'root.db'),api_key='platform-service'))
    with TestClient(api.app) as client:
        response=client.post('/auth/register',headers={'X-Spur-Auth':'1'},json={'username':'owner','display_name':'Owner','password':'test-passphrase-long'})
        client.csrf={'X-CSRF-Token':response.json()['csrf_token']}
        client.owner_cookies=dict(client.cookies)
        yield client


def configure(client):
    assert client.put('/office/google/app',headers=client.csrf,json={'client_id':'shared-google','client_secret':'platform-google-secret','features':['mail','calendar','docs']}).status_code==200
    assert client.put('/social/instagram/app',headers=client.csrf,json={'client_id':'shared-meta','client_secret':'platform-meta-secret'}).status_code==200


def member(client):
    client.cookies.clear()
    response=client.post('/auth/register',headers={'X-Spur-Auth':'1'},json={'username':'creator','display_name':'Creator','password':'test-passphrase-long'})
    client.csrf={'X-CSRF-Token':response.json()['csrf_token']}
    return response.json()['user']


def test_one_platform_setup_is_available_to_every_user_without_exposing_registration(client):
    configure(client)
    owner=client.get('/admin/integrations').json()
    assert owner['office'][0]['client_id']=='shared-google'
    user=member(client)
    office=client.get('/office/connections').json()['connections'][0]
    social=client.get('/social/connections').json()['connections'][1]
    assert office['configured'] and social['configured'] and not office['can_manage'] and not social['can_manage']
    assert office['status']=='disconnected' and social['status']=='disconnected'
    for item in (office,social):
        assert not {'client_id','has_client_secret','callback_url','api_version','tenant','scopes'}.intersection(item)
        assert 'platform-' not in json.dumps(item)
    private=Store(Accounts(client.app.state.store).workspace_path(user['id']))
    with private.connect() as db:
        assert db.execute('SELECT count(*) FROM office_apps').fetchone()[0]==0
        assert db.execute('SELECT count(*) FROM social_apps').fetchone()[0]==0


def test_members_cannot_change_platform_credentials_or_read_admin_configuration(client):
    configure(client);member(client)
    assert client.get('/admin/integrations').status_code==403
    assert client.put('/office/google/app',headers=client.csrf,json={'client_id':'hijack','client_secret':'hijack-secret','features':['mail']}).status_code==403
    assert client.put('/social/instagram/app',headers=client.csrf,json={'client_id':'hijack','client_secret':'hijack-secret'}).status_code==403
    assert OfficeStore(client.app.state.store).app('google')['client_id']=='shared-google'
    assert SocialStore(client.app.state.store).app('instagram')['client_id']=='shared-meta'


@pytest.mark.parametrize('platform',['linkedin','tiktok'])
def test_new_social_providers_use_owner_registration_without_leaking_credentials(client,platform):
    response=client.put('/social/'+platform+'/app',headers=client.csrf,json={'client_id':'shared-'+platform,'client_secret':'private-new-provider-secret','api_version':'202602' if platform=='linkedin' else 'v24.0'})
    assert response.status_code==200
    assert platform in [item['platform'] for item in client.get('/admin/integrations').json()['social']]
    member(client)
    public=next(c for c in client.get('/social/connections').json()['connections'] if c['platform']==platform)
    assert public['configured'] and not public['can_manage'] and public['status']=='disconnected'
    assert 'client_id' not in public and 'private-new-provider-secret' not in json.dumps(public)
    assert client.put('/social/'+platform+'/app',headers=client.csrf,json={'client_id':'hijack','client_secret':'secret'}).status_code==403
    if platform=='tiktok':
        assert not public['connect_ready'] and 'HTTPS' in public['setup_issue']
        assert client.post('/social/tiktok/connect',headers=client.csrf).status_code==422


def test_member_oauth_uses_platform_client_but_stores_tokens_only_in_private_workspace(client,monkeypatch):
    import spur.api as api
    configure(client);user=member(client)
    response=client.post('/office/google/connect',headers=client.csrf)
    params=parse_qs(urlparse(response.json()['authorization_url']).query)
    assert params['client_id']==['shared-google']
    original=httpx.AsyncClient
    def handler(request):
        if request.url.path.endswith('/token'):
            values=parse_qs(request.content.decode());assert values['client_secret']==['platform-google-secret']
            return httpx.Response(200,json={'access_token':'creator-private-token','refresh_token':'creator-private-refresh','scope':'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose'})
        return httpx.Response(200,json={'sub':'creator-google-account','email':'creator@example.com'})
    monkeypatch.setattr(api.httpx,'AsyncClient',lambda **kwargs:original(transport=httpx.MockTransport(handler),**kwargs))
    assert client.get('/office/google/callback',params={'state':params['state'][0],'code':'provider-code'}).status_code==200
    assert client.get('/office/connections').json()['connections'][0]['email']=='creator@example.com'
    root=client.app.state.store
    assert OfficeStore(root).connection('google') is None
    private=Store(Accounts(root).workspace_path(user['id']))
    assert OfficeStore(private).connection('google')['tokens']['access_token']=='creator-private-token'
    client.cookies.clear();client.cookies.update(client.owner_cookies)
    assert client.get('/office/connections').json()['connections'][0]['status']=='disconnected'


def test_worker_private_workspaces_use_shared_registration_but_not_shared_connections(client):
    configure(client);user=member(client);root=client.app.state.store
    stores={};all_stores=discover_workspaces(root,stores)
    private=next(s for s in all_stores if str(s.path)==Accounts(root).workspace_path(user['id']))
    assert OfficeStore(private).app('google')['client_id']=='shared-google'
    assert SocialStore(private).app('instagram')['client_id']=='shared-meta'
    assert OfficeStore(private).connection('google') is None
    assert SocialStore(private).connection('instagram') is None
