---
name: route-skills
description: Routes authorized security tasks to the most specific specialist Skill, provides shared tool bootstrap, evidence workflows, code audit, penetration testing, reverse engineering, SRC, AD, CTF and direct experience write-back for RedTrace Workers.
license: MIT
metadata:
  upstreamProject: reverse-skill
  upstreamSource: https://github.com/zhaoxuya520/reverse-skill
  upstreamRevision: cab837a298fec6fa28a49ef746d0085e0b112cfa
  redtraceOverlay: REDTRACE_RULES.md
---

# route-skills in RedTrace

`route-skills` 是 RedTrace 安全任务的总路由。根据目标类型、用户意图、工具链和当前证据，进入最具体的主 Skill；完整上游包固定在 `upstream/`（原 reverse-skill 项目，仅作来源与许可追溯）。每个会话只读一次 `REDTRACE_RULES.md`，随后从 `upstream/skills/SKILL.md` 定位并加载匹配的专家模块；除非专家模块明确引用，不读取体积较大的 `upstream/RULES.md`。其 case、scope、timeline、workitems、tool-index、bootstrap、report、field-journal 机制保持可用。

## 路由原则

- 路由后必须继续加载并执行最具体的专业 Skill，不能只返回名称后自行发挥。
- 一次确定一个主 Skill 与必要的互补 Skill；连同本路由最多加载 5 个，已加载的文件不得重复读取。
- 不把全部安全文档一次性塞入上下文，使用原生渐进加载。
- 不展示下一步菜单等待用户选择。
- 不替代 RedTrace 调度器、黑板和任务状态机。
- 不创建新的独立 Manager 或 Evolution Agent。
- 源代码审计、SAST 告警研判、PR/MR 审查、API 盘点类任务路由到
  `upstream/skills/code-audit/`；静态 Finding 的授权动态验证路由到
  `upstream/skills/code-audit-runtime-verify/`；白盒准确率与 FP/FN 归因路由到
  `upstream/skills/code-audit-benchmark/`。

## RedTrace integration

- `upstream/` 是上游包根目录。所有上游相对路径从这里解析。
- RedTrace injects this shared Skill into Claude, Codex, and Pi for every Worker.
  This satisfies the global routing injection inside RedTrace; do
  not copy rules into host-user `~/.claude`, `~/.codex`, `~/.pi`, `~/.kiro`, or
  other external client configuration.
- Create upstream `work/<case>` state in the active RedTrace task Workspace,
  not inside an Agent user configuration directory.
- Use the native shared `upstream/skills/tool-index.md` and its refresh/bootstrap
  scripts. Install or start tools only inside the active RedTrace Worker/runtime;
  never mutate host-user Agent configuration.
- RedTrace is non-interactive orchestration. Automatically choose and execute the
  best-supported next step; never pause for an upstream next-step menu.
- At task completion, the same Worker writes the anonymized entry directly to
  `upstream/skills/field-journal/` through
  `redtrace-tools/field-journal/write.py`, which updates `_index.md` under the
  same lock. Do not submit a RedTrace evolution proposal or invoke a separate
  verification Worker.
- 白盒审计的可复用经验通过 `redtrace-tools/code-audit/` 工具写入
  `upstream/skills/code-audit/learned/`；项目事实只写入任务 Workspace 的
  `.redtrace/code-audit/`，不进入全局 Skill。

Load and execute the primary specialist Skill plus only the concrete complements
needed by the current Intent. The complete set, including `route-skills`, must not
exceed five Skills. Never stop after routing or reread an already loaded Skill.
