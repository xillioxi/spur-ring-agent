import asyncio
import hashlib
import json
import logging
import struct
import time
from urllib.parse import parse_qs,urlparse

import httpx
import pytest
from spur.library import Library
from spur.social import SocialStore,SocialError,begin_oauth,exchange_code,unseal
from spur.store import Store
from spur.tiktok_publishing import Posts,DraftInput,DraftUpdate,PublishInput,step,mp4_info,upload_url
from tests.test_social import client


@pytest.fixture(autouse=True)
def cipher(monkeypatch):monkeypatch.setattr('spur.social.protect',lambda b,decrypt=False:bytes(b)[::-1])


def atom(kind,data):return struct.pack('>I4s',len(data)+8,kind)+data


def mp4(seconds=4,extra=0):
    movie=atom(b'mvhd',b'\0'*12+struct.pack('>II',1000,int(seconds*1000))+b'\0'*12)
    track=atom(b'trak',atom(b'mdia',atom(b'hdlr',b'\0'*8+b'vide'+b'\0'*12)))
    return atom(b'ftyp',b'isom\0\0\0\0isom')+atom(b'moov',movie+track)+atom(b'mdat',b'\0'*extra)


def prepare(s,method='direct',audited=False,extra=0):
    repo=SocialStore(s);repo.save_app('tiktok','client','secret','http://127.0.0.1:8000/social/tiktok/callback','v24.0')
    s.set_runtime('tiktok_login',{'mode':'desktop','client_id':'client'})
    s.set_runtime('tiktok_publishing',{'approved':audited,'reference':'existing-approval' if audited else '', 'client_id':'client'})
    repo.connect('tiktok',{'access_token':'user-secret','scope':'user.info.basic,video.publish,video.upload','expires_in':3600},[{'id':'creator-id','name':'Studio'}])
    lib=Library(s);item=lib.create({'title':'Own video','kind':'own','format':'tiktok_video'})
    identifier='a'*32;payload=mp4(extra=extra);lib.asset_dir.mkdir(parents=True,exist_ok=True);lib.asset_path(identifier).write_bytes(payload)
    lib.add_asset(item['id'],identifier,'own.mp4','video/mp4',len(payload),'footage')
    posts=Posts(s);post=posts.create(DraftInput(content_id=item['id'],asset_id=identifier,caption='Original video',method=method))
    return posts,post


def invoke(handler,work):
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as transport:return await work(transport)
    return asyncio.run(run())


def provider(calls,public=False,upload_timeout=False,status='PUBLISH_COMPLETE',endpoint_error=None):
    def handle(request):
        calls.append(request)
        if request.url.host=='open-upload.tiktokapis.com':
            assert request.method=='PUT' and 'authorization' not in request.headers
            assert request.headers['content-range'].startswith('bytes ')
            if upload_timeout:raise httpx.ReadTimeout('upload interrupted',request=request)
            end,total=request.headers['content-range'].split('/');last=int(end.split('-')[-1])+1==int(total)
            return httpx.Response(201 if last else 206)
        assert request.url.host=='open.tiktokapis.com' and request.headers['authorization']=='Bearer user-secret'
        path=request.url.path
        if path.endswith('/user/info/'):
            return httpx.Response(200,json={'data':{'user':{'open_id':'creator-id','display_name':'Studio'}},'error':{'code':'ok'}})
        if path.endswith('/creator_info/query/'):
            data={'creator_nickname':'Studio','creator_username':'studio','privacy_level_options':['PUBLIC_TO_EVERYONE','SELF_ONLY'] if public else ['FOLLOWER_OF_CREATOR','SELF_ONLY'],'comment_disabled':False,'duet_disabled':False,'stitch_disabled':True,'max_video_post_duration_sec':60}
        elif path.endswith('/init/'):
            if endpoint_error:return httpx.Response(403,json={'error':{'code':endpoint_error,'message':'do not leak private provider details'}})
            data={'publish_id':'v_pub_file~v2.123','upload_url':'https://open-upload.tiktokapis.com/video/?upload_id=123&upload_token=never-log-this'}
        elif path.endswith('/status/fetch/'):
            data={'status':status,'publicaly_available_post_id':['987654'] if public else []}
        else:raise AssertionError(path)
        return httpx.Response(200,json={'data':data,'error':{'code':'ok'}})
    return handle


def reviewed(posts,post,handler,**choices):
    r=invoke(handler,lambda transport:posts.review(post['id'],transport))
    value=PublishInput(version=post['version'],review_id=r['review']['id'],account_id='creator-id',privacy_level='SELF_ONLY',confirmed=True,music_confirmed=True,**choices)
    return value,r


def execute(s,handler):
    job=s.claim()
    assert job is not None
    invoke(handler,lambda transport:step(s,job,transport))
    return job


def next_job(s):
    with s.connect() as db:db.execute("UPDATE jobs SET available=0 WHERE status='queued'")


def test_local_video_post_uploads_once_and_reports_actual_completion(tmp_path,caplog):
    s=Store(tmp_path/'root.db');posts,post=prepare(s);calls=[];handler=provider(calls)
    value,r=reviewed(posts,post,handler)
    assert r['review']['creator']['creator_nickname']=='Studio'
    posts.dispatch(post['id'],value)
    with caplog.at_level(logging.INFO,logger='httpx'):
        execute(s,handler);execute(s,handler);next_job(s);execute(s,handler)
    result=posts.get(post['id']);assert result['status']=='published' and result['post_ids']==[]
    assert 'never-log-this' not in caplog.text and 'user-secret' not in caplog.text
    assert 'upload_url' not in json.dumps(result)
    assert len([r for r in calls if r.url.path.endswith('/init/')])==1
    body=json.loads(next(r.content for r in calls if r.url.path.endswith('/video/init/')))
    assert body['post_info']['privacy_level']=='SELF_ONLY'
    assert body['post_info']['disable_comment'] and body['post_info']['disable_duet'] and body['post_info']['disable_stitch']


def test_inbox_delivery_is_not_publication_and_does_not_claim_caption_was_applied(tmp_path):
    s=Store(tmp_path/'root.db');posts,post=prepare(s,'inbox');calls=[];handler=provider(calls,status='SEND_TO_USER_INBOX')
    value,_=reviewed(posts,post,handler);posts.dispatch(post['id'],value)
    execute(s,handler);execute(s,handler);next_job(s);execute(s,handler)
    assert posts.get(post['id'])['status']=='inbox_delivered'
    body=json.loads(next(r.content for r in calls if r.url.path.endswith('/inbox/video/init/')))
    assert 'post_info' not in body
    posts.check_status(post['id']);execute(s,provider(calls,status='PUBLISH_COMPLETE'))
    assert posts.get(post['id'])['status']=='published'


def test_public_completion_keeps_real_username_and_cannot_be_requeued(tmp_path):
    s=Store(tmp_path/'root.db');posts,post=prepare(s,audited=True);calls=[];handler=provider(calls,public=True)
    value,_=reviewed(posts,post,handler);value=value.model_copy(update={'privacy_level':'PUBLIC_TO_EVERYONE'});posts.dispatch(post['id'],value)
    execute(s,handler);execute(s,handler);next_job(s);execute(s,handler)
    result=posts.check_status(post['id'])
    assert result['status']=='published' and result['account_username']=='studio' and result['post_ids']==['987654']
    assert s.claim() is None


def test_timeout_does_not_initialize_or_upload_again(tmp_path):
    s=Store(tmp_path/'root.db');posts,post=prepare(s);calls=[];handler=provider(calls,upload_timeout=True)
    value,_=reviewed(posts,post,handler);posts.dispatch(post['id'],value)
    execute(s,handler);execute(s,handler);assert posts.get(post['id'])['status']=='uncertain'
    assert s.claim() is None
    posts.check_status(post['id']);execute(s,provider(calls,status='PUBLISH_COMPLETE'))
    assert posts.get(post['id'])['status']=='published'
    assert len([r for r in calls if r.url.host=='open-upload.tiktokapis.com'])==1
    assert len([r for r in calls if r.url.path.endswith('/init/')])==1


def test_multiple_chunks_include_remainder_in_last_chunk(tmp_path):
    s=Store(tmp_path/'root.db');posts,post=prepare(s,extra=17*1024*1024);calls=[];handler=provider(calls)
    value,_=reviewed(posts,post,handler);posts.dispatch(post['id'],value)
    execute(s,handler);execute(s,handler);execute(s,handler)
    uploads=[r for r in calls if r.url.host=='open-upload.tiktokapis.com']
    assert len(uploads)==2 and sum(len(r.content) for r in uploads)==post['media']['size']
    assert len(uploads[0].content)==8*1024*1024 and len(uploads[1].content)>8*1024*1024


def test_expired_or_changed_review_and_connection_block_writes(tmp_path):
    s=Store(tmp_path/'root.db');posts,post=prepare(s);calls=[];handler=provider(calls)
    value,_=reviewed(posts,post,handler);current=posts.get(post['id']);current['review']['expires']=0;posts.save(current)
    with pytest.raises(SocialError,match='expired'):posts.dispatch(post['id'],value)
    value,_=reviewed(posts,post,handler)
    c=SocialStore(s).connection('tiktok');SocialStore(s).connect('tiktok',c['tokens'],c['candidates'])
    with pytest.raises(SocialError,match='changed'):posts.dispatch(post['id'],value)
    assert s.claim() is None


def test_media_replaced_after_confirmation_is_not_sent(tmp_path):
    s=Store(tmp_path/'root.db');posts,post=prepare(s);calls=[];handler=provider(calls)
    value,_=reviewed(posts,post,handler);posts.dispatch(post['id'],value)
    Library(s).asset_path(post['asset_id']).write_bytes(mp4(seconds=5))
    execute(s,handler);assert posts.get(post['id'])['status']=='failed'
    assert not any(r.url.path.endswith('/init/') for r in calls)


def test_disconnect_during_creator_lookup_stops_the_external_write(tmp_path):
    s=Store(tmp_path/'root.db');posts,post=prepare(s);calls=[];normal=provider(calls)
    value,_=reviewed(posts,post,normal);posts.dispatch(post['id'],value)
    def disconnect(request):
        if request.url.path.endswith('/creator_info/query/'):SocialStore(s).disconnect('tiktok')
        return normal(request)
    execute(s,disconnect)
    assert posts.get(post['id'])['status']=='failed' and not any(r.url.path.endswith('/init/') for r in calls)


def test_initialization_timeout_never_starts_a_second_post(tmp_path):
    s=Store(tmp_path/'root.db');posts,post=prepare(s);calls=[];normal=provider(calls)
    value,_=reviewed(posts,post,normal);posts.dispatch(post['id'],value)
    def timeout(request):
        if request.url.path.endswith('/init/'):
            calls.append(request);raise httpx.ReadTimeout('unknown',request=request)
        return normal(request)
    execute(s,timeout)
    assert posts.get(post['id'])['status']=='uncertain' and s.claim() is None
    assert len([r for r in calls if r.url.path.endswith('/init/')])==1


def test_processing_network_failure_keeps_the_existing_publish_id(tmp_path):
    s=Store(tmp_path/'root.db');posts,post=prepare(s);calls=[];normal=provider(calls)
    value,_=reviewed(posts,post,normal);posts.dispatch(post['id'],value);execute(s,normal);execute(s,normal);next_job(s)
    def timeout(request):raise httpx.ReadTimeout('network unavailable',request=request)
    execute(s,timeout);p=posts.get(post['id'])
    assert p['status']=='awaiting_tiktok' and p['publish_id']=='v_pub_file~v2.123'


def test_audit_privacy_interactions_and_disclosures_are_enforced(tmp_path):
    s=Store(tmp_path/'root.db');posts,post=prepare(s);calls=[];handler=provider(calls,public=True)
    value,r=reviewed(posts,post,handler)
    with pytest.raises(SocialError,match='Unaudited'):posts.dispatch(post['id'],value)
    s.set_runtime('tiktok_publishing',{'approved':True,'client_id':'client','reference':'approved-audit'})
    value=value.model_copy(update={'privacy_level':'PUBLIC_TO_EVERYONE','allow_stitch':True})
    with pytest.raises(SocialError,match='stitch'):posts.dispatch(post['id'],value)
    value=value.model_copy(update={'allow_stitch':False,'commercial':True})
    with pytest.raises(SocialError,match='Your brand'):posts.dispatch(post['id'],value)
    value=value.model_copy(update={'own_brand':True,'music_confirmed':False})
    with pytest.raises(SocialError,match='Music'):posts.dispatch(post['id'],value)
    value=value.model_copy(update={'music_confirmed':True,'branded_content':True})
    with pytest.raises(SocialError,match='Paid partnership'):posts.dispatch(post['id'],value)
    value=value.model_copy(update={'branded_confirmed':True})
    assert posts.dispatch(post['id'],value)['status']=='queued'


def test_scheduling_and_cancellation_precede_any_provider_upload(tmp_path):
    s=Store(tmp_path/'root.db');posts,post=prepare(s);calls=[];handler=provider(calls)
    value,_=reviewed(posts,post,handler,scheduled_at=time.time()+3600)
    assert posts.dispatch(post['id'],value)['status']=='scheduled' and s.claim() is None
    posts.cancel(post['id']);assert s.claim() is None
    assert not any(r.url.path.endswith('/init/') for r in calls)


def test_unaudited_provider_rejection_is_actionable_not_uncertain(tmp_path):
    s=Store(tmp_path/'root.db');posts,post=prepare(s);calls=[];handler=provider(calls,endpoint_error='unaudited_client_can_only_post_to_private_accounts')
    value,_=reviewed(posts,post,handler);posts.dispatch(post['id'],value);execute(s,handler)
    p=posts.get(post['id']);assert p['status']=='failed' and 'private accounts' in p['error'] and 'private provider' not in p['error']


@pytest.mark.parametrize('url',['http://open-upload.tiktokapis.com/video/?upload_token=x','https://evil.invalid/video/?upload_token=x','https://open-upload.tiktokapis.com.evil.invalid/video/','https://127.0.0.1/video/','https://user:pass@open-upload.tiktokapis.com/video/'])
def test_upload_hosts_are_restricted(url):
    with pytest.raises(SocialError):upload_url(url)


def test_mp4_duration_and_utf16_caption_are_verified(tmp_path):
    path=tmp_path/'clip.mp4';path.write_bytes(mp4(seconds=12.5));assert mp4_info(path)['duration']==12.5
    path.write_bytes(b'not an mp4')
    with pytest.raises(SocialError):mp4_info(path)
    with pytest.raises(ValueError):DraftInput(content_id='a'*32,asset_id='b'*32,caption='😀'*1101)


def test_mock_and_other_workspaces_cannot_post_reference_content(tmp_path):
    s=Store(tmp_path/'a.db');posts,post=prepare(s)
    with pytest.raises(SocialError,match='not found'):Posts(Store(tmp_path/'b.db')).get(post['id'])
    s.mock_profile={'id':'reference'}
    with pytest.raises(SocialError,match='personal workspace'):Posts(s)


def test_tiktok_desktop_pkce_is_hex_and_verifier_reaches_exchange(tmp_path):
    from spur.auth import Accounts
    s=Store(tmp_path/'root.db');prepare(s);a=Accounts(s);user=a.create_user('owner','Owner','long-test-password');session=a.create_session(user['id'])
    result=begin_oauth(s,s,user['id'],session['token'],'tiktok',publishing=True);query=parse_qs(urlparse(result['url']).query)
    assert query['scope']==['user.info.basic,video.publish,video.upload'] and query['code_challenge_method']==['S256']
    with s.connect() as db:payload=unseal(db.execute('SELECT payload FROM social_oauth_tickets').fetchone()[0])
    assert query['code_challenge']==[hashlib.sha256(payload['verifier'].encode()).hexdigest()]
    def handler(request):
        if request.url.path.endswith('/oauth/token/'):
            body=parse_qs(request.content.decode());assert body['code_verifier']==[payload['verifier']]
            return httpx.Response(200,json={'access_token':'new','expires_in':3600,'scope':'user.info.basic,video.upload','open_id':'creator-id'})
        return httpx.Response(200,json={'data':{'user':{'open_id':'creator-id','display_name':'Studio'}},'error':{'code':'ok'}})
    invoke(handler,lambda transport:exchange_code(s,'tiktok','code',payload,transport))
    assert 'video.upload' in SocialStore(s).connection('tiktok')['tokens']['scope']


def test_desktop_login_mode_change_rejects_inflight_authorization(tmp_path):
    from spur.auth import Accounts
    s=Store(tmp_path/'root.db');prepare(s);a=Accounts(s);user=a.create_user('owner','Owner','long-test-password');session=a.create_session(user['id'])
    begin_oauth(s,s,user['id'],session['token'],'tiktok',publishing=True)
    with s.connect() as db:payload=unseal(db.execute('SELECT payload FROM social_oauth_tickets').fetchone()[0])
    s.set_runtime('tiktok_login',{'mode':'web','client_id':'client'})
    def reject(request):pytest.fail('Changed platform must be rejected before exchanging credentials')
    with pytest.raises(SocialError,match='mode changed'):invoke(reject,lambda transport:exchange_code(s,'tiktok','code',payload,transport))


def test_upload_logs_redact_other_signature_query_fields(caplog):
    with caplog.at_level(logging.INFO,logger='httpx'):
        logging.getLogger('httpx').info('HTTP Request: %s %s','PUT',httpx.URL('https://upload.us.tiktokapis.com/video/?upload_id=1&signature=do-not-log-signature'))
    assert 'do-not-log-signature' not in caplog.text


def test_api_csrf_and_workspace_boundaries(client):
    assert client.post('/publishing/tiktok',json={}).status_code==403
    assert client.get('/publishing/tiktok').status_code==200
    root=client.app.state.store;posts,post=prepare(root)
    assert client.post('/publishing/tiktok/'+post['id']+'/dispatch',headers=client.csrf,json={}).status_code==422
    assert client.post('/publishing/tiktok/'+post['id']+'/cancel',headers=client.csrf).status_code==200
