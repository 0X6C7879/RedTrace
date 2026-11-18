# RedTrace 模型输入中文化与压缩验收

日期：2026-11-18；工作区：`/Users/lxy/Downloads/RedTrace`。父版本：`51f28a6990fdc36d7f0b74dd1d40338d4e020455`。未创建额外 Codex Agent/Worktree，未提交/推送，未运行真实攻击或接触真实靶机。

## 1. 修改范围

- 入口链：`legion-missions.ts → activityPrompt → compat/cordis.mjs` 的静态 Mission 与动态执行契约；Benchmark Commander、General、两类 Soldier、General Planner、按需报告。
- 共用规则：任务 Todo、并发/依赖、规划轮次与 FGS 三层说明集中在现有 Mission 组装处，角色只接收其职责段；General 模式不额外注入完整 Worker Mission。未增加 Prompt 框架。
- 动态自有文案：调度恢复/巡检、当前容量、上下文 80% 通知、报告 Hint、经验转移、工具输出重复行提示、Project/Graph 边界、全局助手/参谋长、旧分类提示和超时旧角色引用。Graph Notice 原本已中文；Mailbox 内容属于用户/Worker 数据，不改写。
- 工具：C2/WebShell、能力动词/资源、FGS、Legion、知识、报告与聊天描述中文化。工具域 description 不再重复罗列每个 action 的 required 字段；约束仍由原 JSON Schema 定义。
- Skill：25 条英文/混合 catalog 描述改为中文，保留全部 Skill 名称与顺序；补齐当前 FGS 示例必填字段，修正旧同题 spawn、Commander 验收与分类门槛。API BOLA 工作流中文化并修复指向不存在 Skill 的链接。
- 原始证据/命令/Payload/HTTP、工具名、字段、枚举及 API/CLI 不翻译；`prompts/upstream/`、许可证、DSH/MCP 原生描述及第三方技术参考正文保留原文。没有尝试用改写证据制造压缩。

## 2. 删除/纠正的冗余与冲突

- 删除 Fact 层中“Reporter 单独写报告”的旧职责，以及按需报告“保存后一律结束”的错误表述：report-only Step 才结束，原 Worker 继续其他工作。
- 统一唯一任务 Planner、Todo 继承/维护/凭证验收、Max Step 槽位与依赖规则，避免多段反复展开。
- 删除重复工具 required 字段清单；Schema、参数校验及 handler 保留。
- 修正 Skill 的 `legion_task(action=spawn)` 旧同题编队指导，改为现有 Planner 的 `legion_plan(action=step)`；不赋予 Soldier 委派权。
- 修正 TSecBench “无分类证据不分配”、定向验证“Commander 验收”、旧 Board “需要分类”、禁用 Ligolo 的可用性误导、不可用 `finish_decide` 的收尾文案。只改文字，不改派遣、状态或工具能力。
- 维护 prompts/UPSTREAM.md 的历史来源说明；原上游文件保持逐字节不变。

## 3. 实测方法与结果

计数器：**tiktoken 0.14.0 / o200k_base**。计数对象是实际本地 DSH 请求的完整 `messages + tools` 序列化 JSON，包含系统提示、原生工具、全部工具参数 Schema、真实可见 Skill catalog、执行/规划动态上下文。不是字符数/4，也不是 provider 账单；provider 隐含 framing 和其他模型 Tokenizer 可能有差异。

相同离线任务：同一授权本地 fixture、必要 Fact 依赖、30 条历史 Fact、相同 Goal/Todo/Step、相同工具开关。模型端点仅 127.0.0.1。前后均经过真实 DSH 组装与 API 适配器，在本机假模型捕获；未调用外部模型或实际攻击目标。

仅统一 fixture 随机 UUID、临时 cwd、时间戳。完整原始请求另存且不改写。脚本逐角色断言：除 description 外的工具结构一致；任务 JSON 一致；其余动态契约与 Skill 名称/顺序一致。翻译过的两处框架调度指令仅在等价性检查映射，实际计数仍保留各自原文。

| 角色 | 修改前 Token | 修改后 Token | 节省 |
|---|---:|---:|---:|
| Benchmark Commander | 2,232 | 2,119 | 5.06% |
| Benchmark General | 7,490 | 7,197 | 3.91% |
| Benchmark 自主规划 Soldier | 12,655 | 11,533 | 8.87% |
| Benchmark 执行 Soldier（Specialist） | 11,613 | 10,515 | 9.45% |
| General 模式 General / Planner | 3,814 | 3,653 | 4.22% |
| General 模式 Soldier | 11,614 | 10,494 | 9.64% |
| 按需报告（Soldier，非 Reporter 角色） | 1,574 | 1,467 | 6.80% |
| General 自定义 Executor | 11,651 | 10,531 | 9.61% |

这是首次完整代表请求的比较，不推算整个 Campaign 账单，也不把启动请求降幅当成每次唤醒的节省。历史/证据上下文与工具结构未削减，故完整输入降幅约 4%–10%，**不宣称已经“大幅减半”**。

原始与细分数据：

- `/private/tmp/redtrace-prompt-zh-20261118/full-before.json`
- `/private/tmp/redtrace-prompt-zh-20261118/full-after.json`
- `/private/tmp/redtrace-prompt-zh-20261118/token-comparison.json`（system/tools/dynamic/total）
- `/private/tmp/redtrace-prompt-zh-20261118/catalog-before.json` / `catalog-after.json`

重跑计数（tiktoken 安装于独立临时 venv，项目依赖未改）：

```sh
/private/tmp/redtrace-prompt-zh-20261118/tokenizer-env/bin/python /Users/lxy/Downloads/RedTrace/scripts/measure-prompt-requests.py /private/tmp/redtrace-prompt-zh-20261118/full-before.json /private/tmp/redtrace-prompt-zh-20261118/full-after.json /private/tmp/redtrace-prompt-zh-20261118/token-comparison.json
```

捕获器：`/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/role-request-metrics.fixture.mjs`。`REDTRACE_METRICS_REPO` 仅用于离线测试选择父版本源码，不属于产品路由/配置。该捕获器额外验证增量唤醒 Frontier、Planner/Executor 工具差异及完整 Skill catalog。

## 4. 角色、权限和运行机制不变的证据

- 完整工厂 catalog：102 条定义、56 个工具名；83 条 RedTrace 自有描述均含中文。剔除 description 后的名称、参数、角色、enabled/source/scope/status 完全一致，SHA-256：`bb7a832a9d9909f99b2c48031d4ca8cac6807b2ae538db92aa87085b25a8dc37`。采集时 Agent 数为 0。
- 8 类真实请求：Commander 无任务 FGS/Todo 规划工具；General 无执行工具；Executor 无 Todo/roster/经验调度工具；自主 Soldier 保留 Todo/经验；接力后的 taskPlanner.receiver、依赖与证据引用保留。
- AST 审计：产品源码只有三处非纯文本结构调整——Mission 文本组合、tool-domains 的 description 去重、runner 的已失效英文描述替换删除；工具执行函数、权限过滤、调度/状态机及证据保存逻辑未改。其余产品改动均为字符串文本。
- 新增 prompt-contract.test.ts 对 FGS 只增不减/纠错、未知不重放、并发/依赖、唯一 Planner、报告原 Session 和 Skill 契约作断言。现有测试继续覆盖真正的权限/生命周期，而不只匹配中文句子。
- `scheduler.ts`、FGS/工具 Schema、模型路由、容量/超时配置、profiles、vendor 及 prompts/upstream 无 Git 变更。未新增锁、队列、限流、重试、超时、Fallback 或其他控制机制。

## 5. 测试与构建

| 检查 | 结果 |
|---|---|
| Engine 全量 `node --test packages/redtrace-engine/test/*.test.ts` | 497 项：496 通过、0 失败、1 跳过 |
| DSH `npm run dsh:test` | 63 通过，0 失败 |
| Engine `npm run check --prefix packages/redtrace-engine` | 通过 |
| RedTrace DSH `npm run dsh:build:redtrace` | 通过 |
| 原生 DSH `npm run dsh:build:upstream` | 通过；保留现有打包/deprecation 警告 |
| 8 类请求、catalog、Token 对比、prompt-contract 与 `git diff --check` | 通过 |

跳过项是本机 Chisel server/client 转发用例；未伪报通过。全量压力下曾发生一次原生压缩 fixture 超时，父版本/修改版独立复测均成功（native_compaction=1、fresh_session、full_STATE_preserved、no_recursive_state_growth）；未修改超时策略，最终完整测试通过。

所有原始 stdout/stderr、失败重试及状态码保存在项目外 `/private/tmp/redtrace-prompt-zh-20261118/`，不写入项目日志目录。

## 6. 验收边界

- 结构与确定性回归已验证；没有测量真实攻击成功率、真实模型决策质量、生产延迟/吞吐或全 Campaign Token 账单。离线测试不能证明“任何攻击效果绝不退化”。
- 输入组织/自有文案已修改，但此次完整输入降幅为上述实测范围；如以更高数值定义“大幅压缩”，该定量目标尚未达到，不能以估算或删上下文补足。
- 未改动第三方原始技术资料正文；按需读取它们时仍可能出现英文。目标证据、技术原文和原生 DSH/MCP 描述亦不强行翻译。

## 7. 修改文件

- `docs/prompt-localization-20261118.md`
- `packages/redtrace-dsh/src/c2.ts`
- `packages/redtrace-dsh/src/reverse.ts`
- `packages/redtrace-dsh/src/spill.ts`
- `packages/redtrace-dsh/src/tool-domains.ts`
- `packages/redtrace-dsh/src/webshell.ts`
- `packages/redtrace-dsh/test/execution-tools.test.mjs`
- `packages/redtrace-dsh/test/spill.test.mjs`
- `packages/redtrace-engine/compat/chat.mjs`
- `packages/redtrace-engine/compat/cordis.mjs`
- `packages/redtrace-engine/compat/legion-context.mjs`
- `packages/redtrace-engine/compat/legion.mjs`
- `packages/redtrace-engine/prompts/UPSTREAM.md`
- `packages/redtrace-engine/prompts/benchmark-commander.md`
- `packages/redtrace-engine/prompts/general-planner.md`
- `packages/redtrace-engine/prompts/reporter.md`
- `packages/redtrace-engine/prompts/sapper-fact-layers.md`
- `packages/redtrace-engine/src/capability-verbs.ts`
- `packages/redtrace-engine/src/chat.ts`
- `packages/redtrace-engine/src/knowledge.ts`
- `packages/redtrace-engine/src/legion-experience.ts`
- `packages/redtrace-engine/src/legion-missions.ts`
- `packages/redtrace-engine/src/legion-store.ts`
- `packages/redtrace-engine/src/legion-tools.ts`
- `packages/redtrace-engine/src/plan-guard.ts`
- `packages/redtrace-engine/src/reporter.ts`
- `packages/redtrace-engine/src/runner.ts`
- `packages/redtrace-engine/src/store.ts`
- `packages/redtrace-engine/test/activity-prompt.test.ts`
- `packages/redtrace-engine/test/artex-planner-native.fixture.mjs`
- `packages/redtrace-engine/test/benchmark-autonomy.fixture.mjs`
- `packages/redtrace-engine/test/benchmark-scheduling.test.ts`
- `packages/redtrace-engine/test/benchmark-task-todos.test.ts`
- `packages/redtrace-engine/test/c2-auth-feedback.test.ts`
- `packages/redtrace-engine/test/domain-fixture.mjs`
- `packages/redtrace-engine/test/fact-finding.test.ts`
- `packages/redtrace-engine/test/global-chat.fixture.mjs`
- `packages/redtrace-engine/test/legion-experience.test.ts`
- `packages/redtrace-engine/test/legion-runtime.fixture.mjs`
- `packages/redtrace-engine/test/legion-todos.test.ts`
- `packages/redtrace-engine/test/planning-concurrency.test.ts`
- `packages/redtrace-engine/test/project-commanders.fixture.mjs`
- `packages/redtrace-engine/test/prompt-contract.test.ts`
- `packages/redtrace-engine/test/reporter-runtime.fixture.mjs`
- `packages/redtrace-engine/test/role-request-metrics.fixture.mjs`
- `packages/redtrace-engine/test/role-system.test.ts`
- `scripts/measure-prompt-requests.py`
- `skills/ad-attack/SKILL.md`
- `skills/api-authorization-and-bola/SKILL.md`
- `skills/api-testing/SKILL.md`
- `skills/capability-primitive-search/SKILL.md`
- `skills/ctf-crypto/SKILL.md`
- `skills/ctf-forensics/SKILL.md`
- `skills/ctf-pwn/SKILL.md`
- `skills/ctf-reverse/SKILL.md`
- `skills/ctf-web/SKILL.md`
- `skills/exploit-file-upload/SKILL.md`
- `skills/exploit-logic/SKILL.md`
- `skills/exploit-race/SKILL.md`
- `skills/exploit-smuggling/SKILL.md`
- `skills/exploit-sqli/SKILL.md`
- `skills/exploit-ssrf/SKILL.md`
- `skills/exploit-xss/SKILL.md`
- `skills/ffuf-web-fuzzing/SKILL.md`
- `skills/ghidra-headless/SKILL.md`
- `skills/playwright-skill/SKILL.md`
- `skills/privesc-linux/SKILL.md`
- `skills/privesc-win/SKILL.md`
- `skills/recon-crawl/SKILL.md`
- `skills/shell/SKILL.md`
- `skills/stagnation-recovery/SKILL.md`
- `skills/targeted-pentest/SKILL.md`
- `skills/tsecbench-api/SKILL.md`
- `skills/tunnel/SKILL.md`
