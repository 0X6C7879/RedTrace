# 查询模式

## 使用场景

快速查看库存、导出列表。

**触发场景**：
- 查看现有 API
- 检查处理状态
- 导出 API 列表

---

## Step 1: 查询 API

**触发条件**：需要查看 API 库存

**必做动作**：
1. 构建查询命令（**--git 必填，限制查询范围**）
   ```bash
   python3 $REDTRACE_SKILLS_DIR/code-audit/scripts/api_inventory_cli.py query --git <git_address>
   ```
2. 执行查询

**结束门槛**：
- 返回结果 → 输出给用户
- 无结果 → 提示"无匹配记录"

---

## 筛选参数

| 参数 | 说明 | 示例 |
|------|------|------|
| `--git` | Git 地址（**必填**，限制查询范围） | `--git "github.com/user/repo"` |
| `--ids` | 按 ID 查询，逗号分隔 | `--ids 1,2,3` |
| `--file` | 文件路径模糊匹配 | `--file "controller"` |
| `--file-exact` | 文件路径精确匹配 | `--file-exact "src/api/UserController.java"` |
| `--method` | HTTP 方法（合法值：GET/POST/PUT/DELETE/PATCH/RPC/OTHER） | `--method GET`、`--method RPC`（gRPC） |
| `--priority` | 优先级 | `--priority P0` |
| `--api-type` | 接口类型 | `--api-type inner`、`--api-type operate` |
| `--status` | 处理状态 | `--status processed / unprocessed / all` |
| `--summary` | 按文件分组统计（轻量，不返回详情） | `--summary` |
| `--find-duplicates` | 查找重复记录，返回每组 keep_id/duplicate_ids | `--find-duplicates` |
| `--output-file` | 输出到 JSON 文件（推荐） | `--output-file .code-audit-tmp/api_list.json` |

> **重要约束**：
> - `--output-file` 路径需包含 `.code-audit-tmp/` 目录（支持相对或绝对路径）
> - `--git` 为必填参数，避免在多仓库环境下误操作其他仓库的数据

**使用建议**：
- 结果较多时（>20 条），推荐使用 `--output-file` 保存到文件，然后用 Read 工具读取
- 避免从 bash 输出中解析 JSON（输出包含命令信息，解析不可靠）
- **主 agent 调度/验收时推荐用 `--summary`**：按 file_path 分组返回 `{file_path, total, processed, unprocessed}` 统计，不返回全量 API 详情，适合分批决策和前后对比
  - `--summary` 支持与 `--status` 组合：`--status unprocessed` 只返回有未处理 API 的文件行；`--status processed` 只返回全部已处理的文件行；不加 `--status`（或 `--status all`）返回所有文件行
  - `--summary` 与 `--file`、`--file-exact`、`--ids` 等详情过滤参数**不可同时使用**（summary 是聚合统计，无意义）；`--method`、`--priority`、`--api-type` 同理
- **验收具体文件质量时用 `--file-exact`**：精确查一个文件的完整详情，检查 api_description/priority/api_type 是否合理

---

## api_type 取值说明

> **注意**：api_type 为数组字段，一个 API 可以有多个类型。查询时使用 `--api-type` 会匹配包含该类型的所有 API。

| 值 | 含义 | 示例 |
|----|------|------|
| `inner` | 内部接口（服务间调用、内网专用） | gRPC 服务间调用、`/internal/` 路径接口 |
| `operate` | 运营/管理后台接口 | 运营后台、`/operate/` 路径接口 |
| `admin` | 系统管理员接口 | 系统管理、`/admin/` 路径接口 |
| `test` | 测试接口 | 测试环境专用、`/test/` 路径接口 |
| `toc` | 面向普通用户的接口 | C 端用户接口 |
| `tob` | 面向企业客户的接口 | B 端企业接口 |
| `unclassified` | 未分类（已分析但无法归类） | 监控接口、无明显特征的接口 |

---

## 状态筛选

| 值 | 说明 | 判定条件 |
|----|------|----------|
| `processed` | 已完成分析分类 | `api_description` 不为空 |
| `unprocessed` | 待分析分类 | `api_description` 为空 |
| `all` | 全部（默认） | - |

---

## 输出格式

```json
[
  {
    "id": 1,
    "file_path": "src/api/user.go",
    "api_method": "GetUser",
    "api_path": "/api/users/:id",
    "http_method": "GET",
    "api_description": "获取用户信息（ToC）",
    "priority": "P1",
    "api_type": ["toc"]
  },
  {
    "id": 2,
    "file_path": "src/rpc/ItemDataRpcServiceImpl.java",
    "api_method": "batchGetItemBaseInfo",
    "api_path": "/itemDataRpcService/batchGetItemBaseInfo",
    "http_method": "RPC",
    "api_description": "批量获取商品基础信息（内部API-服务间调用）",
    "priority": "P3",
    "api_type": ["inner"]
  },
  {
    "id": 3,
    "file_path": "src/api/enterprise/EnterpriseController.java",
    "api_method": "createEnterprise",
    "api_path": "/admin/enterprise/create",
    "http_method": "POST",
    "api_description": "创建企业（ToB-管理端）",
    "priority": "P1",
    "api_type": ["tob","admin"]
  }
]
```
