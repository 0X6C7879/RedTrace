# MR Review 模式 - 代码变更安全审查

分析 MR/PR 代码变更，识别引入的安全问题。

---

## 分析范围限定

**前端项目只分析前端安全问题，后端项目只分析后端安全问题**：

**前端项目特征**（命中任一即为前端）：
- 存在 `package.json`（无 `pom.xml`/`build.gradle`）
- 存在 `src/` + `components/` 或 `pages/` 目录
- 主要文件扩展名为 `.vue`、`.jsx`、`.tsx`

**前端项目分析范围**：
- XSS（跨站脚本）
- 敏感信息泄露（前端暴露密钥、token）
- 开放重定向（URL 参数直接跳转）
- CSRF（前端可感知的 token 暴露）
- 前端代码中的 SSRF（通过 fetch/axios 代理接口）和 RCE（通过 eval/new Function/动态脚本加载）
- **不分析**：IDOR、SQL注入、XXE、反序列化等纯服务端漏洞

**后端项目特征**（命中任一即为后端）：
- 存在 `pom.xml` 或 `build.gradle`（Java）
- 存在 `go.mod`（Go）
- 存在 `requirements.txt` 或 `setup.py`（Python）
- 存在 `@Controller`/`@RestController` 注解
- 存在 `src/main/java/` 目录

**后端项目分析范围**：
- SQL 注入、NoSQL 注入
- IDOR、越权、认证绕过
- SSRF、RCE、XXE、反序列化
- 路径遍历、文件上传
- SSTI、CORS 配置错误
- 硬编码密钥

**全栈/混合项目**（同时命中前端和后端特征）：
- 合并前端和后端分析范围，两范围均需覆盖
- 典型场景：Spring Boot + React 同仓、Next.js/Nuxt.js（API Routes + 前端渲染）、Java Thymeleaf/JSP（后端逻辑 + 模板 XSS）
- 模板引擎项目（Thymeleaf/JSP/FreeMarker）需同时分析后端逻辑漏洞和模板中的 XSS

---

## 判定标准

> 判定结论标准见 SKILL.md「通用安全判定标准」章节。

---

## 判定框架

```
MR 变更安全审查
├── Step 1: 获取 Git Diff 并语言检测
├── Step 2: 风险发现 → 构建风险列表
├── Step 3-6: 对每个风险逐一判定
│   └── 单风险判定流程:
│       ├── 安全写法 → 跳过
│       └── 危险写法
│           ├── HTTP入口不可达 → 风险-A
│           └── HTTP入口可达
│               ├── 无认证 → BrokenAccessControl（未授权）（IDOR/越权类别）
│               ├── 有认证 + 无有效防护 → 漏洞
│               └── 有认证 + 有弱防护 → 风险-B
├── Step 6.3: 漏洞类型互斥检查
├── Step 6.5: IDOR风险价值评估
├── Step 6.7: 误报过滤检查
└── Step 7: 汇总输出 → JSON 报告
```

**漏洞类型优先级**:

| 优先级 | 类型 | 枚举值 | 说明 |
|--------|------|--------|------|
| 1（优先） | 基础安全漏洞 | `SQLi`, `NoSQLi`, `SSRF`, `XXE`, `RCE`, `PathTraversal`, `FileUpload`, `Deserialization`, `XSS`, `OpenRedirect`, `CORS`, `Hardcoded`, `SSTI`, `FormatString`, `WebEnableDebug`, `IntegerOverflow`, `WeakRNG`, `PrototypePollution`, `JWT`, `LDAPi`, `JDBCi`, `SwaggerMisconfig` | 风险等级明确，危害严重，技术利用路径固定 |
| 2（其次） | 业务逻辑漏洞 | `IDOR`, `BrokenAccessControl`, `BusinessLogic`, `BatchExport`, `PrivateVideo`, `CSRF`, `PromptInjection` | 需结合业务场景判断，风险等级相对模糊 |

**原因**：基础安全漏洞的危害程度与技术利用路径相对固定，属于高确定性风险；业务逻辑漏洞需更多业务上下文，属于情境依赖性风险。

**关键原则**:
- **优先检查本次MR引入的问题**：仅关注本次变更引入的安全漏洞/风险，对于已存在的安全问题（非本次MR引入）不做过多分析。
- MR 可能包含多个独立风险，每个风险单独判定
- 风险列表在 Step 2 构建，后续步骤循环处理
- 确认为安全写法的风险从列表移除，不再参与后续分析
- IDOR/BrokenAccessControl 必须先检查认证状态，无认证归为 BrokenAccessControl（未授权）

---

## 执行流程

### Step 1: 获取 Git Diff 并语言检测

**触发条件**: 开始 MR 审查

**必做动作**:
1. 从 Git 上下文提取 source_branch, target_branch, source_commit, target_commit
2. 使用 git 命令获取 diff 内容和变更文件列表
3. 排除测试文件 (`*Test.java`, `*_test.go`, `test/`, `tests/`, `test_*.py`, `*.test.ts`/`*.spec.ts`)
4. 排除生成文件 (`generated/`, `vendor/`, `node_modules/`)
5. 过滤非代码文件（.md, .txt, 图片等）
6. 统计变更文件的扩展名分布，确定项目主要语言
7. 加载对应的 references/{lang}/{lang}-router.md

**结束门槛**:
- 成功检测语言 → 进入 Step 2
- 无有效代码文件 → 判定为 safe，终止分析

**输出**:
```
[STEP_1] 获取 Git Diff 并语言检测
  - 源分支: {source_branch}
  - 目标分支: {target_branch}
  - 有效代码文件: {M} 个
  - 检测语言: {java/go/python/javascript}
  - 加载路由: references/{lang}/{lang}-router.md
```

**禁止**:
- 跳过测试文件排除
- 跳过生成文件排除

### Step 2: 风险类型识别

**触发条件**: Step 1 已完成语言检测

**必做动作**:
1. 扫描变更代码中的不安全模式
2. 使用 {lang}-router.md 中的关键词映射表匹配漏洞类型
3. 构建风险列表

**结束门槛**:
- 未检测到不安全模式 → 判定为 safe，终止分析
- 检测到不安全模式 → 进入 Step 3

**禁止**:
- 跳过关键词映射表匹配

### Step 3: 危险写法验证与防护检查

**触发条件**: Step 2 风险列表中存在待验证项

**必做动作**:
1. 加载 references/{lang}/{lang}-{type}.md
2. 对每个风险项：
   - 使用 Grep 定位代码位置
   - 使用 Read 精确读取代码上下文（至少包含前后 10 行）
   - 对照文档中的"危险模式"表格验证
   - 对照文档中的"防护措施"表格检查

**结束门槛**:
- 确认为安全写法 → 从列表移除，继续处理下一项
- 确认为危险写法 → 保留在列表中，进入 Step 4
- 所有问题处理完 → 进入 Step 4

**禁止**:
- 假设代码实现（必须 Read 实际代码）
- 仅凭方法名判断（必须读取方法体）
- 跳过防护措施检查（必须读取防护实现代码）

### Step 4: HTTP/gRPC 入口可达性分析

**触发条件**: Step 3 确认的危险写法列表

> 本步属"无准确代码位置"子任务（反向调用链追踪起点未知），回归 codegraph 优先策略，见 SKILL.md「工具使用规范」。

**必做动作**:
1. 使用 `codegraph_callers` 反向追踪调用链（一次拿全所有调用方，禁止逐个 grep 手工拼接；仅当该方法未被 codegraph 索引时退回 grep）
2. 追踪数据流到 HTTP/gRPC 入口点
3. 加载 references/{lang}/{lang}-common-retrieval.md

**结束门槛**:
- 不可达 → 判定为 risk-a，处理下一项
- 可达 → 保留在列表中，进入 Step 5
- 所有问题处理完 → 进入 Step 6

### Step 5: 防护强度判定

**触发条件**: Step 4 确认入口可达的危险写法列表

**必做动作**:
1. 逐个检查防护措施强度
2. 对照 references/{lang}/{lang}-{type}.md 中的防护类型表格

**认证前提检查（IDOR/越权类别强制执行）**:
若风险类别为 IDOR 或 BrokenAccessControl：
1. 检查接口是否有认证机制（注解、拦截器、中间件、配置）
2. 若发现无认证：
   - category 改为 BrokenAccessControl，标注为未授权子类型
   - 继续按 BrokenAccessControl 评估防护强度
   - 后续不再执行 IDOR 相关检查

**判定**:
- 无认证（IDOR/越权类别）→ 纠正为 BrokenAccessControl，标注为未授权子类型
- 无有效防护 → 判定为 vulnerability，处理下一项
- 有弱防护（如仅长度限制、黑名单） → 判定为 risk-b
- 有强防护（参数化/类型约束/白名单） → 从列表移除
- 所有问题处理完 → 进入 Step 6

**来源纪律标签（强制执行）**：
防护措施的 `description` 必须以来源标签之一起首：
- `[Code-verified]` — 代码追踪验证的防护，confidence 不降
- `[Config-assumed]` — 框架/配置默认假设，confidence ×0.8
- `[Docs-stated]` — 来自文档声明，confidence ×0.8
详见 `references/common/source-discipline.md`

### Step 6: 变更影响分析

**触发条件**: Step 5 完成所有风险的防护强度判定

**必做动作**:
1. 判断问题是否为本次变更引入
2. sink 点所在行在变更范围内 → `is_introduced_by_mr = true`

**结束门槛**:
- 完成影响分析 → 进入 Step 6.3

### Step 6.3: 漏洞类型互斥检查（强制）

**触发条件**: Step 6 完成变更影响分析

**必做动作**: 按优先级保留唯一类型

**互斥判定规则**（按优先级从高到低）:

| 优先级 | 条件 | 保留类型 | 移除类型 |
|--------|------|---------|---------|
| 1 | 无认证 | **BrokenAccessControl** | IDOR |
| 2 | 有认证 + 无所有权校验 + 访问他人资源 | **IDOR** | - |
| 3 | 有认证 + 无角色/权限校验 + 管理功能 | **BrokenAccessControl** | - |
| 4 | 业务流程漏洞（状态绕过、并发竞态） | **BusinessLogic** | IDOR |

**实施流程**:
```
风险列表
    │
    ├─ 发现无认证？
    │   ├─ 是 → 仅保留 BrokenAccessControl，移除 IDOR → 结束
    │   └─ 否 → 继续
    │
    ├─ 发现无所有权校验（访问他人资源）？
    │   ├─ 是 → 仅保留 IDOR，移除 BrokenAccessControl → 继续
    │   └─ 否 → 继续
    │
    ├─ 发现权限注解可绕过？
    │   ├─ 是 → 保留 BrokenAccessControl → 继续
    │   └─ 否 → 继续
    │
    └─ 发现业务流程漏洞（状态绕过/并发竞态）？
        ├─ 是 → 仅保留 BusinessLogic，移除 IDOR → 结束
        └─ 否 → 保留原类型
```

**结束门槛**: 完成类型互斥检查 → 进入 Step 6.5

> **SwaggerMisconfig 独立判定**：SwaggerMisconfig 与上述 IDOR/BAC/BusinessLogic 类型不互斥。Swagger 文档框架的配置问题（如 UI 暴露）与业务端点的权限问题是不同维度，可同时报告为独立 finding。

### Step 6.5: IDOR 风险价值评估（强制）

**触发条件**: Step 6.3 完成后，风险类别为 IDOR

**必做动作**:

1. **资源归属判断**:
   - 资源标识符 == 身份标识符（如 userId）→ 从列表移除（非越权）
   - 身份标识符来源不可信（如来自请求参数）→ 从列表移除

2. **返回数据类型评估（仅读操作）**:
   - 布尔值（boolean）→ severity 强制 low
   - 统计数据（count/sum）→ severity 强制 low
   - 已公开数据（搜索可见）→ 从列表移除

3. **操作类型调整**:
   - 删除操作 → severity +1（最高 critical）
   - 修改金额/权限字段 → severity 升级为 critical

4. **ID可预测性检查**:
   - UUID + 单条查询 → 降为 risk-b

**结束门槛**: 完成 IDOR 评估 → 进入 Step 6.7

### Step 6.7: 误报过滤检查

**触发条件**: Step 6.5 完成 IDOR 风险价值评估

**必做动作**:
1. 加载 references/common/false-positive-filtering.md
2. 逐项检查是否命中排除规则
3. 命中排除规则的风险从列表移除

**结束门槛**:
- 所有风险项检查完成 → 进入 Step 7

**禁止**:
- 跳过误报排除规则检查

### Step 7: 输出 JSON 报告

**执行内容**:
- 汇总所有判定的漏洞和风险
- 相同 category + entry_point + root_cause 的合并为一个
- **必须**按照"输出规范"章节输出纯 JSON 格式报告

**强制要求**: 输出必须是纯 JSON，不包含任何解释文字

---

## 质量检查（本模式强制执行）

在输出 JSON 前，按顺序验证：

- [ ] Step 1-7 所有子步骤已执行
- [ ] 已加载所有"相关文档"引用的规则文件
- [ ] IDOR/BrokenAccessControl 类别已执行认证前提检查
- [ ] IDOR 类别已执行风险价值评估（Step 6.5）
- [ ] 已执行漏洞类型互斥检查（Step 6.3）
- [ ] 已应用误报排除规则（references/common/false-positive-filtering.md）
- [ ] 已按 severity-rating.md 标准评定 severity 字段
- [ ] 结论值在核心概念表格的枚举范围内（vulnerability/risk-a/risk-b/safe）
- [ ] 所有必需字段有值（非空字符串）
- [ ] 输出为纯 JSON 格式

**验证不通过时，禁止输出 JSON。**

---

## 输出规范（强制执行）

**重要**: 判定完成后必须严格按照此格式输出纯 JSON。

**输出格式**: 纯 JSON（不包含 Markdown 代码块标记 ```json ... ```）

**字段要求**:
- 必需字段必须返回
- 可选字段无值时使用空字符串 `""` 或 `null`
- 字段顺序固定，便于解析

### 字段定义

#### findings.vulnerabilities / findings.risks

| 字段 | 类型 | 必需 | 枚举值/格式 | 说明 |
|------|------|------|-------------|------|
| `id` | string | 是 | VULN-XXX / RISK-A-XXX / RISK-B-XXX | 唯一标识 |
| `category` | string | 是 | SQLi / NoSQLi / RCE / SSRF / XSS / PathTraversal / FileUpload / XXE / Deserialization / OpenRedirect / CORS / Hardcoded / IDOR / PrivateVideo / SSTI / FormatString / WebEnableDebug / IntegerOverflow / WeakRNG / PrototypePollution / JWT / BrokenAccessControl / CSRF / PromptInjection / BusinessLogic / BatchExport / SwaggerMisconfig（完整定义及别名映射见 references/common/category-enum.md）| 漏洞分类 |
| `conclusion` | string | 是 | vulnerability/risk-a/risk-b/safe/unknown | 判定结论 |
| `severity` | string | 是 | critical/high/medium/low/info | 严重程度（评级标准见 references/common/severity-rating.md）|
| `entry_point` | string | 是 | HTTP Method + Path 或 gRPC Service | 入口点 |
| `root_cause` | string | 是 | <=100字符 | 根本原因 |
| `is_introduced_by_mr` | boolean | 是 | - | 是否为本次变更引入。true 表示本次MR新增的问题，需重点关注；false 表示已存在的问题，简要说明 |
| `affected_locations` | array | 是 | 见下表 | 受影响位置 |
| `description` | string | 是 | <=500字符 | 详细描述 |
| `recommendation` | string | 是 | <=500字符 | 修复建议 |
| `confidence` | number | 是 | 0-1 | 置信度 |
| `occurrences` | integer | 是 | >=1 | 出现次数 |
| `data_flow` | string | 条件 | - | 数据流流向（仅 vulnerability 结论时必需）|
| `example_payload` | array | 条件 | - | 示例 payload 数组（仅 vulnerability 结论时必需）|

#### affected_locations 子字段

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `file_path` | string | 是 | 文件路径（**必须使用相对路径**，相对于项目根目录，禁止使用绝对路径） |
| `line_number` | integer | 是 | 行号 |

**file_path 示例**：
- 正确：`src/main/java/com/example/UserController.java`
- 错误：`/home/user/project/src/main/java/com/example/UserController.java`

#### summary 字段

| 字段 | 类型 | 必需 | 枚举值 | 说明 |
|------|------|------|--------|------|
| `functional_impact` | string | 是 | - | 功能影响描述 |
| `vulnerabilities_count` | integer | 是 | >=0 | 漏洞总数 |
| `risks_count` | integer | 是 | >=0 | 风险总数 |
| `safe` | boolean | 是 | - | 是否安全 |
| `review_status` | string | 是 | PASS/BLOCK/WARNING | 审查结论 |
| `overall_severity` | string | 是 | critical/high/medium/low/info | 最高严重级别 |
| `key_findings` | array[string] | 是 | - | 关键发现 |

#### passed_checks 子字段

| 字段 | 类型 | 必需 | 枚举值/格式 | 说明 |
|------|------|------|-------------|------|
| `type` | string | 是 | - | 检查的漏洞类别 |
| `reason` | string | 是 | <=500字符，**必须以 `[FP-x.y]` 或 `[FP-NONE]` 起首**（规则编号见 references/common/false-positive-filtering.md「FP 规则索引」） | 判定为安全的原因 |

### 输出示例

```json
{
  "findings": {
    "vulnerabilities": [
      {
        "id": "VULN-001",
        "category": "BrokenAccessControl",
        "conclusion": "vulnerability",
        "severity": "critical",
        "entry_point": "POST /api/v1/resource/recover",
        "root_cause": "新增恢复接口未添加认证注解，userId从请求体传入可冒充任意用户",
        "is_introduced_by_mr": true,
        "affected_locations": [
          {
            "file_path": "resource-api/src/main/java/com/example/resource/controller/ResourceController.java",
            "line_number": 71
          }
        ],
        "description": "新增recover接口未添加@LoginRequired认证注解（同文件其他接口均有）。userId直接从请求体传入，未授权用户可构造任意userId冒充其他用户，结合resourceId和version参数，可恢复并覆盖任意用户的数据。验证难度极低，无需认证即可实施未授权访问。",
        "recommendation": "1. 添加@LoginRequired注解；2. 通过@CurrentUser从会话获取真实userId，禁止从请求体接收",
        "confidence": 0.98,
        "occurrences": 1,
        "data_flow": "Request[userId] → recover(req):78 → resourceService.recover(userId, resourceId, version):36 → DB UPDATE",
        "example_payload": [
          "POST /api/v1/resource/recover",
          "{\"userId\": 123456789, \"resourceId\": 1, \"version\": 5}  # 修改userId可恢复其他用户数据"
        ]
      },
      {
        "id": "VULN-002",
        "category": "SQLi",
        "conclusion": "vulnerability",
        "severity": "high",
        "entry_point": "GET /api/v1/resource/list",
        "root_cause": "新增列表接口，orderBy参数直接拼接到SQL ORDER BY子句",
        "is_introduced_by_mr": true,
        "affected_locations": [
          {
            "file_path": "resource-api/src/main/java/com/example/resource/controller/ResourceController.java",
            "line_number": 89
          },
          {
            "file_path": "resource-api/src/main/java/com/example/resource/service/ResourceService.java",
            "line_number": 156
          }
        ],
        "description": "新增listResources接口的orderBy参数未经校验直接拼接到SQL ORDER BY子句。未授权用户可注入恶意SQL实现盲注窃取数据库数据。验证难度低，仅需有效账号即可实施。",
        "recommendation": "使用ORM的orderByAsc/orderByDesc方法，或对orderBy参数进行白名单校验",
        "confidence": 0.95,
        "occurrences": 1,
        "data_flow": "Request[orderBy] → listResources(projectId, orderBy):89 → resourceService.list(projectId, orderBy):90 → queryWrapper.apply(orderBy):156 → DB SELECT",
        "example_payload": [
          "GET /api/v1/resource/list?projectId=1&orderBy=name;SELECT+SLEEP(5)--",
          "GET /api/v1/resource/list?projectId=1&orderBy=IF((SELECT+password+FROM+users+WHERE+id=1)LIKE'a%',SLEEP(5),0)"
        ]
      }
    ],
    "risks": [
      {
        "id": "RISK-A-001",
        "category": "SQLi",
        "conclusion": "risk-a",
        "severity": "high",
        "entry_point": "内部方法: ResourceInternalService.exportToExcel(resourceId, orderBy)",
        "root_cause": "新增内部导出方法，orderBy参数拼接SQL但仅被定时任务调用",
        "is_introduced_by_mr": true,
        "affected_locations": [
          {
            "file_path": "resource-api/src/main/java/com/example/resource/service/ResourceInternalService.java",
            "line_number": 89
          },
          {
            "file_path": "resource-api/src/main/java/com/example/resource/scheduled/ResourceScheduledTask.java",
            "line_number": 45
          }
        ],
        "description": "新增exportToExcel内部方法，orderBy参数拼接SQL ORDER BY子句。该方法仅被Scheduled定时任务调用，无HTTP/gRPC入口可达。定时任务参数来自数据库配置，用户不可控。验证难度极高（无外部入口），但代码本身存在SQL拼接问题。",
        "recommendation": "使用ORM的orderByAsc/orderByDesc方法消除SQL拼接",
        "confidence": 0.9,
        "occurrences": 1
      },
      {
        "id": "RISK-B-001",
        "category": "SSRF",
        "conclusion": "risk-b",
        "severity": "high",
        "entry_point": "POST /api/v1/resource/export",
        "root_cause": "新增导出接口，exportUrl参数用户可控且使用黑名单校验内网IP",
        "is_introduced_by_mr": true,
        "affected_locations": [
          {
            "file_path": "resource-api/src/main/java/com/example/resource/controller/ResourceController.java",
            "line_number": 134
          }
        ],
        "description": "新增exportResource接口，exportUrl参数完全用户可控。使用黑名单校验内网IP（阻止10.x、172.16.x、192.168.x），但黑名单不完整，未覆盖127.0.0.1、0.0.0.0、169.254.x.x等特殊地址。验证难度低（仅需有效账号），黑名单防护不充分。",
        "recommendation": "改用域名白名单（精确匹配）或隔离代理访问外部URL",
        "confidence": 0.85,
        "occurrences": 1
      },
      {
        "id": "RISK-B-002",
        "category": "IDOR",
        "conclusion": "risk-b",
        "severity": "low",
        "entry_point": "DELETE /api/v1/resource/draft/:draft_uuid",
        "root_cause": "新增草稿删除接口，draft_uuid用户可控但UUID v4格式不可预测",
        "is_introduced_by_mr": true,
        "affected_locations": [
          {
            "file_path": "resource-api/src/main/java/com/example/resource/controller/ResourceController.java",
            "line_number": 167
          }
        ],
        "description": "新增deleteDraft接口，有认证但缺少资源所有权校验。draft_uuid参数完全用户可控，可删除其他用户的草稿数据。但draft_uuid为UUID v4格式，暴力枚举不可行。验证难度极高，ID可预测性极低（UUID v4随机生成）。",
        "recommendation": "添加资源所有权校验，验证当前用户对draft_uuid的访问权限",
        "confidence": 0.8,
        "occurrences": 1
      }
    ],
    "passed_checks": [
      {
        "type": "XSS",
        "reason": "返回数据经JSON序列化，无HTML拼接输出"
      },
      {
        "type": "PathTraversal",
        "reason": "无文件路径参数"
      },
      {
        "type": "IDOR",
        "reason": "POST /api/v1/resource/save: 修改的save接口已通过@CurrentUser获取userId，未从请求体接收"
      },
      {
        "type": "SQL注入",
        "reason": "GET /api/v1/resource/:resource_id: 使用ORM的getById方法，参数化查询"
      }
    ]
  },
  "summary": {
    "functional_impact": "资源管理模块引入多个安全问题：2个严重漏洞（认证缺失、SQL注入），1个内部方法SQL拼接风险，1个SSRF黑名单防护不充分，1个IDOR因UUID不可预测已降级",
    "vulnerabilities_count": 2,
    "risks_count": 3,
    "safe": false,
    "review_status": "BLOCK",
    "overall_severity": "critical",
    "key_findings": [
      "VULN-001(BrokenAccessControl): recover接口无认证，验证难度极低",
      "VULN-002(SQLi): orderBy参数拼接SQL，可盲注窃取数据",
      "RISK-A-001(SQLi): 内部方法exportToExcel拼接SQL，无HTTP入口可达",
      "RISK-B-001(SSRF): 黑名单校验不完整，未覆盖所有内网地址",
      "RISK-B-002(IDOR): deleteDraft存在IDOR，但UUID v4不可预测，已降级为risk-b"
    ]
  }
}
```

---

## 模式专属资源

无独立子文档。数据流追踪方法论由 agent 自主执行，工具纪律见 SKILL.md「工具使用规范」。

## 相关文档

- 语言路由: references/{lang}/{lang}-router.md
- IDOR 规则: references/{lang}/{lang}-idor.md
- 通用规则: references/common/*.md（净化措施、可信数据源、SSRF代理等）
- 误报排除规则: references/common/false-positive-filtering.md（区分安全漏洞与代码质量问题）
- 严重程度评级: references/common/severity-rating.md（IDOR 专项判定表）
