"""Local output-contract regression tests.

The RedTrace contract (``parse_json_output`` + ``validate_*_payload``)
stays local: no task type depends on provider structured output, and
provider errors must never leak into the contract parser.
"""
from __future__ import annotations

import pytest

from redtrace.dispatcher.contracts import (
    parse_json_output,
    validate_explore_payload,
    validate_reason_payload,
    validate_bootstrap_execute_payload,
    validate_bootstrap_conclude_payload,
)
from redtrace.dispatcher.workers.base import ProviderError


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



# ── Normal accepted JSON passes the local contract ───────────────────────

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


# ── Fenced JSON extracted by the local parser ─────────────────────────────

def test_fenced_json_explore() -> None:
    raw = 'Here is my result:\n```json\n{"accepted": True, "data": {"description": "fenced fact"}}\n```\nDone.'
    payload = parse_json_output(raw)
    kind, description = validate_explore_payload(payload)
    assert kind == "fact"
    assert description == "fenced fact"


def test_fenced_json_without_language_tag() -> None:
    raw = '```\n{"accepted": True, "data": {"description": "no-lang"}}\n```'
    payload = parse_json_output(raw)
    kind, description = validate_explore_payload(payload)
    assert kind == "fact"
    assert description == "no-lang"


# ── Invalid JSON enters conclude fallback (contract_error) ────────────────

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


# ── Provider error must NOT enter contract parser ────────────────────────







def test_provider_error_preserves_raw_code_and_message() -> None:
    exc = ProviderError("responses_feature_not_supported", "json_schema not supported")
    assert exc.code == "responses_feature_not_supported"
    assert exc.message == "json_schema not supported"
    assert "responses_feature_not_supported" in str(exc)
    assert "json_schema not supported" in str(exc)


# ── MiMo-style providers (text/json_object only) ──────────────────────────

def test_mimo_json_object_output_passes_local_contract() -> None:
    """MiMo returns text/json_object content (no json_schema), which the
    local contract must accept."""
    raw = '{"accepted": True, "data": {"description": "mimo fact"}}'
    payload = parse_json_output(raw)
    kind, description = validate_explore_payload(payload)
    assert kind == "fact"
    assert description == "mimo fact"


def test_mimo_json_object_with_reasoning_noise() -> None:
    """MiMo may include non-JSON reasoning text before the JSON; parser must extract."""
    raw = (
        'Let me analyze this step by step.\n'
        'After reviewing the target...\n\n'
        '{"accepted": True, "data": {"description": "mimo with noise"}}'
    )
    payload = parse_json_output(raw)
    kind, description = validate_explore_payload(payload)
    assert kind == "fact"
    assert description == "mimo with noise"




# ── No task type depends on provider structured output ────────────────────

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
