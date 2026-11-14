# RedTrace 轻量化优化验收（2026-11-15）

## 结果

直接修改 `/Users/lxy/Downloads/RedTrace`；未创建子 Agent 或新 Codex Session，未安装 Caveman、依赖或额外 Harness。以攻击成功率、执行效率、Token 的顺序取舍。参考 [Caveman 官方仓库](https://github.com/JuliusBrussee/caveman) 的结论先行、技术原文不改、完整输出可取回思想；未引用其性能数字作为 RedTrace 成果。

- `legionMission`：五角色简洁表达，保留分析深度、工具能力、阶段规划、角色权限、Scout 分类和验收规则；取消强制短标题字数/单句摘要要求，避免技术信息受限。
- FGS：移除 Store 的 manageEvidence/releaseFact/deleteStep/deleteInput、对应 Schema、工具、HTTP 路由及前端删除入口。保留整项目生命周期操作；单节点取消改用 PATCH 状态更新。纠错通过新 Fact 引用旧 ID；不自动覆盖旧结论或重写依赖。
- 停止启动时的破坏性历史迁移；已有旧节点和事件原文保持不动，不能恢复过去已经物理删除的数据。graphDelta 只投递事件元数据，不将旧事件原文再次注入。
- `nodeContent`：Step 标题索引不再反复携带 handoff/failure 长文；保留可读取标记，单节点 summary/doc 仍返回原文。Fact/Finding 原有 title → summary → doc/evidence 分层、折叠和活动依赖例外不变。
- General Commander 激活不再同时注入完整 STATE 又要求重复读取；STATE 仍经 legion_state 按需恢复，原生压缩摘要仅为补充。Benchmark 常驻巡检原机制不变。
- Spill：先将原文保存到现有会话隔离存储，再仅折叠连续、逐字完全相同的行，保留首行与精确次数；原始值与 PTC 程序值不改，原文回读不再次去重。保留 12500 Token 原生预算。无法保存时有告警并保留完整输出，不伪造工具失败或重试执行。
- HTTP：默认结果补回响应 Header 和响应正文，继续保留状态码、hash、差异及原始证据。这可能增加某些 HTTP 结果的 Token，优先避免隐藏 Flag/凭据/错误等线索，而非追求所有工具一律缩短。

## 测试

- 原始 Engine：354 通过，0 失败，1 跳过。最终 Engine：349 通过，0 失败，1 跳过；替换/整合了已删除功能的测试，数量变化不是解题率比较。
- 最终 DSH：60 通过，0 失败，1 跳过。两套 TypeScript 检查和 git diff --check 均通过。
- 跳过：本地 Chisel 转发实测、真实 Ghidra ELF/PE 反编译专项。
- 验证两模式 HTTP 读写、FGS 保留/纠错、依赖与阶段验收、失败/取消/改规划、原生压缩与接力、角色消息、并发、Spill 原文回读及存储失败。原有原生 DSH 本地协议 fixture 通过，但不是实际模型解题评测。
- 内置浏览器：本地独立 fixture 页面正常；i001 待执行 → 已取消且仍留在列表；f001 的 HTTP 403、Payload、Flag 摘要仍在，按需展开 X-Clue 与错误路径。未发现页面 error；仅既有 Tailwind CDN 使用告警。截图在会话工具输出中，未声称创建本地截图文件。

## 同输入测量

所有 Token 数为 **DSH 原生 chars/4 启发式估算**，不是目标模型 tokenizer 或账单。相同代码探针、输入、原生预算，不调用模型。

| 角色 | 模式 | 原始估算 Token | 修改后 |
|---|---|---:|---:|
| commander | benchmark | 810 | 806 |
| commander | general | 1456 | 951 |
| general | benchmark | 1237 | 1126 |
| general | general | 979 | 940 |
| soldier | benchmark | 1022 | 964 |
| soldier | general | 962 | 924 |
| scout | benchmark | 950 | 922 |
| scout | general | 904 | 884 |
| reporter | benchmark | 228 | 221 |
| reporter | general | 228 | 221 |

- Step 大 handoff/failure fixture：默认索引 5541 → 113 估算 Token；按需 summary 5541 → 5541，不丢长文。
- 340144 字节重复日志 fixture：模型默认显示 49931 → 537 字节，估算 12487 → 139 Token；中段独有 Header/Payload/错误/Flag 由不可见变为可见，原始文件和 canonical value 两侧均逐字相同。
- 同 fixture 处理时延（预热 2 次、15 次中位数）：1.2515 → 2.3137 ms，**增加约 1.06 ms**。此为本地去重和落盘开销；不声称端到端更快。全套测试耗时不可作为模型推理或 Benchmark 延迟改进证据。

## 基线 / 修改 / 回滚

同一 probe.mjs 输入与指令：
- BASELINE：evidenceMutationAPI=function，Fact 数 1，originalReadable=false。
- MODIFIED：evidenceMutationAPI=undefined，Fact 数 2，originalReadable=true。
- ROLLBACK：恢复 BASELINE 的相同行为；退出码三侧均为 0。

补丁在独立副本重建全部 31 个本次变更文件，与 MODIFIED_FILE 的 SHA-256 全部相同；ROLLBACK.sh 在另一副本实际执行，30 个既有文件恢复有效基线哈希，新增测试文件移除。当前源码保持修改后状态。初始原始快照仍保存在 INITIAL_BASELINE.tar.gz。

## 范围与限制

未新增额外控制机制；无新增开关、权限限制、全局锁、队列、LLM 摘要或模型调用；DSH Agent Loop、工具执行语义、多 Worker 并发和既有权限/证据边界保持。去重仅添加显示层线性扫描与必要原文落盘。

检测到工具控制台的独立并行修改，未回退或归入本次成果：console-api.ts、tool-settings.test.ts、console.test.ts、static/console.js、static/console.css。共享 static/index.html 的工具面板独立 hunk 及后续 console.css 缓存版本更新原样保留并纳入有效前像；本次 diff 不包含该 hunk。

只读检查到当前实际 Benchmark 项目为 stopped；未启动或重置其题目/实例，未进行真实模型、相同题目/预算的解题率 A/B。不能保证攻击成功率不变，也未声称整体 Token、真实解题延迟或单位时间解题数提升；这些仍需真实平台配对评测。

回滚脚本用于指定的目标副本，恢复本次源文件；不要对后续又修改过的工作区直接执行，以免覆盖后续同文件变更。未部署或重启用户正在使用的服务。

## 四角色交付

- `MODIFIED_FILE.tar.gz`：`/tmp/redtrace-lightweight-zEhmvQ/MODIFIED_FILE.tar.gz`；持久副本 [`MODIFIED_FILE.tar.gz`](/Users/lxy/Downloads/RedTrace/docs/lightweight-optimization-20261115/artifacts/MODIFIED_FILE.tar.gz)
- `DIFF_FILE.patch`：`/tmp/redtrace-lightweight-zEhmvQ/DIFF_FILE.patch`；持久副本 [`DIFF_FILE.patch`](/Users/lxy/Downloads/RedTrace/docs/lightweight-optimization-20261115/artifacts/DIFF_FILE.patch)
- `VERIFICATION.txt`：`/tmp/redtrace-lightweight-zEhmvQ/VERIFICATION.txt`；持久副本 [`VERIFICATION.txt`](/Users/lxy/Downloads/RedTrace/docs/lightweight-optimization-20261115/artifacts/VERIFICATION.txt)
- `ROLLBACK.sh`：`/tmp/redtrace-lightweight-zEhmvQ/ROLLBACK.sh`；持久副本 [`ROLLBACK.sh`](/Users/lxy/Downloads/RedTrace/docs/lightweight-optimization-20261115/artifacts/ROLLBACK.sh)

ROLLBACK.sh 需要同目录 BASELINE.tar.gz；持久副本的配套基线已一起保存。VERIFICATION.txt 是可逐行 JSON.parse 的证据账本，包含命令、输入、原始 stdout/stderr、退出码、哈希和状态转换；内部 /tmp 目录属于本次验证副本，不是新项目。

## 本次文件

- `/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/legion-missions.ts`
- `/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/graph-content.ts`
- `/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/http-tools.ts`
- `/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/legion-tools.ts`
- `/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/index.ts`
- `/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/graph-contracts.ts`
- `/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/runner.ts`
- `/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/store.ts`
- `/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/graph-api.ts`
- `/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/compat/legion.mjs`
- `/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/prompts/benchmark-commander.md`
- `/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/prompts/sapper-fact-layers.md`
- `/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/prompts/general-commander.md`
- `/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/prompts/reporter.md`
- `/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/http-tools.test.ts`
- `/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/audit-fixes.test.ts`
- `/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/http.test.ts`
- `/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/legion-commander-context.fixture.mjs`
- `/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/audit-optimization.test.ts`
- `/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/current-fgs.test.ts`
- `/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/fgs-maintenance.test.ts`
- `/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/kernel.test.ts`
- `/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/fact-finding.test.ts`
- `/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/benchmark-resident.test.ts`
- `/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/efficiency-acceptance.test.ts`
- `/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/project-graphs.test.ts`
- `/Users/lxy/Downloads/RedTrace/packages/redtrace-dsh/src/plugins.ts`
- `/Users/lxy/Downloads/RedTrace/packages/redtrace-dsh/src/spill.ts`
- `/Users/lxy/Downloads/RedTrace/packages/redtrace-dsh/test/execution-tools.test.mjs`
- `/Users/lxy/Downloads/RedTrace/static/index.html`
- `/Users/lxy/Downloads/RedTrace/packages/redtrace-dsh/test/spill.test.mjs`
