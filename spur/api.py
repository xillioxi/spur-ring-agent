import secrets
import hashlib
import json
import re
import time
import uuid
from pathlib import Path
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import Depends, FastAPI, HTTPException, Request, Security, Query
from fastapi.security import APIKeyHeader
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response, HTMLResponse
from fastapi.staticfiles import StaticFiles
import httpx
from pydantic import BaseModel, Field

from spur.config import settings
from spur.store import Store
from spur.youtube import CHANNEL_PATTERN
from spur.credentials import selected_connection, load_key, save_key
from spur.providers import ENDPOINTS
from spur.auth import Accounts, AuthError, COOKIE, workspace_settings
from threading import Lock
from spur.social import SocialStore, SocialError, begin_oauth, consume_oauth, exchange_code, analytics_brief, stage_oauth_return, consume_oauth_return
from spur.library import Library, LibraryError, ContentInput, ContentUpdate, FORMATS, STAGES, MEDIA, MAX_ASSET_BYTES
from spur.office import OfficeStore, OfficeSession, OfficeError, OfficeAppInput, OfficeWrite, begin_office_oauth, exchange_office_code
from spur.video_search import SearchStore,SearchInput,DataProviderInput,SearchError,search_videos
from spur.metadata_reports import MetadataReportInput,AnalyticsPermissionInput,generate as generate_metadata_report,permissions as metadata_permissions
from spur.mock_profiles import Profiles,MockProfileInput,cookie_name,context as mock_context,media as mock_media


@asynccontextmanager
async def lifespan(app):
    if not settings.api_key:
        raise RuntimeError("Set SPUR_API_KEY before starting the API")
    app.state.store = Store(settings.db_path)
    app.state.workspaces={str(Path(settings.db_path).resolve()):app.state.store}
    app.state.workspace_lock=Lock()
    yield


api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)


def is_local(request: Request):
    return (request.client is not None and request.client.host in ("127.0.0.1", "::1", "testclient")
            and request.url.hostname in ("127.0.0.1", "localhost", "::1", "testserver"))


def same_origin(request):
    origin=request.headers.get('origin')
    if origin and origin!=str(request.base_url).rstrip('/'):
        raise HTTPException(403,'Cross-origin requests are not allowed')
    if request.headers.get('sec-fetch-site')=='cross-site':raise HTTPException(403,'Cross-site requests are not allowed')


def account_session(request):
    return Accounts(request.app.state.store).session(request.cookies.get(COOKIE))


def require_account(request,mutation=False):
    session=account_session(request)
    if not session:raise HTTPException(401,'Sign in to your workspace')
    if request.url.path!='/auth/me' and request.headers.get('x-spur-user') not in (None,session['user']['id']):
        raise HTTPException(409,'The signed-in account changed.',headers={'X-Spur-Session-Error':'account'})
    if mutation:
        same_origin(request)
        if not secrets.compare_digest(request.headers.get('x-csrf-token','').encode(),session['csrf'].encode()):
            raise HTTPException(403,'Session verification failed. Refresh the page and try again.',headers={'X-Spur-Session-Error':'csrf'})
    return session


def authorize(request: Request, x_api_key: str | None = Security(api_key_header)):
    if request.method not in ('GET','HEAD','OPTIONS'):same_origin(request)
    if x_api_key and settings.api_key and secrets.compare_digest(x_api_key.encode(),settings.api_key.encode()):
        return {'role':'service'}
    return require_account(request,mutation=request.method not in ('GET','HEAD','OPTIONS'))['user']


app = FastAPI(title="Spur Ring Intelligence Agent", version="0.1.0", lifespan=lifespan)
STATIC = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.middleware('http')
async def security_headers(request,call_next):
    response=await call_next(request)
    response.headers['X-Content-Type-Options']='nosniff'
    response.headers['X-Frame-Options']='DENY'
    response.headers['Referrer-Policy']='same-origin'
    response.headers['Cache-Control']='no-cache' if request.url.path.startswith('/static/') else 'no-store'
    return response


@app.exception_handler(AuthError)
async def auth_error(request,error):
    return JSONResponse({'detail':str(error)},status_code=error.status,
                        headers={'Retry-After':'900'} if error.status==429 else {})


@app.exception_handler(SocialError)
async def social_error(request,error):return JSONResponse({'detail':str(error)},status_code=422)


@app.exception_handler(SearchError)
async def search_error(request,error):return JSONResponse({'detail':str(error)},status_code=422)


@app.exception_handler(LibraryError)
async def library_error(request,error):return JSONResponse({'detail':str(error)},status_code=error.status)


@app.exception_handler(OfficeError)
async def office_error(request,error):return JSONResponse({'detail':str(error)},status_code=error.status)


@app.get("/", include_in_schema=False)
def index(request: Request):
    if not account_session(request):return RedirectResponse('/login',status_code=303)
    return asset_page('index.html')


def asset_page(filename):
    # A fresh URL also replaces assets browsers cached before revalidation headers
    # were introduced. Versions change only when the actual file content changes.
    def version(match):
        path=STATIC/match.group(1)
        return '/static/'+match.group(1)+'?v='+hashlib.sha256(path.read_bytes()).hexdigest()[:12]
    html=re.sub(r'/static/([A-Za-z0-9_.-]+\.(?:js|css))',version,(STATIC/filename).read_text(encoding='utf-8'))
    return HTMLResponse(html,headers={'Cache-Control':'no-store'})


@app.get('/login',include_in_schema=False)
def login_page(request:Request):
    if account_session(request):return RedirectResponse('/',status_code=303)
    return asset_page('login.html')


@app.get('/signup',include_in_schema=False)
def signup_page(request:Request):
    if account_session(request):return RedirectResponse('/',status_code=303)
    return asset_page('login.html')


class LoginInput(BaseModel):
    username:str=Field(min_length=1,max_length=40)
    password:str=Field(min_length=1,max_length=128)
    remember:bool=False


class RegisterInput(LoginInput):
    display_name:str=Field(min_length=1,max_length=80)
    admin_create:bool=False


class PasswordInput(BaseModel):
    current_password:str=Field(min_length=1,max_length=128)
    new_password:str=Field(min_length=12,max_length=128)


def auth_request(request):
    same_origin(request)
    if request.headers.get('x-spur-auth')!='1':raise HTTPException(403,'Use the account form to continue')


def session_response(request,user,remember=False):
    accounts=Accounts(request.app.state.store)
    accounts.logout(request.cookies.get(COOKIE))
    session=accounts.create_session(user['id'],remember)
    response=JSONResponse({'user':user,'csrf_token':session['csrf'],'expires':session['expires']})
    response.set_cookie(COOKIE,session['token'],httponly=True,samesite='strict',secure=request.url.scheme=='https',
                        max_age=30*86400 if remember else None,path='/')
    response.delete_cookie('spur_session',path='/')
    return response


@app.get('/auth/status')
def auth_status(request:Request):
    return {'setup_required':not Accounts(request.app.state.store).has_users()}


@app.post('/auth/register',status_code=201)
def register(request:Request,body:RegisterInput):
    auth_request(request);accounts=Accounts(request.app.state.store)
    existing=accounts.has_users()
    if body.admin_create:
        session=require_account(request,mutation=True)
        if session['user']['role']!='owner':raise HTTPException(403,'Only the workspace owner can add accounts')
    else:
        if account_session(request):raise HTTPException(409,'Sign out before creating a different account.')
        accounts.reserve_signup(request.client.host if request.client else 'unknown')
        if not existing and not is_local(request):raise HTTPException(403,'Create the first owner account from localhost')
    user=accounts.create_user(body.username,body.display_name,body.password,allow_existing=existing)
    if body.admin_create:return JSONResponse({'user':user},status_code=201)
    response=session_response(request,user,body.remember);response.status_code=201;return response


@app.post('/auth/login')
def login(request:Request,body:LoginInput):
    auth_request(request)
    user=Accounts(request.app.state.store).login(body.username,body.password,request.client.host if request.client else 'unknown')
    return session_response(request,user,body.remember)


@app.get('/auth/me')
def me(request:Request):
    session=require_account(request)
    base=personal_store(request,session['user'])
    profile=Profiles(base).get(request.cookies.get(cookie_name(session['user']['id']),'false'))
    return {'user':session['user'],'csrf_token':session['csrf'],'expires':session['expires'],
            'mock_profile':profile,
            'onboarding':Accounts(request.app.state.store).onboarding(session['user']['id'])}


@app.post('/auth/onboarding/complete',status_code=204)
def complete_onboarding(request:Request):
    session=require_account(request,mutation=True)
    Accounts(request.app.state.store).complete_onboarding(session['user']['id'])
    return Response(status_code=204)


@app.post('/auth/logout',status_code=204)
def logout(request:Request):
    require_account(request,mutation=True)
    Accounts(request.app.state.store).logout(request.cookies.get(COOKIE))
    response=Response(status_code=204);response.delete_cookie(COOKIE,path='/');response.delete_cookie('spur_session',path='/')
    return response


@app.post('/auth/password')
def change_password(request:Request,body:PasswordInput):
    session=require_account(request,mutation=True)
    Accounts(request.app.state.store).change_password(session['user']['id'],body.current_password,body.new_password)
    return session_response(request,session['user'])


@app.get('/auth/users')
def list_users(request:Request):
    session=require_account(request)
    if session['user']['role']!='owner':raise HTTPException(403,'Only the workspace owner can view accounts')
    return Accounts(request.app.state.store).users()


def personal_store(request: Request,user=Depends(authorize)):
    if user.get('role')=='service':return request.app.state.store
    path=Accounts(request.app.state.store).workspace_path(user['id'])
    with request.app.state.workspace_lock:
        if path not in request.app.state.workspaces:request.app.state.workspaces[path]=Store(path)
        request.app.state.workspaces[path].platform_store=request.app.state.store
        return request.app.state.workspaces[path]


def store(request:Request,user=Depends(authorize)):
    base=personal_store(request,user)
    if user.get('role')=='service':return base
    info=Profiles(base).get(request.cookies.get(cookie_name(user['id']),''))
    expected=request.headers.get('X-Spur-Profile')
    if expected is not None and expected!=(info['id'] if info else 'personal'):raise HTTPException(409,'The active workspace changed. Reload to continue.',headers={'X-Spur-Session-Error':'workspace'})
    if not info:return base
    if request.method not in ('GET','HEAD'):
        path=request.url.path
        if (path.startswith('/office/') or path.startswith('/social/') and not path.endswith('/brief') or path.startswith('/search/providers') or path.startswith('/admin/') or path.startswith('/settings/') and request.method=='PUT' and path!='/settings/provider'):
            raise HTTPException(403,'This is a mock workspace. Return to your personal workspace to manage credentials, connect accounts or edit external services.')
    key='mock:'+str(base.path)+':'+info['id']
    with request.app.state.workspace_lock:
        if key not in request.app.state.workspaces:request.app.state.workspaces[key]=Profiles(base).workspace(info['id'])
        child=request.app.state.workspaces[key];child.mock_profile=info
        return child


def workspace_config(db):return workspace_settings(settings,getattr(db,'profile_parent',db).path)


def require_platform_owner(request,mutation=False):
    session=require_account(request,mutation)
    if Profiles(personal_store(request,session['user'])).get(request.cookies.get(cookie_name(session['user']['id']),'')):raise HTTPException(403,'Exit the mock workspace before changing installation settings.')
    if session['user']['role']!='owner':raise HTTPException(403,'Only the installation owner can configure platform connections')
    return session


def public_registration(value,request,callback):
    session=account_session(request)
    owner=bool(session and session['user']['role']=='owner')
    value={**value,'callback_url':value.get('callback_url') or value.get('redirect_uri') or str(request.base_url).rstrip('/')+callback,'can_manage':owner}
    if not owner:
        for key in ('client_id','tenant','has_client_secret','api_version','scopes','redirect_uri','callback_url','audit_reference'):value.pop(key,None)
    return value


class LibraryImport(BaseModel):
    source: Literal['collected','youtube','instagram']
    external_id: str = Field(min_length=1,max_length=200)


class LibraryArchive(BaseModel):
    archived: bool
    version: int = Field(ge=1)


@app.get('/search/providers')
def search_providers(db=Depends(store)):
    connection=SocialStore(db).connection('youtube')
    return {'youtube':{'ready':bool(connection and connection['status']=='connected'),'provider':'youtube_official'},'tikhub':SearchStore(db).public(),'platforms':['youtube','tiktok','instagram','rednote'],'unsupported':['linkedin'],'mock_profile':mock_context(db)}


@app.get('/mock-profiles')
def mock_profiles(db=Depends(personal_store)):
    from spur.official_instagram import ready
    provider=SearchStore(db).public()
    return {'profiles':Profiles(db).creators(),'official_instagram':{'ready':ready(db)},'public_import_provider':{k:provider[k] for k in ('configured','enabled','usage','monthly_budget_usd')}}


@app.post('/mock-profiles',status_code=201)
def create_mock_profile(body:MockProfileInput,db=Depends(personal_store)):
    return Profiles(db).create(body)


class ActivateMockInput(BaseModel):
    profile_id:str|None=None


@app.post('/mock-profiles/activate')
def activate_mock_profile(body:ActivateMockInput,request:Request,db=Depends(personal_store)):
    session=require_account(request,mutation=True)
    if body.profile_id and not Profiles(db).get(body.profile_id):raise SearchError('Mock profile not found in this account.')
    if body.profile_id:body.profile_id=Profiles(db).get(body.profile_id).get('workspace_id') or body.profile_id
    response=JSONResponse({'profile_id':body.profile_id})
    if body.profile_id:response.set_cookie(cookie_name(session['user']['id']),body.profile_id,httponly=True,samesite='strict',secure=request.url.scheme=='https',max_age=30*86400)
    else:response.delete_cookie(cookie_name(session['user']['id']))
    return response


@app.post('/mock-profiles/{profile_id}/refresh')
def refresh_mock_profile(profile_id:str,body:dict|None=None,db=Depends(personal_store)):
    provider=(body or {}).get('provider')
    if provider not in (None,'official','tikhub','public_pages'):raise SearchError('Choose official, tikhub or public_pages as the data source.')
    return Profiles(db).resume(profile_id,provider=provider,public_page_ack=(body or {}).get('public_page_ack') is True,page_limit=(body or {}).get('page_limit',200))


@app.post('/mock-profiles/{profile_id}/advance')
def advance_mock_profile(profile_id:str,db=Depends(personal_store)):
    return Profiles(db).resume(profile_id,advance=True)


@app.post('/mock-profile/metadata',status_code=202)
def collect_profile_metadata(db=Depends(store)):
    from spur.profile_collection import start
    return start(db)


@app.post('/mock-profile/metadata/pause')
def pause_profile_metadata(db=Depends(store)):
    from spur.profile_collection import start
    return start(db,stop=True)


@app.get('/mock-profile/analytics')
def profile_analytics(days:int=Query(default=0,ge=0,le=3650),format:Literal['all','video','short','live','image']='all',sort:Literal['performance','views','interactions','growth','recent']='performance',offset:int=Query(default=0,ge=0),limit:int=Query(default=50,ge=1,le=100),platform:Literal['all','youtube','instagram','tiktok']='all',db=Depends(store)):
    from spur.profile_analytics import analyze
    return analyze(db,days,format,sort,offset,limit,platform=platform)


@app.get('/mock-profile/context')
def mock_profile_context(db=Depends(store)):
    return {'profile':mock_context(db)}


@app.get('/mock-profile/insights')
def profile_insights(db=Depends(store)):
    from spur.proactive_insights import feed
    return feed(db)


class InsightPreferences(BaseModel):
    enabled:bool


@app.put('/mock-profile/insights')
def update_profile_insights(body:InsightPreferences,db=Depends(store)):
    from spur.proactive_insights import configure
    return configure(db,body.enabled)


@app.get('/mock-profile/media')
def mock_profile_media(offset:int=Query(default=0,ge=0),limit:int=Query(default=24,ge=1,le=100),db=Depends(store)):
    if not getattr(db,'mock_profile',None):raise SearchError('Activate a mock profile first.')
    rows=mock_media(db);return {'items':rows[offset:offset+limit],'total':len(rows)}


@app.put('/search/providers/tikhub')
def search_data_setup(body:DataProviderInput,db=Depends(store)):
    SearchStore(db).save(body)
    return SearchStore(db).public()


@app.post('/search/videos')
async def search_video_endpoint(body:SearchInput,db=Depends(store)):
    async with httpx.AsyncClient() as client:
        return await search_videos(db,body,client)


@app.get('/search/history')
def search_history(db=Depends(store)):
    return {'runs':SearchStore(db).runs()}


@app.get('/search/history/{search_id}')
def search_snapshot(search_id:str,db=Depends(store)):
    return SearchStore(db).run(search_id)


@app.post('/search/reports')
def create_search_report(body:MetadataReportInput,db=Depends(store)):
    return generate_metadata_report(db,body)


@app.get('/search/analytics-permissions')
def search_analytics_permissions(db=Depends(store)):
    return {'youtube_approved':metadata_permissions(db)['youtube_approved']}


@app.put('/admin/search/analytics-permissions')
def save_search_analytics_permissions(body:AnalyticsPermissionInput,request:Request):
    require_platform_owner(request,mutation=True)
    root=request.app.state.store
    previous=metadata_permissions(root)
    reference=body.approval_reference.strip() or (previous.get('approval_reference','') if previous['youtube_approved'] else '')
    if body.youtube_approved and not reference:raise SearchError('Record the existing Google analytics approval or amendment reference. This setting does not apply for or grant approval.')
    with root.connect() as db:registration=db.execute("SELECT client_id FROM social_apps WHERE platform='youtube'").fetchone()
    if body.youtube_approved and not registration:raise SearchError('Configure the YouTube Google application before recording its analytics approval.')
    root.set_runtime('metadata_analytics_permissions',{**body.model_dump(),'approval_reference':reference,'youtube_client_id':registration['client_id'] if registration else ''})
    return {'youtube_approved':body.youtube_approved}


@app.get('/content')
def content_library(archived: bool=False,db=Depends(store)):
    return {'items':Library(db).list(archived),'formats':FORMATS,
            'stages':[{'id':key,'label':label} for key,label in STAGES],
            'upload_extensions':list(MEDIA),'max_asset_bytes':MAX_ASSET_BYTES}


@app.get('/content/export')
def export_content(format: Literal['csv','json']='csv',archived: bool=False,db=Depends(store)):
    return Response(Library(db).export(format,archived),media_type='text/csv; charset=utf-8' if format=='csv' else 'application/json',
                    headers={'Content-Disposition':f'attachment; filename="spur-content-library.{format}"'})


@app.get('/content/import-candidates')
def content_candidates(db=Depends(store)):
    result=[{'source':'collected','external_id':r['id'],'title':r['title'],'label':r['source_name'],'kind':'reference'}
            for r in db.items(0,time.time()+1,limit=200)]
    social=SocialStore(db)
    for platform in ('youtube','instagram'):
        snapshot=social.latest(platform,28)
        if snapshot:
            result.extend({'source':platform,'external_id':r['id'],'title':r['title'],'label':snapshot['account_name'],'kind':'own'} for r in snapshot['content'])
    return result


@app.post('/content/import')
def import_content(body:LibraryImport,db=Depends(store)):
    library=Library(db)
    return library.import_video(body.external_id) if body.source=='collected' else library.import_social(body.source,body.external_id)


@app.post('/content',status_code=201)
def create_content(body:ContentInput,db=Depends(store)):
    return Library(db).create(body.model_dump())


@app.get('/content/{content_id}')
def get_content(content_id:str,db=Depends(store)):return Library(db).get(content_id)


@app.put('/content/{content_id}')
def update_content(content_id:str,body:ContentUpdate,db=Depends(store)):return Library(db).update(content_id,body.model_dump())


@app.post('/content/{content_id}/archive')
def archive_content(content_id:str,body:LibraryArchive,db=Depends(store)):
    return Library(db).archive(content_id,body.archived,body.version)


@app.post('/content/{content_id}/assets',status_code=201)
async def upload_content_asset(content_id:str,request:Request,filename:str=Query(min_length=1,max_length=200),
                               role:Literal['footage','thumbnail','script','captions','audio','other']='other',db=Depends(store)):
    library=Library(db);library.get(content_id)
    filename=re.split(r'[/\\]',filename)[-1]
    if not filename or any(ord(c)<32 for c in filename):raise LibraryError('Choose a valid filename')
    media_type=MEDIA.get(Path(filename).suffix.lower())
    if not media_type:raise LibraryError('File format not supported. Use a listed video, image, audio, document or subtitle format.')
    length=request.headers.get('content-length','')
    if length.isdigit() and int(length)>MAX_ASSET_BYTES:raise LibraryError('Each file must be 250 MB or smaller',413)
    library.asset_dir.mkdir(parents=True,exist_ok=True)
    asset_id=uuid.uuid4().hex;path=library.asset_path(asset_id);size=0
    try:
        with path.open('xb') as output:
            async for chunk in request.stream():
                size+=len(chunk)
                if size>MAX_ASSET_BYTES:raise LibraryError('Each file must be 250 MB or smaller',413)
                output.write(chunk)
        if not size:raise LibraryError('The file is empty')
        return library.add_asset(content_id,asset_id,filename,media_type,size,role)
    except BaseException:
        path.unlink(missing_ok=True)
        raise


@app.get('/content/{content_id}/assets/{asset_id}')
def download_content_asset(content_id:str,asset_id:str,download:bool=False,db=Depends(store)):
    library=Library(db);asset=library.asset(content_id,asset_id);path=library.asset_path(asset_id)
    if not path.is_file():raise LibraryError('Asset file is missing from local storage',404)
    inline=not download and asset['media_type'].startswith(('image/','video/','audio/'))
    return FileResponse(path,media_type=asset['media_type'],filename=asset['filename'],content_disposition_type='inline' if inline else 'attachment')


@app.delete('/content/{content_id}/assets/{asset_id}')
def delete_content_asset(content_id:str,asset_id:str,db=Depends(store)):
    return Library(db).delete_asset(content_id,asset_id)


class SourceInput(BaseModel):
    channel_id: str = Field(pattern=CHANNEL_PATTERN)
    name: str = Field(min_length=1, max_length=200)


class ReportInput(BaseModel):
    topic: str = Field(min_length=1, max_length=6000)
    days: int = Field(default=7, ge=1, le=90)


class MissionInput(ReportInput):
    agent_id: str = Field(default="youtube-research",min_length=1,max_length=100)
    input_report_id:str | None=Field(default=None,max_length=100)


class ScheduleInput(BaseModel):
    kind: Literal["collect", "report"]
    interval_seconds: int = Field(ge=3600, le=31 * 86400)
    report: ReportInput | None = None


@app.get("/health", dependencies=[Depends(authorize)])
def health(db=Depends(store)):
    return {"status": "ok", "model_configured": bool(selected_connection(db, workspace_config(db))["model"])}


@app.post("/sources", status_code=201, dependencies=[Depends(authorize)])
def add_source(body: SourceInput, db=Depends(store)):
    return db.add_source(body.channel_id, body.name)


@app.get("/sources", dependencies=[Depends(authorize)])
def sources(db=Depends(store)):
    return db.sources()


@app.post("/jobs/collect", status_code=202, dependencies=[Depends(authorize)])
def collect(db=Depends(store)):
    return {"job_id": db.enqueue("collect", {})}


@app.post("/jobs/report", status_code=202, dependencies=[Depends(authorize)])
def report(body: ReportInput, db=Depends(store)):
    return {"job_id": db.enqueue("report", body.model_dump())}


@app.get("/jobs/{job_id}", dependencies=[Depends(authorize)])
def job(job_id: str, db=Depends(store)):
    result = db.job(job_id)
    if not result:
        raise HTTPException(404, "Job not found")
    return result


@app.get("/jobs/{job_id}/events", dependencies=[Depends(authorize)])
def job_events(job_id: str, db=Depends(store)):
    if not db.job(job_id):
        raise HTTPException(404,"Job not found")
    return db.job_events(job_id)


@app.get("/reports", dependencies=[Depends(authorize)])
def reports(db=Depends(store)):
    return db.reports()


@app.get("/reports/{report_id}", dependencies=[Depends(authorize)])
def read_report(report_id: str, db=Depends(store)):
    result = db.reports(report_id)
    if not result:
        raise HTTPException(404, "Report not found")
    return result


@app.post("/schedules", status_code=201, dependencies=[Depends(authorize)])
def schedule(body: ScheduleInput, db=Depends(store)):
    if body.kind == "report" and body.report is None:
        raise HTTPException(422, "Report schedules require report settings")
    return {"schedule_id": db.add_schedule(body.kind, body.report.model_dump() if body.report else {},
                                           body.interval_seconds)}


@app.get("/schedules", dependencies=[Depends(authorize)])
def schedules(db=Depends(store)):
    return db.schedules()


@app.delete("/schedules/{schedule_id}", status_code=204, dependencies=[Depends(authorize)])
def delete_schedule(schedule_id: str, db=Depends(store)):
    if not db.delete_schedule(schedule_id):
        raise HTTPException(404, "Schedule not found")


@app.get("/dashboard", dependencies=[Depends(authorize)])
def dashboard(db=Depends(store)):
    connection = selected_connection(db, workspace_config(db))
    return {**db.dashboard(), **connection, "knowledge_count": db.knowledge_count(), "server_time": time.time()}


@app.get("/videos", dependencies=[Depends(authorize)])
def videos(db=Depends(store)):
    if getattr(db,'mock_profile',None):return [{**r,'source_name':r['creator'],'description':r.get('description','')} for r in mock_media(db)[:100]]
    return db.items(0, time.time(), limit=100)


@app.get("/models", dependencies=[Depends(authorize)])
async def models():
    try:
        async with httpx.AsyncClient(timeout=3) as client:
            response = await client.get(settings.ollama_url.rstrip("/") + "/api/tags")
            response.raise_for_status()
            return {"online": True, "models": [m["name"] for m in response.json().get("models", [])]}
    except (httpx.HTTPError, ValueError, KeyError):
        return {"online": False, "models": []}


class ModelInput(BaseModel):
    model: str = Field(min_length=1, max_length=200)


@app.put("/settings/model", dependencies=[Depends(authorize)])
async def select_model(body: ModelInput, db=Depends(store)):
    installed = await models()
    if body.model not in installed["models"]:
        raise HTTPException(422, "Choose an installed Ollama model")
    db.set_runtime("model", body.model)
    db.set_runtime("connection", {"provider": "ollama", "model": body.model})
    return {"model": body.model}


@app.get("/settings/provider", dependencies=[Depends(authorize)])
def provider_settings(db=Depends(store)):
    connection = selected_connection(db, workspace_config(db))
    try:
        has_key = bool(load_key(workspace_config(db), connection["provider"]))
    except (ValueError, OSError):
        has_key = False
    return {**connection, "has_key": has_key}


class ProviderInput(BaseModel):
    provider: Literal["openai", "deepseek", "ollama"]
    model: str = Field(min_length=1, max_length=200, pattern=r"^[A-Za-z0-9_.:/-]+$")
    api_key: str | None = Field(default=None, min_length=1, max_length=500)


@app.put("/settings/provider", dependencies=[Depends(authorize)])
async def configure_provider(body: ProviderInput, db=Depends(store)):
    try:
        if getattr(db,'mock_profile',None):
            if body.api_key:raise HTTPException(403,'Manage API keys in your personal workspace. You can choose a model here using an existing saved key.')
            if body.provider!='ollama' and not load_key(workspace_config(db),body.provider):raise HTTPException(422,'No saved key for this provider. Add it in your personal workspace, then choose its model here.')
            db.set_runtime('model_override',{'provider':body.provider,'model':body.model})
            return provider_settings(db)
        if body.provider != "ollama":
            if body.api_key:
                if "\n" in body.api_key or "\r" in body.api_key:
                    raise ValueError("Invalid API key")
                save_key(workspace_config(db), body.provider, body.api_key.strip())
            if not load_key(workspace_config(db), body.provider):
                raise ValueError("Enter an API key or configure the provider environment variable")
        db.set_runtime("connection", {"provider": body.provider, "model": body.model})
        return provider_settings(db)
    except (ValueError, OSError) as error:
        raise HTTPException(422, str(error)) from None


@app.post("/settings/provider/test", dependencies=[Depends(authorize)])
async def test_provider(db=Depends(store)):
    connection = selected_connection(db, workspace_config(db))
    if connection["provider"] == "ollama":
        result = await models()
        return {"ok": result["online"] and connection["model"] in result["models"],
                "message": "Checks the installed model list; tool calling is checked when you run a request."}
    key = load_key(workspace_config(db), connection["provider"])
    if not key:
        return {"ok": False, "message": "No API key configured."}
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.get(ENDPOINTS[connection["provider"]] + "/models",
                                        headers={"Authorization": "Bearer " + key})
        if response.is_success:
            ids = {m["id"] for m in response.json().get("data", [])}
            return {"ok": True, "message": "API credentials accepted. " +
                    ("Selected model is listed. " if connection["model"] in ids else "Selected model was not in the returned list. ") +
                    "This checks access only; it does not run inference."}
        return {"ok": False, "message": f"Provider returned HTTP {response.status_code}. Check credentials and API access."}
    except (httpx.HTTPError, ValueError, KeyError):
        return {"ok": False, "message": "Could not reach the provider. Check connectivity and try again."}


class KnowledgeInput(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    content: str = Field(min_length=1, max_length=12000)


@app.post("/knowledge", status_code=201, dependencies=[Depends(authorize)])
def add_knowledge(body: KnowledgeInput, db=Depends(store)):
    if not body.title.strip() or not body.content.strip():
        raise HTTPException(422, "Knowledge title and content must not be blank")
    return {"id": db.add_knowledge(body.title.strip(), body.content.strip())}


@app.get("/knowledge", dependencies=[Depends(authorize)])
def knowledge(query: str = "", db=Depends(store)):
    if len(query) > 200:
        raise HTTPException(422, "Search query must be at most 200 characters")
    return db.knowledge(query, limit=100)


@app.post("/missions", status_code=202, dependencies=[Depends(authorize)])
def create_mission(body: MissionInput, db=Depends(store)):
    if not body.topic.strip():
        raise HTTPException(422, "Enter a mission instruction")
    from spur.missions import is_clear_watchlist
    if not selected_connection(db, workspace_config(db))["model"] and not is_clear_watchlist(body.topic):
        raise HTTPException(422, "Connect a model first")
    if not db.agent(body.agent_id):
        raise HTTPException(404,"Agent not found")
    source_report=db.reports(body.input_report_id) if body.input_report_id else None
    if body.input_report_id and not source_report:
        raise HTTPException(404,'Source output not found')
    return {"mission_id": db.create_mission(body.topic.strip(), body.days,body.agent_id,
        input_report=source_report)}


@app.get("/missions", dependencies=[Depends(authorize)])
def missions(db=Depends(store)):
    return db.missions()


@app.get("/missions/{mission_id}", dependencies=[Depends(authorize)])
def mission(mission_id: str, db=Depends(store)):
    result = db.mission(mission_id)
    if not result:
        raise HTTPException(404, "Mission not found")
    return result


class MissionControl(BaseModel):
    action: Literal["pause", "resume", "cancel"]


@app.post("/missions/{mission_id}/control", dependencies=[Depends(authorize)])
def control_mission(mission_id: str, body: MissionControl, db=Depends(store)):
    try:
        db.control_mission(mission_id, body.action)
    except ValueError as error:
        raise HTTPException(409, str(error)) from None
    return db.mission(mission_id)


@app.post("/watchlist/restore/{action_id}", dependencies=[Depends(authorize)])
def restore_watchlist(action_id: str, db=Depends(store)):
    try:
        return {"restored": db.restore_watchlist(action_id)}
    except ValueError as error:
        raise HTTPException(404,str(error)) from None


class AgentInput(BaseModel):
    name: str = Field(min_length=1,max_length=100)
    description: str = Field(min_length=1,max_length=500)
    instructions: str = Field(min_length=1,max_length=6000)


@app.get("/agents",dependencies=[Depends(authorize)])
def agents(db=Depends(store)):
    return db.agents()


@app.post("/agents",status_code=201,dependencies=[Depends(authorize)])
def create_agent(body:AgentInput,db=Depends(store)):
    if any(not value.strip() for value in (body.name,body.description,body.instructions)):
        raise HTTPException(422,"Agent fields cannot be blank")
    return db.add_agent(body.name.strip(),body.description.strip(),body.instructions.strip())


class CreatorBrief(BaseModel):
    channel_name:str=Field(default='',max_length=200)
    niche:str=Field(default='',max_length=1000)
    audience:str=Field(default='',max_length=1000)
    voice:str=Field(default='',max_length=1000)
    platforms:str=Field(default='',max_length=300)
    production_constraints:str=Field(default='',max_length=1500)
    available_assets:str=Field(default='',max_length=1500)


@app.get('/creator-brief',dependencies=[Depends(authorize)])
def creator_brief(db=Depends(store)):
    return db.get_runtime('creator_brief',{})


@app.put('/creator-brief',dependencies=[Depends(authorize)])
def save_creator_brief(body:CreatorBrief,db=Depends(store)):
    db.set_runtime('creator_brief',body.model_dump())
    return body.model_dump()


class ChatInput(BaseModel):
    content:str=Field(min_length=1,max_length=10000)
    request_id:str=Field(min_length=8,max_length=100)


@app.get('/agents/{agent_id}/chat',dependencies=[Depends(authorize)])
def chat_history(agent_id:str,before:int|None=Query(default=None,ge=1),db=Depends(store)):
    if not db.agent(agent_id):raise HTTPException(404,'Agent not found')
    return db.chat(agent_id,before_id=before)


@app.post('/agents/{agent_id}/chat',status_code=202,dependencies=[Depends(authorize)])
def send_chat(agent_id:str,body:ChatInput,db=Depends(store)):
    if not db.agent(agent_id):raise HTTPException(404,'Agent not found')
    if not body.content.strip():raise HTTPException(422,'Enter a message')
    if not selected_connection(db,workspace_config(db))['model']:raise HTTPException(422,'Connect a model in Settings first')
    try:return {'job_id':db.enqueue_chat(agent_id,body.content.strip(),body.request_id)}
    except ValueError as error:raise HTTPException(409,str(error)) from None


@app.post('/agents/{agent_id}/chat/{job_id}/retry',status_code=202,dependencies=[Depends(authorize)])
def retry_chat(agent_id:str,job_id:str,db=Depends(store)):
    try:db.retry_chat(agent_id,job_id)
    except ValueError as error:raise HTTPException(409,str(error)) from None
    return {'job_id':job_id}


SocialPlatform=Literal['youtube','instagram','tiktok','linkedin']
OfficeProvider=Literal['google','microsoft']
OfficeResource=Literal['mail','drafts','events','documents']


@app.get('/admin/integrations')
def platform_integrations(request:Request):
    require_platform_owner(request)
    root=request.app.state.store
    return {'office':[public_registration(OfficeStore(root).public(provider),request,'/office/'+provider+'/callback') for provider in ('google','microsoft')],
            'social':[public_registration(SocialStore(root).public(provider),request,'/social/'+provider+'/callback') for provider in ('youtube','instagram','tiktok','linkedin')]}


@app.get('/office/connections')
def office_connections(request:Request,db=Depends(store)):
    return {'connections':[public_registration(OfficeStore(db).public(provider),request,'/office/'+provider+'/callback')
                           for provider in ('google','microsoft')], 'notice':db.get_runtime('office_notice',None)}


@app.put('/office/{provider}/app')
def office_app(provider:OfficeProvider,body:OfficeAppInput,request:Request,db=Depends(store)):
    require_platform_owner(request,mutation=True)
    OfficeStore(request.app.state.store).save_app(provider,body,str(request.base_url).rstrip('/')+'/office/'+provider+'/callback')
    return public_registration(OfficeStore(db).public(provider),request,'/office/'+provider+'/callback')


@app.post('/office/{provider}/connect')
def office_connect(provider:OfficeProvider,request:Request,db=Depends(store)):
    session=require_account(request,mutation=True)
    result=begin_office_oauth(request.app.state.store,db,session['user']['id'],request.cookies.get(COOKIE),provider)
    response=JSONResponse({'authorization_url':result['url']})
    response.set_cookie('spur_office_oauth_'+provider,result['ticket'],httponly=True,samesite='lax',secure=request.url.scheme=='https',max_age=600,path='/office/'+provider+'/callback')
    return response


@app.get('/office/{provider}/callback',include_in_schema=False)
async def office_callback(provider:OfficeProvider,request:Request,code:str='',state:str='',error:str=''):
    success=False;message='Account connected. Returning to your workspace…'
    try:
        ticket=consume_oauth(request.app.state.store,'office:'+provider,request.cookies.get('spur_office_oauth_'+provider),state)
        path=Accounts(request.app.state.store).workspace_path(ticket['user_id'])
        with request.app.state.workspace_lock:
            if path not in request.app.state.workspaces:request.app.state.workspaces[path]=Store(path)
            workspace=request.app.state.workspaces[path]
            workspace.platform_store=request.app.state.store
        try:
            if error:raise OfficeError('Authorization was cancelled or denied. You can connect again.')
            if not code or len(code)>4096:raise OfficeError('The provider did not return an authorization code.')
            async with httpx.AsyncClient() as client:await exchange_office_code(workspace,provider,code,ticket['payload'],client)
            success=True
            workspace.set_runtime('office_notice',{'message':provider.title()+' connected. Open its workspace to read or edit your content.'})
        except (OfficeError,SocialError) as exc:
            message=str(exc);workspace.set_runtime('office_notice',{'message':message})
    except (OfficeError,SocialError) as exc:message=str(exc)
    import html
    response=HTMLResponse('<!doctype html><html><head><meta charset="utf-8"><title>Account connection — Spur Ring</title></head><body><h1>'+
        ('Account connected' if success else 'Connection needs attention')+'</h1><p>'+html.escape(message)+
        '</p><a href="/#connections">Return to Connections</a>'+('<script src="/static/social-return.js"></script>' if success else '')+'</body></html>',status_code=200 if success else 400)
    response.delete_cookie('spur_office_oauth_'+provider,path='/office/'+provider+'/callback')
    request.scope['query_string']=b''
    return response


@app.delete('/office/{provider}')
def office_disconnect(provider:OfficeProvider,request:Request,db=Depends(store)):
    OfficeStore(db).disconnect(provider)
    session=account_session(request)
    if session:
        with request.app.state.store.connect() as root:root.execute('DELETE FROM social_oauth_tickets WHERE user_id=? AND platform=?',(session['user']['id'],'office:'+provider))
    return {'disconnected':True,'message':'Local tokens removed. Saved items on the provider remain. You can revoke app access in your provider account settings.'}


@app.get('/office/{provider}/items/{resource}')
async def office_list(provider:OfficeProvider,resource:OfficeResource,query:str=Query(default='',max_length=300),start:str='',end:str='',db=Depends(store)):
    async with httpx.AsyncClient() as client:
        return {'items':await OfficeSession(db,provider,client).listing(resource,query,start,end)}


@app.get('/office/{provider}/items/{resource}/{object_id:path}')
async def office_detail(provider:OfficeProvider,resource:OfficeResource,object_id:str,db=Depends(store)):
    async with httpx.AsyncClient() as client:
        result=await OfficeSession(db,provider,client).detail(resource,object_id)
        return {key:value for key,value in result.items() if not key.startswith('_')}


@app.post('/office/{provider}/actions')
async def office_write(provider:OfficeProvider,body:OfficeWrite,db=Depends(store)):
    async with httpx.AsyncClient() as client:return await OfficeSession(db,provider,client).write(body)


class SocialAppInput(BaseModel):
    client_id:str=Field(min_length=1,max_length=300,pattern=r'^[A-Za-z0-9_.-]+$')
    client_secret:str=Field(default='',max_length=1000)
    api_version:str=Field(default='v24.0',pattern=r'^(v[0-9]{1,2}\.0|20[0-9]{4})$')
    login_mode:Literal['web','desktop']|None=None
    publishing_audit_approved:bool|None=None
    audit_reference:str=Field(default='',max_length=200)


class SocialSyncInput(BaseModel):
    days:int=Field(default=28,ge=7,le=28)


class SocialAccountInput(BaseModel):
    account_id:str=Field(min_length=1,max_length=200)


class InstagramDeveloperTokenInput(BaseModel):
    access_token:str=Field(min_length=20,max_length=4096,repr=False)


@app.post('/social/instagram/developer-token')
async def instagram_developer_token(body:InstagramDeveloperTokenInput,request:Request,db=Depends(store)):
    require_account(request,mutation=True)
    from spur.instagram_auth import connect_developer_token
    async with httpx.AsyncClient() as client:
        result=await connect_developer_token(db,body.access_token,client)
    return result


@app.get('/social/connections')
def social_connections(request:Request,db=Depends(store)):
    if getattr(db,'mock_profile',None):
        info=db.mock_profile
        return {'connections':[{'platform':info['platform'],'configured':False,'connect_ready':False,'can_manage':False,'status':'mock','mock_profile':True,'synthetic':info['mode']=='synthetic','account_name':info['name'],'account_id':'','accounts':[],'expires':None,'last_sync':None,'pending_job':None,'error':channel.get('error',''),'import_method':channel.get('import_method'),'setup_issue':'Reference/mock data only. Account connections and external writes are disabled in this workspace.'} for channel in mock_context(db)['channels'] for info in [channel]],'notice':None}
    repo=SocialStore(db)
    return {'connections':[public_registration(repo.public(platform),request,'/social/'+platform+'/callback')
                           for platform in ('youtube','instagram','tiktok','linkedin')],'notice':db.get_runtime('social_notice',None)}


@app.put('/social/{platform}/app')
def social_app(platform:SocialPlatform,body:SocialAppInput,request:Request,db=Depends(store)):
    require_platform_owner(request,mutation=True)
    if '\n' in body.client_secret or '\r' in body.client_secret:raise HTTPException(422,'Invalid app secret')
    if platform=='tiktok' and body.publishing_audit_approved and not body.audit_reference.strip():raise SocialError('Enter the reference for an existing TikTok Direct Post audit approval. This setting does not obtain approval from TikTok.')
    root=request.app.state.store
    SocialStore(root).save_app(platform,body.client_id,body.client_secret.strip(),str(request.base_url).rstrip('/')+'/social/'+platform+'/callback',body.api_version)
    if platform=='tiktok':
        if body.login_mode is not None:root.set_runtime('tiktok_login',{'mode':body.login_mode,'client_id':body.client_id})
        if body.publishing_audit_approved is not None:root.set_runtime('tiktok_publishing',{'approved':body.publishing_audit_approved,'reference':body.audit_reference.strip(),'client_id':body.client_id})
    db.set_runtime('social_notice',{'kind':'info','message':'App setup saved. Choose Connect to authorize your '+platform.title()+' account.'})
    return SocialStore(db).public(platform)


@app.post('/social/{platform}/connect')
def social_connect(platform:SocialPlatform,request:Request,publishing:bool=False,db=Depends(store)):
    session=require_account(request,mutation=True)
    if platform in ('tiktok','linkedin'):
        registration=SocialStore(db).app(platform)
        if registration and registration['redirect_uri']!=str(request.base_url).rstrip('/')+'/social/'+platform+'/callback':
            raise SocialError('Open Spur Ring at the address registered for this provider callback, or save the current callback in Provider app setup first.')
    result=begin_oauth(request.app.state.store,db,session['user']['id'],request.cookies.get(COOKIE),platform,publishing=publishing and platform in ('instagram','tiktok'))
    response=JSONResponse({'authorization_url':result['url']})
    response.set_cookie('spur_oauth_'+platform,result['ticket'],httponly=True,samesite='lax',secure=request.url.scheme=='https',
                        max_age=600,path='/social/'+platform+'/callback')
    return response


@app.get('/social/{platform}/callback',include_in_schema=False)
async def social_callback(platform:SocialPlatform,request:Request,code:str='',state:str='',error:str=''):
    # Cross-site OAuth returns do not carry the Strict login cookie. A one-use
    # Lax ticket binds this callback to the original still-valid login session.
    message='Connection completed. Returning to your workspace…';success=False
    try:
        try:
            ticket=consume_oauth(request.app.state.store,platform,request.cookies.get('spur_oauth_'+platform),state)
        except SocialError:
            # A top-level same-origin document restores the Strict login cookie.
            # Completion then requires that exact initiating session plus CSRF.
            nonce=stage_oauth_return(request.app.state.store,platform,state,code,error)
            import html
            response=HTMLResponse('<!doctype html><html><head><meta charset="utf-8"><title>Finishing connection — Spur Ring</title></head>'
                '<body><h1 id="connection-title">Finishing your connection</h1><p id="connection-message">Verifying your signed-in workspace…</p>'
                '<a href="/#connections">Return to Connections &amp; Analytics</a>'
                '<script src="/static/social-complete.js" data-platform="'+html.escape(platform)+'" data-continuation="'+html.escape(nonce)+'"></script></body></html>')
            request.scope['query_string']=b''
            return response
        path=Accounts(request.app.state.store).workspace_path(ticket['user_id'])
        with request.app.state.workspace_lock:
            if path not in request.app.state.workspaces:request.app.state.workspaces[path]=Store(path)
            workspace=request.app.state.workspaces[path]
            workspace.platform_store=request.app.state.store
        try:
            if error:raise SocialError('Authorization was cancelled or denied. You can try Connect again.')
            if not code or len(code)>4096:raise SocialError('The provider did not return an authorization code.')
            async with httpx.AsyncClient() as client:await exchange_code(workspace,platform,code,ticket['payload'],client)
            workspace.set_runtime('social_notice',{'kind':'success','message':platform.title()+' connected. Select an account if prompted, then sync analytics.'})
            success=True
        except SocialError as exc:
            message=str(exc);workspace.set_runtime('social_notice',{'kind':'error','message':message})
    except SocialError as exc:message=str(exc)
    import html
    # Commit a same-origin page before navigating again so the Strict login
    # cookie is available, rather than relying on a cross-site redirect chain.
    response=HTMLResponse('<!doctype html><html><head><meta charset="utf-8"><title>Account connection — Spur Ring</title></head><body><h1>'+
        ('Account connected' if success else 'Connection needs attention')+'</h1><p>'+html.escape(message)+
        '</p><a href="/#connections">Return to Connections &amp; Analytics</a>'+
        ('<script src="/static/social-return.js"></script>' if success else '')+'</body></html>',status_code=200 if success else 400)
    response.delete_cookie('spur_oauth_'+platform,path='/social/'+platform+'/callback')
    # Avoid persisting one-time authorization codes in access-log URLs.
    request.scope['query_string']=b''
    return response


class SocialReturnInput(BaseModel):
    continuation:str=Field(min_length=20,max_length=200,pattern=r'^[A-Za-z0-9_-]+$')


@app.post('/social/{platform}/complete',include_in_schema=False)
async def social_complete(platform:SocialPlatform,body:SocialReturnInput,request:Request):
    session=require_account(request,mutation=True)
    root=request.app.state.store
    ticket=consume_oauth_return(root,platform,body.continuation,session['user']['id'],request.cookies.get(COOKIE))
    path=Accounts(root).workspace_path(session['user']['id'])
    with request.app.state.workspace_lock:
        if path not in request.app.state.workspaces:request.app.state.workspaces[path]=Store(path)
        workspace=request.app.state.workspaces[path];workspace.platform_store=root
    success=False
    try:
        if ticket['error']:raise SocialError('Authorization was cancelled or denied. You can try Connect again.')
        if not ticket['code']:raise SocialError('The provider did not return an authorization code.')
        async with httpx.AsyncClient() as client:
            await exchange_code(workspace,platform,ticket['code'],ticket['payload'],client)
        success=True;message=platform.title()+' connected. Select an account if prompted, then sync analytics.'
    except SocialError as exc:message=str(exc)
    workspace.set_runtime('social_notice',{'kind':'success' if success else 'error','message':message})
    return {'success':success,'message':message}


@app.post('/social/{platform}/account')
def social_select_account(platform:SocialPlatform,body:SocialAccountInput,request:Request,db=Depends(store)):
    SocialStore(db).select_account(platform,body.account_id)
    db.set_runtime('social_notice',{'kind':'info','message':'Account selected. Click Sync analytics to fetch its data.'})
    return public_registration(SocialStore(db).public(platform),request,'/social/'+platform+'/callback')


@app.post('/social/{platform}/sync',status_code=202)
def social_sync(platform:SocialPlatform,body:SocialSyncInput,db=Depends(store)):
    return {'job_id':SocialStore(db).enqueue_sync(platform,body.days)}


@app.get('/social/{platform}/analytics')
def social_analytics(platform:SocialPlatform,days:int=Query(default=28,ge=7,le=28),db=Depends(store)):
    return {'snapshot':SocialStore(db).latest(platform,days)}


@app.post('/social/{platform}/brief')
def social_brief(platform:SocialPlatform,body:SocialSyncInput,db=Depends(store)):
    snapshot=SocialStore(db).latest(platform,body.days);brief=analytics_brief(snapshot)
    title=platform.title()+' analytics: '+snapshot['period']['start']+' to '+snapshot['period']['end']
    note=db.add_knowledge(title,json.dumps(brief,ensure_ascii=False))
    return {'knowledge_id':note,'brief':brief}


@app.delete('/social/{platform}')
def social_disconnect(platform:SocialPlatform,request:Request,purge:bool=False,db=Depends(store)):
    SocialStore(db).disconnect(platform,purge)
    db.set_runtime('social_notice',{'kind':'info','message':platform.title()+' disconnected.'+(' Analytics snapshots deleted; saved briefs and chats remain.' if purge else ' Saved snapshots remain available.')})
    session=account_session(request)
    if session:
        with request.app.state.store.connect() as root:
            root.execute('DELETE FROM social_oauth_tickets WHERE user_id=? AND platform=?',(session['user']['id'],platform))
    return {'disconnected':True,'analytics_deleted':purge}

@app.get('/publishing/tiktok')
async def tiktok_publishing(db=Depends(store)):
    from spur.tiktok_publishing import Posts
    posts=Posts(db);ready=posts.readiness();creator=None;error=''
    if ready['connected'] and ready['direct_enabled']:
        try:
            async with httpx.AsyncClient() as client:_,_,creator=await posts.creator(client)
        except SocialError as problem:error=str(problem)
    return {'items':posts.list(),'connection':ready,'creator':creator,'creator_error':error}


@app.post('/publishing/tiktok',status_code=201)
def create_tiktok_post(body:dict,db=Depends(store)):
    from spur.tiktok_publishing import Posts,DraftInput
    from pydantic import ValidationError
    try:value=DraftInput.model_validate(body)
    except ValidationError:raise SocialError('Choose your own MP4, a valid posting method and a caption up to 2,200 characters.') from None
    return Posts(db).create(value)


@app.put('/publishing/tiktok/{post_id}')
def update_tiktok_post(post_id:str,body:dict,db=Depends(store)):
    from spur.tiktok_publishing import Posts,DraftUpdate
    from pydantic import ValidationError
    try:value=DraftUpdate.model_validate(body)
    except ValidationError:raise SocialError('Choose a valid MP4, caption and draft version.') from None
    return Posts(db).update(post_id,value)


@app.post('/publishing/tiktok/{post_id}/review')
async def review_tiktok_post(post_id:str,db=Depends(store)):
    from spur.tiktok_publishing import Posts
    async with httpx.AsyncClient() as client:return await Posts(db).review(post_id,client)


@app.post('/publishing/tiktok/{post_id}/dispatch')
def dispatch_tiktok_post(post_id:str,body:dict,db=Depends(store)):
    from spur.tiktok_publishing import Posts,PublishInput
    from pydantic import ValidationError
    try:value=PublishInput.model_validate(body)
    except ValidationError:raise SocialError('Review the current account, video and posting settings again.') from None
    return Posts(db).dispatch(post_id,value)


@app.post('/publishing/tiktok/{post_id}/cancel')
def cancel_tiktok_post(post_id:str,db=Depends(store)):
    from spur.tiktok_publishing import Posts
    return Posts(db).cancel(post_id)


@app.post('/publishing/tiktok/{post_id}/status')
def check_tiktok_post(post_id:str,db=Depends(store)):
    from spur.tiktok_publishing import Posts
    return Posts(db).check_status(post_id)


# Official Instagram publishing. These routes always operate on the active,
# user-owned workspace; reference/mock profiles are rejected by Posts.
@app.get('/publishing/facebook/{source_id}/review')
async def review_facebook_video(source_id:str, db=Depends(store)):
    from spur.facebook_publishing import destination
    async with httpx.AsyncClient() as client:
        page, _, _, _ = await destination(db, client, source_id)
    return page


class FacebookVideoDispatch(BaseModel):
    page_id:str=Field(pattern=r'^[0-9]{1,32}$')
    confirmed:bool


@app.post('/publishing/facebook/{source_id}/dispatch')
async def dispatch_facebook_video(source_id:str, body:FacebookVideoDispatch, db=Depends(store)):
    from spur.facebook_publishing import enqueue
    if not body.confirmed:
        raise SocialError('Confirm the Facebook Page before publishing.')
    async with httpx.AsyncClient() as client:
        return await enqueue(db, client, source_id, body.page_id, )
    

@app.get('/publishing/instagram')
def instagram_publishing(mode:Literal['demo','instagram']='instagram',db=Depends(store)):
    from spur.publishing import Posts
    posts=Posts(db,demo=mode=='demo')
    from spur.facebook_publishing import deliveries
    return {'items':posts.list(),'connection':posts.readiness(), 'facebook':deliveries(db) if mode=='instagram' else []}


@app.post('/publishing/instagram',status_code=201)
def create_instagram_post(body:dict,mode:Literal['demo','instagram']='instagram',db=Depends(store)):
    from spur.publishing import Posts,PostInput
    from pydantic import ValidationError
    try:value=PostInput.model_validate(body)
    except ValidationError:raise SocialError('Choose image or Reel, a caption up to 2,200 characters, and one valid hosted URL or uploaded asset.') from None
    return Posts(db,demo=mode=='demo').create(value)


@app.post('/publishing/instagram/{post_id}/dispatch')
def dispatch_instagram_post(post_id:str,body:dict,request:Request,mode:Literal['demo','instagram']='instagram',db=Depends(store)):
    from spur.publishing import Posts,DispatchInput
    from pydantic import ValidationError
    try:value=DispatchInput.model_validate(body)
    except ValidationError:raise SocialError('Refresh the draft and choose a valid publication time.') from None
    return Posts(db,demo=mode=='demo').dispatch(post_id,value,str(request.base_url).rstrip('/'))


@app.put('/publishing/instagram/{post_id}')
def edit_instagram_draft(post_id:str,body:dict,mode:Literal['demo','instagram']='instagram',db=Depends(store)):
    from spur.publishing import Posts,PostUpdate
    from pydantic import ValidationError
    try:value=PostUpdate.model_validate(body)
    except ValidationError:raise SocialError('Choose a valid caption, media source and draft version.') from None
    return Posts(db,demo=mode=='demo').update(post_id,value)


@app.post('/publishing/instagram/{post_id}/reschedule')
def reschedule_instagram_post(post_id:str,body:dict,mode:Literal['demo','instagram']='instagram',db=Depends(store)):
    from spur.publishing import Posts,DispatchInput
    from pydantic import ValidationError
    try:value=DispatchInput.model_validate(body)
    except ValidationError:raise SocialError('Choose a valid publication time and review the account.') from None
    return Posts(db,demo=mode=='demo').reschedule(post_id,value)


@app.post('/publishing/instagram/{post_id}/cancel')
def cancel_instagram_post(post_id:str,mode:Literal['demo','instagram']='instagram',db=Depends(store)):
    from spur.publishing import Posts
    return Posts(db,demo=mode=='demo').cancel(post_id)


@app.get('/publishing/media/{ticket}',include_in_schema=False)
def retrieve_publishing_media(ticket:str,request:Request):
    from spur.publishing import GRANTS
    from spur.social import digest
    root=request.app.state.store
    if not re.fullmatch(r'[A-Za-z0-9_-]{43}',ticket):raise HTTPException(404,'Media link not found')
    with root.connect() as db:
        db.executescript(GRANTS)
        row=db.execute('SELECT * FROM publishing_media WHERE token_hash=? AND expires>?',(digest(ticket),time.time())).fetchone()
    if not row:raise HTTPException(404,'Media link expired or unavailable')
    allowed={str(Path(p).resolve()) for p in [root.path,*Accounts(root).workspace_paths()]}
    if str(Path(row['workspace']).resolve()) not in allowed:raise HTTPException(404,'Media unavailable')
    library=Library(Store(row['workspace']));asset=library.asset(row['content_id'],row['asset_id']);path=library.asset_path(row['asset_id'])
    if not path.is_file():raise HTTPException(404,'Media unavailable')
    return FileResponse(path,media_type=asset['media_type'],content_disposition_type='inline')
