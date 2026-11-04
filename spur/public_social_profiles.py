"""Budgeted public profile pages. No social login, media download or private analytics.

Contracts: docs.tikhub.io/362985064e0 (TikTok App V3 user posts),
docs.tikhub.io/387337809e0 (Instagram V2 user posts).
"""
import math
import time
from spur.video_search import SearchError,normalize


def check_response(response):
    """Expose actionable provider failures without echoing credentials or raw bodies."""
    if response.is_success:return
    text=response.text[:12000].lower()
    status=response.status_code
    if any(s in text for s in ('does not support free','not support free','free credit is not supported','free credits are not supported','paid balance required')):
        reason='This endpoint does not accept the available free credit; TikHub requires paid balance.'
    elif status==402 or any(s in text for s in ('insufficient balance','insufficient credit','not enough balance')):
        reason='TikHub reports insufficient usable balance for this endpoint.'
    elif status==401:reason='TikHub rejected the API key. Check that it is active.'
    elif status==403:reason='TikHub denied this endpoint. Check the key scope and whether the endpoint requires paid balance.'
    elif status==429:reason='TikHub rate limit reached. Sync again later.'
    else:reason='TikHub could not complete this request. Check its service status and endpoint access.'
    raise SearchError(f'TikHub HTTP {status}. {reason} No automatic paid retry was made.')


def request_page(platform,source,cursor):
    if platform=='instagram':
        return '/api/v1/instagram/v2/fetch_user_posts',{'username':source,**({'pagination_token':cursor} if cursor else {})}
    return '/api/v1/tiktok/app/v3/fetch_user_post_videos_v3',{'unique_id':source,'max_cursor':cursor or 0,'count':20,'sort_type':0}


def parse_page(platform,payload,source):
    if not isinstance(payload,dict) or payload.get('code') not in (0,200):
        raise SearchError('Public profile provider reported an unsuccessful response. No complete import was claimed.')
    data=payload.get('data')
    if not isinstance(data,dict):raise SearchError('Public profile response format needs live validation.')
    if data.get('status_code',0) not in (0,'0'):
        raise SearchError('The source profile is unavailable or access was denied. No complete import was claimed.')
    if platform=='instagram':
        items=data.get('items');cursor=data.get('pagination_token') or payload.get('pagination_token') or None
        more=data.get('more_available')
    else:
        items=data.get('aweme_list',data.get('item_list'))
        more=data.get('has_more')
        if more not in (True,False,0,1):raise SearchError('TikTok pagination status is missing. Import paused without claiming completeness.')
        cursor=data.get('max_cursor') if more else None
    if not isinstance(items,list):raise SearchError('Public profile post list was not recognized. No empty catalog was substituted.')
    if more and cursor in (None,'',0,'0'):raise SearchError('Provider says more posts exist but did not return a usable cursor.')
    if cursor is not None and (isinstance(cursor,bool) or not isinstance(cursor,(str,int))):raise SearchError('Provider returned an invalid pagination cursor.')
    rows=[];observed=time.time()
    for item in items:
        if not isinstance(item,dict):continue
        row=normalize(platform,item)
        if not row:continue
        native=(item.get('media') or item) if platform=='instagram' else (item.get('aweme_info') or item.get('item') or item)
        # Do not silently mix recommendations or another creator into this profile.
        author=native.get('user',{}) if platform=='instagram' else native.get('author',{})
        handle=author.get('username') if platform=='instagram' else author.get('unique_id') or author.get('uniqueId')
        if handle and str(handle).lstrip('@').casefold()!=source.casefold():continue
        video=native.get('video') or {}
        duration=native.get('video_duration') if platform=='instagram' else video.get('duration')
        try:
            duration=float(duration)
            if platform=='tiktok':duration/=1000  # TikTok App video.duration is milliseconds.
            if not math.isfinite(duration) or duration<=0:duration=None
        except (TypeError,ValueError,OverflowError):duration=None
        row.update(description=row['title'],platform=platform,provider='tikhub',observed_at=observed,
                   duration_seconds=duration,metric_basis='public_provider_lifetime_counts',detail_status='collected')
        if platform=='instagram':row.update(media_type=native.get('media_type'),format='video' if native.get('media_type')==2 else 'image')
        rows.append(row)
    if items and not rows:raise SearchError('No usable posts belonging to this profile were returned. Import paused for validation.')
    return rows,cursor,len(items)
