from __future__ import annotations

import json
import socket
from types import SimpleNamespace

import pytest
from redtrace.dispatcher.contracts import (
    parse_json_output,
    validate_explore_payload,
    validate_reason_payload,
)
from redtrace.dispatcher.runtime.process import ManagedProcess
from redtrace.dispatcher.workers.adapters.pi import PiDriver


def test_parse_json_output_extracts_object_from_markdown_noise() -> None:
    assert parse_json_output(
        'result:\n```json\n{"accepted": true, "data": {}}\n```'
    ) == {
        "accepted": True,
        "data": {},
    }


def test_reason_payload_limits_number_of_intents() -> None:
    kind, intents = validate_reason_payload(
        {
            "accepted": True,
            "data": {
                "intents": [
                    {"from": ["f001"], "description": "one"},
                    {"from": ["f001"], "description": "two"},
                ]
            },
        },
        open_intents_empty=True,
        max_intents=1,
    )

    assert kind == "intents"
    assert intents == [{"from": ["f001"], "description": "one"}]


def test_reason_payload_requires_intent_when_none_are_open() -> None:
    with pytest.raises(ValueError, match="intents is required"):
        validate_reason_payload(
            {"accepted": True, "data": {}},
            open_intents_empty=True,
            max_intents=3,
        )


def test_reason_payload_rejects_goal_as_a_source() -> None:
    with pytest.raises(ValueError, match="invalid fact IDs: goal"):
        validate_reason_payload(
            {
                "accepted": True,
                "data": {
                    "intents": [{"from": ["goal"], "description": "invalid"}]
                },
            },
            open_intents_empty=True,
            max_intents=1,
            valid_fact_ids={"origin", "f001"},
        )


def test_explore_payload_rejects_planning_text() -> None:
    with pytest.raises(ValueError):
        validate_explore_payload(
            parse_json_output("Need inspect files and keep working.")
        )


def test_pi_driver_extracts_session_and_last_assistant_text() -> None:
    driver = PiDriver()
    stdout = "\n".join(
        [
            json.dumps({"type": "session", "id": "session-123"}),
            json.dumps(
                {
                    "type": "turn_end",
                    "message": {
                        "role": "assistant",
                        "content": [
                            {"type": "text", "text": '{"accepted":true,"data":{}}'}
                        ],
                    },
                }
            ),
        ]
    )

    assert driver.extract_session(None, stdout, "") == "session-123"
    assert driver.extract_response_text(stdout, "") == '{"accepted":true,"data":{}}'


def test_pi_driver_prefers_final_message_end_over_protocol_summaries() -> None:
    driver = PiDriver()
    good = {"role": "assistant", "content": [{"type": "text", "text": '{"accepted":true,"data":{}}'}]}
    bad = {"role": "assistant", "content": [{"type": "text", "text": '{"accepted":"yes"}'}]}
    stdout = "\n".join(
        json.dumps(event)
        for event in (
            {"type": "message_end", "message": good},
            {"type": "agent_end", "messages": [bad]},
        )
    )

    assert driver.extract_response_text(stdout, "") == '{"accepted":true,"data":{}}'


def test_close_stream_closes_response_even_when_stream_close_fails() -> None:
    class Response:
        def __init__(self) -> None:
            self.closed = False

        def close(self) -> None:
            self.closed = True

    class Stream:
        def __init__(self) -> None:
            self._response = Response()

        def close(self) -> None:
            raise ValueError("already closed")

    stream = Stream()
    ManagedProcess._close_stream(stream)

    assert stream._response.closed


def test_managed_process_writes_and_half_closes_live_stdin() -> None:
    class Stream:
        def __init__(self) -> None:
            self.data = b""
            self.shutdown_mode = None

        def sendall(self, data: bytes) -> None:
            self.data += data

        def shutdown(self, mode: int) -> None:
            self.shutdown_mode = mode

    process = ManagedProcess(
        SimpleNamespace(client=SimpleNamespace(api=None)),
        ["worker"],
        {},
        keep_stdin_open=True,
    )
    stream = Stream()
    process._socket = stream

    assert process.send_stdin("signal\n")
    process.close_stdin()
    assert stream.data == b"signal\n"
    assert stream.shutdown_mode == socket.SHUT_WR
