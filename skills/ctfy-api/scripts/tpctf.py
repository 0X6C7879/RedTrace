#!/usr/bin/env python3
"""CTFy platform CLI for RedTrace workers. No third-party Python deps.

This controls authorized contest API and WireGuard instance access only;
RedTrace's existing agents solve the actual challenge.
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any

DEFAULT_BASE = "https://ctfy.tsinghua.edu.cn/api/v1"
SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


class PlatformError(Exception):
    def __init__(self, code: str, detail: Any, status: int | None = None):
        self.code, self.detail, self.status = code, detail, status
        super().__init__(f"{code}: {detail}")


def out(data: Any) -> None:
    print(json.dumps(data, ensure_ascii=False, separators=(",", ":"), default=str))


def err(code: str, detail: Any, status: int | None = None) -> int:
    out({"ok": False, "code": code, "detail": detail, "http_status": status})
    return 1


def field_id(raw: str) -> str:
    if not SAFE_ID.fullmatch(raw):
        raise PlatformError("invalid_id", "Expected API-supplied alphanumeric ID")
    return raw


def state_dir() -> pathlib.Path:
    root = os.environ.get("CTFY_STATE_DIR") or os.path.join(pathlib.Path.home(), ".cache", "redtrace-tpctf")
    return pathlib.Path(root).expanduser()


def vpn_paths() -> tuple[pathlib.Path, pathlib.Path]:
    base = state_dir()
    return base / "tpctf0.conf", base / "vpn-state.json"


def save_private(path: pathlib.Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(str(path), os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(payload)
    if os.name != "nt":
        os.chmod(path, 0o600)


def load_vpn_state() -> dict[str, Any]:
    _, path = vpn_paths()
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def require_token(kind: str) -> str:
    key = "CTFY_PLAY_TOKEN" if kind == "play" else "CTFY_AUTHOR_TOKEN"
    value = os.environ.get(key, "").strip() or os.environ.get("CTFY_TOKEN", "").strip()
    if not value:
        raise PlatformError("missing_token", f"Set CTFY_TOKEN or {key} in RedTrace worker environment")
    return value


class API:
    def __init__(self, base_url: str | None = None):
        self.base = (base_url or os.environ.get("CTFY_BASE_URL") or DEFAULT_BASE).rstrip("/")
        parts = urllib.parse.urlparse(self.base)
        if parts.scheme not in ("https", "http") or not parts.netloc:
            raise PlatformError("bad_base_url", "CTFY_BASE_URL must be an HTTP(S) URL")
        self.mcp_session = ""
        self.mcp_version = "2025-03-26"

    def call(
        self, method: str, path: str, *, token_kind: str = "play", body: Any = None,
        query: dict[str, Any] | None = None, binary: bool = False,
        multipart: tuple[dict[str, str], pathlib.Path] | None = None,
        rpc: bool = False,
    ) -> Any:
        # Paths are built internally, never from arbitrary contestant-provided URLs.
        endpoint = self.base + "/" + path.lstrip("/")
        if query:
            q = {k: v for k, v in query.items() if v is not None and v != ""}
            if q:
                endpoint += "?" + urllib.parse.urlencode(q)
        headers = {"Authorization": "Bearer " + require_token(token_kind), "Accept": "application/json"}
        if rpc:
            headers["Accept"] = "application/json, text/event-stream"
            headers["MCP-Protocol-Version"] = self.mcp_version
            if self.mcp_session:
                headers["Mcp-Session-Id"] = self.mcp_session
        content = None
        if multipart is not None:
            fields, archive = multipart
            if not archive.is_file():
                raise PlatformError("missing_archive", f"File not found: {archive}")
            boundary = "----tpctf" + uuid.uuid4().hex
            pieces: list[bytes] = []
            for k, v in fields.items():
                pieces.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode())
            name = archive.name.replace('"', "")
            pieces.append((f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\n"
                           f"Content-Type: application/octet-stream\r\n\r\n").encode())
            pieces.append(archive.read_bytes())
            pieces.append((f"\r\n--{boundary}--\r\n").encode())
            content = b"".join(pieces)
            headers["Content-Type"] = "multipart/form-data; boundary=" + boundary
        elif body is not None:
            content = json.dumps(body, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(endpoint, method=method, headers=headers, data=content)
        try:
            with urllib.request.urlopen(req, timeout=30) as response:
                if rpc:
                    self.mcp_session = response.headers.get("Mcp-Session-Id", self.mcp_session)
                raw = response.read()
                if binary:
                    return raw
                if not raw:
                    return {}
                text = raw.decode("utf-8")
                if rpc and not text.lstrip().startswith("{"):
                    # SSE may include progress events before the matching JSON-RPC reply.
                    messages = [json.loads("\n".join(line[5:].lstrip() for line in event.splitlines() if line.startswith("data:")))
                                for event in text.replace("\r\n", "\n").split("\n\n") if any(line.startswith("data:") for line in event.splitlines())]
                    payload = next((m for m in messages if m.get("id") == body.get("id")), None)
                    if payload is None:
                        raise PlatformError("mcp_missing_response", "No matching JSON-RPC response")
                else:
                    payload = json.loads(text)
                if rpc:
                    if "error" in payload:
                        raise PlatformError("mcp_error", payload["error"])
                    result = payload["result"]
                    if result.get("isError"):
                        raise PlatformError("mcp_tool_error", result.get("content", []))
                    return result
                return payload
        except urllib.error.HTTPError as exc:
            raw = exc.read()
            try:
                payload = json.loads(raw.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                payload = {}
            raise PlatformError(payload.get("code", f"http_{exc.code}"), payload.get("detail", "Request rejected"), exc.code) from None
        except urllib.error.URLError as exc:
            raise PlatformError("network_error", str(exc.reason)) from None
        except TimeoutError:
            raise PlatformError("network_timeout", "Request timed out") from None
        except (ValueError, UnicodeDecodeError):
            raise PlatformError("invalid_json", "Platform returned invalid JSON") from None

    def mcp(self, method: str, params: dict[str, Any]) -> Any:
        result = self.call("POST", "mcp/", rpc=True, body={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": self.mcp_version, "capabilities": {}, "clientInfo": {"name": "redtrace-ctfy-skill", "version": "1"}}})
        self.mcp_version = result["protocolVersion"]
        self.call("POST", "mcp/", rpc=True, body={"jsonrpc": "2.0", "method": "notifications/initialized"})
        return self.call("POST", "mcp/", rpc=True, body={"jsonrpc": "2.0", "id": 2, "method": method, "params": params})

    def competition(self) -> str:
        explicit = os.environ.get("CTFY_COMPETITION_ID", "").strip()
        if explicit:
            return field_id(explicit)
        data = self.call("GET", "competitions")
        items = data.get("items", []) if isinstance(data, dict) else []
        candidates = [x for x in items if x.get("is_registered") and x.get("phase") != "past" and x.get("play_open", True)]
        if len(candidates) != 1:
            raise PlatformError("competition_ambiguous", "Use --competition or CTFY_COMPETITION_ID with the intended ID from `competitions`: expected one registered open competition; found " + str(len(candidates)))
        return field_id(candidates[0]["id"])


def cid(api: API, args: argparse.Namespace) -> str:
    supplied = getattr(args, "competition", "")
    return field_id(supplied) if supplied else api.competition()


def iid(value: str) -> str:
    return field_id(value)


def wait_ready(api: API, instance: str, timeout_s: float, interval: float) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_s
    while True:
        data = api.call("GET", f"instances/{iid(instance)}")
        if data.get("status") == "ready":
            return data
        if data.get("status") in ("error", "stopped"):
            raise PlatformError("instance_not_ready", {"status": data.get("status"), "error_code": data.get("error_code")})
        if time.monotonic() >= deadline:
            raise PlatformError("instance_wait_timeout", {"instance_id": instance, "last_status": data.get("status")})
        time.sleep(interval)


def tunnel_is_up() -> bool:
    if not shutil.which("wg"):
        return False
    r = subprocess.run(["wg", "show", "tpctf0"], capture_output=True, text=True, check=False)
    return r.returncode == 0


def vpn_setup(api: API, instance: str, sudo: bool = False) -> dict[str, Any]:
    info = api.call("GET", f"instances/{iid(instance)}")
    if info.get("status") != "ready":
        raise PlatformError("instance_not_ready", {"status": info.get("status")})
    if not info.get("vpn_endpoint"):
        raise PlatformError("vpn_info_missing", "This instance has no vpn_endpoint; inspect network_topology/services before proceeding")
    if not shutil.which("wg-quick"):
        raise PlatformError("missing_wireguard", "Install wg-quick and wg in the SAME network namespace as RedTrace's execution tools")
    if tunnel_is_up():
        old = load_vpn_state()
        if old.get("instance_id") == instance:
            return {"ok": True, "vpn": "already_up", "interface": "tpctf0", "instance_id": instance}
        raise PlatformError("another_vpn_active", "tpctf0 is already connected; disconnect current instance before replacing it")
    # The official doc states the config URL is GET /instances/{id}/vpn-config with Bearer.
    config = api.call("GET", f"instances/{iid(instance)}/vpn-config", binary=True)
    if not config or b"[Interface]" not in config:
        raise PlatformError("invalid_vpn_config", "Platform did not return a WireGuard config")
    config_path, meta_path = vpn_paths()
    save_private(config_path, config)
    cmd = (["sudo", "-n"] if sudo else []) + ["wg-quick", "up", str(config_path)]
    p = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if p.returncode:
        raise PlatformError("vpn_up_failed", "wg-quick up failed (check privileges, routes and interface): " + p.stderr[-600:])
    save_private(meta_path, json.dumps({"instance_id": instance, "interface": "tpctf0"}).encode())
    return {"ok": True, "vpn": "up", "interface": "tpctf0", "instance_id": instance, "targets": info.get("entry_urls", []), "services": info.get("services", [])}


def vpn_down(sudo: bool = False, expected_instance: str | None = None) -> dict[str, Any]:
    config_path, meta_path = vpn_paths()
    old = load_vpn_state()
    if expected_instance and old.get("instance_id") != expected_instance:
        raise PlatformError("vpn_owner_mismatch", "The local VPN metadata does not belong to the requested instance")
    if not config_path.exists() and not tunnel_is_up():
        return {"ok": True, "vpn": "not_configured"}
    if tunnel_is_up():
        cmd = (["sudo", "-n"] if sudo else []) + ["wg-quick", "down", str(config_path)]
        p = subprocess.run(cmd, capture_output=True, text=True, check=False)
        if p.returncode:
            raise PlatformError("vpn_down_failed", p.stderr[-600:])
    config_path.unlink(missing_ok=True)
    meta_path.unlink(missing_ok=True)
    return {"ok": True, "vpn": "down"}


def require_archive(filename: str) -> pathlib.Path:
    p = pathlib.Path(filename)
    if not (p.name.endswith(".tar.gz") or p.name.endswith(".zip")):
        raise PlatformError("archive_extension", "Expected a .tar.gz or .zip challenge archive")
    return p


def run(args: argparse.Namespace) -> Any:
    if args.command == "doctor":
        play = bool(os.environ.get("CTFY_PLAY_TOKEN", "").strip() or os.environ.get("CTFY_TOKEN", "").strip())
        author = bool(os.environ.get("CTFY_AUTHOR_TOKEN", "").strip() or os.environ.get("CTFY_TOKEN", "").strip())
        status = {"ok": play, "play_token_configured": play, "author_token_configured": author, "competition_id_configured": bool(os.environ.get("CTFY_COMPETITION_ID")), "python": sys.version.split()[0], "wg_quick_available": bool(shutil.which("wg-quick")), "wg_available": bool(shutil.which("wg")), "vpn_active": tunnel_is_up()}
        if args.online:
            try:
                c = API().call("GET", "competitions")
                status["platform_api_reachable"] = True
                status["visible_competitions"] = len(c.get("items", []))
            except PlatformError as exc:
                status["ok"] = False
                status["platform_api_reachable"] = False
                status["platform_error"] = {"code": exc.code, "detail": exc.detail}
        return status
    api = API()
    cmd = args.command
    if cmd == "mcp":
        if args.mcp_action == "tools":
            return api.mcp("tools/list", {})
        arguments = json.load(sys.stdin) if args.arguments_stdin else json.loads(args.arguments)
        if not isinstance(arguments, dict):
            raise PlatformError("invalid_arguments", "MCP arguments must be a JSON object")
        return api.mcp("tools/call", {"name": args.tool, "arguments": arguments})
    if cmd == "competitions":
        response = api.call("GET", "competitions")
        if args.registered:
            response["items"] = [x for x in response.get("items", []) if x.get("is_registered")]
        return response
    if cmd == "challenges":
        response = api.call("GET", f"competitions/{cid(api,args)}/challenges", query={"limit": args.limit, "offset": args.offset})
        if args.unsolved:
            response["items"] = [x for x in response.get("items", []) if not x.get("my_team_fully_solved") and not x.get("closed") and x.get("scoring") != "closed" and not x.get("my_team_authored")]
        return response
    if cmd == "detail":
        return api.call("GET", f"challenges/{field_id(args.challenge)}", query={"competition_id": cid(api,args)})
    if cmd == "start":
        result = api.call("POST", "instances", body={"competition_id": cid(api,args), "challenge_id": field_id(args.challenge)})
        if args.wait:
            result = wait_ready(api, result["id"], args.timeout, args.interval)
        return result
    if cmd == "status":
        return wait_ready(api, args.instance, args.timeout, args.interval) if args.wait else api.call("GET", f"instances/{iid(args.instance)}")
    if cmd == "submit":
        if args.answer_stdin:
            answer = sys.stdin.readline().rstrip("\r\n")
        elif args.answer_file:
            answer = pathlib.Path(args.answer_file).read_text(encoding="utf-8").strip()
        else:
            answer = args.answer
        if not answer:
            raise PlatformError("missing_answer", "Specify --answer, --answer-file, or --answer-stdin")
        info = api.call("GET", f"instances/{iid(args.instance)}")
        q = next((q for q in info.get("questions", []) if q.get("id") == args.question), None)
        if q is None:
            raise PlatformError("unknown_question", "Question not found in current instance")
        if not q.get("unlocked") or q.get("answered_correctly"):
            raise PlatformError("question_not_submittable", "Question is locked or already solved")
        remaining = q.get("attempts_remaining")
        if remaining is not None and remaining <= 0:
            raise PlatformError("question_attempt_cap_exceeded", "No wrong submissions remaining")
        return api.call("POST", "submissions", body={"instance_id": iid(args.instance), "question_id": args.question, "answer": answer})
    if cmd == "close":
        return api.call("DELETE", f"instances/{iid(args.instance)}", query={"competition_id": cid(api,args)})
    if cmd == "scoreboard":
        return api.call("GET", f"competitions/{cid(api,args)}/scoreboard", query={"limit": args.limit, "offset": args.offset})
    if cmd == "vpn":
        if args.vpn_action == "up":
            return vpn_setup(api, args.instance, sudo=args.sudo)
        if args.vpn_action == "down":
            return vpn_down(sudo=args.sudo, expected_instance=args.instance)
        config_path, _ = vpn_paths()
        return {"ok": True, "interface": "tpctf0", "active": tunnel_is_up(), "instance_id": load_vpn_state().get("instance_id"), "config_exists": config_path.exists()}
    if cmd == "author":
        contest = cid(api,args)
        kind = args.author_action
        base = f"competitions/{contest}"
        if kind == "topics":
            return api.call("GET", f"{base}/topics", token_kind="author")
        if kind == "quota":
            return api.call("GET", f"{base}/authoring/quota", token_kind="author")
        if kind == "template":
            result = api.call("GET", "authoring/template", token_kind="author", query={"competition_id": contest, "category": args.category, "stack": args.stack}, binary=True)
            location = pathlib.Path(args.output)
            save_private(location, result)
            return {"ok": True, "saved": str(location), "bytes": len(result)}
        if kind == "list":
            return api.call("GET", f"{base}/authored-challenges", token_kind="author")
        if kind == "audit":
            return api.call("GET", f"{base}/authored-challenges/{field_id(args.challenge)}/audit", token_kind="author")
        if kind == "upload":
            fields = {"slug": args.slug}
            for key in ("license", "provenance", "ai_assisted", "source_url", "accepted_terms_version", "credit", "note", "replaces"):
                value = getattr(args, key, None)
                if value is not None:
                    fields[key] = value
            return api.call("POST", f"{base}/authored-challenges", token_kind="author", multipart=(fields, require_archive(args.archive)))
        if kind == "revise":
            return api.call("POST", f"{base}/authored-challenges/{field_id(args.challenge)}/revisions", token_kind="author", multipart=({"note": args.note or ""}, require_archive(args.archive)))
    raise PlatformError("unsupported_command", cmd)


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="CTFy platform CLI for RedTrace; returns JSON. No Python packages required.")
    sub = p.add_subparsers(dest="command", required=True)
    d = sub.add_parser("doctor", help="Check local prerequisites; optional API connectivity")
    d.add_argument("--online", action="store_true")
    m = sub.add_parser("mcp", help="Use the platform's current MCP tools and schemas")
    ms = m.add_subparsers(dest="mcp_action", required=True)
    ms.add_parser("tools")
    mc = ms.add_parser("call")
    mc.add_argument("tool")
    mg = mc.add_mutually_exclusive_group()
    mg.add_argument("--arguments", default="{}", help="JSON object; use stdin for secrets")
    mg.add_argument("--arguments-stdin", action="store_true")
    c = sub.add_parser("competitions")
    c.add_argument("--registered", action="store_true")
    for name in ("challenges", "detail", "start", "close", "scoreboard"):
        q = sub.add_parser(name)
        q.add_argument("--competition", help="Override CTFY_COMPETITION_ID")
        if name in ("detail", "start"):
            q.add_argument("challenge")
        elif name == "close":
            q.add_argument("instance")
        if name in ("challenges", "scoreboard"):
            q.add_argument("--limit", type=int, default=1000)
            q.add_argument("--offset", type=int, default=0)
        if name == "challenges":
            q.add_argument("--unsolved", action="store_true")
        if name == "start":
            q.add_argument("--wait", action="store_true")
            q.add_argument("--timeout", type=float, default=180)
            q.add_argument("--interval", type=float, default=3)
    s = sub.add_parser("status")
    s.add_argument("instance")
    s.add_argument("--wait", action="store_true")
    s.add_argument("--timeout", type=float, default=180)
    s.add_argument("--interval", type=float, default=3)
    s = sub.add_parser("submit")
    s.add_argument("instance")
    s.add_argument("--question", required=True)
    g = s.add_mutually_exclusive_group(required=True)
    g.add_argument("--answer")
    g.add_argument("--answer-file")
    g.add_argument("--answer-stdin", action="store_true")
    v = sub.add_parser("vpn")
    vsub = v.add_subparsers(dest="vpn_action", required=True)
    up = vsub.add_parser("up")
    up.add_argument("instance")
    up.add_argument("--sudo", action="store_true", help="Use sudo -n without interactive password")
    down = vsub.add_parser("down")
    down.add_argument("--instance", help="Only disconnect if bound to this instance")
    down.add_argument("--sudo", action="store_true")
    vsub.add_parser("status")
    a = sub.add_parser("author")
    a.add_argument("--competition")
    asub = a.add_subparsers(dest="author_action", required=True)
    for name in ("topics", "quota", "list"):
        asub.add_parser(name)
    t = asub.add_parser("template")
    t.add_argument("--category", choices=("web", "pwn"), default="web")
    t.add_argument("--stack", help="Web requires go/python-flask/node-express/ruby-sinatra/php-apache")
    t.add_argument("--output", required=True)
    z = asub.add_parser("audit")
    z.add_argument("challenge")
    u = asub.add_parser("upload")
    u.add_argument("archive")
    u.add_argument("--slug", required=True)
    for key in ("license", "provenance", "ai_assisted", "source_url", "accepted_terms_version", "credit", "note", "replaces"):
        u.add_argument("--" + key.replace("_", "-"))
    r = asub.add_parser("revise")
    r.add_argument("challenge")
    r.add_argument("archive")
    r.add_argument("--note")
    return p


def main() -> int:
    try:
        payload = run(parser().parse_args())
        out(payload)
        return 1 if isinstance(payload, dict) and payload.get("ok") is False else 0
    except PlatformError as exc:
        return err(exc.code, exc.detail, exc.status)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        return err("local_error", str(exc))


if __name__ == "__main__":
    raise SystemExit(main())
