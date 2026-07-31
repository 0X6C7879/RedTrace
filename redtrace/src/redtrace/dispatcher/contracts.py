from __future__ import annotations

from typing import Any

from redtrace.dispatcher.output_parser import extract_json_object

SKILL_FEEDBACK_KEYS = ("skillFeedback", "skill_feedback")

# Legacy alias → canonical field mapping for agent-produced feedback.
_FEEDBACK_ALIASES: dict[str, str] = {
    # target_skill aliases
    "skill": "target_skill",
    "skillName": "target_skill",
    "skill_name": "target_skill",
    "targetSkill": "target_skill",
    # summary aliases
    "improvement": "summary",
    "lesson": "summary",
    "experience": "summary",
    "insight": "summary",
    # procedure aliases
    "steps": "procedure",
    # evidence_refs aliases
    "evidenceRefs": "evidence_refs",
    "evidence": "evidence_refs",
    # other canonical mappings
    "type": "evolution_type",
    "evolutionType": "evolution_type",
    "proposedName": "proposed_name",
    "mergeSkills": "merge_skills",
    "reuseValidated": "reuse_validated",
}


def parse_json_output(stdout: str) -> dict[str, Any]:
    return extract_json_object(stdout)


def extract_skill_feedback(
    payload: dict[str, Any],
) -> tuple[dict[str, Any] | None, str | None]:
    """Extract optional skill feedback with lenient field requirements.

    Returns (feedback, None) on success or (None, reason) when feedback is
    absent or invalid.  Minimum acceptable feedback requires only
    ``target_skill`` (str) and ``summary`` (str).  All other fields are
    optional and default to empty values.
    """
    raw: Any = None
    for key in SKILL_FEEDBACK_KEYS:
        if key in payload:
            raw = payload.get(key)
            break
    if raw is None and isinstance(payload.get("data"), dict):
        for key in SKILL_FEEDBACK_KEYS:
            if key in payload["data"]:
                raw = payload["data"].get(key)
                break
    if raw is None:
        return None, None  # no feedback emitted — not an error
    if not isinstance(raw, dict):
        return None, "skillFeedback is not an object"
    if not raw:
        return None, "skillFeedback is an empty object"

    # Detect the "satisfaction survey" format some models produce
    # (e.g. {"satisfactory": [...], "unsatisfactory": [...], "missing": [...]}).
    if "satisfactory" in raw or "unsatisfactory" in raw:
        return None, "satisfaction-survey format; expected target_skill + summary"

    # Normalize aliases to canonical field names.
    feedback: dict[str, Any] = {}
    for key, value in raw.items():
        canonical = _FEEDBACK_ALIASES.get(str(key), str(key))
        # First writer wins when multiple aliases map to the same field.
        if canonical not in feedback:
            feedback[canonical] = value

    # Coerce summary-like values that models sometimes emit as non-str.
    summary = feedback.get("summary")
    if not isinstance(summary, str):
        if isinstance(summary, (list, dict)):
            import json as _json
            summary = _json.dumps(summary, ensure_ascii=False)
            feedback["summary"] = summary
        else:
            return None, "summary is missing or not a string"
    if not summary.strip():
        return None, "summary is empty"

    # target_skill: required for routing but accept missing gracefully.
    target = feedback.get("target_skill")
    if not isinstance(target, str) or not target.strip():
        return None, "target_skill is missing or empty"
    feedback["target_skill"] = target.strip().lower()

    # Optional list fields — default to empty lists.
    for list_field in ("procedure", "validation", "evidence_refs"):
        value = feedback.get(list_field)
        if isinstance(value, list):
            feedback[list_field] = [
                item for item in value if isinstance(item, str) and item.strip()
            ][:8]
        elif isinstance(value, str) and value.strip():
            feedback[list_field] = [value.strip()]
        else:
            feedback[list_field] = []

    # Optional scalar fields.
    if not isinstance(feedback.get("impact"), dict):
        feedback.pop("impact", None)
    if not isinstance(feedback.get("confidence"), (int, float)):
        feedback.pop("confidence", None)

    return feedback, None


def _unwrap_wrapped_payload(payload: dict[str, Any]) -> tuple[bool | None, dict[str, Any] | None]:
    accepted = payload.get("accepted")
    if accepted is False:
        return False, None
    if accepted is True:
        data = payload.get("data")
        if not isinstance(data, dict):
            raise ValueError("data must be an object")
        return True, data
    return None, None


def _is_dict(value: Any) -> bool:
    return isinstance(value, dict)


def _without_skill_feedback(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in payload.items()
        if key not in SKILL_FEEDBACK_KEYS
    }


def _looks_like_reason_data(payload: dict[str, Any]) -> bool:
    if not isinstance(payload, dict):
        return False
    payload = _without_skill_feedback(payload)
    keys = set(payload)
    if keys == {"complete"}:
        complete = payload["complete"]
        return isinstance(complete, dict) and "from" in complete and "description" in complete
    if keys == {"intents"}:
        return isinstance(payload["intents"], list)
    if keys == {"intent"}:
        intent = payload["intent"]
        return isinstance(intent, dict) and "from" in intent and "description" in intent
    return False


def _looks_like_bootstrap_execute_data(payload: dict[str, Any]) -> bool:
    payload = _without_skill_feedback(payload)
    if not isinstance(payload, dict) or set(payload) not in ({"fact"}, {"fact", "complete"}):
        return False
    return _is_dict(payload.get("fact")) and ("complete" not in payload or _is_dict(payload.get("complete")))


def _looks_like_bootstrap_conclude_data(payload: dict[str, Any]) -> bool:
    if not isinstance(payload, dict):
        return False
    payload = _without_skill_feedback(payload)
    keys = set(payload)
    if keys not in ({"fact"}, {"fact", "complete"}):
        return False
    return _is_dict(payload.get("fact"))


def _looks_like_explore_data(payload: dict[str, Any]) -> bool:
    return (
        isinstance(payload, dict)
        and set(_without_skill_feedback(payload)) == {"description"}
    )


def validate_reason_payload(
    payload: dict[str, Any], open_intents_empty: bool, max_intents: int,
) -> tuple[str, dict[str, Any] | list[dict[str, Any]] | None]:
    accepted, data = _unwrap_wrapped_payload(payload)
    if accepted is False:
        return "rejected", None
    if accepted is None:
        if not _looks_like_reason_data(payload):
            raise ValueError("accepted must be true or false")
        data = _without_skill_feedback(payload)
    if not isinstance(data, dict):
        raise ValueError("accepted must be true or false")
    complete = data.get("complete")
    intents = data.get("intents")
    # backward compat: accept singular "intent" key from LLMs
    if intents is None:
        singular = data.get("intent")
        if isinstance(singular, dict):
            intents = [singular]
    if complete is not None:
        if intents is not None:
            raise ValueError("complete and intents cannot coexist")
        if not isinstance(complete, dict) or "from" not in complete or "description" not in complete:
            raise ValueError("invalid complete payload")
        return "complete", complete
    if intents is not None:
        if not isinstance(intents, list):
            raise ValueError("intents must be an array")
        for i, intent in enumerate(intents):
            if not isinstance(intent, dict) or "from" not in intent or "description" not in intent:
                raise ValueError(f"invalid intent at index {i}")
        if not intents and open_intents_empty:
            raise ValueError("intents must not be empty when open_intents is empty")
        intents = intents[:max_intents]
        if not intents:
            return "noop", None
        return "intents", intents
    if open_intents_empty:
        raise ValueError("intents is required when open_intents is empty")
    return "noop", None


def validate_bootstrap_execute_payload(payload: dict[str, Any]) -> tuple[str, dict[str, str] | None]:
    accepted, data = _unwrap_wrapped_payload(payload)
    if accepted is False:
        return "rejected", None
    if accepted is None:
        if not _looks_like_bootstrap_execute_data(payload):
            raise ValueError("accepted must be true or false")
        data = _without_skill_feedback(payload)
    if not isinstance(data, dict):
        raise ValueError("accepted must be true or false")

    fact = data.get("fact")
    if not isinstance(fact, dict):
        raise ValueError("fact is required")
    fact_description = fact.get("description")
    if not isinstance(fact_description, str) or not fact_description.strip():
        raise ValueError("fact.description is required")

    result = {"fact_description": fact_description.strip()}
    complete = data.get("complete")
    if complete is None:
        return "fact", result
    if not isinstance(complete, dict):
        raise ValueError("complete must be an object")
    complete_description = complete.get("description")
    if not isinstance(complete_description, str) or not complete_description.strip():
        raise ValueError("complete.description is required")
    result["complete_description"] = complete_description.strip()
    return "complete", result


def validate_bootstrap_conclude_payload(payload: dict[str, Any]) -> tuple[str, str | None]:
    accepted, data = _unwrap_wrapped_payload(payload)
    if accepted is False:
        return "rejected", None
    if accepted is None:
        if not _looks_like_bootstrap_conclude_data(payload):
            raise ValueError("accepted must be true or false")
        data = _without_skill_feedback(payload)
    if not isinstance(data, dict):
        raise ValueError("accepted must be true or false")
    extra_keys = set(data) - {"fact", "complete"}
    if extra_keys:
        raise ValueError("unexpected keys in conclude payload")
    fact = data.get("fact")
    if not isinstance(fact, dict):
        raise ValueError("fact is required")
    fact_description = fact.get("description")
    if not isinstance(fact_description, str) or not fact_description.strip():
        raise ValueError("fact.description is required")
    return "fact", fact_description.strip()


def validate_explore_payload(payload: dict[str, Any]) -> tuple[str, str | None]:
    accepted, data = _unwrap_wrapped_payload(payload)
    if accepted is False:
        return "rejected", None
    if accepted is None:
        if not _looks_like_explore_data(payload):
            raise ValueError("accepted must be true or false")
        data = _without_skill_feedback(payload)
    if not isinstance(data, dict):
        raise ValueError("accepted must be true or false")
    description = data.get("description")
    if not isinstance(description, str) or not description.strip():
        raise ValueError("description is required")
    return "fact", description.strip()
