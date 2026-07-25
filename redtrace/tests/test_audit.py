from __future__ import annotations

import json
from pathlib import Path

from redtrace.dispatcher.audit import AuditPublisher, normalize_event
from redtrace.dispatcher.config import WorkerConfig
from redtrace.dispatcher.runtime.process import ProcessResult


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
