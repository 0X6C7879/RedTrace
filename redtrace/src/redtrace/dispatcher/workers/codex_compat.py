from __future__ import annotations

import json
import os
import secrets
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

import requests


_LOCK = threading.Lock()
_SERVER: ThreadingHTTPServer | None = None
_ROUTES: dict[str, str] = {}


def codex_compat_base_url(upstream: str) -> str:
    global _SERVER
    with _LOCK:
        if _SERVER is None:
            _SERVER = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
            threading.Thread(target=_SERVER.serve_forever, daemon=True).start()
        token = next(
            (key for key, value in _ROUTES.items() if value == upstream), None
        )
        if token is None:
            token = secrets.token_urlsafe(12)
            _ROUTES[token] = upstream.rstrip("/")
        port = _SERVER.server_address[1]
    return f"http://127.0.0.1:{port}/{token}"


def normalize_response_input(body: dict[str, object]) -> None:
    items = body.get("input")
    if not isinstance(items, list):
        return
    if os.environ.get("REDTRACE_CODEX_COMPAT_DEBUG"):
        print(
            "COMPAT_INPUT",
            body.get("store"),
            [
                (
                    item.get("type"),
                    type(item.get("output")).__name__,
                    sorted(item),
                    [part.get("type") for part in item.get("output", [])]
                    if isinstance(item.get("output"), list)
                    else None,
                )
                for item in items
                if isinstance(item, dict)
            ],
            flush=True,
        )
    for item in items:
        if not isinstance(item, dict) or item.get("type") != "function_call_output":
            continue
        output = item.get("output")
        if not isinstance(output, list):
            continue
        item["output"] = "\n".join(
            part.get("text", "")
            if isinstance(part, dict) and isinstance(part.get("text"), str)
            else json.dumps(part, ensure_ascii=False)
            for part in output
        )


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_POST(self) -> None:
        path = urlsplit(self.path).path.lstrip("/")
        token, separator, suffix = path.partition("/")
        upstream = _ROUTES.get(token)
        if not upstream or not separator:
            self.send_error(404)
            return
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        if suffix == "responses":
            payload = json.loads(body)
            normalize_response_input(payload)
            body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
        headers = {
            name: value
            for name, value in self.headers.items()
            if name.lower() not in {"host", "content-length", "connection"}
        }
        try:
            with requests.post(
                f"{upstream}/{suffix}",
                data=body,
                headers=headers,
                stream=True,
                timeout=(10, 600),
            ) as response:
                self.send_response(response.status_code)
                for name, value in response.headers.items():
                    if name.lower() not in {
                        "connection",
                        "content-encoding",
                        "content-length",
                        "transfer-encoding",
                    }:
                        self.send_header(name, value)
                self.send_header("Connection", "close")
                self.end_headers()
                for chunk in response.iter_content(64 * 1024):
                    if chunk:
                        self.wfile.write(chunk)
                        self.wfile.flush()
                self.close_connection = True
        except (BrokenPipeError, ConnectionResetError):
            pass
        except requests.RequestException as exc:
            self.send_error(502, str(exc))

    def log_message(self, _format: str, *args: object) -> None:
        pass
