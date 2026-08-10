from __future__ import annotations

import json
from pathlib import Path

from redtrace.dispatcher.audit import (
    AUDIT_BATCH_SIZE,
    AUDIT_FLUSH_INTERVAL_SECONDS,
    AuditPublisher,
    normalize_event,
)
from redtrace.dispatcher.config import WorkerConfig
from redtrace.dispatcher.runtime.process import ProcessResult
from redtrace.dispatcher.runtime.stream_buffer import TRUNCATED_STREAM_LINE
from redtrace.server.event_hub import EventHub


class RecordingClient:
    def __init__(self) -> None:
        self.batches: list[tuple[dict, list[dict]]] = []

    def append_audit_events(self, run: dict, events: list[dict]) -> None:
        self.batches.append((dict(run), [dict(event) for event in events]))


def test_audit_transport_uses_full_api_batches() -> None:
    assert AUDIT_BATCH_SIZE == 128
    assert AUDIT_FLUSH_INTERVAL_SECONDS == 0.25


def test_event_hub_releases_empty_project_subscription() -> None:
    hub = EventHub()
    subscriber = hub.subscribe("project-1")

    hub.unsubscribe("project-1", subscriber)

    assert "project-1" not in hub._subscribers


def test_event_hub_keeps_latest_event_when_subscriber_is_saturated() -> None:
    hub = EventHub()
    subscriber = hub.subscribe("project-1")
    for sequence in range(512):
        hub.publish("project-1", {"sequence": sequence})

    hub.publish("project-1", {"sequence": 512})

    assert subscriber.qsize() == 512
    assert subscriber.get_nowait() == {"sequence": 1}
    latest = None
    while not subscriber.empty():
        latest = subscriber.get_nowait()
    assert latest == {"sequence": 512}


def test_normalize_provider_events() -> None:
    claude = normalize_event(
        "claudecode",
        json.dumps(
            {
                "type": "stream_event",
                "event": {
                    "type": "content_block_delta",
                    "delta": {"type": "text_delta", "text": "hello"},
                },
            }
        ),
    )
    codex = normalize_event(
        "codex",
        json.dumps(
            {
                "type": "item.completed",
                "item": {"id": "m1", "type": "agent_message", "text": "done"},
            }
        ),
    )
    pi = normalize_event(
        "pi",
        json.dumps(
            {
                "type": "message_update",
                "assistantMessageEvent": {"type": "text_delta", "delta": "hi"},
            }
        ),
    )

    assert [(event["kind"], event["content"]) for event in claude + codex + pi] == [
        ("assistant.delta", "hello"),
        ("assistant.message", "done"),
        ("assistant.delta", "hi"),
    ]


def test_codex_command_display_is_compact_and_repairs_mojibake() -> None:
    mojibake = "笛卡".encode("utf-8").decode("latin-1")

    events = normalize_event(
        "codex",
        json.dumps(
            {
                "type": "item.completed",
                "item": {
                    "id": "cmd-1",
                    "type": "command_execution",
                    "command": (
                        r'"C:\\Program Files\\PowerShell\\7\\pwsh.exe" '
                        r'-Command "Write-Output \"中文\""'
                    ),
                    "aggregated_output": mojibake,
                    "exit_code": 0,
                },
            },
        ),
    )

    assert events == [
        {
            "kind": "command.completed",
            "timestamp": events[0]["timestamp"],
            "title": "Shell",
            "call_id": "cmd-1",
            "command": 'Write-Output "中文"',
            "content": "笛卡",
            "exit_code": 0,
        }
    ]


def test_claude_streamed_tool_arguments_become_a_command_event(tmp_path: Path) -> None:
    client = RecordingClient()
    worker = WorkerConfig.model_validate(
        {
            "name": "claude-1",
            "type": "claudecode",
            "task_types": ["explore"],
            "max_running": 1,
            "priority": 0,
            "env": {},
        }
    )
    publisher = AuditPublisher(
        client,
        "proj_001",
        "i001",
        worker,
        "explore_execute",
        str(tmp_path),
        "prompt",
    )
    lines = [
        {
            "type": "stream_event",
            "event": {
                "type": "content_block_start",
                "index": 0,
                "content_block": {"type": "tool_use", "id": "tool-1", "name": "Bash"},
            },
        },
        {
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "index": 0,
                "delta": {
                    "type": "input_json_delta",
                    "partial_json": '{"command":"echo 中文"}',
                },
            },
        },
        {
            "type": "stream_event",
            "event": {"type": "content_block_stop", "index": 0},
        },
    ]

    for line in lines:
        publisher.handle_output("stdout", json.dumps(line, ensure_ascii=False))
    publisher.finish(ProcessResult(returncode=0, stdout="", stderr=""))
    publisher.close()

    events = [event for _, batch in client.batches for event in batch]
    commands = [
        (event["kind"], event.get("title"), event.get("command"))
        for event in events
        if event["kind"].startswith("command.")
    ]
    assert commands == [
        ("command.started", "Shell", "echo 中文")
    ]


def test_pi_shell_tool_events_match_codex_command_shape(tmp_path: Path) -> None:
    client = RecordingClient()
    worker = WorkerConfig.model_validate(
        {
            "name": "pi-1",
            "type": "pi",
            "task_types": ["explore"],
            "max_running": 1,
            "priority": 0,
            "env": {},
        }
    )
    publisher = AuditPublisher(
        client,
        "proj_001",
        "i001",
        worker,
        "explore_execute",
        str(tmp_path),
        "prompt",
    )
    publisher.handle_output(
        "stdout",
        json.dumps(
            {
                "type": "tool_execution_start",
                "toolName": "bash",
                "toolCallId": "pi-1",
                "args": {"command": "echo 中文"},
            },
            ensure_ascii=False,
        ),
    )
    publisher.handle_output(
        "stdout",
        json.dumps(
            {
                "type": "tool_execution_end",
                "toolName": "bash",
                "toolCallId": "pi-1",
                "result": "中文",
                "isError": False,
            },
            ensure_ascii=False,
        ),
    )
    publisher.finish(ProcessResult(returncode=0, stdout="", stderr=""))
    publisher.close()

    events = [event for _, batch in client.batches for event in batch]
    started = next(event for event in events if event["kind"] == "command.started")
    completed = next(event for event in events if event["kind"] == "command.completed")
    assert started["title"] == completed["title"] == "Shell"
    assert started["command"] == completed["command"] == "echo 中文"
    assert completed["content"] == "中文"


def test_claude_skill_event_keeps_only_the_skill_name(tmp_path: Path) -> None:
    client = RecordingClient()
    worker = WorkerConfig.model_validate(
        {
            "name": "claude-1",
            "type": "claudecode",
            "task_types": ["explore"],
            "max_running": 1,
            "priority": 0,
            "env": {},
        }
    )
    publisher = AuditPublisher(
        client,
        "proj_001",
        "i001",
        worker,
        "explore_execute",
        str(tmp_path),
        "prompt",
    )
    for payload in (
        {
            "type": "stream_event",
            "event": {
                "type": "content_block_start",
                "index": 0,
                "content_block": {
                    "type": "tool_use",
                    "id": "skill-1",
                    "name": "Skill",
                },
            },
        },
        {
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "index": 0,
                "delta": {
                    "type": "input_json_delta",
                    "partial_json": '{"skill":"route-skills"}',
                },
            },
        },
        {
            "type": "stream_event",
            "event": {"type": "content_block_stop", "index": 0},
        },
        {
            "type": "user",
            "message": {
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": "skill-1",
                        "content": "secret skill instructions",
                    }
                ]
            },
        },
    ):
        publisher.handle_output("stdout", json.dumps(payload))
    publisher.finish(ProcessResult(returncode=0, stdout="", stderr=""))
    publisher.close()

    skill_events = [
        event
        for _, batch in client.batches
        for event in batch
        if event["kind"].startswith("skill.")
    ]
    assert [event["kind"] for event in skill_events] == [
        "skill.started",
        "skill.completed",
    ]
    assert all(event["skill_name"] == "route-skills" for event in skill_events)
    assert all("arguments" not in event for event in skill_events)
    assert all("content" not in event for event in skill_events)


def test_codex_skill_read_command_keeps_only_the_skill_name(tmp_path: Path) -> None:
    client = RecordingClient()
    worker = WorkerConfig.model_validate(
        {
            "name": "codex-1",
            "type": "codex",
            "task_types": ["explore"],
            "max_running": 1,
            "priority": 0,
            "env": {},
        }
    )
    publisher = AuditPublisher(
        client,
        "proj_001",
        "i001",
        worker,
        "explore_execute",
        str(tmp_path),
        "prompt",
    )
    command = "rtk read /workspace/.codex/skills/route-skills/SKILL.md"
    for payload in (
        {
            "type": "item.started",
            "item": {
                "id": "skill-1",
                "type": "command_execution",
                "command": command,
            },
        },
        {
            "type": "item.completed",
            "item": {
                "id": "skill-1",
                "type": "command_execution",
                "command": command,
                "aggregated_output": "secret skill instructions",
                "exit_code": 0,
            },
        },
    ):
        publisher.handle_output("stdout", json.dumps(payload))
    publisher.finish(ProcessResult(returncode=0, stdout="", stderr=""))
    publisher.close()

    skill_events = [
        event
        for _, batch in client.batches
        for event in batch
        if event["kind"].startswith("skill.")
    ]
    assert [event["kind"] for event in skill_events] == [
        "skill.started",
        "skill.completed",
    ]
    assert all(event["skill_name"] == "route-skills" for event in skill_events)
    assert all("command" not in event for event in skill_events)
    assert all("content" not in event for event in skill_events)


def test_pi_skill_read_keeps_only_the_skill_name(tmp_path: Path) -> None:
    client = RecordingClient()
    worker = WorkerConfig.model_validate(
        {
            "name": "pi-1",
            "type": "pi",
            "task_types": ["explore"],
            "max_running": 1,
            "priority": 0,
            "env": {},
        }
    )
    publisher = AuditPublisher(
        client,
        "proj_001",
        "i001",
        worker,
        "explore_execute",
        str(tmp_path),
        "prompt",
    )
    for payload in (
        {
            "type": "tool_execution_start",
            "toolName": "read",
            "toolCallId": "skill-1",
            "args": {
                "path": "/workspace/.agents/skills/route-skills/SKILL.md"
            },
        },
        {
            "type": "tool_execution_end",
            "toolName": "read",
            "toolCallId": "skill-1",
            "result": "secret skill instructions",
            "isError": False,
        },
    ):
        publisher.handle_output("stdout", json.dumps(payload))
    publisher.finish(ProcessResult(returncode=0, stdout="", stderr=""))
    publisher.close()

    skill_events = [
        event
        for _, batch in client.batches
        for event in batch
        if event["kind"].startswith("skill.")
    ]
    assert [event["kind"] for event in skill_events] == [
        "skill.started",
        "skill.completed",
    ]
    assert all(event["skill_name"] == "route-skills" for event in skill_events)
    assert all("arguments" not in event for event in skill_events)
    assert all("content" not in event for event in skill_events)


def test_provider_tool_outputs_are_not_truncated_at_32_kib() -> None:
    content = "完整输出" * (12 * 1024)
    cases = [
        (
            "claudecode",
            {
                "type": "user",
                "message": {
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": "tool-1",
                            "content": content,
                        }
                    ]
                },
            },
        ),
        (
            "codex",
            {
                "type": "item.completed",
                "item": {
                    "id": "tool-1",
                    "type": "mcp_tool_call",
                    "tool": "example",
                    "result": content,
                    "status": "completed",
                },
            },
        ),
        (
            "pi",
            {
                "type": "tool_execution_end",
                "toolName": "example",
                "toolCallId": "tool-1",
                "result": content,
                "isError": False,
            },
        ),
    ]

    for provider, payload in cases:
        events = normalize_event(provider, json.dumps(payload, ensure_ascii=False))
        assert events[0]["content"] == content
        assert "output truncated for audit UI" not in events[0]["content"]


def test_static_audit_command_expands_without_ellipsis() -> None:
    static_dir = Path(__file__).parents[1] / "src" / "redtrace" / "server" / "static"
    index = (static_dir / "index.html").read_text(encoding="utf-8")
    styles = (static_dir / "audit.css").read_text(encoding="utf-8")

    assert "audit-command-text min-w-0 flex-1" in index
    assert ".audit-command-text" in styles
    assert ".audit-terminal[open] .audit-command-text" in styles
    assert "white-space: pre-wrap" in styles


def test_static_audit_hides_claude_skill_plugin_namespace() -> None:
    static_dir = Path(__file__).parents[1] / "src" / "redtrace" / "server" / "static"
    index = (static_dir / "index.html").read_text(encoding="utf-8")
    audit = (static_dir / "audit.js").read_text(encoding="utf-8")

    assert 'x-text="displaySkillName(event)"' in index
    assert "加载中" not in index
    assert "replace(/^redtrace-capabilities:/, '')" in audit
    assert "['tool.started', 'tool.completed'].includes(event.kind)" in audit
    assert "(?:launching|loading)\\s+skill:" in audit
    assert "/static/audit.js?v=20260810-performance-1" in index


def test_static_audit_batches_frames_and_bounds_live_history() -> None:
    static_dir = Path(__file__).parents[1] / "src" / "redtrace" / "server" / "static"
    audit = (static_dir / "audit.js").read_text(encoding="utf-8")

    assert "EVENT_BUFFER_LIMIT: 2000" in audit
    assert "requestAnimationFrame(() =>" in audit
    assert "this.trimEventBuffer()" in audit
    assert "this.events.splice(0, this.events.length - limit)" in audit


def test_successful_worker_stderr_is_not_rendered_as_worker_error(
    tmp_path: Path,
) -> None:
    cases = (
        (
            "codex",
            "Reading additional input from stdin...\nERROR codex_core::tools::router",
        ),
        (
            "pi",
            "added 94 packages, and audited 95 packages in 13s\n"
            "found 0 vulnerabilities",
        ),
    )

    for provider, stderr in cases:
        client = RecordingClient()
        worker = WorkerConfig.model_validate(
            {
                "name": f"{provider}-1",
                "type": provider,
                "task_types": ["explore"],
                "max_running": 1,
                "priority": 0,
                "env": {},
            }
        )
        publisher = AuditPublisher(
            client,
            "proj_001",
            "i001",
            worker,
            "explore_execute",
            str(tmp_path),
            "prompt",
        )
        publisher.finish(ProcessResult(returncode=0, stdout="", stderr=stderr))
        publisher.close()

        events = [event for _, batch in client.batches for event in batch]
        assert not any(event["kind"] in {"stderr", "error"} for event in events)


def test_failed_worker_stderr_is_preserved_as_error(tmp_path: Path) -> None:
    client = RecordingClient()
    worker = WorkerConfig.model_validate(
        {
            "name": "pi-1",
            "type": "pi",
            "task_types": ["explore"],
            "max_running": 1,
            "priority": 0,
            "env": {},
        }
    )
    publisher = AuditPublisher(
        client,
        "proj_001",
        "i001",
        worker,
        "explore_execute",
        str(tmp_path),
        "prompt",
    )
    publisher.finish(
        ProcessResult(returncode=1, stdout="", stderr="npm ERR! install failed")
    )
    publisher.close()

    events = [event for _, batch in client.batches for event in batch]
    errors = [event for event in events if event["kind"] == "error"]
    assert [event["content"] for event in errors] == ["npm ERR! install failed"]


def test_audit_publisher_batches_unredacted_run_events(tmp_path: Path) -> None:
    client = RecordingClient()
    worker = WorkerConfig.model_validate(
        {
            "name": "codex-1",
            "type": "codex",
            "task_types": ["explore"],
            "max_running": 1,
            "priority": 0,
            "env": {},
        }
    )
    publisher = AuditPublisher(
        client,
        "proj_001",
        "i001",
        worker,
        "explore_execute",
        str(tmp_path),
        "API_KEY=do-not-log",
    )
    publisher.handle_output(
        "stdout",
        json.dumps(
            {
                "type": "item.completed",
                "item": {
                    "id": "m1",
                    "type": "mcp_tool_call",
                    "tool": "example",
                    "arguments": {"token": "abc123"},
                    "result": "authorization: bearer-secret",
                    "status": "completed",
                },
            }
        ),
    )
    publisher.finish(ProcessResult(returncode=0, stdout="", stderr=""))
    publisher.close()

    events = [event for _, batch in client.batches for event in batch]
    serialized = json.dumps(events)
    assert {"run.started", "user.message", "tool.completed", "run.completed"} <= {
        event["kind"] for event in events
    }
    assert "do-not-log" in serialized
    assert "bearer-secret" in serialized
    assert "[REDACTED]" not in serialized


def test_audit_publisher_flushes_large_assistant_text_in_bounded_chunks(
    tmp_path: Path,
) -> None:
    client = RecordingClient()
    worker = WorkerConfig.model_validate(
        {
            "name": "claude-1",
            "type": "claudecode",
            "task_types": ["explore"],
            "max_running": 1,
            "priority": 0,
            "env": {},
        }
    )
    publisher = AuditPublisher(
        client,
        "proj_001",
        "i001",
        worker,
        "explore_execute",
        str(tmp_path),
        "prompt",
    )
    content = "a" * (40 * 1024)
    publisher.handle_output(
        "stdout",
        json.dumps(
            {
                "type": "stream_event",
                "event": {
                    "type": "content_block_delta",
                    "delta": {"type": "text_delta", "text": content},
                },
            }
        ),
    )
    publisher.handle_output("stdout", TRUNCATED_STREAM_LINE)
    publisher.finish(ProcessResult(returncode=0, stdout="", stderr=""))
    publisher.close()

    messages = [
        event
        for _, batch in client.batches
        for event in batch
        if event["kind"] == "assistant.message" and event.get("persist_only")
    ]
    assert len(messages) == 2
    assert all(len(event["content"]) <= 32 * 1024 for event in messages)
    assert "".join(event["content"] for event in messages) == content
    assert any(
        event["kind"] == "output.truncated"
        for _, batch in client.batches
        for event in batch
    )


def _events_of(client: "RecordingClient") -> list[dict]:
    return [event for _, batch in client.batches for event in batch]


def test_claude_thinking_blocks_become_thinking_events(tmp_path: Path) -> None:
    client = RecordingClient()
    worker = WorkerConfig.model_validate(
        {
            "name": "claude-1",
            "type": "claudecode",
            "task_types": ["explore"],
            "max_running": 1,
            "priority": 0,
            "env": {},
        }
    )
    publisher = AuditPublisher(
        client,
        "proj_001",
        "i001",
        worker,
        "explore_execute",
        str(tmp_path),
        "prompt",
    )
    payloads = [
        {
            "type": "stream_event",
            "event": {
                "type": "content_block_start",
                "index": 0,
                "content_block": {"type": "thinking", "thinking": ""},
            },
        },
        {
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "thinking_delta", "thinking": "Let me "},
            },
        },
        {
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "thinking_delta", "thinking": "analyze this."},
            },
        },
        {
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "signature_delta", "signature": "sig"},
            },
        },
        {
            "type": "stream_event",
            "event": {"type": "content_block_stop", "index": 0},
        },
    ]
    for payload in payloads:
        publisher.handle_output("stdout", json.dumps(payload, ensure_ascii=False))
    publisher.finish(ProcessResult(returncode=0, stdout="", stderr=""))
    publisher.close()

    events = _events_of(client)
    deltas = [event for event in events if event["kind"] == "thinking.delta"]
    assert [event["content"] for event in deltas] == ["Let me ", "analyze this."]
    messages = [
        event
        for event in events
        if event["kind"] == "thinking.message" and event.get("persist_only")
    ]
    assert [event["content"] for event in messages] == ["Let me analyze this."]
    # The completion marker is a flush signal, never displayed or persisted.
    completed = [event for event in events if event["kind"] == "thinking.completed"]
    assert len(completed) == 1
    assert "content" not in completed[0]


def test_codex_reasoning_summary_becomes_thinking_message() -> None:
    events = normalize_event(
        "codex",
        json.dumps(
            {
                "type": "item.completed",
                "item": {
                    "id": "rs-1",
                    "type": "reasoning",
                    "summary": [
                        {"type": "summary_text", "text": "Step one."},
                        {"type": "summary_text", "text": "Step two."},
                    ],
                    "encrypted_content": "opaque",
                },
            }
        ),
    )

    assert events == [
        {
            "kind": "thinking.message",
            "timestamp": events[0]["timestamp"],
            "role": "assistant",
            "content": "Step one.\n\nStep two.",
            "message_id": "rs-1",
        }
    ]


def test_codex_reasoning_without_summary_is_ignored() -> None:
    events = normalize_event(
        "codex",
        json.dumps(
            {
                "type": "item.completed",
                "item": {"id": "rs-2", "type": "reasoning", "summary": []},
            }
        ),
    )
    assert events == []


def test_pi_streamed_thinking_flushes_a_single_message(tmp_path: Path) -> None:
    client = RecordingClient()
    worker = WorkerConfig.model_validate(
        {
            "name": "pi-1",
            "type": "pi",
            "task_types": ["explore"],
            "max_running": 1,
            "priority": 0,
            "env": {},
        }
    )
    publisher = AuditPublisher(
        client,
        "proj_001",
        "i001",
        worker,
        "explore_execute",
        str(tmp_path),
        "prompt",
    )
    for payload in (
        {
            "type": "message_update",
            "assistantMessageEvent": {
                "type": "thinking_delta",
                "delta": "考虑",
            },
        },
        {
            "type": "message_update",
            "assistantMessageEvent": {
                "type": "thinking_delta",
                "delta": "一下。",
            },
        },
        {
            "type": "message_update",
            "assistantMessageEvent": {
                "type": "thinking_end",
                "content": "考虑一下。",
            },
        },
    ):
        publisher.handle_output("stdout", json.dumps(payload, ensure_ascii=False))
    publisher.finish(ProcessResult(returncode=0, stdout="", stderr=""))
    publisher.close()

    events = _events_of(client)
    deltas = [event for event in events if event["kind"] == "thinking.delta"]
    assert [event["content"] for event in deltas] == ["考虑", "一下。"]
    messages = [
        event
        for event in events
        if event["kind"] == "thinking.message" and event.get("persist_only")
    ]
    assert [event["content"] for event in messages] == ["考虑一下。"]


def test_pi_thinking_end_without_deltas_keeps_full_text() -> None:
    events = normalize_event(
        "pi",
        json.dumps(
            {
                "type": "message_update",
                "assistantMessageEvent": {
                    "type": "thinking_end",
                    "content": "完整思考内容",
                },
            },
            ensure_ascii=False,
        ),
    )

    assert len(events) == 1
    assert events[0]["kind"] == "thinking.message"
    assert events[0]["content"] == "完整思考内容"
    assert not events[0].get("persist_only")


def test_static_audit_renders_thinking_cards() -> None:
    static_dir = Path(__file__).parents[1] / "src" / "redtrace" / "server" / "static"
    index = (static_dir / "index.html").read_text(encoding="utf-8")
    audit = (static_dir / "audit.js").read_text(encoding="utf-8")
    styles = (static_dir / "audit.css").read_text(encoding="utf-8")
    theme = (static_dir / "redtrace-theme.css").read_text(encoding="utf-8")

    assert "isThinking(event)" in index
    assert 'class="audit-terminal audit-thinking overflow-hidden"' in index
    assert ':open="isThinkingOpen(event)"' in index
    assert '@click.prevent="toggleThinking(event)"' in index
    assert ':aria-expanded="isThinkingOpen(event)"' in index
    assert "展开/收起" not in index
    assert "<span class=\"audit-command-text min-w-0 flex-1\">思考</span>" in index
    assert "<details class=\"audit-terminal audit-thinking overflow-hidden\" open>" not in index
    assert "isThinking(event)" in audit
    assert "toggleThinking(event)" in audit
    assert "'thinking.message': '思考'" in audit
    assert "'thinking.delta': '思考'" in audit
    assert ".audit-thinking" in styles
    assert ".audit-thinking" in theme
    assert "/static/audit.js?v=20260810-performance-1" in index


def test_worker_drivers_run_at_maximum_thinking_strength() -> None:
    from redtrace.dispatcher.workers.adapters.claudecode import (
        CLAUDE_MAX_THINKING_TOKENS,
        ClaudeCodeDriver,
    )
    from redtrace.dispatcher.workers.adapters.codex import CodexDriver
    from redtrace.dispatcher.workers.adapters.pi import PiDriver

    claude_worker = WorkerConfig.model_validate(
        {
            "name": "claude-1",
            "type": "claudecode",
            "task_types": ["explore"],
            "max_running": 1,
            "priority": 0,
            "env": {
                "ANTHROPIC_MODEL": "model",
                "ANTHROPIC_BASE_URL": "http://api",
                "ANTHROPIC_AUTH_TOKEN": "secret",
            },
        }
    )
    # Claude thinking is injected into the process environment, not argv.
    assert CLAUDE_MAX_THINKING_TOKENS == "31999"
    claude_argv = ClaudeCodeDriver().build_execute(claude_worker, "prompt", "session").argv
    assert "MAX_THINKING_TOKENS" not in claude_argv

    codex_worker = claude_worker.model_copy(
        update={
            "name": "codex-1",
            "type": "codex",
            "env": {
                "CODEX_MODEL": "model",
                "CODEX_BASE_URL": "http://api",
                "OPENAI_API_KEY": "secret",
            },
        }
    )
    for argv in (
        CodexDriver().build_execute(codex_worker, "prompt", None).argv,
        CodexDriver().build_conclude(codex_worker, "prompt", "thread-1").argv,
    ):
        assert 'model_reasoning_effort="high"' in argv
        assert 'model_reasoning_summary="always"' in argv

    pi_worker = claude_worker.model_copy(
        update={
            "name": "pi-1",
            "type": "pi",
            "env": {
                "PI_MODEL": "model",
                "PI_BASE_URL": "http://api",
                "PI_API_KEY": "secret",
                "PI_PROVIDER_API": "openai-completions",
            },
        }
    )
    for argv in (
        PiDriver().build_execute(pi_worker, "prompt", None).argv,
        PiDriver().build_conclude(pi_worker, "prompt", "session-1").argv,
        PiDriver(local=True)._local_argv(pi_worker, "prompt", None),
    ):
        assert argv[argv.index("--thinking") + 1] == "max"

    overridden = pi_worker.model_copy(
        update={"env": {**pi_worker.env, "REDTRACE_PI_THINKING_LEVEL": "high"}}
    )
    argv = PiDriver().build_execute(overridden, "prompt", None).argv
    assert argv[argv.index("--thinking") + 1] == "high"
