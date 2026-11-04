"""Opt-in, bounded anonymous HTML collector. Never follows challenges or logs in."""
import asyncio,json,re,time
from html.parser import HTMLParser
from urllib.parse import urlparse
from urllib.robotparser import RobotFileParser
from spur.video_search import SearchError,normalize,count

INTERVAL=86400
USER_AGENT='SpurRingPublicCollector/0.1'
STATE_KEY='instagram_public_page_attempt'


class PublicPageBlocked(SearchError):pass


class Scripts(HTMLParser):
    def __init__(self):super().__init__();self.active=False;self.parts=[];self.documents=[]
    def handle_starttag(self,tag,attrs):
        attrs=dict(attrs)
        if tag=='script':self.active=attrs.get('type','').lower() in ('application/json','application/ld+json');self.parts=[]
    def handle_data(self,data):
        if self.active:self.parts.append(data)
    def handle_endtag(self,tag):
        if tag=='script' and self.active:
            try:self.documents.append(json.loads(''.join(self.parts)))
            except (ValueError,RecursionError):pass
            self.active=False;self.parts=[]


def media_url(value):
    try:
        u=urlparse(value)
        if u.scheme=='https' and not u.username and not u.password and u.port in (None,443) and any(u.hostname==host or u.hostname.endswith('.'+host) for host in ('cdninstagram.com','fbcdn.net')):return value
    except (ValueError,TypeError,AttributeError):pass
    return ''


def parse_html(html,username):
    if any(marker in html.lower() for marker in ('/challenge/','/checkpoint/','"is_private":true','"is_private": true')):
        raise PublicPageBlocked('Public page indicates a challenge or private account. Collection stopped.')
    parser=Scripts();parser.feed(html);found={};visited=0;observed=time.time()
    def walk(value,owner='',depth=0):
        nonlocal visited
        if depth>60:return
        if isinstance(value,list):
            for child in value:walk(child,owner,depth+1)
        elif isinstance(value,dict):
            owner=str(value.get('username') or (value.get('owner') or {}).get('username') or (value.get('user') or {}).get('username') or owner)
            code=value.get('shortcode') or value.get('code')
            if code and owner.casefold()==username.casefold():
                visited+=1
                caption=value.get('caption') or {}
                edges=(value.get('edge_media_to_caption') or {}).get('edges') or []
                if edges:caption={'text':(edges[0].get('node') or {}).get('text','')}
                kind=2 if value.get('is_video') or value.get('__typename')=='GraphVideo' else 8 if value.get('__typename')=='GraphSidecar' else value.get('media_type',1)
                native={**value,'code':code,'caption':caption,'user':{'username':owner},'media_type':kind,
                    'like_count':value.get('like_count',(value.get('edge_media_preview_like') or {}).get('count')),
                    'comment_count':value.get('comment_count',(value.get('edge_media_to_comment') or {}).get('count')),
                    'view_count':value.get('video_view_count',value.get('view_count')),'thumbnail_url':value.get('display_url') or value.get('thumbnail_src') or ''}
                row=normalize('instagram',native)
                if row and re.fullmatch(r'[A-Za-z0-9_-]{1,100}',row['id']):
                    row.update(description=row['title'],platform='instagram',provider='instagram_public_page',observed_at=observed,
                        media_type=kind,format='video' if kind==2 else 'image',duration_seconds=count(value.get('video_duration')),
                        media_url=media_url(value.get('video_url','')),detail_status='public_page',metric_basis='anonymous_public_page_snapshot')
                    found[row['id']]=row
            if len(found)<100:
                for child in value.values():
                    if isinstance(child,(dict,list)):walk(child,owner,depth+1)
    for doc in parser.documents:walk(doc)
    if not found:raise PublicPageBlocked('This public page did not expose usable posts for the requested creator. It may require login or client-side access. No alternate endpoints or login attempts were made.')
    return {'rows':list(found.values())[:100],'visited':visited,'cursor':None,'partial':True,
            'warning':'Public HTML snapshot only. Pagination and complete historical coverage are not available. No video files were downloaded.'}


def reserve(parent):
    root=getattr(parent,'platform_store',parent);now=time.time()
    with root.connect() as db:
        db.execute('BEGIN IMMEDIATE');row=db.execute('SELECT value FROM runtime WHERE key=?',(STATE_KEY,)).fetchone()
        old=json.loads(row[0]) if row else {}
        if now-old.get('at',0)<INTERVAL:raise PublicPageBlocked('Public-page cooldown is active: at most one attempt per 24 hours across this installation. No request was made.')
        db.execute('INSERT OR REPLACE INTO runtime VALUES(?,?)',(STATE_KEY,json.dumps({'at':now})))


async def fetch(client,url,limit):
    async with asyncio.timeout(20):
        async with client.stream('GET',url,headers={'User-Agent':USER_AGENT,'Cookie':'','Accept':'text/html,text/plain'},auth=None,follow_redirects=False,timeout=15) as response:
            if response.status_code!=200:raise PublicPageBlocked('Public collection stopped at HTTP '+str(response.status_code)+'. Redirects, login requirements, rate limits and access blocks are not followed or retried.')
            result=bytearray()
            async for chunk in response.aiter_bytes():
                result.extend(chunk)
                if len(result)>limit:raise PublicPageBlocked('Public response exceeded the bounded download limit. Collection stopped.')
            return result.decode('utf-8',errors='replace')


async def page(parent,username,client):
    if not re.fullmatch(r'[A-Za-z0-9_.]{1,30}',username):raise SearchError('Enter a valid public Instagram handle.')
    reserve(parent)
    robots=await fetch(client,'https://www.instagram.com/robots.txt',128000)
    rules=RobotFileParser();rules.parse(robots.splitlines());target='https://www.instagram.com/'+username+'/'
    if not rules.can_fetch(USER_AGENT,target):raise PublicPageBlocked('Instagram robots.txt disallows this collector for the profile path. No profile request was made.')
    html=await fetch(client,target,2_000_000)
    return parse_html(html,username)
