from __future__ import annotations

import json
import os
from importlib import resources
from typing import Any

from redtrace.skill_runtime import skill_runtime_instructions


# 输出契约：(a) 编码要求——自由文本可中文但结构化字段原样保留；(b) 只返回 raw JSON。
OUTPUT_SPEC = (
    "## 输出规范\n\n"
    "- 自由文本可用简体中文；但 JSON key / enum / status / phase、专有名词、命令、代码、路径、占位符以及原始输出或错误一律保持原样，不翻译不改写。\n"
    "- 仅返回一个符合本任务上方 schema 的 raw JSON object：不得带 Markdown 与代码围栏、不得附加解释文字；主任务字段必须完整且有效转义引号。"
)

RAW_JSON_REMINDER = (
    "\n\n最终仍只返回 raw JSON object，禁止使用 Markdown 或代码围栏包裹、禁止附带解释文字。"
)


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
    # would make it invalid JSON and break scheduler tests.
    try:
        json.loads(text)
    except json.JSONDecodeError:
        pass
    else:
        return text.rstrip()
    return OUTPUT_SPEC + "\n\n" + text.rstrip()


def add_blackboard_guidance(
    prompt: str,
    revision: int,
    *,
    task_type: str = "explore",
    context_harness_enabled: bool = True,
    local_execution: bool = False,
    hints: str | None = None,
) -> str:
    del hints
    if task_type not in {"bootstrap", "reason", "explore"}:
        raise ValueError(f"unsupported task type: {task_type}")
    sections = [
        (
            "## 共享 Blackboard 决策刷新\n\n"
            f"启动时完整 Graph snapshot revision 为 {revision}；实时完整黑板可用 `redtrace-blackboard snapshot` 读取。"
            "运行时会在已有 heartbeat 上捎带黑板 revision，不增加轮询；一旦变化，会把全部增量内容写入 "
            "`$REDTRACE_BLACKBOARD_NOTICE`。开始工作及每个关键决策点先读取这个小文件。"
            "相关 Fact 可能在不中断进程的情况下发送短信号供选用；信号不含完整上下文，需要时可 "
            "`redtrace-blackboard source <fact_id>` 读有界记录但不得继承其他 Worker 的身份或任务。"
            "自行判断是否采用外部信息；不得固定频率轮询或重复消费已处理内容。结论通过既有 output contract 返回。"
        )
    ]
    if task_type in {"bootstrap", "explore"}:
        sections.extend(
            [
                (
                    "## 共享 Workspace contract\n\n"
                    "当前进程 cwd 与 `$REDTRACE_WORKSPACE` 是本项目唯一且共享的任务根目录；所有脚本/PoC/日志/"
                    "证据都写在其中，不入 `/tmp`、用户主目录或仓库外路径。修改多 Worker 可能共用的既有资源前用 "
                    "`redtrace-resource lock <id>` 协调，HTTP 423 时改读等待而非覆盖；每道已处理题目留一份可复用的通用解题脚本。"
                ),
            ]
        )
    if task_type != "reason":
        sections.append(
            "## RedTrace 全自动执行覆盖规则\n\n"
            "阶段结束后立即选最充分的具体下一步执行，不等用户菜单选择，也不因常规分支/工具替代暂停。仅在授权范围将变或缺关键输入时停下。"
        )
    if skill_guidance := skill_runtime_instructions(task_type):
        sections.append(skill_guidance)
    guidance = prompt.rstrip() + "\n\n" + "\n\n".join(sections)
    if local_execution and os.name == "nt":
        guidance += (
            "\n\n## Windows local execution\n\n确认 shell(PowerShell/Bash)，需 PowerShell 时走 RTK proxy。"
        )
    if context_harness_enabled and task_type != "reason":
        guidance += (
            "\n\n## Context Harness (post-RTK)\n\n过大的输出用 `redtrace-context run … rtk …` 处理，raw data 存 .redtrace/artifacts/context 用有界 selector 取证；只为已确认结论写 Fact 且附 evidence ID/path。"
        )
    return guidance + RAW_JSON_REMINDER


def format_fact_ids(fact_ids: list[str]) -> str:
    return format_json_block(fact_ids)


def format_open_intents(intents: list[dict[str, Any]]) -> str:
    return format_json_block(intents)


def format_hints(hints: list[dict[str, Any]]) -> str:
    return format_json_block(hints)


def format_json_block(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2)
