"""Local browser QA with fixture accounts and mocked providers. Never real mail."""
import base64
import json
import secrets
from dataclasses import replace
from email import policy
from email.message import EmailMessage
from email.parser import BytesParser
from pathlib import Path

import httpx
import uvicorn
import spur.api as api
from spur.auth import Accounts
from spur.office import OfficeStore,OfficeAppInput,scopes
from spur.store import Store


def main():
    path=str(Path('data/office-ui-qa/workspace.db').resolve());store=Store(path);accounts=Accounts(store)
    if not accounts.has_users():
        user=accounts.create_user('office-preview','Workspace preview','local-preview-only-passphrase');accounts.complete_onboarding(user['id'])
    repo=OfficeStore(store)
    for provider in ('google','microsoft'):
        features=['mail','calendar','docs'] if provider=='google' else ['mail','calendar']
        repo.save_app(provider,OfficeAppInput(client_id='fixture-app',client_secret='fixture-only-secret',features=features),'http://localhost:8001/office/'+provider+'/callback')
        repo.connect(provider,{'access_token':'fixture-token','refresh_token':'fixture-refresh','scope':' '.join(scopes(provider,features))},
                     {'sub':'fixture-google','email':'creator@example.test','name':'Fixture creator'} if provider=='google' else {'id':'fixture-microsoft','mail':'creator@example.test','displayName':'Fixture creator'},repo.app(provider))
    mime=EmailMessage();mime['Subject']='Paris filming collaboration';mime['To']='partner@example.test';mime.set_content('Hello,\n\nI am planning a Paris travel video and would like to discuss a potential collaboration.\n\nThank you!')
    drafts={'draft-1':base64.urlsafe_b64encode(mime.as_bytes()).decode()};events={};documents={}
    def handler(request):
        path=request.url.path;payload=json.loads(request.content) if request.content else {};method=request.method
        if '/gmail/v1/users/me/drafts' in path:
            key=path.rsplit('/',1)[-1]
            if method=='GET' and key=='drafts':return httpx.Response(200,json={'drafts':[{'id':k} for k in drafts]})
            if method=='GET':
                raw=drafts[key];mime=BytesParser(policy=policy.default).parsebytes(base64.urlsafe_b64decode(raw))
                message={'raw':raw} if request.url.params.get('format')=='raw' else {'id':key,'snippet':mime.get_content(),'payload':{'headers':[{'name':'Subject','value':str(mime['Subject'])},{'name':'To','value':str(mime['To'])}]}}
                return httpx.Response(200,json={'id':key,'message':message})
            if method=='POST':key='draft-'+secrets.token_hex(4)
            drafts[key]=payload['message']['raw'];return httpx.Response(200,json={'id':key})
        if '/gmail/v1/users/me/messages' in path:return httpx.Response(200,json={'messages':[]})
        if '/calendar/v3/calendars/primary/events' in path:
            key=path.rsplit('/',1)[-1]
            if method=='GET':return httpx.Response(200,json=events[key] if key!='events' else {'items':list(events.values())})
            if method=='POST':key='event-'+secrets.token_hex(4)
            events[key]={**payload,'id':key,'etag':'"fixture-event"','organizer':{'self':True}}
            return httpx.Response(200,json=events[key])
        if path.startswith('/v1/documents'):
            key=path.rsplit('/',1)[-1].replace(':batchUpdate','')
            if method=='POST' and key=='documents':
                key='doc-'+secrets.token_hex(8);documents[key]={'documentId':key,'title':payload['title'],'revisionId':'fixture-revision','tabs':[{'tabProperties':{'tabId':'main','title':'Main'},'documentTab':{'body':{'content':[{'paragraph':{'elements':[{'textRun':{'content':''}}]}}]}}}]}
                return httpx.Response(200,json={'documentId':key})
            if key not in documents:return httpx.Response(404,json={})
            if method=='GET':return httpx.Response(200,json=documents[key])
            text=documents[key]['tabs'][0]['documentTab']['body']['content'][0]['paragraph']['elements'][0]['textRun']
            for change in payload['requests']:
                if 'insertText' in change:text['content']+=change['insertText']['text']
                if 'replaceAllText' in change:
                    value=change['replaceAllText'];text['content']=text['content'].replace(value['containsText']['text'],value['replaceText'])
            return httpx.Response(200,json={'documentId':key})
        if path.endswith('/mailFolders/drafts/messages') or path.endswith('/mailFolders/inbox/messages'):return httpx.Response(200,json={'value':[]})
        if path.endswith('/messages') and method=='POST':return httpx.Response(200,json={'id':'outlook-fixture-draft'})
        if path.endswith('/calendarView'):return httpx.Response(200,json={'value':[]})
        if path.endswith('/events') and method=='POST':return httpx.Response(200,json={'id':'outlook-fixture-event'})
        return httpx.Response(404,json={'error':'Fixture endpoint not implemented'})
    original=httpx.AsyncClient
    api.httpx.AsyncClient=lambda **kwargs:original(transport=httpx.MockTransport(handler),**kwargs)
    api.settings=replace(api.settings,db_path=str(store.path),api_key=secrets.token_urlsafe(24),local_ui=True,allow_env_keys=False,provider='ollama',model='')
    uvicorn.run(api.app,host='127.0.0.1',port=8001,proxy_headers=False)


if __name__=='__main__':main()
