from __future__ import annotations

import json
import re
from typing import Any

FENCED_JSON_RE = re.compile(
    r"```(?:json)?\s*\n?(.*?)```",
    re.IGNORECASE | re.DOTALL,
)


def parse_json_output(stdout: str) -> dict[str, Any]:
    decoder = json.JSONDecoder()
    seen: set[str] = set()

    candidates = [stdout.strip()]
    candidates.extend(
        match.group(1).strip() for match in FENCED_JSON_RE.finditer(stdout)
    )
    for candidate in candidates:
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)

        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            pass
        else:
            if isinstance(parsed, dict):
                return parsed

        for start, char in enumerate(candidate):
            if char != "{":
                continue
            try:
                parsed, _end = decoder.raw_decode(candidate[start:])
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict):
                return parsed

    raise ValueError("no JSON object found in output")


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


def _looks_like_reason_data(payload: dict[str, Any]) -> bool:
    if not isinstance(payload, dict):
        return False
    keys = set(payload)
    if keys == {"complete"}:
        complete = payload["complete"]
        return isinstance(complete, dict) and "from" in complete and "description" in complete
    if keys == {"intents"}:
        return isinstance(payload["intents"], list)
    if keys == {"intent"}:
        intent = payload["intent"]
        return isinstance(intent, dict) and "from" in intent and "description" in intent
    graph_patch_keys = {"create", "drop", "reprioritize", "supersede", "complete"}
    return bool(keys & graph_patch_keys)


def _looks_like_bootstrap_execute_data(payload: dict[str, Any]) -> bool:
    if not isinstance(payload, dict) or set(payload) != {"fact", "complete"}:
        return False
    return _is_dict(payload.get("fact")) and _is_dict(payload.get("complete"))


def _looks_like_bootstrap_conclude_data(payload: dict[str, Any]) -> bool:
    if not isinstance(payload, dict):
        return False
    keys = set(payload)
    if keys not in ({"fact"}, {"fact", "complete"}):
        return False
    return _is_dict(payload.get("fact"))


def _looks_like_explore_data(payload: dict[str, Any]) -> bool:
    return (
        isinstance(payload, dict)
        and set(payload) == {"description"}
    )


def _patch_create_entries(data: dict[str, Any]) -> list[dict[str, Any]]:
    create = data.get("create")
    if create is not None:
        if not isinstance(create, list):
            raise ValueError("create must be an array")
        return list(create)
    # Backward compatibility: accept the legacy `intents`/`intent` keys.
    intents = data.get("intents")
    if intents is None and isinstance(data.get("intent"), dict):
        intents = [data["intent"]]
    if intents is None:
        return []
    if not isinstance(intents, list):
        raise ValueError("intents must be an array")
    return list(intents)


def _coerce_string_list(
    data: dict[str, Any], key: str, *, require_value: bool = False
) -> list[dict[str, Any]]:
    value = data.get(key)
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError(f"{key} must be an array")
    result = []
    for index, item in enumerate(value):
        if not isinstance(item, dict):
            raise ValueError(f"invalid {key} entry at index {index}")
        result.append(item)
    return result


def _non_empty_string(item: dict[str, Any], key: str, field: str) -> str:
    value = item.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field}.{key} must be a non-empty string")
    return value.strip()


def _optional_priority(item: dict[str, Any], default: int = 50) -> int:
    value = item.get("priority", default)
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 100:
        raise ValueError("priority must be an integer between 0 and 100")
    return value


def validate_reason_payload(
    payload: dict[str, Any],
    *,
    valid_fact_ids: set[str] | None = None,
    valid_intent_ids: set[str] | None = None,
) -> tuple[str, dict[str, Any] | None]:
    accepted, data = _unwrap_wrapped_payload(payload)
    if accepted is False:
        return "rejected", None
    if accepted is None:
        if not _looks_like_reason_data(payload):
            raise ValueError("accepted must be true or false")
        data = payload
    if not isinstance(data, dict):
        raise ValueError("accepted must be true or false")

    patch: dict[str, Any] = {
        "create": [],
        "drop": [],
        "reprioritize": [],
        "supersede": [],
        "complete": None,
    }

    create = []
    for index, entry in enumerate(_patch_create_entries(data)):
        if not isinstance(entry, dict) or "from" not in entry or "description" not in entry:
            raise ValueError(f"invalid create entry at index {index}")
        description = _non_empty_string(entry, "description", "create")
        priority = _optional_priority(entry)
        from_ids = entry.get("from")
        _validate_reason_sources(from_ids, valid_fact_ids)
        create.append(
            {
                "from": list(from_ids),
                "description": description,
                "priority": priority,
                **({"goal_id": entry["goal_id"]} if entry.get("goal_id") else {}),
            }
        )
    patch["create"] = create

    drop = []
    for index, entry in enumerate(_coerce_string_list(data, "drop")):
        intent_id = _non_empty_string(entry, "intent_id", "drop")
        reason = _non_empty_string(entry, "reason", "drop")
        _validate_reason_intent(intent_id, valid_intent_ids)
        drop.append({"intent_id": intent_id, "reason": reason})
    patch["drop"] = drop

    reprioritize = []
    for index, entry in enumerate(_coerce_string_list(data, "reprioritize")):
        intent_id = _non_empty_string(entry, "intent_id", "reprioritize")
        priority = _optional_priority(entry)
        _validate_reason_intent(intent_id, valid_intent_ids)
        reprioritize.append(
            {"intent_id": intent_id, "priority": priority, "reason": entry.get("reason", "")}
        )
    patch["reprioritize"] = reprioritize

    supersede = []
    for index, entry in enumerate(_coerce_string_list(data, "supersede")):
        intent_id = _non_empty_string(entry, "intent_id", "supersede")
        by = _non_empty_string(entry, "by", "supersede")
        _validate_reason_intent(intent_id, valid_intent_ids)
        _validate_reason_intent(by, valid_intent_ids)
        supersede.append(
            {"intent_id": intent_id, "by": by, "reason": entry.get("reason", "")}
        )
    patch["supersede"] = supersede

    complete = data.get("complete")
    if complete is not None:
        if create:
            raise ValueError("complete and create cannot coexist")
        if not isinstance(complete, dict) or "from" not in complete or "description" not in complete:
            raise ValueError("invalid complete payload")
        description = _non_empty_string(complete, "description", "complete")
        from_ids = complete.get("from")
        _validate_reason_sources(from_ids, valid_fact_ids)
        patch["complete"] = {"from": list(from_ids), "description": description}

    return "patch", patch


def _validate_reason_intent(value: Any, valid_intent_ids: set[str] | None) -> None:
    if valid_intent_ids is None:
        return
    if value not in valid_intent_ids:
        raise ValueError(f"invalid intent ID: {value}")


def _validate_reason_sources(value: Any, valid_fact_ids: set[str] | None) -> None:
    if not isinstance(value, list) or not value or any(
        not isinstance(item, str) or not item for item in value
    ):
        raise ValueError("from must be a non-empty fact ID array")
    if valid_fact_ids is None:
        return
    invalid = sorted(set(value) - valid_fact_ids)
    if invalid:
        raise ValueError(f"from contains invalid fact IDs: {', '.join(invalid)}")


def validate_bootstrap_execute_payload(payload: dict[str, Any]) -> tuple[str, dict[str, str] | None]:
    accepted, data = _unwrap_wrapped_payload(payload)
    if accepted is False:
        return "rejected", None
    if accepted is None:
        if not _looks_like_bootstrap_execute_data(payload):
            raise ValueError("accepted must be true or false")
        data = payload
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
        raise ValueError("complete is required")
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
        data = payload
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
        data = payload
    if not isinstance(data, dict):
        raise ValueError("accepted must be true or false")
    description = data.get("description")
    if not isinstance(description, str) or not description.strip():
        raise ValueError("description is required")
    return "fact", description.strip()
