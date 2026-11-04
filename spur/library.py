"""Private content records, portable metadata and locally stored creative assets."""
import csv
import io
import json
import re
import time
import uuid
from datetime import date
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

SCHEMA = """
CREATE TABLE IF NOT EXISTS content_library (
 id TEXT PRIMARY KEY, document TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
 archived INTEGER NOT NULL DEFAULT 0, origin_key TEXT UNIQUE, created REAL NOT NULL, updated REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS content_library_updated ON content_library(updated);
CREATE TABLE IF NOT EXISTS content_assets (
 id TEXT PRIMARY KEY, content_id TEXT NOT NULL REFERENCES content_library(id),
 filename TEXT NOT NULL, media_type TEXT NOT NULL, size INTEGER NOT NULL, role TEXT NOT NULL, created REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS content_assets_parent ON content_assets(content_id);
CREATE TABLE IF NOT EXISTS content_changes (
 id INTEGER PRIMARY KEY AUTOINCREMENT, content_id TEXT NOT NULL REFERENCES content_library(id),
 message TEXT NOT NULL, created REAL NOT NULL
);
"""

FORMATS = [
    {'id': 'youtube_video', 'label': 'YouTube video', 'platform': 'youtube', 'ratio': '16:9'},
    {'id': 'youtube_short', 'label': 'YouTube Short', 'platform': 'youtube', 'ratio': '9:16'},
    {'id': 'tiktok_video', 'label': 'TikTok video', 'platform': 'tiktok', 'ratio': '9:16'},
    {'id': 'instagram_reel', 'label': 'Instagram Reel', 'platform': 'instagram', 'ratio': '9:16'},
    {'id': 'instagram_carousel', 'label': 'Instagram carousel', 'platform': 'instagram', 'ratio': '4:5'},
    {'id': 'instagram_story', 'label': 'Instagram Story', 'platform': 'instagram', 'ratio': '9:16'},
    {'id': 'image_post', 'label': 'Image post', 'platform': 'other', 'ratio': '1:1'},
    {'id': 'article', 'label': 'Article / newsletter', 'platform': 'other', 'ratio': ''},
    {'id': 'podcast', 'label': 'Podcast', 'platform': 'other', 'ratio': ''},
    {'id': 'other', 'label': 'Other content', 'platform': 'other', 'ratio': ''},
]
STAGES = [('idea', 'Idea'), ('drafting', 'Drafting'), ('production', 'In production'),
          ('review', 'In review'), ('scheduled', 'Scheduled'), ('published', 'Published')]
MEDIA = {'.mp4':'video/mp4', '.mov':'video/quicktime', '.webm':'video/webm',
         '.mp3':'audio/mpeg', '.wav':'audio/wav', '.m4a':'audio/mp4',
         '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png', '.webp':'image/webp',
         '.pdf':'application/pdf', '.txt':'text/plain', '.md':'text/plain', '.srt':'text/plain', '.vtt':'text/vtt'}
MAX_ASSET_BYTES = 250 * 1024 * 1024


class LibraryError(ValueError):
    def __init__(self, message, status=422):
        super().__init__(message)
        self.status = status


class ContentInput(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)
    title: str = Field(min_length=1, max_length=300)
    format: Literal['youtube_video','youtube_short','tiktok_video','instagram_reel','instagram_carousel','instagram_story','image_post','article','podcast','other'] = 'youtube_video'
    kind: Literal['own','reference'] = 'own'
    stage: Literal['idea','drafting','production','review','scheduled','published'] = 'idea'
    campaign: str = Field(default='', max_length=160)
    owner_agent_id: str = Field(default='', max_length=100)
    audience: str = Field(default='', max_length=1000)
    objective: str = Field(default='', max_length=1000)
    brief: str = Field(default='', max_length=20000)
    script: str = Field(default='', max_length=60000)
    caption: str = Field(default='', max_length=12000)
    tags: list[str] = Field(default_factory=list, max_length=20)
    due_date: str = ''
    publish_date: str = ''
    source_url: str = Field(default='', max_length=2048)
    live_url: str = Field(default='', max_length=2048)
    report_ids: list[str] = Field(default_factory=list, max_length=20)
    cover_asset_id: str = Field(default='', max_length=100)

    @field_validator('due_date', 'publish_date')
    @classmethod
    def valid_date(cls, value):
        if value and (not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value) or date.fromisoformat(value).isoformat()!=value):
            raise ValueError('Use a valid YYYY-MM-DD date')
        return value

    @field_validator('source_url', 'live_url')
    @classmethod
    def valid_url(cls, value):
        if value:
            try:
                url=urlsplit(value)
                if url.scheme!='https' or not url.hostname or url.username or url.password or any(ord(c)<33 for c in value):
                    raise ValueError()
            except ValueError:
                raise ValueError('Use an HTTPS link without credentials')
        return value

    @field_validator('tags', 'report_ids')
    @classmethod
    def valid_list(cls, value):
        if any(not v.strip() or len(v)>100 for v in value):
            raise ValueError('Entries must contain 1–100 characters')
        return list(dict.fromkeys(v.strip() for v in value))

    @model_validator(mode='after')
    def stage_requirements(self):
        if self.stage=='scheduled' and not self.publish_date:
            raise ValueError('Choose a publication date before marking content Scheduled')
        if self.stage=='published' and not self.live_url:
            raise ValueError('Add the live post link before marking content Published')
        return self


class ContentUpdate(ContentInput):
    version: int = Field(ge=1)


class Library:
    def __init__(self, store):
        self.store=store
        self.asset_dir=Path(store.path).resolve().parent/'content_assets'

    @staticmethod
    def record(row):
        return {**json.loads(row['document']), **{k:row[k] for k in ('id','version','archived','created','updated')}}

    def list(self, archived=False):
        with self.store.connect() as db:
            return [self.record(r) for r in db.execute('SELECT * FROM content_library WHERE archived=? ORDER BY updated DESC', (int(archived),))]

    def get(self, content_id):
        with self.store.connect() as db:
            row=db.execute('SELECT * FROM content_library WHERE id=?',(content_id,)).fetchone()
            if not row: raise LibraryError('Content not found',404)
            result=self.record(row)
            result['assets']=[dict(r) for r in db.execute('SELECT * FROM content_assets WHERE content_id=? ORDER BY created',(content_id,))]
            result['changes']=[dict(r) for r in db.execute('SELECT message,created FROM content_changes WHERE content_id=? ORDER BY id DESC LIMIT 30',(content_id,))]
            return result

    @staticmethod
    def change(db, content_id, message):
        db.execute('INSERT INTO content_changes(content_id,message,created) VALUES(?,?,?)',(content_id,message,time.time()))

    def validate_links(self, db, doc, content_id=''):
        if doc['owner_agent_id'] and not db.execute('SELECT 1 FROM agents WHERE id=?',(doc['owner_agent_id'],)).fetchone():
            raise LibraryError('Assigned agent not found')
        for report_id in doc['report_ids']:
            if not db.execute('SELECT 1 FROM reports WHERE id=?',(report_id,)).fetchone():
                raise LibraryError('Linked output not found')
        if doc['cover_asset_id'] and not db.execute('SELECT 1 FROM content_assets WHERE id=? AND content_id=? AND media_type LIKE ?',(doc['cover_asset_id'],content_id,'image/%')).fetchone():
            raise LibraryError('Choose an image attached to this content as the cover')

    def create(self, body, origin_key=None):
        doc=ContentInput.model_validate(body).model_dump(); content_id=uuid.uuid4().hex; now=time.time()
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            if origin_key:
                existing=db.execute('SELECT id FROM content_library WHERE origin_key=?',(origin_key,)).fetchone()
                if existing:return self.get(existing[0])
            self.validate_links(db,doc)
            db.execute('INSERT INTO content_library VALUES(?,?,1,0,?,?,?)',(content_id,json.dumps(doc,ensure_ascii=False),origin_key,now,now))
            self.change(db,content_id,'Added to the content library')
        return self.get(content_id)

    def update(self, content_id, body):
        value=ContentUpdate.model_validate(body); doc=value.model_dump(exclude={'version'})
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row=db.execute('SELECT * FROM content_library WHERE id=?',(content_id,)).fetchone()
            if not row:raise LibraryError('Content not found',404)
            if row['version']!=value.version:raise LibraryError('This content changed elsewhere. Reopen it before saving your edits.',409)
            self.validate_links(db,doc,content_id)
            old=json.loads(row['document'])
            db.execute('UPDATE content_library SET document=?,version=version+1,updated=? WHERE id=?',(json.dumps(doc,ensure_ascii=False),time.time(),content_id))
            self.change(db,content_id,f"Stage: {old['stage']} → {doc['stage']}" if old['stage']!=doc['stage'] else 'Content details updated')
        return self.get(content_id)

    def archive(self, content_id, archived, version):
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row=db.execute('SELECT version FROM content_library WHERE id=?',(content_id,)).fetchone()
            if not row:raise LibraryError('Content not found',404)
            if row['version']!=version:raise LibraryError('Content changed. Reopen it before archiving or restoring.',409)
            db.execute('UPDATE content_library SET archived=?,version=version+1,updated=? WHERE id=?',(int(archived),time.time(),content_id))
            self.change(db,content_id,'Archived' if archived else 'Restored to library')
        return self.get(content_id)

    def import_video(self, video_id):
        with self.store.connect() as db:
            row=db.execute('SELECT items.*,sources.name AS source_name FROM items JOIN sources ON sources.id=items.source_id WHERE items.id=?',(video_id,)).fetchone()
        if not row:raise LibraryError('Collected video not found',404)
        return self.create({'title':row['title'][:300],'kind':'reference','stage':'published','live_url':row['url'],
            'source_url':row['url'],'brief':f"Reference from {row['source_name']}\n\n{row['description']}"[:20000],
            'publish_date':date.fromtimestamp(row['published']).isoformat()},'collected:'+video_id)

    def import_social(self, platform, external_id):
        from spur.social import SocialStore
        snapshot=SocialStore(self.store).latest(platform,28)
        if not snapshot:raise LibraryError('Sync a 28-day account analytics snapshot first',404)
        row=next((r for r in snapshot.get('content',[]) if r['id']==external_id),None)
        if not row:raise LibraryError('Content not found in the latest account snapshot',404)
        return self.create({'title':row['title'][:300] or 'Published content','kind':'own','stage':'published',
            'format':'youtube_video' if platform=='youtube' else 'other', 'source_url':row['url'],'live_url':row['url'],
            'brief':f"Imported from connected {platform} account: {snapshot['account_name']}. Media files are not downloaded."},platform+':'+external_id)

    def asset(self, content_id, asset_id):
        with self.store.connect() as db:
            row=db.execute('SELECT * FROM content_assets WHERE content_id=? AND id=?',(content_id,asset_id)).fetchone()
        if not row:raise LibraryError('Asset not found',404)
        return dict(row)

    def asset_path(self, asset_id):
        # Only generated IDs from the private workspace database reach this path.
        if not re.fullmatch(r'[a-f0-9]{32}',asset_id):raise LibraryError('Asset not found',404)
        return self.asset_dir/asset_id

    def add_asset(self, content_id, asset_id, filename, media_type, size, role):
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row=db.execute('SELECT document FROM content_library WHERE id=?',(content_id,)).fetchone()
            if not row:raise LibraryError('Content not found',404)
            if db.execute('SELECT count(*) FROM content_assets WHERE content_id=?',(content_id,)).fetchone()[0]>=50:
                raise LibraryError('A content item can have up to 50 files')
            db.execute('INSERT INTO content_assets VALUES(?,?,?,?,?,?,?)',(asset_id,content_id,filename,media_type,size,role,time.time()))
            doc=json.loads(row[0])
            if media_type.startswith('image/') and not doc['cover_asset_id']:doc['cover_asset_id']=asset_id
            db.execute('UPDATE content_library SET document=?,version=version+1,updated=? WHERE id=?',(json.dumps(doc,ensure_ascii=False),time.time(),content_id))
            self.change(db,content_id,'Attached '+filename)
        return self.get(content_id)

    def delete_asset(self, content_id, asset_id):
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            asset=db.execute('SELECT filename FROM content_assets WHERE id=? AND content_id=?',(asset_id,content_id)).fetchone()
            if not asset:raise LibraryError('Asset not found',404)
            row=db.execute('SELECT document FROM content_library WHERE id=?',(content_id,)).fetchone()
            doc=json.loads(row[0])
            if doc['cover_asset_id']==asset_id:doc['cover_asset_id']=''
            db.execute('DELETE FROM content_assets WHERE id=?',(asset_id,))
            db.execute('UPDATE content_library SET document=?,version=version+1,updated=? WHERE id=?',(json.dumps(doc,ensure_ascii=False),time.time(),content_id))
            self.change(db,content_id,'Removed '+asset[0])
        self.asset_path(asset_id).unlink(missing_ok=True)
        return self.get(content_id)

    def context(self, request=''):
        rows=self.list()
        rows.sort(key=lambda r:(r['id'] in request, r['updated']),reverse=True)
        result=[]
        for r in rows[:20]:
            selected=r['id'] in request
            item={**{k:r[k] for k in ('id','title','kind','format','stage','campaign','owner_agent_id','audience','objective','due_date','publish_date','live_url','source_url','report_ids')},
                  'brief':r['brief'][:1800 if selected else 400],
                  'script':r['script'][:9000] if selected else '', 'caption':r['caption'][:3000] if selected else ''}
            if selected:
                item['attached_files']=[{k:a[k] for k in ('filename','role','size','media_type')} for a in self.get(r['id'])['assets']]
                item['linked_outputs']=[]
                for report_id in r['report_ids'][:3]:
                    output=self.store.reports(report_id)
                    if output:item['linked_outputs'].append({'id':report_id,'content_excerpt':json.dumps(output['content'],ensure_ascii=False)[:7000]})
            result.append(item)
        return result

    def export(self, kind, archived=False):
        rows=[self.get(r['id']) for r in self.list(archived)]
        if kind=='json':return json.dumps({'schema_version':1,'content':rows},ensure_ascii=False,indent=2)
        output=io.StringIO(newline=''); fields=list(ContentInput.model_fields)+['id','version','archived','created','updated']
        writer=csv.DictWriter(output,fieldnames=fields);writer.writeheader()
        for row in rows:
            values={k:json.dumps(row[k],ensure_ascii=False) if isinstance(row[k],list) else str(row[k]) for k in fields}
            # Keep user text as text when opened by a spreadsheet application.
            writer.writerow({k:"'"+v if v.lstrip().startswith(('=','+','-','@')) or v.startswith(('\t','\r')) else v for k,v in values.items()})
        return output.getvalue()
