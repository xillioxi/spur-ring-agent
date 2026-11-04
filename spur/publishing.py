"""Official Instagram publishing, with durable checkpoints and no uncertain POST retries."""
import ipaddress
import json
import re
import secrets
import time
import uuid
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from spur.social import SocialStore, SocialError, access_token, request_json, digest
from spur.library import Library

SCHEMA='''CREATE TABLE IF NOT EXISTS instagram_posts(id TEXT PRIMARY KEY, document TEXT NOT NULL, updated REAL NOT NULL);'''
GRANTS='''CREATE TABLE IF NOT EXISTS publishing_media(token_hash TEXT PRIMARY KEY, workspace TEXT NOT NULL, content_id TEXT NOT NULL, asset_id TEXT NOT NULL, expires REAL NOT NULL);'''


def public_url(value):
    try:
        p=urlsplit(value)
        if p.scheme!='https' or not p.hostname or p.username or p.password or p.port not in (None,443) or any(ord(c)<33 for c in value):raise ValueError()
        host=p.hostname.lower()
        if '.' not in host or host.endswith(('.localhost','.local','.internal','.test','.invalid')):raise ValueError()
        try:address=ipaddress.ip_address(host)
        except ValueError:address=None
        if address is not None and not address.is_global:raise ValueError()
        if host in ('localhost','localhost.localdomain'):raise ValueError()
    except ValueError:raise SocialError('Use a publicly accessible HTTPS media URL, without credentials or a local address.') from None
    return value


class PostInput(BaseModel):
    model_config=ConfigDict(extra='forbid')
    caption:str=Field(default='',max_length=2200)
    media_type:str=Field(pattern='^(image|reel)$')
    media_url:str=Field(default='',max_length=4096)
    content_id:str=Field(default='',max_length=32)
    asset_id:str=Field(default='',max_length=32)

    @field_validator('media_url')
    @classmethod
    def validate_url(cls,v):return public_url(v) if v else v

    @model_validator(mode='after')
    def media_source(self):
        if self.media_url and (self.content_id or self.asset_id):raise ValueError('Choose a hosted URL or an uploaded asset, not both.')
        if bool(self.media_url)==bool(self.content_id and self.asset_id):raise ValueError('Choose one hosted URL or one uploaded library asset.')
        return self


class DispatchInput(BaseModel):
    version:int=Field(ge=1)
    account_id:str=Field(min_length=1,max_length=32)
    confirmed:bool=False
    scheduled_at:float|None=None


class PostUpdate(PostInput):
    version:int=Field(ge=1)


class Posts:
    def __init__(self,store,demo=False):
        self.store=store;self.demo=demo;self.mode='demo' if demo else 'instagram'
        if getattr(store,'mock_profile',None) and not demo:raise SocialError('Live publishing is available only in your personal workspace. Local demo publishing is available in creator workspaces.')
        with store.connect() as db:db.executescript(SCHEMA)

    def list(self):
        with self.store.connect() as db:return [json.loads(r[0]) for r in db.execute("SELECT document FROM instagram_posts WHERE COALESCE(json_extract(document,'$.delivery_mode'),'instagram')=? ORDER BY updated DESC LIMIT 100",(self.mode,))]

    def get(self,identifier):
        with self.store.connect() as db:row=db.execute('SELECT document FROM instagram_posts WHERE id=?',(identifier,)).fetchone()
        if not row:raise SocialError('Publishing draft not found in this workspace.')
        post=json.loads(row[0])
        if post.get('delivery_mode','instagram')!=self.mode:raise SocialError('This post belongs to a different publishing mode.')
        return post

    def save(self,post):
        post['updated']=time.time()
        with self.store.connect() as db:db.execute('UPDATE instagram_posts SET document=?,updated=? WHERE id=?',(json.dumps(post),post['updated'],post['id']))

    def validate_asset(self,value):
        if value.asset_id:
            lib=Library(self.store);content=lib.get(value.content_id);asset=lib.asset(value.content_id,value.asset_id)
            if content['kind']!='own':raise SocialError('Choose your own content, rather than a reference creator’s asset.')
            expected=('image/jpeg',) if value.media_type=='image' else ('video/mp4','video/webm') if self.demo else ('video/mp4',)
            if asset['media_type'] not in expected:raise SocialError('Use a JPEG for an image post or MP4 for a live Reel. Local demo Reels also accept WebM.')
            if not lib.asset_path(value.asset_id).is_file():raise SocialError('Uploaded asset is missing.')

    def create(self,value):
        self.validate_asset(value)
        post={**value.model_dump(),'delivery_mode':self.mode,'id':uuid.uuid4().hex,'status':'draft','version':1,'created':time.time(),'error':'','container_id':None,'media_id':None,'permalink':None}
        with self.store.connect() as db:db.execute('INSERT INTO instagram_posts VALUES(?,?,?)',(post['id'],json.dumps(post),time.time()))
        return post

    def update(self,identifier,value):
        self.validate_asset(value)
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row=db.execute('SELECT document FROM instagram_posts WHERE id=?',(identifier,)).fetchone()
            if not row:raise SocialError('Publishing draft not found in this workspace.')
            post=json.loads(row[0])
            if post.get('delivery_mode','instagram')!=self.mode:raise SocialError('This post belongs to a different publishing mode.')
            if post['status']!='draft':raise SocialError('Only unpublished drafts can be edited. Cancel a scheduled publication before creating a revised draft.')
            if post['version']!=value.version:raise SocialError('This draft changed. Reopen it before saving.')
            post.update(value.model_dump(exclude={'version'}),version=post['version']+1,updated=time.time())
            db.execute('UPDATE instagram_posts SET document=?,updated=? WHERE id=?',(json.dumps(post),post['updated'],identifier))
        return post

    def readiness(self):
        if self.demo:return {'connected':True,'account_name':'Local demo account','account_id':'local-demo','publish_permission':True,'authorization_current':True,'setup_issue':'','delivery_mode':'demo'}
        social=SocialStore(self.store);c=social.connection('instagram');app=social.app('instagram')
        scopes=c['tokens'].get('granted_scopes',[]) if c else []
        issue=''
        if not app:issue='Configure your Meta application in Provider app setup, then connect your Instagram account.'
        elif not c and urlsplit(app['redirect_uri']).scheme!='https':issue='For localhost, connect with a Meta developer user token below. Browser OAuth needs an accepted callback address.'
        return {'connected':bool(c and c['status']=='connected'),'account_name':c['account_name'] if c else '',
                'account_id':c['account_id'] if c else '', 'publish_permission':'instagram_content_publish' in scopes,
                'authorization_current':bool(c and c['expires']>time.time()+90),'setup_issue':issue,
                'developer_url':'https://developers.facebook.com/tools/explorer/'+app['client_id']+'/' if app and re.fullmatch(r'[0-9]+',app['client_id']) else '',
                'expires':c['expires'] if c else None}

    def dispatch(self,identifier,value,origin):
        if not value.confirmed:raise SocialError('Review the account, media and caption, then confirm publishing.')
        post=self.get(identifier);c=self.demo_connection() if self.demo else SocialStore(self.store).connection('instagram')
        ready=self.readiness()
        if not all(ready[k] for k in ('connected','publish_permission','authorization_current')):raise SocialError('Connect your Instagram Professional account with publishing permission first.')
        if value.account_id!=c['account_id']:raise SocialError('The Instagram account changed after preview. Open the review again before publishing.')
        when=value.scheduled_at if value.scheduled_at is not None else time.time()
        if not when>=time.time()-10 or when>time.time()+90*86400:raise SocialError('Choose a future publication time within 90 days.')
        if post['asset_id'] and not self.demo:
            self.validate_asset(PostInput(media_type=post['media_type'],content_id=post['content_id'],asset_id=post['asset_id']))
            if post['media_type']=='image':public_url(origin) # Meta fetches JPEGs; MP4 Reels upload directly.
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row=db.execute('SELECT document FROM instagram_posts WHERE id=?',(identifier,)).fetchone();post=json.loads(row[0])
            if post['status']!='draft' or post['version']!=value.version:raise SocialError('This draft changed or was already queued. Refresh before publishing.')
            post.update(status='scheduled' if when>time.time()+1 else 'queued',version=post['version']+1,scheduled_at=when,account_id=c['account_id'],account_name=c['account_name'],connection_generation=c['generation'],origin=origin,confirmed_at=time.time(),polls=0)
            job_id=self.store._enqueue(db,'instagram_demo_publish' if self.demo else 'instagram_publish',{'post_id':identifier},when);post['job_id']=job_id
            db.execute('UPDATE instagram_posts SET document=?,updated=? WHERE id=?',(json.dumps(post),time.time(),identifier))
        return post

    def cancel(self,identifier):
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row=db.execute('SELECT document FROM instagram_posts WHERE id=?',(identifier,)).fetchone()
            if not row:raise SocialError('Publishing draft not found.')
            post=json.loads(row[0])
            if post.get('delivery_mode','instagram')!=self.mode:raise SocialError('This post belongs to a different publishing mode.')
            if post['status'] not in ('draft','queued','scheduled'):raise SocialError('This post has started processing and cannot be cancelled here.')
            job=db.execute('SELECT status FROM jobs WHERE id=?',(post.get('job_id',''),)).fetchone()
            if job and job[0]!='queued':raise SocialError('Publishing has started. Refresh to check its status.')
            post.update(status='cancelled',version=post['version']+1)
            db.execute('UPDATE instagram_posts SET document=?,updated=? WHERE id=?',(json.dumps(post),time.time(),identifier))
            if job:db.execute("UPDATE jobs SET status='succeeded',result=? WHERE id=?",(json.dumps({'cancelled':True}),post['job_id']))
        return post

    def reschedule(self,identifier,value):
        if not value.confirmed:raise SocialError('Confirm the revised publication time first.')
        self.get(identifier)
        connection=self.demo_connection() if self.demo else SocialStore(self.store).connection('instagram')
        if not connection or connection['status']!='connected' or value.account_id!=connection['account_id']:raise SocialError('The Instagram account changed. Reconnect and review the publication.')
        when=value.scheduled_at if value.scheduled_at is not None else time.time()
        if not time.time()-10<=when<=time.time()+90*86400:raise SocialError('Choose a future publication time within 90 days.')
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row=db.execute('SELECT document FROM instagram_posts WHERE id=?',(identifier,)).fetchone()
            if not row:raise SocialError('Publication not found in this workspace.')
            post=json.loads(row[0])
            if post['status'] not in ('scheduled','queued') or post['version']!=value.version or post['account_id']!=value.account_id:raise SocialError('This publication changed or has already started. Refresh its status.')
            job=db.execute('SELECT status FROM jobs WHERE id=?',(post['job_id'],)).fetchone()
            if not job or job['status']!='queued':raise SocialError('Processing has already started. The publication time cannot be changed.')
            post.update(status='scheduled' if when>time.time()+1 else 'queued',scheduled_at=when,version=post['version']+1,connection_generation=connection['generation'],confirmed_at=time.time(),updated=time.time())
            db.execute('UPDATE instagram_posts SET document=?,updated=? WHERE id=?',(json.dumps(post),post['updated'],identifier))
            db.execute('UPDATE jobs SET available=? WHERE id=?',(when,post['job_id']))
        return post

    @staticmethod
    def demo_connection():return {'status':'connected','account_id':'local-demo','account_name':'Local demo account','generation':'local-demo'}


def demo_step(store,job):
    """A local-only delivery path. No provider client, tokens or network calls."""
    repo=Posts(store,demo=True);post=repo.get(job['payload']['post_id'])
    if post['status'] not in ('queued','scheduled') or post.get('job_id')!=job['id']:
        store.finish(job,{'status':post['status'],'simulated':True});return
    if post['asset_id'] and not Library(store).asset_path(post['asset_id']).is_file():
        post.update(status='failed',error='The local media file is missing.')
    else:post.update(status='published',published_at=time.time(),media_id='demo-'+post['id'],error='',simulated=True)
    repo.save(post)
    store.record_event(job,'result','Local Instagram demo completed; nothing sent to Instagram',{'post_id':post['id'],'simulated':True})
    store.finish(job,{'status':post['status'],'simulated':True})


def grant_media(store,post):
    root=getattr(store,'platform_store',store);ticket=secrets.token_urlsafe(32)
    with root.connect() as db:
        db.executescript(GRANTS)
        db.execute('DELETE FROM publishing_media WHERE expires<?',(time.time(),))
        db.execute('INSERT INTO publishing_media VALUES(?,?,?,?,?)',(digest(ticket),store.path,post['content_id'],post['asset_id'],time.time()+86400))
    return post['origin']+'/publishing/media/'+ticket


async def step(store,job,client):
    repo=Posts(store);post=repo.get(job['payload']['post_id'])
    if post.get('job_id')!=job['id']:
        store.finish(job,{'skipped':'This publication checkpoint was already advanced.'});return
    if post['status'] in ('published','failed','uncertain','cancelled','draft'):
        store.finish(job,{'status':post['status']});return
    # Recovering an expired lease must never repeat a potentially successful POST.
    if post['status'] in ('creating','uploading','publishing'):
        post.update(status='uncertain',error='The previous provider write has an unknown outcome. Check Instagram before creating another post.');repo.save(post)
        store.finish(job,{'status':'uncertain'});return
    try:
        social=SocialStore(store);connection=social.connection('instagram');app=social.app('instagram')
        if not connection or connection['status']!='connected' or connection['generation']!=post['connection_generation'] or connection['account_id']!=post['account_id']:raise SocialError('The connected Instagram account changed. This queued post was stopped.')
        token=await access_token(social,connection,client);headers={'Authorization':'Bearer '+token};base='https://graph.facebook.com/'+app['api_version']+'/'
        # Verify actual granted permissions at execution time, including scheduled jobs.
        permissions=await request_json(client,'GET',base+'me/permissions',headers=headers)
        if not any(p.get('permission')=='instagram_content_publish' and p.get('status')=='granted' for p in permissions.get('data',[])):raise SocialError('Instagram publishing permission is missing or revoked. Reconnect with publishing access.')
        page_token=connection['tokens'].get('page_tokens',{}).get(post['account_id'])
        if page_token:headers={'Authorization':'Bearer '+page_token}
        if not post['container_id']:
            local_reel=bool(post['asset_id'] and post['media_type']=='reel')
            if local_reel:
                repo.validate_asset(PostInput(media_type='reel',content_id=post['content_id'],asset_id=post['asset_id']))
            url='' if local_reel else post['media_url'] or grant_media(store,post)
            post['status']='creating';repo.save(post)
            body={'caption':post['caption']}
            if local_reel:body['upload_type']='resumable'
            else:body['video_url' if post['media_type']=='reel' else 'image_url']=url
            if post['media_type']=='reel':body.update(media_type='REELS',share_to_feed='true')
            data=await request_json(client,'POST',base+post['account_id']+'/media',headers=headers,data=body)
            if not re.fullmatch(r'[0-9]+',str(data.get('id',''))):raise SocialError('Instagram did not return a valid media container.')
            post.update(container_id=str(data['id']),status='uploading' if local_reel else 'processing');repo.save(post)
            if local_reel:
                # Only Meta's fixed upload host receives the private MP4. Never
                # follow an arbitrary upload URI returned in a provider response.
                path=Library(store).asset_path(post['asset_id']);size=path.stat().st_size
                async def chunks():
                    with path.open('rb') as file:
                        while chunk:=file.read(256*1024):yield chunk
                uploaded=await request_json(client,'POST','https://rupload.facebook.com/ig-api-upload/'+app['api_version']+'/'+post['container_id'],
                    headers={'Authorization':'OAuth '+(page_token or token),'offset':'0','file_size':str(size),
                             'Content-Length':str(size),'Content-Type':'application/octet-stream'},content=chunks())
                if uploaded.get('success') is not True:raise SocialError('Meta did not confirm the Reel upload. Check Instagram before retrying.')
                post.update(status='processing');repo.save(post)
        state=await request_json(client,'GET',base+post['container_id'],headers=headers,params={'fields':'status_code'})
        code=state.get('status_code')
        if code in ('ERROR','EXPIRED'):raise SocialError('Instagram could not process this media. Check its format and availability.')
        if code=='PUBLISHED':
            post.update(status='published',error='Instagram confirms the container was published; the post ID was not recovered.');repo.save(post)
            store.finish(job,{'status':'published'});return
        if code!='FINISHED':
            post['polls']+=1
            if post['polls']>=80:raise SocialError('Media processing did not finish within the monitoring window. Check Instagram before trying again.')
            with store.connect() as db:
                db.execute('BEGIN IMMEDIATE')
                post['job_id']=store._enqueue(db,'instagram_publish',{'post_id':post['id']},time.time()+15)
                db.execute('UPDATE instagram_posts SET document=?,updated=? WHERE id=?',(json.dumps(post),time.time(),post['id']))
            store.finish(job,{'status':'processing'});return
        post['status']='publishing';repo.save(post)
        result=await request_json(client,'POST',base+post['account_id']+'/media_publish',headers=headers,data={'creation_id':post['container_id']})
        if not re.fullmatch(r'[0-9]+',str(result.get('id',''))):raise SocialError('Instagram did not return a published media ID.')
        post.update(status='published',media_id=str(result['id']),published_at=time.time(),error='');repo.save(post)
        # A failed permalink lookup must never retry publication.
        try:
            link=await request_json(client,'GET',base+post['media_id'],headers=headers,params={'fields':'permalink'})
            if str(link.get('permalink','')).startswith('https://www.instagram.com/'):post['permalink']=link['permalink'];repo.save(post)
        except SocialError:pass
        store.record_event(job,'result','Instagram post published',{'post_id':post['id'],'media_id':post['media_id']})
        store.finish(job,{'status':'published','media_id':post['media_id']})
    except Exception as error:
        uncertain=post['status'] in ('creating','uploading','publishing')
        post.update(status='uncertain' if uncertain else 'failed',error='Provider write outcome is unknown. Check Instagram before creating another post.' if uncertain else str(error) if isinstance(error,SocialError) else 'Publishing stopped. Check your connection, granted publishing permission, media format and provider availability.')
        repo.save(post);store.record_event(job,'error','Instagram publishing stopped',{'post_id':post['id'],'status':post['status']})
        store.finish(job,{'status':post['status']})
