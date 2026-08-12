#!/usr/bin/env python3
"""Dependency-free project resource client shared by Claude Code, Codex, and Pi."""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _json_object(value: str, label: str) -> dict[str, Any]:
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as exc:
        raise argparse.ArgumentTypeError(
            f"{label} must be valid JSON: {exc.msg}"
        ) from exc
    if not isinstance(parsed, dict):
        raise argparse.ArgumentTypeError(f"{label} must be a JSON object")
    return parsed


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="redtrace-resource",
        description=(
            "Discover and use globally shared WebShell, C2, proxy, file, credential, "
            "plugin, and result resources without exposing stored secrets."
        ),
    )
    parser.add_argument(
        "--server", default=_env("REDTRACE_SERVER"), help="RedTrace server URL"
    )
    parser.add_argument(
        "--project",
        default=_env("REDTRACE_PROJECT_ID"),
        help="Current source project for attribution only; resources remain global",
    )
    parser.add_argument(
        "--worker", default=_env("REDTRACE_WORKER", "unknown"), help="Worker identity"
    )
    parser.add_argument(
        "--task", default=_env("REDTRACE_TASK_TYPE", "unknown"), help="Worker task type"
    )
    parser.add_argument(
        "--intent", default=_env("REDTRACE_INTENT_ID"), help="Current Intent ID"
    )
    parser.add_argument(
        "--timeout", type=float, default=10.0, help="HTTP timeout in seconds"
    )
    parser.add_argument("--compact", action="store_true", help="Emit compact JSON")
    commands = parser.add_subparsers(dest="command", required=True)

    commands.add_parser(
        "capabilities", help="Show resource kinds and on-demand workflow"
    )

    snapshot = commands.add_parser(
        "snapshot",
        help="Read a bounded current resource snapshot and an audit cursor in one request",
    )
    snapshot.add_argument(
        "--kind",
        action="append",
        choices=[
            "webshell",
            "c2_listener",
            "c2_session",
            "c2_payload",
            "c2_profile",
            "proxy",
            "file",
            "credential_ref",
            "plugin",
            "result",
        ],
        help="Repeat to select resource kinds; defaults to all kinds",
    )
    snapshot.add_argument(
        "--limit", type=int, default=100, choices=range(1, 501), metavar="1..500"
    )

    changes = commands.add_parser(
        "changes",
        help="Read resource changes after a snapshot audit cursor",
    )
    changes.add_argument(
        "--since",
        type=int,
        required=True,
        help="Audit cursor returned by snapshot or changes",
    )
    changes.add_argument(
        "--limit", type=int, default=100, choices=range(1, 501), metavar="1..500"
    )

    list_cmd = commands.add_parser("list", help="List shared resources")
    list_cmd.add_argument("--kind")
    list_cmd.add_argument("--status")
    list_cmd.add_argument("--query", default="")
    list_cmd.add_argument(
        "--limit", type=int, default=100, choices=range(1, 501), metavar="1..500"
    )

    get_cmd = commands.add_parser(
        "get", help="Read one resource, recent tasks, and audit"
    )
    get_cmd.add_argument("resource_id")

    lock = commands.add_parser("lock", help="Exclusively claim a shared resource")
    lock.add_argument("resource_id")
    unlock = commands.add_parser(
        "unlock", help="Release a resource claimed by this Worker"
    )
    unlock.add_argument("resource_id")

    register = commands.add_parser(
        "register",
        help="Register a resource. Secret JSON is read from stdin and is never echoed.",
    )
    register.add_argument(
        "--kind",
        required=True,
        choices=[
            "webshell",
            "c2_listener",
            "c2_payload",
            "c2_profile",
            "proxy",
            "file",
            "credential_ref",
            "plugin",
        ],
    )
    register.add_argument("--name", required=True)
    register.add_argument("--target", default="")
    register.add_argument("--summary", default="")
    register.add_argument("--status", default="available")
    register.add_argument("--metadata-json", default="{}")
    register.add_argument("--secret-stdin", action="store_true")
    register.add_argument("--parent")
    register.add_argument("--no-fact", action="store_true")

    webshell_create = commands.add_parser(
        "webshell-create",
        help="Create a reusable WebShell resource; optionally read its password from stdin",
    )
    webshell_create.add_argument("--name", required=True)
    webshell_create.add_argument("--target", required=True)
    webshell_create.add_argument("--summary", default="")
    webshell_create.add_argument(
        "--shell-type", default="php", choices=["php", "asp", "aspx", "jsp", "custom"]
    )
    webshell_create.add_argument(
        "--protocol", default="auto", choices=["auto", "eval", "antsword", "raw"]
    )
    webshell_create.add_argument("--method", default="POST", choices=["POST", "GET"])
    webshell_create.add_argument("--command-param", default="cmd")
    webshell_create.add_argument("--password-param", default="")
    webshell_create.add_argument(
        "--target-os", default="auto", choices=["auto", "linux", "windows"]
    )
    webshell_create.add_argument(
        "--encoding", default="auto", choices=["auto", "utf-8", "gbk", "gb18030"]
    )
    webshell_create.add_argument("--verify-tls", action="store_true")
    webshell_create.add_argument("--password-stdin", action="store_true")
    webshell_create.add_argument("--no-fact", action="store_true")

    listener_create = commands.add_parser(
        "listener-create",
        help="Create and enable a C2 Listener that can receive Sessions",
    )
    listener_create.add_argument("--name", required=True)
    listener_create.add_argument(
        "--listener-type",
        default="http_beacon",
        choices=["http_beacon", "https_beacon", "tcp_reverse", "tcp_bind", "websocket", "msf", "sliver", "cobalt_strike", "custom"],
    )
    listener_create.add_argument("--bind-host", default="0.0.0.0")
    listener_create.add_argument(
        "--bind-port",
        type=int,
        required=True,
        choices=range(1, 65536),
        metavar="1..65535",
    )
    listener_create.add_argument("--callback-host", default="")
    listener_create.add_argument("--target-host", default="")
    listener_create.add_argument("--adapter-endpoint", default="")
    listener_create.add_argument("--token-stdin", action="store_true")
    listener_create.add_argument("--profile")
    listener_create.add_argument("--summary", default="")
    listener_create.add_argument(
        "--status", default="available", choices=["available", "offline"]
    )
    listener_create.add_argument("--no-fact", action="store_true")

    payload_kinds = commands.add_parser(
        "payload-kinds",
        help="List Payload kinds compatible with a Listener",
    )
    payload_kinds.add_argument("listener_id")

    payload_oneliner = commands.add_parser(
        "payload-oneliner",
        help="Generate an executable one-line Payload for a Listener",
    )
    payload_oneliner.add_argument("listener_id")
    payload_oneliner.add_argument("kind")
    payload_oneliner.add_argument("--callback-host", default="")

    payload_build = commands.add_parser(
        "payload-build",
        help="Build a compiled Beacon Payload for a Listener",
    )
    payload_build.add_argument("listener_id")
    payload_build.add_argument("--callback-url", default="")
    payload_build.add_argument(
        "--os", default="linux", choices=["linux", "windows", "darwin"]
    )

    payload_external = commands.add_parser(
        "payload-external",
        help="Ask an MSF, Sliver, Cobalt Strike, or custom adapter to generate a compatible payload",
    )
    payload_external.add_argument("listener_id")
    payload_external.add_argument("--format", default="default")
    payload_external.add_argument("--options-json", default="{}")

    session_register = commands.add_parser(
        "session-register",
        help="Register any obtained shell (SSH, WinRM, PsExec, WMI, reverse, bind, or custom) in the global C2 session hub",
    )
    session_register.add_argument("--name", required=True)
    session_register.add_argument("--target", required=True)
    session_register.add_argument(
        "--shell-type",
        required=True,
        choices=[
            "ssh", "evil_winrm", "psexec", "wmi", "reverse_shell", "bind_shell",
            "meterpreter", "msf", "sliver", "cobalt_strike", "beacon", "custom",
        ],
    )
    session_register.add_argument(
        "--connection-type",
        default="direct",
        choices=["direct", "reverse", "bind", "external_c2"],
    )
    session_register.add_argument("--listener")
    session_register.add_argument("--credential")
    session_register.add_argument("--summary", default="")
    session_register.add_argument("--metadata-json", default="{}")
    session_register.add_argument("--secret-stdin", action="store_true")
    session_register.add_argument("--no-fact", action="store_true")

    credential_create = commands.add_parser(
        "credential-create",
        help="Store a discovered host, web, database, cloud, or Active Directory credential without echoing its secret",
    )
    credential_create.add_argument("--name", required=True)
    credential_create.add_argument("--target", default="")
    credential_create.add_argument(
        "--credential-type",
        required=True,
        choices=["host", "web", "database", "active_directory", "cloud", "ssh_key", "token", "certificate", "hash", "ticket", "custom"],
    )
    credential_create.add_argument("--username", default="")
    credential_create.add_argument("--domain", default="")
    credential_create.add_argument("--summary", default="")
    credential_create.add_argument("--metadata-json", default="{}")
    credential_create.add_argument("--secret-stdin", action="store_true")
    credential_create.add_argument("--no-fact", action="store_true")

    payload_import = commands.add_parser(
        "payload-import",
        help="Register a worker-generated or external C2 payload artifact/reference",
    )
    payload_import.add_argument("--name", required=True)
    payload_import.add_argument("--target", required=True)
    payload_import.add_argument("--format", default="custom")
    payload_import.add_argument("--framework", default="custom")
    payload_import.add_argument("--listener")
    payload_import.add_argument("--summary", default="")
    payload_import.add_argument("--metadata-json", default="{}")
    payload_import.add_argument("--secret-stdin", action="store_true")
    payload_import.add_argument("--no-fact", action="store_true")
    payload_build.add_argument(
        "--arch", default="amd64", choices=["amd64", "arm64", "386"]
    )
    payload_build.add_argument(
        "--sleep-seconds",
        type=int,
        default=5,
        choices=range(1, 3601),
        metavar="1..3600",
    )

    run = commands.add_parser("run", help="Queue an operation against a resource")
    run.add_argument("resource_id")
    run.add_argument("action")
    run.add_argument("--arguments-json", default="{}")
    run.add_argument("--command-text", help="Convenience value for arguments.command")
    run.add_argument(
        "--risk", default="low", choices=["low", "medium", "high", "critical"]
    )
    run.add_argument("--require-approval", action="store_true")
    run.add_argument("--publish-result", action="store_true")
    run.add_argument(
        "--wait",
        action="store_true",
        help="Wait for the operation to reach a terminal state",
    )
    run.add_argument("--wait-timeout", type=float, default=30.0)
    run.add_argument("--poll-interval", type=float, default=0.2)

    tasks = commands.add_parser("tasks", help="List project operation tasks")
    tasks.add_argument("--resource")
    tasks.add_argument("--status")
    tasks.add_argument(
        "--limit", type=int, default=100, choices=range(1, 501), metavar="1..500"
    )

    result = commands.add_parser(
        "result", help="Read a full result by its result reference ID"
    )
    result.add_argument("result_id")
    return parser


def _headers(args: argparse.Namespace, *, json_body: bool = False) -> dict[str, str]:
    headers = {
        "Accept": "application/json, text/plain",
        "User-Agent": "redtrace-resource/1",
        "X-RedTrace-Worker": args.worker or "unknown",
        "X-RedTrace-Task": args.task or "unknown",
    }
    if args.intent:
        headers["X-RedTrace-Intent"] = args.intent
    if json_body:
        headers["Content-Type"] = "application/json"
    return headers


def _request(
    args: argparse.Namespace,
    method: str,
    path: str,
    *,
    params: dict[str, Any] | None = None,
    body: dict[str, Any] | None = None,
) -> Any:
    url = f"{args.server.rstrip('/')}{path}"
    if params:
        clean = {key: value for key, value in params.items() if value not in (None, "")}
        if clean:
            url += "?" + urlencode(clean)
    payload = (
        json.dumps(body, ensure_ascii=False).encode("utf-8")
        if body is not None
        else None
    )
    request = Request(
        url,
        data=payload,
        headers=_headers(args, json_body=body is not None),
        method=method,
    )
    with urlopen(request, timeout=args.timeout) as response:
        raw = response.read()
        content_type = response.headers.get("Content-Type", "")
        if "application/json" in content_type:
            return json.loads(raw.decode("utf-8"))
        return raw.decode("utf-8", errors="replace")


def _perform(args: argparse.Namespace) -> Any:
    project = quote(args.project, safe="")
    base = f"/projects/{project}"
    if args.command == "capabilities":
        return {
            "kinds": {
                "webshell": [
                    "probe",
                    "command",
                    "list_files",
                    "read_file",
                    "write_file",
                    "delete_file",
                ],
                "c2_listener": [
                    "worker create/enable reverse, bind, Beacon, external, or custom listeners; receive global Sessions"
                ],
                "c2_session": ["command and plugin-defined agent actions"],
                "c2_payload": [
                    "worker generate from a Listener and deploy through an execution channel"
                ],
                "c2_profile": [],
                "plugin": ["actions declared in resource.metadata.actions"],
                "proxy": [],
                "file": [],
                "credential_ref": ["store host, web, database, cloud, token, certificate, hash, ticket, and Active Directory credentials"],
                "result": [],
            },
            "workflow": [
                "snapshot globally shared access kinds once and retain its audit_cursor",
                "reuse an existing WebShell or C2 Session before creating a duplicate",
                "if no Session exists, create a Listener and generate a Payload instead of stopping",
                "register every obtained direct, reverse, bind, or external C2 shell with session-register",
                "register every discovered credential with credential-create and keep the secret on stdin",
                "register worker-generated and AV-evasive payloads with payload-import",
                "create WebShell resources with webshell-create and use them with run --wait",
                "before declaring no access channel, call changes once with the retained audit_cursor",
                "get the selected resource to inspect bounded metadata and declared actions",
                "run an action by resource ID; stored secrets stay server-side",
                "use --publish-result only for a result that should become a blackboard Fact reference",
                "do not poll changes at a fixed frequency",
            ],
        }
    if args.command == "snapshot":
        return _request(
            args,
            "GET",
            f"{base}/operations/snapshot",
            params={"kinds": ",".join(args.kind or ()), "limit": args.limit},
        )
    if args.command == "changes":
        return _request(
            args,
            "GET",
            f"{base}/operations/audit",
            params={"since": args.since, "limit": args.limit, "order": "asc"},
        )
    if args.command == "list":
        return _request(
            args,
            "GET",
            f"{base}/resources",
            params={
                "kind": args.kind,
                "status": args.status,
                "q": args.query,
                "limit": args.limit,
            },
        )
    if args.command == "get":
        rid = quote(args.resource_id, safe="")
        return _request(args, "GET", f"{base}/resources/{rid}")
    if args.command in {"lock", "unlock"}:
        rid = quote(args.resource_id, safe="")
        return _request(
            args,
            "POST",
            f"{base}/resources/{rid}/{args.command}",
            body={"actor_type": "worker", "actor": args.worker},
        )
    if args.command == "register":
        metadata = _json_object(args.metadata_json, "--metadata-json")
        secret: dict[str, Any] = {}
        if args.secret_stdin:
            secret = _json_object(sys.stdin.read(), "stdin secret")
        return _request(
            args,
            "POST",
            f"{base}/resources",
            body={
                "kind": args.kind,
                "name": args.name,
                "target": args.target,
                "summary": args.summary,
                "status": args.status,
                "metadata": metadata,
                "secret": secret,
                "actor_type": "worker",
                "actor": args.worker,
                "worker": args.worker,
                "intent_id": args.intent or None,
                "parent_resource_id": args.parent,
                "publish_fact": not args.no_fact,
            },
        )
    if args.command == "webshell-create":
        password = sys.stdin.read().rstrip("\r\n") if args.password_stdin else ""
        return _request(
            args,
            "POST",
            f"{base}/resources",
            body={
                "kind": "webshell",
                "name": args.name,
                "target": args.target,
                "summary": args.summary,
                "status": "available",
                "metadata": {
                    "shell_type": args.shell_type,
                    "protocol": args.protocol,
                    "method": args.method,
                    "command_param": args.command_param,
                    "password_param": args.password_param,
                    "os": args.target_os,
                    "encoding": args.encoding,
                    "verify_tls": args.verify_tls,
                },
                "secret": {"password": password} if password else {},
                "actor_type": "worker",
                "actor": args.worker,
                "worker": args.worker,
                "intent_id": args.intent or None,
                "publish_fact": not args.no_fact,
            },
        )
    if args.command == "listener-create":
        adapter_token = sys.stdin.read().rstrip("\r\n") if args.token_stdin else ""
        return _request(
            args,
            "POST",
            f"{base}/resources",
            body={
                "kind": "c2_listener",
                "name": args.name,
                "target": f"{args.bind_host}:{args.bind_port}",
                "summary": args.summary,
                "status": args.status,
                "metadata": {
                    "listener_type": args.listener_type,
                    "bind_host": args.bind_host,
                    "bind_port": args.bind_port,
                    "callback_host": args.callback_host,
                    **({"target_host": args.target_host} if args.target_host else {}),
                    **({"adapter_endpoint": args.adapter_endpoint} if args.adapter_endpoint else {}),
                    "profile_id": args.profile or "",
                },
                **(
                    {"secret": {
                        "adapter_endpoint": args.adapter_endpoint,
                        **({"token": adapter_token} if adapter_token else {}),
                    }}
                    if args.adapter_endpoint else {}
                ),
                "actor_type": "worker",
                "actor": args.worker,
                "worker": args.worker,
                "intent_id": args.intent or None,
                "publish_fact": not args.no_fact,
            },
        )
    if args.command == "session-register":
        metadata = _json_object(args.metadata_json, "--metadata-json")
        metadata.update({"shell_type": args.shell_type, "connection_type": args.connection_type})
        if args.credential:
            metadata["credential_id"] = args.credential
        secret = _json_object(sys.stdin.read(), "stdin secret") if args.secret_stdin else {}
        return _request(args, "POST", f"{base}/resources", body={
            "kind": "c2_session", "name": args.name, "target": args.target,
            "summary": args.summary, "status": "available", "metadata": metadata,
            "secret": secret, "actor_type": "worker", "actor": args.worker,
            "worker": args.worker, "intent_id": args.intent or None,
            "parent_resource_id": args.listener, "publish_fact": not args.no_fact,
        })
    if args.command == "credential-create":
        metadata = _json_object(args.metadata_json, "--metadata-json")
        metadata.update({"credential_type": args.credential_type, "username": args.username, "domain": args.domain})
        secret = _json_object(sys.stdin.read(), "stdin secret") if args.secret_stdin else {}
        return _request(args, "POST", f"{base}/resources", body={
            "kind": "credential_ref", "name": args.name, "target": args.target,
            "summary": args.summary, "metadata": metadata, "secret": secret,
            "actor_type": "worker", "actor": args.worker, "worker": args.worker,
            "intent_id": args.intent or None, "publish_fact": not args.no_fact,
        })
    if args.command == "payload-import":
        metadata = _json_object(args.metadata_json, "--metadata-json")
        metadata.update({"format": args.format, "framework": args.framework, "custom": True})
        secret = _json_object(sys.stdin.read(), "stdin secret") if args.secret_stdin else {}
        return _request(args, "POST", f"{base}/resources", body={
            "kind": "c2_payload", "name": args.name, "target": args.target,
            "summary": args.summary, "metadata": metadata, "secret": secret,
            "actor_type": "worker", "actor": args.worker, "worker": args.worker,
            "intent_id": args.intent or None, "parent_resource_id": args.listener,
            "publish_fact": not args.no_fact,
        })
    if args.command == "payload-kinds":
        listener = quote(args.listener_id, safe="")
        return _request(args, "GET", f"{base}/c2/listeners/{listener}/oneliner-kinds")
    if args.command == "payload-oneliner":
        return _request(
            args,
            "POST",
            f"{base}/c2/payloads/oneliner",
            body={
                "listener_id": args.listener_id,
                "kind": args.kind,
                "callback_host": args.callback_host,
            },
        )
    if args.command == "payload-build":
        return _request(
            args,
            "POST",
            f"{base}/c2/payloads/build",
            body={
                "listener_id": args.listener_id,
                "callback_url": args.callback_url,
                "os": args.os,
                "arch": args.arch,
                "sleep_seconds": args.sleep_seconds,
                "actor": args.worker,
            },
        )
    if args.command == "payload-external":
        return _request(
            args,
            "POST",
            f"{base}/c2/payloads/external",
            body={
                "listener_id": args.listener_id,
                "format": args.format,
                "options": _json_object(args.options_json, "--options-json"),
                "actor": args.worker,
            },
        )
    if args.command == "run":
        rid = quote(args.resource_id, safe="")
        arguments = _json_object(args.arguments_json, "--arguments-json")
        if args.command_text is not None:
            arguments["command"] = args.command_text
        if args.publish_result:
            arguments["publish_result"] = True
        created = _request(
            args,
            "POST",
            f"{base}/resources/{rid}/tasks",
            body={
                "action": args.action,
                "arguments": arguments,
                "actor_type": "worker",
                "actor": args.worker,
                "risk": args.risk,
                "requires_approval": True if args.require_approval else None,
                "intent_id": args.intent or None,
            },
        )
        if not args.wait:
            return created
        task = created.get("task") if isinstance(created, dict) else None
        operation_id = str(task.get("id") or "") if isinstance(task, dict) else ""
        if not operation_id:
            raise ValueError("operation response did not include a task ID")
        deadline = time.monotonic() + max(0.1, args.wait_timeout)
        interval = max(0.05, args.poll_interval)
        while True:
            current = _request(
                args,
                "GET",
                f"{base}/operations/tasks/{quote(operation_id, safe='')}",
            )
            current_task = current.get("task") if isinstance(current, dict) else None
            if isinstance(current_task, dict) and current_task.get("status") in {
                "succeeded",
                "failed",
                "cancelled",
                "rejected",
            }:
                return current
            if time.monotonic() >= deadline:
                return {
                    "task": current_task or task,
                    "wait": {"timed_out": True, "timeout_seconds": args.wait_timeout},
                }
            time.sleep(interval)
    if args.command == "tasks":
        return _request(
            args,
            "GET",
            f"{base}/operations/tasks",
            params={
                "resource_id": args.resource,
                "status": args.status,
                "limit": args.limit,
            },
        )
    if args.command == "result":
        result = quote(args.result_id, safe="")
        return _request(args, "GET", f"{base}/operations/results/{result}")
    raise ValueError(f"unsupported command: {args.command}")


def _print(value: Any, compact: bool, stream: Any = sys.stdout) -> None:
    if isinstance(value, str):
        print(value, file=stream)
        return
    print(
        json.dumps(
            value,
            ensure_ascii=False,
            separators=(",", ":") if compact else None,
            indent=None if compact else 2,
        ),
        file=stream,
    )


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not args.server and args.command != "capabilities":
        parser.error("--server or REDTRACE_SERVER is required")
    if not args.project and args.command != "capabilities":
        parser.error("--project or REDTRACE_PROJECT_ID is required")
    try:
        result = _perform(args)
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        try:
            detail: Any = json.loads(body)
        except json.JSONDecodeError:
            detail = body
        _print(
            {"error": "http_error", "status": exc.code, "detail": detail},
            args.compact,
            sys.stderr,
        )
        return 2
    except (URLError, TimeoutError, OSError, ValueError) as exc:
        _print({"error": "request_error", "detail": str(exc)}, args.compact, sys.stderr)
        return 2
    _print(result, args.compact)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
