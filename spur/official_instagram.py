"""Read-only Meta Business Discovery pages using the user's saved authorization."""
import re,time
from spur.social import SocialStore,SocialError,access_token,request_json
from spur.video_search import SearchError,count,timestamp,image_url,safe_url


def ready(parent):
    repo=SocialStore(parent);connection=repo.connection('instagram')
    return bool(repo.app('instagram') and connection and connection['status']=='connected')


async def page(parent,username,cursor,client):
    if not re.fullmatch(r'[A-Za-z0-9_.]{1,30}',username):raise SearchError('Enter an Instagram username.')
    if cursor and not re.fullmatch(r'[A-Za-z0-9_=-]{1,2000}',str(cursor)):raise SearchError('Meta returned an unsupported pagination cursor.')
    repo=SocialStore(parent);connection=repo.connection('instagram');app=repo.app('instagram')
    if not connection or connection['status']!='connected' or not app:
        raise SearchError('Connect a Professional Instagram account through Facebook Login in your personal workspace first. Meta Business Discovery uses that authorization to read eligible public Business/Creator profiles.')
    token=await access_token(repo,connection,client)
    edge='media.limit(25)'+('.after('+str(cursor)+')' if cursor else '')
    fields='business_discovery.username('+username+'){id,username,followers_count,media_count,'+edge+'{id,caption,media_type,permalink,timestamp,like_count,comments_count,media_url,thumbnail_url}}'
    try:data=await request_json(client,'GET','https://graph.facebook.com/'+app['api_version']+'/'+connection['account_id'],headers={'Authorization':'Bearer '+token},params={'fields':fields})
    except SocialError:
        raise SearchError('Meta Business Discovery denied this request. Check the connected professional account, app permissions/review and target account eligibility. No TikHub fallback was made.') from None
    profile=data.get('business_discovery')
    if not isinstance(profile,dict) or profile.get('username','').casefold()!=username.casefold():raise SearchError('Meta did not return the requested professional profile. No complete import was claimed.')
    collection=profile.get('media')
    if not isinstance(collection,dict) or not isinstance(collection.get('data'),list):raise SearchError('Meta did not return a recognized media list.')
    paging=collection.get('paging') or {};next_cursor=(paging.get('cursors') or {}).get('after') if paging.get('next') else None
    if paging.get('next') and not next_cursor:raise SearchError('Meta indicates another page but supplied no cursor. Import paused.')
    rows=[];observed=time.time()
    for item in collection['data']:
        if not isinstance(item,dict) or not re.fullmatch(r'[0-9]{1,100}',str(item.get('id',''))):continue
        kind=item.get('media_type');description=str(item.get('caption') or '')[:18000]
        rows.append({'id':str(item['id']),'title':description[:300] or 'Instagram '+str(kind or 'post'),'description':description,
            'creator':username,'platform':'instagram','provider':'instagram_official','url':safe_url(item.get('permalink',''),'instagram'),
            'thumbnail':image_url(item.get('thumbnail_url') or (item.get('media_url') if kind!='VIDEO' else '')),
            'format':'video' if kind=='VIDEO' else 'image','media_type':8 if kind=='CAROUSEL_ALBUM' else 2 if kind=='VIDEO' else 1,
            'published':timestamp(item.get('timestamp')),'observed_at':observed,'duration_seconds':None,'detail_status':'collected',
            'metric_basis':'official_public_business_discovery','metrics':{'views':None,'likes':count(item.get('like_count')),'comments':count(item.get('comments_count'))}})
    if collection['data'] and not rows:raise SearchError('Meta returned unsupported media records. No empty catalog was substituted.')
    return {'rows':rows,'cursor':next_cursor,'visited':len(collection['data'])}
