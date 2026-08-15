# 更新模式

## 使用场景

对指定文件组中的 API 进行分析分类并写库。

**本模式定位**：最小执行单元。由主 agent（工作流模式）调度，接收主 agent 传入的文件组，直接进入分析流程，不自行查询全量库存，不负责调度分批。

**触发场景**：
- 主 agent 分配了一批待处理文件
- 用户直接要求更新某些 API 的描述/优先级

---

## 禁止操作

- **禁止自行查询全量 unprocessed API 重新分批**（文件组由主 agent 决定，本模式只处理传入的文件）
- 禁止在 JSON 格式错误时执行更新
- 禁止覆盖已有的 api_description（除非明确需要）
- 禁止输出 api_path 与原值相同的记录（避免无意义的更新）
- **临时文件必须写在 `.code-audit-tmp/` 目录**
- **禁止使用固定文件名**（必须加随机数后缀，避免并发冲突）
- **禁止使用 `bash echo` 写临时文件**（数据量大时 shell 转义会损坏 JSON，必须使用 write 工具）
- **禁止含中文内容时使用 `--json` 参数**（shell 引号嵌套 + 中文转义极易损坏 JSON，必须使用 `--file`）

---

## 执行流程

```
查询指定文件 API → 分析分类 → 质量检查 → 写库 → 输出结果
```

---

## Step 1: 查询指定文件的待处理 API

**触发条件**：进入更新模式，已知待处理文件列表

**必做动作**：

逐文件查询待处理 API，直接读 stdout：

- **常规情况**：查询该文件全部 unprocessed API（无论数量多少，整个文件一次性处理）
  ```bash
  python3 $REDTRACE_SKILLS_DIR/code-audit/scripts/api_inventory_cli.py query \
    --git <git_address> \
    --file-exact <file_path> \
    --status unprocessed
  ```

> **注意**：
> - **必须指定 `--git`**，避免查询到其他仓库的数据
> - 每次只查一个文件，逐文件处理。不查全量 unprocessed。单文件接口数量无论多少，均由本次子代理完整处理，不拆分。
> - **update 必须先 query 拿 id**：输出 JSON 的 `id` 必须来自本步 query 的返回值；缺失 id 会被 CLI 直接 skipped。不要凭空编造 id。

**结束门槛**：
- 该文件/批次有待处理 API → 进入 Step 2 分析
- 该文件/批次无待处理 API → 跳过，处理下一个文件

---

## Step 2: 分析分类

**触发条件**：Step 1 返回该文件的待处理 API

**必做动作**：
1. 读取文件源码，定位每个 `api_method` 的实现
2. 理解 API 功能和参数
3. 根据 priority-rules.md 判定 priority 和 api_type
4. 生成 api_description，包含分类标签

**必须先读取规则文件**：
```
code-audit/references/modes/api-inventory/priority-rules.md
```
重点参考章节：
- **Section 五（分类决策树）**：优先级判定流程
- **Section 七（标签体系 + 识别规则）**：api_description 标签 + api_type 分类
- **Section 0（接口环境/类型）**：降级规则

**api_description 禁止规则（强制执行）**：
- **禁止直接复制方法名作为描述**（如 `pollingUnfinishedProductsForWeb`）
- **禁止仅输出方法名的驼峰拆分**（如 `polling unfinished products for web`）
- **必须理解代码逻辑后生成有意义的中文描述**，说明接口的实际业务功能
- 若无法理解功能，标注为「功能待确认」并输出原文方法名供人工复核

**正确示例**：
- 方法名 `getUserInfo` → 描述：`获取用户基本信息（ToC）`
- 方法名 `pollingUnfinishedProductsForWeb` → 描述：`轮询未完成商品列表供Web端展示（ToC）`
- 方法名 `deleteAdminUser` → 描述：`管理员删除用户账号（管理端）`

> **重要**：`inner`、`operate`、`admin`、`test` 类型的接口**不会被安全审计**，请仔细判断，避免误标导致接口被跳过审计。

**api_path 补全（Java/Kotlin 项目强制执行）**：
1. 读取文件，找到类级别 `@RequestMapping` 注解（含常量拼接形式）
2. 检查库中该文件每个 API 的 `api_path` 是否已包含类级别前缀
3. **不完整则必须在输出中包含补全后的完整 `api_path`**，不得省略
   - 字面量示例：类 `@RequestMapping("/rest/admin")` + 方法 `@GetMapping("/list")` → 补全为 `/rest/admin/list`
   - 同文件常量：`BASIC_PATH="/rest/web"` + `@RequestMapping(BASIC_PATH + "/user")` + 方法 `@GetMapping("/info")` → 补全为 `/rest/web/user/info`
   - **外部常量引用**：若 `@RequestMapping` 引用其他类的常量（如 `ApiPathConstant.AUTHORITY_PATH`），**必须用 grep 在项目中搜索该常量的定义值**，用实际值拼接完整路径（如 `/rest/shareBattle/bizConfig/authority/batchAdd`）
4. 非 Java/Kotlin 项目或路径已完整 → 不输出 `api_path` 字段

**输出格式（JSON 数组）**：
```json
[
  {"id": 1, "api_description": "获取用户信息（ToC）", "priority": "P1", "api_type": ["toc"]},
  {"id": 2, "api_description": "管理员删除用户（内部API-管理端）", "priority": "P2", "api_type": ["inner","admin"]},
  {"id": 3, "api_description": "内部RPC查询商品（内部API-服务间调用）", "priority": "P3", "api_type": ["inner"]},
  {"id": 5, "api_description": "企业订单创建（ToB-管理端）", "priority": "P1", "api_type": ["tob","admin"], "api_path": "/api/v1/enterprise/orders"}
]
```

> **api_path 字段**：Java/Kotlin 项目中路径不完整时**必须输出**；路径已完整或非 Java/Kotlin 项目则不输出。

**结束门槛**：
- 分析完成，JSON 格式正确 → 进入质量检查

---

## 质量检查（Step 3 前强制执行）

- [ ] 所有 API 已填写 api_description
- [ ] api_description 不等于 api_method（禁止直接复制方法名）
- [ ] api_description 包含中文描述（纯英文方法名拆分无效）
- [ ] 所有 API 已标注 priority（P0/P1/P2/P3）
- [ ] api_type 为数组格式（如 `["toc"]`、`["tob","admin"]`、`["unclassified"]`），每个值在合法枚举内（`inner`/`operate`/`admin`/`tob`/`toc`/`test`/`unclassified`），**禁止输出 null**
- [ ] Java/Kotlin 项目：路径不完整的 API 已在输出中包含补全后的 api_path
- [ ] JSON 格式正确（无语法错误）

**任一项未通过 → 返回 Step 2 重新分析**

---

## Step 3: 写库

**触发条件**：质量检查通过

**必做动作**：
1. 生成随机后缀：
   ```bash
   openssl rand -hex 4
   ```
2. 用 **write 工具**将完整 JSON 数组写入 `.code-audit-tmp/api_updates_{随机后缀}.json`（**禁止使用 bash echo**）
3. 执行批量更新命令：
   ```bash
   python3 $REDTRACE_SKILLS_DIR/code-audit/scripts/api_inventory_cli.py update --git <git_address> --file .code-audit-tmp/api_updates_{随机后缀}.json
   ```

**结束门槛**：
- 输出 `{"status":"success","updated":N}` → 处理下一个文件（回到 Step 1）
- 输出 `{"status":"error",...}` → 检查 JSON 格式或文件路径

---

## Step 4: 输出结果

**触发条件**：所有指定文件处理完毕

**输出格式**：
```
=== 更新完成 ===
处理文件: {file_count} 个
已更新 API: {updated} 个

优先级分布:
  - P0: {p0} 个
  - P1: {p1} 个
  - P2: {p2} 个
  - P3: {p3} 个
```

---

## 优先级快速判定

| 优先级 | 触发条件（任一） |
|--------|----------------|
| **P0** | 资金交易、认证授权、文件上传、命令执行、无认证敏感接口 |
| **P1** | 文件下载、PII 数据、权限管理、外部请求 (SSRF)、合同/资质 |
| **P2** | 核心业务写操作、批量操作、配置管理 |
| **P3** | 一般查询、公开数据 |

详细规则：[priority-rules.md](priority-rules.md)
