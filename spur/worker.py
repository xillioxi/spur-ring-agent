import asyncio
import logging
import uuid
import time
from pathlib import Path
from dataclasses import replace
from xml.etree.ElementTree import ParseError

import httpx
from defusedxml.common import DefusedXmlException

from spur.agent import generate_report
from spur.config import settings
from spur.store import Store
from spur.youtube import collect
from spur.credentials import selected_connection
from spur.auth import Accounts, workspace_settings

log = logging.getLogger(__name__)


async def execute(store, job, client,config=None):
    store.record_event(job,"action","Worker started this step",{"job_type":job["kind"]})
    await execute_step(store,job,client,config)
    store.record_event(job,"result","Step finished")


async def execute_step(store, job, client,config=None):
    config=config or settings
    if job['kind'] == 'facebook_video_publish':
        from spur.facebook_publishing import step
        await step(store, job, client)
        return
    if job['kind']=='tiktok_publish':
        from spur.tiktok_publishing import step
        await step(store,job,client);return
    if job['kind']=='instagram_demo_publish':
        from spur.publishing import demo_step
        demo_step(store,job);return
    if job['kind']=='instagram_publish':
        from spur.publishing import step
        await step(store,job,client);return
    if job['kind']=='profile_metadata':
        from spur.profile_collection import step
        await step(store,job);return
    if job['kind']=='profile_import':
        from spur.mock_profiles import import_step
        await import_step(store,job,client);return
    if job['kind']=='collect' and getattr(store,'mock_profile',None):
        if store.mock_profile['mode']=='public' and store.mock_profile['platform']=='youtube':
            from spur.profile_collection import start
            result=start(store,request_key='collect:'+job['id']);store.finish(job,result);return
        from spur.mock_profiles import Profiles,materialize
        registry=Profiles(store.profile_parent);info=registry.get(store.mock_profile['id']);materialize(store,info);registry.update(info)
        store.finish(job,{'mock_profile':info['id'],'message':'Reused the local reference catalog. Use Refresh on Mock profiles for a new public import.'});return
    if job['kind']=='social_sync':
        from spur.social import sync
        await sync(store,job,client)
    elif job['kind']=='chat':
        from spur.chat import reply
        connection=selected_connection(store,config)
        await reply(store,replace(config,model=connection['model'],provider=connection['provider']),job,client)
    elif job["kind"] == "mission":
        from spur.missions import step
        connection = selected_connection(store, config)
        await step(store, replace(config, model=connection["model"], provider=connection["provider"]), job, client)
    elif job["kind"] == "collect":
        sources = store.sources()
        if not sources:
            raise ValueError("Add at least one YouTube channel first")
        counts, failures = {}, {}
        for source in sources:
            try:
                store.record_event(job,"tool","Collect channel feed",{"channel":source["name"],"channel_id":source["channel_id"]})
                items = await collect(client, source["channel_id"])
                store.save_items(source["id"], items)
                counts[source["id"]] = len(items)
                store.record_event(job,"result","Feed collected",{"channel":source["name"],"videos":len(items)})
            except (httpx.HTTPError, ValueError, ParseError, DefusedXmlException) as exc:
                error = f"{type(exc).__name__}: {exc}"[:1000]
                store.source_error(source["id"], error)
                failures[source["id"]] = error
                store.record_event(job,"error","Channel collection failed",{"channel":source["name"],"error":error})
        if len(failures) == len(sources):
            raise ValueError("All channel collections failed; inspect GET /sources")
        store.finish(job, {"items_seen_per_source": counts, "failed_sources": failures,
                           "partial": bool(failures)})
    elif job["kind"] == "report":
        connection = selected_connection(store, config)
        model_settings = replace(config, model=connection["model"], provider=connection["provider"])
        report = await generate_report(store, model_settings, job["payload"], client,
            progress=lambda kind,title,details=None:store.record_event(job,kind,title,details))
        store.finish(job, {"report_id": uuid.uuid4().hex}, report=report)
    else:
        raise ValueError("Unsupported job kind")


def discover_workspaces(root,cache):
    paths=[str(Path(root.path).resolve()),*Accounts(root).workspace_paths()]
    for path in dict.fromkeys(paths):
        if path not in cache:cache[path]=Store(path)
        cache[path].platform_store=root
    from spur.mock_profiles import Profiles
    for path in dict.fromkeys(paths):
        parent=cache[path]
        for info in Profiles(parent).list():
            key='mock:'+path+':'+info['id']
            if key not in cache:cache[key]=Profiles(parent).workspace(info['id'])
            cache[key].mock_profile=info
    return list(cache.values())


async def run():
    root=Store(settings.db_path);stores={};discover_workspaces(root,stores)
    async def heartbeat():
        while True:
            for workspace in discover_workspaces(root,stores):workspace.set_runtime('worker_heartbeat',time.time())
            await asyncio.sleep(5)
    task=asyncio.create_task(heartbeat())
    try:await work(root,stores)
    finally:
        task.cancel()
        for workspace in stores.values():workspace.set_runtime('worker_heartbeat',0)


async def work(root,stores=None):
    stores=stores if stores is not None else {}
    async with httpx.AsyncClient() as client:
        while True:
            did_work=False
            # One bounded step per workspace per pass prevents a busy account
            # from monopolizing every queued step of the shared local worker.
            for store in discover_workspaces(root,stores):
                if getattr(store,'mock_profile',None) and not store.mock_profile.get('workspace_id'):
                    try:
                        from spur.proactive_insights import maybe_schedule
                        maybe_schedule(store,workspace_settings(settings,store.profile_parent.path))
                    except Exception:
                        log.exception('Automatic insight scheduling failed for %s',store.path)
                store.tick();job=store.claim()
                if not job:continue
                did_work=True
                try:
                    config=workspace_settings(settings,getattr(store,'profile_parent',store).path)
                    await asyncio.wait_for(execute(store,job,client,config),timeout=600)
                except Exception as exc:
                    log.exception('Job %s failed',job['id'])
                    store.record_event(job,'error','Step failed; retry policy applies',{'error_type':type(exc).__name__,'message':str(exc)[:1000]})
                    store.fail(job,f'{type(exc).__name__}: {exc}')
            if not did_work:await asyncio.sleep(2)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass
