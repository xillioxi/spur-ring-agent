import asyncio
import time
import json
from urllib.parse import urlparse,parse_qs
import httpx
import pytest
from spur.store import Store
from spur.social import SocialStore,SocialError,begin_oauth
from spur.publishing import Posts,PostInput,DispatchInput,step,public_url
from tests.test_social import client,test_encryption


def prepare(tmp_path):
 s=Store(str(tmp_path/'workspace.db'));social=SocialStore(s)
 social.save_app('instagram','app','secret','https://app.example.com/social/instagram/callback','v24.0')
 social.connect('instagram',{'access_token':'token','expires_in':3600,'granted_scopes':['instagram_content_publish']},[{'id':'123','name':'studio'}])
 p=Posts(s);post=p.create(PostInput(media_type='reel',media_url='https://media.example.com/clip.mp4',caption='My post'))
 return s,p,post


def execute(s,job,handler):
 async def run():
  async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:await step(s,job,c)
 asyncio.run(run())


def provider(calls,processing=False,timeout=False):
 def handle(r):
  calls.append(r)
  assert r.url.host=='graph.facebook.com' and r.headers['authorization']=='Bearer token'
  assert 'access_token' not in str(r.url)
  if r.url.path.endswith('/me/permissions'):return httpx.Response(200,json={'data':[{'permission':'instagram_content_publish','status':'granted'}]})
  if r.url.path.endswith('/123/media'):return httpx.Response(200,json={'id':'456'})
  if r.url.path.endswith('/456'):return httpx.Response(200,json={'status_code':'IN_PROGRESS' if processing else 'FINISHED'})
  if r.url.path.endswith('/123/media_publish'):
   if timeout:raise httpx.ReadTimeout('unknown outcome',request=r)
   return httpx.Response(200,json={'id':'789'})
  if r.url.path.endswith('/789'):return httpx.Response(200,json={'permalink':'https://www.instagram.com/reel/abc/'})
  raise AssertionError(str(r.url))
 return handle


def test_complete_publish_idempotency_and_link(tmp_path):
 s,p,post=prepare(tmp_path);p.dispatch(post['id'],DispatchInput(account_id="123",version=1,confirmed=True),'https://app.example.com')
 with pytest.raises(SocialError,match='already queued'):p.dispatch(post['id'],DispatchInput(account_id="123",version=1,confirmed=True),'https://app.example.com')
 calls=[];execute(s,s.claim(),provider(calls));done=p.get(post['id'])
 assert done['status']=='published' and done['media_id']=='789' and done['permalink'].endswith('/abc/')
 assert len([r for r in calls if r.url.path.endswith('/media_publish')])==1
 assert 'token' not in json.dumps(p.list())


@pytest.mark.parametrize('upload_timeout',[False,True])
def test_local_mp4_upload_uses_meta_page_token_without_public_app(tmp_path,upload_timeout):
 from spur.library import Library
 s,p,_=prepare(tmp_path);lib=Library(s);content=lib.create({'title':'Own Reel','kind':'own','format':'instagram_reel'})
 asset='c'*32;lib.asset_dir.mkdir(parents=True,exist_ok=True);payload=b'own-mp4-fixture'
 lib.asset_path(asset).write_bytes(payload);lib.add_asset(content['id'],asset,'own.mp4','video/mp4',len(payload),'footage')
 c=SocialStore(s).connection('instagram');c['tokens']['page_tokens']={'123':'page-token'};SocialStore(s).connect('instagram',c['tokens'],c['candidates'])
 post=p.create(PostInput(media_type='reel',content_id=content['id'],asset_id=asset,caption='Owned Reel'))
 p.dispatch(post['id'],DispatchInput(account_id='123',version=1,confirmed=True),'http://127.0.0.1:8000')
 calls=[]
 async def handle(r):
  calls.append(r)
  assert 'access_token' not in str(r.url)
  if r.url.path.endswith('/me/permissions'):
   assert r.headers['authorization']=='Bearer token'
   return httpx.Response(200,json={'data':[{'permission':'instagram_content_publish','status':'granted'}]})
  if r.url.host=='rupload.facebook.com':
   assert r.url.path=='/ig-api-upload/v24.0/456'
   assert r.headers['authorization']=='OAuth page-token' and r.headers['offset']=='0'
   assert int(r.headers['file_size'])==len(payload) and await r.aread()==payload
   if upload_timeout:raise httpx.ReadTimeout('unknown outcome',request=r)
   return httpx.Response(200,json={'success':True})
  assert r.url.host=='graph.facebook.com' and r.headers['authorization']=='Bearer page-token'
  if r.url.path.endswith('/123/media'):
   body=parse_qs((await r.aread()).decode());assert body['upload_type']==['resumable'] and 'video_url' not in body
   return httpx.Response(200,json={'id':'456','uri':'https://evil.invalid/do-not-upload'})
  if r.url.path.endswith('/456'):return httpx.Response(200,json={'status_code':'FINISHED'})
  if r.url.path.endswith('/media_publish'):return httpx.Response(200,json={'id':'789'})
  return httpx.Response(200,json={'permalink':'https://www.instagram.com/reel/own/'})
 execute(s,s.claim(),handle)
 done=p.get(post['id']);assert done['status']==('uncertain' if upload_timeout else 'published')
 assert len([r for r in calls if r.url.host=='rupload.facebook.com'])==1
 if upload_timeout:
  assert not any(r.url.path.endswith('/media_publish') for r in calls)
  s.enqueue('instagram_publish',{'post_id':post['id']});execute(s,s.claim(),handle)
  assert len([r for r in calls if r.url.host=='rupload.facebook.com'])==1


def test_uncertain_publish_never_retries(tmp_path):
 s,p,post=prepare(tmp_path);p.dispatch(post['id'],DispatchInput(account_id="123",version=1,confirmed=True),'https://app.example.com');calls=[]
 execute(s,s.claim(),provider(calls,timeout=True));assert p.get(post['id'])['status']=='uncertain'
 s.enqueue('instagram_publish',{'post_id':post['id']});execute(s,s.claim(),provider(calls))
 assert len([r for r in calls if r.url.path.endswith('/media_publish')])==1


def test_processing_checkpoint_and_cancel_scheduled(tmp_path):
 s,p,post=prepare(tmp_path);p.dispatch(post['id'],DispatchInput(account_id="123",version=1,confirmed=True),'https://app.example.com');calls=[]
 execute(s,s.claim(),provider(calls,processing=True));assert p.get(post['id'])['status']=='processing'
 with s.connect() as db:db.execute("UPDATE jobs SET available=0 WHERE status='queued'")
 execute(s,s.claim(),provider(calls));assert p.get(post['id'])['status']=='published'
 assert len([r for r in calls if r.url.path.endswith('/123/media')])==1
 other=p.create(PostInput(media_type='image',media_url='https://media.example.com/image.jpg'))
 p.dispatch(other['id'],DispatchInput(account_id="123",version=1,confirmed=True,scheduled_at=time.time()+3600),'https://app.example.com')
 assert s.claim() is None
 assert p.cancel(other['id'])['status']=='cancelled'


def test_account_switch_stops_scheduled_post(tmp_path):
 s,p,post=prepare(tmp_path);p.dispatch(post['id'],DispatchInput(account_id="123",version=1,confirmed=True),'https://app.example.com')
 SocialStore(s).disconnect('instagram');calls=[];execute(s,s.claim(),provider(calls))
 assert p.get(post['id'])['status']=='failed' and not calls


def test_crash_after_write_marker_requires_reconciliation(tmp_path):
 s,p,post=prepare(tmp_path);post=p.dispatch(post['id'],DispatchInput(account_id="123",version=1,confirmed=True),'https://app.example.com')
 post['status']='creating';p.save(post);calls=[];execute(s,s.claim(),provider(calls))
 assert p.get(post['id'])['status']=='uncertain' and not calls


def test_permissions_and_explicit_confirmation_required(tmp_path):
 s,p,post=prepare(tmp_path)
 with pytest.raises(SocialError,match='confirm'):p.dispatch(post['id'],DispatchInput(account_id="123",version=1),'https://app.example.com')
 c=SocialStore(s).connection('instagram');c['tokens']['granted_scopes']=[];SocialStore(s).connect('instagram',c['tokens'],c['candidates'])
 with pytest.raises(SocialError,match='permission'):p.dispatch(post['id'],DispatchInput(account_id="123",version=1,confirmed=True),'https://app.example.com')
 assert s.claim() is None


@pytest.mark.parametrize('url',['http://example.com/a','https://localhost/a','https://127.0.0.1/a','https://10.0.0.1/a','https://[fd00::1]/a','https://name.local/a','https://user:secret@example.com/a'])
def test_reject_local_and_credential_urls(url):
 with pytest.raises(SocialError):public_url(url)


def test_mock_and_cross_workspace_access_blocked(tmp_path):
 s,p,post=prepare(tmp_path);other=Posts(Store(str(tmp_path/'other.db')))
 with pytest.raises(SocialError,match='not found'):other.get(post['id'])
 s.mock_profile={'id':'mock'}
 with pytest.raises(SocialError,match='personal workspace'):Posts(s)


def test_api_csrf_and_opt_in_scope(client):
 import spur.api as api
 root=client.app.state.store;social=SocialStore(root)
 social.save_app('instagram','app','secret','http://testserver/social/instagram/callback','v24.0')
 assert client.post('/publishing/instagram',json={}).status_code==403
 regular=client.post('/social/instagram/connect',headers=client.csrf).json()
 assert 'instagram_content_publish' not in parse_qs(urlparse(regular['authorization_url']).query)['scope'][0]
 expanded=client.post('/social/instagram/connect?publishing=true',headers=client.csrf).json()
 assert 'instagram_content_publish' in parse_qs(urlparse(expanded['authorization_url']).query)['scope'][0]
 assert client.get('/publishing/instagram').status_code==200
 response=client.post('/publishing/instagram',headers=client.csrf,json={'media_type':'image','media_url':'https://media.example.com/a.jpg','caption':'Draft'})
 assert response.status_code==201 and response.json()['status']=='draft'


def test_upload_and_expiring_public_media_link(client,tmp_path):
 from spur.library import Library
 from spur.publishing import grant_media
 root=client.app.state.store
 content=client.post('/content',headers=client.csrf,json={'title':'Own image','format':'image_post','kind':'own'}).json()
 image=b'\xff\xd8\xff\xd9'  # Byte-transfer fixture; Meta performs media decoding.
 upload=client.post('/content/'+content['id']+'/assets?filename=test.jpg&role=footage',headers={**client.csrf,'Content-Type':'application/octet-stream'},content=image)
 assert upload.status_code==201
 asset=upload.json()['assets'][0]
 draft=client.post('/publishing/instagram',headers=client.csrf,json={'media_type':'image','content_id':content['id'],'asset_id':asset['id'],'caption':'Own media'}).json()
 assert draft['status']=='draft'
 path=grant_media(root,{**draft,'origin':'https://app.example.com'}).split('https://app.example.com')[1]
 cookie=client.cookies.get('spur_account');client.cookies.clear()
 response=client.get(path);assert response.status_code==200 and response.content==image
 assert client.get('/content/'+content['id']+'/assets/'+asset['id']).status_code==401
 with root.connect() as db:db.execute('UPDATE publishing_media SET expires=0')
 assert client.get(path).status_code==404


def test_revoked_permission_stops_before_provider_write(tmp_path):
 s,p,post=prepare(tmp_path);p.dispatch(post['id'],DispatchInput(account_id="123",version=1,confirmed=True),'https://app.example.com');calls=[]
 def denied(r):calls.append(r);return httpx.Response(200,json={'data':[]})
 execute(s,s.claim(),denied)
 assert p.get(post['id'])['status']=='failed' and all(r.method=='GET' for r in calls)


def test_upload_cannot_be_dispatched_from_localhost(tmp_path):
 from spur.library import Library
 s,p,_=prepare(tmp_path);lib=Library(s);c=lib.create({'title':'Local upload','format':'image_post','kind':'own'})
 lib.asset_dir.mkdir(parents=True,exist_ok=True);asset='a'*32;lib.asset_path(asset).write_bytes(b'jpeg')
 lib.add_asset(c['id'],asset,'image.jpg','image/jpeg',4,'footage')
 post=p.create(PostInput(media_type='image',content_id=c['id'],asset_id=asset))
 with pytest.raises(SocialError,match='publicly accessible HTTPS'):p.dispatch(post['id'],DispatchInput(account_id="123",version=1,confirmed=True),'http://127.0.0.1:8000')
 assert p.get(post['id'])['status']=='draft' and s.claim() is None


def test_review_cannot_publish_to_a_different_account(tmp_path):
 s,p,post=prepare(tmp_path)
 with pytest.raises(SocialError,match='account changed after preview'):
  p.dispatch(post['id'],DispatchInput(account_id='999',version=1,confirmed=True),'https://app.example.com')
 assert p.get(post['id'])['status']=='draft' and s.claim() is None


def test_draft_edit_version_and_queued_content_lock(tmp_path):
 from spur.publishing import PostUpdate
 s,p,post=prepare(tmp_path)
 value=PostUpdate(version=1,media_type='image',media_url='https://media.example.com/changed.jpg',caption='Updated caption')
 changed=p.update(post['id'],value)
 assert changed['version']==2 and changed['caption']=='Updated caption' and changed['media_type']=='image'
 with pytest.raises(SocialError,match='draft changed'):p.update(post['id'],value)
 p.dispatch(post['id'],DispatchInput(account_id='123',version=2,confirmed=True,scheduled_at=time.time()+3600),'https://app.example.com')
 with pytest.raises(SocialError,match='Only unpublished drafts'):p.update(post['id'],PostUpdate(**{**value.model_dump(),'version':3}))


def test_reschedule_reuses_job_and_rejects_running_job(tmp_path):
 s,p,post=prepare(tmp_path)
 queued=p.dispatch(post['id'],DispatchInput(account_id='123',version=1,confirmed=True,scheduled_at=time.time()+3600),'https://app.example.com')
 later=time.time()+7200
 changed=p.reschedule(post['id'],DispatchInput(account_id='123',version=queued['version'],confirmed=True,scheduled_at=later))
 assert changed['job_id']==queued['job_id'] and changed['scheduled_at']==later
 with s.connect() as db:
  assert db.execute("SELECT count(*) FROM jobs WHERE kind='instagram_publish'").fetchone()[0]==1
  assert db.execute('SELECT available FROM jobs WHERE id=?',(changed['job_id'],)).fetchone()[0]==later
  db.execute('UPDATE jobs SET available=0 WHERE id=?',(changed['job_id'],))
 s.claim()
 with pytest.raises(SocialError,match='already started'):p.reschedule(post['id'],DispatchInput(account_id='123',version=changed['version'],confirmed=True,scheduled_at=later+3600))


def test_schedule_change_requires_confirmation_and_same_account(tmp_path):
 s,p,post=prepare(tmp_path)
 queued=p.dispatch(post['id'],DispatchInput(account_id='123',version=1,confirmed=True,scheduled_at=time.time()+3600),'https://app.example.com')
 with pytest.raises(SocialError,match='Confirm'):p.reschedule(post['id'],DispatchInput(account_id='123',version=queued['version']))
 with pytest.raises(SocialError,match='account changed'):p.reschedule(post['id'],DispatchInput(account_id='999',version=queued['version'],confirmed=True))
 assert p.get(post['id'])['version']==queued['version']


def test_draft_edit_api_csrf_and_schema(client):
 post=client.post('/publishing/instagram',headers=client.csrf,json={'caption':'Initial','media_type':'image','media_url':'https://media.example.com/image.jpg'}).json()
 body={'version':post['version'],'caption':'Edited through app','media_type':'image','media_url':'https://media.example.com/image.jpg'}
 assert client.put('/publishing/instagram/'+post['id'],json=body).status_code==403
 saved=client.put('/publishing/instagram/'+post['id'],headers=client.csrf,json=body)
 assert saved.status_code==200 and saved.json()['caption']=='Edited through app'
 assert client.put('/publishing/instagram/'+post['id'],headers=client.csrf,json=body).status_code==422


def test_local_demo_publish_needs_no_provider_or_https(tmp_path,monkeypatch):
 from spur.publishing import demo_step
 s=Store(str(tmp_path/'demo.db'));s.mock_profile={'id':'reference-workspace'}
 monkeypatch.setattr('spur.publishing.SocialStore',lambda *a:(_ for _ in ()).throw(AssertionError('Demo must not read real credentials')))
 p=Posts(s,demo=True);post=p.create(PostInput(media_type='image',media_url='https://media.example.com/demo.jpg',caption='Local demo'))
 assert p.readiness()['account_id']=='local-demo'
 queued=p.dispatch(post['id'],DispatchInput(account_id='local-demo',version=1,confirmed=True),'http://127.0.0.1:8000')
 job=s.claim();assert job['kind']=='instagram_demo_publish'
 demo_step(s,job);result=p.get(post['id'])
 assert result['status']=='published' and result['simulated'] is True and result['permalink'] is None
 assert result['media_id'].startswith('demo-')
 assert s.job(job['id'])['result']['simulated'] is True


def test_demo_and_live_lanes_cannot_edit_or_dispatch_each_other(tmp_path):
 from spur.publishing import PostUpdate
 s,p,live=prepare(tmp_path);demo=Posts(s,demo=True)
 post=demo.create(PostInput(media_type='reel',media_url='https://media.example.com/demo.mp4'))
 assert post['id'] not in [r['id'] for r in p.list()]
 assert live['id'] not in [r['id'] for r in demo.list()]
 with pytest.raises(SocialError,match='different publishing mode'):p.dispatch(post['id'],DispatchInput(account_id='123',version=1,confirmed=True),'https://app.example.com')
 with pytest.raises(SocialError,match='different publishing mode'):demo.cancel(live['id'])
 with pytest.raises(SocialError,match='different publishing mode'):demo.update(live['id'],PostUpdate(version=1,media_type='image',media_url='https://media.example.com/a.jpg'))
 assert s.claim() is None


def test_demo_webm_reel_is_local_only(tmp_path):
 from spur.library import Library
 from spur.publishing import demo_step
 s=Store(str(tmp_path/'demo.db'));lib=Library(s);content=lib.create({'title':'Local test Reel','kind':'own','format':'instagram_reel'})
 asset='b'*32;lib.asset_dir.mkdir(parents=True,exist_ok=True);lib.asset_path(asset).write_bytes(b'demo-webm')
 lib.add_asset(content['id'],asset,'demo.webm','video/webm',9,'footage')
 value=PostInput(media_type='reel',content_id=content['id'],asset_id=asset)
 with pytest.raises(SocialError,match='MP4'):Posts(s).create(value)
 demo=Posts(s,demo=True);post=demo.create(value)
 demo.dispatch(post['id'],DispatchInput(account_id='local-demo',version=1,confirmed=True),'http://localhost:8000')
 demo_step(s,s.claim());assert demo.get(post['id'])['status']=='published'


def test_demo_api_without_instagram_and_worker_delivery(client):
 from spur.worker import execute_step
 response=client.post('/publishing/instagram?mode=demo',headers=client.csrf,json={'caption':'Local demo','media_type':'image','media_url':'https://media.example.com/a.jpg'})
 assert response.status_code==201;post=response.json();assert post['delivery_mode']=='demo'
 queued=client.post('/publishing/instagram/'+post['id']+'/dispatch?mode=demo',headers=client.csrf,json={'version':1,'account_id':'local-demo','confirmed':True})
 assert queued.status_code==200
 root=client.app.state.store;job=root.claim()
 asyncio.run(execute_step(root,job,None))
 items=client.get('/publishing/instagram?mode=demo').json()['items'];assert items[0]['simulated'] is True
 assert client.get('/publishing/instagram').json()['items']==[]


def test_demo_delivery_does_not_change_reference_catalog(tmp_path):
 from spur.mock_profiles import Profiles,MockProfileInput,media
 from spur.publishing import demo_step
 root=Store(str(tmp_path/'root.db'));registry=Profiles(root)
 info=registry.create(MockProfileInput(platform='youtube',mode='synthetic'))
 child=registry.workspace(info['id']);before=media(child)
 demo=Posts(child,demo=True);post=demo.create(PostInput(media_type='image',media_url='https://media.example.com/test.jpg',caption='Local demo'))
 demo.dispatch(post['id'],DispatchInput(version=1,account_id='local-demo',confirmed=True),'http://localhost:8000')
 demo_step(child,child.claim())
 assert media(child)==before
 assert demo.get(post['id'])['simulated'] is True
