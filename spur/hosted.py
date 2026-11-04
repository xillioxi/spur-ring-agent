"""Windows backend behind a local HTTPS reverse proxy.

Keeps existing DPAPI credentials on their original Windows account. This is
separate from spur.local: it trusts forwarding headers only from loopback.
"""
import os
import re
import secrets
import subprocess
import sys
from pathlib import Path

from starlette.middleware.trustedhost import TrustedHostMiddleware


def public_application(application, hostname):
    hostname = hostname.strip().lower()
    label = r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
    if len(hostname) > 253 or not re.fullmatch(label + r'(?:\.' + label + r')+', hostname):
        raise ValueError('SPUR_PUBLIC_HOST must be a hostname without a scheme, port, or path')
    return TrustedHostMiddleware(application, allowed_hosts=[hostname, 'localhost', '127.0.0.1', '[::1]'])


def main():
    if os.name != 'nt':
        raise RuntimeError('This deployment entry point requires the Windows account that owns the DPAPI credentials')
    hostname = os.environ.get('SPUR_PUBLIC_HOST', '')
    if not hostname:
        raise RuntimeError('Set SPUR_PUBLIC_HOST to the chosen public app hostname')
    os.environ.setdefault('SPUR_API_KEY', secrets.token_urlsafe(32))
    os.environ['SPUR_LOCAL_UI'] = '0'
    os.environ.setdefault('SPUR_DB', str(Path('data/spur.db').resolve()))
    from spur.api import app
    import uvicorn

    application = public_application(app, hostname)
    worker = subprocess.Popen([sys.executable, '-m', 'spur.worker'], env=os.environ.copy(),
                              creationflags=subprocess.CREATE_NO_WINDOW)
    try:
        uvicorn.run(application, host='127.0.0.1', port=8000, proxy_headers=True,
                    forwarded_allow_ips='127.0.0.1,::1')
    finally:
        worker.terminate()
        worker.wait(timeout=10)


if __name__ == '__main__':
    main()
