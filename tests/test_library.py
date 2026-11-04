import csv
import io
import json
import time
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from spur.config import Settings
from spur.library import Library,LibraryError,ContentInput
from spur.store import Store


@pytest.fixture
def client(tmp_path,monkeypatch):
    import spur.api as api
    monkeypatch.setattr(api,'settings',replace(Settings(),db_path=str(tmp_path/'root.db'),api_key='library-service'))
    with TestClient(api.app) as client:
        signup=client.post('/auth/register',headers={'X-Spur-Auth':'1'},json={'username':'owner','display_name':'Owner','password':'test-passphrase-long'})
        assert signup.status_code==201
        client.csrf={'X-CSRF-Token':signup.json()['csrf_token']}
        yield client


def create(client,**kwargs):
    response=client.post('/content',headers=client.csrf,json={'title':'Paris travel guide',**kwargs})
    assert response.status_code==201,response.text
    return response.json()


def update_body(item,**kwargs):
    return {**{key:item[key] for key in ContentInput.model_fields},'version':item['version'],**kwargs}


def test_library_persists_updates_filters_and_recovers_archive(client):
    item=create(client,campaign='Paris autumn',owner_agent_id='script-writer',tags=['Paris','Paris'],script='Scene 1: arrive in Paris')
    assert item['tags']==['Paris'] and item['version']==1
    saved=client.put('/content/'+item['id'],headers=client.csrf,json=update_body(item,stage='production')).json()
    assert saved['version']==2 and saved['stage']=='production'
    stale=client.put('/content/'+item['id'],headers=client.csrf,json=update_body(item,title='Stale overwrite'))
    assert stale.status_code==409
    assert client.get('/content/'+item['id']).json()['title']=='Paris travel guide'
    archived=client.post('/content/'+item['id']+'/archive',headers=client.csrf,json={'archived':True,'version':saved['version']}).json()
    assert client.get('/content').json()['items']==[]
    assert client.get('/content?archived=true').json()['items'][0]['id']==item['id']
    restored=client.post('/content/'+item['id']+'/archive',headers=client.csrf,json={'archived':False,'version':archived['version']}).json()
    assert not restored['archived'] and len(restored['changes'])==4
    # Reopening the SQLite database keeps briefs, scripts, versions, and history.
    library=Library(Store(client.app.state.store.path))
    assert library.get(item['id'])['script']=='Scene 1: arrive in Paris'


@pytest.mark.parametrize('patch',[
    {'stage':'scheduled'}, {'stage':'published'}, {'publish_date':'2026-02-30'},
    {'due_date':'2026-1-1'},{'live_url':'javascript:alert(1)'},{'source_url':'https://user:password@example.com'},
    {'format':'invented'}, {'owner_agent_id':'foreign-agent'}, {'report_ids':['foreign-output']},
    {'cover_asset_id':'foreign-asset'},{'title':'   '}, {'unexpected':'field'},
])
def test_invalid_content_cannot_be_saved(client,patch):
    assert client.post('/content',headers=client.csrf,json={'title':'A video',**patch}).status_code==422


def test_published_is_a_live_link_and_scheduled_is_a_plan(client):
    item=create(client,stage='scheduled',publish_date='2026-11-08')
    response=client.put('/content/'+item['id'],headers=client.csrf,json=update_body(item,stage='published',live_url='https://www.youtube.com/watch?v=abcdefghijk'))
    assert response.status_code==200
    assert response.json()['stage']=='published'
    with client.app.state.store.connect() as db:
        assert db.execute('SELECT count(*) FROM jobs').fetchone()[0]==0 # Status never enqueues publication.


def test_imported_collected_video_is_reference_and_deduplicated(client):
    store=client.app.state.store
    source=store.add_source('UC'+'a'*22,'Paris channel')
    store.save_items(source['id'],[{'id':'abcdefghijk','title':'A walk through Paris','description':'Locations and timings','url':'https://www.youtube.com/watch?v=abcdefghijk','published':time.time()-100}])
    candidates=client.get('/content/import-candidates').json()
    assert candidates[0]['kind']=='reference'
    first=client.post('/content/import',headers=client.csrf,json={'source':'collected','external_id':'abcdefghijk'}).json()
    second=client.post('/content/import',headers=client.csrf,json={'source':'collected','external_id':'abcdefghijk'}).json()
    assert first['id']==second['id'] and first['kind']=='reference' and first['stage']=='published'
    assert 'Paris channel' in first['brief'] and len(client.get('/content').json()['items'])==1
    assert client.post('/content/import',headers=client.csrf,json={'source':'collected','external_id':'foreign'}).status_code==404


def test_imported_connected_post_is_own_content_without_downloading_media(client):
    with client.app.state.store.connect() as db:
        snapshot={'account_name':'My Paris channel','content':[{'id':'abcdefghijk','title':'My trip','url':'https://www.youtube.com/watch?v=abcdefghijk'}]}
        db.execute('INSERT INTO social_snapshots VALUES(?,?,?,?,?,?)',('snapshot','youtube','my-account',28,json.dumps(snapshot),time.time()))
    item=client.post('/content/import',headers=client.csrf,json={'source':'youtube','external_id':'abcdefghijk'}).json()
    assert item['kind']=='own' and item['stage']=='published' and item['assets']==[]


def test_private_upload_preview_remove_and_cover_validation(client,monkeypatch):
    import spur.api as api
    item=create(client);base='/content/'+item['id']+'/assets'
    assert client.post(base+'?filename=photo.png',content=b'file').status_code==403
    response=client.post(base+'?filename=../../photo.png&role=thumbnail',headers=client.csrf,content=b'\x89PNG\r\n\x1a\nimage')
    assert response.status_code==201,response.text
    item=response.json();asset=item['assets'][0]
    assert asset['filename']=='photo.png' and item['cover_asset_id']==asset['id']
    preview=client.get(base+'/'+asset['id'])
    assert preview.content.startswith(b'\x89PNG') and preview.headers['content-type']=='image/png'
    assert preview.headers['content-disposition'].startswith('inline') and preview.headers['cache-control']=='no-store'
    assert client.get(base+'/'+asset['id']+'?download=true').headers['content-disposition'].startswith('attachment')
    assert client.post(base+'?filename=payload.html',headers=client.csrf,content=b'<script>').status_code==422
    assert client.post(base+'?filename=empty.mp4',headers=client.csrf,content=b'').status_code==422
    monkeypatch.setattr(api,'MAX_ASSET_BYTES',4)
    assert client.post(base+'?filename=huge.mp4',headers=client.csrf,content=b'12345').status_code==413
    other=create(client,title='Another video')
    assert client.put('/content/'+other['id'],headers=client.csrf,json=update_body(other,cover_asset_id=asset['id'])).status_code==422
    path=Library(client.app.state.store).asset_path(asset['id']);assert path.exists()
    deleted=client.delete(base+'/'+asset['id'],headers=client.csrf).json()
    assert deleted['assets']==[] and deleted['cover_asset_id']=='' and not path.exists()
    assert client.get(base+'/'+asset['id']).status_code==404


def test_exports_portable_metadata_and_preserves_literal_text(client):
    item=create(client,title='=SUM(1,2)',brief='A brief\nwith two lines',tags=['travel','Paris'])
    response=client.get('/content/export?format=csv')
    row=list(csv.DictReader(io.StringIO(response.text)))[0]
    assert row['title']=="'=SUM(1,2)" and row['brief']=='A brief\nwith two lines'
    assert json.loads(row['tags'])==['travel','Paris']
    exported=client.get('/content/export?format=json').json()
    assert exported['schema_version']==1 and exported['content'][0]['id']==item['id']
    assert exported['content'][0]['title']=='=SUM(1,2)'


def test_accounts_cannot_read_or_mutate_other_libraries_or_files(client):
    first=create(client)
    uploaded=client.post('/content/'+first['id']+'/assets?filename=private.txt',headers=client.csrf,content=b'Private owner script').json()
    asset=uploaded['assets'][0]
    client.post('/auth/logout',headers=client.csrf)
    signup=client.post('/auth/register',headers={'X-Spur-Auth':'1'},json={'username':'second','display_name':'Second','password':'test-passphrase-long'})
    client.csrf={'X-CSRF-Token':signup.json()['csrf_token']}
    assert client.get('/content').json()['items']==[]
    assert client.get('/content/'+first['id']).status_code==404
    assert client.get('/content/'+first['id']+'/assets/'+asset['id']).status_code==404
    assert client.put('/content/'+first['id'],headers=client.csrf,json=update_body(first)).status_code==404
    assert client.delete('/content/'+first['id']+'/assets/'+asset['id'],headers=client.csrf).status_code==404
    second=create(client,title='Second creator video')
    assert second['id']!=first['id']
    assert client.get('/content/export?format=json').json()['content'][0]['title']=='Second creator video'
    client.post('/auth/logout',headers=client.csrf)
    assert client.get('/content').status_code==401
    assert client.get('/content/'+first['id']+'/assets/'+asset['id']).status_code==401


def test_agent_context_prioritizes_requested_content_and_keeps_references_explicit(tmp_path):
    store=Store(str(tmp_path/'context.db'));library=Library(store)
    reference=library.create({'title':'Competitor example','kind':'reference','brief':'Original creator research','script':'A saved draft'})
    job_id=store.enqueue('report',{})
    job=store.claim();store.finish(job,{'report_id':'output'},report={'topic':'Script','summary':'A useful output','artifact':{'kind':'script','data':{'text':'Actual script'}}})
    reference=library.update(reference['id'],{**update_body(reference),'report_ids':['output']})
    for i in range(24):library.create({'title':f'Newer content {i}'})
    assert reference['id'] not in [r['id'] for r in library.context()]
    context=library.context('Review content '+reference['id'])
    assert context[0]['kind']=='reference' and context[0]['script']=='A saved draft'
    assert 'Actual script' in context[0]['linked_outputs'][0]['content_excerpt']
    assert len(context)==20
