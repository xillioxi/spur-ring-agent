"""Official TikTok posting with explicit reviews and durable upload checkpoints."""
import hashlib
import json
import logging
import math
import re
import struct
import time
import uuid
from urllib.parse import urlsplit,urlunsplit

import httpx
from pydantic import BaseModel,ConfigDict,Field,field_validator
from spur.library import Library
from spur.social import SocialStore,SocialError,access_token,seal,unseal,request_json

BASE='https://open.tiktokapis.com/v2/'
SCHEMA='''CREATE TABLE IF NOT EXISTS tiktok_posts(id TEXT PRIMARY KEY,document TEXT NOT NULL,updated REAL NOT NULL);
CREATE TABLE IF NOT EXISTS tiktok_uploads(post_id TEXT PRIMARY KEY,secret BLOB NOT NULL);'''
ERRORS={
 'scope_not_authorized':'Reconnect TikTok and grant the publishing permission for this posting method.',
 'access_token_invalid':'TikTok authorization expired or was revoked. Reconnect your account.',
 'unaudited_client_can_only_post_to_private_accounts':'TikTok restricts unaudited Direct Post apps to private accounts and Only me posts. Use Upload to TikTok, or complete the app audit.',
 'privacy_level_option_mismatch':'The account privacy options changed. Review the post again.',
 'spam_risk_too_many_posts':'TikTok has reached the account’s daily posting limit. Try later.',
 'spam_risk_too_many_pending_share':'TikTok has too many pending inbox uploads. Finish them in TikTok before uploading another.',
 'spam_risk_user_banned_from_posting':'TikTok is not allowing this account to post.',
 'reached_active_user_cap':'TikTok has reached this app’s active creator limit.',
 'rate_limit_exceeded':'TikTok’s request limit was reached. Try later.'}


class TikTokError(SocialError):
    def __init__(self,message,uncertain=False):super().__init__(message);self.uncertain=uncertain


class UploadLogFilter(logging.Filter):
    def filter(self,record):
        if isinstance(record.args,tuple):
            values=[]
            for value in record.args:
                text=str(value)
                if 'upload_token=' in text or re.search(r'https://(?:open-upload|upload\.(?:us|eu|sg))\.tiktokapis\.com/',text):
                    p=urlsplit(text);value=urlunsplit((p.scheme,p.netloc,p.path,'[redacted]',''))
                values.append(value)
            record.args=tuple(values)
        return True


logging.getLogger('httpx').addFilter(UploadLogFilter())


async def call(client,path,token,body=None):
    try:
        response=await client.post(BASE+path,headers={'Authorization':'Bearer '+token},json=body or {},timeout=30)
        data=response.json()
    except (httpx.HTTPError,ValueError):raise TikTokError('TikTok did not confirm this request. Check its status before retrying.',True) from None
    error=data.get('error') if isinstance(data,dict) else None
    code=error.get('code') if isinstance(error,dict) else None
    if not response.is_success or code!='ok':
        raise TikTokError(ERRORS.get(code,'TikTok rejected this request. Check the account, app products and granted permissions.'),response.status_code>=500)
    result=data.get('data')
    if not isinstance(result,dict):raise TikTokError('TikTok returned an incomplete response.',True)
    return result


def upload_url(value):
    try:
        p=urlsplit(value)
        allowed=p.hostname=='open-upload.tiktokapis.com' or bool(re.fullmatch(r'upload\.(us|eu|sg)\.tiktokapis\.com',p.hostname or ''))
        if not allowed or p.scheme!='https' or p.port not in (None,443) or p.username or p.password or p.fragment or p.path not in ('/video/','/upload/'):raise ValueError()
    except (TypeError,ValueError):raise TikTokError('TikTok returned an unrecognized upload destination. No video was sent.') from None
    return value


def mp4_info(path):
    """Read bounded ISO-BMFF headers; seek across media instead of loading it."""
    size=path.stat().st_size
    if not 1<=size<=250*1024*1024:raise SocialError('Choose an MP4 up to 250 MB.')
    duration=None;video=False;ftyp=False;boxes=0
    with path.open('rb') as file:
        def scan(start,end,depth=0):
            nonlocal duration,video,ftyp,boxes
            if depth>8:raise SocialError('MP4 structure is too deeply nested.')
            position=start
            while position+8<=end:
                boxes+=1
                if boxes>10000:raise SocialError('MP4 has too many metadata boxes.')
                file.seek(position);length,kind=struct.unpack('>I4s',file.read(8));header=8
                if length==1:
                    if position+16>end:raise SocialError('MP4 metadata is incomplete.')
                    length=struct.unpack('>Q',file.read(8))[0];header=16
                elif length==0:length=end-position
                if length<header or position+length>end:raise SocialError('MP4 metadata is invalid.')
                payload=position+header;stop=position+length
                if kind==b'ftyp':ftyp=True
                if kind in (b'moov',b'trak',b'mdia'):scan(payload,stop,depth+1)
                elif kind==b'mvhd':
                    file.seek(payload);version=file.read(1)
                    offset,width=(20,8) if version==b'\x01' else (12,4)
                    if payload+offset+4+width>stop:raise SocialError('MP4 duration is incomplete.')
                    file.seek(payload+offset);scale=int.from_bytes(file.read(4),'big');ticks=int.from_bytes(file.read(width),'big')
                    if scale:duration=ticks/scale
                elif kind==b'hdlr' and stop-payload>=12:
                    file.seek(payload+8);video=video or file.read(4)==b'vide'
                position=stop
        scan(0,size)
    if not ftyp or not video or duration is None or not math.isfinite(duration) or not 3<=duration<=3600:
        raise SocialError('Choose a complete MP4 video with a readable duration of 3 seconds to 60 minutes.')
    digest=hashlib.sha256()
    with path.open('rb') as file:
        while chunk:=file.read(1024*1024):digest.update(chunk)
    return {'size':size,'duration':duration,'sha256':digest.hexdigest()}


class DraftInput(BaseModel):
    model_config=ConfigDict(extra='forbid')
    caption:str=Field(default='',max_length=2200)
    content_id:str=Field(pattern=r'^[a-f0-9]{32}$')
    asset_id:str=Field(pattern=r'^[a-f0-9]{32}$')
    method:str=Field(default='direct',pattern='^(direct|inbox)$')

    @field_validator('caption')
    @classmethod
    def caption_length(cls,value):
        if len(value.encode('utf-16-le'))//2>2200:raise ValueError('Caption exceeds TikTok’s 2,200 UTF-16 character limit.')
        return value


class DraftUpdate(DraftInput):version:int=Field(ge=1)


class PublishInput(BaseModel):
    model_config=ConfigDict(extra='forbid')
    version:int=Field(ge=1)
    account_id:str=Field(min_length=1,max_length=200)
    review_id:str=Field(pattern=r'^[a-f0-9]{32}$')
    confirmed:bool=False
    music_confirmed:bool=False
    branded_confirmed:bool=False
    privacy_level:str=''
    allow_comment:bool=False
    allow_duet:bool=False
    allow_stitch:bool=False
    commercial:bool=False
    own_brand:bool=False
    branded_content:bool=False
    is_aigc:bool=False
    scheduled_at:float|None=None


class Posts:
    def __init__(self,store):
        if getattr(store,'mock_profile',None):raise SocialError('Publish from your personal workspace. Creator reference profiles are for research.')
        self.store=store
        with store.connect() as db:db.executescript(SCHEMA)

    def list(self):
        with self.store.connect() as db:return [json.loads(r[0]) for r in db.execute('SELECT document FROM tiktok_posts ORDER BY updated DESC LIMIT 100')]

    def get(self,identifier):
        with self.store.connect() as db:row=db.execute('SELECT document FROM tiktok_posts WHERE id=?',(identifier,)).fetchone()
        if not row:raise SocialError('TikTok draft not found in this workspace.')
        return json.loads(row[0])

    def save(self,post):
        with self.store.connect() as db:db.execute('UPDATE tiktok_posts SET document=?,updated=? WHERE id=?',(json.dumps(post),time.time(),post['id']))

    def asset(self,value):
        lib=Library(self.store);item=lib.get(value.content_id);asset=lib.asset(value.content_id,value.asset_id)
        if item['kind']!='own' or asset['media_type']!='video/mp4':raise SocialError('Choose your own MP4 video from the content library.')
        return mp4_info(lib.asset_path(value.asset_id))

    def create(self,value):
        post={**value.model_dump(),'id':uuid.uuid4().hex,'version':1,'status':'draft','created':time.time(),'media':self.asset(value),'error':'','publish_id':None,'post_ids':[],'polls':0,'uploaded_bytes':0}
        with self.store.connect() as db:db.execute('INSERT INTO tiktok_posts VALUES(?,?,?)',(post['id'],json.dumps(post),time.time()))
        return post

    def update(self,identifier,value):
        info=self.asset(value)
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE');row=db.execute('SELECT document FROM tiktok_posts WHERE id=?',(identifier,)).fetchone()
            if not row:raise SocialError('TikTok draft not found.')
            post=json.loads(row[0])
            if post['status']!='draft' or post['version']!=value.version:raise SocialError('This draft changed or was queued. Reopen it before editing.')
            post.update(value.model_dump(exclude={'version'}),media=info,version=post['version']+1);post.pop('review',None)
            db.execute('UPDATE tiktok_posts SET document=?,updated=? WHERE id=?',(json.dumps(post),time.time(),identifier))
        return post

    def readiness(self):
        repo=SocialStore(self.store);c=repo.connection('tiktok');app=repo.public('tiktok')
        scopes=set(c['tokens'].get('scope','').replace(',',' ').split()) if c else set()
        config=repo.apps.get_runtime('tiktok_publishing',{})
        return {'connected':bool(c and c['status']=='connected'),'account_name':c['account_name'] if c else '',
            'account_id':c['account_id'] if c else '', 'direct_enabled':'video.publish' in scopes,'inbox_enabled':'video.upload' in scopes,
            'audit_approved':bool(config.get('approved') and config.get('client_id')==app['client_id'] and config.get('reference')),
            'connect_ready':app['connect_ready'],'setup_issue':app['setup_issue'],'login_mode':app.get('login_mode','web')}

    async def creator(self,client,method='direct'):
        repo=SocialStore(self.store);c=repo.connection('tiktok')
        if not c or c['status']!='connected':raise SocialError('Connect your own TikTok account first.')
        needed='video.publish' if method=='direct' else 'video.upload'
        if needed not in c['tokens'].get('scope','').replace(',',' ').split():raise SocialError('Reconnect TikTok with '+needed+' permission for this posting method.')
        token=await access_token(repo,c,client)
        if method=='direct':
            data=await call(client,'post/publish/creator_info/query/',token)
            if not isinstance(data.get('privacy_level_options'),list) or not all(v in ('PUBLIC_TO_EVERYONE','MUTUAL_FOLLOW_FRIENDS','FOLLOWER_OF_CREATOR','SELF_ONLY') for v in data['privacy_level_options']) or type(data.get('max_video_post_duration_sec')) is not int or data['max_video_post_duration_sec']<=0:raise SocialError('TikTok did not return the account’s posting settings. Try again later.')
            data={k:data.get(k) for k in ('creator_username','creator_nickname','creator_avatar_url','privacy_level_options','max_video_post_duration_sec','comment_disabled','duet_disabled','stitch_disabled')}
        else:
            profile=(await request_json(client,'GET',BASE+'user/info/',headers={'Authorization':'Bearer '+token},params={'fields':'open_id,display_name'})).get('data',{}).get('user',{})
            if profile.get('open_id')!=c['account_id']:raise SocialError('TikTok returned a different account. Reconnect before uploading.')
            data={'creator_nickname':profile.get('display_name') or c['account_name'],'creator_username':'','privacy_level_options':[]}
        return c,token,data

    async def review(self,identifier,client):
        post=self.get(identifier)
        if post['status']!='draft':raise SocialError('Only unpublished drafts can be reviewed.')
        if self.asset(DraftInput(**{k:post[k] for k in DraftInput.model_fields}))!=post['media']:raise SocialError('The media changed. Save the draft again.')
        c,token,creator=await self.creator(client,post['method'])
        if post['method']=='direct' and post['media']['duration']>creator['max_video_post_duration_sec']:raise SocialError('This video exceeds the duration TikTok allows for this account.')
        review={'id':uuid.uuid4().hex,'account_id':c['account_id'],'generation':c['generation'],'creator':creator,'expires':time.time()+600}
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE');current=json.loads(db.execute('SELECT document FROM tiktok_posts WHERE id=?',(identifier,)).fetchone()[0])
            if current['version']!=post['version'] or current['status']!='draft':raise SocialError('This draft changed. Review it again.')
            current['review']=review;db.execute('UPDATE tiktok_posts SET document=?,updated=? WHERE id=?',(json.dumps(current),time.time(),identifier))
        return {'post':post,'review':review,'connection':self.readiness()}

    def validate_choices(self,post,value,creator):
        if not value.confirmed:raise SocialError('Review the account and video, then explicitly confirm the upload.')
        if post['method']=='inbox':return
        if not value.music_confirmed:raise SocialError('Confirm TikTok’s Music Usage Confirmation before posting.')
        if value.privacy_level not in creator['privacy_level_options']:raise SocialError('Select a privacy level currently offered by TikTok.')
        if not self.readiness()['audit_approved']:
            if value.privacy_level!='SELF_ONLY' or 'PUBLIC_TO_EVERYONE' in creator['privacy_level_options']:
                raise SocialError('Unaudited Direct Post requires a private TikTok account and Only me visibility. Use Upload to TikTok to finish the post there, or complete TikTok’s audit.')
        for field in ('comment','duet','stitch'):
            if getattr(value,'allow_'+field) and creator.get(field+'_disabled',True):raise SocialError('TikTok disabled '+field+' for this account. Review the post again.')
        if value.commercial and not (value.own_brand or value.branded_content):raise SocialError('Select Your brand, Branded content, or both.')
        if not value.commercial and (value.own_brand or value.branded_content):raise SocialError('Enable commercial disclosure for brand labels.')
        if value.branded_content and (value.privacy_level=='SELF_ONLY' or not value.branded_confirmed):raise SocialError('Paid partnership requires non-private visibility and agreement to TikTok’s Branded Content Policy.')
        if post['media']['duration']>creator['max_video_post_duration_sec']:raise SocialError('The video exceeds this account’s current maximum duration.')

    def dispatch(self,identifier,value):
        c=SocialStore(self.store).connection('tiktok');post=self.get(identifier);review=post.get('review',{})
        if not c or c['status']!='connected' or value.account_id!=c['account_id'] or review.get('account_id')!=c['account_id'] or review.get('generation')!=c['generation']:raise SocialError('The connected account changed. Review the post again.')
        if review.get('id')!=value.review_id or review.get('expires',0)<time.time():raise SocialError('The review expired. Review this draft again.')
        self.validate_choices(post,value,review['creator'])
        when=value.scheduled_at if value.scheduled_at is not None else time.time()
        if not math.isfinite(when) or not time.time()-10<=when<=time.time()+30*86400:raise SocialError('Choose a publication time within the next 30 days.')
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE');current=json.loads(db.execute('SELECT document FROM tiktok_posts WHERE id=?',(identifier,)).fetchone()[0])
            if current['status']!='draft' or current['version']!=value.version or current.get('review',{}).get('id')!=value.review_id:raise SocialError('This draft changed or was already queued.')
            username=review['creator'].get('creator_username') or ''
            current.update(status='scheduled' if when>time.time()+1 else 'queued',version=current['version']+1,account_id=c['account_id'],account_name=review['creator'].get('creator_nickname') or c['account_name'],account_username=username if re.fullmatch(r'[A-Za-z0-9_.]{1,64}',username) else '',generation=c['generation'],choices=value.model_dump(),scheduled_at=when,confirmed_at=time.time())
            current.pop('review',None);current['job_id']=self.store._enqueue(db,'tiktok_publish',{'post_id':identifier},when)
            db.execute('UPDATE tiktok_posts SET document=?,updated=? WHERE id=?',(json.dumps(current),time.time(),identifier))
        return current

    def cancel(self,identifier):
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE');row=db.execute('SELECT document FROM tiktok_posts WHERE id=?',(identifier,)).fetchone()
            if not row:raise SocialError('TikTok draft not found.')
            post=json.loads(row[0]);job=db.execute('SELECT status FROM jobs WHERE id=?',(post.get('job_id',''),)).fetchone()
            if post['status'] not in ('draft','queued','scheduled') or job and job[0]!='queued':raise SocialError('This upload has started. Check its TikTok status; cancelling a local draft cannot remove TikTok content.')
            post.update(status='cancelled',version=post['version']+1)
            db.execute('UPDATE tiktok_posts SET document=?,updated=? WHERE id=?',(json.dumps(post),time.time(),identifier))
            if job:db.execute("UPDATE jobs SET status='succeeded',result=? WHERE id=?",(json.dumps({'cancelled':True}),post['job_id']))
        return post

    def check_status(self,identifier):
        post=self.get(identifier)
        if not post.get('publish_id'):raise SocialError('TikTok has not supplied a publish ID. Check the account before starting another upload.')
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE');post=json.loads(db.execute('SELECT document FROM tiktok_posts WHERE id=?',(identifier,)).fetchone()[0])
            if post['status']=='published':return post
            pending=db.execute("SELECT id FROM jobs WHERE id=? AND status IN ('queued','running')",(post.get('job_id',''),)).fetchone()
            if pending:return post
            post['job_id']=self.store._enqueue(db,'tiktok_publish',{'post_id':identifier,'status_only':True},time.time())
            db.execute('UPDATE tiktok_posts SET document=?,updated=? WHERE id=?',(json.dumps(post),time.time(),identifier))
        return post


def checkpoint(repo,job,post,delay=0):
    with repo.store.connect() as db:
        db.execute('BEGIN IMMEDIATE')
        owner=db.execute('SELECT token,status FROM jobs WHERE id=?',(job['id'],)).fetchone()
        if not owner or owner['token']!=job['token'] or owner['status']!='running':raise SocialError('The upload job lease changed.')
        post['job_id']=repo.store._enqueue(db,'tiktok_publish',{'post_id':post['id']},time.time()+delay)
        db.execute('UPDATE tiktok_posts SET document=?,updated=? WHERE id=?',(json.dumps(post),time.time(),post['id']))
    repo.store.finish(job,{'status':post['status']})


def verify_write_owner(store,job,post):
    with store.connect() as db:
        owner=db.execute('SELECT token,status,lease_until FROM jobs WHERE id=?',(job['id'],)).fetchone()
        connection=db.execute("SELECT generation,account_id,status FROM social_connections WHERE platform='tiktok'").fetchone()
    if not owner or owner['token']!=job['token'] or owner['status']!='running' or owner['lease_until']<time.time():raise SocialError('The upload job lease changed.')
    if not connection or connection['generation']!=post['generation'] or connection['account_id']!=post['account_id'] or connection['status']!='connected':raise SocialError('The TikTok connection changed. This publication was stopped.')


async def step(store,job,client):
    repo=Posts(store);post=repo.get(job['payload']['post_id']);status_only=job['payload'].get('status_only',False)
    if post.get('job_id')!=job['id']:store.finish(job,{'skipped':'Checkpoint already advanced'});return
    if post['status'] in ('published','failed','cancelled','draft','inbox_delivered','upload_incomplete','uncertain') and not status_only:store.finish(job,{'status':post['status']});return
    if post['status'] in ('initializing','uploading') and not status_only:
        post.update(status='uncertain',error='An interrupted TikTok write has an unknown outcome. Check status before creating another upload.');repo.save(post);store.finish(job,{'status':'uncertain'});return
    try:
        social=SocialStore(store);c=social.connection('tiktok')
        if not c or c['generation']!=post['generation'] or c['account_id']!=post['account_id'] or c['status']!='connected':raise SocialError('The TikTok connection changed. This publication was stopped.')
        token=await access_token(social,c,client)
        c=social.connection('tiktok')
        if not c or c['generation']!=post['generation']:raise SocialError('The TikTok connection changed. This publication was stopped.')
        needed='video.publish' if post['method']=='direct' else 'video.upload'
        if needed not in c['tokens'].get('scope','').replace(',',' ').split():raise SocialError('TikTok publishing permission is missing. Reconnect this account.')
        if not post.get('publish_id'):
            _,token,creator=await repo.creator(client,post['method']);repo.validate_choices(post,PublishInput(**post['choices']),creator)
            media=repo.asset(DraftInput(**{k:post[k] for k in DraftInput.model_fields}))
            if media!=post['media']:raise SocialError('The reviewed MP4 changed. This publication was stopped.')
            verify_write_owner(store,job,post)
            chunk=min(media['size'],8*1024*1024);count=max(1,media['size']//chunk)
            body={'source_info':{'source':'FILE_UPLOAD','video_size':media['size'],'chunk_size':chunk,'total_chunk_count':count}}
            if post['method']=='direct':
                v=post['choices'];body['post_info']={'title':post['caption'],'privacy_level':v['privacy_level'],**{'disable_'+k:not v['allow_'+k] for k in ('comment','duet','stitch')},'brand_organic_toggle':v['own_brand'],'brand_content_toggle':v['branded_content'],'is_aigc':v['is_aigc']}
            post['status']='initializing';repo.save(post)
            result=await call(client,'post/publish/'+('video/init/' if post['method']=='direct' else 'inbox/video/init/'),token,body)
            identifier=result.get('publish_id','')
            if not isinstance(identifier,str) or not re.fullmatch(r'[A-Za-z0-9_.~:-]{1,64}',identifier):raise TikTokError('TikTok did not return a valid publish ID.',True)
            post.update(publish_id=identifier,status='upload_pending',chunk_size=chunk,chunk_count=count,chunk_index=0,upload_started=time.time());repo.save(post)
            url=upload_url(result.get('upload_url'))
            with store.connect() as db:db.execute('INSERT OR REPLACE INTO tiktok_uploads VALUES(?,?)',(post['id'],seal({'url':url})))
            checkpoint(repo,job,post);return
        if post['status']=='upload_pending' and not status_only:
            media=repo.asset(DraftInput(**{k:post[k] for k in DraftInput.model_fields}))
            if media!=post['media']:raise SocialError('The reviewed MP4 changed during upload. This upload was stopped.')
            if time.time()-post['upload_started']>3500:raise SocialError('TikTok’s upload URL expired. Check status before starting another upload.')
            with store.connect() as db:row=db.execute('SELECT secret FROM tiktok_uploads WHERE post_id=?',(post['id'],)).fetchone()
            if not row:raise SocialError('The encrypted upload checkpoint is missing. Check status before starting another upload.')
            url=upload_url(unseal(row[0])['url']);offset=post['uploaded_bytes'];last=post['chunk_index']==post['chunk_count']-1
            length=media['size']-offset if last else post['chunk_size']
            path=Library(store).asset_path(post['asset_id'])
            with path.open('rb') as file:file.seek(offset);chunk=file.read(length)
            if len(chunk)!=length:raise SocialError('The MP4 changed during upload.')
            verify_write_owner(store,job,post)
            post['status']='uploading';repo.save(post)
            try:response=await client.put(url,headers={'Content-Type':'video/mp4','Content-Length':str(length),'Content-Range':f'bytes {offset}-{offset+length-1}/{media["size"]}'},content=chunk,timeout=45,follow_redirects=False)
            except httpx.HTTPError:raise TikTokError('The TikTok upload outcome is unknown. Check status before retrying.',True) from None
            if response.status_code!=(201 if last else 206):raise TikTokError('TikTok did not confirm this video chunk. Check status before retrying.',True)
            post.update(uploaded_bytes=offset+length,chunk_index=post['chunk_index']+1,status='processing' if last else 'upload_pending')
            if last:
                with store.connect() as db:db.execute('DELETE FROM tiktok_uploads WHERE post_id=?',(post['id'],))
            checkpoint(repo,job,post,10 if last else 0);return
        result=await call(client,'post/publish/status/fetch/',token,{'publish_id':post['publish_id']})
        status=result.get('status');post['provider_status']=status
        if status=='PUBLISH_COMPLETE':
            post.update(status='published',published_at=time.time(),error='',post_ids=[str(v) for v in result.get('publicaly_available_post_id',[]) if re.fullmatch(r'[0-9]{1,30}',str(v))])
        elif status=='SEND_TO_USER_INBOX':post.update(status='inbox_delivered',error='Open the TikTok inbox notification to edit and publish. This is not a published post.')
        elif status=='FAILED':
            reason=result.get('fail_reason','');reason=reason if isinstance(reason,str) and re.fullmatch(r'[a-z0-9_]{1,100}',reason) else ''
            post.update(status='failed',error='TikTok could not publish this video.'+(' TikTok reason: '+reason+'.' if reason else ' Check the account and media requirements.'))
        elif status=='PROCESSING_UPLOAD' and status_only and (not isinstance(result.get('uploaded_bytes'),int) or result['uploaded_bytes']<post['media']['size']):
            post.update(status='upload_incomplete',error='TikTok is still awaiting video bytes. The interrupted upload was not automatically repeated.')
        elif status in ('PROCESSING_UPLOAD','PROCESSING_DOWNLOAD'):
            post.update(status='processing',polls=post['polls']+1)
            if post['polls']>=120:post.update(status='awaiting_tiktok',error='TikTok is still processing. Use Check TikTok status later; the video will not be uploaded again.')
            else:checkpoint(repo,job,post,30);return
        else:raise SocialError('TikTok returned an unknown processing state. Check status later.')
        repo.save(post);store.finish(job,{'status':post['status']})
    except Exception as error:
        with store.connect() as db:owner=db.execute('SELECT token,status FROM jobs WHERE id=?',(job['id'],)).fetchone()
        if not owner or owner['token']!=job['token'] or owner['status']!='running':return
        uncertain=post['status'] in ('initializing','uploading') and (not isinstance(error,TikTokError) or error.uncertain)
        waiting=post['status'] in ('processing','awaiting_tiktok','inbox_delivered') and isinstance(error,TikTokError) and error.uncertain
        post.update(status='uncertain' if uncertain else 'awaiting_tiktok' if waiting else 'failed',error=str(error) if isinstance(error,SocialError) else 'TikTok posting stopped. Check the account and media before trying again.')
        repo.save(post);store.finish(job,{'status':post['status']})
