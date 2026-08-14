# Report Review 模式 - 审计报告复核

对外部审计报告中的漏洞/风险发现进行复核，验证其结论是否准确，判断是否需要升级或降级。

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

**file_path 格式要求**：
- `affected_locations.file_path` 必须使用**相对路径**（相对于项目根目录）
- 正确示例：`src/main/java/com/example/UserController.java`
- 错误示例：`/home/user/project/src/main/java/com/example/UserController.java`

---

## 判定标准

> 判定结论标准见 SKILL.md「通用安全判定标准」章节。

**复核特有规则**：
- 复核只能维持、升级或降级现有发现，不能凭空引入新发现
- 复核必须通过阅读实际代码验证，不能仅基于摘要文本做出判断
- 无法读取到关键代码时，维持原始判定（不盲目调整）

---

## 判定框架

```
报告复核
├── Step 0: 输入解析与验证 → 解析外部报告 findings 列表
├── Step 1: 加载通用规则 → 误报排除 / 净化措施 / 可信数据源
├── Step 2: 逐一复核每个 finding
│   ├── Step 2.1: 定位并读取原始代码
│   ├── Step 2.2: 误报排除检查
│   ├── Step 2.3: 防护措施验证
│   ├── Step 2.3.3: 认证前提检查（IDOR/越权类别）
│   ├── Step 2.3.5: 风险价值复核（IDOR类别）
│   ├── Step 2.4-pre: N 票独立对抗验证（高危强制）
│   ├── Step 2.4: 升级/降级判定
│   └── Step 2.5: 构建 review 项
└── Step 3: 输出复核 JSON
```

---

## 执行流程

### Step 0: 输入解析与验证

识别用户提供的审计报告内容，提取每个 finding 的关键字段。

**输入格式**：文本形式的 findings 列表，每行包含 API 主键、路径、方法、severity 及完整 result_json。

| 字段 | 必需 | 说明 |
|------|------|------|
| `id` | 是 | API 记录主键（数字，如 6133），review_id 必须回传此值 |
| `api_path` | 是 | 定位代码，用于搜索 Controller/Handler |
| `http_method` | 是 | HTTP 方法，辅助定位路由 |
| `severity` | 是 | 原始评级，用于判断升级/降级方向 |
| `category` | 是 | 漏洞类别，用于加载对应规则文档 |
| `conclusion` | 是 | 判定结论，用于判断升级/降级方向 |
| `root_cause` | 否 | 辅助定位 sink 点，无值时需自行分析 |

**编排层实际输入格式**（非 JSON 数组）：
```
[id:6133] API: /models/custom/create [POST] (severity: high) {"findings": {...}, "summary": {...}}
```
- `[id:数字]` 是 API 记录主键，review_id 必须回传此数字
- `severity`/`category`/`conclusion` 等字段在 result_json 内部

⚠️ **注意区分两个 id**：
- 输入的 `[id:数字]` 是 API 记录主键 → 填到 review 顶层的 `review_id`
- finding 内部的 `id`（如 VULN-001/RISK-A-001）是漏洞编号 → 填在 `updated_result.findings.vulnerabilities/risks` 内部，**不要填到 `review_id`**

**输入示例**（JSON 形式供理解字段结构）：
```
[{"id": 6133, "api_path": "/rest/app/user/profile", "http_method": "GET", "severity": "high", "category": "IDOR", "conclusion": "vulnerability", "root_cause": "orderId参数用户可控，无归属校验"}]
```

**必做动作**：
1. 解析每条 finding 的关键字段（必需字段缺失时跳过该 finding）
2. 检测项目语言（用于后续加载语言规则）

**结束门槛**：
- 有有效 findings → 进入 Step 1
- 无有效 findings → 输出空 reviews 数组

### Step 1: 加载通用规则文档

**触发条件**: Step 0 已识别有效 findings

**必做动作**（强制加载）：
1. 加载 `references/common/false-positive-filtering.md` — 误报排除规则
2. 加载 `references/common/sanitization.md` — 净化措施判定
3. 加载 `references/common/trusted-sources.md` — 可信数据源判定

**按需加载**（根据 findings 类别和项目语言）：
- 含 SSRF 类别 → 加载 `references/common/ssrf-proxy.md`
- 涉及配置值 → 加载 `references/common/kconf.md`
- 已知项目语言 → 加载 `references/{lang}/{lang}-router.md`
- 已知项目语言 + finding 类别 → 加载 `references/{lang}/{lang}-{category}.md`（如 `java-idor.md`、`python-ssrf.md`）
  - 类别映射：IDOR → idor、SQL注入 → sql-injection、SSRF → ssrf、XSS → xss、RCE → rce、路径遍历 → path-traversal、XXE → xxe、开放重定向 → open-redirect、文件上传 → file-upload、反序列化 → deserialization、CORS → cors、硬编码 → hardcoded、SSTI/模板注入 → ssti(template-injection)、Swagger 不安全配置 → swagger-misconfig
  - 这些文档包含对应漏洞类型的研判标准和陷阱 case，复核时必须参考

**结束门槛**：文档已加载 → 进入 Step 2

### Step 2: 逐一复核 Finding

**触发条件**: Step 1 规则文档已加载

对每个 finding 按以下子步骤执行：

#### Step 2.1: 定位并读取原始代码

**必做动作**：
1. 使用 Grep 搜索 api_path 对应的路由定义，定位 Controller/Handler 代码
2. 验证 API 路径是否存在于代码库中：
   - 搜索所有路由定义（如 v1.POST/GET/PUT/DELETE/PATCH、@RequestMapping 等）
   - 若输入的 API 路径与现有路径均不匹配 → 标记为 API_NOT_FOUND（在 review 项中记录）
3. 使用 Read 读取入口点方法的完整代码
4. 根据 root_cause 描述，定位并读取 sink 点代码

**API 不存在时的处理**：
在 review 项中标记：
```json
{
  "review_id": "42",
  "api_path": "/xxx/yyy",
  "http_method": "GET",
  "original_severity": "high",
  "new_severity": "high",
  "changed": false,
  "change_reason": "API路径在代码库中不存在，无法验证，维持原判定"
}
```

**禁止**：
- 不读代码就做出判定
- 假设代码存在或不存在

**全局拦截器分析**（认证注解缺失时强制执行）：

当发现接口方法没有 `@LoginRequired`/`@PreAuthorize` 等认证注解时：
1. 查阅 .redtrace/code-audit/PROJECT_CONTEXT.md Architecture 章节作为**参考线索**（`[Docs-stated]`，confidence ×0.8），提示去哪里找拦截器配置；**.redtrace/code-audit/PROJECT_CONTEXT.md 记录不构成最终判定依据**
2. 无论 .redtrace/code-audit/PROJECT_CONTEXT.md 是否记录，都搜索/Read 代码确认拦截器的实际注册方式与路径覆盖。搜索 `WebMvcConfigurer`/`WebMvcConfigurerAdapter` 实现：
   ```bash
   grep -rn "WebMvcConfigurer\|addInterceptors\|HandlerInterceptor" --include="*.java"
   ```
3. 搜索 `SpringSecurity` 配置：
   ```bash
   grep -rn "SecurityFilterChain\|WebSecurityConfigurerAdapter\|@EnableWebSecurity" --include="*.java"
   ```
4. 搜索 NestJS 全局认证配置：
   ```bash
   grep -rn "MiddlewareConsumer\|NestMiddleware\|APP_GUARD\|useGlobalGuards\|forRoutes\|\.exclude(" --include="*.ts" --include="*.js"
   ```
5. 搜索 Express/Koa 全局中间件：
   ```bash
   grep -rn "app\.use.*[Aa]uth\|app\.use.*[Ll]ogin\|app\.use.*[Ss]so\|app\.use.*[Tt]oken" --include="*.ts" --include="*.js"
   ```
6. 搜索 Egg.js 全局中间件配置：
   ```bash
   grep -rn "config\.middleware\|middleware:" --include="*.js" --include="*.ts" config/
   ```
7. 确认全局拦截器/中间件的路径覆盖范围和排除路径：
   - Java：`addPathPatterns` 覆盖 / `excludePathPatterns` 排除 / `needLoginPathList`（路径白名单型：仅列入的路径需登录，目标 api_path 命中前缀则有认证）
   - NestJS：`forRoutes()` 覆盖 / `exclude()` 排除
   - Egg.js：`config.middleware` 全局生效，检查 `app/middleware/` 下对应中间件是否有路径排除逻辑

**判定**：全局拦截器/中间件已覆盖该 API 路径 → 认证存在，不标记为认证缺失

#### Step 2.2: 误报排除检查

**必做动作**：
1. 对照 `false-positive-filtering.md` 逐项检查
2. 判断该 finding 是否属于误报排除规则中列出的场景

**判定**：
- 命中排除规则 → 标记为降级，change_reason 注明命中的规则
- 未命中 → 继续下一步

#### Step 2.2.1: IDOR 专项误报排除（IDOR 类别强制执行）

**触发条件**: finding 类别为 IDOR

**必做动作**（按顺序执行，命中任一即标记降级）:

1. **RPC 下游凭证检查**（对应 false-positive-filtering.md 3.3.1）：
   - Read 入口方法代码，追踪调用链中的下游 RPC 调用
   - 判断是否同时传递了身份凭证和资源 ID 给下游
   - 若 .redtrace/code-audit/PROJECT_CONTEXT.md 有该端点的 `RPC-DOWNSTREAM:` 记录，仅作参考线索（仍须 Read 调用链代码确认身份凭证+资源ID同时传递）
   - 身份凭证 + 资源ID 同时传递 → 降级为安全，change_reason 填写"身份凭证与资源ID同时传递给下游RPC（{service名}），下游可做归属校验，符合3.3.1"
   - **真实案例**: `lottery/detail` → sellerId 与 lotteryId 一起传给 `lotteryManageClient.queryLotteryDetail` → adopted_comment: "sellerId通过@Visitor注解注入（可信来源）并透传给下游RPC。默认下游有校验"

2. **公开数据检查**（对应 false-positive-filtering.md 3.2.3）：
   - 判断接口返回的数据是否为公开可见数据
   - 用户昵称/头像、商品信息、公告等 → 降级为安全
   - 若 .redtrace/code-audit/PROJECT_CONTEXT.md 有该端点的 `PUBLIC-DATA:` 记录，仅作参考线索（仍须 Read 代码确认返回数据确为公开数据）
   - **真实案例**: `profile/user` → 返回用户昵称、头像、性别 → adopted_comment: "公开数据"

3. **ID 可枚举性检查**（对应 false-positive-filtering.md 3.2.4）：
   - BlobStore key / blobKey / Bucket name (UUID格式) / AES 加密参数 → 不可枚举
   - 不可枚举 ID + 单条查询 → 降级为 risk-b 或不报告
   - 若 .redtrace/code-audit/PROJECT_CONTEXT.md 有该 ID 类型的 `ID-TYPE:` 记录且标记为不可枚举，仅作参考线索（仍须 Read 代码确认 ID 生成方式）
   - **真实案例**: `musician/v2/file/load` → key 是 BlobStore key，服务端随机生成 → adopted_comment: "BlobStore_key不可遍历"

4. **同租户横向检查**（对应 false-positive-filtering.md 3.2.5）：
   - 判断越权是否发生在同一租户/组织/公会内部
   - 同租户内用户间横向访问 → 不报告（业务设计如此）
   - 若 .redtrace/code-audit/PROJECT_CONTEXT.md 有该资源类型的 `TENANT-BOUNDARY:` 记录，仅作参考线索（仍须 Read 代码确认租户边界）
   - **真实案例**: `settlement/income/detail/flow/detail` → authorId 可查同组织其他主播收入 → adopted_comment: "同组织内其他主播。我们不关注同租户下的水平越权"

5. **数据层隐式过滤检查**（对应 false-positive-filtering.md 3.2.6）：
   - 检查查询方法是否自动注入当前用户身份作为过滤条件
   - MyBatis-Plus: `lambdaQuery.eq(Entity::getUserId, currentUserId)` → 数据层隐式过滤 → 降级为安全
   - JPA: `repository.findByUserId(currentUserId)` → 仅查询当前用户数据 → 降级为安全
   - 检查方式：Read Repository/DAO 层代码，查看查询条件是否自动注入当前用户身份
   - **真实案例**: `todo/date/list` → 查询条件 `.eq(TodoPO::getAssigneeId, userId).or().eq(TodoPO::getCreateId, userId)` → adopted_comment: "Repository 层隐式过滤，userId 来自 @Visitor 注入（可信）"

**输出**: 命中时标记 changed=true，change_reason 注明命中的规则和代码证据

#### Step 2.2.2: 通用漏洞真实性验证（所有类别强制执行）

**触发条件**: finding 结论为 vulnerability

**核心原则**：report-review 不仅需要排除误报，还必须**以未授权用户视角自主验证漏洞的真实可验证性**。仅依赖原始报告的描述是不够的，必须独立追踪完整数据流，确认从用户输入到危险 sink 之间的每一步都真实可达。

**必做动作**（按顺序执行）：

1. **独立追踪数据流**（强制）：
   - 不依赖原始报告的 data_flow 描述，自行从入口方法开始 Read 代码
   - 逐步追踪用户可控参数从入口到 sink 的完整路径
   - 每一步都必须通过 Read 工具确认代码存在，禁止假设

2. **验证关键假设**（强制）：
   - 原始报告声称"无校验"的环节 → Read 代码确认是否真的无校验
   - 原始报告声称"用户可控"的参数 → 追溯参数来源，确认是否真的可控
   - 原始报告声称"拼接SQL"的写法 → Read 实际代码确认拼接逻辑
   - **真实案例**: `monthSettlement/record/freeze/count` → 原报告声称 `getOrDefault` 的 fallback 是"用户输入值拼接SQL"，实际 Read 代码后发现 fallback 为固定值 `"create_time"` → 注入 payload 被替换为安全默认值 → 误报

3. **验证防护措施的实际效果**（强制）：
   - 白名单/Map 映射 → 验证 default 值是否为固定安全值
   - 类型转换 → 验证转换后是否仍可能注入
   - 参数化查询 → 验证是否真正使用参数绑定而非拼接
   - RPC 下游调用 → 验证是否传递了身份凭据

4. **验证利用前提**（强制）：
   - 测试角色需要什么权限？（认证用户？管理员？内部网络？）
   - 测试角色能否获取到所需的资源标识符？（ID 可枚举？不可枚举？）
   - 测试角色能否触发危险操作？（是否有前置条件检查？）
   - 若 finding 声称\"未认证可达\"：追踪未认证请求到达 sink 的实际路径，验证是否在到达 sink 前被拦截/提前 return/抛异常（含 NPE 中断控制流）——即漏洞代码是否真的被执行，而非假设可达。若未认证即在中途中断 → 前提不成立 → 降级或标记误报

**判定**：
- 数据流完整追踪到 sink + 无有效防护 + 利用前提满足 → **确认漏洞，维持原判定**
- 数据流中断（中间有防护/不可达）→ **降级或标记误报**
- 关键假设不成立（如白名单回退为安全值）→ **降级或标记误报**
- 无法读取关键代码 → **保守维持原判定**

**输出**: 在 review 项中记录验证过程，change_reason 填写验证结论

#### Step 2.3: 防护措施验证

**必做动作**：
1. 使用 Read 读取原始报告中未提及的防护代码（鉴权、参数校验、白名单等）
2. 对照 `sanitization.md` 判断防护是否有效
3. 对照 `trusted-sources.md` 判断数据源是否可信

**来源纪律标签（强制执行）**：
每条防护措施的 `description` 必须以来源标签之一起首：
- `[Code-verified]` — 代码追踪验证的防护，confidence 不降
- `[Config-assumed]` — 框架/配置默认假设（如 Spring `@Valid`），confidence ×0.8
- `[Docs-stated]` — 来自 .redtrace/code-audit/PROJECT_CONTEXT.md 文档声明，confidence ×0.8
详见 `references/common/source-discipline.md`

**网络可达性检查**（SSRF 类别强制执行）：
若 finding 类别为 SSRF：
1. 加载 `references/common/ssrf-proxy.md`
2. 执行「网络可达性优先原则」判定流程：
   - Step 1: 检查网络可达性（是否有 HTTP 入口）
     - 无 HTTP 入口 → 判定为 risk-a（终止）
   - Step 2: 检查 URL 结构（Host 是否可控）
     - 仅 path/query 可控 → 判定为 safe（终止）
   - Step 3: 检查防护措施（隔离代理/白名单等）
     - **代理有效性判定**：仅当代理类名/方法名包含 `anti`、`ssrf` 关键字（如 `AntiSsrfProxy`、`SsrfSafeHttpClient`）时，才视为有效 SSRF 防护代理。使用通用 HTTP 客户端或名称中不含上述关键字的代理（如 `SafeProxy`、`ForwardProxy`）均视为无效防护，不应阻止升级
     - 若代理无效 → 忽略该代理防护，继续评估其余防护（如白名单）；若无其余有效防护 → 升级为 vulnerability
3. 若有用户实测反馈确认网络不通（如内网地址不可达），应将 vulnerability 降级为 risk-a

**业务层权限校验识别**（IDOR/越权类别强制执行）：
若 finding 类别为 IDOR 或越权：
1. 搜索业务层权限校验方法：`checkPermission`、`verifyPermission`、`authorize`、`checkOwnership` 等
2. 若发现 gRPC/RPC 调用权限服务（如 `xxxClient.checkDataPermission`），即使注解被注释也应视为有效防护
3. 典型案例：`AdLoginForCrmService.checkPermission(userId, adminUserId)` 通过 gRPC 调用 CRM 数据权限服务

**判定**：
- 发现原始报告遗漏的有效防护 → 降级
- 原始报告已正确评估防护 → 维持

#### Step 2.3.3: 认证前提检查（IDOR/越权类别强制执行）

**触发条件**: finding 类别为 IDOR 或 BrokenAccessControl

**必做动作**:
1. 检查接口是否有认证机制（注解、拦截器、中间件、配置）
2. 若发现无认证：
   - category 改为 BrokenAccessControl，标注为未授权子类型
   - change_reason 填写"无认证接口应定性为 BrokenAccessControl（未授权子类型），原报告分类错误"
   - 按 BrokenAccessControl 重新评定 severity（参考 severity-rating.md）

**判定**：
- 无认证 → 纠正为 BrokenAccessControl
- 有认证 → 维持原类别，继续后续检查

#### Step 2.3.5: 风险价值复核（IDOR强制执行）

**触发条件**: finding 类别为 IDOR

**severity 评级引用要求**（强制执行）：

对每个 finding 评定 `new_severity` 时，必须明确引用 severity-rating.md 中的判定表行：
- IDOR 类别 → 引用 4.1 表的具体行（如 "L4 + 单条 + 自增 + 需登录 = high"）
- 读写操作调整 → 引用 4.2 表（如 "DELETE → base +1"）
- 返回数据降级 → 引用 4.3 表
- 通用漏洞 → 引用第五节通用快速判定表的具体行
- **禁止仅凭直觉评定 severity**，每个评级必须有表格依据

**必做动作**:

1. 检查是否为"用户操作自己的资源"：
   - 资源标识符 == 身份标识符（userId/accountId等）
   - 身份标识符来源为可信（拦截器/注解注入）
   → 是 → 标记为误报，change_reason 填写"用户操作自己的资源，非越权"
   → 否 → 继续以下检查

2. 检查返回数据类型（仅读操作）：
   - 布尔值（boolean）→ 降级为 **low**
   - 统计数据（count/sum）→ 降级为 **low**
   - 已公开数据（搜索可见）→ 标记为误报
   - 部分 PII（仅昵称/头像）→ 确认是否已降级

3. 检查操作类型：
   - 删除操作 → 确认 severity 是否已 +1（最高critical）
   - 修改金额字段 → 确认是否已为 critical

4. 检查ID可预测性：
   - UUID + 单条查询 → 确认是否已降为 risk-b

5. **RPC 下游凭证检查**（强制执行）：
   - 追踪调用链中的下游 RPC 调用
   - 身份凭证 + 资源ID 同时传递给下游 → 降级为安全
   - 参照 false-positive-filtering.md 3.3.1 判定流程

6. **非标准 ID 可枚举性检查**（强制执行）：
   - 资源标识符非自增 Long/Integer 时，检查是否为 BlobStore key / bucket name / AES 加密参数
   - 这些 ID 类型不可枚举 → 单条查询降级为 risk-b 或不报告
   - 参照 false-positive-filtering.md 3.2.4 不可枚举 ID 类型表

7. **数据公开性检查**（强制执行）：
   - 确认接口返回数据是否为公开可见（搜索结果可见、无需登录可访问）
   - 仅返回用户昵称/头像 → 确认是否已按 3.2.3 降级
   - 返回数据为公开业务信息 → 降级为安全

8. **租户边界检查**（强制执行）：
   - 确认是否有 tenantId/orgId/guildId 等租户标识
   - 同一租户内用户间横向访问 → 不报告
   - 跨租户访问 → 维持或升级

**输出**: 更新 new_severity 和 change_reason

#### Step 2.4-pre: N 票独立对抗验证（高危强制执行）

**触发条件**：finding `severity ∈ {critical, high}` 或 `conclusion = vulnerability`

**核心原则**：验证者独立推导，不继承原审计推理链。通过子代理实现真·独立新会话（各子代理互不可见上下文）。

**详细规则**：见 `references/modes/report-review/adversarial-validation.md`

**🔍 准入检查（进入本步前必做）**：

1. 逐条扫描本次复核的所有 finding 的 `severity` 和 `conclusion` 字段
2. 命中 `severity ∈ {critical, high}` 或 `conclusion = vulnerability` 的 finding，收集为**「待对抗验证列表」**
3. 列表为空 → 跳过本步，记录「本次复核无高危 finding 需对抗验证」
4. **准入门禁：未完成待对抗验证列表的逐条扫描，禁止跳过本步**

**必做动作**：
1. 对每个高危 finding，启动 N=2 个子代理并行独立验证（每个子代理开全新会话）
2. 每个子代理只传入 `{category, api_path, file_path, line_number, root_cause}`（**不传 description/data_flow/recommendation**）
3. 收集 2 票裁决：TRUE_POSITIVE / FALSE_POSITIVE / CANNOT_VERIFY
4. 多数票裁决：FP ≥ ⌈N/2⌉+1 → 降级；TP ≥ ⌈N/2⌉+1 → 维持；平局默认 precision → 降级
5. 裁决写入 `change_reason` 文字：`"N 票对抗复核 k/n 判误报，规则 FP-x.y [VOTE: 2/2 TP, 0/2 FP]"`

**🔍 准出检查（离开本步前必做）**：

1. 逐个核对：「待对抗验证列表」中的每个 finding，是否都有对应的 `[VOTE: ...]` 裁决记录
2. 有 finding 缺裁决记录 → **禁止进入 Step 2.4**，补齐后重新检查
3. **准出门禁：待对抗验证列表与裁决记录一一对应，方可进入 Step 2.4**

**成本控制**：仅高危触发；低危 finding 跳过此步

#### Step 2.4: 升级/降级判定

**降级场景**（vulnerability → risk/safe）：
- 命中误判排除规则
- 存在原始报告未识别的有效防护
- 入口点实际不可通过 HTTP/gRPC 到达

**升级场景**（risk → vulnerability）：
- 原始报告低估了风险，实际存在可达入口且无有效防护

**维持场景**：
- 代码验证与原始报告一致
- 无法读取关键代码（保守维持原始判定）
- 功能开关控制安全检查（代码有校验逻辑但开关默认关闭）→ 维持原评级，但修改 root_cause 描述为"功能开关默认关闭"，如 `kconf.getBoolean("xxx.enabled", false)` 默认为 false

**严重程度调整**：
- `new_severity` 的评定依据 references/common/severity-rating.md 的三维度评级框架
- 代码验证后若影响维度发生变化（如发现实际需要管理员权限、数据非敏感），需重新计算 severity

**severity 抗通胀校准（Step 2.4 强制执行）**：
1. 复核时对 `original_severity` 给 alignment 分（-5..+5），评估原评级是否合理
2. 参考severity-rating.md 第七节判定标准：
   - alignment ≤ -3 → 强制降一级（如 critical→high）
   - alignment ≥ +3 → 允许升一级（受 conclusion 天花板封顶）
   - -2..+2 → 维持原级
3. **禁止跨两级**（即使 alignment=-5，也只降一级）
4. 评分嵌入 `change_reason` 文字：`[SEV-ALIGN: -3]`

**威胁模型匹配（与 Step 2.4-pre 对抗验证协同）**：
1. 按 `affected_locations.file_path` 匹配 .redtrace/code-audit/PROJECT_CONTEXT.md Threat Model 中 STRIDE 条目
2. 命中 ≥1 条 STRIDE 威胁 → severity 允许 +1（禁止跨两级，受 conclusion 天花板封顶）
3. 匹配结果在 `description` 追加 `[THREAT-MATCH: STRIDE-I, STRIDE-E]`
4. 详细规则见 references/common/severity-rating.md 第八节

**计算顺序**：维度一~三公式计算 → alignment 校准 → 威胁匹配 +1 → conclusion 天花板封顶

#### Step 2.5: 构建 review 项

为**发生变更的** finding 构建 review 项，记录：
- review_id（与输入中 `[id:xxx]` 的值一致，用于关联原始记录）
- api_path、http_method（与输入一致）
- original_severity（原始严重级别）
- new_severity（新严重级别，不变则与原始相同）
- changed（是否变更）
- change_reason（变更原因，仅 changed=true 时填写）
- updated_result（完整的修正后审计结果 JSON，仅 changed=true 时需要）

**结束门槛**：所有 findings 处理完成 → 进入 Step 3

### Step 3: 输出复核 JSON

**执行内容**：
- 汇总所有 review 项
- 统计 upgraded（升级数）、downgraded（降级数）、unchanged（不变数）
- 输出纯 JSON 格式

**强制要求**：输出必须是纯 JSON，不包含 Markdown 标记或解释文字

---

## 质量检查（本模式强制执行）

在输出 JSON 前，按顺序验证：

- [ ] Step 0-3 所有子步骤已执行
- [ ] 已加载误报排除规则（references/common/false-positive-filtering.md）
- [ ] 每个 finding 已使用 Read 工具读取实际代码
- [ ] IDOR/BrokenAccessControl 类别已执行认证前提检查（Step 2.3.3）
- [ ] IDOR 类别已执行风险价值复核（Step 2.3.5）
- [ ] IDOR 类别已执行专项误报排除（Step 2.2.1）
- [ ] vulnerability 结论已执行真实性验证（Step 2.2.2）
- [ ] IDOR 类别已执行风险价值复核中的 RPC 下游 / 公开数据 / 不可枚举 ID / 租户边界检查
- [ ] 已应用误判排除规则
- [ ] 所有 changed=true 的 review 包含 updated_result（含 findings + summary）
- [ ] 所有 severity 值在枚举范围内（critical/high/medium/low/info）
- [ ] new_severity 评级已按 severity-rating.md 标准重新评定
- [ ] summary 中的 upgraded + downgraded 计数 = reviews 数组长度，total_reviewed = upgraded + downgraded + unchanged
- [ ] 输出为纯 JSON 格式

**验证不通过时，禁止输出 JSON。**

---

## 输出规范（强制执行）

**输出格式**: 纯 JSON（不包含 Markdown 代码块标记 ```json ... ```）

### 字段定义

#### reviews 数组

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `review_id` | string/int | 是 | **必须等于输入中 `[id:数字]` 的值**（如 6133），用于关联原始记录。禁止填 finding 内部编号（VULN-xxx/RISK-xxx） |
| `api_path` | string | 是 | API 路径，与输入一致 |
| `http_method` | string | 是 | HTTP 方法，与输入一致 |
| `original_severity` | string | 是 | 原始严重级别（评级标准见 references/common/severity-rating.md） |
| `new_severity` | string | 是 | 新严重级别，按 severity-rating.md 重新评定（不变则与原始相同） |
| `changed` | boolean | 是 | 是否发生变更 |
| `change_reason` | string | 条件 | 变更原因（仅 changed=true 时填写） |
| `updated_result` | object | 条件 | 完整的修正后审计结果（仅 changed=true 时需要） |

> ⚠️ `review_id` 是 API 记录主键（输入 `[id:数字]` 的数字值），不是 finding 内部的漏洞编号。finding 内部的 `id`（VULN-xxx/RISK-xxx）填在 `updated_result.findings.vulnerabilities/risks` 里。

#### updated_result 结构（changed=true 时必需）

必须包含 `findings` 和 `summary` 两个顶级键，格式与 api-audit 模式输出一致：

```json
{
  "findings": {
    "vulnerabilities": [...],
    "risks": [...],
    "passed_checks": [
      {
        "type": "SSRF",
        "reason": "用户无法控制请求目标主机"
      }
    ]
  },
  "summary": {
    "functional_impact": "string",
    "vulnerabilities_count": 0,
    "risks_count": 0,
    "audit_status": "PASS|BLOCK|WARNING",
    "overall_severity": "critical|high|medium|low|info",
    "key_findings": ["string"]
  }
}
```

##### findings.vulnerabilities / findings.risks 字段

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `id` | string | 是 | VULN-XXX / RISK-A-XXX / RISK-B-XXX |
| `category` | string | 是 | 漏洞分类 |
| `conclusion` | string | 是 | vulnerability/risk-a/risk-b/safe/unknown |
| `severity` | string | 是 | critical/high/medium/low/info（评级标准见 references/common/severity-rating.md） |
| `entry_point` | string | 是 | HTTP Method + Path 或 gRPC Service |
| `root_cause` | string | 是 | <=100字符 |
| `affected_locations` | object | 是 | `[{file_path, line_number}]`，file_path 必须使用相对路径 |
| `description` | string | 是 | <=500字符 |
| `recommendation` | string | 是 | <=500字符 |
| `confidence` | number | 是 | 0-1 |
| `occurrences` | integer | 是 | >=1 |
| `data_flow` | string | 条件 | 仅 vulnerability 结论时必需 |
| `example_payload` | array | 条件 | 仅 vulnerability 结论时必需 |

##### findings.passed_checks 字段

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `type` | string | 是 | 检查的漏洞类型 |
| `reason` | string | 是 | <=500字符，判定为安全的原因。**必须以 `[FP-x.y]` 或 `[FP-NONE]` 起首**（规则编号见 references/common/false-positive-filtering.md「FP 规则索引」） |

#### summary 字段

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `total_reviewed` | integer | 是 | 复核总数 = 输入的 API 数量（每个 `[id:xxx]` 算 1 个，不是 finding 条数） |
| `upgraded` | integer | 是 | 升级数量 |
| `downgraded` | integer | 是 | 降级数量 |
| `unchanged` | integer | 是 | 不变数量 |
| `unchanged_reasons` | array[string] | 否 | 不变项原因列表，格式 `{id}: {reason}` |

### 输出示例

**有变更时**：
```json
{
  "reviews": [
    {
      "review_id": "42",
      "api_path": "/api/users/{id}",
      "http_method": "GET",
      "original_severity": "high",
      "new_severity": "medium",
      "changed": true,
      "change_reason": "原报告未识别到 @AuthCheck 注解提供的鉴权防护",
      "updated_result": {
        "findings": {
          "vulnerabilities": [],
          "risks": [
            {
              "id": "RISK-A-001",
              "category": "IDOR",
              "conclusion": "risk-a",
              "severity": "medium",
              "entry_point": "GET /api/users/{id}",
              "root_cause": "鉴权存在但权限校验不严格",
              "affected_locations": [{"file_path": "UserController.java", "line_number": 45}],
              "description": "...",
              "recommendation": "...",
              "confidence": 0.7,
              "occurrences": 1
            }
          ],
          "passed_checks": [
            {
              "type": "SSRF",
              "reason": "接口无外部URL请求"
            }
          ]
        },
        "summary": {
          "functional_impact": "用户信息查询",
          "vulnerabilities_count": 0,
          "risks_count": 1,
          "audit_status": "WARNING",
          "overall_severity": "medium",
          "key_findings": ["权限校验不严格"]
        }
      }
    }
  ],
  "summary": {
    "total_reviewed": 3,
    "upgraded": 0,
    "downgraded": 1,
    "unchanged": 2
  }
}
```

**全部无变更时**：
```json
{"reviews": [], "summary": {"total_reviewed": 3, "upgraded": 0, "downgraded": 0, "unchanged": 3, "unchanged_reasons": ["42: 代码验证确认 id 参数无所有权校验，原判定准确", "43: 全局拦截器已覆盖认证，维持原判", "44: 数据层隐式过滤已排除，维持原判"]}}
```

> 当 reviews 为空数组时，表示所有 findings 复核后均无变更。通过 `summary.unchanged` 字段确认数量。这是正常完成状态，表示复核任务已完成。

---

## 相关文档

- 误报排除规则: references/common/false-positive-filtering.md
- 净化措施判定: references/common/sanitization.md
- 可信数据源判定: references/common/trusted-sources.md
- SSRF 隔离代理: references/common/ssrf-proxy.md
- Kconf 配置系统: references/common/kconf.md
- 严重程度评级: references/common/severity-rating.md
- 语言路由: references/{lang}/{lang}-router.md
