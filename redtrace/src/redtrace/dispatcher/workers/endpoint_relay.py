"""Local endpoint relay for ``direct`` endpoint mode.

When a worker's ``endpoint_mode`` is ``"direct"``, the configured URL is the
**final request URL** (e.g. an LLM gateway proxy).  Agent CLIs automatically
append API paths like ``/v1/messages`` or ``/chat/completions`` to whatever
base URL they receive, which would produce an incorrect URL for a direct
endpoint.

The relay solves this by spinning up a local HTTP server per unique upstream
URL.  The CLI sends requests to standard paths on ``localhost:{port}``; the
relay strips the API path suffix and forwards the raw request (headers + body)
to the configured upstream URL.
"""

from __future__ import annotations

import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

import requests


class EndpointRelay:
    """Singleton local HTTP relay that forwards requests to a direct upstream URL.

    Each unique upstream URL gets a set of exact routes on a shared local
    server.  The relay matches the incoming request path against registered
    routes and forwards the raw request to the upstream.
    """

    _lock = threading.Lock()
    _server: ThreadingHTTPServer | None = None
    _routes: dict[str, str] = {}  # path -> upstream URL

    @classmethod
    def _ensure_server(cls) -> None:
        if cls._server is not None:
            return

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self_handler) -> None:
                cls._handle_request(self_handler)

            def do_GET(self_handler) -> None:
                cls._handle_request(self_handler)

            def log_message(self_handler, _fmt: str, *args: object) -> None:
                pass  # silence request logging

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        cls._server = server

    @classmethod
    def _handle_request(cls, handler: BaseHTTPRequestHandler) -> None:
        path = urlsplit(handler.path).path
        if path.startswith("/"):
            path = path[1:]
        upstream = cls._routes.get(path)
        if not upstream:
            handler.send_error(404)
            return
        length = int(handler.headers.get("Content-Length", "0"))
        body = handler.rfile.read(length)
        headers = {
            name: value
            for name, value in handler.headers.items()
            if name.lower() not in {"host", "content-length", "connection"}
        }
        try:
            with requests.request(
                handler.command,
                upstream,
                data=body,
                headers=headers,
                stream=True,
                timeout=(10, 600),
            ) as response:
                handler.send_response(response.status_code)
                for name, value in response.headers.items():
                    if name.lower() not in {
                        "connection",
                        "content-encoding",
                        "content-length",
                        "transfer-encoding",
                    }:
                        handler.send_header(name, value)
                handler.send_header("Connection", "close")
                handler.end_headers()
                for chunk in response.iter_content(64 * 1024):
                    if chunk:
                        handler.wfile.write(chunk)
                        handler.wfile.flush()
                handler.close_connection = True
        except (BrokenPipeError, ConnectionResetError):
            pass
        except requests.RequestException as exc:
            handler.send_error(502, str(exc))

    @classmethod
    def register(cls, upstream: str) -> str:
        """Register *upstream* and return a local relay URL.

        Multiple calls with the same *upstream* return the same URL.
        Exact routes are registered for the base token and each known
        API path suffix so that CLIs appending ``/v1/messages``,
        ``/responses``, or ``/chat/completions`` are forwarded correctly.
        """
        upstream = upstream.rstrip("/")
        with cls._lock:
            cls._ensure_server()
            token = next(
                (k for k, v in cls._routes.items() if v == upstream),
                None,
            )
            if token is None:
                import secrets

                token = secrets.token_urlsafe(12)
                cls._routes[token] = upstream
                # Register exact routes for each known API path suffix.
                for suffix in ("/v1/messages", "/chat/completions", "/responses"):
                    cls._routes[f"{token}{suffix}"] = upstream
            port = cls._server.server_address[1]  # type: ignore[union-attr]
        return f"http://127.0.0.1:{port}/{token}"

    @classmethod
    def ping(cls, upstream: str, *, timeout: float = 5.0) -> tuple[bool, str]:
        """Probe the relay for *upstream* by hitting ``/healthz``.

        Returns ``(ok, detail)``.
        """
        url = cls.register(upstream)
        started = time.perf_counter()
        try:
            response = requests.post(
                f"{url}/healthz",
                json={"ping": True},
                timeout=timeout,
            )
            duration_ms = int((time.perf_counter() - started) * 1000)
            ok = response.status_code < 500
            return ok, f"relay -> {upstream} ({response.status_code}, {duration_ms}ms)"
        except requests.RequestException as exc:
            duration_ms = int((time.perf_counter() - started) * 1000)
            return False, f"relay -> {upstream} failed ({exc}, {duration_ms}ms)"
