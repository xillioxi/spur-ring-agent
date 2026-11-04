"""Private OAuth connections and analytics. Publishing requires a separate explicit opt-in."""
import base64
import hashlib
import json
import math
import re
import secrets
import time
import uuid
from datetime import date,timedelta,datetime,timezone
from urllib.parse import urlencode, urlparse

import httpx

from spur.credentials import protect

PLATFORMS=('youtube','instagram','tiktok','linkedin')
TT_SCOPES=['user.info.basic','video.list','user.info.stats']
YT_SCOPES=['https://www.googleapis.com/auth/youtube.readonly','https://www.googleapis.com/auth/yt-analytics.readonly']
IG_SCOPES=['instagram_basic','instagram_manage_insights','pages_show_list','pages_read_engagement']


class SocialError(ValueError):pass


def seal(value):
    try:return protect(json.dumps(value).encode())
    except (ValueError,OSError):raise SocialError('Windows could not encrypt these credentials. Run the app under your normal Windows account.') from None
def unseal(value):
    try:return json.loads(protect(bytes(value),decrypt=True))
    except (ValueError,OSError):raise SocialError('Saved credentials cannot be read by this Windows account. Re-enter the app setup and reconnect.') from None
def digest(value):return hashlib.sha256(value.encode()).hexdigest()


def numeric(value):
    if isinstance(value,bool):return None
    try:
        result=float(value)
        return result if math.isfinite(result) else None
    except (ValueError,TypeError):return None


class SocialStore:
    def __init__(self,store):
        self.store=store
        self.apps=getattr(store,'platform_store',store)

    def app(self,platform):
        with self.apps.connect() as db:
            row=db.execute('SELECT * FROM social_apps WHERE platform=?',(platform,)).fetchone()
        return {**dict(row),'client_secret':unseal(row['secret'])['value']} if row else None

    def save_app(self,platform,client_id,secret,redirect_uri,api_version):
        previous=self.app(platform)
        if not secret and previous and previous['client_id']==client_id:secret=previous['client_secret']
        if not secret:raise SocialError('Enter the OAuth app client secret.')
        with self.apps.connect() as db:
            db.execute('INSERT OR REPLACE INTO social_apps VALUES(?,?,?,?,?,?)',
                       (platform,client_id,seal({'value':secret}),redirect_uri,api_version,time.time()))

    def connection(self,platform):
        with self.store.connect() as db:row=db.execute('SELECT * FROM social_connections WHERE platform=?',(platform,)).fetchone()
        return {**dict(row),'tokens':unseal(row['tokens']),'candidates':json.loads(row['candidates'])} if row else None

    def connect(self,platform,tokens,candidates):
        import re
        pattern=r'UC[A-Za-z0-9_-]{22}' if platform=='youtube' else r'[A-Za-z0-9_.~-]{1,200}' if platform=='tiktok' else r'[0-9]{1,32}'
        candidates=[item for item in candidates if re.fullmatch(pattern,str(item.get('id','')))]
        if not candidates:raise SocialError('No eligible account found. Check ownership and granted permissions.')
        first=candidates[0];status='connected' if len(candidates)==1 else 'choose_account'
        with self.store.connect() as db:
            db.execute('INSERT OR REPLACE INTO social_connections VALUES(?,?,?,?,?,?,?,?,?,?)',
                       (platform,seal(tokens),first['id'],first['name'],json.dumps(candidates),status,
                        time.time()+float(tokens.get('expires_in',3600)),None,None,uuid.uuid4().hex))

    def select_account(self,platform,account_id):
        connection=self.connection(platform)
        if not connection:raise SocialError('Connect an account first.')
        account=next((item for item in connection['candidates'] if item['id']==account_id),None)
        if not account:raise SocialError('Choose an account returned by this authorization.')
        with self.store.connect() as db:
            db.execute("UPDATE social_connections SET account_id=?,account_name=?,status='connected',last_sync=NULL,last_error=NULL,generation=? WHERE platform=?",
                       (account['id'],account['name'],uuid.uuid4().hex,platform))

    def public(self,platform):
        app=self.app(platform);connection=self.connection(platform)
        with self.store.connect() as db:
            pending=db.execute("SELECT id FROM jobs WHERE kind='social_sync' AND status IN ('queued','running') AND json_extract(payload,'$.platform')=? ORDER BY created DESC LIMIT 1",(platform,)).fetchone()
        issue='';login=self.apps.get_runtime('tiktok_login',{})
        mode=login.get('mode','web') if app and login.get('client_id')==app['client_id'] else 'web'
        if app and platform=='tiktok':
            callback=urlparse(app['redirect_uri'])
            try:port=callback.port
            except ValueError:port=None
            if mode=='desktop':
                if callback.scheme not in ('http','https') or callback.hostname not in ('localhost','127.0.0.1') or not port or callback.query or callback.fragment or callback.username:
                    issue='TikTok Desktop Login Kit needs its registered localhost callback with a port. Save this local address and register it under Desktop in TikTok.'
            elif callback.scheme!='https' or callback.hostname in ('localhost','127.0.0.1'):
                issue='TikTok Web Login Kit needs a registered public HTTPS callback. For localhost, configure Desktop Login Kit and select Desktop in Provider app setup.'
        return {'platform':platform,'configured':bool(app),'connect_ready':bool(app) and not issue,'setup_issue':issue,'client_id':app['client_id'] if app else '',
                'redirect_uri':app['redirect_uri'] if app else '', 'api_version':app['api_version'] if app else 'v24.0',
                'has_client_secret':bool(app),'login_mode':mode if platform=='tiktok' else None,
                'publishing_audit_approved':bool(platform=='tiktok' and app and self.apps.get_runtime('tiktok_publishing',{}).get('client_id')==app['client_id'] and self.apps.get_runtime('tiktok_publishing',{}).get('approved')),
                'audit_reference':self.apps.get_runtime('tiktok_publishing',{}).get('reference','') if platform=='tiktok' else '',
                'status':connection['status'] if connection else 'disconnected',
                'account_id':connection['account_id'] if connection else '',
                'account_name':connection['account_name'] if connection else '',
                'accounts':connection['candidates'] if connection else [],
                'expires':connection['expires'] if connection else None,'last_sync':connection['last_sync'] if connection else None,
                'error':connection['last_error'] if connection else None,'pending_job':pending[0] if pending else None}

    def disconnect(self,platform,purge=False):
        with self.store.connect() as db:
            db.execute('DELETE FROM social_connections WHERE platform=?',(platform,))
            if purge:db.execute('DELETE FROM social_snapshots WHERE platform=?',(platform,))
        # In-flight jobs compare their connection generation before saving.

    def enqueue_sync(self,platform,days):
        connection=self.connection(platform)
        if not connection or connection['status']=='choose_account':raise SocialError('Connect and select an account first.')
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            pending=db.execute("SELECT id FROM jobs WHERE kind='social_sync' AND status IN ('queued','running') AND json_extract(payload,'$.platform')=?",(platform,)).fetchone()
            if pending:return pending[0]
            return self.store._enqueue(db,'social_sync',{'platform':platform,'days':days,'generation':connection['generation']},time.time())

    def latest(self,platform,days):
        connection=self.connection(platform)
        with self.store.connect() as db:
            row=db.execute('SELECT * FROM social_snapshots WHERE platform=? AND days=? '+
                           ('AND account_id=? ' if connection else '')+'ORDER BY created DESC LIMIT 1',
                           (platform,days,connection['account_id']) if connection else (platform,days)).fetchone()
        return {**json.loads(row['content']),'snapshot_id':row['id'],'synced_at':row['created']} if row else None

    def save_snapshot(self,job,connection,data):
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            current=db.execute('SELECT generation FROM social_connections WHERE platform=?',(connection['platform'],)).fetchone()
            owner=db.execute('SELECT token,status FROM jobs WHERE id=?',(job['id'],)).fetchone()
            if not owner or owner['token']!=job['token'] or owner['status']!='running':raise SocialError('Sync job lease changed.')
            if not current or current[0]!=connection['generation']:
                db.execute("UPDATE jobs SET status='succeeded',result=?,lease_until=NULL WHERE id=?",(json.dumps({'skipped':'Connection changed'}),job['id']));return
            snapshot_id=uuid.uuid4().hex
            db.execute('INSERT INTO social_snapshots VALUES(?,?,?,?,?,?)',(snapshot_id,connection['platform'],connection['account_id'],job['payload']['days'],json.dumps(data),time.time()))
            db.execute("UPDATE social_connections SET last_sync=?,last_error=NULL,status='connected' WHERE platform=?",(time.time(),connection['platform']))
            db.execute("UPDATE jobs SET status='succeeded',result=?,error=NULL,lease_until=NULL WHERE id=?",(json.dumps({'snapshot_id':snapshot_id}),job['id']))


def begin_oauth(root,workspace,user_id,session_token,platform,publishing=False):
    app=SocialStore(workspace).app(platform)
    if not app:raise SocialError('Configure your OAuth app before connecting.')
    if not app['redirect_uri']:raise SocialError('Save an authorized callback URI in Provider app setup first.')
    if platform=='tiktok' and not SocialStore(workspace).public(platform)['connect_ready']:raise SocialError(SocialStore(workspace).public(platform)['setup_issue'])
    state=secrets.token_urlsafe(32);ticket=secrets.token_urlsafe(32);verifier=secrets.token_urlsafe(48)
    challenge=base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
    payload={'verifier':verifier,'client_id':app['client_id'],'redirect_uri':app['redirect_uri'],'publishing':publishing}
    if platform=='tiktok':payload['login_mode']=SocialStore(workspace).public(platform)['login_mode']
    with root.connect() as db:
        db.execute('DELETE FROM social_oauth_tickets WHERE expires<?',(time.time(),))
        db.execute('INSERT INTO social_oauth_tickets VALUES(?,?,?,?,?,?,?)',
                   (digest(ticket),digest(state),user_id,digest(session_token),platform,seal(payload),time.time()+600))
    params={'client_id':app['client_id'],'redirect_uri':app['redirect_uri'],'response_type':'code','state':state}
    if platform=='youtube':
        params.update(scope=' '.join(YT_SCOPES),access_type='offline',prompt='consent',code_challenge=challenge,code_challenge_method='S256')
        url='https://accounts.google.com/o/oauth2/v2/auth'
    elif platform=='tiktok':
        params.pop('client_id');params.update(client_key=app['client_id'],scope=','.join(['user.info.basic','video.publish','video.upload'] if publishing else TT_SCOPES))
        if payload['login_mode']=='desktop':params.update(code_challenge=hashlib.sha256(verifier.encode()).hexdigest(),code_challenge_method='S256')
        url='https://www.tiktok.com/v2/auth/authorize/'
    elif platform=='linkedin':
        params.update(scope='rw_organization_admin')
        url='https://www.linkedin.com/oauth/v2/authorization'
    else:
        params.update(scope=','.join(IG_SCOPES+(['instagram_content_publish'] if publishing else [])))
        url='https://www.facebook.com/'+app['api_version']+'/dialog/oauth'
    return {'ticket':ticket,'url':url+'?'+urlencode(params)}


def consume_oauth(root,platform,ticket,state):
    if not ticket or not state or len(ticket)>200 or len(state)>200:raise SocialError('Connection verification failed. Start Connect again.')
    with root.connect() as db:
        db.execute('BEGIN IMMEDIATE')
        row=db.execute('SELECT * FROM social_oauth_tickets WHERE ticket_hash=?',(digest(ticket),)).fetchone()
        if not row or row['platform']!=platform or row['expires']<time.time() or not secrets.compare_digest(row['state_hash'],digest(state)):
            raise SocialError('Connection verification failed. Start Connect again.')
        valid=db.execute('SELECT 1 FROM user_sessions WHERE token_hash=? AND user_id=? AND expires>?',(row['session_hash'],row['user_id'],time.time())).fetchone()
        if not valid:raise SocialError('Your sign-in changed or expired. Sign in and start Connect again.')
        db.execute('DELETE FROM social_oauth_tickets WHERE ticket_hash=?',(digest(ticket),))
        return {**dict(row),'payload':unseal(row['payload'])}


def stage_oauth_return(root,platform,state,code,error):
    if not state or len(state)>200 or len(code)>4096 or len(error)>200:
        raise SocialError('Connection verification failed. Start Connect again.')
    nonce=secrets.token_urlsafe(32);now=time.time()
    with root.connect() as db:
        db.execute('BEGIN IMMEDIATE')
        row=db.execute('SELECT * FROM social_oauth_tickets WHERE state_hash=? AND platform=? AND expires>?',
                       (digest(state),platform,now)).fetchone()
        if not row:raise SocialError('This connection expired or was already completed. Start Connect again.')
        db.execute('DELETE FROM social_oauth_returns WHERE expires<? OR ticket_hash=?',(now,row['ticket_hash']))
        db.execute('INSERT INTO social_oauth_returns VALUES(?,?,?,?)',
                   (digest(nonce),row['ticket_hash'],seal({'state':state,'code':code,'error':error}),min(row['expires'],now+120)))
    return nonce


def consume_oauth_return(root,platform,nonce,user_id,session_token):
    if not nonce or len(nonce)>200:raise SocialError('Connection verification failed. Start Connect again.')
    now=time.time()
    with root.connect() as db:
        db.execute('BEGIN IMMEDIATE')
        pending=db.execute('SELECT * FROM social_oauth_returns WHERE nonce_hash=? AND expires>?',(digest(nonce),now)).fetchone()
        if not pending:raise SocialError('This connection expired or was already completed. Start Connect again.')
        ticket=db.execute('SELECT * FROM social_oauth_tickets WHERE ticket_hash=? AND platform=? AND expires>?',
                          (pending['ticket_hash'],platform,now)).fetchone()
        if not ticket:raise SocialError('This connection expired or was already completed. Start Connect again.')
        if ticket['user_id']!=user_id or not secrets.compare_digest(ticket['session_hash'],digest(session_token or '')):
            raise SocialError('This connection belongs to a different sign-in. Start Connect again.')
        valid=db.execute('SELECT 1 FROM user_sessions WHERE token_hash=? AND user_id=? AND expires>?',
                         (ticket['session_hash'],user_id,now)).fetchone()
        if not valid:raise SocialError('Your sign-in expired. Sign in and start Connect again.')
        returned=unseal(pending['payload'])
        if not secrets.compare_digest(ticket['state_hash'],digest(returned['state'])):
            raise SocialError('Connection verification failed. Start Connect again.')
        db.execute('DELETE FROM social_oauth_returns WHERE ticket_hash=?',(ticket['ticket_hash'],))
        db.execute('DELETE FROM social_oauth_tickets WHERE ticket_hash=?',(ticket['ticket_hash'],))
        return {**dict(ticket),'payload':unseal(ticket['payload']),'code':returned['code'],'error':returned['error']}


def google_error(response,url):
    """Translate allowlisted Google reasons; never surface provider messages/URLs."""
    from urllib.parse import urlsplit
    target=urlsplit(url)
    if target.hostname not in ('www.googleapis.com','youtubeanalytics.googleapis.com','oauth2.googleapis.com'):
        return None
    try:data=response.json()
    except (ValueError,TypeError):return None
    if not isinstance(data,dict):return None
    error=data.get('error')
    if target.hostname=='oauth2.googleapis.com':
        if error=='invalid_grant':return 'Google authorization expired or was already used. Start Connect YouTube again.'
        if error in ('invalid_client','unauthorized_client'):return 'Google rejected the OAuth app credentials. The installation owner needs to check Provider app setup.'
        return None
    if not isinstance(error,dict):return None
    reasons=set()
    for key in ('errors','details'):
        entries=error.get(key,[])
        if isinstance(entries,list):
            for entry in entries:
                if isinstance(entry,dict) and isinstance(entry.get('reason'),str):reasons.add(entry['reason'])
    if 'youtubeSignupRequired' in reasons:
        return 'This Google account has no YouTube channel (youtubeSignupRequired). Choose the account that owns your channel, or create a YouTube channel first, then reconnect.'
    if reasons.intersection(('accessNotConfigured','SERVICE_DISABLED')):
        api='YouTube Analytics API' if target.hostname=='youtubeanalytics.googleapis.com' else 'YouTube Data API v3'
        return f'{api} is disabled for the OAuth app project. The installation owner must enable it in Google Cloud, then retry.'
    if reasons.intersection(('insufficientPermissions','ACCESS_TOKEN_SCOPE_INSUFFICIENT')):
        return 'YouTube permissions are missing. Reconnect and allow both YouTube read-only and YouTube Analytics access.'
    if reasons.intersection(('quotaExceeded','dailyLimitExceeded','rateLimitExceeded','RATE_LIMIT_EXCEEDED')):
        return 'The Google API quota or rate limit was reached. Wait for the limit to reset or ask the installation owner to check Google Cloud quotas.'
    if reasons.intersection(('channelSuspended','channelClosed')):
        return 'YouTube reports that this channel is suspended or closed. Choose another channel account or resolve its status with YouTube.'
    return None


async def request_json(client,method,url,**kwargs):
    try:
        response=await client.request(method,url,timeout=30,**kwargs)
        if not response.is_success:
            specific=google_error(response,url)
            if specific:raise SocialError(specific)
            if response.status_code in (401,403):raise SocialError('Provider denied access. Check permissions, API enablement, app review and account eligibility; reconnect if needed.')
            raise SocialError(f'Provider request failed (HTTP {response.status_code}). Check the app configuration or retry later.')
        data=response.json()
        if not isinstance(data,dict) or ('error' in data and not (urlparse(url).hostname=='open.tiktokapis.com' and isinstance(data['error'],dict) and data['error'].get('code')=='ok')):raise SocialError('Provider returned an unsuccessful response. Check the connection permissions.')
        return data
    except (httpx.HTTPError,json.JSONDecodeError):raise SocialError('The provider could not be reached or returned invalid data. Try again later.') from None


async def exchange_code(workspace,platform,code,payload,client):
    repo=SocialStore(workspace);app=repo.app(platform)
    if not app or app['client_id']!=payload['client_id'] or app['redirect_uri']!=payload['redirect_uri']:
        raise SocialError('App settings changed during authorization. Start Connect again.')
    body={'client_id':app['client_id'],'client_secret':app['client_secret'],'redirect_uri':app['redirect_uri'],'code':code}
    if platform in ('tiktok','linkedin'):
        body['grant_type']='authorization_code'
        if platform=='tiktok':
            body['client_key']=body.pop('client_id')
            mode=repo.public('tiktok')['login_mode']
            if payload.get('login_mode','web')!=mode:raise SocialError('TikTok login mode changed during authorization. Start Connect again.')
            if mode=='desktop':body['code_verifier']=payload['verifier']
        url='https://open.tiktokapis.com/v2/oauth/token/' if platform=='tiktok' else 'https://www.linkedin.com/oauth/v2/accessToken'
        tokens=await request_json(client,'POST',url,data=body)
        if not tokens.get('access_token'):raise SocialError('The provider did not return an access token.')
        headers={'Authorization':'Bearer '+tokens['access_token']}
        if platform=='tiktok':
            granted=set(tokens.get('scope','').replace(',',' ').split())
            if payload.get('publishing'):
                if 'user.info.basic' not in granted or not granted.intersection({'video.publish','video.upload'}):raise SocialError('Grant TikTok profile access and at least one requested posting permission, then reconnect.')
            elif not {'user.info.basic','video.list'}<=granted:raise SocialError('Grant TikTok profile and public video access, then reconnect.')
            profile=(await request_json(client,'GET','https://open.tiktokapis.com/v2/user/info/',headers=headers,params={'fields':'open_id,display_name'})).get('data',{}).get('user',{})
            identifier=profile.get('open_id','');name=profile.get('display_name','TikTok account')
            if not identifier or identifier!=tokens.get('open_id'):raise SocialError('TikTok returned inconsistent account information. Reconnect.')
        else:
            accounts=await linkedin_accounts(tokens['access_token'],app,client)
            repo.connect(platform,tokens,accounts);return
        repo.connect(platform,tokens,[{'id':identifier,'name':name}]);return
    if platform=='youtube':body.update(grant_type='authorization_code',code_verifier=payload['verifier'])
    url='https://oauth2.googleapis.com/token' if platform=='youtube' else 'https://graph.facebook.com/'+app['api_version']+'/oauth/access_token'
    tokens=await request_json(client,'POST',url,data=body)
    if not tokens.get('access_token'):raise SocialError('The provider did not return an access token.')
    headers={'Authorization':'Bearer '+tokens['access_token']}
    if platform=='youtube':
        data=await request_json(client,'GET','https://www.googleapis.com/youtube/v3/channels',headers=headers,params={'part':'snippet','mine':'true','maxResults':50})
        accounts=[{'id':item['id'],'name':item.get('snippet',{}).get('title',item['id'])} for item in data.get('items',[])]
        if not accounts:
            raise SocialError('No YouTube channel was found for the Google account you selected. Choose the account that owns your channel, or create a YouTube channel first, then reconnect.')
    else:
        data=await request_json(client,'GET','https://graph.facebook.com/'+app['api_version']+'/me/accounts',headers=headers,
                                params={'fields':'id,name,instagram_business_account{id,username}','limit':100})
        accounts=[{'id':item['instagram_business_account']['id'],'name':item['instagram_business_account'].get('username',item.get('name','Instagram account'))}
                  for item in data.get('data',[]) if item.get('instagram_business_account',{}).get('id')]
    if platform=='instagram' and payload.get('publishing'):
        permissions=await request_json(client,'GET','https://graph.facebook.com/'+app['api_version']+'/me/permissions',headers=headers)
        tokens['granted_scopes']=[p['permission'] for p in permissions.get('data',[]) if p.get('status')=='granted' and isinstance(p.get('permission'),str)]
    repo.connect(platform,tokens,accounts)


async def access_token(repo,connection,client):
    if connection['expires']>time.time()+90:return connection['tokens']['access_token']
    app=repo.app(connection['platform']);tokens=connection['tokens']
    if connection['platform'] not in ('youtube','tiktok') or not tokens.get('refresh_token') or not app:
        raise SocialError('Authorization expired. Reconnect this account to continue syncing.')
    tiktok=connection['platform']=='tiktok'
    refreshed=await request_json(client,'POST','https://open.tiktokapis.com/v2/oauth/token/' if tiktok else 'https://oauth2.googleapis.com/token',data={
        'grant_type':'refresh_token','client_key' if tiktok else 'client_id':app['client_id'],'client_secret':app['client_secret'],'refresh_token':tokens['refresh_token']})
    if not refreshed.get('access_token'):raise SocialError('Token refresh failed. Reconnect the account.')
    tokens={**tokens,**refreshed};expires=time.time()+float(refreshed.get('expires_in',3600))
    with repo.store.connect() as db:db.execute('UPDATE social_connections SET tokens=?,expires=? WHERE platform=? AND generation=?',
        (seal(tokens),expires,connection['platform'],connection['generation']))
    return tokens['access_token']


def rows(data):
    names=[column['name'] for column in data.get('columnHeaders',[])]
    return [dict(zip(names,row)) for row in data.get('rows',[])]


async def youtube_analytics(connection,token,days,client):
    end=date.today()-timedelta(days=1);start=end-timedelta(days=days-1)
    metrics='views,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost,likes,comments,shares'
    base={'ids':'channel=='+connection['account_id'],'startDate':str(start),'endDate':str(end),'metrics':metrics}
    headers={'Authorization':'Bearer '+token};url='https://youtubeanalytics.googleapis.com/v2/reports'
    totals=rows(await request_json(client,'GET',url,headers=headers,params=base))
    series=rows(await request_json(client,'GET',url,headers=headers,params={**base,'dimensions':'day','sort':'day'}))
    videos=rows(await request_json(client,'GET',url,headers=headers,params={**base,'dimensions':'video','sort':'-views','maxResults':25}))
    ids=','.join(row['video'] for row in videos)
    titles={}
    if ids:
        metadata=await request_json(client,'GET','https://www.googleapis.com/youtube/v3/videos',headers=headers,params={'part':'snippet','id':ids})
        titles={item['id']:item.get('snippet',{}).get('title',item['id']) for item in metadata.get('items',[])}
    content=[{'id':row.pop('video'),'title':'','metrics':row} for row in videos]
    for item in content:item['title']=titles.get(item['id'],item['id']);item['url']='https://www.youtube.com/watch?v='+item['id']
    previous_end=start-timedelta(days=1);previous_start=previous_end-timedelta(days=days-1)
    previous=rows(await request_json(client,'GET',url,headers=headers,params={**base,'startDate':str(previous_start),'endDate':str(previous_end)}))
    return {'platform':'youtube','account_name':connection['account_name'],'account_id':connection['account_id'],
            'period':{'start':str(start),'end':str(end),'days':days},'totals':totals[0] if totals else {},
            'previous':previous[0] if previous else {},'series':series,'content':content,
            'limitations':['Official YouTube Analytics data; reporting delays and privacy thresholds may apply.','Ranked videos are limited to 25. Title/thumbnail causality and CTR are not inferred.']}


async def instagram_analytics(repo,connection,token,days,client):
    app=repo.app('instagram');base='https://graph.facebook.com/'+app['api_version']+'/'+connection['account_id']
    headers={'Authorization':'Bearer '+token};end=int(time.time());start=end-days*86400
    totals={};limitations=[]
    for metric in ('views','reach','accounts_engaged'):
        try:
            data=await request_json(client,'GET',base+'/insights',headers=headers,params={'metric':metric,'period':'day','metric_type':'total_value','since':start,'until':end})
            for item in data.get('data',[]):
                value=numeric(item.get('total_value',{}).get('value'))
                if value is not None:totals[item['name']]=value
        except SocialError:limitations.append(metric+' is unavailable for this authorization or API version.')
    media=await request_json(client,'GET',base+'/media',headers=headers,params={'fields':'id,caption,media_type,media_product_type,timestamp,permalink,like_count,comments_count','limit':25})
    content=[]
    for item in media.get('data',[]):
        stamp=str(item.get('timestamp',''))[:10]
        if stamp and stamp<str(date.fromtimestamp(start)):continue
        content.append({'id':item['id'],'title':(item.get('caption') or item.get('media_type','Instagram post'))[:300],
                        'url':item.get('permalink',''),'type':item.get('media_product_type',item.get('media_type')),
                        'published':item.get('timestamp'),'metrics':{'likes':numeric(item.get('like_count')),'comments':numeric(item.get('comments_count'))}})
    if not totals:limitations.append('Account insights are unavailable; only returned content engagement is shown.')
    return {'platform':'instagram','account_name':connection['account_name'],'account_id':connection['account_id'],
            'period':{'start':str(date.fromtimestamp(start)),'end':str(date.today()),'days':days},'totals':totals,'previous':{},'series':[],
            'content':content,'limitations':limitations+['Uses Facebook Login for a Professional Instagram account linked to a Facebook Page.','The period ends at sync time; the current day may be partial.',
            'Media sample is limited to 25 recent posts; likes/comments are current lifetime counts for those posts, not period totals.','Missing metrics are unavailable, not zero. No cross-platform engagement-rate equivalence is assumed.']}


async def tiktok_analytics(connection,token,days,client):
    headers={'Authorization':'Bearer '+token};today=datetime.now(timezone.utc).date();start=today-timedelta(days=days-1)
    granted=set(connection['tokens'].get('scope','').replace(',',' ').split())
    totals={};content=[];limitations=['TikTok Display API returns current lifetime video counts, not views earned during this date range.','The date filter selects videos by publication date. It does not filter when engagement occurred.','No watch-time, retention, daily series, or previous-period comparison is provided.']
    if 'user.info.stats' in granted:
        user=(await request_json(client,'GET','https://open.tiktokapis.com/v2/user/info/',headers=headers,params={'fields':'open_id,follower_count,following_count,likes_count,video_count'})).get('data',{}).get('user',{})
        if user.get('open_id')!=connection['account_id']:raise SocialError('TikTok account changed. Reconnect before syncing.')
        for key in ('follower_count','following_count','likes_count','video_count'):
            if numeric(user.get(key)) is not None:totals[key]=numeric(user[key])
    else:limitations.append('Follower and profile totals need the optional user.info.stats permission; it was not granted.')
    cursor=None;finished=False
    for _ in range(20):
        body={'max_count':20,**({'cursor':cursor} if cursor is not None else {})}
        result=await request_json(client,'POST','https://open.tiktokapis.com/v2/video/list/',headers=headers,params={'fields':'id,title,create_time,share_url,view_count,like_count,comment_count,share_count'},json=body)
        data=result.get('data',{});videos=data.get('videos',[])
        for row in videos:
            try:published=datetime.fromtimestamp(float(row['create_time']),timezone.utc).date()
            except (KeyError,ValueError,TypeError,OverflowError):continue
            if start<=published<=today:
                content.append({'id':row['id'],'title':row.get('title','TikTok video'),'url':row.get('share_url',''),'published':str(published),'metrics':{key:numeric(row.get(source)) for key,source in [('views','view_count'),('likes','like_count'),('comments','comment_count'),('shares','share_count')]}})
        older=bool(videos) and all(numeric(r.get('create_time')) is not None and float(r['create_time'])<datetime.combine(start,datetime.min.time(),tzinfo=timezone.utc).timestamp() for r in videos)
        if not data.get('has_more') or older:finished=True;break
        next_cursor=data.get('cursor')
        if not isinstance(next_cursor,int) or next_cursor==cursor:raise SocialError('TikTok returned an invalid video pagination cursor. Retry later.')
        cursor=next_cursor
    if not finished:limitations.append('Video sample capped at 400 recent public videos; this date range may be incomplete.')
    for metric in ('views','likes','comments','shares'):
        if content and all(row['metrics'][metric] is not None for row in content):totals[metric]=sum(row['metrics'][metric] for row in content)
    return {'platform':'tiktok','account_name':connection['account_name'],'account_id':connection['account_id'],'period':{'start':str(start),'end':str(today),'days':days},'totals':totals,'previous':{},'series':[],'content':content,'limitations':limitations,'metric_basis':'lifetime_for_published_videos'}


def linkedin_headers(token,app):
    version=app.get('api_version','')
    return {'Authorization':'Bearer '+token,'LinkedIn-Version':version if re.fullmatch(r'20\d{4}',version) else '202602','X-Restli-Protocol-Version':'2.0.0'}


async def linkedin_accounts(token,app,client):
    headers=linkedin_headers(token,app);accounts={};start=0
    for _ in range(20):
        data=await request_json(client,'GET','https://api.linkedin.com/rest/organizationAcls',headers=headers,params={'q':'roleAssignee','role':'ADMINISTRATOR','state':'APPROVED','count':100,'start':start})
        for row in data.get('elements',[]):
            if row.get('role')!='ADMINISTRATOR' or row.get('state')!='APPROVED':continue
            urn=row.get('organization') or row.get('organizationTarget','')
            match=re.fullmatch(r'urn:li:organization:([0-9]{1,32})',urn)
            if not match or match[1] in accounts:continue
            org=await request_json(client,'GET','https://api.linkedin.com/rest/organizations/'+match[1],headers=headers)
            accounts[match[1]]={'id':match[1],'name':org.get('localizedName') or 'LinkedIn Page '+match[1]}
        if not any(link.get('rel')=='next' for link in data.get('paging',{}).get('links',[])):
            if not accounts:raise SocialError('No approved LinkedIn company Page administrator access was returned. Use a Page admin account and an app approved for Community Management with rw_organization_admin.')
            return list(accounts.values())
        count=data.get('paging',{}).get('count',len(data.get('elements',[])))
        if not isinstance(count,int) or count<1:raise SocialError('LinkedIn returned invalid Page pagination. Retry later.')
        start+=count
    raise SocialError('Too many LinkedIn Pages to list. Contact your installation owner.')


async def linkedin_analytics(repo,connection,token,days,client):
    finish=datetime.combine(datetime.now(timezone.utc).date(),datetime.min.time(),tzinfo=timezone.utc);start=finish-timedelta(days=days)
    urn='urn:li:organization:'+connection['account_id']
    data=await request_json(client,'GET','https://api.linkedin.com/rest/organizationalEntityShareStatistics',headers=linkedin_headers(token,repo.app('linkedin')),params={'q':'organizationalEntity','organizationalEntity':urn,'timeIntervals':f'(timeRange:(start:{int(start.timestamp()*1000)},end:{int(finish.timestamp()*1000)}),timeGranularityType:DAY)'})
    rows=data.get('elements',[]);series=[];totals={}
    for row in rows:
        if row.get('organizationalEntity')!=urn:raise SocialError('LinkedIn returned statistics for a different Page. Reconnect.')
        stats=row.get('totalShareStatistics',{});stamp=row.get('timeRange',{}).get('start')
        if stamp is not None:
            try:day=datetime.fromtimestamp(float(stamp)/1000,timezone.utc).date()
            except (ValueError,TypeError,OverflowError):raise SocialError('LinkedIn returned invalid reporting dates.') from None
            if not start.date()<=day<finish.date():raise SocialError('LinkedIn returned statistics outside the requested dates.')
            series.append({'day':str(day),'impressions':numeric(stats.get('impressionCount'))})
    for field,source in [('impressions','impressionCount'),('clicks','clickCount'),('likes','likeCount'),('comments','commentCount'),('shares','shareCount')]:
        values=[numeric(row.get('totalShareStatistics',{}).get(source)) for row in rows]
        if values and all(v is not None for v in values):totals[field]=sum(values)
    return {'platform':'linkedin','account_name':connection['account_name'],'account_id':connection['account_id'],'period':{'start':str(start.date()),'end':str((finish-timedelta(days=1)).date()),'days':days},'totals':totals,'previous':{},'series':sorted(series,key=lambda r:r['day']),'content':[],'metric_basis':'organization_organic_period',
            'limitations':['Company Page organic share statistics only; sponsored activity is excluded.','Reporting dates use complete UTC days. No per-post ranking, follower statistics, personal-profile analytics or previous-period comparison is fetched.','Unique impressions are not summed across days. Missing metrics remain unavailable.','LinkedIn requires approved Community Management access and rw_organization_admin. That provider scope includes management capabilities, but Spur Ring only performs read requests.']}


async def sync(store,job,client):
    repo=SocialStore(store);platform=job['payload']['platform'];connection=repo.connection(platform)
    if not connection or connection['generation']!=job['payload']['generation']:
        store.finish(job,{'skipped':'Connection changed'});return
    store.record_event(job,'action','Syncing authorized social analytics',{'platform':platform,'days':job['payload']['days']})
    try:
        token=await access_token(repo,connection,client)
        if platform=='youtube':data=await youtube_analytics(connection,token,job['payload']['days'],client)
        elif platform=='instagram':data=await instagram_analytics(repo,connection,token,job['payload']['days'],client)
        elif platform=='tiktok':data=await tiktok_analytics(connection,token,job['payload']['days'],client)
        elif platform=='linkedin':data=await linkedin_analytics(repo,connection,token,job['payload']['days'],client)
        else:raise SocialError('Unsupported social platform.')
        repo.save_snapshot(job,connection,data)
    except SocialError as error:
        with store.connect() as db:db.execute('UPDATE social_connections SET last_error=? WHERE platform=? AND generation=?',(str(error),platform,connection['generation']))
        raise


def analytics_brief(snapshot):
    """Deterministic, evidence-labelled observations; no model billing required."""
    if not snapshot:raise SocialError('Sync analytics before creating a brief.')
    points=[]
    for key,value in snapshot['totals'].items():
        current=numeric(value);previous=numeric(snapshot.get('previous',{}).get(key))
        if current is None:continue
        point={'metric':key,'value':current}
        if previous is not None and previous>0:point['change_percent']=round((current-previous)/previous*100,1)
        points.append(point)
    ranked=sorted(snapshot['content'],key=lambda item:numeric(item['metrics'].get('views')) or numeric(item['metrics'].get('likes')) or 0,reverse=True)[:5]
    return {'platform':snapshot['platform'],'account_name':snapshot['account_name'],'period':snapshot['period'],
            'snapshot_id':snapshot.get('snapshot_id'),'synced_at':snapshot.get('synced_at'),
            'observations':points,'top_content':ranked,'limitations':snapshot['limitations'],
            'next_steps':['Review the strongest content and propose follow-up concepts with Marketing Lead.','Compare like-for-like periods and content age before drawing conclusions.','Treat proposed causes as hypotheses to test, not proven explanations.']}
