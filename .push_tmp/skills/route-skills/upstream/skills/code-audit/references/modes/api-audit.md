# API Audit 模式 - API 端点安全审计

从指定的 API 入口点出发，分析完整调用链路的安全性。

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
- 前端 JSBridge/原生桥接 SDK 注册代码（仅定义调用接口、无用户可控参数透传）→ 直接判定 safe
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
API 安全审计
├── Step 0: 输入解析与验证 → 识别 API 入口点 + 验证一致性
├── Step 1: 语言检测与路由定位 → 加载 router 文档
├── Step 2: 入口点代码读取 → 读取 Controller/Handler 实现
├── Step 3: 调用链追踪 → 获取完整 call stack
├── Step 4: 风险类型识别 → 根据 call stack 推测漏洞类型
├── Step 5: 代码验证 → 逐一验证推测的漏洞类型
└── Step 6: 输出 JSON 报告
```

**漏洞类型优先级**:

| 优先级 | 类型 | 枚举值 | 说明 |
|--------|------|--------|------|
| 1（优先） | 基础安全漏洞 | `SQLi`, `NoSQLi`, `SSRF`, `XXE`, `RCE`, `PathTraversal`, `FileUpload`, `Deserialization`, `XSS`, `OpenRedirect`, `CORS`, `Hardcoded`, `SSTI`, `FormatString`, `WebEnableDebug`, `IntegerOverflow`, `WeakRNG`, `PrototypePollution`, `JWT`, `LDAPi`, `JDBCi`, `SwaggerMisconfig` | 风险等级明确，危害严重，技术利用路径固定 |
| 2（其次） | 业务逻辑漏洞 | `IDOR`, `BrokenAccessControl`, `BusinessLogic`, `BatchExport`, `PrivateVideo`, `CSRF`, `PromptInjection` | 需结合业务场景判断，风险等级相对模糊 |

**原因**：基础安全漏洞的危害程度与技术利用路径相对固定，属于高确定性风险；业务逻辑漏洞需更多业务上下文，属于情境依赖性风险。

---

## 执行流程

### Step 0: 输入解析与验证

识别用户提供的输入格式，并验证与实际代码的一致性：

| 输入格式 | 示例 | 解析方式 | 验证方法 |
|---------|------|---------|---------|
| REST 路由路径 | `/api/users/{id}` 或 `GET /api/users` | 根据 routing 规则定位到处理方法 | `codegraph_search(kind="route")`（codegraph 优先；仅当索引缺失或返回空时退回 grep） |
| 文件路径+方法名 | `UserService.java:getUserInfo` | 直接读取文件并定位方法 | `codegraph_node(symbol="getUserInfo", includeCode=true)`（codegraph 优先；仅当代码未被索引时退回 read） |
| gRPC Service 方法 | `UserService.GetUser` | 根据 proto 定义定位实现 | `codegraph_search(query="UserService")`（codegraph 优先；仅当索引缺失或返回空时退回 grep） |

> 工具选择总原则见 SKILL.md「工具使用规范」：codegraph MCP 优先，grep/read 仅在"已确定文件位置"或"满足降级条件"时使用。本模式属"无准确代码位置"场景。

**验证规则** (强制执行):
- HTTP 方法不匹配 → 以代码中实际注解为准（@GetMapping/@PostMapping）
- 文件路径不存在 → 判定为 unknown，输出 JSON
- 方法名不匹配 → 报告最近似的方法名
- 项目为前端项目且无法定位到后端 Controller/Handler → 判定为 unknown，summary 注明"后端代码不在当前仓库"，直接进入 Step 6

**输出格式** (验证通过时):
```
[VALIDATION] 输入验证完成 - 用户输入: GET /api/users/{id}, 实际代码: @GetMapping in UserController.java:45
```

**输出格式** (发现差异时):
```
[VALIDATION] 输入验证发现差异 - 用户输入: POST, 实际代码: @GetMapping - 使用实际 HTTP 方法
```

### Step 1: 语言检测与路由定位

- 检测项目语言
- 加载对应的 `references/{lang}/{lang}-router.md`
- 定位目标 API 的处理代码

**文档加载策略**：
- Step 1 仅加载路由文档（`references/{lang}/{lang}-router.md`）
- 误报排除规则（`false-positive-filtering.md`）在 Step 4.5 按需加载
- 漏洞类型文档（`references/{lang}/{lang}-{type}.md`）在 Step 5 按需加载
- 单接口审计时，大部分 IDOR 专项规则（Step 4.5.1/5.5）不会触发，无需提前加载

**接口相似性说明**：

当审计多个接口时，若发现新接口的代码与已审计接口**代码同构**（相同的处理逻辑、相同的调用链、相同的参数来源），可复用已审计接口的结论：
- 同 Controller 中，不同 HTTP 方法映射到同一方法体 → 复用结论
- 不同路径映射到同一 Handler 方法（如路由别名）→ 复用结论
- 不同 Controller 的方法体完全相同（复制粘贴代码）→ 复用结论，但在 description 中标注原始接口

**代码同构判定清单**（须全部满足方可复用结论）：
1. 相同 Handler 方法体（或调用同一 internal 方法且参数透传、无额外逻辑）
2. 相同 Service/DAO 调用链结构（下沉到同一 sink 点）
3. 相同参数来源（同为用户可控 / 同为可信注入）
4. 相同业务权限校验（认证状态、所有权校验逻辑一致）

**不可直接复用 severity 的情况**（即使代码同构，须重新评估 severity）：
- 路径语义差异（读 vs 写、公开 vs 私有、批量 vs 单条）
- 返回数据敏感度不同
- 前置条件不同（需登录 vs 需管理员）

**禁止**：仅因路径相似就复用结论，必须验证代码实现一致。

**复用结果格式**：复用时需输出完整的 finding 结构（与正常审计一致），并在 description 末尾追加 `(reused from <原始 api_path>)` 标注来源，便于复核时溯源。

### Step 2: 入口点代码定位

**触发条件**: Step 1 已识别目标 API 的处理方法

**必做动作**:
1. 使用 `codegraph_explore` 定位入口方法并获取完整源码（一次性拿全相关符号，避免后续多次 read）
2. 若 explore 返回的代码被截断，用 `codegraph_node(symbol, includeCode=true)` 展开单个方法
   - 仅当该方法未被 codegraph 索引（返回空）时，才退回 `read`
3. 识别用户输入参数及其来源

**结束门槛**:
- 成功定位入口方法 → 进入 Step 3
- 无法定位 → 判定为 unknown，输出 JSON

**禁止**:
- 假设方法签名（必须使用 `codegraph_node(includeCode=true)` 读取实际代码；仅当符号未被索引时退回 read）
- 跳过参数来源识别

### Step 3: 调用链追踪

**触发条件**: Step 2 已读取入口点代码

**必做动作**:
1. 使用 `codegraph_callees` 追踪方法调用链（一次拿全所有下游调用，禁止逐个 grep+read 手工拼接；仅当该方法未被 codegraph 索引时退回 grep + read）
2. **codegraph 降级时的具体搜索模式**（满足 SKILL.md「降级条件」时）：
   - `codegraph_callees` 返回空或聚合噪音 → `grep -rn "methodName(" --include="*.java"` 定位调用点，再 read 源码
   - 通用方法名（create/delete/edit/list/get）会聚合多个类的同名方法 → 配合类名限定搜索，如 `grep -rn "userService.create("`
   - 重载方法需结合参数签名区分 → grep 后按上下文 read 确认具体重载版本
3. 记录每层调用的文件位置和行号
4. 识别调用链中的危险 API（sink 点）
5. 分析 API 功能特征：
   - 路径语义（增删改查、文件操作、外部交互等）
   - 参数名语义（字段名、文件名、URL、路径等）
   - 参数类型（文件、字符串、数字等）
   - 根据功能语义推断潜在风险类型

**功能-风险推断原则**:

| 功能语义 | 风险推断方向 |
|---------|-------------|
| 数据查询/搜索/列表 | 输入可能参与查询构建 → SQL注入/NoSQL注入 |
| 文件读写/上传下载 | 输入可能参与路径构建 → 路径遍历/恶意文件 |
| 外部请求/代理/回调 | 输入可能控制请求目标 → SSRF |
| 重定向/跳转 | 输入可能控制跳转目标 → 开放重定向 |
| 命令/脚本执行 | 输入可能参与命令构建 → RCE |
| 数据输出/渲染 | 输入可能直接输出 → XSS |

**注意**: 上表为参考，应根据实际功能语义自主推断，不限于表中列举的对应关系。

**结束门槛**:
- 发现 sink 点或推断风险 → 进入 Step 4
- 无 sink 点且无推断风险 → 判定为 safe，进入 Step 6
- 方法实现位于外部依赖（JAR/源码不在仓库中）→ 记录为 unknown，description 说明"实现位于外部依赖，无法读取源码"，confidence 设为 0.3，进入 Step 6

**无参数接口处理**：若入口方法无显式参数（如 `cure()`），仍须判断数据来源：
- 全部为服务端控制（DB 查询结果、Redis 锁、拦截器注入、系统时间）→ 直接判定 safe，进入 Step 6
- 含外部可控输入（配置文件可被外部修改、请求头/cookie 经隐式参数绑定）→ 继续按 Step 4 研判

### Step 4: 风险类型识别

**触发条件**: Step 3 发现 sink 点或推断风险

**必做动作**:
1. 加载 `references/{lang}/{lang}-router.md`
2. 查看 "模式关键词到漏洞类型映射" 章节
3. 根据 sink API 类型匹配漏洞类型
4. 若来自功能推断，记录推断来源

**结束门槛**:
- 成功匹配漏洞类型 → 进入 Step 4.5
- 无法匹配 → 记录为 unknown 类型，继续

### Step 4.5: 误报过滤检查

**触发条件**: Step 4 已识别风险类型

**必做动作**:
1. 加载 references/common/false-positive-filtering.md
2. **优先检查第一节（代码质量问题）和第二节（合规/业务问题）**：若发现属于代码质量（如仅输入校验缺失、空值未处理）或合规问题，直接命中排除规则，不继续后续类型特定检查
3. 逐项检查第三节安全场景排除规则是否命中
4. **若 .redtrace/code-audit/PROJECT_CONTEXT.md 存在**：读取 .redtrace/code-audit/PROJECT_CONTEXT.md 中 `RPC-DOWNSTREAM:`、`ID-TYPE:`、`PUBLIC-DATA:`、`TENANT-BOUNDARY:` 标记的条目（**仅作参考线索，消费纪律见 SKILL.md「.redtrace/code-audit/PROJECT_CONTEXT.md 消费纪律」，不得据此直接判定**）
5. **IDOR/BrokenAccessControl 类别强制执行 RPC 下游凭证检查**（见下方子步骤 4.5.1）
6. **IDOR 类别强制执行数据层隐式过滤检查**（对应 false-positive-filtering.md 3.2.6）：检查 Repository/DAO 查询是否自动注入当前用户身份（如 `lambdaQuery.eq(Entity::getUserId, userId)`），userId 来自拦截器/注解则可信 → 不报告
7. **BrokenAccessControl 类别强制执行全局拦截器检查**（对应 false-positive-filtering.md 3.2.7）：当接口缺少 `@LoginRequired`（Java）或 `@UseGuards(AuthGuard)`（NestJS）或无认证中间件（Express/Koa）时，先**查阅 .redtrace/code-audit/PROJECT_CONTEXT.md Architecture 认证体系章节作为参考线索**（`[Docs-stated]`，confidence ×0.8），再**搜索/Read 代码确认**拦截器的实际注册方式与路径覆盖，判断是否存在全局认证覆盖：
   - Java：搜索 `WebMvcConfigurer`/`SpringSecurity`，确认 `addPathPatterns`/`excludePathPatterns`/`needLoginPathList`（路径白名单型：目标 api_path 命中前缀则有认证）
   - NestJS：搜索 `MiddlewareConsumer`/`APP_GUARD`/`useGlobalGuards`，确认 `forRoutes()`/`exclude()`
   - Express/Koa：搜索 `app.use(authMiddleware)` 确认全局中间件注册
   - **注意**：.redtrace/code-audit/PROJECT_CONTEXT.md 记录的认证信息仅作参考，必须以代码确认为准
8. **认证入口接口排除**（IDOR/BrokenAccessControl 适用）：登录、注册、密码重置、验证码发送等接口，无登录态要求属于正常设计
   - 路径含 `/login`、`/signin`、`/register`、`/signup`、`/password/reset`、`/forgot`、`/captcha`、`/sms`、`/verify-code` → IDOR/BrokenAccessControl 类型从报告中移除
   - 上述接口若存在其他漏洞类型（如 SQL 注入、SMS 炸弹），仍按对应类型报告
9. **XSS 类别强制执行 Content-Type 检查**（参考 `references/{lang}/{lang}-xss.md` 黄金法则）：
   - **首先**检查响应的 `Content-Type`：`application/json`（Jackson/Gson 序列化）→ 无 HTML 输出 → **安全**（终止）
   - `text/html` → 继续 XSS 分析
   - **禁止**对 `@RestController` 返回 JSON 的接口报告 XSS（JSON API 本身不触发脚本执行）
   - **真实误报模式**：JSON API 返回包含 URL 的对象被误报为 XSS，实际 JSON 序列化不产生 HTML 上下文

**结束门槛**:
- 命中排除规则 → 从 risks/vulnerabilities 移除，添加到 passed_checks（注明排除规则编号），处理下一个风险
- **同一 finding 禁止同时出现在 risks/vulnerabilities 和 passed_checks 中**
- 未命中排除规则 → 进入 Step 4.6

#### Step 4.5.1: IDOR RPC 下游凭证检查（强制门禁）

**触发条件**: 风险类型为 IDOR

**必做动作**:
1. 在调用链中搜索下游 RPC 调用（`XxxClient.call()`、`@KrpcReference` 调用）
2. 检查是否**同时**传递了以下两类参数给下游：
   - 身份凭证：`userId`/`sellerId`/`accountId`/`visitor` 等
   - 资源标识符：被控的 `orderId`/`lotteryId`/`sessionId` 等
3. 若 .redtrace/code-audit/PROJECT_CONTEXT.md 有该端点的 `RPC-DOWNSTREAM:` 记录，作为参考线索（仍须 Read 调用链代码确认身份凭证+资源ID同时传递；仅凭标记不得直接判定）

**判定流程**：
```
IDOR 风险已识别
    │
    ├─ 调用链中是否有下游 RPC 调用？
    │   ├─ 否 → 继续正常 IDOR 流程
    │   └─ 是 → 检查传递给下游的参数
    │       ├─ 身份凭证 + 资源ID 同时传递 → 命中 3.3.1 → 不报告（下游可做归属校验）
    │       ├─ 仅资源ID 传递，无身份凭证 → 继续正常 IDOR 流程（下游无法校验）
    │       └─ 当前层已做归属校验 → 不报告（命中 3.3.1 第二条）
    │
    └─ 无下游调用 → 继续正常 IDOR 流程
```

**典型模式示例（来自真实误报案例）**：
```java
// 模式1: sellerId + lotteryId 一起传给下游 → 不报告
// 真实案例: POST /rest/pc/marketing/tools/lottery/detail (LotteryController.java:283-290)
lotteryManageClient.queryLotteryDetail(LotteryRequest.newBuilder()
    .setSellerId(sellerId)      // 身份凭证，@Visitor 注入
    .setLotteryId(lotteryId)    // 资源ID，@JsonParam 用户可控
    .build());
// adopted_comment: "sellerId通过@Visitor注解注入（可信来源）并透传给下游RPC。默认下游有校验"

// 模式2: visitor + sessionId 一起传给下游 → 不报告
// 真实案例: GET /rest/kd/music/business/authorization/getAuthLetterFile (MusicBusinessAuthLetterController.java:172)
musicBusinessDocBuilderRpcClient.getAuthLetterFile(sessionId, visitor);
// adopted_comment: "把visitor, sessionId一起传递给RPC则默认RPC会做权限校验"

// 模式3: 仅资源ID传给下游 → 需继续研判（危险！）
downstreamReq.setResourceId(userInputId); // 未传 userId，下游无法校验归属
```

**输出**：命中时在 passed_checks 中记录：
```json
{"type": "IDOR", "reason": "身份凭证(sellerId)与资源ID(lotteryId)同时传递给下游RPC(lotteryManageClient)，下游可做归属校验，符合 false-positive-filtering.md 3.3.1"}
```

**质量门禁**: IDOR 类别**禁止**跳过此检查，否则禁止进入 Step 4.6

### Step 4.6: 漏洞类型互斥检查（强制）

**触发条件**: Step 4.5 确认的风险列表

**必做动作**: 按优先级保留唯一类型

**互斥判定规则**（按优先级从高到低）:

| 优先级 | 条件 | 保留类型 | 移除类型 | 说明 |
|--------|------|---------|---------|------|
| 1a | 完全无认证（无注解 + 无全局拦截器覆盖） | **BrokenAccessControl** | IDOR | 认证缺失是首要问题，越权判断无意义 |
| 1b | 有认证 + 无资源所有权校验 + 访问他人资源 | **IDOR** | BrokenAccessControl | 越权访问他人资源 |
| 1c | 有认证 + 无角色/权限注解 + 管理功能 | **BrokenAccessControl** | - | 权限校验机制缺陷 |
| 2 | 业务流程漏洞（状态绕过、并发竞态） | **BusinessLogic** | IDOR | 业务逻辑问题优先 |

**实施流程**:
```
风险列表
    │
    ├─ 检查认证状态（参考 false-positive-filtering.md 3.2.7）
    │   ├─ 完全无认证（无注解 + 无全局拦截器覆盖）？
    │   │   ├─ 是 → 仅保留 BrokenAccessControl，移除 IDOR → 结束
    │   │   └─ 否 → 继续
    │
    ├─ 检查资源所有权校验
    │   ├─ 有认证 + 无所有权校验 + 资源ID != 身份ID（访问他人资源）？
    │   │   ├─ 是 → 仅保留 IDOR，移除 BrokenAccessControl → 继续
    │   │   └─ 否 → 继续
    │
    ├─ 检查角色/权限校验
    │   ├─ 有认证 + 无角色/权限注解 + 管理功能？
    │   │   ├─ 是 → 保留 BrokenAccessControl → 继续
    │   │   └─ 否 → 继续
    │
    └─ 发现业务流程漏洞（状态绕过/并发竞态）？
        ├─ 是 → 仅保留 BusinessLogic，移除 IDOR → 结束
        └─ 否 → 保留原类型
```

**输出要求**:
- 每个 finding 仅保留一个主类型
- 在 description 中记录类型调整原因

**结束门槛**: 完成类型互斥检查 → 进入 Step 4.7

> **SwaggerMisconfig 独立判定**：SwaggerMisconfig 与上述 IDOR/BAC/BusinessLogic 类型不互斥。Swagger 文档框架的配置问题（如 UI 暴露）与业务端点的权限问题是不同维度，可同时报告为独立 finding。

### Step 4.7: 配置来源判定

**触发条件**: 风险涉及配置项

**必做动作**:
1. 加载 `references/common/kconf.md`
2. 追踪配置来源

**SSRF 配置溯源**（强制执行）:
若风险类型为 SSRF，且发现使用代理，必须执行配置溯源：
1. 加载 `references/common/ssrf-proxy.md`
2. 查看「快速检查清单」章节
3. 追踪代理配置来源：
   - 变量名/值含 `anti`/`ssrf` → 直接判定为隔离代理
   - 变量名/值不含 → 搜索工具类实现 → 确认配置来源是否为 `antiSsrfProxiesList`

**结束门槛**:
- KConf/Apollo 等云端配置 → 可信数据源，判定为 safe
- 硬编码/用户输入 → 保持风险判定，进入 Step 5

### Step 5: 代码验证

**触发条件**: Step 4.7 确认的风险列表

**必做动作**:

**针对所有风险类型（显式 sink 或功能推断）**:
1. 加载 `references/{lang}/{lang}-{type}.md` 对应漏洞文档
2. 按文档指引验证数据流和防护措施

**若对应漏洞文档不存在**:
- 根据漏洞类型自行设计验证策略
- 搜索输入到危险操作的完整数据流
- 检查是否有参数化查询、白名单、类型约束等防护

**常见验证搜索模式**:

| 风险类型 | 搜索关键词 |
|---------|-----------| 
| SQL注入 | orderBy/apply/反射调用、动态SQL构建 |
| 路径遍历 | getOriginalFilename、路径拼接、File 构造 |
| SSRF | HttpClient/RestTemplate/URL构造、Host校验 |
| 开放重定向 | sendRedirect/setHeader("Location"、URL白名单 |
| RCE | Runtime.exec/ProcessBuilder/反射调用 |
| XSS | getWriter/print、响应拼接、模板渲染 |

**验证结果判定**:
- 找到风险代码 → 按漏洞规则判定 vulnerability/risk-a/risk-b
- 未找到风险代码 → 在 passed_checks 记录排除原因
- 所有问题处理完 → 进入 Step 5.5

**来源纪律标签（passed_checks 强制执行）**：
`passed_checks[*].reason` 中的防护措施描述必须以来源标签之一起首：
- `[Code-verified]` — 代码追踪验证的防护，confidence 不降
- `[Config-assumed]` — 框架/配置默认假设，confidence ×0.8
- `[Docs-stated]` — 来自文档声明，confidence ×0.8
详见 `references/common/source-discipline.md`

### Step 5.5: 风险价值评估（IDOR强制执行）

**触发条件**: Step 5 判定为漏洞或风险-B，且类别为 IDOR

**必做动作**:

#### 5.5.1 资源归属判断
1. 判断资源标识符与身份标识符的关系：
   - 资源ID == 身份ID → 用户操作自己的资源 → **安全（结束审计）**
   - 资源ID != 身份ID → 用户操作他人资源 → 继续

2. 身份ID来源验证：
   - gRPC: `request.getUserId()` → 可信（网关注入）
   - Spring MVC: `@EspAccount/@Visitor` 注入 → 可信（拦截器注入）
   - `request.getAttribute("userId")` → 可信（拦截器注入）

#### 5.5.2 返回数据类型评估（仅读操作，GET请求）
| 返回类型 | severity |
|---------|----------|
| 布尔值（boolean） | 固定 **low** |
| 统计数据（count/sum） | 固定 **low** |
| 已公开数据（搜索可见） | **安全**（不报告） |
| 部分 PII（仅昵称/头像） | 原等级 **-1** |
| 完整 PII | 维持原等级 |

#### 5.5.3 读写操作调整
| 操作类型 | severity调整 |
|---------|-------------|
| 删除（DELETE） | 基础等级 **+1**（最高critical）|
| 修改金额/权限字段 | 升级为 **critical** |
| 批量操作 | 基础等级 **+1** |

#### 5.5.4 ID可预测性最终检查（强制执行）

**必做动作**: 识别资源标识符类型，按不可预测性规则调整。

**不可预测ID类型表**（命中任一 + 单条查询 → 强制 risk-b 或不报告）：

| ID 类型 | 识别信号 | 不可预测原因 |
|---------|---------|-------------|
| UUID v4 | `@GeneratedValue(strategy = UUID)` / 32位hex字符串 | 随机性高，无法遍历 |
| BlobStore key / blobKey | `bs3Client`/`BS3Client` 相关操作，key 为上传时服务端生成 | 服务端随机生成，无法枚举 |
| Bucket name (UUID格式) | `bucketName` + UUID 命名规则 | UUID 格式不可暴力遍历 |
| AES 加密参数 | 参数经过 `Cipher`/`AES`/`encrypt`/`@EncryptedRequestParam` 处理 | 密文不可逆推原始值 |
| Hash ID (>=32位) | `Hashids`/`SHA`/`MD5` 编码 | 单向哈希不可逆推 |

**判定规则**：
- 不可预测ID + 单条查询 → **强制降为 risk-b 或不报告**
- 不可预测ID + 批量接口 → **维持原等级**（批量接口可绕过单条限制）
- 可预测ID（自增/短序号） → **维持原等级**

**真实误报案例**：
```
# 案例: GET /rest/kd/music/musician/v2/file/download
# api-audit 报了 IDOR(high): "认证用户可构造任意BlobStore key越权下载他人文件"
# 实际情况: key 参数经 @EncryptedRequestParam(AES) 解密，原始 BlobStore key 不可遍历
# 正确判定: ID 不可预测 → 不报告

# 案例: GET /rest/kd/music/download/export/any
# api-audit 报了 IDOR(high): "认证用户可越权下载BlobStore中任意文件"
# 实际情况: bucket 名和 blobKey 都是 UUID 格式/随机字符串，不可枚举
# 正确判定: ID 不可预测 → 不报告
```

**SQL 注入 getOrDefault 白名单检查**（强制执行）：
当发现 `getOrDefault(key, defaultValue)` 模式时，必须区分：
- `defaultValue` 为固定安全字符串 → 安全（白名单回退）
- `defaultValue` 包含用户输入 → 需继续研判

```java
// 安全：回退值为固定字符串
String column = SORT_MAP.getOrDefault(userInput, "create_time");  // "create_time" 是固定安全值

// 不安全：回退值包含用户输入
String column = SORT_MAP.getOrDefault(userInput, userInput);  // 回退值也是用户输入
```

**真实误报案例**：
```
# 案例: POST /rest/live/settlement/monthSettlement/record/freeze/count
# 代码: SORT_KEY_MAP.getOrDefault(request.getSortKey(), "create_time")
# api-audit 误判: "fallback为用户输入值拼接SQL"
# 实际: fallback 值 "create_time" 是固定安全字符串
# 用户输入 "IF(1=1,SLEEP(5),0)" → Map 查找失败 → 返回 "create_time" → 安全
```

**结束门槛**: 完成以上所有评估后，输出最终 severity，进入 Step 6

### Step 6: 输出 JSON 报告

**执行内容**:
- 汇总审计发现的所有漏洞和风险
- **必须**按照"输出规范"章节输出纯 JSON 格式报告

**强制要求**: 输出必须是纯 JSON，不包含任何解释文字

---

## 质量检查（本模式强制执行）

在输出 JSON 前，按顺序验证：

- [ ] Step 0-6 所有子步骤已执行
- [ ] 已执行输入验证（Step 0）
- [ ] 输入差异已记录并在分析中使用实际值
- [ ] 已加载所有"相关文档"引用的规则文件
- [ ] 已执行漏洞类型互斥检查（Step 4.6）
- [ ] IDOR 类别已执行风险价值评估（Step 5.5）
- [ ] IDOR 类别已执行 RPC 下游凭证检查（Step 4.5.1）
- [ ] IDOR 类别已检查非标准 ID 可枚举性（Step 5.5.4）
- [ ] 已应用误报排除规则（references/common/false-positive-filtering.md）
- [ ] 已按 severity-rating.md 标准评定 severity 字段
- [ ] 结论值在核心概念表格的枚举范围内（vulnerability/risk-a/risk-b/safe/unknown）
- [ ] 所有 findings 的 entry_point 与 Step 0 验证后的目标 API 一致
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
| `file_path` | string | 是 | **相对路径**（相对于项目根目录，如 `src/main/java/com/example/UserController.java`），禁止使用绝对路径 |
| `line_number` | integer | 是 | 行号 |

#### findings.passed_checks

| 字段 | 类型 | 必需 | 格式 | 说明 |
|------|------|------|------|------|
| `type` | string | 是 | SQLi / NoSQLi / RCE / SSRF / XSS / PathTraversal / FileUpload / XXE / Deserialization / OpenRedirect / CORS / Hardcoded / IDOR / PrivateVideo / SSTI / FormatString / WebEnableDebug / IntegerOverflow / WeakRNG / PrototypePollution / JWT / BrokenAccessControl / CSRF / PromptInjection / BusinessLogic / BatchExport / SwaggerMisconfig（见 references/common/category-enum.md）| 检查的漏洞类型 |
| `reason` | string | 是 | <=500字符 | 判定为安全的原因说明。**必须以 `[FP-x.y]` 或 `[FP-NONE]` 起首**（规则编号见 references/common/false-positive-filtering.md「FP 规则索引」） |

#### summary 字段

| 字段 | 类型 | 必需 | 枚举值 | 说明 |
|------|------|------|--------|------|
| `functional_impact` | string | 是 | - | 功能影响描述 |
| `vulnerabilities_count` | integer | 是 | >=0 | 漏洞总数 |
| `risks_count` | integer | 是 | >=0 | 风险总数 |
| `audit_status` | string | 是 | PASS/BLOCK/WARNING | 审计结论 |
| `overall_severity` | string | 是 | critical/high/medium/low/info | 最高严重级别 |
| `key_findings` | array[string] | 是 | - | 关键发现 |

### 输出示例

```json
{
  "findings": {
    "vulnerabilities": [
      {
        "id": "VULN-001",
        "category": "SQLi",
        "conclusion": "vulnerability",
        "severity": "critical",
        "entry_point": "GET /api/v1/users/:id/profile",
        "root_cause": "orderBy参数直接拼接到SQL语句，无参数化处理",
        "affected_locations": [
          {
            "file_path": "user-api/src/main/java/com/example/user/controller/UserProfileController.java",
            "line_number": 45
          },
          {
            "file_path": "user-api/src/main/java/com/example/user/service/UserService.java",
            "line_number": 78
          }
        ],
        "description": "getUserProfile接口的orderBy参数未经校验直接拼接到ORDER BY子句。未授权用户可注入恶意SQL实现盲注窃取数据库数据。验证难度低，仅需有效账号即可实施。",
        "recommendation": "使用ORM的orderByAsc/orderByDesc方法，或对orderBy参数进行白名单校验",
        "confidence": 0.95,
        "occurrences": 1,
        "data_flow": "Request[orderBy] → getUserProfile(id, orderBy):45 → userService.getProfile(id, orderBy):46 → queryWrapper.orderByAsc(orderBy):78 → DB SELECT",
        "example_payload": [
          "GET /api/v1/users/123/profile?orderBy=name;SELECT+SLEEP(5)--",
          "GET /api/v1/users/123/profile?orderBy=IF((SELECT+password+FROM+users+WHERE+id=1)LIKE'a%',SLEEP(5),0)"
        ]
      }
    ],
    "risks": [
      {
        "id": "RISK-B-001",
        "category": "IDOR",
        "conclusion": "risk-b",
        "severity": "low",
        "entry_point": "GET /api/v1/users/:id/profile",
        "root_cause": "id参数无所有权校验，但返回数据已脱敏",
        "affected_locations": [
          {
            "file_path": "user-api/src/main/java/com/example/user/controller/UserProfileController.java",
            "line_number": 45
          }
        ],
        "description": "getUserProfile接口的id路径参数无所有权校验，认证用户可查询任意用户资料。但返回数据已在service层脱敏（隐藏手机号中间4位、隐藏邮箱），仅返回昵称、头像、脱敏联系方式。验证难度低，但数据敏感度低。",
        "recommendation": "从认证上下文获取当前用户ID，或添加资源所有权校验",
        "confidence": 0.85,
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
      }
    ]
  },
  "summary": {
    "functional_impact": "用户资料查询接口存在SQL注入漏洞，可窃取数据库数据；同时存在IDOR但数据已脱敏",
    "vulnerabilities_count": 1,
    "risks_count": 1,
    "audit_status": "BLOCK",
    "overall_severity": "critical",
    "key_findings": [
      "orderBy参数存在SQL注入，验证难度低，severity critical",
      "id参数存在IDOR，但返回数据已脱敏，数据敏感度低，已降级为risk-b"
    ]
  }
}
```

---

## 模式专属资源

无独立子文档。调用链追踪与输入验证方法论由 agent 自主执行，工具纪律见 SKILL.md「工具使用规范」。

## 相关文档

- 语言路由: references/{lang}/{lang}-router.md
- 通用规则: references/common/*.md（净化措施、可信数据源、SSRF代理等）
- 严重程度评级: references/common/severity-rating.md
