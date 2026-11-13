# 上游来源与适配记录

Sapper-v2: https://github.com/N1nEmAn/sapper-v2 commit 7b75e6f1f5d5b4ae0c55878b0dd0994d9b08f1fb，MIT，Copyright (c) 2026 N1nEmAn。
ARTEX: https://github.com/RuoJi6/ARTEX commit 73d5437c5a64559ed803bcd096d2a0a0014a1214，AGPL-3.0。
已于 2026-11-13 git fetch origin --prune，Sapper 本地 fast-forward 到该提交，ARTEX 与远端相同。

## 保留原文
- upstream/sapper-explore.md：templates/explore.md 原文件；upstream/SAPPER-LICENSE 原许可证。
- upstream/artex-reporter.md：agent/promptcatalog.go ReporterDefaultPrompt 的 Go 字符串拼接求值内容（仅增加结尾换行）；upstream/ARTEX-LICENSE 原许可证。
- artex-report-template.md：ReporterDefaultPrompt 报告结构段原文提取。上游没有独立的本次模板文件。

## 最小接口适配
- sapper-fact-layers.md：explore.md 文档三层和增量事实段，CLI 改为 FGS 工具；按用户要求默认只 Title。注意：Sapper 上游 graph/默认提示词实际包含 Title + Description，show 返回完整节点，doc 专读文档；严格 Title-only 是本次 RedTrace 适配，不宣称是上游原行为。
- reporter.md：保留 Reporter 职责、八节结构、复现/证据/PoC/修复/纪律，只替换唤起句中的提交工具、Project/Graph/Finding ID、查询与保存接口和证据来源。上游独立 Finding/探索节点双 ID 统一为现有 FGS ID，EvidenceVersion 改用现有 Finding version 乐观并发检查。不迁入 PG、流量绑定系统或独立漏洞表。截图开关与 browser MCP 未引入，遵循原文不可用时不伪造截图规则。
- agent/tools.go addFinding、db/findings.go DBFinding/ValidSeverity：name→title，vulnclass→type，summary→description，severity/asset_ids→severity/assetIds，证据通过 factIds→Fact→Evidence；原 details 保留。
- server/orchestration.go seedReporterAgent：每个新结构化 Finding 创建一个 Reporter FGS Step，通过现有 Scheduler 在独立 DSH Session 执行；多个 Finding 可按已有全局/Worker 容量并发，未新增上游 maxParallel=5 限制、队列或状态库。Reporter 使用已配置 Soldier 模型路线与 preset，不新增必须配置项。
- lib/sapper.py：add_fact/build_graph_view/render_graph_text/render_prompt/cmd_show/cmd_doc 调用链作为字段/按需读取依据，未复制文件存储和图数据库。

## 许可证
复制内容保留上游许可证、仓库/commit/文件路径及上述修改说明。ARTEX 内容按其 AGPL-3.0 许可保留；未擅自将 RedTrace 全仓重新标记许可证。项目发布、分发或提供网络服务前，应核对与该复制/适配有关的许可兼容和源码提供要求；此记录不是已完成全仓法律合规审查的声明。
