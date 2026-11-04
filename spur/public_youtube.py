"""Anonymous, metadata-only catalog import. Never loads browser cookies or downloads media."""
import asyncio
import re
import time
from yt_dlp import YoutubeDL
from yt_dlp.utils import DownloadError
from spur.video_search import SearchError,count,image_url

TABS=('videos','shorts','streams')

class QuietLog:
    def debug(self,message):pass
    def warning(self,message):pass
    def error(self,message):pass


def extract_page(source,cursor=None):
    if not re.fullmatch(r'(UC[A-Za-z0-9_-]{22}|@[A-Za-z0-9_.-]{1,100})',source):raise SearchError('Invalid public channel reference.')
    position=cursor or {'tab':0,'offset':0};tab=position['tab'];offset=position['offset']
    if tab not in range(3) or offset<0:raise SearchError('Invalid catalog checkpoint.')
    base='https://www.youtube.com/'+('channel/'+source if source.startswith('UC') else source)
    options={'extract_flat':True,'skip_download':True,'quiet':True,'logger':QuietLog(),'lazy_playlist':True,
             'playlist_items':f'{offset+1}:{offset+50}','socket_timeout':20,'retries':0,'extractor_retries':0,
             'ignoreerrors':False,'cachedir':False,'noplaylist':False}
    try:
        with YoutubeDL(options) as ydl:
            result=ydl.extract_info(base+'/'+TABS[tab],download=False)
            if not result or 'entries' not in result:raise SearchError('YouTube returned no readable catalog. Import was not marked complete.')
            entries=list(result['entries'])
    except DownloadError as error:
        message=str(error)
        if 'does not have a '+TABS[tab]+' tab' in message or 'does not have a '+TABS[tab].rstrip('s')+' tab' in message:
            result={};entries=[]
        else:raise SearchError('Public YouTube import failed: '+message[:400]) from error
    observed=time.time();rows=[]
    for entry in entries:
        if not entry or not re.fullmatch(r'[A-Za-z0-9_-]{11}',str(entry.get('id',''))):continue
        if entry.get('availability') in ('private','premium_only','subscriber_only','needs_auth'):continue
        identifier=entry['id'];thumbs=entry.get('thumbnails') or []
        rows.append({'id':identifier,'title':str(entry.get('title') or identifier)[:1000],'description':str(entry.get('description') or '')[:12000],
            'creator':entry.get('channel') or result.get('channel') or result.get('uploader') or source,'platform':'youtube','provider':'youtube_public',
            'url':'https://www.youtube.com/watch?v='+identifier,'thumbnail':image_url(thumbs[-1]) if thumbs else '',
            'published':entry.get('timestamp') or entry.get('release_timestamp'), 'observed_at':observed,'duration_seconds':entry.get('duration'),
            'metrics':{'views':count(entry.get('view_count')),'likes':count(entry.get('like_count')),'comments':count(entry.get('comment_count'))},
            'format':'short' if tab==1 else 'live' if tab==2 else 'video','date_status':'provider_timestamp' if entry.get('timestamp') else 'unavailable'})
    next_cursor={'tab':tab,'offset':offset+50} if len(entries)==50 else {'tab':tab+1,'offset':0} if tab<2 else None
    return {'rows':rows,'cursor':next_cursor,'visited':len(entries),'name':result.get('channel') or result.get('uploader'),'channel_id':result.get('channel_id'),'tab':TABS[tab]}


async def public_page(source,cursor=None):
    return await asyncio.to_thread(extract_page,source,cursor)


def extract_video(identifier):
    if not re.fullmatch(r'[A-Za-z0-9_-]{11}',identifier):raise SearchError('Invalid video ID.')
    options={'skip_download':True,'quiet':True,'logger':QuietLog(),'socket_timeout':20,'retries':0,'extractor_retries':0,
        'cachedir':False,'noplaylist':True,'ignore_no_formats_error':True,'getcomments':False,
        'extractor_args':{'youtube':{'skip':['hls','dash']}}}
    try:
        with YoutubeDL(options) as ydl:result=ydl.extract_info('https://www.youtube.com/watch?v='+identifier,download=False)
    except DownloadError as error:raise SearchError(str(error)[:500]) from error
    if not result or result.get('id')!=identifier:raise SearchError('No matching video details returned.')
    published=result.get('timestamp') or result.get('release_timestamp')
    precision='timestamp' if published else 'unavailable'
    if not published and result.get('upload_date'):
        from datetime import datetime,timezone
        try:published=datetime.strptime(result['upload_date'],'%Y%m%d').replace(tzinfo=timezone.utc).timestamp();precision='day'
        except ValueError:pass
    thumbs=result.get('thumbnails') or []
    return {'id':identifier,'title':str(result.get('title') or identifier)[:1000],'description':str(result.get('description') or '')[:12000],
        'published':published,'publication_precision':precision,'observed_at':time.time(),'duration_seconds':result.get('duration'),
        'metrics':{'views':count(result.get('view_count')),'likes':count(result.get('like_count')),'comments':count(result.get('comment_count'))},
        'thumbnail':image_url(thumbs[-1]) if thumbs else '', 'detail_status':'collected'}


async def video_details(identifier):return await asyncio.to_thread(extract_video,identifier)
