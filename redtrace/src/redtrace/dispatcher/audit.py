from __future__ import annotations

import json
import logging
import queue
import re
import threading
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from redtrace.dispatcher.config import WorkerConfig
from redtrace.dispatcher.protocol.client import CairnClient
from redtrace.dispatcher.runtime.process import ProcessResult


LOG = logging.getLogger(__name__)
MAX_INLINE_CONTENT = 32 * 1024
CRITICAL_KINDS = {"error", "run.completed", "tool.completed", "command.completed"}
SECRET_PATTERN = re.compile(
    r"(?i)(authorization|api[_-]?key|token|secret|password)(\s*[:=]\s*)([^\s,;]+)"
)


def utcnow() -> str:
    return datetime.now(UTC).isoformat()


class AuditPublisher:
    def __init__(
        self,
        client: CairnClient,
        project_id: str,
        intent_id: str | None,
        worker: WorkerConfig,
        phase: str,
        workspace_ref: str,
        prompt: str,
    ):
        self.run_id = uuid.uuid4().hex
        self._client = client
        self._sequence = 0
        self._queue: queue.Queue[dict[str, Any] | None] = queue.Queue(maxsize=2048)
        self._assistant_text = ""
        self._run = {
            "id": self.run_id,
            "project_id": project_id,
            "intent_id": intent_id,
            "task_type": phase.split("_", 1)[0],
            "phase": phase,
            "worker": worker.name,
            "provider": worker.type,
            "workspace_kind": "local" if Path(workspace_ref).is_absolute() else "container",
            "workspace_ref": workspace_ref,
            "workspace_root": workspace_ref
            if Path(workspace_ref).is_absolute()
            else "/home/kali/workspace",
            "status": "running",
            "started_at": utcnow(),
        }
        self._thread = threading.Thread(target=self._run_loop, daemon=True)
        self._thread.start()
        self.emit("run.started", title=phase)
        self.emit("user.message", role="user", content=prompt)

    def handle_output(self, channel: str, line: str) -> None:
        if channel != "stdout":
            return
        for event in normalize_event(self._run["provider"], line):
            if event["kind"] == "assistant.delta":
                self._assistant_text += str(event.get("content", ""))
            elif event["kind"] in {"tool.started", "command.started", "turn.completed"}:
                self._persist_assistant_message()
            self._emit(event)

    def finish(self, result: ProcessResult) -> None:
        self._persist_assistant_message()
        if result.stderr.strip():
            self.emit(
                "error" if result.returncode else "stderr",
                content=_limit(result.stderr.strip()),
            )
        self._run.update(
            {
                "status": "cancelled"
                if result.cancelled
                else "timed_out"
                if result.timed_out
                else "completed"
                if result.returncode == 0
                else "failed",
                "ended_at": utcnow(),
                "exit_code": result.returncode,
                "timed_out": result.timed_out,
                "cancelled": result.cancelled,
            }
        )
        self.emit(
            "run.completed",
            content=result.cancel_reason,
            exit_code=result.returncode,
            timed_out=result.timed_out,
            cancelled=result.cancelled,
        )

    def fail(self, exc: Exception) -> None:
        self._run.update({"status": "failed", "ended_at": utcnow()})
        self.emit("error", content=str(exc))
        self.emit("run.completed")

    def close(self) -> None:
        try:
            self._queue.put(None, timeout=0.1)
        except queue.Full:
            self._make_room()
            with suppress_queue_full():
                self._queue.put_nowait(None)
        self._thread.join(timeout=2)

    def emit(self, kind: str, **fields: Any) -> None:
        self._emit({"kind": kind, "timestamp": utcnow(), **fields})

    def _emit(self, event: dict[str, Any]) -> None:
        self._sequence += 1
        payload = _redact(
            {
                **event,
                "event_uid": uuid.uuid4().hex,
                "project_id": self._run["project_id"],
                "run_id": self.run_id,
                "run_sequence": self._sequence,
                "worker": self._run["worker"],
                "provider": self._run["provider"],
                "phase": self._run["phase"],
            }
        )
        try:
            self._queue.put_nowait(payload)
        except queue.Full:
            if payload["kind"] in CRITICAL_KINDS:
                self._make_room()
                with suppress_queue_full():
                    self._queue.put_nowait(payload)

    def _make_room(self) -> None:
        try:
            self._queue.get_nowait()
        except queue.Empty:
            pass

    def _persist_assistant_message(self) -> None:
        text = self._assistant_text.strip()
        if not text:
            return
        self._assistant_text = ""
        self.emit(
            "assistant.message",
            role="assistant",
            content=_limit(text),
            persist_only=True,
        )

    def _run_loop(self) -> None:
        batch: list[dict[str, Any]] = []
        deadline = time.monotonic() + 0.05
        while True:
            try:
                item = self._queue.get(timeout=max(0.0, deadline - time.monotonic()))
            except queue.Empty:
                item = ...
            if item is None:
                self._flush(batch)
                return
            if item is not ...:
                batch.append(item)
            if len(batch) >= 32 or time.monotonic() >= deadline:
                self._flush(batch)
                batch.clear()
                deadline = time.monotonic() + 0.05

    def _flush(self, batch: list[dict[str, Any]]) -> None:
        if not batch:
            return
        try:
            self._client.append_audit_events(self._run, batch)
        except Exception:
            LOG.debug("audit batch publish failed run=%s", self.run_id, exc_info=True)


class suppress_queue_full:
    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return exc_type is queue.Full


def normalize_event(provider: str, line: str) -> list[dict[str, Any]]:
    try:
        payload = json.loads(line)
    except json.JSONDecodeError:
        return []
    if not isinstance(payload, dict):
        return []
    timestamp = utcnow()
    if provider == "claudecode":
        return _normalize_claude(payload, timestamp)
    if provider == "codex":
        return _normalize_codex(payload, timestamp)
    if provider == "pi":
        return _normalize_pi(payload, timestamp)
    return []


def _normalize_claude(payload: dict[str, Any], timestamp: str) -> list[dict[str, Any]]:
    kind = payload.get("type")
    if kind == "system" and payload.get("subtype") == "init":
        return [_event("session.started", timestamp, session_id=payload.get("session_id"))]
    if kind == "stream_event":
        event = payload.get("event") or {}
        event_type = event.get("type")
        if event_type == "content_block_delta":
            delta = event.get("delta") or {}
            if delta.get("type") == "text_delta":
                return [_event("assistant.delta", timestamp, content=delta.get("text", ""))]
        if event_type == "content_block_start":
            block = event.get("content_block") or {}
            if block.get("type") == "tool_use":
                return [
                    _event(
                        "tool.started",
                        timestamp,
                        title=block.get("name"),
                        call_id=block.get("id"),
                        arguments=block.get("input"),
                    )
                ]
    if kind == "user":
        message = payload.get("message") or {}
        results = []
        for block in message.get("content") or []:
            if isinstance(block, dict) and block.get("type") == "tool_result":
                results.append(
                    _event(
                        "tool.completed",
                        timestamp,
                        call_id=block.get("tool_use_id"),
                        content=_limit(_content_text(block.get("content"))),
                        error=bool(block.get("is_error")),
                    )
                )
        return results
    if kind == "result":
        return [
            _event(
                "turn.completed",
                timestamp,
                session_id=payload.get("session_id"),
                usage=payload.get("usage"),
                cost_usd=payload.get("total_cost_usd"),
                error=payload.get("is_error", False),
            )
        ]
    return []


def _normalize_codex(payload: dict[str, Any], timestamp: str) -> list[dict[str, Any]]:
    event_type = payload.get("type")
    item = payload.get("item") or {}
    item_type = item.get("type")
    if event_type == "thread.started":
        return [_event("session.started", timestamp, session_id=payload.get("thread_id"))]
    if event_type == "turn.started":
        return [_event("turn.started", timestamp)]
    if event_type == "item.started" and item_type in {"command_execution", "mcp_tool_call"}:
        return [
            _event(
                "command.started" if item_type == "command_execution" else "tool.started",
                timestamp,
                title="Shell" if item_type == "command_execution" else item.get("tool"),
                call_id=item.get("id"),
                command=item.get("command"),
                arguments=item.get("arguments"),
            )
        ]
    if event_type == "item.completed":
        if item_type == "agent_message":
            return [
                _event(
                    "assistant.message",
                    timestamp,
                    role="assistant",
                    content=item.get("text", ""),
                    message_id=item.get("id"),
                )
            ]
        if item_type == "command_execution":
            return [
                _event(
                    "command.completed",
                    timestamp,
                    title="Shell",
                    call_id=item.get("id"),
                    command=item.get("command"),
                    content=_limit(item.get("aggregated_output", "")),
                    exit_code=item.get("exit_code"),
                )
            ]
        if item_type == "file_change":
            return [_event("file.changed", timestamp, changes=item.get("changes", []))]
        if item_type == "mcp_tool_call":
            return [
                _event(
                    "tool.completed",
                    timestamp,
                    title=item.get("tool"),
                    call_id=item.get("id"),
                    content=_limit(_content_text(item.get("result"))),
                    error=item.get("status") == "failed",
                )
            ]
    if event_type in {"turn.completed", "turn.failed"}:
        return [
            _event(
                "turn.completed" if event_type == "turn.completed" else "error",
                timestamp,
                usage=payload.get("usage"),
                content=_content_text(payload.get("error")),
            )
        ]
    return []


def _normalize_pi(payload: dict[str, Any], timestamp: str) -> list[dict[str, Any]]:
    event_type = payload.get("type")
    if event_type == "session":
        return [_event("session.started", timestamp, session_id=payload.get("id"))]
    if event_type == "message_update":
        update = payload.get("assistantMessageEvent") or {}
        if update.get("type") == "text_delta":
            return [_event("assistant.delta", timestamp, content=update.get("delta", ""))]
    if event_type == "tool_execution_start":
        return [
            _event(
                "tool.started",
                timestamp,
                title=payload.get("toolName"),
                arguments=payload.get("args"),
                call_id=payload.get("toolCallId"),
            )
        ]
    if event_type == "tool_execution_end":
        return [
            _event(
                "tool.completed",
                timestamp,
                title=payload.get("toolName"),
                content=_limit(_content_text(payload.get("result"))),
                error=payload.get("isError", False),
                call_id=payload.get("toolCallId"),
            )
        ]
    if event_type in {"turn_end", "agent_end"}:
        return [_event("turn.completed", timestamp)]
    return []


def _event(kind: str, timestamp: str, **fields: Any) -> dict[str, Any]:
    return {"kind": kind, "timestamp": timestamp, **fields}


def _content_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if value is None:
        return ""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _limit(value: str, limit: int = MAX_INLINE_CONTENT) -> str:
    if len(value) <= limit:
        return value
    return value[:limit] + "\n… output truncated for audit UI …"


def _redact(value: Any) -> Any:
    if isinstance(value, str):
        return SECRET_PATTERN.sub(r"\1\2[REDACTED]", value)
    if isinstance(value, list):
        return [_redact(item) for item in value]
    if isinstance(value, dict):
        return {
            key: "[REDACTED]"
            if re.search(r"(?i)(api[_-]?key|token|secret|password|authorization)", key)
            else _redact(item)
            for key, item in value.items()
        }
    return value
