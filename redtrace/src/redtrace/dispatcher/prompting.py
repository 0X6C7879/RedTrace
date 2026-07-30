from __future__ import annotations

import json
import os
from importlib import resources
from typing import Any


def load_prompt(group: str, name: str) -> str:
    return (
        resources.files("redtrace.dispatcher.prompts")
        .joinpath(group)
        .joinpath(name)
        .read_text(encoding="utf-8")
    )


def render_prompt(template: str, replacements: dict[str, str]) -> str:
    text = template
    for key, value in replacements.items():
        text = text.replace("{" + key + "}", value)
    # The mock prompt group is a machine-readable JSON fixture. Appending human
    # guidance would make it invalid JSON and break end-to-end scheduler tests.
    try:
        json.loads(text)
    except json.JSONDecodeError:
        pass
    else:
        return text.rstrip()
    return (
        text.rstrip()
        + "\n\n## 语言与编码要求\n\n"
        + "请优先使用简体中文回答，并用中文写入 Fact、Intent、Hint、任务结论、日志摘要和黑板记录。"
        + "命令、路径、代码、JSON 键名、工具名和原始错误可保留原文；不要翻译会影响执行的命令。"
        + "所有文件和进程输出按 UTF-8 处理。Windows 下读取或写入文本时显式指定 UTF-8（例如 "
        + "Python `encoding='utf-8'`、PowerShell `-Encoding UTF8`）；不要依赖系统默认 GBK。"
        + "如果终端直接显示中文会乱码，改用 UTF-8 文件、JSON 或 Unicode 转义传递，再在结论中还原为可读中文。"
    )


def add_blackboard_guidance(
    prompt: str,
    revision: int,
    *,
    task_type: str = "explore",
    context_harness_enabled: bool = True,
    local_execution: bool = False,
) -> str:
    if task_type not in {"bootstrap", "reason", "explore"}:
        raise ValueError(f"unsupported task type: {task_type}")
    sections = [
        (
            "## Optional shared blackboard access\n\n"
            f"The snapshot is at revision {revision}. If fresher context materially helps, you may call the "
            "read-only `redtrace-blackboard` (`status`, `changes`, `node`, `path`, or `context`). "
            "Use bounded calls only: do not poll it or call it at a fixed frequency. Return Facts, Intents, "
            "Hints, and conclusions through the existing output contract."
        )
    ]
    if task_type in {"bootstrap", "explore"}:
        sections.extend(
            [
                (
                    "## Web research order\n\n"
                    "When research is needed, Claude/Codex use native Web search/fetch first and the shared "
                    "`brave-search` Skill as the fallback; Pi uses `brave-search`. Preserve URLs and do not "
                    "repeat a successful query through another provider."
                ),
                (
                    "## Known-vulnerability-first exploitation\n\n"
                    "For an actionable product/version/banner/hash fingerprint, check existing Facts, then "
                    "perform at least one live Web query before custom exploit work. Verify applicability and "
                    "source. Do not install, clone, or synchronize bulk vulnerability databases; fetch only the "
                    "specific PoC/EXP or template, pass that explicit template path to Nuclei, and never invoke "
                    "automatic template discovery or updates. Prefer an existing PoC over inventing a new "
                    "exploit. Validate with the smallest PoC. When the PoC confirms the vulnerability, use the "
                    "matching EXP. This is an execution order, not an approval gate. Record results. Only move "
                    "to custom vulnerability discovery after bounded candidates fail."
                ),
                (
                    "## Missing tool bootstrap\n\n"
                    "Only for a required missing tool, identify an installed equivalent and verify OS and "
                    "architecture. Use official documentation, a pinned non-interactive user-local installation, "
                    "published checksums when available, then `--version` and a small smoke check. Try at most "
                    "one justified fallback and continue instead of looping or blocking it."
                ),
            ]
        )
    if task_type == "explore":
        sections.append(
            "## Active WebShell and C2 workflow\n\n"
            "Use `redtrace-resource snapshot --kind webshell --kind c2_listener --kind c2_session "
            "--kind c2_payload`, reuse a matching resource, and inspect it by ID. Register shells with "
            "`redtrace-resource webshell-create`; execute with `redtrace-resource run`. If no session exists, "
            "do not stop at that boundary: use `redtrace-resource listener-create`, then "
            "`payload-oneliner` or a compiled Beacon with `payload-build`, deploy it, and refresh once. "
            "Before duplicating a channel, call `redtrace-resource changes --since <audit_cursor>` once. "
            "This is a decision-point refresh, not a timer; never request stored secrets."
        )
    if task_type != "reason":
        sections.append(
            "Inspect the managed plugin catalog only on demand. Skills, MCP and plugins are shared from "
            "the RedTrace root and are not Workspace copies."
        )
    sections.append(
        "## Automatic Skill feedback checkpoint\n\n"
        "At final output, add one compact `skillFeedback` only for a verified reusable improvement; "
        "otherwise omit it. Never write or scan private Skill copies, make another model call, poll, retry, "
        "or delay the task. RedTrace validates and writes accepted evolution only to root `skills/`."
    )
    guidance = prompt.rstrip() + "\n\n" + "\n\n".join(sections)
    if local_execution and os.name == "nt":
        guidance += (
            "\n\n## Windows local execution\n\n"
            "Identify whether the actual shell is PowerShell or Bash; never pass PowerShell syntax directly "
            "to Bash. Use Workspace paths, keep RTK outermost, and invoke PowerShell explicitly with "
            "`rtk proxy powershell -NoProfile -Command <script>` when needed."
        )
    if not context_harness_enabled or task_type == "reason":
        return guidance
    return (
        guidance + "\n\n## Context Harness (post-RTK)\n\n"
        "Keep using RTK first. Route still-large tool/HTTP/page output through "
        "`redtrace-context run -- rtk ...`; prefer structured output. Raw data is stored under "
        "`.redtrace/artifacts/context`; query evidence with bounded selectors instead of rereading it. "
        "Do not create a parallel Idea, Memory, or task-state store. Write a Fact only for a confirmed "
        "conclusion and include its evidence ID/path."
    )


def format_fact_ids(fact_ids: list[str]) -> str:
    return format_json_block(fact_ids)


def format_open_intents(intents: list[dict[str, Any]]) -> str:
    return format_json_block(intents)


def format_hints(hints: list[dict[str, Any]]) -> str:
    return format_json_block(hints)


def format_json_block(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2)
