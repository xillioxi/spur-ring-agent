import asyncio
import json
import time
from dataclasses import replace

import httpx
import pytest
from fastapi.testclient import TestClient

from spur.agent import Draft, Finding, generate_report, validate_evidence
from spur.config import Settings
from spur.store import Store
from spur.youtube import parse_feed


@pytest.fixture
def db(tmp_path):
    return Store(str(tmp_path / "test.db"))


def test_deduplication_and_window_boundaries(db):
    source = db.add_source("UC" + "a" * 22, "Example")
    item = {"id": "abcdefghijk", "title": "New model", "description": "Launch",
            "url": "https://www.youtube.com/watch?v=abcdefghijk", "published": 100}
    db.save_items(source["id"], [item, item])
    assert len(db.items(100, 101)) == 1
    assert db.items(0, 100) == []
    assert db.items(0, 101, query="%") == []


def test_job_retry_lease_and_stale_worker(db):
    job_id = db.enqueue("collect", {})
    first = db.claim()
    assert db.claim() is None
    with db.connect() as conn:
        conn.execute("UPDATE jobs SET lease_until=0 WHERE id=?", (job_id,))
    second = db.claim()
    with pytest.raises(RuntimeError, match="ownership"):
        db.finish(first, {})
    db.fail(first, "stale error")
    assert db.job(job_id)["status"] == "running"
    db.fail(second, "temporary")
    with db.connect() as conn:
        conn.execute("UPDATE jobs SET available=0 WHERE id=?", (job_id,))
    third = db.claim()
    db.fail(third, "permanent")
    assert db.job(job_id)["status"] == "failed"
    assert db.claim() is None


def test_schedule_only_enqueues_once_and_report_commits_atomically(db):
    db.add_schedule("collect", {}, 3600)
    db.tick()
    db.tick()
    job = db.claim()
    assert job is not None
    assert db.claim() is None
    db.finish(job, {"report_id": "r1"}, report={"summary": "Example"})
    assert db.job(job["id"])["status"] == "succeeded"
    assert db.reports("r1")["content"]["summary"] == "Example"


def test_parse_youtube_and_reject_xml_entities():
    xml = b'''<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:yt="http://www.youtube.com/xml/schemas/2015"
      xmlns:media="http://search.yahoo.com/mrss/">
      <entry><yt:videoId>abcdefghijk</yt:videoId><title>A launch</title>
      <published>2026-10-26T12:00:00Z</published>
      <media:group><media:description>Details</media:description></media:group></entry></feed>'''
    result = parse_feed(xml)
    assert result[0]["description"] == "Details"
    assert result[0]["url"] == "https://www.youtube.com/watch?v=abcdefghijk"
    with pytest.raises(ValueError):
        parse_feed(b"<html/>")
    with pytest.raises(Exception):
        parse_feed(b'<!DOCTYPE feed [<!ENTITY x "secret">]><feed>&x;</feed>')


def test_reject_invented_citations_and_single_channel_trends():
    finding = Finding(title="Trend", observation="Claim", implication="May matter", evidence_ids=["invented"])
    draft = Draft(summary="Test", developments=[finding], potential_trends=[], limitations=["Metadata only"])
    with pytest.raises(ValueError, match="did not retrieve"):
        validate_evidence(draft, {})
    draft.developments = []
    draft.potential_trends = [finding]
    with pytest.raises(ValueError, match="two channels"):
        validate_evidence(draft, {"invented": {"source_id": "same"}})


def test_agent_tool_loop_and_structured_report(db):
    source = db.add_source("UC" + "a" * 22, "Example")
    db.save_items(source["id"], [{"id": "abcdefghijk", "title": "Model launch", "description": "Creator announcement",
        "url": "https://www.youtube.com/watch?v=abcdefghijk", "published": time.time() - 10}])
    requests = []

    def handler(request):
        body = json.loads(request.content)
        requests.append(body)
        if len(requests) == 1:
            message = {"role": "assistant", "content": "", "tool_calls": [{"function": {
                "name": "search_items", "arguments": {"query": "model", "period": "current"}}}]}
        elif len(requests) == 2:
            message = {"role": "assistant", "content": "Ready"}
        else:
            message = {"role": "assistant", "content": json.dumps({"summary": "Creator announces a model.",
                "developments": [{"title": "Launch", "observation": "Creator announcement",
                    "implication": "Worth investigating", "evidence_ids": ["abcdefghijk"]}],
                "potential_trends": [], "limitations": ["Metadata only"]})}
        return httpx.Response(200, json={"message": message})

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await generate_report(db, replace(Settings(), model="test-model"),
                                         {"topic": "Models", "days": 7}, client)

    result = asyncio.run(run())
    assert result["sources"]["abcdefghijk"]["source_name"] == "Example"
    assert result["tool_trace"][0]["returned_ids"] == ["abcdefghijk"]
    assert "format" in requests[-1]


def test_report_continues_when_model_requests_too_many_tools(db):
    source=db.add_source('UC'+'a'*22,'Example')
    db.save_items(source['id'],[{'id':'abcdefghijk','title':'Paris','description':'Travel',
        'url':'https://www.youtube.com/watch?v=abcdefghijk','published':time.time()-1}])
    requests=[]
    def handler(request):
        body=json.loads(request.content);requests.append(body)
        if len(requests)==1:
            message={'role':'assistant','content':'','tool_calls':[{'id':f'call-{i}','function':{
                'name':'search_items','arguments':{'query':'Paris','period':'current'}}} for i in range(5)]}
        elif len(requests)==2:
            results=[m for m in body['messages'] if m['role']=='tool']
            assert len(results)==5
            assert 'budget' in results[-1]['content']
            message={'role':'assistant','content':'Ready'}
        else:
            message={'role':'assistant','content':json.dumps({'summary':'Travel evidence reviewed','developments':[],
                'potential_trends':[],'limitations':['Metadata only']})}
        return httpx.Response(200,json={'message':message})
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
            return await generate_report(db,replace(Settings(),model='test-model'),{'topic':'Paris','days':7},c)
    assert asyncio.run(run())['summary']=='Travel evidence reviewed'


def test_api_auth_validation_and_queue(tmp_path, monkeypatch):
    import spur.api as api
    monkeypatch.setattr(api, "settings", replace(Settings(), db_path=str(tmp_path / "api.db"), api_key="test-key"))
    with TestClient(api.app) as client:
        assert client.get("/sources").status_code == 401
        headers = {"X-API-Key": "test-key"}
        assert client.post("/sources", headers=headers, json={"channel_id": "https://localhost/", "name": "bad"}).status_code == 422
        assert client.post("/sources", headers=headers, json={"channel_id": "UC" + "a" * 22, "name": "Example"}).status_code == 201
        response = client.post("/jobs/report", headers=headers, json={"topic": "AI", "days": 7})
        assert response.status_code == 202
        job_id = response.json()["job_id"]
        assert client.get(f"/jobs/{job_id}", headers=headers).json()["status"] == "queued"
        assert client.post("/schedules", headers=headers, json={"kind": "report", "interval_seconds": 86400}).status_code == 422
        prompt = "Compare the channels and explain the implications.\n" * 100
        response = client.post("/jobs/report", headers=headers, json={"topic": prompt, "days": 14})
        assert response.status_code == 202
        saved = client.get(f"/jobs/{response.json()['job_id']}", headers=headers).json()
        assert saved["payload"] == {"topic": prompt, "days": 14}
        assert client.post("/jobs/report", headers=headers, json={"topic": "x" * 6001, "days": 7}).status_code == 422


def test_collector_partial_failure_is_visible(db):
    from spur.worker import execute
    good = db.add_source("UC" + "a" * 22, "Good")
    bad = db.add_source("UC" + "b" * 22, "Bad")
    job_id = db.enqueue("collect", {})
    job = db.claim()

    def handler(request):
        if request.url.params["channel_id"] == good["channel_id"]:
            return httpx.Response(200, content=b'<feed xmlns="http://www.w3.org/2005/Atom"/>')
        return httpx.Response(503)

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            await execute(db, job, client)

    asyncio.run(run())
    assert db.job(job_id)["result"]["partial"] is True
    assert bad["id"] in db.job(job_id)["result"]["failed_sources"]
    assert next(s for s in db.sources() if s["id"] == bad["id"])["last_error"]


def test_local_dashboard_session_and_private_api(tmp_path, monkeypatch):
    import spur.api as api
    monkeypatch.setattr(api, "settings", replace(Settings(), db_path=str(tmp_path / "ui.db"),
                                                api_key="local-secret", local_ui=True))
    with TestClient(api.app) as client:
        assert client.get("/dashboard").status_code == 401
        page = client.get("/")
        assert page.status_code == 200
        assert "Sign in" in page.text
        assert "local-secret" not in page.text
        assert "set-cookie" not in page.headers
        assert client.get("/static/app.js").status_code == 200
        registration=client.post('/auth/register',headers={'X-Spur-Auth':'1'},json={
            'username':'owner','display_name':'Owner','password':'a-test-password-123'})
        assert registration.status_code==201
        assert 'HttpOnly' in registration.headers['set-cookie']
        csrf={'X-CSRF-Token':registration.json()['csrf_token']}
        dashboard = client.get("/dashboard").json()
        assert dashboard["counts"]["videos"] == 0
        assert dashboard["worker_online"] is False
        client.post("/jobs/collect",headers=csrf)
        assert client.get("/dashboard").json()["jobs"][0]["kind"] == "collect"
        assert client.get("/videos").json() == []
    with TestClient(api.app, base_url="http://attacker.example") as remote:
        assert "set-cookie" not in remote.get("/").headers
        remote.cookies.set("spur_session", "local-secret")
        assert remote.get("/dashboard").status_code == 401


def test_ui_model_settings_are_persisted(tmp_path, monkeypatch):
    import spur.api as api
    monkeypatch.setattr(api, "settings", replace(Settings(), db_path=str(tmp_path / "model.db"), api_key="key"))

    async def available():
        return {"online": True, "models": ["local-model"]}

    monkeypatch.setattr(api, "models", available)
    with TestClient(api.app) as client:
        headers = {"X-API-Key": "key"}
        assert client.put("/settings/model", json={"model": "unknown"}, headers=headers).status_code == 422
        assert client.put("/settings/model", json={"model": "local-model"}, headers=headers).status_code == 200
        assert client.get("/dashboard", headers=headers).json()["model"] == "local-model"
