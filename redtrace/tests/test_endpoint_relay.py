"""E2E tests for EndpointRelay routing.

Verifies that the relay correctly strips API path suffixes and forwards
requests to the exact upstream URL without appending extra paths.
"""
from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest
import requests

from redtrace.dispatcher.workers.endpoint_relay import EndpointRelay


class _MockUpstream(BaseHTTPRequestHandler):
    """Records the exact path and headers of each request."""

    requests_log: list[dict] = []

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        _MockUpstream.requests_log.append({
            "path": self.path,
            "headers": {k: v for k, v in self.headers.items()},
            "body": body.decode("utf-8", errors="replace"),
        })
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"ok": True}).encode())

    def log_message(self, _fmt: str, *args: object) -> None:
        pass


@pytest.fixture()
def mock_upstream():
    """Start a local mock upstream server and return its base URL."""
    server = HTTPServer(("127.0.0.1", 0), _MockUpstream)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    _MockUpstream.requests_log.clear()
    yield f"http://127.0.0.1:{port}"
    server.shutdown()


def _post(relay_url: str, path: str, **kwargs) -> requests.Response:
    return requests.post(f"{relay_url}{path}", timeout=5, **kwargs)


# ── Claude / Anthropic style ──────────────────────────────────────────────


def test_relay_claude_direct_endpoint(mock_upstream: str) -> None:
    """CLI POST to relay/v1/messages → upstream receives request at root."""
    relay_url = EndpointRelay.register(mock_upstream)
    resp = _post(
        relay_url,
        "/v1/messages",
        headers={
            "Content-Type": "application/json",
            "x-api-key": "sk-test-secret",
            "anthropic-version": "2023-06-01",
        },
        json={"model": "test", "max_tokens": 10, "messages": []},
    )
    assert resp.status_code == 200
    assert len(_MockUpstream.requests_log) == 1
    req = _MockUpstream.requests_log[0]
    # Upstream must receive request at root path, NOT /v1/messages
    assert req["path"] == "/"
    # Headers are case-insensitive — check via lowercased lookup
    lower_headers = {k.lower(): v for k, v in req["headers"].items()}
    assert lower_headers.get("x-api-key") == "sk-test-secret"
    assert lower_headers.get("anthropic-version") == "2023-06-01"


# ── OpenAI / Pi style ────────────────────────────────────────────────────


def test_relay_pi_openai_direct_endpoint(mock_upstream: str) -> None:
    """CLI POST to relay/chat/completions → upstream receives request at root."""
    relay_url = EndpointRelay.register(mock_upstream)
    resp = _post(
        relay_url,
        "/chat/completions",
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer sk-test-secret",
        },
        json={"model": "test", "messages": []},
    )
    assert resp.status_code == 200
    req = _MockUpstream.requests_log[0]
    assert req["path"] == "/"
    assert req["headers"].get("Authorization") == "Bearer sk-test-secret"


def test_relay_codex_direct_endpoint(mock_upstream: str) -> None:
    """CLI POST to relay/responses → upstream receives request at root."""
    relay_url = EndpointRelay.register(mock_upstream)
    resp = _post(
        relay_url,
        "/responses",
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer sk-test-secret",
        },
        json={"model": "test", "input": []},
    )
    assert resp.status_code == 200
    req = _MockUpstream.requests_log[0]
    assert req["path"] == "/"


# ── Exact matching, no fuzzy ─────────────────────────────────────────────


def test_relay_unknown_path_returns_404(mock_upstream: str) -> None:
    """Paths that don't match a registered route return 404."""
    relay_url = EndpointRelay.register(mock_upstream)
    resp = _post(relay_url, "/unknown/path", json={})
    assert resp.status_code == 404
    assert len(_MockUpstream.requests_log) == 0


# ── Multiple upstreams don't cross-route ──────────────────────────────────


def test_relay_multiple_upstreams_isolated(mock_upstream: None) -> None:
    """Different upstreams get different tokens and don't share routes."""
    # Start a second mock upstream
    server2 = HTTPServer(("127.0.0.1", 0), _MockUpstream)
    port2 = server2.server_address[1]
    thread2 = threading.Thread(target=server2.serve_forever, daemon=True)
    thread2.start()
    upstream2 = f"http://127.0.0.1:{port2}"

    url1 = EndpointRelay.register(mock_upstream)
    url2 = EndpointRelay.register(upstream2)

    assert url1 != url2  # Different tokens

    _MockUpstream.requests_log.clear()
    _post(url1, "/v1/messages", json={"model": "a"})
    assert len(_MockUpstream.requests_log) == 1

    # The request should NOT have been routed through url2's token
    server2.shutdown()


# ── Request body forwarded as-is ─────────────────────────────────────────


def test_relay_forwards_body_unchanged(mock_upstream: str) -> None:
    """Request body is forwarded to upstream without modification."""
    relay_url = EndpointRelay.register(mock_upstream)
    payload = {"model": "test", "messages": [{"role": "user", "content": "hello"}]}
    _post(
        relay_url,
        "/v1/messages",
        headers={"Content-Type": "application/json"},
        json=payload,
    )
    req = _MockUpstream.requests_log[0]
    assert json.loads(req["body"]) == payload


# ── Consistent URL on re-register ────────────────────────────────────────


def test_relay_register_idempotent(mock_upstream: str) -> None:
    """Registering the same upstream twice returns the same relay URL."""
    url1 = EndpointRelay.register(mock_upstream)
    url2 = EndpointRelay.register(mock_upstream)
    assert url1 == url2
