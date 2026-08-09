from __future__ import annotations

import json
import os
import re
from importlib import resources
from pathlib import Path
from typing import Any

LANGUAGE_GUIDANCE = """## 输出语言

自然语言及 JSON 自由文本值须用简体中文。
JSON key、enum/status、phase、工具/Skill/MCP/plugin 名、命令、代码、路径、占位符和原始输出/错误保持原样；raw JSON contract 只输出 JSON。"""

FINAL_OUTPUT_CONTRACT = """## Final output contract

只返回一个符合本任务上方 schema 的 raw JSON object，不得输出 Markdown、代码围栏或解释文字。主任务字段必须完整。"""

PRIMARY_SKILL_MARKER = "REDTRACE_PRIMARY_SKILL="
PRIMARY_SKILL_DIR_MARKER = "REDTRACE_PRIMARY_SKILL_DIR="
RELATIVE_SKILL_REF_PATTERN = re.compile(
    r"`((?:\.\.?/|references/|scripts/|templates/|payloads/|src-hunter/)[^`\s]+)`"
)
_PRIMARY_SKILL_ROUTES = (
    (("源码审计", "代码审计", "code audit", "sast", "source review"), "code-audit"),
    (("android", "apk", "smali"), "apk-reverse"),
    (("firmware", "固件", "uart", "jtag"), "firmware-pentest"),
    (("kubernetes", "k8s", "imds", "cloud metadata", "云元数据"), "cloud-k8s"),
    (("kerberos", "active directory", "ad cs", "ldap", "域渗透"), "windows-ad"),
    (("graphql", "websocket", "jwt", "oauth", "oidc", "bola", "idor"), "api-security"),
    (("pcap", "数字取证", "内存取证", "forensic"), "digital-forensics"),
    (("malware", "恶意软件", "yara", "sigma"), "malware-analysis"),
    (("pwn", "heap", "stack overflow", "栈溢出", "堆利用"), "pwn-chain"),
    (("reverse engineering", "逆向", "反编译", "disassembly", "binary analysis"), "reverse-engineering"),
    (("lateral", "pivot", "post-exploitation", "横向", "内网", "攻击链"), "attack-chain"),
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
    primary_skill: str = "",
    primary_skill_content: str = "",
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
        if primary_skill:
            sections.append(
                "## 已预加载的主执行 Skill\n\n"
                f"{PRIMARY_SKILL_MARKER}{primary_skill}\n"
                "调度器已完成路由并预加载下方完整主 Skill；不得再读取 `route-skills/SKILL.md`、"
                "`REDTRACE_RULES.md`、`upstream/RULES.md`、routing/index 或同一 `SKILL.md`。"
                "正文中的相对路径均以 `REDTRACE_PRIMARY_SKILL_DIR` 为基准。"
                "RedTrace 已提供授权、scope、PATH 和工具基线；跳过 Skill 中的授权先例、scope 初始化、tool-index 发现和"
                "`which`/`find`/`--help` 探测，直接尝试工作流工具。只有实际出现 command-not-found 时才做一次定向修复。"
                "第一个实质动作直接执行该 Skill 的 ACTION REQUIRED/workflow；需要参考文件时再按它的路由精确读取一次。\n\n"
                "--- PRIMARY SKILL BEGIN ---\n"
                f"{primary_skill_content.strip()}\n"
                "--- PRIMARY SKILL END ---"
            )
        sections.append(
            "## Active WebShell 与 C2 工作流\n\n"
            "调度器已在本次 Explore 启动前载入 WebShell/C2 snapshot；直接复用上下文中的匹配资源并按 ID 检查。"
            "用 `redtrace-resource webshell-create` 注册 shell，"
            "用 `redtrace-resource run` 执行。若无 session，不要止步：运行 `redtrace-resource listener-create`，"
            "再用 `payload-oneliner`，或通过 `payload-build` 构建 Beacon，部署后 refresh 一次。重复建立 channel 前，"
            "调用一次 `redtrace-resource changes --since <audit_cursor>`；这是 decision-point refresh，不是 timer。"
            "不得索取已存储的 secret。"
        )
        sections.append(
            "## 执行边界\n\n"
            "Explore 可 start/close/reset/submit Current Intent Description 中明确命名的一道或多道 "
            "Benchmark Challenge；不得操作 `active_peer_work` 中其他 Worker 已认领的题目。操作后必须重新读取状态。"
            "运行时已提供 `redtrace-resource`、`redtrace-context` 和 RTK；不得用 `which`、`--help` 或搜索 runtime 路径重复探测。"
            "Resource kind 仅有 webshell/c2_listener/c2_session/c2_payload/c2_profile/proxy/file/credential_ref/plugin/result。"
            "超过 128 KiB 的 payload 必须写入文件或 stdin，不得放入 argv。"
        )
    if task_type != "reason":
        sections.append(
            "## RedTrace 全自动执行覆盖规则\n\n"
            "阶段结束后自动选择证据最充分、最能推进 Goal 的具体下一步并立即执行；"
            "不得等待用户从下一步菜单中选择，不得因常规分支、工具替代或阶段切换暂停。"
            "仅在授权范围即将改变或缺少无法安全推断的必要输入时停下。"
        )
        if not primary_skill:
            sections.append(
                "Skill、MCP 和 plugin 由 RedTrace root 共享。首次实质操作前用 Worker 原生 Skill 机制发现并调用最具体的相关 Skill；"
                "安全任务必须从 `route-skills` 进入并由其内部路由。默认只用一个主 Skill，确有缺口时再加一个辅助 Skill，"
                "不得额外调用 model 做匹配。"
            )
    sections.append(
        "## route-skills 原生经验回写\n\n"
        "安全任务结束前按 `route-skills` 的 field-journal 规则完成一次复盘。只有产生已验证且可复用的新经验时，"
        "先在 Workspace 写脱敏 draft，再调用 `$REDTRACE_SKILLS_DIR/route-skills/redtrace-tools/field-journal/write.py` 的"
        " `--slug --summary --keywords --entry-file` 接口事务写入；不得直接修改共享 `_index.md`。"
        "白盒代码审计产生的可复用经验改为调用 `$REDTRACE_SKILLS_DIR/route-skills/redtrace-tools/code-audit/evolve.py` 写入"
        " `code-audit/learned/`；项目事实只写当前任务 Workspace 的 `.redtrace/code-audit/`，不进入全局 Skill。"
        "必须脱敏，不得写 target、credential、flag、secret 或 Workspace 绝对路径。没有可复用经验则不写。"
        "不得提交 RedTrace evolution proposal、调用额外 model、等待后台治理或启动独立验证任务。"
    )
    guidance = prompt.rstrip() + "\n\n" + "\n\n".join(sections)
    if local_execution and os.name == "nt":
        guidance += (
            "\n\n## Windows local execution\n\n"
            "确认 shell（PowerShell/Bash），不得将 PowerShell syntax 传给 Bash。使用 Workspace path，RTK 置于最外层；"
            "需要时运行 `rtk proxy powershell -NoProfile -Command <script>`。"
        )
    if context_harness_enabled and task_type != "reason":
        guidance += (
            "\n\n## Context Harness (post-RTK)\n\n"
            "继续优先使用 RTK。仍然过大的 tool/HTTP/page output 通过 `redtrace-context run -- rtk ...` 处理，"
            "优先 structured output。raw data 存于 `.redtrace/artifacts/context`；用有界 selector 查询 evidence，"
            "不要重复读取。不得另建 Idea、Memory 或 task-state store。只为已确认结论写入 Fact，并包含 evidence ID/path。"
        )
    return guidance + "\n\n" + FINAL_OUTPUT_CONTRACT


def select_primary_skill(description: str) -> str:
    normalized = description.casefold()
    for keywords, skill in _PRIMARY_SKILL_ROUTES:
        if any(keyword in normalized for keyword in keywords):
            return skill
    return "pentest-tools"


def preload_primary_skill(
    description: str,
    worker_env: dict[str, str],
) -> tuple[str, str, str]:
    skill = select_primary_skill(description)
    source_root = worker_env.get("REDTRACE_HOST_SKILLS_DIR", "").strip()
    if source_root:
        entrypoint = (
            Path(source_root)
            / "route-skills"
            / "upstream"
            / "skills"
            / skill
            / "SKILL.md"
        )
        try:
            content = entrypoint.read_text(encoding="utf-8")
            skill_dir = str(entrypoint.parent)
            content = RELATIVE_SKILL_REF_PATTERN.sub(
                lambda match: f"`{(entrypoint.parent / match.group(1)).resolve()}`",
                content,
            )
            return skill, f"{PRIMARY_SKILL_DIR_MARKER}{skill_dir}\n\n{content}", skill_dir
        except OSError:
            pass
    runtime_path = (
        f"$REDTRACE_SKILLS_DIR/route-skills/upstream/skills/{skill}/SKILL.md"
    )
    return skill, f"预加载源不可读；立即精确读取 `{runtime_path}` 后执行，不要重跑路由。", ""


def format_explore_context(project: Any, intent: Any) -> str:
    """Return bounded execution state plus the few live peer claims."""
    facts = {fact.id: fact for fact in project.facts}
    selected_ids = list(dict.fromkeys(["origin", "goal", *intent.from_]))
    selected_facts = [
        {"id": fact_id, "description": facts[fact_id].description}
        for fact_id in selected_ids
        if fact_id in facts
    ]
    payload = {
        "project": {
            "id": project.project.id,
            "title": project.project.title,
            "status": project.project.status,
        },
        "current_intent": {
            "id": intent.id,
            "from": intent.from_,
            "description": intent.description,
        },
        "active_peer_work": format_active_peer_work(project, intent.id),
        "facts": selected_facts,
        "hints": [
            {"id": hint.id, "content": hint.content}
            for hint in project.hints[-8:]
        ],
        "blackboard_revision": project.blackboard_revision,
    }
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def format_active_peer_work(project: Any, current_intent_id: str) -> list[dict[str, str]]:
    return [
        {
            "intent_id": peer.id,
            "worker": peer.worker,
            "description": peer.description,
        }
        for peer in project.intents
        if peer.id != current_intent_id
        and peer.worker
        and peer.concluded_at is None
    ]


def format_fact_ids(fact_ids: list[str]) -> str:
    return format_json_block(fact_ids)


def format_open_intents(intents: list[dict[str, Any]]) -> str:
    return format_json_block(intents)


def format_hints(hints: list[dict[str, Any]]) -> str:
    return format_json_block(hints)


def format_json_block(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2)
