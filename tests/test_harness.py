import asyncio
import json
import os
import time
from dataclasses import replace

import httpx
import pytest
from fastapi.testclient import TestClient

from spur.agent import generate_report
from spur.config import Settings
from spur.credentials import load_key, save_key
from spur.store import Store


def test_memory_survives_restart_and_report_commit(tmp_path):
    path = str(tmp_path / "memory.db")
    first = Store(path)
    note = first.add_knowledge("Research priorities", "Focus on semiconductor supply chains")
    job_id = first.enqueue("report", {"topic": "Suppliers", "days": 7})
    job = first.claim()
    first.finish(job, {"report_id": "report-1"}, report={"topic": "Suppliers", "summary": "Historical finding", "sources": {}})
    second = Store(path)
    assert second.knowledge_count() == 2
    assert second.knowledge("semiconductor")[0]["id"] == note
    assert second.knowledge("Historical")[0]["report_id"] == "report-1"
    assert second.job(job_id)["status"] == "succeeded"


@pytest.mark.skipif(os.name != "nt", reason="Windows credential encryption")
def test_api_key_is_encrypted_on_disk(tmp_path, monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    config = replace(Settings(), db_path=str(tmp_path / "test.db"))
    save_key(config, "openai", "synthetic-unit-test-key")
    data = (tmp_path / "credentials" / "openai.dpapi").read_bytes()
    assert b"synthetic-unit-test-key" not in data
    assert load_key(config, "openai") == "synthetic-unit-test-key"


def test_provider_switch_preserves_memory_and_never_returns_key(tmp_path, monkeypatch):
    import spur.api as api
    config = replace(Settings(), db_path=str(tmp_path / "api.db"), api_key="test-auth")
    monkeypatch.setattr(api, "settings", config)
    monkeypatch.setenv("OPENAI_API_KEY", "synthetic-openai-key")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "synthetic-deepseek-key")
    headers = {"X-API-Key": "test-auth"}
    with TestClient(api.app) as client:
        assert client.get("/knowledge").status_code == 401
        assert client.post("/knowledge", headers=headers, json={"title": "Company", "content": "Business context"}).status_code == 201
        for provider in ("openai", "deepseek"):
            response = client.put("/settings/provider", headers=headers, json={"provider": provider, "model": "test-model"})
            assert response.status_code == 200
            assert "synthetic" not in response.text
            assert response.json()["has_key"] is True
            assert client.get("/dashboard", headers=headers).json()["provider"] == provider
            assert client.get("/dashboard", headers=headers).json()["knowledge_count"] == 1
        assert client.get("/knowledge", headers=headers).json()[0]["content"] == "Business context"


@pytest.mark.parametrize("provider", ["openai", "deepseek"])
def test_hosted_model_tools_and_persistent_knowledge(tmp_path, monkeypatch, provider):
    monkeypatch.setenv("OPENAI_API_KEY", "synthetic-openai-key")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "synthetic-deepseek-key")
    config = replace(Settings(), db_path=str(tmp_path / "report.db"), provider=provider, model="test-model")
    store = Store(config.db_path)
    source = store.add_source("UC" + "a" * 22, "Research channel")
    store.save_items(source["id"], [{"id": "abcdefghijk", "title": "Product launch", "description": "Creator announcement",
                                   "url": "https://www.youtube.com/watch?v=abcdefghijk", "published": time.time() - 5}])
    note_id = store.add_knowledge("Business", "Focus on suppliers")
    requests = []
    final = json.dumps({"summary": "Creator announcement, considered in supplier context.", "developments": [{
        "title": "Launch", "observation": "Channel announced a product", "implication": "May affect suppliers",
        "evidence_ids": ["abcdefghijk"]}], "potential_trends": [], "limitations": ["Metadata only"]})

    def handler(request):
        body = json.loads(request.content)
        requests.append(body)
        index = len(requests)
        assert request.headers["authorization"].startswith("Bearer synthetic-")
        if provider == "openai":
            assert request.url.path == "/v1/responses"
            assert body["store"] is False
            if index == 1:
                output = [{"type": "reasoning", "id": "reasoning-1", "summary": []}, {"type": "function_call", "call_id": "call-1",
                          "name": "search_knowledge", "arguments": '{"query":"suppliers"}'}]
            else:
                assert any(item.get("type") == "reasoning" for item in body["input"])
                assert any(item.get("type") == "function_call_output" and item["call_id"] == "call-1" for item in body["input"])
                if index == 3:
                    assert body["text"]["format"]["strict"] is True
                    assert body["text"]["format"]["schema"]["additionalProperties"] is False
                output = [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": final if index == 3 else "Ready"}]}]
            return httpx.Response(200, json={"status": "completed", "output": output})
        assert request.url.path == "/chat/completions"
        if index == 1:
            message = {"role": "assistant", "content": None, "reasoning_content": "Consider context", "tool_calls": [
                {"id": "call-1", "type": "function", "function": {"name": "search_knowledge", "arguments": '{"query":"suppliers"}'}}]}
        else:
            assert any(m.get("tool_call_id") == "call-1" for m in body["messages"])
            assert any(m.get("reasoning_content") == "Consider context" for m in body["messages"])
            if index == 3:
                assert body["response_format"] == {"type": "json_object"}
            message = {"role": "assistant", "content": final if index == 3 else "Ready"}
        return httpx.Response(200, json={"choices": [{"finish_reason": "stop", "message": message}]})

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await generate_report(store, config, {"topic": "Suppliers", "days": 7}, client)

    report = asyncio.run(run())
    assert report["provider"] == provider
    assert report["knowledge_context"][0]["id"] == note_id
    assert report["tool_trace"][0]["tool"] == "search_knowledge"
    assert report["sources"]["abcdefghijk"]["source_name"] == "Research channel"


def test_knowledge_only_prompt_without_videos(tmp_path):
    store = Store(str(tmp_path / "knowledge.db"))
    store.add_knowledge("Our company", "We build tools for researchers")
    def handler(request):
        body = json.loads(request.content)
        answer = {"summary": "Your saved context says you build tools for researchers.", "developments": [],
                  "potential_trends": [], "limitations": ["Based on saved notes, not verified current sources"]}
        return httpx.Response(200, json={"message": {"role": "assistant", "content": json.dumps(answer) if "format" in body else "Ready"}})
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await generate_report(store, replace(Settings(), model="test-model"), {"topic": "What do we build?", "days": 7}, client)
    report = asyncio.run(run())
    assert report["sources"] == {}
    assert len(report["knowledge_context"]) == 1
