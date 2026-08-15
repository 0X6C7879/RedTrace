---
name: code-audit
description: 统一白盒代码安全审计平台，支持 arch-scan、api-audit、mr-review、sast-audit、api-inventory、report-review、security-assessment 七种模式，覆盖 Java/Go/Python/JavaScript 的 REST 与 gRPC 框架，Codegraph 优先的调用链分析与误报过滤体系。
license: MIT
metadata:
  sourceSkill: ks-security-audit
  targetSkill: code-audit
---

# 统一安全审计技能（code-audit）

统一的安全审计平台，通过模式切换支持不同审计场景。

---

## 触发条件

| 模式 | 触发关键词 |
|------|-----------|
| mr-review | MR审查、PR审查、代码变更、安全审查、diff分析、合并请求、代码评估、变更安全 |
| api-audit | API审计、接口审计、路由审计、端点安全、接口测试、API安全、REST审计、gRPC审计 |
| arch-scan | 架构分析、架构预分析、认证体系、授权模型、数据层识别、安全中间件、项目架构、代码仓库首次理解 |
| sast-audit | CodeQL、Semgrep、SAST扫描、静态分析、漏洞研判、误报分析、告警研判、安全告警 |
| api-inventory | API发现、接口管理、API分类、库存分析、接口登记、资产清点、API盘点、端点管理 |
| report-review | 报告复核、审计复核、报告审查、复核审查、漏洞复核、风险复核、审计报告验证 |
| security-assessment | 安全评估报告、security assessment report、验证优先级、风险链路、risk chain、测试用例、security assessment、评估报告 |

---

## 模式选择

| 模式 | 使用场景 | 输入格式 | 文档入口 |
|------|----------|----------|----------|
| **mr-review** | MR/PR 代码变更安全审查 | Git Diff + MR 信息 | references/modes/mr-review.md |
| **api-audit** | API 端点安全审计 | API 路由路径或文件路径+方法名 | references/modes/api-audit.md |
| **arch-scan** | 项目架构预分析（认证/授权/数据层） | Git 地址 + 仓库路径 | references/modes/arch-scan.md |
| **sast-audit** | CodeQL 告警研判 | CodeQL JSON 报告 | references/modes/sast-audit.md |
| **api-inventory** | API 库存管理（发现/分类/查询） | Git 地址 + 子模式参数 | references/modes/api-inventory.md |
| **report-review** | 审计报告复核（漏洞/风险等级验证） | 审计结果 findings 列表 | references/modes/report-review.md |
| **security-assessment** | 安全评估报告（验证优先级+风险链路+测试用例） | Git 地址 + 仓库路径 | references/modes/security-assessment.md |

### 模式执行规范（强制）

加载 `references/modes/{模式名}.md`，严格按其执行流程、输出规范、判定标准执行，不得跳过步骤。

---

## RedTrace 集成（路径与输出约束）

- **Skill 根目录**：脚本一律从当前文件位置推导 Skill 根目录（`SKILL_ROOT = Path(__file__).resolve().parents[1]`），不写死用户主目录；文档中的 `$REDTRACE_SKILLS_DIR/code-audit/` 即本目录。
- **项目上下文**：arch-scan 生成的项目上下文写入 `<workspace>/.redtrace/code-audit/PROJECT_CONTEXT.md`；**禁止覆盖目标仓库根目录已有的 `AGENTS.md`**。语义内容（认证体系、授权模型、全局拦截器、路径白名单、RPC-DOWNSTREAM、ID-TYPE、PUBLIC-DATA、TENANT-BOUNDARY、STRIDE 标记、数据层与安全中间件）保持不变。
- **API 库存**：库存数据库为任务级 `<workspace>/.redtrace/code-audit/api-inventory.db`（可用环境变量 `API_INVENTORY_DB_PATH` 覆盖）；不得使用主机全局数据库，不得跨项目共享库存。SQLite 设置 `journal_mode=WAL`、`busy_timeout=30000`，写操作使用文件锁避免多 Worker 冲突。
- **共享状态**：`<workspace>/.redtrace/code-audit/` 下含 `PROJECT_CONTEXT.md`、`state.json`、`api-inventory.db`、`findings.jsonl`、`passed-checks.jsonl`、`unknowns.jsonl`、`reports/`、`evidence/`。大段源码、完整 SAST 报告和响应正文保存在 Workspace，不直接塞入 Blackboard。
- **结果输出**：保留本 Skill 原始内部 Schema，外层包一层 RedTrace 协议：

```json
{
  "accepted": true,
  "data": {
    "skill": "code-audit",
    "mode": "api-audit",
    "auditResult": {
      "findings": [],
      "passed_checks": [],
      "unknowns": []
    },
    "artifacts": [],
    "blackboardUpdates": []
  }
}
```

原始 `scripts/validate-output.cjs` 只校验 `data.auditResult`，不校验 RedTrace 外层。`security-assessment` 继续生成 Markdown（写入 `.redtrace/code-audit/security-assessment.md`），返回：

```json
{
  "accepted": true,
  "data": {
    "mode": "security-assessment",
    "reportPath": ".redtrace/code-audit/security-assessment.md",
    "summary": {}
  }
}
```

- **Finding 唯一标识**：`CA-<project>-<mode>-<category>-<hash>`；多个 Worker 发现同一问题时按 `file + function + sink + category` 计算去重键，合并证据，不重复创建 Finding。
- **Codegraph 索引**：不存在索引时执行 `codegraph init`，已有索引且代码变化时执行 `codegraph sync`；init/sync 前获取 `<workspace>/.redtrace/locks/codegraph.lock`，同一时间只允许一个 Worker 执行，其他 Worker 可读取已完成索引。
- **经验沉淀**：任务结束前，只有满足沉淀条件的新经验才通过 `redtrace-skill learn code-audit ...` 写入 RedTrace Skill memory；项目事实只留在 Workspace，不进入全局经验。
- **私有案例**：`references/cases/internal-cases.json` 为私有案例（不入库、不公开提交）；缺失时公开规则和 learned 仍能正常运行。可通过环境变量 `REDTRACE_CODE_AUDIT_PRIVATE_CASES_DIR` 提供外部私有案例目录。

---

## 通用安全判定标准

> **静态分析的边界**：纯静态代码分析，输出「代码层面是否存在风险」，而非「运行时是否可利用」。
> **关键原则**：网络不可达 = 事实防护；代码有风险 ≠ 实际可利用；代码状态 > 网络可达性 > 危险写法 > 防护措施。

### 判定标准表

| 结论 | 定义 | 判定条件 |
|------|------|----------|
| **vulnerability** | 代码有问题 + 运行时可利用 + 无有效防护 | 存在危险写法 + 数据流可从入口追踪到 sink + 无有效防护措施 |
| **risk-a** | 代码有问题 + 无 HTTP 入口（或网络不可达） | 存在危险写法 + 无可达的 HTTP/gRPC 入口 + 网络不可达本身是事实防护 |
| **risk-b** | 代码有问题 + 入口可达 + 有弱防护 | 存在危险写法 + 入口可达 + 有弱防护（仅长度限制/黑名单） |
| **safe** | 无危险写法或有有效防护 | 无危险写法，或代码已禁用，或所有 sink 点有有效防护（参数化/类型约束/白名单） |
| **unknown** | 关键代码缺失或数据流不完整 | 关键代码不可访问，或数据流不完整 |

> **严重程度评级**：`severity` 字段评级标准见 references/common/severity-rating.md，适用 api-audit、mr-review、report-review、security-assessment 模式。

### 代码状态检查规则

| 状态 | 识别特征 | 判定 |
|------|----------|------|
| 注释禁用 | 代码被 `/* */` 或 `//` 包裹 | safe（不参与安全判定） |
| 废弃标记 | `@Deprecated` 注解 | safe（已废弃代码，但仍需确认无活跃路由入口）|
| 功能开关 | 存在 `if (kconf.getBoolean("xxx.enabled", false))` 且默认关闭 | safe（功能未启用） |
| 测试代码 | 标准测试源集：`src/test/`、`src/*/test/`、`__tests__/`、`test_*.py`、`*_test.go`、`*.test.ts`/`*.spec.ts` | safe（非生产代码）。`src/main/` 下即使包名/目录含 `test` 仍为生产代码，须正常审计 |

> **sast-audit 例外**：仅输出 vulnerability/safe/unknown，不输出 risk-a/risk-b。

---

## 通用质量门禁（全部模式强制执行）

在宣布任何模式完成前，**必须**验证以下检查项：

> 检查项标注了模式名（如「仅 api-audit/mr-review/report-review」）的，仅对所列模式生效，其余模式视为自动通过，不阻塞后续检查项。

| 检查项 | 验证动作 |
|--------|----------|
| 所有执行步骤已完成 | 回顾对应模式文档的执行流程章节 |
| 所有必需字段已返回 | 对照输出规范章节逐字段核查 |
| 输出格式正确 | 确认输出格式符合模式要求（纯 JSON / Markdown 报告，security-assessment 输出 Markdown，其余模式纯 JSON） |
| 输出格式校验（仅 api-audit/mr-review/report-review） | 仅这三模式适用：输出前运行 `node $REDTRACE_SKILLS_DIR/code-audit/scripts/validate-output.cjs <output.json> [mode]`（mode 取模式名），校验通过方可宣布完成；校验 schema 见 `$REDTRACE_SKILLS_DIR/code-audit/scripts/output-schema.json`。**sast-audit/arch-scan/api-inventory/security-assessment 跳过本项**（输出形态非该 schema 覆盖） |
| 审计反模式自检 | 加载并对照 references/common/audit-anti-patterns.md，确认未触犯任一反模式；硬化建议与 finding 严格分离，诚实空结论有效 |
| 已应用误报排除规则 | 加载并应用 false-positive-filtering.md；`passed_checks[*].reason` 必须以 `[FP-x.y]` 或 `[FP-NONE]` 起首（迁移期告警不阻断）；规则索引见 false-positive-filtering.md「FP 规则索引」章节 |
| 高危 finding 必须经对抗验证 | severity∈{critical,high} 或 conclusion=vulnerability 的 finding 必须经过 N 票独立对抗验证（见 references/modes/report-review/adversarial-validation.md）。**准出门禁**：待对抗验证列表中每个 finding 必须有对应 `[VOTE: ...]` 裁决记录，缺少则复核结果无效 |
| severity 评级已按标准执行 | 加载并应用 severity-rating.md（api-audit/mr-review/report-review 模式）|
| 结论与证据一致 | 确认结论有对应代码证据支撑 |
| category 值为标准化枚举 | category 字段值必须为 references/common/category-enum.md 中定义的值之一 |

> 各模式专属质量检查项见对应模式文档。

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布完成。**

---

## 文档索引

### 通用规则（common）

| 主题 | 文档 | 适用模式 |
|------|------|----------|
| 误报排除规则 | references/common/false-positive-filtering.md（含 FP 规则索引） | 全部 |
| 审计反模式与诚实结论 | references/common/audit-anti-patterns.md | 全部（各模式适用反模式子集不同，见文档「适用范围区分」）|
| 净化措施判定 | references/common/sanitization.md | 全部 |
| 可信数据源判定 | references/common/trusted-sources.md | 全部 |
| SSRF 隔离代理 | references/common/ssrf-proxy.md | 全部 |
| Spring 框架特性 | references/common/framework-spring.md | 全部 |
| Kconf 配置系统 | references/common/kconf.md | 全部 |
| gRPC 框架特性 | references/common/grpc.md | 全部 |
| BlobStore 规则 | references/common/blobstore.md | 全部 |
| 严重程度评级 | references/common/severity-rating.md | api-audit, mr-review, report-review, security-assessment |
| 漏洞类型枚举 | references/common/category-enum.md | api-audit, mr-review, report-review, security-assessment |
| 威胁清单消费 | references/common/threat-consumption.md | api-audit, arch-scan, report-review, mr-review, security-assessment |
| 来源纪律标签 | references/common/source-discipline.md | api-audit, mr-review, report-review |

### 语言规则

| 语言 | 路由配置 | 漏洞规则 |
|------|----------|----------|
| Java | references/java/java-router.md | references/java/java-*.md |
| Go | references/go/go-router.md | references/go/go-*.md |
| Python | references/python/python-router.md | references/python/python-*.md |
| JavaScript | references/javascript/javascript-router.md | references/javascript/javascript-*.md |

---

## 工具使用规范

> **核心原则：codegraph MCP 优先，grep/read 仅在"已确定文件位置"或"codegraph 降级"时使用。**
> codegraph 一次调用即可获取符号源码与完整调用关系；退化为 grep+read 手工拼调用链会产生大量重复文件操作、显著拉长单接口耗时。两者职责不同，不可混用。

根据上下文中的代码位置信息选择工具策略：

| 场景 | 适用模式 | 策略 |
|------|---------|------|
| **无准确代码位置** | api-audit、arch-scan、api-inventory、security-assessment | **codegraph MCP 优先**，仅在降级条件成立时用 grep/read |
| **有准确代码位置** | sast-audit、mr-review、report-review | grep/read 优先 |

### 无准确位置场景（codegraph MCP 优先）

输入仅有 API 路径或项目地址，需要从路由/架构出发追踪代码。

**优先级**：codegraph MCP 工具 > read > grep

#### codegraph 工具速查

| 任务 | 首选工具 | 用途说明 |
|-----|---------|---------|
| 理解模块/功能实现 | `codegraph_explore` | 主入口，一次性获取相关符号的完整源码 |
| 定位类/方法位置 | `codegraph_search` | 记住名字但不确定在哪个文件 |
| 获取单个符号完整详情（源码/签名/调用关系） | `codegraph_node(symbol, includeCode=true)` | explore 返回的被截断代码，用这个展开 |
| 追踪方法调用的所有下游 | `codegraph_callees` | "这个方法依赖哪些下游？"——调用链追踪核心工具 |
| 查找谁调用了某方法 | `codegraph_callers` | "谁在使用这个方法？" |
| 了解项目结构 | `codegraph_files` | 文件树（带语言+符号计数） |

**推荐工作流**：
1. `codegraph_explore` → 获取相关符号源码（一次拿全，避免多次 read）
2. `codegraph_node(includeCode=true)` → 展开被截断的代码（如需要）
3. `codegraph_callees` / `codegraph_callers` → 补充调用关系（如需要）

> **工具形态兼容**：独立 CLI 版 codegraph（`@colbymchenry/codegraph`）的 MCP 只暴露聚合工具 `codegraph_explore`；此时 `codegraph_search/node/callees/callers/files` 用同名 CLI 子命令等价替代（如 `codegraph query <符号>`、`codegraph node <符号>`、`codegraph callees <符号>`、`codegraph callers <符号>`、`codegraph files`），能力不降级。IDE 内置 codegraph MCP 提供全部六个工具时优先用 MCP。

#### 任务→工具映射

| 任务 | 首选工具 | 降级工具 |
|-----|---------|---------|
| 查找路由定义 | `codegraph_search(kind="route")` | grep |
| 获取类/方法源码 | `codegraph_explore` / `codegraph_node(includeCode=true)` | read |
| 追踪调用链 | `codegraph_callees` | grep + read |
| 查找方法调用者 | `codegraph_callers` | grep |
| 读取配置文件/XML/properties | `read` | - |

#### 降级条件（仅以下四种情况允许退回 grep/read）

1. 项目无 `.codegraph/codegraph.db` 索引
2. codegraph 连续 2 次返回空结果（说明该符号未被索引，如第三方库代码、动态生成代码）
3. codegraph MCP 工具调用报错
4. 输入已经包含精确文件、行号和方法位置

**降级后纪律**：仅对"codegraph 未覆盖的那一项任务"用 grep/read，已用 codegraph 拿到的符号不得再用 grep/read 重复获取。

#### 禁止行为（高频踩坑）

- ❌ 用 grep 搜索已被 codegraph 索引的类名/方法名（应 `codegraph_search`）
- ❌ 已知方法名仍 `grep` 全仓找文件再 `read` 整文件（应 `codegraph_node(includeCode=true)` 直接拿源码）
- ❌ 追踪调用链时逐个 `read` 文件人工拼接（应 `codegraph_callees` 一次拿全下游）
- ❌ 对同一文件连续多次 `read` 不同行号（应 `codegraph_explore` 或一次 `read` 全文件）
- ❌ 用 `sqlite3` 查询 `codegraph.db`

### 有准确位置场景（grep/read 优先）

输入包含文件路径、行号或 CodeQL 数据流定位信息，直接精确定位。

**优先级**：先定位，后读取。grep/glob 定位 → read(offset, limit) 精确读取 → read(全文件) 备选。

**sast-audit 例外**：若 CodeQL JSON 缺失关键证据，可使用 codegraph 补充数据流分析（此时回归"无准确位置"策略，codegraph 优先）。

---

## 反幻觉约束（通用）

| 禁止行为 | 正确做法 |
|---------|---------|
| 假设代码存在 | 必须 Read 工具读取 |
| 假设 HTTP 入口存在 | 必须找到 REST/gRPC 入口 |
| 假设参数可控 | 必须追踪数据流 |
| 假设防护措施有效 | 必须读取防护实现代码 |
| 假设配置值安全 | 必须确认配置来源（Kconf 可信） |

---

## PROJECT_CONTEXT.md 消费纪律（通用）

`.redtrace/code-audit/PROJECT_CONTEXT.md`（由 arch-scan 模式生成，位于任务 Workspace）中的标记——`RPC-DOWNSTREAM:`、`ID-TYPE:`、`PUBLIC-DATA:`、`TENANT-BOUNDARY:`、`STRIDE-*:`，以及 Architecture 章节的认证体系/全局拦截器/路径白名单记录——**仅作参考线索，不构成最终判定依据**。api-audit / report-review / security-assessment 消费这些标记时必须遵守：

| 纪律 | 说明 |
|------|------|
| 标记 = 先验线索，非结论 | 标记提示「去哪里验证」，不能代替代码确认 |
| 必须代码确认 | 凡依据 PROJECT_CONTEXT.md 做出的安全/越权/认证结论，都必须 Read/grep 代码佐证实际逻辑 |
| 来源标签降权 | 仅基于 PROJECT_CONTEXT.md 未代码确认的防护 → `passed_checks[*].reason` / `description` 以 `[Docs-stated]` 起首，confidence ×0.8（见 references/common/source-discipline.md） |
| 标记可能过时 | arch-scan 在代码变更后未必刷新；当代码与标记矛盾时，**以代码为准** |

**禁止**：仅凭 PROJECT_CONTEXT.md 标记「直接判定」为安全/越权/有认证，从而跳过代码确认。
