"""One-command local dashboard and worker. Never binds to a public interface."""
import os
import secrets
import subprocess
import sys
from pathlib import Path


def main():
    os.environ.setdefault("SPUR_API_KEY", secrets.token_urlsafe(32))
    os.environ["SPUR_LOCAL_UI"] = "1"
    os.environ.setdefault("SPUR_DB", str(Path("data/spur.db").resolve()))
    from spur.api import app
    import uvicorn

    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    worker = subprocess.Popen([sys.executable, "-m", "spur.worker"], env=os.environ.copy(), creationflags=flags)
    try:
        uvicorn.run(app, host="127.0.0.1", port=8000, proxy_headers=False)
    finally:
        worker.terminate()
        worker.wait(timeout=10)


if __name__ == "__main__":
    main()
