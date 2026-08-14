# API Inventory 模式 - API 库存管理

API 库存管理，支持 API 发现、分类、查询、优先级管理。

---

## 模式概述

API 库存管理是安全审计的前置流程，通过发现和管理 API 端点，为后续的安全审计提供准确的目标清单。支持所有 codegraph 能识别路由的语言（Java/Kotlin/Go/Python/JavaScript/TypeScript）的 REST API 和 gRPC 接口发现。不支持的框架可通过发现模式手动 Grep 补充。

**核心价值**：
- 发现项目中所有 REST API 端点和 Java gRPC 接口
- 对 API 进行功能分类和优先级分级
- 为安全审计提供 P0/P1 高优先级 API 清单
- 追踪 API 的审计状态

---

## 子模式选择

| 子模式 | 使用场景 | 触发关键词 | 文档入口 |
|--------|----------|------------|----------|
| **初始化** | 新项目首次入库 | 初始化、init、首次入库、新建项目 | references/modes/api-inventory/init.md |
| **更新** | 分析分类 API | 更新、分类、分析、优先级 | references/modes/api-inventory/update.md |
| **查询** | 查询现有 API | 查询、查看、列出、导出 | references/modes/api-inventory/query.md |
| **发现** | 发现遗漏 API | 发现、新增、discover | references/modes/api-inventory/discovery.md |
| **工作流** | 自动执行完整流程 | 工作流、workflow、全量、完整、一键、自动 | references/modes/api-inventory/workflow.md |
| **删除** | 清理错误/重复 API | 删除、清理、去重、remove、delete | references/modes/api-inventory/delete.md |

---

## CLI 工具

### Codegraph 必要条件

`api_discovery_cli.py` 依赖 codegraph 索引（`.codegraph/codegraph.db`）进行 API 发现。执行前需确保索引已建立：

```bash
codegraph init <repo_path>
```

> 索引已存在时可用 `codegraph sync <repo_path>` 增量同步。

### API 发现 CLI

自动从代码仓库中发现 REST API 端点和 gRPC 接口：

```bash
python3 $REDTRACE_SKILLS_DIR/code-audit/scripts/api_discovery_cli.py <repo_path> --git <git_address> [options]
```

| 参数 | 说明 |
|------|------|
| `repo_path` | 仓库本地路径（位置参数，默认当前目录） |
| `--git` | Git 仓库地址（必填） |
| `--output-file` | 输出 JSON 文件路径，**必须使用 `.code-audit-tmp/` 目录** |
| `--dry-run` | 只发现不存储 |
| `--verbose` | 详细输出 |

> **重要约束**：`--output-file` 路径需包含 `.code-audit-tmp/` 目录（支持相对或绝对路径）
> - 正确：`.code-audit-tmp/api_discovery.json` 或 `/data/repos/myproj/.code-audit-tmp/api_discovery.json`
> - 错误：`/tmp/api_discovery.json`

**发现类型**：
- REST API：通过 codegraph route 节点（GET/POST/PUT/DELETE/PATCH 等）识别，支持 Java/Kotlin/Go/Python/JavaScript/TypeScript
- gRPC API：通过 codegraph route 节点（RPC 类型）识别，`http_method` 为 `RPC`

### API 库存管理 CLI

管理已发现的 API（查询/更新/插入/删除）：

```bash
python3 $REDTRACE_SKILLS_DIR/code-audit/scripts/api_inventory_cli.py <command> [options]
```

| 命令 | 说明 | 关键参数 |
|------|------|----------|
| `query` | 查询 API | `--ids`, `--git`, `--status`, `--file-exact`, `--summary`, `--find-duplicates`, `--output-file`（推荐） |
| `update` | 批量更新 API 描述和优先级 | `--file`（推荐）或 `--json`（不含中文时可用） |
| `insert` | 插入新 API | `--file`（推荐）或 `--json` |
| `stats` | 返回完整统计信息（优先级/HTTP方法/api_type 分布） | `--git`, `--include-files`, `--output-file` |
| `delete` | 删除 API | `--ids`, `--git`, `--confirm` |

> **批量数据推荐使用 `--file`**：update 和 insert 支持 `--file <path>` 从 JSON 文件读取，避免 shell 参数长度限制；含中文描述时**禁止使用 `--json`**。
> **query 推荐使用 `--output-file`**：将结果保存到文件，避免从 bash 输出中解析 JSON。
> **`--summary` 用于主 agent 调度**：按 file_path 分组统计每个文件的 total/processed/unprocessed 计数，不返回全量详情，适合主 agent 分批决策和验收对比。
> **`--find-duplicates` 用于去重检测**：直接返回 `(file_path, api_method)` 重复组，含 keep_id/duplicate_ids，供主 agent 执行 delete 时使用。
> **`stats` 用于汇总报告**：一次返回 priority/http_method/api_type 分布，无需多次 query 拼凑。加 `--include-files` 可同时返回 by_file 分组统计（合并 `--summary` 功能）。

---

## http_method 字段规范

`http_method` 字段仅接受以下枚举值（统一大写）：

| 值 | 含义 | 来源 |
|----|------|------|
| `GET` | HTTP GET 请求 | REST API @GetMapping 等 |
| `POST` | HTTP POST 请求 | REST API @PostMapping 等 |
| `PUT` | HTTP PUT 请求 | REST API @PutMapping 等 |
| `DELETE` | HTTP DELETE 请求 | REST API @DeleteMapping 等 |
| `PATCH` | HTTP PATCH 请求 | REST API @PatchMapping 等 |
| `RPC` | gRPC 方法（非 HTTP） | Java @KrpcService + extends *ImplBase |
| `OTHER` | 无法识别的方法 | 兜底值，用于无法归类的请求方法 |

> **重要**：任何小写、混合大小写或非标准值（如 `get`、`Get`、`USE`）会在写入时自动规范化为大写枚举值。未知方法兜底为 `OTHER`。

---

## 优先级分类体系

| 优先级 | 分数范围 | 审计要求 | 典型特征 |
|--------|----------|----------|----------|
| **P0** | 35-45 | 必须全量审计 | 支付、认证、文件上传、无认证敏感接口 |
| **P1** | 25-34 | 重点审计 | 文件下载、PII 数据、权限管理、外部请求 |
| **P2** | 15-24 | 抽样审计 | 核心业务写操作、批量操作、敏感查询 |
| **P3** | 5-14 | 可选审计 | 一般查询、公开数据、有认证的普通接口 |

详细规则见：references/modes/api-inventory/priority-rules.md

---

## 分类标签体系

| 分类 | 标签 | 路径特征 |
|------|------|----------|
| 测试API | （测试API） | /test/, /mock/, /debug/, /sandbox/ |
| 内部API | （内部API） | /internal/, /inner/, /private/ |
| 管理端API | （管理端）或组合标签 | /admin/, /manage/, /backend/ |
| ToB | （ToB）或组合标签 | enterprise, org, company |
| ToC | （ToC） | user, customer, member |
| 监控API | （监控API） | /health/, /metrics/, /ping/ |

---

## 与 api-audit 模式的关系

```
API Inventory (库存管理) → API Audit (安全审计)
      ↓                          ↓
  发现所有 REST API          审计 P0/P1 API
  发现 Java gRPC 接口        识别安全漏洞
  分类优先级                 生成审计报告
  确定审计范围
```

**推荐流程**：
1. 使用 `api-inventory` 工作流模式完成 API 库存建设（REST + gRPC）
2. 查询 P0/P1 优先级的 API 清单
3. 使用 `api-audit` 模式逐个审计高风险 API

---

## 质量检查（本模式强制执行）

在宣布完成前，按顺序验证：

- [ ] 已根据用户输入选择正确的子模式（初始化/更新/查询/发现/工作流/删除）
- [ ] 已加载对应子模式的文档（references/modes/api-inventory/{子模式}.md）
- [ ] CLI 工具调用参数正确（git 地址、命令等）
- [ ] 命令执行结果已验证（API 列表/更新结果等）
- [ ] gRPC API 的 http_method 为 "RPC"，路径格式为 `/{serviceName}/{methodName}`
- [ ] REST API 路径包含类级别前缀（Java/Kotlin 项目的 `@RequestMapping` 类注解前缀）
- [ ] 如有错误，已提供错误信息和解决建议

> **本模式不适用通用 JSON 输出校验脚本**（`$REDTRACE_SKILLS_DIR/code-audit/scripts/validate-output.cjs`）：api-inventory 输出为 API 库存数据而非漏洞 finding 结构，schema 不覆盖。跳过 SKILL.md 通用质量门禁的「输出格式校验」项。

**验证不通过时，禁止宣布完成。**

---

## 模式专属资源

| 文档 | 说明 | 路径 |
|------|------|------|
| 优先级分类规则 | API 优先级 P0-P3 判定标准 | references/modes/api-inventory/priority-rules.md |
| 初始化模式 | 新项目首次入库流程 | references/modes/api-inventory/init.md |
| 更新模式 | 分析分类 API 流程 | references/modes/api-inventory/update.md |
| 查询模式 | 查询现有 API 流程 | references/modes/api-inventory/query.md |
| 发现模式 | 发现遗漏 API 流程 | references/modes/api-inventory/discovery.md |
| 工作流模式 | 自动执行完整流程 | references/modes/api-inventory/workflow.md |
| 删除模式 | 清理错误 API 流程 | references/modes/api-inventory/delete.md |

## 相关文档

- 语言路由: references/{lang}/{lang}-router.md
- 通用规则: references/common/*.md（净化措施、可信数据源、SSRF代理等）
