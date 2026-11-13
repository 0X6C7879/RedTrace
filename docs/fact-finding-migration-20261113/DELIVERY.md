# Fact / Finding / Reporter 迁移交付（2026-11-13）

## 当前结果
已在 /Users/lxy/Downloads/RedTrace 原目录完成代码迁移，保留进入任务前的未提交修改。未创建子 Agent、新 Codex Session 或 Worktree（业务验证运行独立 DSH Session），未提交或推送 Git，未重启既有用户服务，未修改用户项目数据库/凭据/运行配置。临时副本仅用于要求的补丁/回滚验证，不作为工作目录。

## 上游来源：直接复用与接口适配
- Sapper-v2 commit `7b75e6f1f5d5b4ae0c55878b0dd0994d9b08f1fb`，MIT。已 fetch 并将所提供本地仓库 fast-forward；仅 README 上游更新。检查 `templates/explore.md`，`lib/sapper.py` 的 add_fact、build_graph_view、render_graph_text、render_prompt、cmd_show、cmd_doc 以及 Worker 历史读取。原 explore 模板和许可证逐字保留；迁入三层规范和 latest incremental fact 原文，仅改查询/提交/存储接口。
- ARTEX commit `73d5437c5a64559ed803bcd096d2a0a0014a1214`，AGPL-3.0，与 fetch 后 origin/HEAD 相同。检查 `agent/tools.go:addFinding`、`db/findings.go:DBFinding`、`agent/promptcatalog.go:ReporterDefaultPrompt`、`server/orchestration.go:seedReporterAgent` 和证据交接逻辑。ReporterDefaultPrompt 完整求值原文保留，原许可证保留；模板确实在该 Prompt 内，没有凭空补造独立上游模板。
- 原样内容：上游 explore 模板、Reporter Prompt 快照、八节报告结构、职责、编号复现步骤、原文证据/PoC/根因/修复/禁止编造纪律。运行版只适配 Project/Graph/Finding ID、工具、证据来源、保存接口。
- 必须说明的差异：Sapper 上游 graph 和默认提示词实际是 Title + Description，show 返回完整节点；本次依用户要求收紧为默认 Title-only，摘要/文档按需读取。这不是宣称上游原本就只显示 Title。
- ARTEX name→title，vulnclass→type，summary→description，severity→severity，asset_ids→assetIds；evidence/PoC 经现有 factIds→Fact→Doc/Evidence 追溯，report 改为现有 Project Artifact 引用。旧 details 原样保留。没有迁入 F-I 图、PG、独立漏洞表/双 ID、独立资产表、Case/triage 状态或流量自动绑定系统。
- 上游一 Finding 一 Reporter、多报告并行的流程保留；上游单独 maxParallel=5 不再重复加在现有 Scheduler 容量之上。Reporter 使用已有 Soldier 模型路线和 preset，无必须新增的配置项；它有独立 role/Step/Run/DSH Session，不与 Explore 共用攻击执行会话。
- 来源、逐字内容哈希核对和接口差异见 /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/prompts/UPSTREAM.md 及 /Users/lxy/Downloads/RedTrace/docs/fact-finding-migration-20261113/UPSTREAM_VERIFIED.json。复制内容保留对应许可证和修改说明；没有擅自给全仓重新标许可。发布/分发/提供网络服务前仍须核对 ARTEX AGPL 的适用义务与兼容性；未宣称已完成全仓法律审查。

## 最终数据结构
```ts
Fact = NodeBase & {
  kind: "fact"; title: string; description: string;
  doc?: Evidence; evidence: Evidence[]; stepId: string | null;
  producerStepIds?: string[];
}
Finding = NodeBase & {
  kind: "finding"; title: string; description: string; type: string;
  factIds: string[]; details: Json;
  severity?: "critical" | "high" | "medium" | "low";
  assetIds?: string[]; report?: Evidence;
  stepId?: string | null; producerStepIds?: string[];
}
Evidence = { description: string; path?: string; artifactId?: string;
             runId?: string; toolCallId?: string }
```
Doc 和完整报告字节均进入已有 ProjectEvidence 内容寻址存储；节点仅存引用。不新建文件存储，不重复保存原始文件。Report 的 .md 名称保存在 Artifact 描述中，前端可独立查看、分页及下载原字节。历史没有 severity/report 的 Finding 不触发自动报告。历史 Fact 在一次性 SQLite 迁移中从首句最多 40 个 Unicode 字符补 Title，description 不改，既有 title 不覆盖。旧调用未提供 title 时仅在写入点生成并保存，不在各读取路径散布 fallback。

## Reporter 的实际流程
1. Soldier/General/Scout 真实验证后调用现有 submit_fact，写入 title、增量 description、可选 Markdown doc 和 Evidence；file 路径立即保全，保留 Run/Tool Call 来源。
2. 通过现有 submit_finding/addFinding 登记已确认漏洞：title/type/severity/description/assetIds/factIds。仍由 FGS 校验 Fact 关联和跨 Graph 边界。
3. 新结构化 Finding 在同一事务创建一个 Reporter FGS Step；Scheduler 按原有 Worker/全局/Project 容量调度独立 DSH Session。没有新状态机、队列或锁。
4. Reporter 用 read_graph({id,detail:"doc"}) 展开关联 Fact，用 project_evidence_read 分页取哈希验证的 Doc/Evidence，read_execution 分页回看原 audit Run/命令/响应。所有外来文本仍是非可信数据。
5. 按 ARTEX 原有八节写报告，用 update_finding_report(finding_id, expectedVersion, report) 发布 Markdown Artifact 并关联 Finding。复用现有 version 冲突机制，冲突必须重读。成功保存即结束，不再要求 Reporter 制造一个 Fact。
6. finishRun 以本 Run 实际保存的 report.runId 为完成依据；旧报告不能冒充本次再生成成功。报告更新复用同一保存工具；前端“生成 / 更新报告”创建或复用现有未结束 Reporter Mission。旧报告 Artifact 不覆盖。
7. Reporter 只获得 FGS/证据/原始执行记录查询和定向报告回写工具，不挂载攻击/写文件/Shell 工具。它可在漏洞 Goal/Project 已验收后完成整理，但项目停止仍停止运行；原有执行 Worker 的取消/验收语义不变。Mock 模式明确报错，不自动编造报告。

## 默认 / 摘要 / 文档读取与前端
- 默认：read_graph()、read_graph_delta、Commander 唤醒 FGS、legion_read_changes、FGS 页面列表均不带 Fact/Finding description、doc、evidence、details、报告全文。保留 ID、Title 和必要关系元数据。
- 摘要：read_graph({id}) 或 legion_read_node({projectId,id}) 返回 description；Finding 同时展开关联 Fact 摘要。
- 文档：同一读取工具 detail="doc" 返回完整引用，再通过现有 Evidence 工具读取字节；HTTP 对应 /nodes/:id?detail=doc 和现有 /evidence/:artifact。没有新建 graph/show/doc 同功能工具。
- 聚合：factIds 只形成视图折叠，Fact/Evidence 不物理合并或删除，同 Fact 可支持多个 Finding。被未结束 Step 独立列入 sourceIds 的 Fact 保留在默认索引；SQL 先折叠再分页，count 与分页一致。
- 前端沿用原 FGS Canvas/侧栏：Finding Title + Fact 数量；点击后摘要和关联 Fact；进一步展开 Doc/Evidence；报告以独立对话框查看/下载。原始关系仍可展开。UI 异步读取不把旧 Project/Graph 的结果写进新选择；UTF-8 跨页按原字节还原。
- 当前项目早已由 Commander 承担原 Reason 规划，本次没有恢复/改写独立 Reason。现有四角色职责、TodoList、原生暂停/恢复/隔离及状态来源保留。

## 验收与测试
| 项目 | 观察结果 |
|---|---|
| 本次相关最终回归 | 51/51；最后 UI/Reporter/审计定向复验 30/30 |
| 新增 Fact/Finding 验收 | 9/9；覆盖三层、many-to-many、折叠、活跃依赖、REST、旧数据、跨 Graph、UTF-8、报告更新 |
| 原生 DSH Reporter | 独立 Soldier + Reporter 两个 Session，真实 loopback 401/200 原始响应被读取并写入报告；八节模板/审计回溯/Artifact 回链成功 |
| 全 Engine | 294 项：290 通过，3 失败，1 跳过；失败均在既有 project-graph-migration.test.ts |
| DSH 回归 | 59 项：58 通过，0 失败，1 跳过（可选真实 Ghidra 测试） |
| 类型检查 | npm run check --prefix packages/redtrace-engine，退出 0 |
| 构建 | npm run dsh:build:redtrace，退出 0；Engine 为直接运行 TS，无单独 build 脚本 |
| JS/MJS 语法、diff | node --check 与 git diff --check，退出 0 |
| 内置浏览器 | Title-only、支撑数量、关联摘要、Doc/Evidence、独立报告查看及原字节下载；无应用 console error；既有 Tailwind 生产使用 warning |
| 回滚/重建 | 435 原文件哈希完全恢复；13 新增文件移除；补丁重建后 448 文件与当前源字节完全相等 |

### 3 个既有迁移测试为何保留失败
测试用 git show HEAD 作为“旧 Store”，但当前 HEAD 已包含 Project Graph 迁移，夹具不是它所假设的迁移前结构。未修改前备份重跑同文件也是 3/3 失败：legacy-session 未继承、campaign_archive 不存在、预期的旧迁移触发器没有运行；本次 Title 迁移使第三项的触发器先报错，后续仍因数据库原本已存在 Graph 表而失败。记录为“基线同样失败”，不是声称两次每条堆栈完全相同。本次独立的历史 Fact Title/内容保持迁移测试已通过。未为了通过旧夹具而改动无关业务逻辑。

### 环境与验证边界
首轮 shell 使用 Node 26，不符合项目 Node 24 LTS 约束，已换用 /opt/homebrew/opt/node@24/bin/node（24.21.0）。知识库默认解释器缺失，复用既有 /Users/lxy/Downloads/RedTrace/.redtrace/project-commander-upgrade-20261113/knowledge-test-env/bin/python，仅通过测试环境变量指定，没有安装依赖或改应用配置。所有失败和修正后的 stdout/stderr/exit 保留。
真实 DSH 验证使用本地协议模型夹具，不是外部真实模型；已验证工具链与真实命令/HTTP 响应，不等同于真实模型报告质量或真实业务漏洞验收。未做专门移动端、多浏览器或生产发布验证；已构建 RedTrace DSH 包，未另外重建未修改的 DSH 上游运行时。

## 控制机制与性能影响
未新增额外控制机制（权限层、限流、锁、队列、重试、超时策略、数据库或第二套任务状态）。仅增加新业务字段必要的非空 Title / Severity 枚举 / vulnclass 校验和 Reporter 只能回写其 Finding 的约束，复用现有 Graph、Artifact、version 与 Session 工具约束。
Reporter 是请求所需的新增工作，会占现有共享并发和模型调用预算；未将任何原并发执行改成串行。报告目标已验收仍可整理是 Reporter 专属流程，普通执行仍受原 Goal/Project 规则限制。
同一 2000 Fact / 200 Finding / 每 Finding 10 Fact / 1 活跃独立依赖负载：旧页中位 7.33ms、232681 bytes；最终折叠页 12.81ms、34413 bytes（约减 85.2%，额外约 5.5ms）；第一页保留活跃独立依赖。初版关联 SQL 实测 2304ms，已改成每查询物化一次 Project-local ID 集，且 Delta 一次批量取当前节点；未新增缓存或索引系统。样本是本机确定性合成负载，不外推生产吞吐。
没有超出迁移范围的架构调整。已有 Fact 维护/合并保留新增 Doc 引用，避免现有维护操作丢失新层；Finding 聚合本身没有执行合并/删除。

## BASELINE / MODIFIED / ROLLBACK
```json
{
  "BASELINE": {
    "title": null,
    "defaultContainsDescription": true,
    "supportingFactFolded": false,
    "summary": "Verified fixture summary",
    "rawFactRetained": "Verified fixture summary",
    "findingFacts": 1
  },
  "MODIFIED": {
    "title": "Fixture title",
    "defaultContainsDescription": false,
    "supportingFactFolded": true,
    "summary": "Verified fixture summary",
    "rawFactRetained": "Verified fixture summary",
    "findingFacts": 1
  },
  "ROLLBACK": {
    "title": null,
    "defaultContainsDescription": true,
    "supportingFactFolded": false,
    "summary": "Verified fixture summary",
    "rawFactRetained": "Verified fixture summary",
    "findingFacts": 1
  }
}
```
三次同一探针输入均退出 0，stderr 为空。回滚原树 SHA256 7e660ba63de1fd5f62a876de49e5228edb98b78b8cf501188607682344445c2e；重建修改树 SHA256 fe5d207c2753530b12693bca534cc4fa5ebf98eefe25dee28e61448272623b75。回滚仅在单独验证副本执行，原工作区保持 GOAL 已应用。ROLLBACK.sh 恢复进入本任务时的代码字节，不是业务数据库降级工具；运行前应停止目标副本运行，且保留同目录 BASELINE.tar.gz。

## 四个固定交付角色
- MODIFIED_FILE: /Users/lxy/Downloads/RedTrace/docs/fact-finding-migration-20261113/MODIFIED_FILE.tar.gz
- DIFF_FILE: /Users/lxy/Downloads/RedTrace/docs/fact-finding-migration-20261113/DIFF_FILE.patch
- VERIFICATION: /Users/lxy/Downloads/RedTrace/docs/fact-finding-migration-20261113/VERIFICATION.txt
- ROLLBACK: /Users/lxy/Downloads/RedTrace/docs/fact-finding-migration-20261113/ROLLBACK.sh

## 修改文件清单（仅相对进入本任务时的差异）
- /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/compat/cordis.mjs
- /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/compat/legion.mjs
- /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/prompts/UPSTREAM.md
- /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/prompts/artex-report-template.md
- /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/prompts/reporter.md
- /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/prompts/sapper-fact-layers.md
- /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/prompts/upstream/ARTEX-LICENSE
- /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/prompts/upstream/SAPPER-LICENSE
- /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/prompts/upstream/artex-reporter.md
- /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/prompts/upstream/sapper-explore.md
- /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/fgs.ts
- /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/graph-api.ts
- /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/graph-content.ts
- /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/index.ts
- /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/legion-missions.ts
- /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/legion-tools.ts
- /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/plan-guard.ts
- /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/project-evidence.ts
- /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/reporter.ts
- /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/runner.ts
- /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/scheduler.ts
- /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/store.ts
- /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/types.ts
- /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/dsh-loop.test.ts
- /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/fact-finding.test.ts
- /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/fgs.test.ts
- /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/legion-experience.test.ts
- /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/legion-runtime.fixture.mjs
- /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/legion-todos.fixture.mjs
- /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/reporter-runtime.fixture.mjs
- /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/reporter-runtime.test.ts
- /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/runtime-contract.test.ts
- /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/tsecbench-reason.test.ts
- /Users/lxy/Downloads/RedTrace/static/audit.js
- /Users/lxy/Downloads/RedTrace/static/fgs-view.js
- /Users/lxy/Downloads/RedTrace/static/index.html

## 尚未完成 / 未宣称完成
- 3 个既有 Project Graph 迁移测试尚未修复，原因如上，属于原夹具/HEAD 假设不符。
- 未做外部真实模型、真实业务目标、生产运行切换或 AGPL 全仓合规审查；未提交或推送。

验证命令与字面 stdout/stderr/退出码、完整哈希和中间错误见 VERIFICATION.txt；浏览器证据见 UI_QA.json、UI_FINDING.png、UI_REPORT.png。REPORT_FIXTURE.md 仅为故意脆弱本地夹具的测试产物，不能作为真实业务漏洞报告。
