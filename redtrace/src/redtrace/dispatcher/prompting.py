from __future__ import annotations

import json
from importlib import resources
from typing import Any


def load_prompt(group: str, name: str) -> str:
    return resources.files("redtrace.dispatcher.prompts").joinpath(group).joinpath(name).read_text(encoding="utf-8")


def render_prompt(template: str, replacements: dict[str, str]) -> str:
    text = template
    for key, value in replacements.items():
        text = text.replace("{" + key + "}", value)
    return text


def add_blackboard_guidance(prompt: str, revision: int) -> str:
    return (
        prompt.rstrip()
        + "\n\n"
        + "## Optional shared blackboard access\n\n"
        + f"The task snapshot was created at blackboard revision {revision}. "
        + "If fresher shared context would materially help, you may call the read-only "
        + "`redtrace-blackboard` CLI (`status`, `changes`, `node`, `path`, or `context`). "
        + "`status` and `changes` default to this task's snapshot revision. "
        + "Use it only when you judge it useful: do not poll it, do not call it at a fixed frequency, "
        + "and do not interrupt the task merely to check. Results are bounded JSON and calls are audited. "
        + "Continue to return Fact, Intent, Hint, and task conclusions through RedTrace's existing output contract."
    )


def format_fact_ids(fact_ids: list[str]) -> str:
    return format_json_block(fact_ids)


def format_open_intents(intents: list[dict[str, Any]]) -> str:
    return format_json_block(intents)


def format_hints(hints: list[dict[str, Any]]) -> str:
    return format_json_block(hints)


def format_json_block(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2)
