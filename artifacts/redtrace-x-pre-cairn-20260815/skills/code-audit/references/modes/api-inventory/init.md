# 初始化模式

## 使用场景

新项目首次入库，自动发现 API 并存入数据库。

**触发场景**：
- 新项目首次入库
- 需要扫描项目所有 API

---

## 禁止操作

- 重复初始化同一项目是安全的（INSERT OR IGNORE 自动跳过已存在的 API），但建议使用发现模式增量更新
- 禁止跳过语言识别步骤
- 禁止忽略 --dry-run 预览结果

---

## 执行流程

```
识别语言 → 建立索引 → 执行脚本 → 验证完成 → 输出汇总
```

---

## Step 1: 识别语言

**触发条件**：执行初始化命令

**必做动作**：
1. 检查项目根目录文件
2. 确定主要语言

**语言判断依据**：

| 语言 | 判断依据 |
|------|----------|
| Java | `pom.xml`, `build.gradle`, `src/main/java/` |
| Kotlin | `build.gradle.kts`, `src/main/kotlin/` |
| Go | `go.mod`, `main.go` |
| Python | `requirements.txt`, `setup.py`, `pyproject.toml` |
| JavaScript/TypeScript | `package.json`, `yarn.lock` |

**结束门槛**：
- 语言已确定 → 进入 Step 2
- 语言不支持 → 进入发现模式（不支持语言）

---

## Step 2: 建立 codegraph 索引

**触发条件**：语言已确定

**前置条件**：`api_discovery_cli.py` 依赖 codegraph 索引（`.codegraph/codegraph.db`）进行 API 发现。

**必做动作**：
1. 检查项目是否已有索引：
   ```bash
   ls <repo_path>/.codegraph/codegraph.db
   ```
2. 若不存在，建立索引：
   ```bash
   codegraph init <repo_path>
   ```
3. 若已存在，增量同步（可选）：
   ```bash
   codegraph sync <repo_path>
   ```

**结束门槛**：
- `.codegraph/codegraph.db` 存在 → 进入 Step 3

---

## Step 3: 执行脚本

**触发条件**：codegraph 索引已存在

**必做动作**：
1. 执行发现脚本
   ```bash
   python3 $REDTRACE_SKILLS_DIR/code-audit/scripts/api_discovery_cli.py <repo_path> --git <git_address>
   ```
2. 观察输出日志

> **说明**：脚本通过 codegraph 的 `route` 节点发现 API（亚秒级），支持所有 codegraph 能识别路由的语言（Java/Kotlin/Go/Python/JavaScript/TypeScript）。

**发现类型**：
| 类型 | 识别方式 | http_method |
|------|----------|-------------|
| REST API | codegraph route 节点（GET/POST/PUT/DELETE/PATCH 等） | GET/POST/PUT/DELETE/PATCH/OTHER |
| gRPC API | codegraph route 节点（RPC 类型） | RPC |

**CLI 参数**：

| 参数 | 类型 | 说明 |
|------|------|----------|
| `repo_path` | 位置参数（可选） | 仓库本地路径（默认：当前目录） |
| `--git` | 必填 | Git 仓库地址 |
| `--output-file` | 可选 | 输出 JSON 文件路径，**路径需包含 `.code-audit-tmp/` 目录** |
| `--dry-run` | 可选 | 只发现不存储 |
| `--verbose` | 可选 | 详细输出 |

> **重要**：`--output-file` 路径需包含 `.code-audit-tmp/` 目录（支持相对或绝对路径）。示例：
> ```bash
> # 相对路径
> python3 $REDTRACE_SKILLS_DIR/code-audit/scripts/api_discovery_cli.py <repo_path> --git <git_address> --output-file .code-audit-tmp/api_discovery.json
> # 绝对路径
> python3 $REDTRACE_SKILLS_DIR/code-audit/scripts/api_discovery_cli.py /data/repos/myproj --git <git_address> --output-file /data/repos/myproj/.code-audit-tmp/api_discovery.json
> ```

**结束门槛**：
- 日志输出「插入新数据: N 条」（N > 0）→ 进入 Step 4
- 日志输出「插入新数据: 0 条」但索引存在 → 检查 codegraph 是否支持该项目的路由框架，可手动进入发现模式补充
- 输出 `codegraph 索引不存在` → 返回 Step 2 建立索引

---

## Step 4: 验证完成

**触发条件**：脚本执行完成

脚本执行后会自动输出摘要：
```
==================================================
初始化完成
  数据库已有记录: 10 条
  本次新增: 0 条（已跳过重复）
  待处理: 10 条
==================================================
下一步: 执行 api-inventory update 模式处理待处理 API
```

**必做动作**：
1. 确认摘要中的数据正确
2. 若需详细验证，可用 `stats --include-files` 获取完整统计：
   ```bash
   python3 $REDTRACE_SKILLS_DIR/code-audit/scripts/api_inventory_cli.py stats --git <git_address> --include-files
   ```

**结束门槛**：
- 日志显示 file_count > 0 且 total > 0 → 初始化成功
- 日志显示 file_count = 0 → 检查参数或路径

---

## 质量检查（Step 4 后强制执行）

- [ ] 脚本日志显示"初始化完成"摘要
- [ ] 摘要中 total > 0（数据库已有记录）
- [ ] 抽查字段质量（**强制，至少 2 个文件**）：分别抽查一个 Controller 文件和一个 API 数量最多的文件，用 `--file-exact` 验证 api_path 完整性、http_method 正确性：
  ```bash
  python3 $REDTRACE_SKILLS_DIR/code-audit/scripts/api_inventory_cli.py query --git <git_address> --file-exact <file_path>
  ```
- [ ] gRPC API 的 http_method 为 "RPC"（如有 gRPC 服务，抽查验证）
- [ ] **Java 项目 gRPC 兜底**：若 `by_http_method.RPC = 0`，执行以下命令确认是否真的无 gRPC 服务：
  ```bash
  grep -rl "@KrpcService\|extends.*ImplBase\|Grpc.*newStub" <repo_path> --include="*.java" 2>/dev/null | head -5
  ```
  若有输出 → 说明 codegraph 未识别到 gRPC，需进入发现模式补充；无输出 → 确认无 gRPC，正常
- [ ] REST API 的 api_path 完整性（Java/Kotlin 项目）：抽查 api_path 是否包含类级别前缀

**任一项未通过 → 检查脚本参数或项目路径**

---

## 注意事项

1. **唯一性约束**：同一 `(git_address, file_path, api_method, http_method)` 只能有一条记录（方法重载通过 `api_method` 函数名与 `http_method` 区分；同一方法的多路径映射处理见注意事项 4）
2. **增量入库**：重复运行时自动跳过已存在的 API
3. 初始化后 `api_description` 为空，需通过 [更新模式](update.md) 完成分析
4. **多路径方法**：Spring 中一个方法可映射多个路由路径（`@RequestMapping` 数组），`api_discovery_cli.py` 自动保留主路径（段数最多、最具体的路径），其余路径丢弃并输出 `[多路径方法]` warning 日志。如需保留全部路径，可在 `--dry-run` 结果中手动补充插入。
