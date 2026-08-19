from __future__ import annotations

import json
from importlib import resources
from typing import Any


def load_prompt(group: str, name: str) -> str:
    return (
        resources.files("redtrace.dispatcher.prompts")
        .joinpath(group)
        .joinpath(name)
        .read_text(encoding="utf-8")
    )


def load_prompt_for_mode(name: str, *, prompt_group: str | None = None) -> str:
    """Select prompt group. If prompt_group is provided (e.g. "mock"), use it directly.
    Otherwise always use "default" (the single canonical prompt set).
    """
    if prompt_group is not None:
        return load_prompt(prompt_group, name)
    return load_prompt("default", name)


def render_prompt(template: str, replacements: dict[str, str]) -> str:
    text = template
    for key, value in replacements.items():
        text = text.replace("{" + key + "}", value)
    return text.rstrip()


def format_fact_ids(fact_ids: list[str]) -> str:
    return format_json_block(fact_ids)


def format_open_intents(intents: list[dict[str, Any]]) -> str:
    return format_json_block(intents)


def format_hints(hints: list[dict[str, Any]]) -> str:
    return format_json_block(hints)


def format_json_block(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2)
