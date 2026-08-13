from __future__ import annotations

import json
import os
from importlib import resources
from typing import Any

LANGUAGE_GUIDANCE = """## 输出语言

自然语言及 JSON 自由文本值须用简体中文。
JSON key、enum/status、phase、工具/Skill/MCP/plugin 名、命令、代码、路径、占位符和原始输出/错误保持原样；raw JSON contract 只输出 JSON。"""

FINAL_OUTPUT_CONTRACT = """## Final output contract

只返回一个符合本任务上方 schema 的 raw JSON object，不得输出 Markdown、代码围栏或解释文字。主任务字段必须完整。"""


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
    hints: str | None = None,
) -> str:
    if task_type not in {"bootstrap", "reason", "explore"}:
        raise ValueError(f"unsupported task type: {task_type}")
    sections = [
        (
            "## 共享 Blackboard 决策刷新\n\n"
            f"启动时完整 Graph snapshot revision 为 {revision}；实时完整黑板可用 `redtrace-blackboard snapshot` 读取。"
            "运行时会在已有 heartbeat 上捎带黑板 revision，不增加轮询；一旦变化，会把全部增量内容写入 "
            "`$REDTRACE_BLACKBOARD_NOTICE`。开始工作及每个关键决策点先读取这个小文件。"
            "当 `changed=true` 时，由你根据当前任务和 token 成本自行决定：直接采用文件内增量、运行 "
            "`redtrace-blackboard changes --since <revision>`，或运行 `redtrace-blackboard snapshot` 查看全部内容。"
            "通知文件保留本次 Worker 启动以来的全部增量；在会话内记住已处理的最新 revision，避免重复消费。"
            "相关 Fact 会在不中断当前进程的情况下发送一个可选短信号，由你判断是否采用。"
            "信号不携带完整上下文；需要更多信息时运行 `redtrace-blackboard source <fact_id>` "
            "查看提交者的有界对话记录，不得继承其他 Worker 的身份或任务。"
            "自行判断相关 Fact、Intent、Hint 和其他 Worker 占用情况；仅在有助于当前任务时采用，"
            "不得固定频率轮询或重做黑板已确认的工作。"
            "结论仍通过既有 output contract 返回。"
        )
    ]
    if task_type in {"bootstrap", "explore"}:
        sections.extend(
            [
                (
                    "## 共享 Workspace contract\n\n"
                    "当前进程工作目录和 `$REDTRACE_WORKSPACE` 是本项目唯一且共享的任务工作根目录；Claude、Codex、Pi "
                    "都能读取和复用其中全部文件。是否新建并进入 `<题目ID>/` 子目录，由你依据当前任务性质自行决定；"
                    "普通非题目任务可以直接使用 Workspace 根目录。所有脚本、PoC/EXP、日志、中间文件和证据都必须写在 "
                    "`$REDTRACE_WORKSPACE` 内，不得写入 `/tmp`、用户主目录或仓库外路径。"
                    "修改其他 Worker 可能同时使用的既有文件或独占通道前，先在 `redtrace-resource list` 复用对应 `file`/Resource，"
                    "必要时用 `register --kind file --no-fact` 注册，再执行 `redtrace-resource lock <id>`；HTTP 423 时改读、等待或写独立文件，"
                    "不得覆盖。完成或放弃修改后 `unlock <id>`。只读分析无需锁，不得用粗粒度目录锁串行化可并行探索。"
                    "每道已处理题目都要创建或更新一个可复用、"
                    "不绑定本次 flag/容器地址的通用解题脚本，供其他 Worker 直接复用。Agent 自身配置和会话状态目录不属于任务产物。"
                ),
                (
                    "## Web 调研顺序\n\n"
                    "Web 调研能力贯穿整个会话，不限于第一轮。首次实质操作前以及后续任一对话轮次出现新 fingerprint、版本、报错或知识缺口时，"
                    "Claude/Codex 优先使用原生 Web search/fetch，共享 `brave-search` Skill 作为 fallback；Pi 使用 `brave-search`。"
                    "保留 URL，成功的 query 不得换 provider 重复执行。"
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
                    "## 共享工具 Bootstrap\n\n"
                    "仅在必需工具缺失时，先寻找已安装的等价工具并核验 OS/architecture。依据官方文档，以固定版本、"
                    "非交互方式安装到 `$REDTRACE_TOOLS_DIR`，并把入口放入已永久注入所有 Worker PATH 的 `$REDTRACE_TOOLS_BIN`；"
                    "禁止写系统目录或修改 shell rc 文件。如有公开 checksum 则校验，随后运行 `--version` 和最小 smoke check。"
                    "最多尝试一个有依据的 fallback，失败后继续推进，不得循环或阻塞。"
                ),
            ]
        )
        if hints is not None:
            sections.append(
                "## Project Hints\n\n以下 Hint 对当前执行阶段继续有效，必须遵守：\n\n"
                + hints
            )
    if task_type == "explore":
        sections.append(
            "## Active WebShell 与 C2 工作流\n\n"
            "WebShell、Listener、Session、Payload 与 Credential 是 RedTrace 全局资源，所有项目和任务均可复用；project/intent/worker 仅用于来源追踪。"
            "任何直接 HTTP RCE、WebShell、reverse/bind shell、SSH、Evil-WinRM、PsExec、WMI、Meterpreter、Beacon 或 socket 通道都只是入口，注册为共享 Resource 后才算建立成功。先运行 "
            "`redtrace-resource snapshot --kind webshell --kind c2_listener --kind c2_session "
            "--kind c2_payload --kind credential_ref`，跨任务复用匹配资源并按 ID 检查。用 `redtrace-resource webshell-create` 注册 WebShell，"
            "注册失败必须查看该子命令 `--help`、修正参数并重试一次；注册成功后必须改用 `redtrace-resource run --wait` 执行，"
            "不得继续手写 `curl ...?c=...` 绕过管理层。任何已获得的直接、reverse、bind 或外部 C2 shell 必须立刻用 `session-register` 登记到 C2 会话中心；"
            "reverse shell 的 `session-register --connection-type reverse` 必须提供由 `redtrace-resource listener-create` 创建的 `--listener`，不能用裸 nc 临时监听。"
            "Bind Shell 使用 `redtrace-resource listener-create --listener-type tcp_bind --target-host <target>` 作为主动 Connector。若无 session，不要止步：运行 `redtrace-resource listener-create`，"
            "再用 `payload-oneliner`，或通过 `payload-build` 构建 Beacon；也可通过 `payload-external` 让 MSF/Sliver/Cobalt Strike Adapter 生成匹配 Beacon，或让 Worker 自行生成兼容/免杀 payload 后用 `payload-import` 登记。"
            "MSF、Sliver、Cobalt Strike 等外部 C2 的 implant/session 用 `session-register --connection-type external_c2` 同步回来；普通 shell 可作为投递通道启动匹配 implant，不能伪装成另一种 C2 协议。"
            "发现主机、Web、数据库、云或 AD 凭证时必须用 `credential-create --secret-stdin` 登记，禁止把 secret 放在命令行、Fact 或最终描述里；需要复用时从 credential_ref 资源的 secret 字段读取。部署后 refresh 一次。重复建立 channel 前，"
            "调用一次 `redtrace-resource changes --since <audit_cursor>`；这是 decision-point refresh，不是 timer。"
            "最终结论提到已获得 shell/RCE/session/credential 时，必须包含对应 Resource ID；没有 ID 就继续注册而不是结束。"
            "`protocol` 只能填写实际 WebShell 协议，`method` 只能是 GET/POST，不得把漏洞利用链名称填入任一字段。"
            "已存储的 credential_ref secret 可直接复用。"
        )
    if task_type != "reason":
        sections.extend(
            [
                (
                    "## RedTrace 全自动执行覆盖规则\n\n"
                    "阶段结束后自动选择证据最充分、最能推进 Goal 的具体下一步并立即执行；"
                    "不得等待用户从下一步菜单中选择，不得因常规分支、工具替代或阶段切换暂停。"
                    "仅在授权范围即将改变或缺少无法安全推断的必要输入时停下。"
                ),
                (
                    "Skill、MCP 和 plugin 由 RedTrace root 共享。首次实质操作前用 Worker 原生 Skill 机制发现并调用最具体的相关 Skill；"
                    "直接加载专业 Skill，不调用 Router、通配符或目录占位名。优先完成原生 Skill 选择和必要 Web 调研，再开始通用命令探索。"
                    "后续若任务方向或知识缺口变化，可继续发现并加载 Skill；同时启用最多 5 个且不得重复加载。"
                    "未完成专业 Skill 的规定步骤前，不得退回纯手写 curl/python/bash 流程。"
                ),
            ]
        )
    sections.append(
        "## Skill 学习闭环\n\n"
        "加载专业 Skill 后运行一次 `redtrace-skill recall <canonical-id>`。任务结束前只有产生已验证、可复用且非项目事实的新经验时，"
        "才在 Workspace 写脱敏说明并调用 `redtrace-skill learn <canonical-id> --summary <摘要> --evidence <验证依据> --content-file <文件>`。"
        "RedTrace Core 负责锁、脱敏、去重、原子写入、索引和审计；没有新经验就不写。"
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


def format_fact_ids(fact_ids: list[str]) -> str:
    return format_json_block(fact_ids)


def format_open_intents(intents: list[dict[str, Any]]) -> str:
    return format_json_block(intents)


def format_hints(hints: list[dict[str, Any]]) -> str:
    return format_json_block(hints)


def format_json_block(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2)
