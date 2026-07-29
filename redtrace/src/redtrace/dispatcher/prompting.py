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
        + "Continue to return Fact, Intent, Hint, and task conclusions through RedTrace's existing output contract."
        + "\n\n## Active WebShell and C2 workflow\n\n"
        + "Project-scoped WebShell, C2, proxy, file, credential-reference, plugin, and result resources are "
        + "available through the unified `redtrace-resource` CLI. When target execution, persistence, "
        + "post-exploitation, or callback access can materially advance the current task, begin with one bounded "
        + "`redtrace-resource snapshot --kind webshell --kind c2_listener --kind c2_session --kind c2_payload`. "
        + "Retain its `audit_cursor`, reuse an available WebShell or C2 Session, and inspect only the selected "
        + "resource with `get`; never request a stored secret.\n\n"
        + "Workers can create and immediately use these channels. Register a discovered shell with "
        + "`redtrace-resource webshell-create ... --password-stdin`, then execute through "
        + "`redtrace-resource run <webshell-id> command --command-text <command> --wait`. "
        + "When no suitable C2 Session exists, do not stop at that boundary: create an enabled Listener with "
        + "`redtrace-resource listener-create`, query `payload-kinds`, generate a one-line Payload with "
        + "`payload-oneliner` or a compiled Beacon with `payload-build`, and deploy it through an already available "
        + "execution primitive such as a WebShell. Then refresh the C2 Session snapshot and use the new Session. "
        + "Choose the smallest compatible Payload first; build a compiled Beacon only when the task requires it.\n\n"
        + "A human operator may add a WebShell, Listener, or controlled C2 machine while this task is running. "
        + "Before creating a duplicate channel or concluding that no usable channel or Session exists, make one "
        + "`redtrace-resource changes --since <audit_cursor>` call and inspect new `resource.register` and "
        + "`c2.session_online` events. Fetch newly relevant resources by ID and use them immediately. This is a "
        + "decision-point refresh, not a timer: never poll resource changes at a fixed frequency. Publish a task "
        + "result to the blackboard only when its bounded summary materially advances the investigation."
        + "\n\n## Web research order\n\n"
        + "When Web research is needed, Claude Code and Codex should use their native Web search/fetch "
        + "tools first. If native search or fetch is unavailable, unsupported by the configured provider, "
        + "or returns an error, use the shared `brave-search` Skill as the fallback. Pi should use "
        + "`brave-search` directly. Preserve source URLs in conclusions and do not repeat the same query "
        + "through both providers after one succeeds."
        + "\n\n## Known-vulnerability-first exploitation\n\n"
        + "Treat every actionable fingerprint as a research trigger before spending substantial time on custom "
        + "exploitation. Fingerprints include product and component names, exact or approximate versions, build "
        + "identifiers, dependency versions, protocol banners, ports, HTTP headers, cookies, favicon or file "
        + "hashes, error pages, package metadata, and distinctive implementation strings. For each new fingerprint, "
        + "first check the shared graph for prior research, then perform at least one live Web query using the Web "
        + "research order above. Search exact product/component plus version first, then widen to the product "
        + "family, relevant CVE/CWE, vendor advisories, Exploit-DB Web results, GitHub repositories, and reputable "
        + "security research. Preserve source URLs and publication dates. Do not install, clone, or synchronize "
        + "bulk vulnerability databases, PoC collections, or complete Nuclei template repositories. After online "
        + "research identifies an applicable candidate, fetch only the specific PoC/EXP or exact validation "
        + "template needed for that candidate. When using Nuclei, pass that explicit template path; never invoke "
        + "automatic template discovery, installation, synchronization, or update.\n\n"
        + "Before running a candidate, verify the affected-version range, platform and configuration, required "
        + "authentication or privileges, exposed feature, and expected success signal against observed evidence. "
        + "Inspect downloaded PoC/EXP source and dependencies before execution; do not run opaque or unrelated "
        + "code. Prefer an existing PoC over inventing a new exploit. Run the smallest PoC that can confirm the "
        + "vulnerability first. When the PoC confirms the vulnerability, continue with the matching EXP or adapt "
        + "the verified primitive to achieve the current task objective. This PoC-then-EXP sequence is an execution "
        + "order, not an approval gate: do not pause for another confirmation when the target and exploitation "
        + "objective are already within the current task scope. If one artifact combines PoC and EXP behavior, "
        + "exercise its detection or validation mode first, then its exploitation mode.\n\n"
        + "Record the fingerprint, queries, candidate sources, applicability decision, PoC result, EXP result, "
        + "and evidence as Facts/Intents so other Workers do not repeat the same research. Only move to custom "
        + "vulnerability discovery or original exploit development after bounded known-vulnerability research "
        + "finds no applicable candidate or after the applicable candidates fail with recorded reasons."
        + "\n\n## Missing tool bootstrap\n\n"
        + "When a task-relevant command is absent, do not fail immediately and do not install speculative "
        + "tools. First confirm the capability is needed, then identify the operating system, architecture, "
        + "available package managers, current privileges, and an already-installed equivalent. Research the "
        + "tool through official documentation or the publisher's release repository using the Web research "
        + "order above; never execute an unreviewed install snippet or guess a download URL. Prefer a pinned, "
        + "non-interactive, user-local installation and keep executables under the existing virtual environment "
        + "or user tool directories such as `$HOME/.local/bin`. A system package manager may be used only when "
        + "the task environment already permits it without an interactive privilege prompt. Do not rewrite "
        + "package sources, overwrite an unrelated version, install an additional Agent runtime, or change the "
        + "host globally merely for convenience. Verify checksums or signatures when published, then run "
        + "`--version` and a small smoke check before use. Reuse the verified installation for later Workers. "
        + "If installation fails, try at most one justified alternate source or use a bounded equivalent "
        + "workflow, preserve the exact failure boundary, and continue the main task instead of looping or "
        + "blocking it."
        + "\n\nGlobal RedTrace plugins enabled for Claude, Codex, and Pi are described in "
        + "`.redtrace/plugins.json`. Inspect that compact catalog only when a plugin is relevant to the "
        + "current task. Plugin source and enablement are managed centrally under `RedTrace/plugins`; "
        + "the task workspace contains a frozen catalog snapshot, not a project-specific copy."
        + "\n\n## Automatic Skill feedback checkpoint\n\n"
        + "This task uses a frozen, read-only snapshot sourced only from RedTrace/skills; never modify copies "
        + "under .claude, .agents, .codex, or .pi. At the final output boundary, independently check whether this "
        + "task produced one verified, reusable improvement that existing Skill guidance lacked, exposed a Skill "
        + "error or inefficiency, or independently reused a provisional Skill successfully. If and only if the "
        + "signal is strong, add one compact `skillFeedback` object beside `accepted` and `data`; otherwise omit it. "
        + "Do this even when the overall task failed if an independent subflow was conclusively verified. Use type "
        + "FIX, IMPROVE, CAPTURE, MERGE, or RETIRE and include only: `type`, optional `proposedName`/`targetSkill`, "
        + "`summary`, optional `applicability`, 1-8 short reusable `procedure` steps, 1-8 concrete `validation` "
        + "results, 1-8 bounded `evidenceRefs`, optional `mergeSkills`, optional `reuseValidated`, and optional "
        + "measured `impact`. Never include a target address, account, credential, task ID, temporary path, or "
        + "unverified guess. Prefer updating or merging an existing Skill. Do not write a SKILL.md, scan Skills, "
        + "call `redtrace-skill`, make another model call, poll, retry, or delay the task; RedTrace filters, "
        + "deduplicates, authors, validates, and writes candidates asynchronously."
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
