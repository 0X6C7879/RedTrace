#!/usr/bin/env python3
"""Dependency-free CLI for the 西湖论剑 CTF Agent API."""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

API_PREFIX = "/slab-match/api/v1/agent"
SUCCESS_CODE = "00000"


class ApiError(RuntimeError):
    pass


def emit(obj: Any) -> None:
    print(json.dumps(obj, ensure_ascii=False, indent=2))


class Client:
    def __init__(self, host: str, access_key: str, request_timeout: float = 30.0):
        self.base = host.rstrip("/") + API_PREFIX
        self.access_key = access_key
        self.request_timeout = request_timeout

    def request(self, method: str, path: str, *, query: dict[str, Any] | None = None,
                body: dict[str, Any] | None = None) -> dict[str, Any]:
        url = self.base + path
        if query:
            url += "?" + urllib.parse.urlencode(query)
        headers = {
            "X-Agent-AccessKey": self.access_key,
            "Accept": "application/json",
        }
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.request_timeout) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", errors="replace")
            raise ApiError(f"HTTP {e.code} {e.reason}: {raw[:2000]}") from e
        except urllib.error.URLError as e:
            raise ApiError(f"request failed: {e.reason}") from e

        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as e:
            raise ApiError(f"non-JSON response: {raw[:2000]}") from e

        if not isinstance(payload, dict):
            raise ApiError(f"unexpected response type: {type(payload).__name__}")
        if str(payload.get("code")) != SUCCESS_CODE:
            raise ApiError(
                f"API error code={payload.get('code')!r} message={payload.get('message')!r}"
            )
        return payload

    def match_info(self):
        return self.request("GET", "/match/notice/match-info")

    def overview(self):
        return self.request("GET", "/answer-panel/overview")

    def exercises(self):
        return self.request("GET", "/ctf/exercise-list")

    def detail(self, exercise_id: int):
        return self.request("GET", "/ctf/exercise", query={"exerciseId": exercise_id})

    def build(self, exercise_id: int):
        return self.request("POST", "/ctf/build-exercise-env", body={"exerciseId": exercise_id})

    def recover(self, exercise_id: int):
        return self.request("POST", "/ctf/recover-exercise-env", body={"exerciseId": exercise_id})

    def submit(self, exercise_id: int, flag: str):
        if len(flag) > 256:
            raise ApiError("flag exceeds API limit of 256 characters")
        return self.request(
            "POST", "/answer-panel/answer", body={"exerciseId": exercise_id, "flag": flag}
        )

    def notices(self):
        return self.request("GET", "/match/notice/now-list")

    def notice(self, notice_id: int):
        return self.request("GET", "/match/notice/detail", query={"id": notice_id})


def require_config(args: argparse.Namespace) -> Client:
    host = args.host or os.environ.get("AI_AGENT_HOST") or os.environ.get("SLAB_MATCH_HOST")
    key = args.access_key or os.environ.get("AI_AGENT_ACCESS_KEY") or os.environ.get("SLAB_MATCH_ACCESS_KEY")
    if not host:
        raise ApiError("missing host: set AI_AGENT_HOST or pass --host")
    if not key:
        raise ApiError("missing AccessKey: set AI_AGENT_ACCESS_KEY or pass --access-key")
    return Client(host, key, request_timeout=args.request_timeout)


def ensure_env(client: Client, exercise_id: int, timeout: float, interval: float) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    built = False
    last: dict[str, Any] | None = None

    while True:
        last = client.detail(exercise_id)
        data = last.get("data") or {}
        if not isinstance(data, dict):
            raise ApiError("exercise detail data is not an object")

        if data.get("hasSolved"):
            return last

        if data.get("isNeedInit") and not built:
            client.build(exercise_id)
            built = True
        else:
            endpoints = data.get("endpoints")
            if data.get("isNeedCheck") is False and isinstance(endpoints, list) and endpoints:
                return last

        if time.monotonic() >= deadline:
            raise ApiError(
                f"environment not ready within {timeout:g}s "
                f"(isNeedInit={data.get('isNeedInit')!r}, "
                f"isNeedCheck={data.get('isNeedCheck')!r}, "
                f"endpoints={bool(data.get('endpoints'))})"
            )
        time.sleep(interval)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Slab Match AI Agent API CLI")
    p.add_argument("--host", help="server origin, e.g. https://example.com")
    p.add_argument("--access-key", help="Agent AccessKey (prefer environment variable)")
    p.add_argument("--request-timeout", type=float, default=30.0, help="HTTP request timeout in seconds")
    sub = p.add_subparsers(dest="command", required=True)

    sub.add_parser("match-info", help="get competition notes and rules")
    sub.add_parser("overview", help="get score and rank")
    sub.add_parser("exercises", help="list exercises")
    sub.add_parser("notices", help="list announcements")

    q = sub.add_parser("detail", help="get exercise details")
    q.add_argument("exercise_id", type=int)

    q = sub.add_parser("build", help="start exercise environment")
    q.add_argument("exercise_id", type=int)

    q = sub.add_parser("recover", help="recover exercise environment")
    q.add_argument("exercise_id", type=int)

    q = sub.add_parser("submit", help="submit a flag")
    q.add_argument("exercise_id", type=int)
    q.add_argument("flag")

    q = sub.add_parser("notice", help="get announcement details")
    q.add_argument("notice_id", type=int)

    q = sub.add_parser("ensure-env", help="initialize if needed and poll until endpoints are usable")
    q.add_argument("exercise_id", type=int)
    q.add_argument("--timeout", type=float, default=300.0, help="overall wait timeout in seconds")
    q.add_argument("--interval", type=float, default=3.0, help="poll interval in seconds")
    return p


def main() -> int:
    args = build_parser().parse_args()
    try:
        client = require_config(args)
        cmd = args.command
        if cmd == "match-info":
            out = client.match_info()
        elif cmd == "overview":
            out = client.overview()
        elif cmd == "exercises":
            out = client.exercises()
        elif cmd == "detail":
            out = client.detail(args.exercise_id)
        elif cmd == "build":
            out = client.build(args.exercise_id)
        elif cmd == "recover":
            out = client.recover(args.exercise_id)
        elif cmd == "submit":
            out = client.submit(args.exercise_id, args.flag)
        elif cmd == "notices":
            out = client.notices()
        elif cmd == "notice":
            out = client.notice(args.notice_id)
        elif cmd == "ensure-env":
            out = ensure_env(client, args.exercise_id, args.timeout, args.interval)
        else:
            raise ApiError(f"unsupported command: {cmd}")
        emit(out)
        return 0
    except ApiError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
