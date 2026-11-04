"""Account-scoped Gmail, Outlook, Calendar and Google Docs integration."""
import asyncio
import base64
import hashlib
import json
import re
import secrets
import time
import uuid
from datetime import date, datetime, timedelta, timezone
from email import policy
from email.message import EmailMessage
from email.parser import BytesParser
from email.utils import getaddresses
from html.parser import HTMLParser
from typing import Literal
from urllib.parse import quote, urlencode, urlparse

import httpx
from pydantic import BaseModel, ConfigDict, Field, field_validator
from spur.social import seal, unseal, digest, consume_oauth, SocialError

SCHEMA = """
CREATE TABLE IF NOT EXISTS office_apps (
 provider TEXT PRIMARY KEY, client_id TEXT NOT NULL, secret BLOB NOT NULL,
 redirect_uri TEXT NOT NULL, tenant TEXT NOT NULL, features TEXT NOT NULL, updated REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS office_connections (
 provider TEXT PRIMARY KEY, tokens BLOB NOT NULL, account_id TEXT NOT NULL, email TEXT NOT NULL,
 name TEXT NOT NULL, expires REAL NOT NULL, features TEXT NOT NULL, fingerprint TEXT NOT NULL,
 generation TEXT NOT NULL, updated REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS office_actions (
 request_id TEXT PRIMARY KEY, provider TEXT NOT NULL, operation TEXT NOT NULL, payload_hash TEXT NOT NULL,
 status TEXT NOT NULL, result TEXT NOT NULL, created REAL NOT NULL, updated REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS office_documents (
 account_id TEXT NOT NULL, document_id TEXT NOT NULL, title TEXT NOT NULL, updated REAL NOT NULL,
 PRIMARY KEY(account_id,document_id)
);
"""
FEATURES={'google':['mail','calendar','docs'],'microsoft':['mail','calendar']}
SCOPES={
 'google':{'identity':['https://www.googleapis.com/auth/userinfo.email'],
           'mail':['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.compose'],
           'calendar':['https://www.googleapis.com/auth/calendar.events.owned'],
           'docs':['https://www.googleapis.com/auth/documents']},
 'microsoft':{'identity':['offline_access','User.Read'],'mail':['Mail.ReadWrite'],'calendar':['Calendars.ReadWrite']}}
AUTH={'google':'https://accounts.google.com/o/oauth2/v2/auth','microsoft':'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize'}
TOKEN={'google':'https://oauth2.googleapis.com/token','microsoft':'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token'}
GMAIL='https://gmail.googleapis.com/gmail/v1/users/me'
GRAPH='https://graph.microsoft.com/v1.0/me'
CAL='https://www.googleapis.com/calendar/v3/calendars/primary/events'
DOCS='https://docs.googleapis.com/v1/documents'
refresh_locks={}


class OfficeError(ValueError):
    def __init__(self,message,status=422):super().__init__(message);self.status=status


class OfficeAppInput(BaseModel):
    model_config=ConfigDict(extra='forbid',str_strip_whitespace=True)
    client_id:str=Field(min_length=1,max_length=300,pattern=r'^[A-Za-z0-9_.-]+$')
    client_secret:str=Field(default='',max_length=1000,pattern=r'^[^\r\n]*$')
    tenant:str=Field(default='common',pattern=r'^(common|consumers|organizations|[a-fA-F0-9-]{36})$')
    features:list[Literal['mail','calendar','docs']]=Field(min_length=1,max_length=3)


class OfficeWrite(BaseModel):
    model_config=ConfigDict(extra='forbid')
    request_id:str=Field(min_length=8,max_length=100,pattern=r'^[A-Za-z0-9_-]+$')
    resource:Literal['drafts','events','documents']
    target_id:str=Field(default='',max_length=300)
    title:str=Field(default='',max_length=300)
    body:str=Field(default='',max_length=60000)
    to:list[str]=Field(default_factory=list,max_length=30)
    cc:list[str]=Field(default_factory=list,max_length=30)
    bcc:list[str]=Field(default_factory=list,max_length=30)
    version:str=Field(default='',max_length=500)
    start:str=Field(default='',max_length=50)
    end:str=Field(default='',max_length=50)
    all_day:bool=False
    location:str=Field(default='',max_length=1000)
    mode:Literal['append','replace']='append'
    find:str=Field(default='',max_length=1000)
    tab_id:str=Field(default='',max_length=200)

    @field_validator('to','cc','bcc')
    @classmethod
    def emails(cls,values):
        if any(len(v)>254 or not re.fullmatch(r'[^\s<>@,;\r\n]+@[^\s<>@,;\r\n]+\.[^\s<>@,;\r\n]+',v) for v in values):
            raise ValueError('Enter email addresses separated by commas, without display names')
        return values

    @field_validator('title')
    @classmethod
    def single_line(cls,value):
        if '\r' in value or '\n' in value:raise ValueError('Title or subject must be one line')
        return value.strip()


def scopes(provider,features):return SCOPES[provider]['identity']+list(dict.fromkeys(s for f in features for s in SCOPES[provider][f]))
def fingerprint(app):return digest(json.dumps([app['client_id'],app['redirect_uri'],app['tenant'],sorted(app['features'])]))
def ident(value):
    if not value or value in ('.','..') or len(value)>300 or any(ord(c)<32 for c in value):raise OfficeError('Invalid provider resource ID')
    return quote(value,safe='')


class OfficeStore:
    def __init__(self,store):
        self.store=store
        self.apps=getattr(store,'platform_store',store)

    def app(self,provider):
        with self.apps.connect() as db:row=db.execute('SELECT * FROM office_apps WHERE provider=?',(provider,)).fetchone()
        return {**dict(row),'features':json.loads(row['features']),'client_secret':unseal(row['secret'])['value']} if row else None

    def save_app(self,provider,body,redirect):
        if any(f not in FEATURES[provider] for f in body.features):raise OfficeError('This provider does not support one of the selected services')
        old=self.app(provider);secret=body.client_secret
        if not secret and old and old['client_id']==body.client_id:secret=old['client_secret']
        if not secret:raise OfficeError('Enter the OAuth application client secret, not your account password')
        with self.apps.connect() as db:
            db.execute('INSERT OR REPLACE INTO office_apps(provider,client_id,secret,redirect_uri,tenant,features,updated) VALUES(?,?,?,?,?,?,?)',
                       (provider,body.client_id,seal({'value':secret}),redirect,body.tenant,json.dumps(sorted(set(body.features))),time.time()))

    def connection(self,provider):
        with self.store.connect() as db:row=db.execute('SELECT * FROM office_connections WHERE provider=?',(provider,)).fetchone()
        return {**dict(row),'tokens':unseal(row['tokens']),'features':json.loads(row['features'])} if row else None

    def public(self,provider):
        app=self.app(provider);conn=self.connection(provider)
        return {'provider':provider,'configured':bool(app),'client_id':app['client_id'] if app else '',
                'tenant':app['tenant'] if app else 'common','has_client_secret':bool(app),
                'features':app['features'] if app else FEATURES[provider],
                'connected_features':conn['features'] if conn else [],
                'status':'reconnect' if conn and (not app or conn['fingerprint']!=fingerprint(app)) else 'connected' if conn else 'disconnected',
                'account_name':conn['name'] if conn else '', 'email':conn['email'] if conn else '',
                'callback_url':app['redirect_uri'] if app else '',
                'expires':conn['expires'] if conn else None,'scopes':scopes(provider,app['features'] if app else FEATURES[provider])}

    def connect(self,provider,tokens,profile,app):
        wanted=app['features'];granted=tokens.get('scope')
        if granted:
            normalized={s.removeprefix('https://graph.microsoft.com/').lower() for s in granted.split()}
            wanted=[f for f in wanted if all(s.lower() in normalized for s in SCOPES[provider][f])]
        if not wanted:raise OfficeError('No selected service permissions were granted. Reconnect and approve the services you want.')
        account_id=str((profile.get('sub') if provider=='google' else profile.get('id')) or '')
        if not account_id or len(account_id)>300:raise OfficeError('The provider did not return an account identity')
        email=profile.get('email','') if provider=='google' else profile.get('mail') or profile.get('userPrincipalName','')
        name=profile.get('name') or profile.get('displayName') or email or account_id
        with self.store.connect() as db:
            db.execute('INSERT OR REPLACE INTO office_connections(provider,tokens,account_id,email,name,expires,features,fingerprint,generation,updated) VALUES(?,?,?,?,?,?,?,?,?,?)',
                       (provider,seal(tokens),account_id,email,name,time.time()+float(tokens.get('expires_in',3600)),json.dumps(wanted),fingerprint(app),uuid.uuid4().hex,time.time()))

    def disconnect(self,provider):
        with self.store.connect() as db:db.execute('DELETE FROM office_connections WHERE provider=?',(provider,))

    def remember_doc(self,account_id,document):
        with self.store.connect() as db:
            db.execute('INSERT OR REPLACE INTO office_documents(account_id,document_id,title,updated) VALUES(?,?,?,?)',
                       (account_id,document['id'],document['title'],time.time()))


def begin_office_oauth(root,workspace,user_id,session_token,provider):
    app=OfficeStore(workspace).app(provider)
    if not app:raise OfficeError('Save the OAuth application setup first')
    state=secrets.token_urlsafe(32);ticket=secrets.token_urlsafe(32);verifier=secrets.token_urlsafe(48)
    challenge=base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
    payload={'verifier':verifier,'fingerprint':fingerprint(app)}
    with root.connect() as db:
        db.execute('DELETE FROM social_oauth_tickets WHERE expires<?',(time.time(),))
        db.execute('INSERT INTO social_oauth_tickets VALUES(?,?,?,?,?,?,?)',
                   (digest(ticket),digest(state),user_id,digest(session_token),'office:'+provider,seal(payload),time.time()+600))
    params={'client_id':app['client_id'],'redirect_uri':app['redirect_uri'],'response_type':'code','state':state,
            'scope':' '.join(scopes(provider,app['features'])),'code_challenge':challenge,'code_challenge_method':'S256'}
    if provider=='google':params.update(access_type='offline',prompt='consent')
    else:params.update(response_mode='query',prompt='select_account')
    return {'ticket':ticket,'url':AUTH[provider].format(tenant=app['tenant'])+'?'+urlencode(params)}


async def request_json(client,method,url,**kwargs):
    try:
        response=await client.request(method,url,timeout=30,follow_redirects=False,**kwargs)
        if response.status_code in (409,412):raise OfficeError('This item changed on the provider. Reopen it before saving.',409)
        if response.status_code==404:raise OfficeError('Item not found, or this account does not have access.',404)
        if response.status_code in (401,403):raise OfficeError('Provider denied access. Check enabled APIs, granted services and app consent, then reconnect if needed.',403)
        if not response.is_success:raise OfficeError(f'Provider request failed (HTTP {response.status_code}). Refresh the provider list before retrying.',502)
        if response.status_code==204:return {}
        data=response.json()
        if not isinstance(data,dict) or 'error' in data:raise OfficeError('Provider returned an invalid response',502)
        return data
    except (httpx.HTTPError,json.JSONDecodeError):raise OfficeError('Provider request could not be completed. Refresh the provider list before retrying.',502) from None


async def exchange_office_code(workspace,provider,code,payload,client):
    repo=OfficeStore(workspace);app=repo.app(provider)
    if not app or fingerprint(app)!=payload['fingerprint']:raise OfficeError('App setup changed during authorization. Start Connect again.')
    body={'grant_type':'authorization_code','client_id':app['client_id'],'client_secret':app['client_secret'],
          'redirect_uri':app['redirect_uri'],'code':code,'code_verifier':payload['verifier']}
    tokens=await request_json(client,'POST',TOKEN[provider].format(tenant=app['tenant']),data=body)
    if not tokens.get('access_token'):raise OfficeError('Provider did not return an access token')
    url='https://www.googleapis.com/oauth2/v3/userinfo' if provider=='google' else GRAPH
    profile=await request_json(client,'GET',url,headers={'Authorization':'Bearer '+tokens['access_token']})
    repo.connect(provider,tokens,profile,app)


async def access_token(repo,provider,client):
    key=(str(repo.store.path),provider)
    async with refresh_locks.setdefault(key,asyncio.Lock()):
        conn=repo.connection(provider);app=repo.app(provider)
        if not conn or not app:raise OfficeError('Connect this account first',409)
        if conn['fingerprint']!=fingerprint(app):raise OfficeError('Connection settings changed. Reconnect this account.',409)
        if conn['expires']>time.time()+90:return conn,conn['tokens']['access_token']
        if not conn['tokens'].get('refresh_token'):raise OfficeError('Authorization expired. Reconnect this account.',409)
        tokens=await request_json(client,'POST',TOKEN[provider].format(tenant=app['tenant']),data={
            'grant_type':'refresh_token','client_id':app['client_id'],'client_secret':app['client_secret'],'refresh_token':conn['tokens']['refresh_token']})
        if not tokens.get('access_token'):raise OfficeError('Refresh failed. Reconnect this account.')
        tokens={**conn['tokens'],**tokens}
        with repo.store.connect() as db:
            saved=db.execute('UPDATE office_connections SET tokens=?,expires=? WHERE provider=? AND generation=?',
                            (seal(tokens),time.time()+float(tokens.get('expires_in',3600)),provider,conn['generation']))
            if not saved.rowcount:raise OfficeError('Connection changed while refreshing. Try opening the account again.',409)
        return conn,tokens['access_token']


class TextHTML(HTMLParser):
    def __init__(self):super().__init__();self.output=[];self.skip=0
    def handle_starttag(self,tag,attrs):
        if tag in ('script','style'):self.skip+=1
        if tag in ('p','br','div','li'):self.output.append('\n')
    def handle_endtag(self,tag):
        if tag in ('script','style'):self.skip=max(0,self.skip-1)
    def handle_data(self,data):
        if not self.skip:self.output.append(data)


def plain(value):
    parser=TextHTML();parser.feed(value or '')
    return ''.join(parser.output)[:60000]


def decode64(value):
    if len(value)>8*1024*1024:raise OfficeError('This email is too large for the text editor. Open it in your mail provider.')
    try:return base64.urlsafe_b64decode(value+'='*(-len(value)%4))
    except (ValueError,TypeError):raise OfficeError('The provider returned invalid email content') from None


def gmail_summary(item,draft_id=None):
    headers={h['name'].lower():h['value'] for h in item.get('payload',{}).get('headers',[])}
    return {'id':draft_id or item['id'],'title':headers.get('subject','(No subject)'),
            'from':headers.get('from',''),'to':headers.get('to',''),'preview':item.get('snippet','')[:300]}


def doc_tabs(document):
    tabs=[]
    def walk(items):
        for tab in items:
            prop=tab.get('tabProperties',{});body=tab.get('documentTab',{}).get('body',{})
            tabs.append({'id':prop.get('tabId',''),'title':prop.get('title','Document'),'content':body.get('content',[])})
            walk(tab.get('childTabs',[]))
    walk(document.get('tabs',[]))
    return tabs or [{'id':'','title':'Document','content':document.get('body',{}).get('content',[])}]


def doc_text(elements):
    result=[]
    for element in elements:
        if 'paragraph' in element:result.extend(e.get('textRun',{}).get('content','') for e in element['paragraph'].get('elements',[]))
        for row in element.get('table',{}).get('tableRows',[]):
            result.extend(doc_text(cell.get('content',[])) for cell in row.get('tableCells',[]))
    return ''.join(result)[:60000]


class OfficeSession:
    def __init__(self,store,provider,client):self.repo=OfficeStore(store);self.provider=provider;self.client=client;self.conn=None;self.headers={}

    async def ready(self,feature):
        if not self.conn:
            self.conn,token=await access_token(self.repo,self.provider,self.client)
            self.headers={'Authorization':'Bearer '+token}
        if feature not in self.conn['features']:raise OfficeError('This service was not granted. Update app setup and reconnect.',403)
        return self

    async def request(self,method,url,**kwargs):
        headers={**self.headers,**kwargs.pop('headers',{})}
        return await request_json(self.client,method,url,headers=headers,**kwargs)

    async def listing(self,resource,query='',start='',end=''):
        await self.ready({'mail':'mail','drafts':'mail','events':'calendar','documents':'docs'}[resource])
        if resource=='documents':
            if self.provider!='google':raise OfficeError('Google Docs requires a Google connection')
            with self.repo.store.connect() as db:
                return [dict(r,id=r['document_id']) for r in db.execute('SELECT document_id,title,updated FROM office_documents WHERE account_id=? ORDER BY updated DESC LIMIT 30',(self.conn['account_id'],))]
        if resource=='events':
            try:
                first=date.fromisoformat(start);last=date.fromisoformat(end)
                if not 0<(last-first).days<=93:raise ValueError()
            except ValueError:raise OfficeError('Choose a valid calendar range of 1–93 days')
            if self.provider=='google':
                params={'timeMin':start+'T00:00:00Z','timeMax':end+'T00:00:00Z','singleEvents':'true','orderBy':'startTime','maxResults':250}
                result=[]
                for _ in range(20):
                    data=await self.request('GET',CAL,params=params)
                    result.extend(self.event(r) for r in data.get('items',[]) if r.get('status')!='cancelled')
                    token=data.get('nextPageToken')
                    if not token:return result
                    params={**params,'pageToken':token}
                raise OfficeError('Too many calendar events in this range. Choose a shorter range.')
            url=GRAPH+'/calendarView'
            params={'startDateTime':start+'T00:00:00Z','endDateTime':end+'T00:00:00Z','$top':250,'$orderby':'start/dateTime'}
            result=[]
            for _ in range(20):
                data=await self.request('GET',url,params=params,headers={'Prefer':'outlook.timezone="UTC"'})
                result.extend(self.event(r) for r in data.get('value',[]) if not r.get('isCancelled'))
                url=data.get('@odata.nextLink')
                if not url:return result
                parsed=urlparse(url)
                if parsed.scheme!='https' or parsed.netloc!='graph.microsoft.com' or parsed.path!=urlparse(GRAPH+'/calendarView').path:
                    raise OfficeError('Calendar provider returned an invalid continuation link.')
                params=None
            raise OfficeError('Too many calendar events in this range. Choose a shorter range.')
        if self.provider=='google':
            data=await self.request('GET',GMAIL+'/'+('drafts' if resource=='drafts' else 'messages'),params={'maxResults':20,**({'labelIds':'INBOX','q':query} if resource=='mail' else {})})
            semaphore=asyncio.Semaphore(5)
            async def summary(row):
                async with semaphore:
                    result=await self.request('GET',GMAIL+'/'+resource.replace('mail','messages')+'/'+ident(row['id']),params={'format':'metadata'})
                    return gmail_summary(result['message'],row['id']) if resource=='drafts' else gmail_summary(result)
            return await asyncio.gather(*(summary(row) for row in data.get('drafts' if resource=='drafts' else 'messages',[])))
        folder='drafts' if resource=='drafts' else 'inbox'
        data=await self.request('GET',GRAPH+'/mailFolders/'+folder+'/messages',params={'$top':20,'$orderby':'lastModifiedDateTime desc','$select':'id,subject,from,toRecipients,bodyPreview,isDraft,lastModifiedDateTime'})
        return [{'id':r['id'],'title':r.get('subject','(No subject)'),'from':r.get('from',{}).get('emailAddress',{}).get('address',''),
                 'preview':r.get('bodyPreview','')[:300]} for r in data.get('value',[]) if not query or query.lower() in json.dumps(r).lower()]

    async def detail(self,resource,object_id):
        await self.ready({'mail':'mail','drafts':'mail','events':'calendar','documents':'docs'}[resource])
        key=ident(object_id)
        if resource=='documents':
            if self.provider!='google':raise OfficeError('Google Docs requires a Google connection')
            data=await self.request('GET',DOCS+'/'+key,params={'includeTabsContent':'true'})
            result={'id':data['documentId'],'title':data.get('title','Untitled document'),'version':data.get('revisionId',''),
                    'tabs':[{'id':t['id'],'title':t['title'],'text':doc_text(t['content'])} for t in doc_tabs(data)],
                    'url':'https://docs.google.com/document/d/'+quote(data['documentId'],safe='')+'/edit'}
            self.repo.remember_doc(self.conn['account_id'],result);return result
        if resource=='events':
            data=await self.request('GET',CAL+'/'+key if self.provider=='google' else GRAPH+'/events/'+key,**({'headers':{'Prefer':'outlook.timezone="UTC"'}} if self.provider=='microsoft' else {}))
            return self.event(data)
        if self.provider=='google':
            if resource=='drafts':
                data=await self.request('GET',GMAIL+'/drafts/'+key,params={'format':'raw'})
                raw=data['message'].get('raw','');mime=BytesParser(policy=policy.default).parsebytes(decode64(raw))
                editable=not mime.is_multipart() and mime.get_content_type()=='text/plain' and not mime.get('Content-Disposition')
                body=mime.get_body(preferencelist=('plain','html')) if mime.is_multipart() else mime
                content=body.get_content() if body else ''
                if isinstance(content,bytes):content=content.decode('utf-8',errors='replace')
                editable=editable and len(content)<=60000
                return {'id':object_id,'title':str(mime.get('Subject','')),**{label:', '.join(email for _,email in getaddresses(mime.get_all(label,[]))) for label in ('to','cc','bcc')},
                        'body':(plain(content) if body and body.get_content_type()=='text/html' else content)[:60000],
                        'version':digest(raw),'editable':editable,'reason':'' if editable else 'Rich-text, multipart, or long draft: open Gmail to preserve all content and attachments.',
                        'url':'https://mail.google.com/mail/u/'+quote(self.conn['email'],safe='')+'/#drafts','_mime':mime}
            data=await self.request('GET',GMAIL+'/messages/'+key,params={'format':'full'})
            def text(part):
                if part.get('filename'):return ''
                if part.get('mimeType')=='text/plain':return decode64(part.get('body',{}).get('data','')).decode('utf-8',errors='replace')
                children=part.get('parts',[])
                if part.get('mimeType')=='multipart/alternative':
                    preferred=next((p for p in children if p.get('mimeType')=='text/plain'),None)
                    if preferred:return text(preferred)
                content='\n'.join(text(p) for p in children)
                return content or (plain(decode64(part.get('body',{}).get('data','')).decode('utf-8',errors='replace')) if part.get('mimeType')=='text/html' else '')
            return {**gmail_summary(data),'body':text(data.get('payload',{}))[:60000],'editable':False,'url':'https://mail.google.com/mail/u/'+quote(self.conn['email'],safe='')+'/#inbox'}
        data=await self.request('GET',GRAPH+'/messages/'+key,**({'headers':{'Prefer':'outlook.body-content-type="text"'}} if resource=='mail' else {}))
        body=data.get('body',{});editable=bool(data.get('isDraft')) and body.get('contentType','').lower()=='text' and len(body.get('content',''))<=60000
        return {'id':object_id,'title':data.get('subject',''),'body':plain(body.get('content','')) if body.get('contentType','').lower()=='html' else body.get('content','')[:60000],
                **{label:', '.join(r['emailAddress']['address'] for r in data.get(label+'Recipients',[])) for label in ('to','cc','bcc')},
                'version':data.get('@odata.etag') or data.get('changeKey',''),'editable':editable and resource=='drafts',
                'reason':'' if editable else 'Received mail is read-only. Rich-text drafts can be edited in Outlook.',
                'url':data.get('webLink','https://outlook.live.com/mail/'),'has_attachments':bool(data.get('hasAttachments'))}

    def event(self,data):
        google=self.provider=='google';start=data.get('start',{});end=data.get('end',{})
        all_day=bool(start.get('date')) if google else bool(data.get('isAllDay'))
        def stamp(value):
            result=value.get('date') or value.get('dateTime','')
            if not google and not all_day and result and not re.search(r'(Z|[+-]\d\d:\d\d)$',result):result+='Z'
            return result[:10] if all_day else result
        editable=not data.get('attendees') and not data.get('recurrence') and not data.get('recurringEventId') and not data.get('seriesMasterId')
        editable=editable and (data.get('organizer',{}).get('self',True) if google else data.get('isOrganizer',True) and data.get('type','singleInstance')=='singleInstance')
        return {'id':data['id'],'title':data.get('summary' if google else 'subject','(Untitled event)'),
                'body':plain(data.get('description','')) if google else plain(data.get('body',{}).get('content','')),
                'location':data.get('location','') if google else data.get('location',{}).get('displayName',''),
                'start':stamp(start),'end':stamp(end),'all_day':all_day,'version':data.get('etag') or data.get('@odata.etag') or '',
                'editable':bool(editable),'reason':'' if editable else 'Meetings with guests and recurring events open in the provider to preserve invitations and series settings.',
                'url':data.get('htmlLink' if google else 'webLink','')}

    async def write(self,value):
        resource=value.resource
        await self.ready({'drafts':'mail','events':'calendar','documents':'docs'}[resource])
        if resource=='documents' and self.provider!='google':raise OfficeError('Google Docs requires a Google connection')
        if value.target_id and not value.version:raise OfficeError('Open the current item before editing it')
        if resource=='events':
            try:
                first=date.fromisoformat(value.start) if value.all_day else datetime.fromisoformat(value.start.replace('Z','+00:00'))
                last=date.fromisoformat(value.end) if value.all_day else datetime.fromisoformat(value.end.replace('Z','+00:00'))
                if (not value.all_day and (first.tzinfo is None or last.tzinfo is None)) or last<=first:raise ValueError()
            except (ValueError,TypeError):raise OfficeError('Enter valid start/end dates. End must follow start; timed events need a timezone offset.')
        if resource=='documents' and value.mode=='replace' and not value.find:raise OfficeError('Enter the exact text to replace')
        body=value.model_dump();body.pop('request_id');hashed=digest(json.dumps({'account_id':self.conn['account_id'],'edit':body},sort_keys=True))
        dbstore=self.repo.store
        with dbstore.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            old=db.execute('SELECT * FROM office_actions WHERE request_id=?',(value.request_id,)).fetchone()
            if old:
                if old['payload_hash']!=hashed or old['provider']!=self.provider:raise OfficeError('This action ID was already used for a different edit',409)
                if old['status']=='succeeded':return json.loads(old['result'])
                raise OfficeError('This save is already in progress or its outcome is uncertain. Refresh the provider list before starting a new edit.',409)
            db.execute('INSERT INTO office_actions(request_id,provider,operation,payload_hash,status,result,created,updated) VALUES(?,?,?,?,?,?,?,?)',
                       (value.request_id,self.provider,resource,hashed,'applying','{}',time.time(),time.time()))
        try:
            # Re-check account identity after reservation; all URLs below are fixed provider endpoints.
            current=self.repo.connection(self.provider)
            if not current or current['generation']!=self.conn['generation']:raise OfficeError('Connection changed. Open the account again.',409)
            result=await self._write(value)
            with dbstore.connect() as db:db.execute("UPDATE office_actions SET status='succeeded',result=?,updated=? WHERE request_id=?",(json.dumps(result),time.time(),value.request_id))
            return result
        except BaseException:
            with dbstore.connect() as db:db.execute("UPDATE office_actions SET status='uncertain',updated=? WHERE request_id=?",(time.time(),value.request_id))
            raise

    async def _write(self,value):
        resource=value.resource;old=None
        if value.target_id:
            old=await self.detail(resource,value.target_id)
            if old['version']!=value.version:raise OfficeError('This item changed on the provider. Reopen it before saving.',409)
            if resource!='documents' and not old['editable']:raise OfficeError(old['reason'],409)
        if resource=='drafts':
            if self.provider=='google':
                mime=old['_mime'] if old else EmailMessage()
                for key,content in [('Subject',value.title),('To',', '.join(value.to)),('Cc',', '.join(value.cc)),('Bcc',', '.join(value.bcc))]:
                    if key in mime:del mime[key]
                    if content:mime[key]=content
                mime.set_content(value.body)
                raw=base64.urlsafe_b64encode(mime.as_bytes()).decode()
                data=await self.request('PUT' if old else 'POST',GMAIL+'/drafts'+('/'+ident(value.target_id) if old else ''),json={'message':{'raw':raw}})
                return {'id':data['id'],'message':'Draft saved in Gmail. It has not been sent.'}
            payload={'subject':value.title,'body':{'contentType':'Text','content':value.body},
                     **{label+'Recipients':[{'emailAddress':{'address':email}} for email in getattr(value,label)] for label in ('to','cc','bcc')}}
            data=await self.request('PATCH' if old else 'POST',GRAPH+'/messages'+('/'+ident(value.target_id) if old else ''),json=payload,
                                    **({'headers':{'If-Match':value.version}} if old and value.version.startswith(('W/','"')) else {}))
            return {'id':data['id'],'message':'Draft saved in Outlook. It has not been sent.'}
        if resource=='events':
            if self.provider=='google':
                payload={'summary':value.title or 'Untitled event','description':value.body,'location':value.location,
                         'start':{'date' if value.all_day else 'dateTime':value.start},'end':{'date' if value.all_day else 'dateTime':value.end}}
                data=await self.request('PATCH' if old else 'POST',CAL+('/'+ident(value.target_id) if old else ''),params={'sendUpdates':'none'},json=payload,
                                        **({'headers':{'If-Match':value.version}} if old else {}))
            else:
                def stamp(value):return value+'T00:00:00' if len(value)==10 else datetime.fromisoformat(value.replace('Z','+00:00')).astimezone(timezone.utc).isoformat().replace('+00:00','')
                payload={'subject':value.title or 'Untitled event','body':{'contentType':'Text','content':value.body},'location':{'displayName':value.location},
                         'isAllDay':value.all_day,'start':{'dateTime':stamp(value.start),'timeZone':'UTC'},'end':{'dateTime':stamp(value.end),'timeZone':'UTC'}}
                if not old:payload['transactionId']=value.request_id
                data=await self.request('PATCH' if old else 'POST',GRAPH+'/events'+('/'+ident(value.target_id) if old else ''),json=payload,
                                        **({'headers':{'If-Match':value.version}} if old else {}))
            return {'id':data['id'],'message':'Calendar event saved on the provider.'}
        created=False
        if not old:
            data=await self.request('POST',DOCS,json={'title':value.title or 'Untitled document'})
            doc_id=data['documentId'];created=True
            partial={'id':doc_id,'url':'https://docs.google.com/document/d/'+quote(doc_id,safe='')+'/edit',
                     'message':'Document created, but its text could not be confirmed. Open it and refresh before adding text again.','partial':True}
            self.repo.remember_doc(self.conn['account_id'],dict(partial,title=value.title or 'Untitled document'))
            with self.repo.store.connect() as db:db.execute('UPDATE office_actions SET result=? WHERE request_id=?',(json.dumps(partial),value.request_id))
            try:old=await self.detail('documents',doc_id)
            except OfficeError:return partial
        else:doc_id=value.target_id
        tab_id=value.tab_id or old['tabs'][0]['id']
        if tab_id not in {t['id'] for t in old['tabs']}:raise OfficeError('Document tab changed. Reopen the document.',409)
        if value.body or value.mode=='replace':
            change={'insertText':{'endOfSegmentLocation':{'tabId':tab_id} if tab_id else {},'text':value.body}} if value.mode=='append' else {
                'replaceAllText':{'containsText':{'text':value.find,'matchCase':True},'replaceText':value.body,**({'tabsCriteria':{'tabIds':[tab_id]}} if tab_id else {})}}
            try:
                if not old['version']:raise OfficeError('The document did not return a revision ID. Reopen it before editing.')
                await self.request('POST',DOCS+'/'+ident(doc_id)+':batchUpdate',json={'writeControl':{'requiredRevisionId':old['version']},'requests':[change]})
            except OfficeError:
                if not created:raise
                return {'id':doc_id,'url':old['url'],'message':'Document created, but its text could not be confirmed. Open it and refresh before adding text again.','partial':True}
        return {'id':doc_id,'url':old['url'],'message':'Google document saved.'}
