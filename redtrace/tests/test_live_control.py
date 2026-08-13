from __future__ import annotations

import json

from redtrace.dispatcher.workers.live import (
    ClaudeLiveControl,
    CodexLiveControl,
    PiLiveControl,
)


class FakeProcess:
    def __init__(self):
        self.writes: list[dict] = []
        self.closed = 0

    def send_stdin(self, line: str) -> bool:
        self.writes.append(json.loads(line))
        return True

    def close_stdin(self) -> None:
        self.closed += 1


def emit(control, payload: dict) -> None:
    control.handle_output("stdout", json.dumps(payload))


def test_pi_uses_native_steer_without_closing_process() -> None:
    process = FakeProcess()
    control = PiLiveControl("initial")
    control.attach(process)

    assert control.send_signal("optional fact")
    assert process.writes == [{"type": "steer", "message": "optional fact"}]
    assert process.closed == 0

    emit(
        control,
        {
            "type": "response",
            "command": "get_state",
            "data": {"sessionId": "pi-session", "sessionFile": "/sessions/pi.jsonl"},
        },
    )
    emit(control, {"type": "agent_settled"})
    assert control.session_id == "pi-session"
    assert control.session_file == "/sessions/pi.jsonl"
    assert process.closed == 1


def test_claude_streams_signal_and_waits_for_both_results() -> None:
    process = FakeProcess()
    control = ClaudeLiveControl("initial", "claude-session")
    control.attach(process)

    assert control.send_signal("optional fact")
    assert process.writes[0]["type"] == "user"
    assert process.writes[0]["message"]["content"] == "optional fact"
    emit(control, {"type": "result", "session_id": "claude-session"})
    assert process.closed == 0
    emit(control, {"type": "result", "session_id": "claude-session"})
    assert process.closed == 1


def test_codex_queues_signal_until_active_turn_then_uses_turn_steer() -> None:
    process = FakeProcess()
    control = CodexLiveControl("initial", model="gpt-test", output_schema={})
    control.attach(process)

    assert control.send_signal("optional fact")
    assert process.writes == []
    emit(control, {"id": 1, "result": {}})
    assert [message["method"] for message in process.writes] == [
        "initialized",
        "thread/start",
    ]
    emit(control, {"id": 2, "result": {"thread": {"id": "thread-1"}}})
    assert process.writes[-1]["method"] == "turn/start"
    assert process.writes[-1]["params"]["input"][0]["text"] == "initial"
    emit(control, {"id": 3, "result": {"turn": {"id": "turn-1"}}})

    steer = process.writes[-1]
    assert steer["method"] == "turn/steer"
    assert steer["params"]["threadId"] == "thread-1"
    assert steer["params"]["expectedTurnId"] == "turn-1"
    assert steer["params"]["input"][0]["text"] == "optional fact"
    assert process.closed == 0

    emit(control, {"method": "turn/completed", "params": {}})
    assert process.closed == 1
