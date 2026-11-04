"""Publish an owned library video to the connected Facebook Page."""
import re
import time

from spur.library import Library
from spur.publishing import PostInput, Posts
from spur.social import SocialError, SocialStore, request_json


def deliveries(store):
    with store.connect() as db:
        db.execute("""CREATE TABLE IF NOT EXISTS facebook_deliveries(
            source_id TEXT NOT NULL, page_id TEXT NOT NULL, status TEXT NOT NULL,
            video_id TEXT, message TEXT, PRIMARY KEY(source_id,page_id))""")
        return [dict(row) for row in db.execute('SELECT * FROM facebook_deliveries')]


def source(store, source_id):
    if getattr(store, 'mock_profile', None):
        raise SocialError('Publish from your personal workspace.')
    post = Posts(store).get(source_id)
    if post['media_type'] != 'reel' or not post.get('asset_id') or post['status'] != 'published':
        raise SocialError('Choose a published Reel with an uploaded MP4.')
    Posts(store).validate_asset(PostInput(media_type='reel', content_id=post['content_id'], asset_id=post['asset_id']))
    return post


async def destination(store, client, source_id):
    post = source(store, source_id)
    social = SocialStore(store)
    connection = social.connection('instagram')
    if not connection or connection['account_id'] != post['account_id'] or connection['expires'] <= time.time():
        raise SocialError('Reconnect the Meta account used for this Reel.')
    tokens = connection['tokens']
    token = tokens.get('page_tokens', {}).get(post['account_id'])
    if not token:
        raise SocialError('Reconnect Meta and select the Facebook Page linked to this Instagram account.')
    base = 'https://graph.facebook.com/' + social.app('instagram')['api_version'] + '/'
    headers = {'Authorization': 'Bearer ' + token}
    page = await request_json(client,'GET',base+'me',headers=headers,params={'fields':'id,name'})
    if not re.fullmatch(r'[0-9]+', str(page.get('id',''))):
        raise SocialError('Meta did not identify a Facebook Page.')
    ready = 'pages_manage_posts' in tokens.get('granted_scopes', [])
    return {'id':page['id'],'name':page['name'],'authorized':ready},headers,connection['generation'],base


async def enqueue(store, client, source_id, page_id):
    page, _, generation, _ = await destination(store, client, source_id)
    if page['id'] != page_id or not page['authorized']:
        raise SocialError('Authorize pages_manage_posts for the selected Facebook Page before posting.')
    deliveries(store)
    with store.connect() as db:
        db.execute('BEGIN IMMEDIATE')
        inserted = db.execute("INSERT OR IGNORE INTO facebook_deliveries VALUES(?,?,'queued',NULL,NULL)",(source_id,page_id))
        if inserted.rowcount:
            store._enqueue(db,'facebook_video_publish',{'source_id':source_id,'page_id':page_id,'generation':generation},time.time())
    return {'items':deliveries(store)}


async def step(store, job, client):
    payload = job['payload']
    key = (payload['source_id'], payload['page_id'])
    def save(status, message='', video=None):
        with store.connect() as db:
            db.execute('UPDATE facebook_deliveries SET status=?,message=?,video_id=COALESCE(?,video_id) WHERE source_id=? AND page_id=?',
                       (status,message,video,*key))
    with store.connect() as db:
        started = db.execute("UPDATE facebook_deliveries SET status='checking' WHERE source_id=? AND page_id=? AND status IN ('queued','checking')",key)
    if not started.rowcount:
        store.finish(job,{'skipped':True})
        return
    writing = False
    try:
        page, headers, generation, base = await destination(store,client,key[0])
        if generation != payload['generation'] or page['id'] != key[1] or not page['authorized']:
            raise SocialError('Facebook authorization changed before publication.')
        post = source(store,key[0])
        path = Library(store).asset_path(post['asset_id'])
        with path.open('rb') as video:
            with store.connect() as db:
                claimed = db.execute("UPDATE facebook_deliveries SET status='sending' WHERE source_id=? AND page_id=? AND status='checking'",key)
            if not claimed.rowcount:
                store.finish(job,{'skipped':True})
                return
            writing = True
            response = await client.post(base.replace('graph.facebook.com','graph-video.facebook.com')+page['id']+'/videos',
                headers=headers,data={'description':post['caption'],'published':'true'},
                files={'source':('video.mp4',video,'video/mp4')},timeout=180)
        body = response.json()
        if 'error' in body:
            writing = False
            raise SocialError('Meta rejected the video (code '+str(body['error'].get('code','unknown'))+').')
        video_id = str(body.get('id',''))
        if not re.fullmatch(r'[0-9]+',video_id):
            raise SocialError('Missing Facebook video ID.')
        save('accepted','Facebook accepted the video for publication.',video_id)
        store.finish(job,{'video_id':video_id})
    except Exception as exc:
        message = 'Check the Facebook Page before retrying.' if writing else str(exc) if isinstance(exc,SocialError) else 'Facebook connection failed.'
        save('uncertain' if writing else 'failed',message)
        store.finish(job,{'error':message})
