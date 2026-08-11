---
name: route-skills
description: Routes authorized security tasks to the most specific specialist Skill, provides shared tool bootstrap, evidence workflows, code audit, penetration testing, reverse engineering, SRC, AD, CTF and direct experience write-back for RedTrace Workers.
license: MIT
metadata:
  redtraceOverlay: REDTRACE_RULES.md
  distribution: redtrace-local
---

# RedTrace 安全任务路由

`route-skills` 是 RedTrace 内置的安全任务总路由。它根据目标类型、用户意图、工具链和当前证据，进入最具体的主 Skill。每个会话只读一次 `REDTRACE_RULES.md`，随后从 `upstream/skills/SKILL.md` 定位并加载匹配的专家模块；除非专家模块明确引用，不读取体积较大的 `upstream/RULES.md`。

`upstream/` 仅是不可变专家模块所依赖的内部兼容路径，不是外部仓库镜像、更新通道或独立项目。其 case、scope、timeline、workitems、tool-index、bootstrap、report 和 field-journal 机制均作为 RedTrace 本地能力使用。

## 路由原则

- 路由后必须继续加载并执行最具体的专业 Skill，不能只返回名称后自行发挥。
- 一次确定一个主 Skill 与必要的互补 Skill；连同本路由最多加载 5 个，已加载的文件不得重复读取。
- 不把全部安全文档一次性塞入上下文，使用原生渐进加载。
- 不展示下一步菜单等待用户选择。
- 不替代 RedTrace 调度器、黑板和任务状态机。
- 不创建新的独立 Manager 或 Evolution Agent。
- 源代码审计、SAST 告警研判、PR/MR 审查、API 盘点路由到 `upstream/skills/code-audit/`；静态 Finding 的授权动态验证路由到 `upstream/skills/code-audit-runtime-verify/`；白盒准确率与 FP/FN 归因路由到 `upstream/skills/code-audit-benchmark/`。

## RedTrace 集成

- RedTrace 向每个 Claude、Codex 和 Pi Worker 注入此共享 Skill；不得把规则复制到宿主用户的 Agent 配置。
- case 状态必须创建在当前 RedTrace 任务 Workspace 中，不得写入 Agent 用户配置目录。
- 使用 `upstream/skills/tool-index.md` 及其 refresh/bootstrap 脚本。工具只能安装或启动在当前 RedTrace Worker/runtime 内，不得修改宿主用户配置。
- RedTrace 是非交互式编排。自动选择并执行证据支持最充分的下一步，不得因模块中的菜单说明暂停。
- 任务结束时，同一 Worker 通过 `redtrace-tools/field-journal/write.py` 把已验证、可复用且脱敏的经验写入 `upstream/skills/field-journal/`，并在同一锁内更新 `_index.md`。不得提交 evolution proposal 或调用独立验证 Worker。
- 白盒审计的可复用经验通过 `redtrace-tools/code-audit/` 写入 `upstream/skills/code-audit/learned/`；项目事实只写入任务 Workspace 的 `.redtrace/code-audit/`。

加载并执行当前意图所需的一个主专业 Skill 和必要补充。包含 `route-skills` 在内，总数不得超过 5 个；不得停在路由结果，也不得重复读取已加载的 Skill。
