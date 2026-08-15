# 工作流模式

## 使用场景

自动执行完整的库存管理流程，确保 API 库存完整且已分析。

**触发场景**：

- 首次入库新项目
- 定期维护已有项目
- 需要确保库存完整性

---

## 禁止操作

- **禁止跳过 Step 0 强制初始化**
- 禁止在有未处理 API 时进入 Step 4
- 禁止手动修改数据库绕过脚本验证
- **禁止在 Step 1 发现模式中使用 `api_discovery_cli.py` 脚本**（该脚本仅限 Step 0 初始化使用，发现模式必须使用子代理搜索）
- **禁止主 agent 自己执行 update/insert 写库动作**（写库由子代理通过 skill 完成，主 agent 只负责调度与验收）
- **禁止子代理执行任何 delete 操作**（子代理发现需删除的记录时，应在回复中输出待删除 id 列表，由主 agent 在 Step 2 统一执行删除）
- **`--output-file` 路径需包含 `.code-audit-tmp/` 目录**（支持相对或绝对路径）

---

## 执行原则

Step 0（初始化）、Step 2（清理）到达时，主 agent 加载对应文档执行：

| 触发条件 | 必须加载 |
|----------|----------|
| 需要初始化 | [init.md](init.md) |
| 需要删除 | [delete.md](delete.md) |

**Step 1（发现）和 Step 3（更新）通过子代理调用 skill 执行，主 agent 负责调度与验收。**

---

## 执行流程

```
初始化 → 子代理发现遗漏 API → 去重清理 → 子代理更新（含路径补全） → 最终验证 → 输出报告
```

---

## Step 0: 强制初始化

**触发条件**：工作流启动时（无论数据库是否有数据）

**必做动作**：

1. **加载 [init.md](init.md)**
2. 执行 codegraph sync（始终执行，确保索引与代码同步）
3. 执行初始化流程（发现脚本通过 `.codegraph/codegraph.db` 进行 API 发现）
4. 执行 `stats --git <git_address>` 查看库存 total：
   - 输出「本次新增 N 条」（N=0 说明无新 API，N>0 进入 Step 1 重点验收新文件）

**说明**：
- 每次执行 api_discovery_cli.py 均安全，唯一键 `(git_address, file_path, api_method, http_method)` 保证幂等
- codegraph sync 后新增的路由节点会被脚本捕获并入库
- Step 0 是唯一调用 api_discovery_cli.py 的地方（发现模式禁止调用该脚本）

**结束门槛**：

- 初始化完成 → 进入 Step 1

---

## Step 1: 子代理发现遗漏 API

**触发条件**：Step 0 初始化完成

**必做动作**：

1. 获取当前库存的文件分组统计（用于后续对比）
   ```bash
   python3 $REDTRACE_SKILLS_DIR/code-audit/scripts/api_inventory_cli.py query --git <git_address> --summary
   ```
2. 用 glob/ls 扫描仓库，识别包含路由文件的顶层模块目录列表（`{MODULE_DIRS}`）：按语言特征（Java: `*Controller.java`、Go: `*handler*`、Python: `*router*` 等）定位各模块目录
3. **差集计算（强制）**：
   - 从上方 `--summary` 结果提取库存文件集合 B（file_path 字段）
   - 将 glob 扫描到的路由文件集合 A 与 B 做差集（A - B = 在磁盘有但库存没有的文件）
   - 差集为空 → 跳过子代理，直接进入 Step 2
   - 差集不为空 → 仅将差集文件所在目录作为 `{search_path}` 传给子代理
4. 并行逐目录启动子代理，每个目录完成后验收，再处理下一个目录

**子代理 prompt 模板**：
```
使用 code-audit 技能的 api-inventory 发现模式搜索以下目录的遗漏 API 并插入库存。

注意：
- 不要把临时文件放在 `/tmp/` 下，临时文件统一放在当前项目路径的 `.code-audit-tmp/` 下，没有该目录就创建一个。
- 严禁执行 `rm -rf`、`sqlite3`、`drop`、`delete`等不可逆命令！！
- **严禁执行任何 delete API 记录的操作**；若发现需删除的记录，在回复末尾以 JSON 列表形式列出待删除 id（格式：`{"delete_suggestion": [id1, id2, ...]}`），由主 agent 统一决策执行。
- 代码分析工具选择：见 SKILL.md「工具使用规范」章节

项目信息：
- Git 地址：{git_address}
- 仓库路径：{repo_path}
- 项目语言：{language}

搜索范围（本次仅此目录）：{search_path}

现有库存文件列表（用于去重，仅列出 file_path）：
{existing_file_paths}

说明：发现模式是最小执行单元，会在指定目录搜索路由、去重、分类分级、插入库存。你只需传入上述参数，无需额外说明流程。
```

> **`{existing_file_paths}`** 从 `--summary` 结果中提取 file_path 字段，只传路径列表，不传 API 详情。

**子代理验收（每个目录完成后执行）**：

再次获取文件分组统计，与执行前对比：
```bash
python3 $REDTRACE_SKILLS_DIR/code-audit/scripts/api_inventory_cli.py query --git <git_address> --summary
```
- 对比前后 file_count 和各文件 total：若子代理报告有新增但统计无变化 → 记录异常，重试一次
- 若有新增文件，用 `--file-exact` 抽查新文件详情，验证字段质量：
  ```bash
  python3 $REDTRACE_SKILLS_DIR/code-audit/scripts/api_inventory_cli.py query --git <git_address> --file-exact <new_file_path> --output-file .code-audit-tmp/api_verify_new.json
  ```
  检查：api_path 是否完整（含类级别前缀）、http_method 是否正确、priority 是否已设置
- **验收完成后，必须从最新 `--summary` 结果中刷新 `{existing_file_paths}`**，再传给下一个目录的子代理，不得复用旧列表

**结束门槛**：

- 所有目录扫描完毕（无论是否有新 API）→ 进入 Step 2

---

## Step 2: 清理非 API 记录 + 去重

**触发条件**：Step 1 所有目录发现完成

**必做动作**：

1. **加载 [delete.md](delete.md)** 执行清理
2. **检测重复接口**：用 `--find-duplicates` 查找重复记录
   ```bash
   python3 $REDTRACE_SKILLS_DIR/code-audit/scripts/api_inventory_cli.py query --git <git_address> --find-duplicates
   ```
   返回格式：`[{"file_path": "...", "api_method": "...", "count": 2, "ids": [1,2], "keep_id": 1, "duplicate_ids": [2]}, ...]`
3. **删除重复记录**：**执行删除前必须检查 `api_path` 是否相同**：
   - `api_path` 完全相同 → 真重复，保留 `keep_id`，删除 `duplicate_ids`
   - `api_path` 不同 → 一方法多路径映射（Spring 合法用法），**不应删除**；新版 `api_discovery_cli.py` 已自动处理此情况，此类记录仅在旧数据中出现
   ```bash
   # 预览（--git 必填）
   python3 $REDTRACE_SKILLS_DIR/code-audit/scripts/api_inventory_cli.py delete --git <git_address> --ids <duplicate_ids逗号分隔> --dry-run
   # 确认删除
   python3 $REDTRACE_SKILLS_DIR/code-audit/scripts/api_inventory_cli.py delete --git <git_address> --ids <duplicate_ids逗号分隔> --confirm
   ```

**结束门槛**：

- 非 API 记录已清理、无重复 → 进入 Step 3
- 无需清理 → 直接进入 Step 3

---

## Step 3: 子代理更新未处理 API

**触发条件**：Step 2 清理去重完成

**必做动作**：

1. 用 `--summary --status unprocessed` 获取有未处理 API 的文件列表（只返回 unprocessed > 0 的行，已全部处理的文件不出现）
   ```bash
   python3 $REDTRACE_SKILLS_DIR/code-audit/scripts/api_inventory_cli.py query --git <git_address> --status unprocessed --summary
   ```
   返回格式：`[{"file_path": "...", "total": N, "processed": M, "unprocessed": K}, ...]`（直接读 stdout，数据量小）
2. 读取结果，**自行决定分批策略**：综合考虑文件数量、API 数量、文件复杂度，合理分组
3. 并行启动子代理，每批完成后立即验收

**分批原则（参考，非强制上限）**：
- **同一文件不得拆分给多个子代理**（拆分会导致子代理读取同一文件源码时上下文割裂，无法正确理解类级别路由前缀）
- 文件数量少时（如 ≤5 个文件）：可将所有文件合并给单个子代理一次处理
- 文件数量多时：按模块/目录聚合分批，优先并行启动多个子代理以提升速度
- API 数量极多的单文件（如 >50 个）：单独作为一批，给予充足上下文

**子代理 prompt 模板**：
```
使用 code-audit 技能的 api-inventory 更新模式处理以下文件的 API。

注意：
- 必须按更新模式完整流程执行：读取源码 → 分析分类 → 生成 JSON → **调用 api_inventory_cli.py update 写库**。不允许只生成 JSON 而不执行写库命令。
- 不要把临时文件放在 `/tmp/` 下，临时文件统一放在当前项目路径的 `.code-audit-tmp/` 下，没有该目录就创建一个。
- 严禁执行 `rm -rf`、`sqlite3`、`drop`、`delete`等不可逆命令！！
- **严禁执行任何 delete API 记录的操作**；若发现路径不完整、重复等需删除的记录，在回复末尾以 JSON 列表形式列出待删除 id（格式：`{"delete_suggestion": [id1, id2, ...]}`），由主 agent 在 Step 2 统一决策执行。
- 代码分析工具选择：见 SKILL.md「工具使用规范」章节

项目信息：
- Git 地址：{git_address}
- 仓库路径：{repo_path}

待处理文件及未处理 API 数量：
{文件列表，每行格式：- {file_path}（{n} 个未处理 API）}

- **写库验证（强制）**：执行 `api_inventory_cli.py update --file` 后，必须运行以下命令确认 unprocessed 数量已减少：
  ```bash
  python3 $REDTRACE_SKILLS_DIR/code-audit/scripts/api_inventory_cli.py query --git {git_address} --status unprocessed --summary
  ```
  若数量未减少，说明写库失败，必须重新执行 update 命令，最多重试 1 次。验证结果包含在回复中。

说明：更新模式是最小执行单元，直接处理上述传入的文件列表，不要自行查询全量库存或重新分批。
```

**子代理验收（每批完成后强制执行）**：

从该批文件中按 **unprocessed 数量降序**取前 **min(3, 该批文件数)** 个文件抽查，确保复杂文件优先验收：
```bash
python3 $REDTRACE_SKILLS_DIR/code-audit/scripts/api_inventory_cli.py query --git <git_address> --file-exact <file_path> --output-file .code-audit-tmp/api_verify_<file_name>.json
```
验收要点（逐条检查，**不合格需重试**）：
- `api_description` 已填充且包含中文，不等于方法名
- `priority` 已填充（P0/P1/P2/P3）
- `api_type` 已填充（非 null，无特征用 `["unclassified"]`）
- Java/Kotlin 项目：`api_path` 包含类级别路由前缀（如 `/rest/web/xxx` 而非仅 `/xxx`）
- 若该文件 unprocessed 数量无减少 → 子代理未正确写库，重试一次

**熔断机制**：同一批连续 2 次验收后数据无变化，跳过该批，标记失败并继续下一批。

**结束门槛**：

- 所有批次处理完毕（含跳过的批次） → 进入 Step 4

---

## Step 4: 最终验证

**说明**：安全网步骤，捕获 Step 3 中因 update 部分失败（如校验不通过被跳过）导致的残留未处理记录。

**触发条件**：Step 3 所有批次完成

**必做动作**：

1. 用 `--summary` 确认是否还有未处理记录：
   ```bash
   python3 $REDTRACE_SKILLS_DIR/code-audit/scripts/api_inventory_cli.py query --git <git_address> --status unprocessed --summary
   ```

**结束门槛**：

- 有 unprocessed > 0 的文件 → 跳回 Step 3
- 所有文件 unprocessed = 0 → 进入质量检查

---

## 质量检查（进入 Step 5 前强制执行）

- [ ] 查询返回 0 条未处理记录 → 失败回 Step 3
- [ ] Java/Kotlin 项目 REST API 路径包含类级别前缀（由 update 模式负责检查补全） → 失败回 Step 3
- [ ] 所有已处理 API 的 api_type 不为 NULL（无特征应标记为 `["unclassified"]`） → 失败回 Step 3
- [ ] api_type untyped 比率 ≤ 20%：执行 `stats --git <git_address>` 查看 by_api_type.untyped，untyped / total > 20% → 回 Step 3 补充分类（子代理 prompt 注明"重点补充 api_type 为 null 的记录，无特征的标记为 unclassified"）
- [ ] Java/Kotlin 项目 api_path 前缀完整率 ≥ 95%（抽样验证）：从 stats by_file 中取 api 数量最多的 3 个文件执行 `--file-exact`，检查 api_path 是否均含类级别前缀（如 `/api/llm4sec/v1/`）→ 有不完整则回 Step 3

**任一项未通过 → 返回对应步骤重新执行**

---

## Step 5: 输出汇总报告

**触发条件**：质量检查全部通过

**必做动作**：

1. 用 `stats --include-files` 命令获取完整统计数据（含文件分组）：
   ```bash
   python3 $REDTRACE_SKILLS_DIR/code-audit/scripts/api_inventory_cli.py stats --git <git_address> --include-files
   ```
   返回：`{total, processed, unprocessed, by_priority: {...}, by_http_method: {...}, by_api_type: {...}, by_file: [{file_path, total, processed, unprocessed}, ...]}`
2. 生成汇总报告

**输出格式**：

```
=== API 库存工作流执行完成 ===
项目: {git_address}

总 API 数: {total}
  - REST API: {total - by_http_method.RPC} 个
  - gRPC API: {by_http_method.RPC} 个
  - P0 (必须审计): {by_priority.P0} 个
  - P1 (重点审计): {by_priority.P1} 个
  - P2 (抽样审计): {by_priority.P2} 个
  - P3 (可选审计): {by_priority.P3} 个
  - api_type 分布（按值独立计数，一个 API 可有多个类型）:
    - toc (用户端): {by_api_type.toc} 个
    - tob (企业端): {by_api_type.tob} 个
    - inner (内部接口): {by_api_type.inner} 个
    - operate (运营端): {by_api_type.operate} 个
    - admin (管理端): {by_api_type.admin} 个
    - test (测试接口): {by_api_type.test} 个
    - unclassified (未分类): {by_api_type.unclassified} 个
    - 未分析(null): {by_api_type.untyped} 个

处理状态: 全部已分析 ✓

子代理执行摘要:
  - 发现目录: {discovery_dirs} 个，新增 API: {new_apis} 个
  - 更新批次: {update_batches} 批，成功 {success_batches} 批，跳过 {skipped_batches} 批
```

---

## 工作流图示

```
Start
 │
 ├─ Step 0: 强制初始化 ───────────── 总是执行（跳过已存在API）
 │
 ├─ Step 1: 子代理发现遗漏 API
 │   │
 │   ├─ 主agent扫描目录 ──→ 子代理（discovery skill）──→ 插入
 │   │
 │   ├─ 主agent验收（--summary 对比 + --file-exact 抽查）
 │   │
 │   └─ 循环至所有目录完成
 │
 ├─ Step 2: 清理+去重 ──────── 有非API/重复? ──→ 删除
 │
 ├─ Step 3: 子代理更新未处理 API（含 api_path 补全）
 │   │
 │   ├─ 分组分批 ──→ 子代理（update skill）──→ 分析+路径补全+写库
 │   │
 │   ├─ 主agent验收（--file-exact 查详情，检查描述/优先级/路径）
 │   │
 │   └─ 循环至所有批次完成
 │
 ├─ Step 4: 最终验证
 │   │
 │   ├─ 仍有未处理 ──→ 回 Step 3
 │   │
 │   └─ 全部完成 ──→ 继续
 │
 └─ Step 5: 输出汇总报告
```

---

## 相关模式

- [初始化模式](init.md) - 新项目首次入库
- [更新模式](update.md) - 分析分类 API（供子代理调用）
- [发现模式](discovery.md) - 发现遗漏 API（供子代理调用）
- [查询模式](query.md) - 查询现有 API
- [删除模式](delete.md) - 清理错误 API 记录
