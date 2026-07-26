from __future__ import annotations

import json
import os
from importlib import resources
from typing import Any


def load_prompt(group: str, name: str) -> str:
    return resources.files("redtrace.dispatcher.prompts").joinpath(group).joinpath(name).read_text(encoding="utf-8")


def render_prompt(template: str, replacements: dict[str, str]) -> str:
    text = template
    for key, value in replacements.items():
        text = text.replace("{" + key + "}", value)
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
    context_harness_enabled: bool = True,
    local_execution: bool = False,
) -> str:
    guidance = (
        prompt.rstrip()
        + "\n\n"
        + "## Optional shared blackboard access\n\n"
        + f"The task snapshot was created at blackboard revision {revision}. "
        + "If fresher shared context would materially help, you may call the read-only "
        + "`redtrace-blackboard` CLI (`status`, `changes`, `node`, `path`, or `context`). "
        + "`status` and `changes` default to this task's snapshot revision. "
        + "Use it only when you judge it useful: do not poll it, do not call it at a fixed frequency, "
        + "and do not interrupt the task merely to check. Results are bounded JSON and calls are audited. "
        + "Project-scoped WebShell, C2, proxy, file, credential-reference, plugin, and result resources "
        + "are available through the `redtrace-resource` CLI. Query only the resource kinds relevant to "
        + "the current task, use resource IDs instead of requesting stored secrets, and publish a task "
        + "result to the blackboard only when its bounded summary materially advances the investigation. "
        + "Continue to return Fact, Intent, Hint, and task conclusions through RedTrace's existing output contract."
        + "\n\nGlobal RedTrace plugins enabled for Claude, Codex, and Pi are described in "
        + "`.redtrace/plugins.json`. Inspect that compact catalog only when a plugin is relevant to the "
        + "current task. Plugin source and enablement are managed centrally under `RedTrace/plugins`; "
        + "the task workspace contains a frozen catalog snapshot, not a project-specific copy."
        + "\n\n## Optional Skill evolution\n\n"
        + "This task uses a frozen, read-only snapshot sourced only from RedTrace/skills; never evolve copies "
        + "under .claude, .agents, .codex, or .pi. Only after the task succeeds and a concrete check proves fewer "
        + "failed steps, tool calls, or elapsed time, you may submit one compact full replacement with "
        + "`redtrace-skill propose`. Prefer the matching existing Skill. Create a new Skill only when none can be "
        + "reused or extended. Merge, replace, compress, and remove redundancy; append-only proposals are rejected. "
        + "Submission is optional and asynchronous: do not make another model call, scan all Skills, poll, retry, "
        + "or delay the task for it."
    )
    if local_execution and os.name == "nt":
        guidance += (
            "\n\n## Windows local execution\n\n"
            "This Worker runs on Windows, but its shell tool may be PowerShell or Git Bash. "
            "Identify the actual shell from the tool/runtime before composing commands, and never pass "
            "PowerShell syntax directly to Bash or Bash syntax directly to PowerShell. Use paths under "
            "the current workspace instead of `/tmp`. Keep RTK as the outer command path. When a Bash "
            "shell needs a PowerShell operation, invoke it explicitly with "
            "`rtk proxy powershell -NoProfile -Command <script>`; otherwise use the actual shell's native "
            "syntax. Prefer the available `python` command over assuming `python3` exists."
        )
    if not context_harness_enabled:
        return guidance
    return (
        guidance
        + "\n\n## Context Harness (post-RTK)\n\n"
        + "Keep using the existing RTK command path first. When a security tool, HTTP request, Web page, "
        + "HAR/browser export, or other tool result may still be large after RTK, run it through the shared "
        + "`redtrace-context` CLI, with RTK inside the harness (for example "
        + "`redtrace-context run -- rtk proxy nuclei ...`). Prefer native JSON, JSONL, or XML output flags. "
        + "The command runs normally and keeps its exit code; large raw stdout/stderr is saved under "
        + "`.redtrace/artifacts/context`, while only deterministic high-signal findings and an evidence ID "
        + "are returned. For page captures, pass a stable `--source` URL so interactive-element, DOM, and "
        + "network changes can be reported without reinjecting prior HTML or screenshots. Use "
        + "`redtrace-context query <evidence-id>` with `--keyword`, `--lines`, or `--offset/--length`; never "
        + "blindly reread a complete Artifact. Use `--passthrough` for progress-sensitive non-interactive "
        + "commands; bypass the harness for a truly interactive TTY. If the harness is disabled or fails "
        + "before execution it falls back to the raw command.\n\n"
        + "Do not create a parallel Idea, Memory, or task-state store. Keep hypotheses and active directions "
        + "in existing Intent/Hint/task-graph flows. Write a Fact only for a confirmed conclusion and include "
        + "the relevant evidence ID/path. When compacting working context, retain only the objective, scope, "
        + "confirmed Facts, active direction, failed boundaries, authentication state, evidence paths, and "
        + "the next action."
    )


def format_fact_ids(fact_ids: list[str]) -> str:
    return format_json_block(fact_ids)


def format_open_intents(intents: list[dict[str, Any]]) -> str:
    return format_json_block(intents)


def format_hints(hints: list[dict[str, Any]]) -> str:
    return format_json_block(hints)


def format_json_block(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2)
