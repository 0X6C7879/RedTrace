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
from urllib.parse import parse_qs, urlsplit, urlunsplit

import yaml

from redtrace.dispatcher.config import WorkerConfig
from redtrace.dispatcher.output_parser import extract_json_object
from redtrace.dispatcher.prompting import PRIMARY_SKILL_MARKER
from redtrace.dispatcher.protocol.client import CairnClient
from redtrace.dispatcher.runtime.process import ProcessResult
from redtrace.dispatcher.runtime.stream_buffer import TRUNCATED_STREAM_LINE

LOG = logging.getLogger(__name__)
ASSISTANT_MESSAGE_CHUNK = 32 * 1024
THINKING_MESSAGE_CHUNK = 32 * 1024
ANSI_PATTERN = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")
MOJIBAKE_MARKERS = frozenset("ÃÂâ€™œž�ç¬åæèé")
SHELL_TOOL_NAMES = frozenset(
    {"bash", "sh", "shell", "powershell", "pwsh", "cmd", "command", "terminal", "exec"}
)
SKILL_TOOL_NAMES = frozenset({"skill", "skills", "load skill", "use skill"})
SKILL_MD_MARKERS = ("SKILL.md", "skill.md", "Skill.md")
SKILL_PATH_BOUNDARIES = frozenset(' \t\r\n"\'`;|&<>(){}[]')
MAX_COMMAND_BYTES = 128 * 1024
CHALLENGE_CODE_PATTERN = re.compile(
    r"(?i)(?<![a-z0-9])[a-z][a-z0-9]*-\d{1,4}(?![a-z0-9])"
)
URL_PATTERN = re.compile(r"https?://[^\s\"'<>]+", re.IGNORECASE)
WEBSHELL_PATH_PATTERN = re.compile(
    r"(?i)(?:^|/)(?:[^/?#]*(?:shell|webshell|backdoor|cmd)[^/?#]*|ws(?:[-_.][^/?#]*)?)"
    r"\.(?:php\d*|phtml|asp|aspx|jsp)$"
)
COMMAND_PARAM_NAMES = frozenset({"c", "cmd", "command", "exec"})
DIRECT_C2_PATTERN = re.compile(
    r"(?is)(?:\b(?:nc|ncat)\b[^\n]{0,160}\s-(?:[^\s]*l|l[^\s]*)\b|"
    r"\bsocat\b[^\n]{0,160}\bTCP-LISTEN:|/dev/tcp/|"
    r"\b(?:bash|sh)\s+-i\b[^\n]{0,160}(?:>&|\|\s*(?:nc|ncat)\b))"
)
C2_RESOURCE_COMMANDS = (
    "listener-create",
    "payload-oneliner",
    "payload-build",
)
CHANNEL_CREATE_COMMANDS = ("listener-create", "webshell-create")


def _challenge_lifecycle_codes(command: str) -> set[str]:
    codes: set[str] = set()
    for raw_url in URL_PATTERN.findall(command):
        parsed = urlsplit(raw_url)
        path = parsed.path.casefold().rstrip("/")
        if re.search(r"/challenges/(?:start|close|reset)$", path):
            candidates = parse_qs(parsed.query).get("unique_code", [])
        else:
            match = re.search(
                r"/challenges/([a-z][a-z0-9]*-\d{1,4})/(?:start|close|reset)$",
                path,
            )
            candidates = [match.group(1)] if match else []
        codes.update(
            candidate.casefold()
            for candidate in candidates
            if CHALLENGE_CODE_PATTERN.fullmatch(candidate)
        )
    return codes


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
        # Audit is the durable execution record. An unbounded producer queue is
        # cheaper and safer than silently evicting earlier events under bursts;
        # the consumer still sends small bounded batches.
        self._queue: queue.Queue[dict[str, Any] | None] = queue.Queue()
        self._assistant_parts: list[str] = []
        self._assistant_chars = 0
        self._thinking_parts: list[str] = []
        self._thinking_chars = 0
        self._tool_calls: dict[str, dict[str, Any]] = {}
        self._claude_tool_blocks: dict[int, dict[str, Any]] = {}
        self._pi_state: dict[str, Any] = {"thinking_streamed": False}
        self._process: Any | None = None
        self._policy_cancelled = False
        self._registered_webshells: set[tuple[str, str, str]] = set()
        self._resource_snapshot_seen = False
        self._c2_managed = False
        self._channel_creations = 0
        self._changes_refreshed = False
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
        if self._run["task_type"] == "explore":
            self._load_resource_snapshot()
        primary = re.search(
            rf"(?m)^{re.escape(PRIMARY_SKILL_MARKER)}([a-z0-9-]+)\s*$",
            prompt,
        )
        self._primary_skill_name = primary.group(1) if primary else ""
        if self._primary_skill_name:
            self.emit(
                "skill.started",
                title="Skill",
                skill_name=self._primary_skill_name,
                source="dispatcher_preload",
            )
        self.emit("user.message", role="user", content=prompt)

    def _peer_challenge_conflicts(self, challenge_codes: set[str]) -> set[str]:
        active_peer_work = getattr(self._client, "active_peer_work", None)
        if not callable(active_peer_work):
            return set()
        try:
            peers = active_peer_work(self._run["project_id"], self._run["worker"])
        except Exception:
            LOG.debug("peer work refresh failed", exc_info=True)
            return set()
        peer_codes = {
            code.casefold()
            for peer in peers
            if isinstance(peer, dict)
            for code in CHALLENGE_CODE_PATTERN.findall(str(peer.get("description") or ""))
        }
        return challenge_codes & peer_codes

    def _load_resource_snapshot(self) -> None:
        snapshot = getattr(self._client, "snapshot_resources", None)
        if not callable(snapshot):
            return
        try:
            response = snapshot(
                self._run["project_id"],
                worker=self._run["worker"],
                intent_id=self._run["intent_id"],
            )
        except Exception:
            LOG.debug("resource snapshot preflight failed", exc_info=True)
            return
        data = response.data if getattr(response, "ok", False) else None
        if not isinstance(data, dict):
            return
        self._resource_snapshot_seen = True
        resources = data.get("resources", [])
        if not isinstance(resources, list):
            return
        for resource in resources:
            if not isinstance(resource, dict):
                continue
            kind = resource.get("kind")
            if kind == "webshell":
                target = str(resource.get("target") or "")
                metadata = resource.get("metadata")
                metadata = metadata if isinstance(metadata, dict) else {}
                if target:
                    self._registered_webshells.add(
                        (
                            target,
                            str(metadata.get("command_param") or "cmd"),
                            str(metadata.get("method") or "GET").upper(),
                        )
                    )
            elif kind in {"c2_listener", "c2_session", "c2_payload"}:
                self._c2_managed = True

    def attach_process(self, process: Any) -> None:
        self._process = process

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
            if event["kind"] == "command.started":
                self._enforce_command(str(event.get("command") or ""))
            elif event["kind"] == "command.completed":
                self._record_command_success(event)
                self._register_webshell_candidate(event)
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
        if self._primary_skill_name and self._run["status"] == "completed":
            self.emit(
                "skill.completed",
                title="Skill",
                skill_name=self._primary_skill_name,
                source="dispatcher_preload",
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
        self._queue.put(None)
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
        self._queue.put(payload)

    def _persist_assistant_message(self) -> None:
        text = "".join(self._assistant_parts)
        if not text.strip():
            self._assistant_parts.clear()
            self._assistant_chars = 0
            return
        self._assistant_parts.clear()
        self._assistant_chars = 0
        if self._run["provider"] == "pi":
            text = _canonical_contract_json(text)
        for offset in range(0, len(text), ASSISTANT_MESSAGE_CHUNK):
            self.emit(
                "assistant.message",
                role="assistant",
                content=text[offset : offset + ASSISTANT_MESSAGE_CHUNK],
                persist_only=True,
            )

    def _enforce_command(self, command: str) -> None:
        if self._policy_cancelled or not command:
            return
        normalized = " ".join(command.casefold().split())
        webshell = _webshell_candidate(command)
        if len(command.encode("utf-8", errors="replace")) > MAX_COMMAND_BYTES:
            reason = "command exceeds 128 KiB; write the payload to a file or stdin"
        elif challenge_codes := _challenge_lifecycle_codes(command):
            conflicts = self._peer_challenge_conflicts(challenge_codes)
            if not conflicts:
                return
            reason = (
                "Benchmark Challenge is currently assigned to another Worker: "
                + ", ".join(sorted(conflicts))
            )
        elif "redtrace-resource snapshot" in normalized:
            self._resource_snapshot_seen = True
            return
        elif "redtrace-resource changes --since" in normalized:
            self._changes_refreshed = True
            return
        elif "redtrace-resource" in normalized and any(
            action in normalized for action in CHANNEL_CREATE_COMMANDS
        ):
            if not self._resource_snapshot_seen:
                reason = "snapshot shared access resources before creating a channel"
            elif self._channel_creations and not self._changes_refreshed:
                reason = "refresh resource changes before creating another access channel"
            else:
                return
        elif "redtrace-resource" in normalized and any(
            action in normalized for action in C2_RESOURCE_COMMANDS
        ):
            if not self._resource_snapshot_seen:
                reason = "snapshot shared access resources before creating a C2 channel"
            else:
                return
        elif webshell in self._registered_webshells:
            reason = "this WebShell is registered; execute it through redtrace-resource run"
        elif webshell is not None and not self._resource_snapshot_seen:
            reason = "snapshot shared access resources before using a direct WebShell endpoint"
        elif DIRECT_C2_PATTERN.search(command) and not self._resource_snapshot_seen:
            reason = "snapshot shared access resources before establishing a remote shell"
        elif DIRECT_C2_PATTERN.search(command) and not self._c2_managed:
            reason = "create a RedTrace Listener and Payload before establishing a remote shell"
        else:
            return
        self._policy_cancelled = True
        self.emit("policy.violation", title="Runtime policy", content=reason)
        cancel = getattr(self._process, "cancel", None)
        if callable(cancel):
            cancel(reason)

    def _record_command_success(self, event: dict[str, Any]) -> None:
        if event.get("error") or event.get("exit_code") not in (None, 0):
            return
        normalized = " ".join(str(event.get("command") or "").casefold().split())
        if "redtrace-resource" in normalized and any(
            action in normalized for action in CHANNEL_CREATE_COMMANDS
        ):
            self._channel_creations += 1
            self._changes_refreshed = False
        if "redtrace-resource" in normalized and any(
            action in normalized for action in C2_RESOURCE_COMMANDS
        ):
            self._c2_managed = True

    def _register_webshell_candidate(self, event: dict[str, Any]) -> None:
        if event.get("error") or event.get("exit_code") not in (None, 0):
            return
        candidate = _webshell_candidate(str(event.get("command") or ""))
        if candidate is None or candidate in self._registered_webshells:
            return
        content = str(event.get("content") or "")
        if not content.strip() or "(no output)" in content.casefold():
            return
        command_param = re.escape(candidate[1])
        verifies_id = re.search(
            rf"(?i)(?:[?&]|\b){command_param}=id(?:[&#'\"\s]|$)",
            str(event.get("command") or ""),
        )
        if verifies_id and not re.search(r"(?i)\b(?:uid|gid)=\d+", content):
            return
        register = getattr(self._client, "ensure_webshell_resource", None)
        if not callable(register):
            return
        self._registered_webshells.add(candidate)
        target, command_param, method = candidate
        try:
            response = register(
                self._run["project_id"],
                target=target,
                command_param=command_param,
                method=method,
                worker=self._run["worker"],
                intent_id=self._run["intent_id"],
            )
        except Exception:
            LOG.debug("automatic WebShell registration failed target=%s", target, exc_info=True)
            return
        if getattr(response, "ok", False):
            self.emit(
                "resource.registered",
                title="WebShell",
                content=target,
                source="command_detection",
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


def _canonical_contract_json(text: str) -> str:
    if '"accepted"' not in text:
        return text
    try:
        payload = extract_json_object(text)
    except (TypeError, ValueError):
        return text
    if payload.get("accepted") not in {True, False}:
        return text
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def _webshell_candidate(command: str) -> tuple[str, str, str] | None:
    data_param = ""
    data_match = re.search(
        r"(?is)(?:^|\s)(?:-d|--data(?:-raw|-binary)?)\s+(?:['\"])?([a-zA-Z_][\w-]*)=",
        command,
    )
    if data_match:
        data_param = data_match.group(1)
    for match in URL_PATTERN.finditer(command):
        raw = match.group(0).rstrip(".,);]")
        try:
            parsed = urlsplit(raw)
        except ValueError:
            continue
        query = parse_qs(parsed.query, keep_blank_values=True)
        command_param = next(
            (key for key in query if key.casefold() in COMMAND_PARAM_NAMES),
            data_param if data_param.casefold() in COMMAND_PARAM_NAMES else "",
        )
        if not command_param and not WEBSHELL_PATH_PATTERN.search(parsed.path):
            continue
        if not command_param:
            command_param = "cmd"
        target = urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))
        method = "POST" if data_param else "GET"
        return target, command_param, method
    return None


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
        return [_event("session.started", timestamp, session_id=payload.get("session_id"))]
    if kind == "stream_event":
        event = payload.get("event") or {}
        event_type = event.get("type")
        if event_type == "content_block_delta":
            delta = event.get("delta") or {}
            if delta.get("type") == "text_delta":
                return [_event("assistant.delta", timestamp, content=delta.get("text", ""))]
            if delta.get("type") == "thinking_delta":
                return [
                    _event("thinking.delta", timestamp, content=delta.get("thinking", ""))
                ]
            if delta.get("type") == "input_json_delta" and tool_state is not None:
                index = event.get("index")
                if isinstance(index, int) and index in tool_state:
                    tool_state[index]["parts"].append(str(delta.get("partial_json", "")))
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
    event_type = payload.get("type")
    item = payload.get("item") or {}
    item_type = item.get("type")
    if event_type == "thread.started":
        return [_event("session.started", timestamp, session_id=payload.get("thread_id"))]
    if event_type == "turn.started":
        return [_event("turn.started", timestamp)]
    if event_type == "item.delta":
        return _normalize_codex_delta(item, item_type, timestamp)
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
        if item_type == "agent_message":
            return [
                _event(
                    "assistant.message",
                    timestamp,
                    role="assistant",
                    content=_clean_text(item.get("text", "")),
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
                    command=_display_command(item.get("command")),
                    content=_clean_text(item.get("aggregated_output", "")),
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
                    content=_content_text(item.get("result")),
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
    if event_type == "session":
        return [_event("session.started", timestamp, session_id=payload.get("id"))]
    if event_type == "message_update":
        update = payload.get("assistantMessageEvent") or {}
        update_type = update.get("type")
        if update_type == "text_delta":
            return [_event("assistant.delta", timestamp, content=update.get("delta", ""))]
        if update_type == "thinking_delta":
            if state is not None:
                state["thinking_streamed"] = True
            return [_event("thinking.delta", timestamp, content=update.get("delta", ""))]
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
        if skill_name and not _is_router_skill_name(skill_name):
            return _as_skill_event(event, "skill.started", skill_name)
        command = _command_from_event(event)
        if command:
            event["command"] = _display_command(command)
        if kind == "tool.started" and _is_shell_tool(event.get("title")) and event.get("command"):
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
        if skill_name and not _is_router_skill_name(skill_name):
            return _as_skill_event(event, "skill.completed", skill_name)
        if kind == "tool.completed" and started and started.get("kind") == "command.started":
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
    # A concrete SKILL.md path always wins over the router package name the
    # Agent reports, so nested package Skills show their real names.
    for candidate in _text_candidates(event):
        path = _extract_skill_md_path(candidate)
        if path:
            return _skill_name_from_skill_md(path)

    title = str(event.get("title") or "").strip().lower().replace("_", " ")
    arguments = event.get("arguments")
    if title in SKILL_TOOL_NAMES:
        if isinstance(arguments, dict):
            for key in ("skill", "name", "skill_name", "skillName"):
                value = arguments.get(key)
                if isinstance(value, str) and value.strip():
                    return _strip_skill_plugin_prefix(value.strip())
        elif isinstance(arguments, str) and arguments.strip():
            return _strip_skill_plugin_prefix(arguments.strip())
        # Completion events carry no arguments; only started calls may fall
        # back to the placeholder name.
        if arguments is not None:
            return "未知技能"
        return ""

    direct_name = event.get("skill_name") or event.get("skillName")
    if isinstance(direct_name, str) and direct_name.strip():
        return _strip_skill_plugin_prefix(direct_name.strip())
    return ""


def _strip_skill_plugin_prefix(name: str) -> str:
    if name.startswith(SKILL_PLUGIN_PREFIX):
        return name[len(SKILL_PLUGIN_PREFIX):]
    return name


def _is_router_skill_name(name: str) -> bool:
    """Router Skills only forward to nested Skills, so their own load is not
    a concrete Skill and must not surface as a Skill record."""
    try:
        from redtrace.capabilities import CapabilityStore

        entries = CapabilityStore().list_skill_entries()
    except Exception:
        return False
    return any(entry.router and entry.name == name for entry in entries)


def _text_candidates(event: dict[str, Any]) -> list[str]:
    candidates: list[Any] = [
        event.get("command"),
        event.get("path"),
        event.get("file"),
        event.get("input"),
        event.get("raw"),
    ]
    arguments = event.get("arguments")
    if isinstance(arguments, dict):
        candidates.extend(
            arguments.get(key)
            for key in ("path", "file", "file_path", "filePath", "command", "input", "raw")
        )
    elif isinstance(arguments, str):
        candidates.append(arguments)
    return [candidate for candidate in candidates if isinstance(candidate, str)]


def _extract_skill_md_path(text: str) -> str:
    offset = 0
    lowered = text.lower()
    while True:
        found = -1
        for marker in SKILL_MD_MARKERS:
            index = lowered.find(marker.lower(), offset)
            if index != -1 and (found == -1 or index < found):
                found = index
        if found == -1:
            return ""
        end = found + len("SKILL.md")
        offset = end
        start = found
        while start > 0 and text[start - 1] not in SKILL_PATH_BOUNDARIES:
            start -= 1
        path = text[start:end]
        if "/" in path or "\\" in path:
            return path


def _skill_name_from_skill_md(path: str) -> str:
    try:
        entrypoint = Path(path)
        directory = entrypoint.parent.name
        if entrypoint.is_file():
            try:
                content = entrypoint.read_text(encoding="utf-8", errors="replace")
            except OSError:
                content = ""
            name = _frontmatter_name(content)
            if name:
                return name
        return directory
    except Exception:
        return ""


def _frontmatter_name(content: str) -> str:
    lines = content.splitlines()
    if not lines or lines[0].strip() != "---":
        return ""
    for index in range(1, len(lines)):
        if lines[index].strip() != "---":
            continue
        try:
            parsed = yaml.safe_load("\n".join(lines[1:index]))
        except yaml.YAMLError:
            return ""
        if isinstance(parsed, dict):
            name = parsed.get("name")
            if isinstance(name, str) and name.strip():
                return name.strip()
        return ""
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
    return normalized in SHELL_TOOL_NAMES or "shell" in normalized or "bash" in normalized


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
    return (
        command.replace(r'\"', '"')
        .replace(r"\'", "'")
        .replace("\\\\", "\\")
        .strip()
    )


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
    return repaired if repaired_cjk > original_cjk or repaired_markers < original_markers else text


def _redact(value: Any) -> Any:
    return value
