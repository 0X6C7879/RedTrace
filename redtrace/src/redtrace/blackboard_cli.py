#!/usr/bin/env python3
"""Small, dependency-free read-only client for RedTrace's shared blackboard."""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _default_revision() -> int:
    raw = _env("REDTRACE_BLACKBOARD_CURSOR", "0")
    try:
        return max(0, int(raw))
    except ValueError:
        return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="redtrace-blackboard",
        description="Read the current RedTrace blackboard on demand. This client never writes or polls.",
    )
    parser.add_argument("--server", default=_env("REDTRACE_SERVER"), help="RedTrace server URL")
    parser.add_argument("--project", default=_env("REDTRACE_PROJECT_ID"), help="RedTrace project ID")
    parser.add_argument("--worker", default=_env("REDTRACE_WORKER", "unknown"), help="Worker identity for audit")
    parser.add_argument("--task", default=_env("REDTRACE_TASK_TYPE", "unknown"), help="Task type for audit")
    parser.add_argument("--intent", default=_env("REDTRACE_INTENT_ID"), help="Current Intent ID for audit")
    parser.add_argument("--timeout", type=float, default=5.0, help="HTTP timeout in seconds")
    parser.add_argument("--compact", action="store_true", help="Emit compact JSON")
    subparsers = parser.add_subparsers(dest="command", required=True)

    status = subparsers.add_parser("status", help="Check whether the blackboard changed")
    status.add_argument("--since", type=int, default=_default_revision(), help="Known revision")

    subparsers.add_parser("snapshot", help="Read the complete current blackboard")

    changes = subparsers.add_parser("changes", help="Read content added after a revision")
    changes.add_argument("--since", type=int, default=_default_revision(), help="Known revision")
    changes.add_argument("--limit", type=int, default=20, choices=range(1, 101), metavar="1..100")

    node = subparsers.add_parser("node", help="Read one fact, intent, or hint")
    node.add_argument("node_id")

    path = subparsers.add_parser("path", help="Read the directed path between two graph nodes")
    path.add_argument("source")
    path.add_argument("target")

    context = subparsers.add_parser("context", help="Read a bounded neighborhood around one node")
    context.add_argument("node_id")
    context.add_argument("--depth", type=int, default=1, choices=range(0, 4), metavar="0..3")
    context.add_argument("--limit", type=int, default=30, choices=range(1, 51), metavar="1..50")
    return parser


def _request(args: argparse.Namespace) -> dict[str, Any]:
    project = quote(args.project, safe="")
    if args.command == "status":
        path = "status"
        params = {"since": args.since}
    elif args.command == "snapshot":
        path = "snapshot"
        params = {}
    elif args.command == "changes":
        path = "changes"
        params = {"since": args.since, "limit": args.limit}
    elif args.command == "node":
        path = f"nodes/{quote(args.node_id, safe='')}"
        params = {}
    elif args.command == "path":
        path = "path"
        params = {"source": args.source, "target": args.target}
    elif args.command == "context":
        path = f"context/{quote(args.node_id, safe='')}"
        params = {"depth": args.depth, "limit": args.limit}
    else:  # pragma: no cover - argparse enforces this
        raise ValueError(f"unsupported command: {args.command}")

    url = f"{args.server.rstrip('/')}/projects/{project}/blackboard/{path}"
    if params:
        url += "?" + urlencode(params)
    headers = {
        "Accept": "application/json",
        "User-Agent": "redtrace-blackboard/1",
        "X-RedTrace-Worker": args.worker or "unknown",
        "X-RedTrace-Task": args.task or "unknown",
    }
    if args.intent:
        headers["X-RedTrace-Intent"] = args.intent
    request = Request(url, headers=headers, method="GET")
    with urlopen(request, timeout=args.timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _print_json(value: dict[str, Any], *, compact: bool, stream: Any | None = None) -> None:
    if stream is None:
        stream = sys.stdout
    if compact:
        text = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    else:
        text = json.dumps(value, ensure_ascii=False, indent=2)
    print(text, file=stream)


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not args.server:
        parser.error("--server or REDTRACE_SERVER is required")
    if not args.project:
        parser.error("--project or REDTRACE_PROJECT_ID is required")
    try:
        result = _request(args)
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        try:
            detail: Any = json.loads(body)
        except json.JSONDecodeError:
            detail = body
        _print_json({"error": "http_error", "status": exc.code, "detail": detail}, compact=args.compact, stream=sys.stderr)
        return 2
    except (URLError, TimeoutError, OSError) as exc:
        _print_json({"error": "connection_error", "detail": str(exc)}, compact=args.compact, stream=sys.stderr)
        return 2
    _print_json(result, compact=args.compact)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
