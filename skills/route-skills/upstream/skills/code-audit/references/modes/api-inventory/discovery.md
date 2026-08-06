# 发现模式

## 使用场景

在指定目录中搜索遗漏 API，增量插入库存。

**本模式定位**：最小执行单元。由主 agent（工作流模式）调度，接收主 agent 传入的搜索目录和现有文件列表，直接进入搜索流程，不自行查询全量库存，不负责扫描目录结构。

**触发场景**：
- 主 agent 分配了一个待搜索的模块目录
- 用户直接要求发现某目录下的遗漏 API

---

## 禁止操作

- **禁止自行扫描全仓库目录结构**（搜索范围由主 agent 指定，本模式只处理传入的目录）
- **禁止自行查询全量库存**（现有文件列表由主 agent 传入，本模式按传入列表去重）
- 禁止忽略去重规则
- **临时文件路径需包含 `.code-audit-tmp/` 目录**（支持相对或绝对路径）
- **禁止使用 `bash echo` 写临时文件**（数据量大时 shell 转义会损坏 JSON，必须使用 write 工具）
- **禁止使用固定文件名**（必须加随机数后缀，避免并发冲突）
- **!!! 禁止使用 `api_discovery_cli.py` 脚本 !!!**（该脚本会全量扫描并插入，无法区分「已有库存覆盖的文件」和「新文件」；发现模式需要在已知 `existing_file_paths` 的前提下精确去重，必须手动搜索后按 `(file_path + api_method)` 组合判断是否已存在）

---

## 执行流程

```
搜索路由 → 提取信息 → 去重 → 分类分级 → 写库 → 输出结果
```

---

## Step 1: 搜索路由定义

**触发条件**：已接收搜索目录（`{search_path}`）和现有文件列表（`{existing_file_paths}`）

**必做动作**：

在指定目录下搜索路由定义。若项目有 codegraph 索引，优先使用 codegraph MCP 工具精准定位路由文件（禁止使用 sqlite3）：
```
codegraph_search(query="route controller", kind="route")
```
返回的每条结果含 file_path，据此确定路由文件集合，跳过 grep 扫描。
若 codegraph_search 无返回（索引未建立或不支持该语言）→ 降级使用下方 grep 模式（fallback）。
**Java/Kotlin 项目注意**：grep 搜索到的路由文件需文件名含 `Controller`（大小写不敏感），非 Controller 文件（如 `*ServiceImpl.java`、`*Client.java`）应跳过。

按语言搜索路由定义（fallback）：

| 语言 | 接口类型 | Grep 搜索模式 |
|------|----------|----|
| Java/Kotlin | REST | `@(GetMapping\|PostMapping\|PutMapping\|DeleteMapping\|PatchMapping)` |
| Java | gRPC | `@KrpcService` 或 `extends.*ImplBase` |
| Go | REST | `\.(GET\|POST\|PUT\|DELETE\|PATCH)\(` |
| Python | REST | `@\w+\.(route\|get\|post\|put\|delete\|patch)\(` |
| JavaScript | REST | `\.(get\|post\|put\|delete\|patch)\(` |

**gRPC 方法识别（仅 Java）**：
- 类注解 `@KrpcService(serviceName = "xxx")`
- 类继承 `extends *Grpc.*ImplBase`
- 方法 `@Override` + 首参数含 `Req`
- 排除 `manualWarmUp`、`serverStart`、`serverStop` 等生命周期方法
- 路径格式：`/{serviceName}/{methodName}`，http_method 为 `RPC`

**结束门槛**：
- 有匹配文件 → 进入 Step 2
- 无匹配 → 输出「该目录无路由文件」并结束

---

## Step 2: 提取 API 信息

**触发条件**：Step 1 找到路由定义

**必做动作**：

使用 Read 工具读取匹配文件，逐文件提取：
1. HTTP 方法（`@GetMapping` → `GET`）
2. api_path：
   - **Java/Kotlin**：必须组合类级别 `@RequestMapping` 前缀 + 方法级别路径
     - 字面量：类 `@RequestMapping("/rest/web")` + 方法 `@GetMapping("/list")` → `/rest/web/list`
     - 常量拼接：先在同文件搜索常量定义（如 `BASIC_PATH = "/rest/web"`），再拼接
   - 其他语言：直接提取路由路径，将 `{id}` 转换为 `:id`
3. api_method（处理函数名）
4. **http_method 必须是枚举值**：GET/POST/PUT/DELETE/PATCH/RPC/OTHER（全大写，未知方法用 OTHER）

---

## Step 3: 去重

**触发条件**：Step 2 提取到 API 列表

**去重规则**：
- 当 `file_path` 在 `{existing_file_paths}` 中时：
  - 若需确认该文件具体已有哪些 api_method，可用 `--file-exact` 精确查询：
    ```bash
    python3 $REDTRACE_SKILLS_DIR/route-skills/upstream/skills/code-audit/scripts/api_inventory_cli.py query --git <git_address> --file-exact <file_path> --output-file .code-audit-tmp/api_existing_{hash}.json
    ```
  - 按 `(file_path + api_method)` 组合去重，已存在的跳过
- 当 `file_path` 不在 `{existing_file_paths}` 中时：该文件所有 API 均为新增，无需查库

> **`{existing_file_paths}` 的时效性**：此列表由主 agent 在启动本次子代理前从最新 `--summary` 中提取，每个子代理使用的都是当时最新快照。主 agent 在收到本次子代理结果后，必须重新执行 `--summary` 刷新列表再传给下一个子代理，不得复用旧列表。

**结束门槛**：
- 有新增 API → 进入 Step 4
- 无新增 API → 输出「无新增」并结束

---

## Step 4: 分类分级

**触发条件**：有新增 API 需要写库

**必须先读取规则文件**：
```
code-audit/references/modes/api-inventory/priority-rules.md
```
重点参考章节：
- **Section 七（识别规则）**：api_type 分类判定
- **Section 四（快速识别关键词）**：priority 快速判定
- **Section 0（接口环境/类型）**：降级规则（最低 P3）

每个新增 API 必须输出：
- `api_type`：JSON 数组，如 `["toc"]` 或 `["tob","admin"]`；无特征则为 `["unclassified"]`
- `priority`：P0/P1/P2/P3（应用降级规则后）

**api_type 路径自动推断**（当无法从注解/源码判断时，按路径特征推断）：

| 路径特征 | api_type |
|----------|----------|
| `/internal/` 或 `/inner/` | `["inner"]` |
| `/admin/` 或 `/manage/` | `["admin"]` |
| `/test/` 或 `/mock/` | `["test"]` |
| `/operate/` 或 `/operation/` | `["operate"]` |
| `/rest/web/` | `["toc"]` |
| `/rest/open/` 或 `/open/` | `["tob"]` |
| `/api/`（弱信号） | 优先用源码上下文判断，仅无其他线索时默认 `["toc"]` |
| 无明显特征 | `["unclassified"]` |

> 路径推断仅作为兜底，优先使用源码上下文（注释、类名、包名）判断。本规则为文档约定，由执行发现模式的 AI 子代理参照应用，无需在脚本中实现。

---

## Step 5: 写库

**触发条件**：新增 API 已完成分类分级

**必做动作**：
1. 补充 `git_address` 字段到每条记录
2. 生成随机后缀：
   ```bash
   openssl rand -hex 4
   ```
3. 用 **write 工具**将完整 JSON 数组写入 `.code-audit-tmp/api_new_{随机后缀}.json`（**禁止使用 bash echo**）
4. 执行插入命令：
   ```bash
   python3 $REDTRACE_SKILLS_DIR/route-skills/upstream/skills/code-audit/scripts/api_inventory_cli.py insert --file .code-audit-tmp/api_new_{随机后缀}.json
   ```

**插入字段**：

| 字段 | 说明 | 来源 |
|------|------|------|
| `git_address` | Git 仓库地址 | 主 agent 传入 |
| `file_path` | 文件路径 | Step 2 提取 |
| `api_path` | API 路由路径 | Step 2 提取 |
| `http_method` | HTTP 方法 | Step 2 提取 |
| `api_method` | 处理函数名 | Step 2 提取 |
| `api_type` | API 类型（必填，无特征为 `["unclassified"]`） | Step 4 分类 |
| `priority` | 优先级（可选，默认 P3） | Step 4 分级 |

**结束门槛**：
- 输出 `{"status":"success","inserted":N}` → 进入 Step 6
- 输出 `{"status":"error",...}` → 检查 JSON 格式

---

## 质量检查（Step 5 前强制执行）

- [ ] 所有新 API 已包含 git_address
- [ ] JSON 格式正确
- [ ] api_type 已填充（必须为 JSON 数组，无特征用 `["unclassified"]`，禁止 null）和 priority 已填充
- [ ] Java/Kotlin 项目：api_path 包含类级别前缀

**任一项未通过 → 返回对应步骤重新处理**

---

## Step 6: 输出结果

**触发条件**：写库完成

**输出格式**：
```
=== 发现完成（{search_path}）===
  - 发现路由文件: {files} 个
  - 新增 API: {new} 个（已存在: {existing} 个）
  - 插入状态: 成功
```
