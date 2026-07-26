from __future__ import annotations

import json
from pathlib import Path

from redtrace.dispatcher.audit import AuditPublisher, normalize_event
from redtrace.dispatcher.config import WorkerConfig
from redtrace.dispatcher.runtime.process import ProcessResult
from redtrace.dispatcher.runtime.stream_buffer import TRUNCATED_STREAM_LINE


class RecordingClient:
    def __init__(self) -> None:
        self.batches: list[tuple[dict, list[dict]]] = []

    def append_audit_events(self, run: dict, events: list[dict]) -> None:
        self.batches.append((dict(run), [dict(event) for event in events]))


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


def test_successful_codex_router_stderr_is_not_rendered_as_worker_error(
    tmp_path: Path,
) -> None:
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
    publisher.finish(
        ProcessResult(
            returncode=0,
            stdout="",
            stderr="Reading additional input from stdin...\nERROR codex_core::tools::router",
        )
    )
    publisher.close()

    events = [event for _, batch in client.batches for event in batch]
    assert not any(event["kind"] in {"stderr", "error"} for event in events)


def test_audit_publisher_batches_redacted_run_events(tmp_path: Path) -> None:
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
                "item": {"id": "m1", "type": "agent_message", "text": "done"},
            }
        ),
    )
    publisher.finish(ProcessResult(returncode=0, stdout="", stderr=""))
    publisher.close()

    events = [event for _, batch in client.batches for event in batch]
    assert {"run.started", "user.message", "assistant.message", "run.completed"} <= {
        event["kind"] for event in events
    }
    assert "do-not-log" not in json.dumps(events)


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
