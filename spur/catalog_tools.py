"""Shared read-only access to the active profile's complete saved video catalog."""
from pydantic import BaseModel,Field,ConfigDict
from spur.mock_profiles import media,context
from spur.video_search import SearchError

class BrowseInput(BaseModel):
    model_config=ConfigDict(extra='forbid')
    query:str=Field(default='',max_length=200)
    offset:int=Field(default=0,ge=0)
    limit:int=Field(default=20,ge=1,le=20)

class VideoInput(BaseModel):
    model_config=ConfigDict(extra='forbid')
    video_id:str=Field(min_length=1,max_length=200)

TOOLS=[{'type':'function','function':{'name':'browse_collected_videos','description':'Read/search any video in the active mock/reference profile saved catalog, including old uploads. No default date cutoff and no external request. Paginate with next_offset; the page is not the entire catalog. Use before claiming a video or its data is unavailable. Empty query browses all records.','parameters':{'type':'object','properties':{'query':{'type':'string','maxLength':200},'offset':{'type':'integer','minimum':0},'limit':{'type':'integer','minimum':1,'maximum':20}},'required':['query','offset','limit'],'additionalProperties':False}}},
 {'type':'function','function':{'name':'read_collected_video','description':'Read the full saved metadata record for one video ID in this profile, including its stored description, views, likes, comments, publication date and measurement time. This is catalog/database access, not watching or downloading the video.','parameters':{'type':'object','properties':{'video_id':{'type':'string','minLength':1,'maxLength':200}},'required':['video_id'],'additionalProperties':False}}}]


def browse(store,value):
    profile=context(store)
    if not profile:raise SearchError('Open a mock/reference profile to browse its saved catalog.')
    all_rows=media(store);query=value.query.strip().casefold()
    rows=[r for r in all_rows if not query or query in (r['title']+' '+r.get('description','')+' '+r['id']).casefold()]
    page=rows[value.offset:value.offset+value.limit]
    return {'catalog_records':len(all_rows),'matching_records':len(rows),'offset':value.offset,'next_offset':value.offset+len(page) if value.offset+len(page)<len(rows) else None,'coverage':profile['coverage'],'items':[{k:r.get(k) for k in ('id','title','url','creator','platform','format','published','observed_at','metrics','detail_status')}|{'description_excerpt':r.get('description','')[:400],'description_is_excerpt':len(r.get('description',''))>400} for r in page],'scope':'Complete saved profile catalog; no publication-date cutoff. This is one page of database records, not the entire catalog and not video footage.'}


def read(store,value):
    if not getattr(store,'mock_profile',None):raise SearchError('Open a mock/reference profile first.')
    for row in media(store):
        if row['id']==value.video_id:return {'video':row,'scope':'Full saved metadata record in the active profile. No video/audio/transcript access is implied.'}
    raise SearchError('That video ID is not in the active profile catalog. Browse this profile to find the correct ID.')


def dispatch(store,name,arguments):
    return browse(store,BrowseInput.model_validate(arguments)) if name=='browse_collected_videos' else read(store,VideoInput.model_validate(arguments))
