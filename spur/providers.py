"""Model adapters. Tools, memory, jobs and report validation belong to our harness."""
import copy
import json

from spur.credentials import load_key

ENDPOINTS = {"openai": "https://api.openai.com/v1", "deepseek": "https://api.deepseek.com"}


def strict_schema(schema):
    schema = copy.deepcopy(schema)
    def walk(node):
        if isinstance(node, dict):
            if node.get("type") == "object":
                node["additionalProperties"] = False
                node["required"] = list(node.get("properties", {}))
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)
    walk(schema)
    return schema


class ModelSession:
    def __init__(self, settings, client):
        self.settings, self.client = settings, client
        self.input = []
        self.cursor = 0

    async def chat(self, messages, tools=None, schema=None):
        provider, model = self.settings.provider, self.settings.model
        if provider == "ollama":
            body = {"model": model, "stream": False, "messages": messages,
                    "options": {"temperature": 0, "num_predict": 6000}}
            if tools:
                body["tools"] = tools
            if schema:
                body["format"] = schema
            response = await self.client.post(self.settings.ollama_url.rstrip("/") + "/api/chat", json=body, timeout=90)
            response.raise_for_status()
            return response.json()["message"]
        if provider not in ENDPOINTS:
            raise ValueError("Unsupported model provider")
        key = load_key(self.settings, provider)
        if not key:
            raise ValueError(f"Connect {provider} in Settings before running the agent")
        headers = {"Authorization": "Bearer " + key}
        if provider == "openai":
            # Preserve raw response items, including reasoning, without storing state at OpenAI.
            for message in messages[self.cursor:]:
                if message["role"] == "assistant":
                    # On a new chat turn, include saved assistant text from the
                    # transcript. Later rounds already preserve raw output below.
                    if self.cursor==0 and message.get('content'):
                        self.input.append({'role':'assistant','content':message['content']})
                    continue
                if message["role"] == "tool":
                    self.input.append({"type": "function_call_output", "call_id": message["tool_call_id"],
                                       "output": message["content"]})
                else:
                    self.input.append({"role": message["role"], "content": message["content"]})
            self.cursor = len(messages)
            body = {"model": model, "input": self.input, "store": False, "max_output_tokens": 6000}
            if tools:
                body["tools"] = [{"type": "function", **tool["function"], "strict": True} for tool in tools]
            if schema:
                body["text"] = {"format": {"type": "json_schema", "name": "research_report",
                                          "strict": True, "schema": strict_schema(schema)}}
            data = await self.request(ENDPOINTS[provider] + "/responses", body, headers)
            if data.get("status") == "incomplete":
                raise ValueError("OpenAI response was incomplete; reduce the task size or output requirements")
            output = data.get("output", [])
            self.input.extend(output)
            calls = [{"id": item["call_id"], "type": "function", "function": {
                "name": item["name"], "arguments": item["arguments"]}} for item in output if item["type"] == "function_call"]
            text = "".join(part.get("text", "") for item in output if item["type"] == "message"
                           for part in item.get("content", []) if part["type"] == "output_text")
            return {"role": "assistant", "content": text, **({"tool_calls": calls} if calls else {})}
        # DeepSeek uses Chat Completions tool call IDs and JSON mode.
        converted = []
        for message in messages:
            entry = {k: v for k, v in message.items() if k in ("role", "content", "tool_calls", "tool_call_id", "reasoning_content")}
            converted.append(entry)
        # Explicit mode avoids the provider's default high reasoning budget consuming
        # the entire completion allowance before a usable creator artifact is returned.
        body = {"model": model, "messages": converted, "stream": False, "max_tokens": 6000,
                "thinking": {"type":"disabled"}}
        if tools:
            body["tools"] = tools
        if schema:
            body["response_format"] = {"type": "json_object"}
            body["messages"] = converted + [{"role": "user", "content": "Return ONLY the JSON instance matching this schema. Do not include the schema itself or format metadata fields: " + json.dumps(schema)}]
        data = await self.request(ENDPOINTS[provider] + "/chat/completions", body, headers)
        choice = data["choices"][0]
        if choice.get("finish_reason") == "length":
            raise ValueError("DeepSeek response exceeded the output limit")
        return choice["message"]

    async def request(self, url, body, headers):
        response = await self.client.post(url, json=body, headers=headers, timeout=90)
        if not response.is_success:
            # Never propagate provider bodies or credentials into persisted job errors.
            raise ValueError(f"{self.settings.provider} request failed (HTTP {response.status_code}). Check credentials, model access and API balance.")
        return response.json()
