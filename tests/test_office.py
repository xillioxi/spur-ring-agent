import asyncio
import base64
import json
import time
from dataclasses import replace
from email import policy
from email.message import EmailMessage
from email.parser import BytesParser
from urllib.parse import parse_qs,urlparse

import httpx
import pytest
from fastapi.testclient import TestClient

from spur.auth import Accounts,COOKIE
from spur.config import Settings
from spur.office import OfficeStore,OfficeAppInput,OfficeWrite,OfficeSession,OfficeError,access_token,scopes
from spur.store import Store


@pytest.fixture(autouse=True)
def test_cipher(monkeypatch):
    monkeypatch.setattr('spur.social.protect',lambda value,decrypt=False:bytes(value)[::-1])


@pytest.fixture
def client(tmp_path,monkeypatch):
    import spur.api as api
    monkeypatch.setattr(api,'settings',replace(Settings(),db_path=str(tmp_path/'office.db'),api_key='office-service'))
    with TestClient(api.app) as client:
        response=client.post('/auth/register',headers={'X-Spur-Auth':'1'},json={'username':'owner','display_name':'Owner','password':'test-passphrase-long'})
        client.csrf={'X-CSRF-Token':response.json()['csrf_token']}
        yield client


def prepare(store,provider='google',features=None,expires=3600):
    features=features or (['mail','calendar','docs'] if provider=='google' else ['mail','calendar'])
    repo=OfficeStore(store)
    repo.save_app(provider,OfficeAppInput(client_id='client-id',client_secret='app-secret',features=features),'http://testserver/office/'+provider+'/callback')
    profile={'sub':'google-user','email':'creator@example.com'} if provider=='google' else {'id':'microsoft-user','mail':'creator@example.com'}
    repo.connect(provider,{'access_token':'access-secret','refresh_token':'refresh-secret','expires_in':expires,'scope':' '.join(scopes(provider,features))},profile,repo.app(provider))
    return repo


def run(store,provider,handler,work):
    async def main():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:return await work(OfficeSession(store,provider,client))
    return asyncio.run(main())


def write(**values):return OfficeWrite(request_id='request-'+str(time.time_ns()),resource='drafts',**values)


def raw(subject='A draft',body='A message',html=False):
    mime=EmailMessage();mime['Subject']=subject;mime['To']='Creator <person@example.com>';mime.set_content(body,subtype='html' if html else 'plain')
    return base64.urlsafe_b64encode(mime.as_bytes()).decode()


@pytest.mark.parametrize('provider',['google','microsoft'])
def test_calendar_follows_pages_and_excludes_cancelled(tmp_path,provider):
    store=Store(str(tmp_path/'calendar.db'));prepare(store,provider)
    calls=[]
    def handler(request):
        calls.append(request)
        if provider=='google':
            row={'id':'page-'+str(len(calls)),'summary':'Shoot','start':{'date':'2026-10-30'},'end':{'date':'2026-10-31'}}
            return httpx.Response(200,json={'items':[row,dict(row,id='cancelled',status='cancelled')],**({'nextPageToken':'next'} if len(calls)==1 else {})})
        row={'id':'page-'+str(len(calls)),'subject':'Shoot','isAllDay':True,'start':{'dateTime':'2026-10-30T00:00:00'},'end':{'dateTime':'2026-10-31T00:00:00'}}
        return httpx.Response(200,json={'value':[row,dict(row,id='cancelled',isCancelled=True)],**({'@odata.nextLink':'https://graph.microsoft.com/v1.0/me/calendarView?$skiptoken=next'} if len(calls)==1 else {})})
    rows=run(store,provider,handler,lambda s:s.listing('events',start='2026-10-01',end='2026-11-01'))
    assert [r['id'] for r in rows]==['page-1','page-2']
    assert rows[0]['all_day'] and rows[0]['end']=='2026-10-31'
    assert len(calls)==2
    assert calls[1].url.params.get('pageToken' if provider=='google' else '$skiptoken')=='next'


def test_calendar_rejects_external_continuation(tmp_path):
    store=Store(str(tmp_path/'calendar.db'));prepare(store,'microsoft')
    calls=[]
    def handler(request):
        calls.append(request);return httpx.Response(200,json={'value':[],'@odata.nextLink':'https://untrusted.example/calendarView'})
    with pytest.raises(OfficeError,match='invalid continuation'):
        run(store,'microsoft',handler,lambda s:s.listing('events',start='2026-10-01',end='2026-11-01'))
    assert len(calls)==1


@pytest.mark.parametrize('provider,selected',[('google',['mail','calendar','docs']),('microsoft',['mail','calendar'])])
def test_oauth_pkce_session_binding_and_private_tokens(client,monkeypatch,provider,selected):
    import spur.api as api
    body={'client_id':'oauth-app','client_secret':'app-secret','features':selected}
    assert client.put('/office/'+provider+'/app',json=body).status_code==403
    assert client.put('/office/'+provider+'/app',headers=client.csrf,json=body).status_code==200
    response=client.post('/office/'+provider+'/connect',headers=client.csrf)
    params=parse_qs(urlparse(response.json()['authorization_url']).query)
    assert params['code_challenge_method']==['S256'] and 'app-secret' not in response.text
    assert 'Mail.Send' not in params['scope'][0]
    original=httpx.AsyncClient
    def handler(request):
        if request.url.path.endswith('/token'):
            values=parse_qs(request.content.decode());assert values['code_verifier'] and values['client_secret']==['app-secret']
            return httpx.Response(200,json={'access_token':'access-secret','refresh_token':'refresh-secret','scope':' '.join(scopes(provider,selected)),'expires_in':3600})
        assert request.headers['authorization']=='Bearer access-secret'
        return httpx.Response(200,json={'sub':'google-user','email':'creator@example.com'} if provider=='google' else {'id':'ms-user','mail':'creator@example.com'})
    monkeypatch.setattr(api.httpx,'AsyncClient',lambda **kwargs:original(transport=httpx.MockTransport(handler),**kwargs))
    cookie=client.cookies.get(COOKIE);client.cookies.delete(COOKIE)
    response=client.get('/office/'+provider+'/callback',params={'code':'authorization-code','state':params['state'][0]})
    assert response.status_code==200 and 'social-return.js' in response.text
    client.cookies.set(COOKIE,cookie,domain='testserver.local',path='/')
    result=client.get('/office/connections').json()
    connected=next(c for c in result['connections'] if c['provider']==provider)
    assert connected['status']=='connected' and connected['connected_features']==sorted(selected)
    assert 'access-secret' not in json.dumps(result) and 'app-secret' not in json.dumps(result)
    with client.app.state.store.connect() as db:assert b'access-secret' not in bytes(db.execute('SELECT tokens FROM office_connections').fetchone()[0])
    assert client.get('/office/'+provider+'/callback',params={'code':'authorization-code','state':params['state'][0]}).status_code==400


def test_reconnect_on_changed_setup_and_scope_limits(tmp_path):
    store=Store(str(tmp_path/'permissions.db'));repo=prepare(store,features=['mail'])
    with pytest.raises(OfficeError,match='not granted'):
        run(store,'google',lambda r:None,lambda session:session.listing('documents'))
    repo.save_app('google',OfficeAppInput(client_id='different-client',client_secret='new-secret',features=['docs']),'http://testserver/office/google/callback')
    assert repo.public('google')['status']=='reconnect'
    with pytest.raises(OfficeError,match='settings changed'):
        run(store,'google',lambda r:None,lambda session:session.listing('documents'))


def test_token_refresh_rotates_secret_and_keeps_tokens_private(tmp_path):
    store=Store(str(tmp_path/'refresh.db'));repo=prepare(store,'microsoft',expires=-1)
    def handler(request):
        assert 'refresh-secret' not in str(request.url)
        return httpx.Response(200,json={'access_token':'new-access','refresh_token':'rotated-refresh','expires_in':3600})
    run(store,'microsoft',handler,lambda session:session.ready('mail'))
    assert repo.connection('microsoft')['tokens']['refresh_token']=='rotated-refresh'
    assert 'new-access' not in json.dumps(repo.public('microsoft'))


def test_gmail_read_create_update_and_deduplicated_save(tmp_path):
    store=Store(str(tmp_path/'gmail.db'));prepare(store);current=raw();requests=[]
    def handler(request):
        nonlocal current
        requests.append(request)
        assert request.headers['authorization']=='Bearer access-secret' and 'access_token' not in request.url.params
        if request.method=='GET':return httpx.Response(200,json={'id':'draft-1','message':{'raw':current}})
        body=json.loads(request.content);current=body['message']['raw'];mime=BytesParser(policy=policy.default).parsebytes(base64.urlsafe_b64decode(current))
        assert str(mime['Subject'])=='Updated subject' and mime.get_content().strip()=='Updated copy'
        assert str(mime['To'])=='person@example.com'
        assert '/send' not in request.url.path
        return httpx.Response(200,json={'id':'draft-1'})
    detail=run(store,'google',handler,lambda s:s.detail('drafts','draft-1'))
    assert detail['to']=='person@example.com' and detail['editable']
    value=write(target_id='draft-1',version=detail['version'],title='Updated subject',body='Updated copy',to=['person@example.com'])
    result=run(store,'google',handler,lambda s:s.write(value));before=len(requests)
    assert result['id']=='draft-1' and 'not been sent' in result['message']
    assert run(store,'google',handler,lambda s:s.write(value))==result and len(requests)==before
    current=raw('Provider edited it')
    with pytest.raises(OfficeError,match='changed on the provider'):
        run(store,'google',handler,lambda s:s.write(write(target_id='draft-1',version=detail['version'],body='Overwrite')))


def test_rich_and_long_gmail_drafts_cannot_be_accidentally_flattened(tmp_path):
    store=Store(str(tmp_path/'rich.db'));prepare(store)
    for content in (raw(html=True),raw(body='x'*60001)):
        handler=lambda request:httpx.Response(200,json={'message':{'raw':content}})
        item=run(store,'google',handler,lambda s:s.detail('drafts','draft-1'))
        assert not item['editable']


def test_outlook_draft_edit_preserves_unrelated_properties_and_uses_etag(tmp_path):
    store=Store(str(tmp_path/'outlook.db'));prepare(store,'microsoft');seen=[]
    draft={'id':'draft-1','isDraft':True,'subject':'Old','body':{'contentType':'text','content':'Old text'},'@odata.etag':'W/"version1"','hasAttachments':True}
    def handler(request):
        seen.append(request)
        if request.method=='GET':return httpx.Response(200,json=draft)
        assert request.method=='PATCH' and request.headers['if-match']=='W/"version1"'
        payload=json.loads(request.content);assert 'attachments' not in payload and payload['body']['contentType']=='Text'
        assert request.url.path.endswith('/messages/draft-1')
        return httpx.Response(200,json={'id':'draft-1'})
    value=write(target_id='draft-1',version='W/"version1"',title='New title',body='New copy')
    assert run(store,'microsoft',handler,lambda s:s.write(value))['id']=='draft-1'
    draft['isDraft']=False
    with pytest.raises(OfficeError,match='read-only'):
        run(store,'microsoft',handler,lambda s:s.write(write(target_id='draft-1',version='W/"version1"',body='Cannot edit received email')))


@pytest.mark.parametrize('provider',['google','microsoft'])
def test_calendar_edits_validate_dates_guests_and_revisions(tmp_path,provider):
    store=Store(str(tmp_path/(provider+'.db')));prepare(store,provider)
    event={'id':'event-1','summary':'Film Paris','etag':'"revision"','organizer':{'self':True},'start':{'dateTime':'2026-11-01T09:00:00Z'},'end':{'dateTime':'2026-11-01T10:00:00Z'}} if provider=='google' else {
        'id':'event-1','subject':'Film Paris','@odata.etag':'W/"revision"','isOrganizer':True,'type':'singleInstance','start':{'dateTime':'2026-11-01T09:00:00','timeZone':'UTC'},'end':{'dateTime':'2026-11-01T10:00:00','timeZone':'UTC'}}
    def handler(request):
        if request.method=='GET':return httpx.Response(200,json=event)
        assert request.headers['if-match']==event.get('etag',event.get('@odata.etag'))
        payload=json.loads(request.content);assert 'attendees' not in payload
        if provider=='google':assert request.url.params['sendUpdates']=='none'
        return httpx.Response(200,json={'id':'event-1'})
    values={'request_id':'calendar-save','resource':'events','target_id':'event-1','version':event.get('etag',event.get('@odata.etag')),
            'title':'Film Paris revised','start':'2026-11-01T09:00:00Z','end':'2026-11-01T11:00:00Z'}
    assert run(store,provider,handler,lambda s:s.write(OfficeWrite(**values)))['id']=='event-1'
    event['attendees']=[{'email':'guest@example.com'}]
    values['request_id']='calendar-guests'
    with pytest.raises(OfficeError,match='Meetings with guests'):
        run(store,provider,handler,lambda s:s.write(OfficeWrite(**values)))
    values.update(request_id='calendar-invalid',end='2026-10-01T00:00:00Z')
    with pytest.raises(OfficeError,match='valid start/end'):
        run(store,provider,handler,lambda s:s.write(OfficeWrite(**values)))


def test_google_docs_tabs_append_replace_and_revision_control(tmp_path):
    store=Store(str(tmp_path/'docs.db'));prepare(store);seen=[]
    document={'documentId':'doc-1','title':'Paris script','revisionId':'revision-1','tabs':[{'tabProperties':{'tabId':'tab-1','title':'Main'},'documentTab':{'body':{'content':[{'paragraph':{'elements':[{'textRun':{'content':'Old script\n'}}]}}]}}}]}
    def handler(request):
        seen.append(request)
        if request.method=='GET':assert request.url.params['includeTabsContent']=='true';return httpx.Response(200,json=document)
        body=json.loads(request.content);assert body['writeControl']=={'requiredRevisionId':'revision-1'}
        if 'insertText' in body['requests'][0]:assert body['requests'][0]['insertText']['endOfSegmentLocation']=={'tabId':'tab-1'}
        else:assert body['requests'][0]['replaceAllText']['tabsCriteria']=={'tabIds':['tab-1']}
        return httpx.Response(200,json={'documentId':'doc-1'})
    doc=run(store,'google',handler,lambda s:s.detail('documents','doc-1'))
    assert doc['tabs'][0]['text']=='Old script\n'
    for mode in ('append','replace'):
        value=OfficeWrite(request_id='document-'+mode,resource='documents',target_id='doc-1',version='revision-1',tab_id='tab-1',mode=mode,find='Old script',body='New text')
        assert run(store,'google',handler,lambda s:s.write(value))['id']=='doc-1'
    recent=run(store,'google',handler,lambda s:s.listing('documents'))
    assert recent[0]['title']=='Paris script'
    document['revisionId']='revision-2'
    with pytest.raises(OfficeError,match='changed on the provider'):
        run(store,'google',handler,lambda s:s.write(OfficeWrite(request_id='document-stale',resource='documents',target_id='doc-1',version='revision-1',body='Stale')))


def test_new_document_partial_failure_returns_created_link_without_duplicate(tmp_path):
    store=Store(str(tmp_path/'partial.db'));prepare(store);created=[]
    def handler(request):
        if request.method=='POST':created.append(1);return httpx.Response(200,json={'documentId':'new-doc'})
        return httpx.Response(503,json={'error':'Temporary problem access-secret'})
    value=OfficeWrite(request_id='create-new-doc',resource='documents',title='New script',body='Initial text')
    result=run(store,'google',handler,lambda s:s.write(value))
    assert result['partial'] and result['id']=='new-doc' and 'access-secret' not in json.dumps(result)
    assert run(store,'google',handler,lambda s:s.write(value))==result and len(created)==1


def test_failed_write_cannot_be_replayed_automatically(tmp_path):
    store=Store(str(tmp_path/'timeout.db'));prepare(store);attempts=[]
    def handler(request):attempts.append(1);raise httpx.ReadTimeout('access-secret',request=request)
    value=write(title='Uncertain draft',body='A message')
    with pytest.raises(OfficeError,match='could not be completed'):
        run(store,'google',handler,lambda s:s.write(value))
    with pytest.raises(OfficeError,match='outcome is uncertain'):
        run(store,'google',handler,lambda s:s.write(value))
    assert len(attempts)==1


def test_office_is_private_and_writes_require_csrf(client):
    prepare(client.app.state.store)
    result=client.get('/office/connections').json();assert result['connections'][0]['email']=='creator@example.com'
    assert client.post('/office/google/actions',json={'request_id':'private-write','resource':'drafts','body':'Do not save'}).status_code==403
    client.post('/auth/logout',headers=client.csrf)
    response=client.post('/auth/register',headers={'X-Spur-Auth':'1'},json={'username':'second','display_name':'Second','password':'test-passphrase-long'})
    client.csrf={'X-CSRF-Token':response.json()['csrf_token']}
    assert all(c['status']=='disconnected' for c in client.get('/office/connections').json()['connections'])
    assert client.get('/office/google/items/drafts').status_code==409
    assert 'creator@example.com' not in client.get('/office/connections').text
    client.post('/auth/logout',headers=client.csrf)
    assert client.get('/office/connections').status_code==401


def test_no_arbitrary_provider_url_or_email_header_injection(client):
    invalid={'request_id':'invalid-address','resource':'drafts','to':['good@example.com\r\nBcc: bad@example.com']}
    assert client.post('/office/google/actions',headers=client.csrf,json=invalid).status_code==422
    assert client.get('/office/other-provider/items/mail').status_code==422
    assert client.post('/office/google/actions',headers=client.csrf,json={'request_id':'invalid-action','resource':'send'}).status_code==422


def test_api_can_read_and_save_real_shaped_gmail_drafts_without_serializing_mime(client,monkeypatch):
    import spur.api as api
    prepare(client.app.state.store);original=httpx.AsyncClient;current=raw()
    def handler(request):
        nonlocal current
        if request.method=='GET':return httpx.Response(200,json={'id':'draft-1','message':{'raw':current}})
        current=json.loads(request.content)['message']['raw']
        return httpx.Response(200,json={'id':'draft-1'})
    monkeypatch.setattr(api.httpx,'AsyncClient',lambda **kwargs:original(transport=httpx.MockTransport(handler),**kwargs))
    draft=client.get('/office/google/items/drafts/draft-1')
    assert draft.status_code==200 and '_mime' not in draft.json()
    value={'request_id':'http-draft-save','resource':'drafts','target_id':'draft-1','version':draft.json()['version'],'title':'New HTTP subject','body':'New HTTP body'}
    result=client.post('/office/google/actions',headers=client.csrf,json=value)
    assert result.status_code==200 and result.json()['id']=='draft-1'
    assert client.get('/office/google/items/drafts/draft-1').json()['title']=='New HTTP subject'


def test_inbox_content_is_safe_text_and_never_saved_in_sqlite(tmp_path):
    store=Store(str(tmp_path/'inbox.db'));prepare(store)
    html='<div>Private inbox content<script>stealTokens()</script><img src="https://tracker.test/pixel"></div>'
    value={'id':'message-1','payload':{'mimeType':'text/html','body':{'data':base64.urlsafe_b64encode(html.encode()).decode()},'headers':[{'name':'Subject','value':'Inbox subject'}]}}
    result=run(store,'google',lambda r:httpx.Response(200,json=value),lambda s:s.detail('mail','message-1'))
    assert 'Private inbox content' in result['body'] and 'stealTokens' not in result['body'] and '<img' not in result['body']
    assert not result['editable']
    with store.connect() as db:
        assert db.execute('SELECT count(*) FROM office_actions').fetchone()[0]==0
        assert db.execute('SELECT count(*) FROM knowledge').fetchone()[0]==0


def test_replayed_action_cannot_cross_connected_accounts(tmp_path):
    store=Store(str(tmp_path/'account-switch.db'));repo=prepare(store)
    value=write(body='Draft in first account')
    handler=lambda r:httpx.Response(200,json={'id':'draft-1'})
    run(store,'google',handler,lambda s:s.write(value))
    repo.connect('google',{'access_token':'second-token'}, {'sub':'another-user','email':'second@example.com'},repo.app('google'))
    with pytest.raises(OfficeError,match='different edit'):
        run(store,'google',handler,lambda s:s.write(value))


def test_resource_ids_with_encoded_slashes_stay_inside_provider_path(client,monkeypatch):
    import spur.api as api
    prepare(client.app.state.store,'microsoft');original=httpx.AsyncClient
    def handler(request):
        assert request.url.raw_path==b'/v1.0/me/messages/id%2Fwith%2Bsymbols%3D%3D'
        return httpx.Response(200,json={'id':'id/with+symbols==','subject':'Draft with a provider ID','isDraft':True,'body':{'contentType':'text','content':'A draft'}})
    monkeypatch.setattr(api.httpx,'AsyncClient',lambda **kwargs:original(transport=httpx.MockTransport(handler),**kwargs))
    response=client.get('/office/microsoft/items/drafts/id%2Fwith%2Bsymbols%3D%3D')
    assert response.status_code==200 and response.json()['id']=='id/with+symbols=='


def test_dot_segment_cannot_change_provider_endpoint(tmp_path):
    store=Store(str(tmp_path/'dot-segment.db'));prepare(store)
    with pytest.raises(OfficeError,match='Invalid provider resource'):
        run(store,'google',lambda r:None,lambda s:s.detail('drafts','..'))
