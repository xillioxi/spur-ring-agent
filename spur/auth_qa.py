"""Isolated real-HTTP account walkthrough. Does not create production accounts."""
import os
import secrets
import socket
import subprocess
import sys
import time
import uuid

import httpx

from spur.store import Store


def main():
    path='data/auth-qa-'+uuid.uuid4().hex[:8]+'.db';db=Store(path)
    db.add_knowledge('Existing creator context','Preserve our Paris positioning')
    with socket.socket() as listener:listener.bind(('127.0.0.1',0));port=listener.getsockname()[1]
    base=f'http://127.0.0.1:{port}';env={**os.environ,'SPUR_DB':path,'SPUR_API_KEY':secrets.token_urlsafe(32)}
    process=None;password=secrets.token_urlsafe(24);headers={'X-Spur-Auth':'1'}
    def start():
        nonlocal process
        process=subprocess.Popen([sys.executable,'-m','uvicorn','spur.api:app','--host','127.0.0.1','--port',str(port)],
                                 env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
                                 creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
        for _ in range(100):
            if process.poll() is not None:raise RuntimeError('QA server did not start')
            try:
                if httpx.get(base+'/auth/status',timeout=1).status_code==200:return
            except httpx.HTTPError:pass
            time.sleep(.1)
        raise RuntimeError('QA server startup timed out')
    def stop():
        if process and process.poll() is None:process.terminate();process.wait(timeout=10)
    try:
        start()
        with httpx.Client(base_url=base) as client:
            assert client.get('/dashboard').status_code==401
            assert client.get('/').headers['location']=='/login'
            owner=client.post('/auth/register',headers=headers,json={'username':'qa-owner','display_name':'QA Owner','password':password,'remember':True})
            owner.raise_for_status();csrf={'X-CSRF-Token':owner.json()['csrf_token']}
            assert 'HttpOnly' in owner.headers['set-cookie']
            assert client.get('/').status_code==200
            assert len(client.get('/agents').json())==12
            assert client.get('/knowledge').json()[0]['title']=='Existing creator context'
            assert client.post('/jobs/collect').status_code==403
            member=client.post('/auth/register',headers={**headers,**csrf},json={'username':'qa-member','display_name':'QA Member','password':password,'admin_create':True})
            member.raise_for_status();assert client.get('/auth/me').json()['user']['role']=='owner'
            with httpx.Client(base_url=base) as newcomer:
                assert newcomer.get('/signup').status_code==200
                signup=newcomer.post('/auth/register',headers=headers,json={'username':'qa-signup','display_name':'New Creator','password':password})
                signup.raise_for_status();new_csrf={'X-CSRF-Token':signup.json()['csrf_token']}
                assert newcomer.get('/knowledge').json()==[]
                assert newcomer.get('/agents/coordinator/chat').json()==[]
                assert newcomer.get('/settings/provider').json()['model']==''
                assert newcomer.get('/auth/me').json()['onboarding']=={'completed':False}
                assert newcomer.post('/auth/onboarding/complete',headers=new_csrf).status_code==204
                assert newcomer.get('/auth/me').json()['onboarding']=={'completed':True}
                assert client.get('/auth/me').json()['onboarding']=={'completed':False}
            # Rotate the launcher's service key; account sessions remain SQLite-backed.
            stop();env['SPUR_API_KEY']=secrets.token_urlsafe(32);start()
            assert client.get('/auth/me').status_code==200
            assert len(client.get('/auth/users').json())==3
            assert client.post('/auth/logout',headers=csrf).status_code==204
            assert client.get('/dashboard').status_code==401
            login=client.post('/auth/login',headers=headers,json={'username':'qa-member','password':password})
            login.raise_for_status();assert client.get('/auth/users').status_code==403
            assert client.get('/dashboard').status_code==200
            assert client.get('/knowledge').json()==[]
            assert client.get('/creator-brief').json().get('channel_name','')==''
        print('Real HTTP accounts passed: setup, protected workspace, owner/member access, CSRF, logout, login and cookie persistence across server restart. No production accounts created.',flush=True)
    finally:stop()


if __name__=='__main__':main()
