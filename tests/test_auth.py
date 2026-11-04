import hashlib
import time
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from spur.auth import Accounts,AuthError,COOKIE,hash_password,verify_password
from spur.config import Settings
from spur.store import Store

PASSWORD='sample-passphrase-123'
AUTH={'X-Spur-Auth':'1'}


@pytest.fixture
def client(tmp_path,monkeypatch):
    import spur.api as api
    monkeypatch.setattr(api,'settings',replace(Settings(),db_path=str(tmp_path/'accounts.db'),api_key='service-key',local_ui=True))
    with TestClient(api.app) as app:yield app


def register(client,username='owner',**kwargs):
    return client.post('/auth/register',headers={**AUTH,**kwargs.pop('headers',{})},json={
        'username':username,'display_name':username.title(),'password':PASSWORD,**kwargs})


def test_registration_login_logout_and_protected_workspace(client):
    assert client.get('/auth/status').json()=={'setup_required':True}
    assert client.get('/',follow_redirects=False).headers['location']=='/login'
    assert client.get('/dashboard').status_code==401
    response=register(client);assert response.status_code==201
    assert response.json()['user']['role']=='owner'
    assert 'password' not in str(response.json())
    cookie=response.headers['set-cookie'];assert 'HttpOnly' in cookie and 'SameSite=strict' in cookie
    assert 'Max-Age=2592000' not in cookie
    assert client.get('/').status_code==200 and 'agent-directory' in client.get('/').text
    assert client.get('/login',follow_redirects=False).status_code==303
    assert client.get('/dashboard').status_code==200
    assert client.post('/jobs/collect').status_code==403
    csrf={'X-CSRF-Token':response.json()['csrf_token']}
    assert client.post('/jobs/collect',headers=csrf).status_code==202
    raw_token=client.cookies.get(COOKIE)
    result=client.post('/auth/logout',headers=csrf);assert result.status_code==204 and result.content==b''
    assert client.get('/auth/me').status_code==401
    client.cookies.set(COOKIE,raw_token)
    assert client.get('/dashboard').status_code==401
    client.cookies.clear()
    login=client.post('/auth/login',headers=AUTH,json={'username':'OWNER','password':PASSWORD,'remember':True})
    assert login.status_code==200 and 'Max-Age=2592000' in login.headers['set-cookie']
    assert client.get('/auth/me').json()['user']['username']=='owner'


def test_passwords_salted_sessions_hashed_expired_and_restart_durable(tmp_path):
    path=str(tmp_path/'durable.db');store=Store(path);accounts=Accounts(store)
    owner=accounts.create_user('owner','Owner',PASSWORD)
    accounts.create_user('member','Member',PASSWORD,allow_existing=True)
    session=accounts.create_session(owner['id'],True)
    with store.connect() as db:
        hashes=[row[0] for row in db.execute('SELECT password_hash FROM users')]
        assert len(set(hashes))==2 and all(PASSWORD not in value for value in hashes)
        row=db.execute('SELECT token_hash FROM user_sessions').fetchone()
        assert row[0]==hashlib.sha256(session['token'].encode()).hexdigest()
        assert row[0]!=session['token']
    restored=Accounts(Store(path));assert restored.session(session['token'])['user']['id']==owner['id']
    assert restored.login('owner',PASSWORD,'127.0.0.1')['id']==owner['id']
    with store.connect() as db:db.execute('UPDATE user_sessions SET expires=?',(time.time()-1,))
    assert restored.session(session['token']) is None
    assert verify_password(PASSWORD,hashes[0]) and not verify_password('wrong',hashes[0])


def test_owner_adds_member_without_switching_sessions(client):
    owner=register(client).json();csrf={'X-CSRF-Token':owner['csrf_token']}
    assert client.get('/auth/status').json()['setup_required'] is False
    assert register(client,'outsider').status_code==409
    response=register(client,'member',headers=csrf,admin_create=True);assert response.status_code==201
    assert response.json()['user']['role']=='member' and 'set-cookie' not in response.headers
    assert client.get('/auth/me').json()['user']['id']==owner['user']['id']
    users=client.get('/auth/users').json();assert len(users)==2 and 'password_hash' not in str(users)
    assert register(client,'MEMBER',headers=csrf,admin_create=True).status_code==409
    member_login=client.post('/auth/login',headers=AUTH,json={'username':'member','password':PASSWORD})
    assert member_login.status_code==200
    assert client.get('/auth/users').status_code==403
    assert register(client,'intruder',headers={'X-CSRF-Token':member_login.json()['csrf_token']},admin_create=True).status_code==403
    assert client.get('/dashboard').status_code==200


def test_csrf_origin_and_legacy_cookie_cannot_bypass_login(client):
    assert register(client,headers={'Origin':'https://attacker.example'}).status_code==403
    assert client.post('/auth/register',json={'username':'owner','display_name':'Owner','password':PASSWORD}).status_code==403
    client.cookies.set('spur_session','service-key')
    assert client.get('/dashboard').status_code==401
    owner=register(client).json();csrf={'X-CSRF-Token':owner['csrf_token']}
    assert client.post('/jobs/collect',headers={**csrf,'Origin':'http://localhost:9000'}).status_code==403
    assert client.post('/auth/logout',headers={'X-CSRF-Token':'incorrect'}).status_code==403
    assert client.post('/jobs/collect',headers={**csrf,'Origin':'http://testserver'}).status_code==202
    assert client.post('/auth/login',headers={**AUTH,'Sec-Fetch-Site':'cross-site'},json={'username':'owner','password':PASSWORD}).status_code==403
    assert client.get('/dashboard',headers={'X-API-Key':'service-key'}).status_code==200
    assert client.get('/auth/me').headers['cache-control']=='no-store'


def test_password_change_revokes_other_sessions_and_old_password(client):
    owner=register(client).json();accounts=Accounts(client.app.state.store)
    other=accounts.create_session(owner['user']['id'])
    csrf={'X-CSRF-Token':owner['csrf_token']}
    assert client.post('/auth/password',headers=csrf,json={'current_password':'wrong','new_password':'new-test-password-123'}).status_code==400
    result=client.post('/auth/password',headers=csrf,json={'current_password':PASSWORD,'new_password':'new-test-password-123'})
    assert result.status_code==200 and result.json()['csrf_token']!=owner['csrf_token']
    assert accounts.session(other['token']) is None and client.get('/auth/me').status_code==200
    assert client.post('/auth/login',headers=AUTH,json={'username':'owner','password':PASSWORD}).status_code==401
    assert client.post('/auth/login',headers=AUTH,json={'username':'owner','password':'new-test-password-123'}).status_code==200


def test_validation_and_login_throttling(client):
    assert register(client,password='short').status_code==422
    assert register(client,'bad username').status_code==422
    assert register(client).status_code==201
    for _ in range(8):
        assert client.post('/auth/login',headers=AUTH,json={'username':'owner','password':'incorrect'}).status_code==401
    response=client.post('/auth/login',headers=AUTH,json={'username':'owner','password':PASSWORD})
    assert response.status_code==429 and response.headers['retry-after']=='900'
    unknown=client.post('/auth/login',headers=AUTH,json={'username':'unknown','password':'incorrect'})
    assert unknown.status_code==401 and unknown.json()['detail']=='Incorrect username or password.'


def test_first_owner_creation_is_exclusive_and_remote_bootstrap_rejected(client):
    accounts=Accounts(client.app.state.store)
    first=accounts.create_user('first','First',PASSWORD);assert first['role']=='owner'
    with pytest.raises(AuthError,match='already exists'):accounts.create_user('second','Second',PASSWORD)
    assert len(accounts.users())==1


def test_https_cookie_has_secure_flag(tmp_path,monkeypatch):
    import spur.api as api
    monkeypatch.setattr(api,'settings',replace(Settings(),db_path=str(tmp_path/'secure.db'),api_key='key'))
    with TestClient(api.app,base_url='https://localhost') as client:
        response=register(client);assert response.status_code==201
        assert 'Secure' in response.headers['set-cookie']


def test_stale_verification_is_marked_before_any_write(client):
    register(client)
    body={'title':'Recovery test','content':'Save this exactly once'}
    rejected=client.post('/knowledge',json=body,headers={'X-CSRF-Token':'stale'})
    assert rejected.status_code==403 and rejected.headers['X-Spur-Session-Error']=='csrf'
    assert client.get('/knowledge').json()==[]
    current=client.get('/auth/me').json()
    retried=client.post('/knowledge',json=body,headers={'X-CSRF-Token':current['csrf_token']})
    assert retried.status_code==201 and len(client.get('/knowledge').json())==1
    forbidden=client.post('/knowledge',json=body,headers={'X-CSRF-Token':current['csrf_token'],'Origin':'https://foreign.example'})
    assert forbidden.status_code==403 and 'X-Spur-Session-Error' not in forbidden.headers
    assert client.get('/static/accounts.js').headers['Cache-Control']=='no-cache'


def test_page_asset_versions_change_with_content(tmp_path,monkeypatch):
    import spur.api as api
    monkeypatch.setattr(api,'STATIC',tmp_path)
    (tmp_path/'index.html').write_text('<script src="/static/client.js"></script>')
    script=tmp_path/'client.js';script.write_text('first version')
    first=api.asset_page('index.html')
    assert b'client.js?v=' in first.body and first.headers['cache-control']=='no-store'
    assert api.asset_page('index.html').body==first.body
    script.write_text('updated version')
    assert api.asset_page('index.html').body!=first.body
