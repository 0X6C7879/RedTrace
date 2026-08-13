from __future__ import annotations

import json
import logging
import queue
import re
import threading
import time
import uuid
from contextlib import suppress
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from redtrace.dispatcher.config import WorkerConfig
from redtrace.dispatcher.control_plane import ControlPlaneClient
from redtrace.dispatcher.runtime.process import ProcessResult
from redtrace.dispatcher.runtime.stream_buffer import TRUNCATED_STREAM_LINE

LOG = logging.getLogger(__name__)
ASSISTANT_MESSAGE_CHUNK = 32 * 1024
THINKING_MESSAGE_CHUNK = 32 * 1024
AUDIT_BATCH_SIZE = 128
AUDIT_FLUSH_INTERVAL_SECONDS = 0.25
CRITICAL_KINDS = {
    "error",
    "run.completed",
    "tool.completed",
    "command.completed",
    "skill.completed",
    "output.truncated",
}
ANSI_PATTERN = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")
MOJIBAKE_MARKERS = frozenset("ÃÂâ€™œž�ç¬åæèé")
SHELL_TOOL_NAMES = frozenset(
    {"bash", "sh", "shell", "powershell", "pwsh", "cmd", "command", "terminal", "exec"}
)
SKILL_TOOL_NAMES = frozenset({"skill", "skills", "load skill", "use skill"})
SKILL_PATH_PATTERN = re.compile(
    r"""(?i)(?:^|[\\/])(?P<name>[^\\/"'\s]+)[\\/]SKILL\.md(?=$|[\s"'`;|&)])"""
)


def utcnow() -> str:
    return datetime.now(UTC).isoformat()


class AuditPublisher:
    def __init__(
        self,
        client: ControlPlaneClient,
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
        self._assistant_parts: list[str] = []
        self._assistant_chars = 0
        self._thinking_parts: list[str] = []
        self._thinking_chars = 0
        self._tool_calls: dict[str, dict[str, Any]] = {}
        self._claude_tool_blocks: dict[int, dict[str, Any]] = {}
        self._pi_state: dict[str, Any] = {"thinking_streamed": False}
        self._run = {
            "id": self.run_id,
            "project_id": project_id,
            "intent_id": intent_id,
            "task_type": phase.split("_", 1)[0],
            "phase": phase,
            "worker": worker.name,
            "provider": worker.type,
            "workspace_kind": "local"
            if Path(workspace_ref).is_absolute()
            else "container",
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
        if line == TRUNCATED_STREAM_LINE:
            self.emit(
                "output.truncated",
                title=channel,
                content="oversized single Worker output record omitted from live audit",
            )
            return
        if channel != "stdout":
            return
        for event in normalize_event(
            self._run["provider"],
            line,
            claude_tool_state=self._claude_tool_blocks,
            pi_state=self._pi_state,
        ):
            event = _enrich_tool_event(event, self._tool_calls)
            kind = event["kind"]
            if kind == "assistant.delta":
                content = str(event.get("content", ""))
                self._assistant_parts.append(content)
                self._assistant_chars += len(content)
                if self._assistant_chars >= ASSISTANT_MESSAGE_CHUNK:
                    self._persist_assistant_message()
                # A visible text block always starts after the thinking block
                # ends, so any buffered thinking text is complete at this point.
                self._persist_thinking_message()
            elif kind == "thinking.delta":
                content = str(event.get("content", ""))
                self._thinking_parts.append(content)
                self._thinking_chars += len(content)
                if self._thinking_chars >= THINKING_MESSAGE_CHUNK:
                    self._persist_thinking_message()
            elif kind == "thinking.completed":
                fallback = str(event.pop("final_text", "") or "")
                self._persist_thinking_message(fallback_text=fallback)
            elif kind in {
                "tool.started",
                "command.started",
                "skill.started",
                "turn.completed",
            }:
                self._persist_assistant_message()
                self._persist_thinking_message()
            if event["kind"] in {"tool.started", "command.started", "skill.started"}:
                call_id = event.get("call_id")
                if isinstance(call_id, str) and call_id:
                    self._tool_calls[call_id] = event
            elif event["kind"] in {
                "tool.completed",
                "command.completed",
                "skill.completed",
            }:
                call_id = event.get("call_id")
                if isinstance(call_id, str) and call_id:
                    self._tool_calls.pop(call_id, None)
            self._emit(event)

    def finish(self, result: ProcessResult) -> None:
        self._persist_assistant_message()
        self._persist_thinking_message()
        stderr = _clean_text(result.stderr.strip())
        # Worker CLIs may forward successful tool output and diagnostics to
        # stderr. Command events already carry their actionable exit codes, so
        # only surface process-level stderr when the Worker itself failed.
        if stderr and result.returncode != 0:
            self.emit("error", content=stderr)
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
            with suppress(queue.Full):
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
                with suppress(queue.Full):
                    self._queue.put_nowait(payload)

    def _make_room(self) -> None:
        try:
            self._queue.get_nowait()
        except queue.Empty:
            pass

    def _persist_assistant_message(self) -> None:
        text = "".join(self._assistant_parts)
        if not text.strip():
            self._assistant_parts.clear()
            self._assistant_chars = 0
            return
        self._assistant_parts.clear()
        self._assistant_chars = 0
        for offset in range(0, len(text), ASSISTANT_MESSAGE_CHUNK):
            self.emit(
                "assistant.message",
                role="assistant",
                content=text[offset : offset + ASSISTANT_MESSAGE_CHUNK],
                persist_only=True,
            )

    def _persist_thinking_message(self, fallback_text: str = "") -> None:
        text = "".join(self._thinking_parts)
        if not text:
            text = fallback_text
        self._thinking_parts.clear()
        self._thinking_chars = 0
        if not text.strip():
            return
        for offset in range(0, len(text), THINKING_MESSAGE_CHUNK):
            self.emit(
                "thinking.message",
                role="assistant",
                content=text[offset : offset + THINKING_MESSAGE_CHUNK],
                persist_only=True,
            )

    def _run_loop(self) -> None:
        batch: list[dict[str, Any]] = []
        deadline = time.monotonic() + AUDIT_FLUSH_INTERVAL_SECONDS
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
            if len(batch) >= AUDIT_BATCH_SIZE or time.monotonic() >= deadline:
                self._flush(batch)
                batch.clear()
                deadline = time.monotonic() + AUDIT_FLUSH_INTERVAL_SECONDS

    def _flush(self, batch: list[dict[str, Any]]) -> None:
        if not batch:
            return
        try:
            self._client.append_audit_events(self._run, batch)
        except Exception:
            LOG.debug("audit batch publish failed run=%s", self.run_id, exc_info=True)


def normalize_event(
    provider: str,
    line: str,
    *,
    claude_tool_state: dict[int, dict[str, Any]] | None = None,
    pi_state: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    try:
        payload = json.loads(line)
    except json.JSONDecodeError:
        return []
    if not isinstance(payload, dict):
        return []
    timestamp = utcnow()
    if provider == "claudecode":
        return _normalize_claude(payload, timestamp, claude_tool_state)
    if provider == "codex":
        return _normalize_codex(payload, timestamp)
    if provider == "pi":
        return _normalize_pi(payload, timestamp, pi_state)
    return []


def _normalize_claude(
    payload: dict[str, Any],
    timestamp: str,
    tool_state: dict[int, dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    kind = payload.get("type")
    if kind == "system" and payload.get("subtype") == "init":
        return [
            _event("session.started", timestamp, session_id=payload.get("session_id"))
        ]
    if kind == "stream_event":
        event = payload.get("event") or {}
        event_type = event.get("type")
        if event_type == "content_block_delta":
            delta = event.get("delta") or {}
            if delta.get("type") == "text_delta":
                return [
                    _event("assistant.delta", timestamp, content=delta.get("text", ""))
                ]
            if delta.get("type") == "thinking_delta":
                return [
                    _event(
                        "thinking.delta", timestamp, content=delta.get("thinking", "")
                    )
                ]
            if delta.get("type") == "input_json_delta" and tool_state is not None:
                index = event.get("index")
                if isinstance(index, int) and index in tool_state:
                    tool_state[index]["parts"].append(
                        str(delta.get("partial_json", ""))
                    )
                return []
        if event_type == "content_block_start":
            block = event.get("content_block") or {}
            block_type = block.get("type")
            if block_type == "thinking":
                index = event.get("index")
                if isinstance(index, int) and tool_state is not None:
                    tool_state[index] = {"kind": "thinking", "parts": []}
                return []
            if block_type == "tool_use":
                index = event.get("index")
                if isinstance(index, int) and tool_state is not None:
                    tool_state[index] = {
                        "kind": "tool",
                        "call_id": block.get("id"),
                        "title": block.get("name"),
                        "parts": [],
                    }
                    return []
                return [
                    _event(
                        "tool.started",
                        timestamp,
                        title=block.get("name"),
                        call_id=block.get("id"),
                        arguments=block.get("input"),
                    )
                ]
        if event_type == "content_block_stop" and tool_state is not None:
            index = event.get("index")
            state = tool_state.pop(index, None) if isinstance(index, int) else None
            if state is None:
                return []
            if state.get("kind") == "thinking":
                return [_event("thinking.completed", timestamp)]
            arguments: Any = {}
            raw_arguments = "".join(state["parts"]).strip()
            if raw_arguments:
                try:
                    arguments = json.loads(raw_arguments)
                except json.JSONDecodeError:
                    arguments = {"raw": raw_arguments}
            return [
                _event(
                    "tool.started",
                    timestamp,
                    title=state.get("title"),
                    call_id=state.get("call_id"),
                    arguments=arguments,
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
                        content=_content_text(block.get("content")),
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
    event_type = payload.get("method") or payload.get("type")
    params = payload.get("params") if isinstance(payload.get("params"), dict) else {}
    item = params.get("item") or payload.get("item") or {}
    item_type = item.get("type")
    if event_type in {"thread.started", "thread/started"}:
        thread = params.get("thread") if isinstance(params.get("thread"), dict) else {}
        return [
            _event(
                "session.started",
                timestamp,
                session_id=thread.get("id") or payload.get("thread_id"),
            )
        ]
    if event_type in {"turn.started", "turn/started"}:
        return [_event("turn.started", timestamp)]
    if event_type == "item/agentMessage/delta":
        return [_event("assistant.delta", timestamp, content=params.get("delta", ""))]
    if event_type in {
        "item/reasoning/summaryTextDelta",
        "item/reasoning/textDelta",
    }:
        return [_event("thinking.delta", timestamp, content=params.get("delta", ""))]
    if event_type == "item.delta":
        return _normalize_codex_delta(item, item_type, timestamp)
    if event_type in {"item.started", "item/started"} and item_type in {
        "command_execution",
        "commandExecution",
        "mcp_tool_call",
        "mcpToolCall",
    }:
        command_item = item_type in {"command_execution", "commandExecution"}
        return [
            _event(
                "command.started" if command_item else "tool.started",
                timestamp,
                title="Shell" if command_item else item.get("tool"),
                call_id=item.get("id"),
                command=item.get("command"),
                arguments=item.get("arguments"),
            )
        ]
    if event_type in {"item.completed", "item/completed"}:
        if item_type == "reasoning":
            content = _codex_reasoning_text(item)
            if not content:
                return []
            return [
                _event(
                    "thinking.message",
                    timestamp,
                    role="assistant",
                    content=content,
                    message_id=item.get("id"),
                )
            ]
        if item_type in {"agent_message", "agentMessage"}:
            return [
                _event(
                    "assistant.message",
                    timestamp,
                    role="assistant",
                    content=_clean_text(item.get("text", "")),
                    message_id=item.get("id"),
                )
            ]
        if item_type in {"command_execution", "commandExecution"}:
            return [
                _event(
                    "command.completed",
                    timestamp,
                    title="Shell",
                    call_id=item.get("id"),
                    command=_display_command(item.get("command")),
                    content=_clean_text(
                        item.get("aggregatedOutput", item.get("aggregated_output", ""))
                    ),
                    exit_code=item.get("exitCode", item.get("exit_code")),
                )
            ]
        if item_type in {"file_change", "fileChange"}:
            return [_event("file.changed", timestamp, changes=item.get("changes", []))]
        if item_type in {"mcp_tool_call", "mcpToolCall"}:
            return [
                _event(
                    "tool.completed",
                    timestamp,
                    title=item.get("tool"),
                    call_id=item.get("id"),
                    content=_content_text(item.get("result")),
                    error=item.get("status") == "failed",
                )
            ]
    if event_type in {"turn.completed", "turn.failed", "turn/completed"}:
        turn = params.get("turn") if isinstance(params.get("turn"), dict) else {}
        failed = event_type == "turn.failed" or turn.get("status") == "failed"
        return [
            _event(
                "error" if failed else "turn.completed",
                timestamp,
                usage=payload.get("usage"),
                content=_content_text(turn.get("error") or payload.get("error")),
            )
        ]
    return []


def _normalize_codex_delta(
    item: dict[str, Any],
    item_type: str,
    timestamp: str,
) -> list[dict[str, Any]]:
    if item_type == "reasoning":
        text = _codex_reasoning_delta_text(item)
        if not text:
            return []
        return [_event("thinking.delta", timestamp, content=text)]
    if item_type == "agent_message":
        text = item.get("text")
        if not isinstance(text, str) or not text.strip():
            return []
        return [_event("assistant.delta", timestamp, content=text)]
    return []


def _codex_reasoning_delta_text(item: dict[str, Any]) -> str:
    text = item.get("text")
    if isinstance(text, str) and text.strip():
        return _clean_text(text).strip()
    return _codex_reasoning_text(item)


def _normalize_pi(
    payload: dict[str, Any],
    timestamp: str,
    state: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    event_type = payload.get("type")
    if event_type == "response" and payload.get("command") == "get_state":
        data = payload.get("data")
        if not isinstance(data, dict) or not data.get("sessionId"):
            return []
        return [
            _event(
                "session.started",
                timestamp,
                session_id=data.get("sessionId"),
                session_file=data.get("sessionFile"),
            )
        ]
    if event_type == "session":
        return [_event("session.started", timestamp, session_id=payload.get("id"))]
    if event_type == "message_end":
        message = payload.get("message")
        if not isinstance(message, dict) or message.get("role") != "assistant":
            return []
        message_content = message.get("content")
        content = (
            "\n".join(
                str(item["text"])
                for item in message_content
                if isinstance(item, dict) and item.get("type") == "text" and item.get("text")
            )
            if isinstance(message_content, list)
            else _content_text(message_content)
        )
        return (
            [_event("assistant.message", timestamp, role="assistant", content=content)]
            if content
            else []
        )
    if event_type == "message_update":
        update = payload.get("assistantMessageEvent") or {}
        update_type = update.get("type")
        if update_type == "text_delta":
            return [
                _event("assistant.delta", timestamp, content=update.get("delta", ""))
            ]
        if update_type == "thinking_delta":
            if state is not None:
                state["thinking_streamed"] = True
            return [
                _event("thinking.delta", timestamp, content=update.get("delta", ""))
            ]
        if update_type in {"thinking_end", "thinking_start"}:
            if update_type == "thinking_end":
                streamed = bool(state.get("thinking_streamed")) if state else False
                if state is not None:
                    state["thinking_streamed"] = False
                if streamed:
                    return [_event("thinking.completed", timestamp)]
                content = _clean_text(update.get("content", ""))
                if content.strip():
                    # Provider delivered the thinking block without streaming
                    # deltas; surface the complete text as a single card.
                    return [
                        _event(
                            "thinking.message",
                            timestamp,
                            role="assistant",
                            content=content,
                        )
                    ]
            return []
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
                content=_content_text(payload.get("result")),
                error=payload.get("isError", False),
                call_id=payload.get("toolCallId"),
            )
        ]
    if event_type in {"turn_end", "agent_end"}:
        return [_event("turn.completed", timestamp)]
    return []


def _event(kind: str, timestamp: str, **fields: Any) -> dict[str, Any]:
    return {"kind": kind, "timestamp": timestamp, **fields}


def _codex_reasoning_text(item: dict[str, Any]) -> str:
    parts: list[str] = []
    summary = item.get("summary")
    if isinstance(summary, list):
        for entry in summary:
            if isinstance(entry, str) and entry.strip():
                parts.append(_clean_text(entry).strip())
                continue
            if not isinstance(entry, dict):
                continue
            text = entry.get("text")
            if isinstance(text, str) and text.strip():
                parts.append(_clean_text(text).strip())
    return "\n\n".join(part for part in parts if part).strip()


def _content_text(value: Any) -> str:
    if isinstance(value, str):
        return _clean_text(value)
    if value is None:
        return ""
    return _clean_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")))


def _enrich_tool_event(
    event: dict[str, Any],
    active_tools: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    kind = event.get("kind")
    call_id = event.get("call_id")
    if kind in {"tool.started", "command.started"}:
        skill_name = _skill_name_from_event(event)
        if skill_name:
            return _as_skill_event(event, "skill.started", skill_name)
        command = _command_from_event(event)
        if command:
            event["command"] = _display_command(command)
        if (
            kind == "tool.started"
            and _is_shell_tool(event.get("title"))
            and event.get("command")
        ):
            event["kind"] = "command.started"
            event["title"] = "Shell"
        return event
    if kind in {"tool.completed", "command.completed"}:
        started = active_tools.get(call_id) if isinstance(call_id, str) else None
        if started and started.get("kind") == "skill.started":
            return _as_skill_event(
                event,
                "skill.completed",
                str(started.get("skill_name") or "未知技能"),
            )
        skill_name = _skill_name_from_event(event)
        if skill_name:
            return _as_skill_event(event, "skill.completed", skill_name)
        if (
            kind == "tool.completed"
            and started
            and started.get("kind") == "command.started"
        ):
            event["kind"] = "command.completed"
            event["title"] = "Shell"
            event["command"] = started.get("command", "")
        elif kind == "tool.completed" and started and not event.get("title"):
            event["title"] = started.get("title")
    return event


def _as_skill_event(
    event: dict[str, Any],
    kind: str,
    skill_name: str,
) -> dict[str, Any]:
    event["kind"] = kind
    event["title"] = "Skill"
    event["skill_name"] = skill_name
    for key in ("arguments", "command", "content"):
        event.pop(key, None)
    return event


SKILL_PLUGIN_PREFIX = "redtrace-capabilities:"


def _skill_name_from_event(event: dict[str, Any]) -> str:
    direct_name = event.get("skill_name") or event.get("skillName")
    if isinstance(direct_name, str) and direct_name.strip():
        name = direct_name.strip()
        if name.startswith(SKILL_PLUGIN_PREFIX):
            name = name[len(SKILL_PLUGIN_PREFIX) :]
        return name

    title = str(event.get("title") or "").strip().lower().replace("_", " ")
    arguments = event.get("arguments")
    if title in SKILL_TOOL_NAMES:
        if isinstance(arguments, dict):
            for key in ("skill", "name", "skill_name", "skillName"):
                value = arguments.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()
        elif isinstance(arguments, str) and arguments.strip():
            return arguments.strip()
        return "未知技能"

    candidates: list[Any] = [event.get("command")]
    if isinstance(arguments, dict):
        candidates.extend(
            arguments.get(key)
            for key in (
                "path",
                "file",
                "file_path",
                "filePath",
                "command",
                "input",
                "raw",
            )
        )
    elif isinstance(arguments, str):
        candidates.append(arguments)
    for candidate in candidates:
        if not isinstance(candidate, str):
            continue
        match = SKILL_PATH_PATTERN.search(candidate)
        if match:
            return match.group("name")
    return ""


def _command_from_event(event: dict[str, Any]) -> str:
    command = event.get("command")
    if isinstance(command, str) and command.strip():
        return command
    arguments = event.get("arguments")
    if isinstance(arguments, dict):
        for key in ("command", "cmd", "script", "input"):
            value = arguments.get(key)
            if isinstance(value, str) and value.strip():
                return value
    if isinstance(arguments, str) and arguments.strip():
        return arguments
    return ""


def _is_shell_tool(title: Any) -> bool:
    if not isinstance(title, str):
        return False
    normalized = title.strip().lower().replace("_", " ")
    return (
        normalized in SHELL_TOOL_NAMES or "shell" in normalized or "bash" in normalized
    )


def _display_command(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    text = _clean_text(value).strip()
    match = re.match(
        r"""(?is)^\s*["']?.*?[\\/](?:pwsh|powershell)(?:\.exe)?["']?\s+-command\s+(.+?)\s*$""",
        text,
    )
    if not match:
        return text
    command = match.group(1).strip()
    if len(command) >= 2 and command[0] == command[-1] and command[0] in {'"', "'"}:
        command = command[1:-1]
    return command.replace(r"\"", '"').replace(r"\'", "'").replace("\\\\", "\\").strip()


def _clean_text(value: Any) -> str:
    text = ANSI_PATTERN.sub("", str(value or ""))
    if not any(marker in text for marker in MOJIBAKE_MARKERS):
        return text
    try:
        repaired = text.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return text
    original_cjk = sum("\u4e00" <= char <= "\u9fff" for char in text)
    repaired_cjk = sum("\u4e00" <= char <= "\u9fff" for char in repaired)
    original_markers = sum(char in MOJIBAKE_MARKERS for char in text)
    repaired_markers = sum(char in MOJIBAKE_MARKERS for char in repaired)
    return (
        repaired
        if repaired_cjk > original_cjk or repaired_markers < original_markers
        else text
    )


def _redact(value: Any) -> Any:
    return value
