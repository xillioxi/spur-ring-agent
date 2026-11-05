# Connect an external agent to Spur Ring

Use this guide when your agent runs outside Spur Ring and needs to use its existing workspace, agents or social integrations through HTTP.

## Get the three inputs from the operator

- `SPUR_BASE_URL` — the running Spur Ring server. Use `http://127.0.0.1:8000` only if the harness shares the server's network namespace. For a remote agent, supply the installation's reachable HTTPS origin. A GitHub URL points to source code. Running a fork starts a separate installation with its own workspaces.
- `SPUR_USERNAME` and `SPUR_PASSWORD` — credentials for the intended Spur Ring workspace, supplied through your harness's secret store. Each account has its own data and social connections. For a dedicated agent account, the operator must connect the relevant social accounts in that workspace.

GitHub access is optional for an API client. The operator only needs to grant repository access if the harness also needs to inspect or change the private source. Never put passwords, provider tokens, cookies or the server-wide API key into a prompt, repository or log.

## First run: authenticate and inspect

Run this Python example with the project's `httpx` dependency. It signs in, verifies the selected workspace and lists connection states. It makes no provider requests.

```python
import os
from urllib.parse import urlsplit
import httpx

base = os.environ["SPUR_BASE_URL"].rstrip("/")
url = urlsplit(base)
if url.scheme != "https" and not (
    url.scheme == "http" and url.hostname in {"localhost", "127.0.0.1", "::1"}
):
    raise ValueError("Use HTTPS for a remote Spur Ring server")

with httpx.Client(base_url=base, timeout=20) as client:
    login = client.post("/auth/login", headers={"X-Spur-Auth": "1"}, json={
        "username": os.environ["SPUR_USERNAME"],
        "password": os.environ["SPUR_PASSWORD"],
        "remember": False,
    })
    login.raise_for_status()
    me = client.get("/auth/me").raise_for_status().json()
    if me["mock_profile"]:
        raise RuntimeError("Use the personal workspace for connected accounts")
    client.headers.update({
        "X-CSRF-Token": me["csrf_token"],
        "X-Spur-User": me["user"]["id"],
        "X-Spur-Profile": "personal",
    })
    client.get("/health").raise_for_status()
    for row in client.get("/social/connections").raise_for_status().json()["connections"]:
        print(row["platform"], row["status"], row.get("account_name", ""))
    # Run further authorized requests with this same client and cookie jar.
    client.post("/auth/logout").raise_for_status()
```

Success means the server returns your workspace identity and a status for each supported social platform. A successful Spur Ring login can still show disconnected providers. Stop if the account name is unexpected.

## Use a connected platform

| Task | Request or sequence |
|---|---|
| Read an existing YouTube analytics report | `GET /social/youtube/analytics?days=28`. A null snapshot means this workspace has no saved result for that period. |
| Refresh YouTube, Instagram, TikTok or LinkedIn analytics | With a connected account and permission to sync, send `POST /social/{platform}/sync` with `{"days":28}`. Poll `GET /jobs/{job_id}` with a short delay and a deadline. On success, fetch the analytics endpoint for the same period. |
| Ask the Marketing Lead for a report | List agents with `GET /agents`. Send `POST /agents/coordinator/chat` with `{"content":"Summarize the latest saved YouTube analytics.","request_id":"<unique UUID>"}`. Preserve the request ID when retrying the same message. Poll the returned job, then read `GET /agents/coordinator/chat`. This requires a configured model and a running worker. |
| Review a Facebook Page video share | Facebook uses the linked Instagram connection. Use `GET /publishing/instagram` to find an eligible owned, previously published Reel uploaded as an MP4. Call `GET /publishing/facebook/{source_id}/review` and check the Page identity and posting permission. Review alone does not publish. |

For a **disconnected** account, direct the operator to **Connections & Analytics** in the intended workspace to complete provider consent in their own browser. For Instagram or TikTok posting, use the corresponding **Publishing** connection. Let the browser that initiated OAuth finish the callback. Then rerun the connection check. For Facebook Page posting, the saved grant must include `pages_manage_posts`; the current Instagram browser flow omits it, so the installation owner may need the local Meta developer-token flow. The external harness should never collect the operator's social password or ask them to paste a Meta token into chat.

Use the running server's `/openapi.json` for request schemas. On 401, renew the workspace session. On a CSRF error, refresh `/auth/me` using the same cookie jar. On a workspace or account mismatch (409), verify the intended identity before proceeding. A queued job is pending until its status confirms the result. A request to connect or inspect accounts does not authorize publishing content.
