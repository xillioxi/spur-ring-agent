"""Provider-backed discovery. No model-generated results and no direct social scraping."""
import json
import hashlib
import math
import re
import time
import uuid
from datetime import datetime,timedelta,timezone
from urllib.parse import urlparse

from pydantic import BaseModel,Field,ConfigDict
from typing import Literal
from spur.social import SocialStore,SocialError,access_token,request_json,seal,unseal

PLATFORMS=('youtube','tiktok','instagram','rednote','linkedin')
SCHEMA='''
CREATE TABLE IF NOT EXISTS discovery_provider(provider TEXT PRIMARY KEY,secret BLOB NOT NULL,settings TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS discovery_requests(id INTEGER PRIMARY KEY,provider TEXT NOT NULL,platform TEXT NOT NULL,created REAL NOT NULL,reserved_usd REAL NOT NULL,status TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS discovery_requests_created ON discovery_requests(provider,created);
CREATE TABLE IF NOT EXISTS discovery_tool_calls(call_key TEXT PRIMARY KEY,created REAL NOT NULL,result TEXT,error TEXT);
CREATE TABLE IF NOT EXISTS discovery_runs(id TEXT PRIMARY KEY,created REAL NOT NULL,expires REAL NOT NULL,payload TEXT NOT NULL);
'''


class SearchError(ValueError):pass


class SearchInput(BaseModel):
    model_config=ConfigDict(extra='forbid')
    platform:Literal['youtube','tiktok','instagram','rednote','linkedin']='youtube'
    query:str=Field(min_length=2,max_length=150)
    days:int=Field(default=7,ge=1,le=90)
    limit:int=Field(default=20,ge=1,le=20)


class DataProviderInput(BaseModel):
    api_key:str=Field(default='',max_length=500)
    enabled:bool=False
    monthly_budget_usd:float=Field(default=25,gt=0,le=25)
    max_request_cost_usd:float=Field(default=0,ge=0,le=25)
    monthly_requests:int=Field(default=250,ge=1,le=2500)
    daily_requests:int=Field(default=20,ge=1,le=250)


class SearchStore:
    def __init__(self,store):
        self.store=store
        with store.connect() as db:db.executescript(SCHEMA)

    def save_run(self,result):
        identifier=uuid.uuid4().hex;now=time.time()
        with self.store.connect() as db:
            db.execute('DELETE FROM discovery_runs WHERE expires<?',(now,))
            db.execute('INSERT INTO discovery_runs VALUES(?,?,?,?)',(identifier,now,now+29*86400,json.dumps(result)))
        return identifier

    def run(self,identifier):
        with self.store.connect() as db:row=db.execute('SELECT * FROM discovery_runs WHERE id=? AND expires>?',(identifier,time.time())).fetchone()
        if not row:raise SearchError('Search snapshot not found in this workspace or expired. Run a fresh search.')
        return {**json.loads(row['payload']),'search_id':identifier,'expires_at':row['expires']}

    def runs(self):
        with self.store.connect() as db:
            return [dict(r) for r in db.execute("SELECT id,created,json_extract(payload,'$.query') AS query,json_extract(payload,'$.platform') AS platform FROM discovery_runs WHERE expires>? ORDER BY created DESC LIMIT 20",(time.time(),))]

    def config(self):
        with self.store.connect() as db:row=db.execute("SELECT * FROM discovery_provider WHERE provider='tikhub'").fetchone()
        return ({**json.loads(row['settings']),'api_key':unseal(row['secret'])['key']} if row else {**DataProviderInput().model_dump(),'api_key':''})

    def save(self,value):
        old=self.config();key=value.api_key.strip() or old['api_key']
        if key and (len(key)<8 or re.search(r'[\s\x00-\x1f]',key)):raise SearchError('Enter a valid provider API key without whitespace.')
        if value.enabled and (not key or value.max_request_cost_usd<=0):raise SearchError('Enter an API key and verify the maximum per-request price before enabling paid discovery.')
        data=value.model_dump();data.pop('api_key')
        with self.store.connect() as db:db.execute('INSERT OR REPLACE INTO discovery_provider VALUES(?,?,?)',('tikhub',seal({'key':key}),json.dumps(data)))

    def usage(self):
        now=datetime.now(timezone(timedelta(hours=8)))
        month=now.replace(day=1,hour=0,minute=0,second=0,microsecond=0).timestamp()
        day=now.replace(hour=0,minute=0,second=0,microsecond=0).timestamp()
        with self.store.connect() as db:
            row=db.execute("SELECT COUNT(*) AS requests,COALESCE(SUM(reserved_usd),0) AS reserved,COALESCE(SUM(created>=?),0) AS today FROM discovery_requests WHERE provider='tikhub' AND created>=?",(day,month)).fetchone()
        return {'month':now.strftime('%Y-%m'),'timezone':'Asia/Hong_Kong','requests':row['requests'],'today':row['today'],'reserved_usd':round(row['reserved'],6)}

    def public(self):
        c=self.config();c['configured']=bool(c.pop('api_key'));c['usage']=self.usage();return c

    def reserve(self,platform):
        c=self.config()
        if not c['enabled'] or not c['api_key']:raise SearchError('Configure and enable TikHub in Search data settings first. No paid request was made.')
        if c['max_request_cost_usd']<=0:raise SearchError('Verify the provider request price before searching.')
        now=datetime.now(timezone(timedelta(hours=8)));month=now.replace(day=1,hour=0,minute=0,second=0,microsecond=0).timestamp();day=now.replace(hour=0,minute=0,second=0,microsecond=0).timestamp()
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            usage=db.execute("SELECT COUNT(*),COALESCE(SUM(reserved_usd),0),COALESCE(SUM(created>=?),0) FROM discovery_requests WHERE provider='tikhub' AND created>=?",(day,month)).fetchone()
            if usage[0]>=c['monthly_requests'] or usage[2]>=c['daily_requests']:raise SearchError('Discovery request limit reached. Increase the limit deliberately or wait for the next reset.')
            if usage[1]+c['max_request_cost_usd']>c['monthly_budget_usd']+0.0000001:raise SearchError('Estimated monthly data budget reached. No paid request was made.')
            request_id=db.execute('INSERT INTO discovery_requests(provider,platform,created,reserved_usd,status) VALUES(?,?,?,?,?)',('tikhub',platform,time.time(),c['max_request_cost_usd'],'reserved')).lastrowid
        return request_id,c['api_key']

    def finish(self,request_id,status):
        with self.store.connect() as db:db.execute('UPDATE discovery_requests SET status=? WHERE id=?',(status,request_id))


def count(value):
    if isinstance(value,bool):return None
    try:
        number=float(value)
        return int(number) if math.isfinite(number) and number>=0 and number.is_integer() else None
    except (TypeError,ValueError,OverflowError):return None


def timestamp(value):
    try:
        if isinstance(value,(int,float)) or isinstance(value,str) and value.isdigit():
            stamp=float(value);return stamp/1000 if stamp>100000000000 else stamp
        result=datetime.fromisoformat(str(value).replace('Z','+00:00'))
        return result.timestamp() if result.tzinfo else None
    except (ValueError,TypeError,OverflowError,OSError):return None


def safe_url(value,platform):
    try:
        u=urlparse(value)
        domains={'youtube':('youtube.com','youtu.be'),'tiktok':('tiktok.com',),'instagram':('instagram.com',),'rednote':('xiaohongshu.com','xhslink.com')}[platform]
        if u.scheme=='https' and not u.username and not u.password and u.port in (None,443) and any(u.hostname==d or u.hostname.endswith('.'+d) for d in domains):return value
    except (ValueError,TypeError,AttributeError,KeyError):pass
    return ''


def image_url(value):
    if isinstance(value,dict):value=value.get('url') or next(iter(value.get('url_list',[])),None)
    if isinstance(value,list):value=value[0] if value else ''
    return value if isinstance(value,str) and value.startswith('https://') else ''


def normalize(platform,row):
    if not isinstance(row,dict):return None
    if platform=='tiktok':
        r=row.get('aweme_info') or row.get('item') or row;identifier=str(r.get('aweme_id') or r.get('id') or '')
        if not identifier or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}',identifier):return None
        author=r.get('author') or {};stats=r.get('statistics') or r.get('stats') or {};video=r.get('video') or {}
        handle=author.get('unique_id') or author.get('uniqueId')
        url=safe_url(r.get('share_url',''),'tiktok') or ('https://www.tiktok.com/@'+str(handle)+'/video/'+identifier if handle and re.fullmatch(r'[A-Za-z0-9_.]{1,100}',str(handle)) else '')
        return {'id':identifier,'title':r.get('desc') or r.get('title') or 'TikTok video','creator':author.get('nickname') or handle or '', 'url':url,'thumbnail':image_url(video.get('cover') or video.get('dynamic_cover')),'published':timestamp(r.get('create_time') or r.get('createTime')),'metrics':{'views':count(stats.get('play_count',stats.get('playCount'))),'likes':count(stats.get('digg_count',stats.get('diggCount'))),'comments':count(stats.get('comment_count',stats.get('commentCount'))),'shares':count(stats.get('share_count',stats.get('shareCount')))},'format':'video'}
    if platform=='instagram':
        r=row.get('media') or row;identifier=str(r.get('id') or r.get('pk') or '')
        if not identifier:return None
        user=r.get('user') or {};code=r.get('code') or r.get('shortcode') or '';caption=r.get('caption') or {}
        title=caption.get('text','') if isinstance(caption,dict) else str(caption)
        candidates=(r.get('image_versions2') or {}).get('candidates') or []
        kind='video' if r.get('media_type',2)==2 else 'image'
        url=safe_url(r.get('url',''),'instagram') or ('https://www.instagram.com/'+('reel/' if kind=='video' else 'p/')+str(code)+'/' if re.fullmatch(r'[A-Za-z0-9_-]{1,100}',str(code)) else '')
        return {'id':identifier,'title':title or 'Instagram post','creator':user.get('username',''),'url':url,'thumbnail':image_url(candidates[0] if candidates else r.get('thumbnail_url')),'published':timestamp(r.get('taken_at') or r.get('taken_at_timestamp')),'metrics':{'views':count(r.get('play_count',r.get('view_count'))),'likes':count(r.get('like_count')),'comments':count(r.get('comment_count'))},'format':kind}
    r=row.get('note_card') or row;identifier=str(r.get('note_id') or r.get('id') or row.get('id') or '')
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}',identifier):return None
    stats=r.get('interact_info') or {};user=r.get('user') or {};cover=r.get('cover') or {}
    return {'id':identifier,'title':r.get('display_title') or r.get('title') or 'Rednote note','creator':user.get('nickname',''),'url':safe_url(r.get('share_url',''),'rednote') or 'https://www.xiaohongshu.com/explore/'+identifier,'thumbnail':image_url(cover.get('url_default') or cover.get('url') or r.get('image_list',[])[:1]),'published':timestamp(r.get('time') or r.get('publish_time')),'metrics':{'views':None,'likes':count(stats.get('liked_count')),'comments':count(stats.get('comment_count')),'saves':count(stats.get('collected_count'))},'format':'video' if r.get('type')=='video' else 'note'}


def unpack(platform,payload):
    data=payload.get('data')
    if not isinstance(data,dict):raise SearchError('Provider response format was not recognized. This is a connector error, not an empty search.')
    candidates=[]
    if platform=='tiktok':candidates=[data.get('item_list'),data.get('aweme_list'),data.get('data')]
    elif platform=='instagram':candidates=[data.get('items'),data.get('data',{}).get('items') if isinstance(data.get('data'),dict) else None]
    else:candidates=[data.get('items'),data.get('notes'),data.get('data',{}).get('items') if isinstance(data.get('data'),dict) else None]
    rows=next((r for r in candidates if isinstance(r,list)),None)
    if rows is None:raise SearchError('Provider response format was not recognized. This is a connector error, not an empty search.')
    result=[n for r in rows if (n:=normalize(platform,r))]
    if rows and not result:raise SearchError('Provider returned records in an unsupported format. No results were invented; this connector needs a response sample.')
    return result,len(rows)-len(result)


async def search_once(store,value,client,request_key):
    """Worker retries cannot silently repeat a paid search after an uncertain outcome."""
    repo=SearchStore(store);key=hashlib.sha256((request_key+json.dumps(value.model_dump(),sort_keys=True)).encode()).hexdigest()
    with store.connect() as db:
        db.execute('BEGIN IMMEDIATE')
        db.execute('DELETE FROM discovery_tool_calls WHERE created<?',(time.time()-29*86400,))
        row=db.execute('SELECT * FROM discovery_tool_calls WHERE call_key=?',(key,)).fetchone()
        if row:
            if row['error']:raise SearchError(row['error'])
            if row['result'] and row['created']>time.time()-1800:return json.loads(row['result'])
            raise SearchError('This search was already attempted; its result is pending, uncertain or expired. No automatic paid retry was made. Ask for a new search to retry.')
        db.execute('INSERT INTO discovery_tool_calls(call_key,created) VALUES(?,?)',(key,time.time()))
    try:result=await search_videos(store,value,client)
    except (SearchError,SocialError) as error:
        with store.connect() as db:db.execute('UPDATE discovery_tool_calls SET error=? WHERE call_key=?',(str(error),key))
        raise
    with store.connect() as db:db.execute('UPDATE discovery_tool_calls SET result=? WHERE call_key=?',(json.dumps(result),key))
    return result


async def search_videos(store,value,client):
    if getattr(store,'mock_profile',None):
        from spur.mock_profiles import local_search
        return local_search(store,value)
    query=value.query.strip()
    if len(query)<2:raise SearchError('Enter at least two characters to search.')
    if value.platform=='linkedin':raise SearchError('Broad LinkedIn topic discovery is not configured. Company Page analytics is a separate connection.')
    observed=time.time();cutoff=observed-value.days*86400
    warnings=[]
    if value.platform=='youtube':
        repo=SocialStore(store);connection=repo.connection('youtube')
        if not connection or connection['status']!='connected':raise SearchError('Connect YouTube in Platforms first to use official video search.')
        token=await access_token(repo,connection,client);headers={'Authorization':'Bearer '+token}
        response=await request_json(client,'GET','https://www.googleapis.com/youtube/v3/search',headers=headers,params={'part':'snippet','type':'video','q':query,'publishedAfter':datetime.fromtimestamp(cutoff,timezone.utc).isoformat(),'maxResults':value.limit,'order':'relevance'})
        ids=[r.get('id',{}).get('videoId') for r in response.get('items',[])];ids=[i for i in ids if isinstance(i,str) and re.fullmatch(r'[A-Za-z0-9_-]{11}',i)]
        records=[]
        if ids:
            details=await request_json(client,'GET','https://www.googleapis.com/youtube/v3/videos',headers=headers,params={'part':'snippet,statistics,contentDetails','id':','.join(ids)})
            for r in details.get('items',[]):
                s=r.get('snippet') or {};stats=r.get('statistics') or {};thumb=s.get('thumbnails') or {}
                records.append({'id':r['id'],'title':s.get('title','YouTube video'),'creator':s.get('channelTitle',''),'duration':r.get('contentDetails',{}).get('duration'),'url':'https://www.youtube.com/watch?v='+r['id'],'thumbnail':image_url(thumb.get('medium') or thumb.get('default')),'published':timestamp(s.get('publishedAt')),'metrics':{k:count(stats.get(v)) for k,v in [('views','viewCount'),('likes','likeCount'),('comments','commentCount')]},'format':'video'})
        provider='youtube_official';warnings.append('One search page; not exhaustive. Counts are current lifetime public counts. No transcript or video-content analysis was performed.')
        if response.get('nextPageToken'):warnings.append('More search pages exist; this bounded search did not fetch them.')
    else:
        repo=SearchStore(store);request_id,key=repo.reserve(value.platform)
        paths={'tiktok':'/api/v1/tiktok/web/fetch_search_video','instagram':'/api/v1/instagram/v2/search_reels','rednote':'/api/v1/xiaohongshu/app_v2/search_notes'}
        params={'keyword':query}
        if value.platform=='tiktok':params.update(count=value.limit,offset=0)
        if value.platform=='rednote':params.update(page=1,sort_type='time_descending')
        try:
            response=await client.get('https://api.tikhub.io'+paths[value.platform],headers={'Authorization':'Bearer '+key},params=params,timeout=45,follow_redirects=False)
            if not response.is_success:raise SearchError(f'Data provider request failed (HTTP {response.status_code}). Check the key, balance and endpoint access. The attempt remains counted against local limits.')
            payload=response.json()
            if not isinstance(payload,dict) or payload.get('code') not in (200,0):raise SearchError('Data provider reported an unsuccessful request. No empty result was substituted.')
            records,skipped=unpack(value.platform,payload);repo.finish(request_id,'succeeded')
        except Exception as exc:
            repo.finish(request_id,'failed')
            if isinstance(exc,SearchError):raise
            raise SearchError('Data provider could not be reached or returned invalid data. No automatic paid retry was made.') from None
        provider='tikhub';warnings.extend(['Third-party live search, not a complete platform database. Endpoint shapes require validation with your provider account.','One page only; no automatic paid pagination or retries. Unknown publication dates remain visible and are marked unverified.','Local estimated reservations are not an invoice or a provider-enforced billing cap. Set a balance/spending cap with the provider and verify request prices.'])
        if value.platform=='instagram':warnings.append('TikHub documents that Instagram V2 statistics may lag by days. Collection time is not the underlying metric-update time.')
        if skipped:warnings.append(f'{skipped} unsupported result records were skipped.')
    seen=set();items=[]
    for row in records:
        if row['id'] in seen:continue
        seen.add(row['id'])
        if row['published'] is not None and row['published']<cutoff:continue
        items.append({**row,'platform':value.platform,'provider':provider,'observed_at':observed,'date_verified':row['published'] is not None,'metric_basis':'current_lifetime_counts'})
    result={'query':query,'platform':value.platform,'provider':provider,'items':items[:value.limit],'observed_at':observed,'window_days':value.days,'warnings':warnings,'coverage':'one_page','status':'results' if items else 'no_results'}
    from spur.metadata_reports import permissions
    result['derived_analytics_allowed']=value.platform!='youtube' or permissions(store)['youtube_approved']
    result['search_id']=SearchStore(store).save_run(result)
    return result
