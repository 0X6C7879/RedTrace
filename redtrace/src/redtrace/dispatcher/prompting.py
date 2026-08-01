from __future__ import annotations

import json
import os
from importlib import resources
from typing import Any


LANGUAGE_GUIDANCE = """## 输出语言

自然语言及 JSON 自由文本值须用简体中文。
JSON key、enum/status、phase、工具/Skill/MCP/plugin 名、命令、代码、路径、占位符和原始输出/错误保持原样；raw JSON contract 只输出 JSON。"""


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
    # The mock prompt group is a machine-readable JSON fixture. Human guidance
    # would make it invalid JSON and break end-to-end scheduler tests.
    try:
        json.loads(text)
    except json.JSONDecodeError:
        pass
    else:
        return text.rstrip()
    return LANGUAGE_GUIDANCE + "\n\n" + text.rstrip()


def add_blackboard_guidance(
    prompt: str,
    revision: int,
    *,
    task_type: str = "explore",
    context_harness_enabled: bool = True,
    local_execution: bool = False,
    skill_index: str = "",
    worker_type: str = "",
) -> str:
    if task_type not in {"bootstrap", "reason", "explore"}:
        raise ValueError(f"unsupported task type: {task_type}")
    sections = [
        (
            "## 可选的共享 Blackboard 访问\n\n"
            f"当前 snapshot revision 为 {revision}。仅当更新的上下文确有帮助时，才可调用只读 "
            "`redtrace-blackboard`（`status`、`changes`、`node`、`path` 或 `context`）。"
            "调用必须有明确边界；不得轮询或按固定频率调用。Fact、Intent、Hint 和结论仍通过既有 output contract 返回。"
        )
    ]
    if task_type in {"bootstrap", "explore"}:
        sections.extend(
            [
                (
                    "## Web 调研顺序\n\n"
                    "需要调研时，Claude/Codex 优先使用原生 Web search/fetch，共享 `brave-search` Skill "
                    "作为 fallback；Pi 使用 `brave-search`。保留 URL，成功的 query 不得换 provider 重复执行。"
                ),
                (
                    "## 已知漏洞优先利用\n\n"
                    "发现可操作的 product/version/banner/hash fingerprint 后，先检查既有 Fact，再至少执行一次实时 "
                    "Web query，然后才进行自定义 exploit 工作；核验适用性和来源。不得安装、clone 或同步批量漏洞库；"
                    "只获取特定 PoC/EXP 或 template，向 Nuclei 传入明确的 template path，且不得自动发现或更新 "
                    "template。优先复用现有 PoC，以最小 PoC 验证；确认漏洞后使用匹配的 EXP。此为执行顺序，不是 "
                    "approval gate。记录结果；只有有界候选均失败后，才转向自定义漏洞发现。"
                ),
                (
                    "## 缺失工具 Bootstrap\n\n"
                    "仅在必需工具缺失时，先寻找已安装的等价工具并核验 OS/architecture。依据官方文档，以固定版本、"
                    "非交互、user-local 方式安装；如有公开 checksum 则校验，随后运行 `--version` 和最小 smoke check。"
                    "最多尝试一个有依据的 fallback，失败后继续推进，不得循环或阻塞。"
                ),
            ]
        )
    if task_type == "explore":
        sections.append(
            "## Active WebShell 与 C2 工作流\n\n"
            "运行 `redtrace-resource snapshot --kind webshell --kind c2_listener --kind c2_session "
            "--kind c2_payload`，复用匹配资源并按 ID 检查。用 `redtrace-resource webshell-create` 注册 shell，"
            "用 `redtrace-resource run` 执行。若无 session，不要止步：运行 `redtrace-resource listener-create`，"
            "再用 `payload-oneliner`，或通过 `payload-build` 构建 Beacon，部署后 refresh 一次。重复建立 channel 前，"
            "调用一次 `redtrace-resource changes --since <audit_cursor>`；这是 decision-point refresh，不是 timer。"
            "不得索取已存储的 secret。"
        )
    # Skill-first matching rule: active, not passive.
    if task_type != "reason" and skill_index:
        if worker_type == "pi":
            invoke_hint = (
                "匹配时读取 `$REDTRACE_SKILLS_DIR/<skill-name>/SKILL.md` 并遵循 procedure；"
                "选最具体的 Skill，必要时最多组合 10 个。"
            )
        else:
            invoke_hint = (
                "匹配时用原生 Skill tool 调用 `redtrace-capabilities:<skill-name>`；"
                "选最具体的 Skill，必要时最多组合 10 个。"
            )
        sections.append(
            "## Skill-first 匹配\n\n"
            "首次实质操作前按下方 Available Skills index 匹配；它是 Skill name/description 的权威来源。\n"
            f"- {invoke_hint}\n"
            "- 无匹配项就继续；phase 变化或确认 vulnerability/tool type 时重试。\n"
            "- 不得仅为匹配额外调用 model。\n\n"
            f"Available Skills：\n{skill_index}"
        )
    elif task_type != "reason":
        sections.append(
            "Skill、MCP 和 plugin 由 RedTrace root 共享。开始实质工作前，使用原生 Skill loading 机制发现并调用相关 Skill。"
        )
    sections.append(
        "## Skill feedback checkpoint\n\n"
        "结束任务前必须完成一次学习复盘：对照本次实际结果、失败边界和已调用 Skill，判断是否存在可复用的纠错、"
        "步骤压缩或缺失分支。存在明确经验时不得省略 `skillFeedback`；只有确实没有可泛化变化时才为 null。\n"
        "非 null 时使用：\n"
        "```json\n"
        '{"target_skill": "skill-name", "summary": "一句可复用经验", '
        '"evolution_type": "IMPROVE", "procedure": ["可复现步骤"], '
        '"validation": ["本任务中的验证结果"], "evidence_refs": ["context/fact/artifact 引用"], '
        '"impact": {"task_succeeded": true, "step_verified": true, '
        '"tool_calls_saved": 0, "invalid_steps_avoided": 1, "duration_saved_ms": 0}}\n'
        "```\n"
        "现有 Skill 用 `IMPROVE`/`FIX`，全新 Skill 用 `CAPTURE`。只填实际测得的 impact；未测得时三个收益值保持 0，"
        "系统会保留候选但不会直接改写 Skill。`reuse_validated` 仅用于当前任务真实使用了该 revision，且来源项目不同的情况。"
        "不得包含 target IP、credential、flag、absolute path，也不得额外调用 model、轮询或延迟。"
    )
    guidance = prompt.rstrip() + "\n\n" + "\n\n".join(sections)
    if local_execution and os.name == "nt":
        guidance += (
            "\n\n## Windows local execution\n\n"
            "确认 shell（PowerShell/Bash），不得将 PowerShell syntax 传给 Bash。使用 Workspace path，RTK 置于最外层；"
            "需要时运行 `rtk proxy powershell -NoProfile -Command <script>`。"
        )
    if not context_harness_enabled or task_type == "reason":
        return guidance
    return (
        guidance
        + "\n\n## Context Harness (post-RTK)\n\n"
        "继续优先使用 RTK。仍然过大的 tool/HTTP/page output 通过 `redtrace-context run -- rtk ...` 处理，"
        "优先 structured output。raw data 存于 `.redtrace/artifacts/context`；用有界 selector 查询 evidence，"
        "不要重复读取。不得另建 Idea、Memory 或 task-state store。只为已确认结论写入 Fact，并包含 evidence ID/path。"
    )


def format_fact_ids(fact_ids: list[str]) -> str:
    return format_json_block(fact_ids)


def format_open_intents(intents: list[dict[str, Any]]) -> str:
    return format_json_block(intents)


def format_hints(hints: list[dict[str, Any]]) -> str:
    return format_json_block(hints)


def format_json_block(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2)


def build_skill_index(skills: list[dict[str, str]]) -> str:
    """Build a compact skill index for prompt injection.

    Each enabled skill becomes one line: ``- name: description``.
    Descriptions are truncated to keep the prompt lightweight.
    """
    if not skills:
        return ""
    lines: list[str] = []
    for skill in skills:
        name = skill.get("name", "")
        description = skill.get("description", "")
        if not name:
            continue
        entry = f"- {name}: {description}"
        lines.append(entry)
    return "\n".join(lines)
