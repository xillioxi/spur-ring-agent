from dataclasses import replace

import pytest
from fastapi.testclient import TestClient
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

from spur.config import Settings
from spur.hosted import public_application


@pytest.mark.parametrize('hostname', ['', 'https://hispurring.com', 'app.hispurring.com:8000',
                                     '*.hispurring.com', 'app.hispurring.com/path', 'app.hispurring.com\nother'])
def test_hosted_rejects_invalid_hostname(hostname):
    with pytest.raises(ValueError):
        public_application(lambda *args: None, hostname)


@pytest.fixture
def hosted(tmp_path, monkeypatch):
    import spur.api as api
    monkeypatch.setattr(api, 'settings', replace(Settings(), db_path=str(tmp_path / 'app.db'), api_key='test-service'))
    return ProxyHeadersMiddleware(public_application(api.app, 'app.hispurring.com'),
                                  trusted_hosts=['127.0.0.1', '::1'])


def test_hosted_rejects_unexpected_host(hosted):
    with TestClient(hosted, base_url='http://untrusted.example') as client:
        assert client.get('/login').status_code == 400


def test_trusted_https_proxy_sets_secure_login_cookie(hosted):
    with TestClient(hosted, base_url='http://localhost', client=('127.0.0.1', 50000)) as client:
        credentials = {'username': 'owner', 'password': 'test-password-long', 'display_name': 'Owner'}
        assert client.post('/auth/register', headers={'X-Spur-Auth': '1'}, json=credentials).status_code == 201
        response = client.post('/auth/login', json=credentials,
                               headers={'Host': 'app.hispurring.com', 'Origin': 'https://app.hispurring.com',
                                        'X-Forwarded-Proto': 'https', 'X-Spur-Auth': '1'})
        assert response.status_code == 200
        cookie = response.headers['set-cookie'].lower()
        assert 'secure' in cookie and 'httponly' in cookie and 'samesite=strict' in cookie


def test_untrusted_client_cannot_spoof_https_forwarding(hosted):
    with TestClient(hosted, base_url='http://app.hispurring.com', client=('198.51.100.5', 50000)) as client:
        response = client.post('/auth/login', json={'username': 'owner', 'password': 'test-password-long'},
                               headers={'Origin': 'https://app.hispurring.com', 'X-Forwarded-Proto': 'https',
                                        'X-Spur-Auth': '1'})
        assert response.status_code == 403
