"""Regression tests for Codex output-protocol rollback to Cairn design.

Codex must NOT send ``outputSchema`` in ``turn/start``.  The RedTrace
contract (``parse_json_output`` + ``validate_*_payload``) stays local.
Provider errors must never leak into the contract parser.
"""
from __future__ import annotations

import json

import pytest

from redtrace.dispatcher.contracts import (
    parse_json_output,
    validate_explore_payload,
    validate_reason_payload,
    validate_bootstrap_execute_payload,
    validate_bootstrap_conclude_payload,
)
from redtrace.dispatcher.workers.adapters.codex import CodexDriver
from redtrace.dispatcher.workers.base import ProviderError, REDTRACE_OUTPUT_SCHEMA_OBJECT
from redtrace.dispatcher.workers.live import CodexLiveControl


# ── helpers ────────────────────────────────────────────────────────────────

class FakeProcess:
    """Minimal process stub that records stdin writes."""
    def __init__(self):
        self.writes: list[dict] = []
        self.closed = 0

    def send_stdin(self, line: str) -> bool:
        self.writes.append(json.loads(line))
        return True

    def close_stdin(self) -> None:
        self.closed += 1


def _emit(control: CodexLiveControl, payload: dict) -> None:
    control.handle_output("stdout", json.dumps(payload))


def _codex_stdout(*events: dict) -> str:
    return "\n".join(json.dumps(e, ensure_ascii=False) for e in events)


def _item_completed(text: str, *, method_style: bool = False) -> dict:
    if method_style:
        return {
            "method": "item/completed",
            "params": {"item": {"type": "agentMessage", "text": text}},
        }
    return {
        "type": "item.completed",
        "item": {"type": "agent_message", "text": text},
    }


# ── 1. CodexLiveControl turn/start must NOT contain outputSchema ──────────

def test_turn_start_has_no_output_schema() -> None:
    """turn/start.params must never include outputSchema."""
    process = FakeProcess()
    control = CodexLiveControl("hello", model="gpt-test")
    control.attach(process)

    # Trigger initialize → thread/start → turn/start
    _emit(control, {"id": 1, "result": {}})
    _emit(control, {"id": 2, "result": {"thread": {"id": "t1"}}})
    # The turn/start is the last write before turn result
    turn_start = next(
        w for w in process.writes if w.get("method") == "turn/start"
    )
    assert "outputSchema" not in turn_start["params"], (
        "turn/start must not contain outputSchema"
    )


# ── 2. CodexDriver does not pass REDTRACE_OUTPUT_SCHEMA_OBJECT ────────────

def test_codex_driver_build_execute_no_output_schema() -> None:
    """CodexDriver._build_live must not inject output_schema."""
    from redtrace.dispatcher.config import WorkerConfig

    worker = WorkerConfig(
        name="test",
        type="codex",
        max_running=1,
        priority=50,
        env={
            "CODEX_BASE_URL": "http://localhost:8080",
            "OPENAI_API_KEY": "sk-test",
            "CODEX_MODEL": "gpt-test",
        },
    )
    driver = CodexDriver()
    result = driver.build_execute(worker, "prompt", None, task_type="explore")
    control = result.live_control
    assert isinstance(control, CodexLiveControl)
    assert not hasattr(control, "output_schema") or control.output_schema is None


def test_codex_driver_does_not_import_schema_object() -> None:
    """codex.py must not import REDTRACE_OUTPUT_SCHEMA_OBJECT."""
    import redtrace.dispatcher.workers.adapters.codex as codex_mod
    assert not hasattr(codex_mod, "REDTRACE_OUTPUT_SCHEMA_OBJECT")


# ── 3. Normal accepted JSON passes local contract ────────────────────────

def test_normal_explore_accepted_passes_contract() -> None:
    payload = {"accepted": True, "data": {"description": "test fact"}}
    kind, description = validate_explore_payload(payload)
    assert kind == "fact"
    assert description == "test fact"


def test_normal_reason_accepted_passes_contract() -> None:
    payload = {
        "accepted": True,
        "data": {"intents": [{"from": ["f1"], "description": "desc"}]},
    }
    kind, intents = validate_reason_payload(payload)
    assert kind == "intents"
    assert len(intents) == 1


def test_bootstrap_execute_accepted_passes_contract() -> None:
    payload = {
        "accepted": True,
        "data": {
            "fact": {"description": "found something"},
            "complete": {"description": "done"},
        },
    }
    kind, data = validate_bootstrap_execute_payload(payload)
    assert kind == "complete"
    assert data["fact_description"] == "found something"


def test_bootstrap_conclude_accepted_passes_contract() -> None:
    payload = {
        "accepted": True,
        "data": {"fact": {"description": "concluded fact"}},
    }
    kind, description = validate_bootstrap_conclude_payload(payload)
    assert kind == "fact"
    assert description == "concluded fact"


# ── 4. Fenced JSON extracted by local parser ─────────────────────────────

def test_fenced_json_explore() -> None:
    raw = 'Here is my result:\n```json\n{"accepted": true, "data": {"description": "fenced fact"}}\n```\nDone.'
    payload = parse_json_output(raw)
    kind, description = validate_explore_payload(payload)
    assert kind == "fact"
    assert description == "fenced fact"


def test_fenced_json_without_language_tag() -> None:
    raw = '```\n{"accepted": true, "data": {"description": "no-lang"}}\n```'
    payload = parse_json_output(raw)
    kind, description = validate_explore_payload(payload)
    assert kind == "fact"
    assert description == "no-lang"


# ── 5. Invalid JSON enters conclude fallback (contract_error) ────────────

def test_unparseable_json_raises_value_error() -> None:
    with pytest.raises(ValueError, match="no JSON object found"):
        parse_json_output("I'm still thinking about this...")


def test_missing_accepted_field_raises() -> None:
    """A payload without 'accepted' and not matching any heuristic raises."""
    with pytest.raises(ValueError, match="accepted must be true or false"):
        validate_explore_payload({"random_key": "random_value", "foo": 42})


def test_explore_wrong_shape_raises() -> None:
    with pytest.raises(ValueError):
        validate_explore_payload({"accepted": True, "data": {"wrong_key": 1}})


# ── 6. Provider error must NOT enter contract parser ─────────────────────

def test_codex_extract_raises_provider_error_on_error_event() -> None:
    """A Codex error event with no agent message must raise ProviderError."""
    driver = CodexDriver()
    stdout = _codex_stdout(
        {"type": "error", "code": "responses_feature_not_supported",
         "message": "text.format type 'json_schema' is not supported"},
    )
    with pytest.raises(ProviderError) as exc_info:
        driver.extract_response_text(stdout, "")
    assert "responses_feature_not_supported" in exc_info.value.code
    assert "json_schema" in exc_info.value.message


def test_codex_extract_raises_provider_error_on_dict_error_field() -> None:
    """An event with {'error': {'code': ..., 'message': ...}} raises ProviderError."""
    driver = CodexDriver()
    stdout = _codex_stdout(
        {"id": 3, "error": {"code": "turn_failed", "message": "rate limit exceeded"}},
    )
    with pytest.raises(ProviderError) as exc_info:
        driver.extract_response_text(stdout, "")
    assert "rate limit" in exc_info.value.message


def test_codex_extract_raises_provider_error_on_turn_failed() -> None:
    driver = CodexDriver()
    stdout = _codex_stdout(
        {"method": "turn/start/failed", "params": {"error": {"message": "upstream 500"}}},
    )
    with pytest.raises(ProviderError) as exc_info:
        driver.extract_response_text(stdout, "")
    assert "upstream 500" in exc_info.value.message


def test_codex_extract_raises_on_known_provider_pattern_in_raw_stdout() -> None:
    """Even without structured events, known error patterns trigger ProviderError."""
    driver = CodexDriver()
    stdout = '{"error": "text.format type \'json_schema\' is not supported"}'
    with pytest.raises(ProviderError) as exc_info:
        driver.extract_response_text(stdout, "")
    assert "json_schema" in str(exc_info.value).lower()


def test_codex_extract_does_not_raise_when_agent_message_present() -> None:
    """When a valid agent message exists, errors are ignored."""
    driver = CodexDriver()
    stdout = _codex_stdout(
        {"type": "error", "code": "transient", "message": "retry"},
        _item_completed('{"accepted":true,"data":{"description":"ok"}}'),
    )
    result = driver.extract_response_text(stdout, "")
    assert result == '{"accepted":true,"data":{"description":"ok"}}'


def test_provider_error_preserves_raw_code_and_message() -> None:
    exc = ProviderError("responses_feature_not_supported", "json_schema not supported")
    assert exc.code == "responses_feature_not_supported"
    assert exc.message == "json_schema not supported"
    assert "responses_feature_not_supported" in str(exc)
    assert "json_schema not supported" in str(exc)


# ── 7. MiMo-style providers (text/json_object only) ─────────────────────

def test_mimo_json_object_output_passes_local_contract() -> None:
    """MiMo returns text/json_object content (no json_schema), which the
    local contract must accept."""
    raw = '{"accepted": true, "data": {"description": "mimo fact"}}'
    payload = parse_json_output(raw)
    kind, description = validate_explore_payload(payload)
    assert kind == "fact"
    assert description == "mimo fact"


def test_mimo_json_object_with_reasoning_noise() -> None:
    """MiMo may include non-JSON reasoning text before the JSON; parser must extract."""
    raw = (
        'Let me analyze this step by step.\n'
        'After reviewing the target...\n\n'
        '{"accepted": true, "data": {"description": "mimo with noise"}}'
    )
    payload = parse_json_output(raw)
    kind, description = validate_explore_payload(payload)
    assert kind == "fact"
    assert description == "mimo with noise"


# ── 8. Codex turn/steer still works ──────────────────────────────────────

def test_codex_steer_works_after_output_schema_removal() -> None:
    """turn/steer must still function after output_schema removal."""
    process = FakeProcess()
    control = CodexLiveControl("initial", model="gpt-test")
    control.attach(process)

    # Complete the handshake
    _emit(control, {"id": 1, "result": {}})
    _emit(control, {"id": 2, "result": {"thread": {"id": "t1"}}})
    _emit(control, {"id": 3, "result": {"turn": {"id": "turn-1"}}})

    assert control.send_signal("blackboard fact r5: new intel")
    steer = process.writes[-1]
    assert steer["method"] == "turn/steer"
    assert steer["params"]["threadId"] == "t1"
    assert steer["params"]["expectedTurnId"] == "turn-1"
    assert "blackboard fact" in steer["params"]["input"][0]["text"]


def test_codex_steer_queues_before_turn_active() -> None:
    """Signals before turn is active are queued and flushed on turn start."""
    process = FakeProcess()
    control = CodexLiveControl("initial", model="gpt-test")
    control.attach(process)

    control.send_signal("queued signal")
    assert process.writes == []  # not yet sent

    _emit(control, {"id": 1, "result": {}})
    _emit(control, {"id": 2, "result": {"thread": {"id": "t1"}}})
    _emit(control, {"id": 3, "result": {"turn": {"id": "turn-1"}}})

    # The queued signal should have been flushed as a turn/steer
    steers = [w for w in process.writes if w.get("method") == "turn/steer"]
    assert len(steers) == 1
    assert "queued signal" in steers[0]["params"]["input"][0]["text"]


# ── 9. Claude/Pi behavior unaffected ─────────────────────────────────────

def test_claude_live_control_unaffected() -> None:
    """ClaudeLiveControl API unchanged — no output_schema parameter."""
    from redtrace.dispatcher.workers.live import ClaudeLiveControl
    process = FakeProcess()
    control = ClaudeLiveControl("test prompt", "session-123")
    control.attach(process)

    assert control.send_signal("signal")
    assert process.writes[0]["type"] == "user"
    assert process.writes[0]["message"]["content"] == "signal"


def test_pi_live_control_unaffected() -> None:
    """PiLiveControl API unchanged — no output_schema parameter."""
    from redtrace.dispatcher.workers.live import PiLiveControl
    process = FakeProcess()
    control = PiLiveControl("test prompt")
    control.attach(process)

    assert control.send_signal("signal")
    assert process.writes[-1] == {"type": "steer", "message": "signal"}


# ── 10. No task type depends on provider structured output ────────────────

def test_reason_unwrapped_json_without_provider_schema() -> None:
    """Reason contract works on plain JSON without provider-enforced schema."""
    payload = {
        "accepted": True,
        "data": {
            "intents": [{"from": ["f1"], "description": "new intent"}],
        },
    }
    kind, intents = validate_reason_payload(payload)
    assert kind == "intents"
    assert intents[0]["description"] == "new intent"


def test_explore_unwrapped_json_without_provider_schema() -> None:
    payload = {"accepted": True, "data": {"description": "explored result"}}
    kind, description = validate_explore_payload(payload)
    assert kind == "fact"
    assert description == "explored result"


def test_bootstrap_execute_unwrapped_json_without_provider_schema() -> None:
    payload = {
        "accepted": True,
        "data": {
            "fact": {"description": "found"},
            "complete": {"description": "done"},
        },
    }
    kind, data = validate_bootstrap_execute_payload(payload)
    assert kind == "complete"
    assert data["fact_description"] == "found"


def test_bootstrap_conclude_unwrapped_json_without_provider_schema() -> None:
    payload = {"accepted": True, "data": {"fact": {"description": "concluded"}}}
    kind, description = validate_bootstrap_conclude_payload(payload)
    assert kind == "fact"
    assert description == "concluded"


def test_rejected_payload_still_works() -> None:
    """Model can still reject via accepted=false."""
    payload = {"accepted": False}
    kind, data = validate_explore_payload(payload)
    assert kind == "rejected"
    assert data is None


# ── bonus: CodexLiveControl constructor signature ─────────────────────────

def test_codex_live_control_has_no_output_schema_param() -> None:
    """CodexLiveControl.__init__ must not accept output_schema."""
    import inspect
    sig = inspect.signature(CodexLiveControl.__init__)
    assert "output_schema" not in sig.parameters, (
        "output_schema parameter must be removed from CodexLiveControl"
    )


def test_codex_live_control_has_no_output_schema_attribute() -> None:
    control = CodexLiveControl("test")
    assert not hasattr(control, "output_schema")


# ── bonus: REDTRACE_OUTPUT_SCHEMA_OBJECT still exists in base ─────────────

def test_schema_object_still_defined_in_base() -> None:
    """Other workers may still use REDTRACE_OUTPUT_SCHEMA_OBJECT."""
    assert isinstance(REDTRACE_OUTPUT_SCHEMA_OBJECT, dict)
    assert REDTRACE_OUTPUT_SCHEMA_OBJECT["type"] == "object"
    assert "accepted" in REDTRACE_OUTPUT_SCHEMA_OBJECT["properties"]
