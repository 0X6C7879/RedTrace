# 架构预分析（arch-scan）

在 API 安全审计之前，预先识别项目的安全相关架构，减少后续每个 API 审计时的重复识别工作。

---

## 目标

将以下信息写入 .redtrace/code-audit/PROJECT_CONTEXT.md 的对应章节，供后续 API 审计参考：

| 识别内容 | 写入 .redtrace/code-audit/PROJECT_CONTEXT.md 章节 |
|----------|-------------------|
| 语言/框架/项目类型 | Project Overview |
| 认证体系 | Architecture |
| 授权模型 | Architecture |
| 数据层 | Architecture |
| 安全中间件 | Common Components |
| 业务模块 | Modules |
| 危险模式 | Dangerous Patterns |
| 其他安全发现 | Other Findings |
| 误报预防上下文 | Other Findings (以特定前缀标记) |
| 威胁模型 | Threat Model（对应子章节） |

---

## 执行流程

```
语言检测 → [前端项目检测] → 认证体系识别 → 授权模型识别 → 数据层识别 → 安全中间件识别 → 误报预防上下文记录 → 轻量级威胁建模 → 写入 .redtrace/code-audit/PROJECT_CONTEXT.md
                              ↓ (纯前端项目)
                          前端安全模式识别 → 写入 .redtrace/code-audit/PROJECT_CONTEXT.md
```

---

## Step 1: 语言与框架检测

**必做动作**：

1. 检测项目语言（Java/Kotlin/Go/Python/JavaScript）
2. 检测 Web 框架

| 语言 | 框架检测 | 搜索方式 |
|------|---------|---------|
| Java/Kotlin | Spring Boot | `pom.xml` 中 `spring-boot-starter` |
| Java/Kotlin | Spring MVC | `@RestController` / `@Controller` |
| Go | Gin / Echo / Chi / 标准库 | `go.mod` 中对应依赖 |
| Python | Flask / Django / FastAPI | `requirements.txt` 或 import |
| JavaScript | Express / NestJS / Koa | `package.json` 中对应依赖 |

**结束门槛**：语言和框架已识别 → 进入 Step 1.5

---

## Step 1.5: 前端项目检测

**触发条件**：Step 1 已完成框架检测

**必做动作**：

1. 检查项目是否为纯前端项目（无后端 API 端点）

**前端项目判断依据**（满足以下全部条件）：
- `package.json` 存在
- `package.json` 的 `dependencies`/`devDependencies` 中 **不包含** 后端框架：`express`、`nestjs`、`@nestjs/core`、`koa`、`hono`、`fastify`、`hapi`
- `package.json` 包含前端框架：`react`、`vue`、`@vue/cli-service`、`next`、`nuxt`、`@angular/core`、`vite`、`webpack`
- 项目中不存在 `src/main/java`、`go.mod`、`app.py`、`manage.py` 等后端语言标志

**结束门槛**：
- 判定为纯前端项目 → 跳过 Step 2-5，进入 **Step 1.5-FE: 前端安全模式识别**
- 判定为后端或全栈项目 → 正常进入 Step 2

---

## Step 1.5-FE: 前端安全模式识别

**触发条件**：Step 1.5 判定为纯前端项目

**必做动作**：识别前端特有的安全相关模式

| 检查项 | 搜索模式 |
|--------|---------|
| Token 存储方式 | `localStorage.setItem` / `sessionStorage.setItem` / `cookie.set` / `Cookies.set` |
| DOM XSS 风险 | `dangerouslySetInnerHTML` / `v-html` / `innerHTML` / `outerHTML` / `document.write` |
| API 代理配置 | `proxy` in `package.json` / `vite.config.*` 的 `proxy` / `setupProxy.js` / `http-proxy-middleware` |
| CORS 配置 | `cors` / `Access-Control-Allow` / `withCredentials` |
| 硬编码敏感信息 | `apiKey` / `api_key` / `secret` / `token` / `password` in 源码（非 .env） |
| 环境变量暴露 | `.env.production` / `.env.local` 中含敏感值 / `NEXT_PUBLIC_` 前缀变量 |
| CSP 配置 | `Content-Security-Policy` / `helmet` / `meta http-equiv` |

**输出格式**（写入 Architecture 和 Other Findings）：

| 组件 | 类型 | 位置 | 安全说明 |
|------|------|------|---------|
| {Token存储方式} | 认证体系 | {文件}:{行号} | 存储位置: {localStorage/cookie}, HttpOnly: {是/否} |
| {API代理配置} | 网络配置 | {文件}:{行号} | 代理目标: {后端地址} |
| {硬编码密钥} | 危险模式 | {文件}:{行号} | 类型: {API Key/Secret}, 风险: 暴露在客户端代码 |

**跳过说明**：纯前端项目的认证/授权/数据层/安全中间件由后端服务控制，前端只是展示和 API 调用层，因此跳过 Step 2-5 的后端搜索。

**结束门槛**：前端安全模式已识别 → 直接进入 Step 6 写入 .redtrace/code-audit/PROJECT_CONTEXT.md

---

## Step 2: 认证体系识别

**必做动作**：搜索项目中的认证实现，确定认证方式。

### Java/Kotlin (Spring)

| 认证方式 | 搜索模式 |
|---------|---------|
| Spring Security FilterChain | `extends WebSecurityConfigurerAdapter` / `SecurityFilterChain` / `@EnableWebSecurity` |
| 自定义 Interceptor | `implements HandlerInterceptor` / `extends HandlerInterceptorAdapter` |
| 网关鉴权 | `GatewayFilter` / `GlobalFilter` |
| Filter | `implements Filter` / `extends OncePerRequestFilter` |
| Session 认证 | `HttpSession` / `@SessionAttribute` |
| JWT | `JwtFilter` / `JwtUtil` / `JwtToken` / `Authorization` header |
| OAuth2 | `@EnableOAuth2Client` / `OAuth2Authentication` |
| 快手 KESS-RPC 认证 | `@KrpcService` / `extends.*ImplBase(V2)?` / `@KrpcReference` / `com.kuaishou.krpc` |

> **KESS-RPC 说明**：快手内部 gRPC 框架（KESS-RPC），认证凭据由 gRPC Metadata 拦截器注入（userId/sellerId 等），当前仓库通常不含拦截器代码。识别到 `@KrpcService` 时标注为"身份凭据由上游网关注入"。详细框架特性见 `references/common/grpc.md`。

### Go

| 认证方式 | 搜索模式 |
|---------|---------|
| 中间件认证 | `func.*Middleware` / `func.*Auth` |
| JWT | `jwt` / `token.*Validate` / `ParseWithClaims` |
| Session | `session` / `gorilla/sessions` |

### Python

| 认证方式 | 搜索模式 |
|---------|---------|
| Flask-Login | `@login_required` / `LoginManager` |
| Django Auth | `@login_required` / `AuthenticationMiddleware` |
| FastAPI Depends | `Depends.*auth` / `OAuth2PasswordBearer` |
| JWT | `jwt` / `PyJWT` / `encode` / `decode` |

### JavaScript

| 认证方式 | 搜索模式 |
|---------|---------|
| Express 中间件 | `app.use.*auth` / `passport` |
| NestJS Guard | `@UseGuards` / `AuthGuard` / `CanActivate` |
| JWT | `jsonwebtoken` / `jwt.verify` / `jwt.sign` |

**输出格式**（写入 Architecture，表格形式）：

| 组件 | 类型 | 位置 | 安全说明 |
|------|------|------|---------|
| {认证方式名称} | 认证体系 | {实现类}:{行号} | Token: {JWT/Session/Cookie}, 入口: {URL/Filter}, 未认证: {401/JSON} |
| {全局拦截器名称} | 认证体系 | {实现类}:{行号} | 覆盖路径: {addPathPatterns}, 排除: {excludePathPatterns} |

---

## Step 3: 授权模型识别

**必做动作**：搜索项目中的授权实现。

### Java/Kotlin (Spring)

| 授权方式 | 搜索模式 |
|---------|---------|
| 注解鉴权 | `@PreAuthorize` / `@Secured` / `@RolesAllowed` |
| SpEL 表达式 | `@PreAuthorize("hasRole` / `hasAuthority` |
| 自定义注解 | `@RequiresPermission` / `@RequiresRole` |
| 硬编码检查 | `if (user.getRole` / `if (!user.isAdmin` |
| URL 权限配置 | `antMatchers` / `requestMatchers` / `authorizeRequests` |

### Go

| 授权方式 | 搜索模式 |
|---------|---------|
| RBAC | `HasRole` / `CheckPermission` / `rbac` |
| 硬编码检查 | `if user.Role !=` / `if !admin` |
| 中间件鉴权 | `func.*Authorize` / `func.*Permission` |

### Python

| 授权方式 | 搜索模式 |
|---------|---------|
| 装饰器鉴权 | `@permission_required` / `@role_required` |
| DRF Permission | `IsAuthenticated` / `IsAdminUser` / BasePermission |
| FastAPI Depends | `Depends.*role` / `Depends.*permission` |

### JavaScript

| 授权方式 | 搜索模式 |
|---------|---------|
| NestJS Guard | `RolesGuard` / `PermissionsGuard` |
| Express 中间件 | `requireRole` / `checkPermission` |
| 硬编码检查 | `if (req.user.role` / `if (!user.admin` |

**输出格式**（写入 Architecture，表格形式）：

| 组件 | 类型 | 位置 | 安全说明 |
|------|------|------|---------|
| {授权方式名称} | 授权模型 | {实现类}:{行号} | 粒度: {URL/方法/数据}, 角色: {角色列表} |

---

## Step 4: 数据层识别

**必做动作**：搜索项目的数据访问层实现。

### Java/Kotlin

| 数据层 | 搜索模式 |
|--------|---------|
| MyBatis XML | `*Mapper.xml` / `SqlSessionFactory` |
| MyBatis 注解 | `@Select` / `@Insert` / `@Update` / `@Delete` |
| JPA/Hibernate | `@Repository` / `@Entity` / ` JpaRepository` |
| JDBC Template | `JdbcTemplate` / `NamedParameterJdbcTemplate` |
| QueryDSL | `JPAQuery` / `querydsl` |

### Go

| 数据层 | 搜索模式 |
|--------|---------|
| GORM | `gorm.DB` / `gorm.Model` |
| sqlx | `sqlx.DB` / `sqlx.Select` |
| sql/database | `database/sql` / `db.Query` |
| ent | `ent.Client` |

### Python

| 数据层 | 搜索模式 |
|--------|---------|
| SQLAlchemy ORM | `Session` / `Base` / `Column` |
| Django ORM | `models.Model` / `objects.filter` |
| 原始 SQL | `cursor.execute` / `text(` |

### JavaScript

| 数据层 | 搜索模式 |
|--------|---------|
| Prisma | `prisma` / `@prisma/client` |
| Sequelize | `Sequelize` / `Model` |
| TypeORM | `@Entity` / `Repository` |
| Mongoose | `mongoose.model` / `Schema` |

**输出格式**（写入 Architecture，表格形式）：

| 组件 | 类型 | 位置 | 安全说明 |
|------|------|------|---------|
| {数据层类型} | 数据层 | {配置文件/包路径} | SQL拼接风险: {有/无}, ORM: {是/否} |

---

## Step 5: 安全中间件识别

**必做动作**：搜索项目的安全相关中间件和全局处理。

| 中间件类型 | 搜索模式 |
|-----------|---------|
| XSS 过滤 | `XSSFilter` / `HtmlUtils.htmlEscape` / `sanitize` / `bleach` / `DOMPurify` |
| CSRF 防护 | `CsrfFilter` / `csrf` / `@csrf_protect` / `csurf` |
| SSRF 代理 | `SSRFProxy` / `SafeHttpClient` / `urlWhitelist` / `ssrf` |
| 全局异常处理 | `@ControllerAdvice` / `@ExceptionHandler` / `ErrorHandler` |
| 请求参数校验 | `@Valid` / `@Validated` / `@RequestBody` / `validator` / `joi` / `zod` |
| CORS 配置 | `@CrossOrigin` / `CorsConfiguration` / `cors` middleware |
| 请求限流 | `RateLimiter` / `@RateLimit` / `throttle` |
| SQL 注入防护 | `PreparedStatement` / 参数化查询 / `escape_string` |

**输出格式**（写入 Common Components）：

| 组件 | 类型 | 位置 | 安全说明 |
|------|------|------|---------|
| XSSFilter | 安全过滤器 | com.xxx.filter.XSSFilter | 全局 XSS 过滤 |
| GlobalExceptionHandler | 异常处理 | com.xxx.handler.GlobalExceptionHandler | 统一异常响应 |

---

## Step 5.5: 误报预防上下文记录

**触发条件**: Step 2-5 已完成

**必做动作**: 识别并记录以下四类安全上下文信息，供 api-audit / report-review / security-assessment 模式消费。

> **核心原则**：arch-scan 阶段预先识别可能导致误报的代码模式，避免下游模式重复分析或遗漏。重点关注「身份凭据与资源ID的传递关系」——当两者一起传给下游 RPC 时，IDOR 判定应被排除。

### 5.5.1 RPC 下游凭证模式

搜索所有 Controller/Handler 中调用下游 RPC（`@KrpcReference`、`XxxClient`、`XxxService`）的代码，识别同时传递**身份凭证**和**资源ID**的模式。

**搜索命令**：
```bash
# 搜索RPC客户端调用
grep -rn "@KrpcReference\|@GrpcClient\|Client\b" --include="*.java" -A 20
# 搜索同时传递身份ID和资源ID的RPC调用
grep -rn "setUserId\|setSellerId\|setAccountId\|setVisitorId" --include="*.java"
```

**记录格式**（每条一行）：
```
RPC-DOWNSTREAM: {Controller.method} → {下游Service} | 身份: {sellerId/visitor/userId} + 资源: {resourceId} | 判定: 下游可做归属校验
```

**真实案例**（应被记录的典型模式）：
```
# 案例1: LotteryController - sellerId + lotteryId 一起传给 lotteryManageClient
RPC-DOWNSTREAM: LotteryController.detail → lotteryManageClient.queryLotteryDetail | 身份: sellerId(@Visitor注入) + 资源: lotteryId(@JsonParam用户可控) | 判定: 下游可做归属校验
# LotteryController.java:283-290: request.setSellerId(sellerId).setLotteryId(lotteryId) → lotteryManageClient.queryLotteryDetail(request)

# 案例2: PreShellController - sellerId + campaignId 一起传给 preShellManageClient
RPC-DOWNSTREAM: PreShellController.end → preShellManageClient.earlyEndPreShell | 身份: sellerId(@Visitor注入) + 资源: campaignId(@JsonParam用户可控) | 判定: 下游可做归属校验
# PreShellController.java:106-109: .setCampaignId(campaignId).setSellerId(sellerId) → preShellManageClient.earlyEndPreShell()

# 案例3: MusicBusinessAuthLetterController - visitor + sessionId 一起传给 RPC
RPC-DOWNSTREAM: MusicBusinessAuthLetterController.getAuthLetterFile → musicBusinessDocBuilderRpcClient.getAuthLetterFile | 身份: visitor(@Visitor注入) + 资源: sessionId(@JsonParam用户可控) | 判定: 下游可做归属校验
```

**关键提醒**：当发现身份 ID 与资源 ID 同时被传递给下游 RPC 时，必须记录此模式，并标注"下游可做归属校验"。后续 api-audit/report-review 遇到此端点的 IDOR 判定时，应优先查阅此记录。

### 5.5.2 ID 类型目录

对代码中出现的所有资源标识符类型进行分类，判断可枚举性。

**搜索命令**：
```bash
# 搜索ID生成策略
grep -rn "@GeneratedValue\|AUTO_INCREMENT\|IDENTITY\|UUID\|SnowflakeIdGenerator" --include="*.java"
# 搜索BlobStore相关标识符
grep -rn "blobKey\|bucketName\|BlobStoreKey\|bs3Client\|BS3Client" --include="*.java"
# 搜索加密参数
grep -rn "AES\|encrypt\|decrypt\|Cipher\|@EncryptedRequestParam" --include="*.java"
```

**记录格式**：
```
ID-TYPE: {字段名} | 类型: {自增Long/UUID/String/BlobStoreKey/BucketName/HashID/AES-Encrypted} | 可枚举: {是/否} | 依据: {@GeneratedValue(IDENTITY)/UUID格式/加密不可逆/随机key不可预测}
```

**分类规则**：

| ID 类型 | 可枚举性 | 判定依据 |
|---------|---------|---------|
| 自增 Long/Integer | 是 | `@GeneratedValue(strategy = IDENTITY)` |
| 雪花 ID | 部分 | `SnowflakeIdGenerator`，时间有序但非连续 |
| UUID v4 | 否 | `@GeneratedValue(strategy = UUID)` |
| BlobStore key/blobKey | 否 | 服务端生成随机字符串，无法遍历 |
| Bucket name (UUID格式) | 否 | 命名规则含UUID/强随机 |
| AES 加密参数 | 否 | 加密后密文不可预测原始值 |
| Hash ID (>=32位) | 否 | 单向哈希不可逆推 |

**真实案例**：
```
# BlobStore key 不可枚举
ID-TYPE: key (MusicianV2FileController) | 类型: BlobStoreKey | 可枚举: 否 | 依据: 服务端上传时生成的随机字符串，用户无法遍历

# Bucket name + blobKey 不可枚举
ID-TYPE: bucket+blobKey (MusicDownloadExportController.downloadAnyFile) | 类型: BucketName+BlobKey | 可枚举: 否 | 依据: bucket名和blobKey均为不可预测标识符

# AES 加密参数不可枚举
ID-TYPE: key (MusicianV2FileController, @EncryptedRequestParam) | 类型: AES-Encrypted | 可枚举: 否 | 依据: 参数经AES加密，密文不可逆推原始BlobStore key
```

**Jooq/代码生成框架例外说明**：
当项目使用 Jooq、MyBatis Generator 等代码生成框架时，数据模型（包括主键策略、ID 生成方式）定义在数据库层面而非 Java 代码中。此时无法通过搜索 Java 代码的 `@GeneratedValue` 等注解判断 ID 可枚举性。
- 处理方式：将此类项目的 ID 类型标记为 `unknown`，不强制分类
- 记录格式：`ID-TYPE: {参数名} ({Controller}) | 类型: unknown（Jooq 代码生成） | 可枚举: 未知 | 依据: ID 策略定义在数据库层`

### 5.5.3 公开数据端点

识别返回公开数据的接口（无需登录或数据已在搜索结果中可见）。

**搜索命令**：
```bash
# 搜索公开路径
grep -rn "/public/\|/open/\|/anon/" --include="*.java"
# 搜索用户资料类接口（昵称/头像）
grep -rn "getProfile\|getUserInfo\|getAvatar\|getNickname" --include="*.java"
# 搜索商品/公告类接口
grep -rn "getProduct\|getAnnouncement\|getNotice" --include="*.java"
```

**记录格式**：
```
PUBLIC-DATA: {HTTP方法} {路径} | 数据类型: {用户昵称头像/商品信息/公告/配置} | 判定: 已公开数据
```

**真实案例**：
```
PUBLIC-DATA: GET /rest/kquan/social/profile/user | 数据类型: 用户昵称/头像/性别等基础信息 | 判定: 已公开数据，搜索结果中可见
```

### 5.5.4 租户边界图

识别多租户模式，记录租户边界。

**搜索命令**：
```bash
# 搜索租户标识
grep -rn "tenantId\|orgId\|organizationId\|companyId\|guildId\|teamId\|workspaceId" --include="*.java"
# 搜索租户隔离查询
grep -rn "findByTenantId\|AndTenantId\|where.*tenant_id\|tenant_id.*=" --include="*.java"
```

**记录格式**：
```
TENANT-BOUNDARY: {租户标识符} | 类型: {组织/团队/公会} | 隔离级别: {租户内共享/租户+用户双重隔离} | 判定: 同租户内横向访问不构成越权
```

**真实案例**：
```
TENANT-BOUNDARY: orgId (LiveSettlementAuthorIncomeController) | 类型: 组织/公会 | 隔离级别: 租户内共享(公会管理员可查看旗下主播收入) | 判定: 同租户内横向访问不构成越权
# settlement接口通过 orgStaffFilterHelper.getFilteredMemberIds() 过滤，仅在 orgId 相同的组织内操作
```

**写入目标**: 写入 .redtrace/code-audit/PROJECT_CONTEXT.md 的 "Other Findings" 章节（不新增章节，复用已有结构），每条以 `RPC-DOWNSTREAM:`、`ID-TYPE:`、`PUBLIC-DATA:`、`TENANT-BOUNDARY:` 前缀标记。

---

## Step 5.7: 轻量级威胁建模

**触发条件**: Step 2-5 已完成，架构信息已收集

**必做动作**: 基于 Step 2-5 已识别的认证体系、授权模型、数据层、安全中间件，执行 STRIDE 威胁分析。这是轻量级分析，不需要执行完整威胁建模流程。

> **核心原则**：arch-scan 已经识别了架构，威胁建模步骤只需在此基础上做 STRIDE 分类和优先级评估，不需要重新搜索代码。

### 5.7.1 资产识别

从 Step 2-5 已识别的组件中提取需要保护的关键资产。

**来源映射**：
- Step 2（认证体系）→ 用户身份、Token/Session 为资产
- Step 3（授权模型）→ 权限配置、角色定义为资产
- Step 4（数据层）→ 数据库内容、ORM 模型为资产
- Step 5（安全中间件）→ 过滤规则、安全配置为资产

**记录格式**（每条一行）：
```
ASSET: {资产名称} | 敏感度: {low/medium/high/critical} | 描述: {一句话}
```

**敏感度评分指南**：

| 敏感度 | 适用场景 |
|--------|---------|
| critical | 用户密码、密钥、认证凭据、财务数据 |
| high | 用户 PII、业务核心数据（订单/交易） |
| medium | 业务配置、内部 API、非敏感用户数据 |
| low | 公开信息、日志、非业务配置 |

**示例**：
```
ASSET: 用户认证Token | 敏感度: critical | 描述: JWT Token，包含 userId/role，泄露可冒充身份
ASSET: 商家订单数据 | 敏感度: high | 描述: 订单金额/状态/收货信息，通过 MyBatis 查询
ASSET: 商品公开信息 | 敏感度: low | 描述: 商品名称/价格，搜索结果中可见
```

### 5.7.2 入口点与信任边界

从 Step 2-5 已识别的认证体系和安全中间件中提取信任边界。

**来源映射**：
- Step 2 认证体系 → 认证边界（未认证 vs 已认证）
- Step 3 授权模型 → 授权边界（普通用户 vs 管理员）
- Step 4 数据层 → 数据访问边界（应用内 vs 外部存储）
- Step 5 安全中间件 → 输入过滤边界（外部输入 vs 内部处理）

**记录格式**（每条一行）：
```
ENTRY: {入口名称} | 信任边界: {信任边界描述} | 可达资产: {asset1,asset2}
```

**示例**：
```
ENTRY: REST API (Spring Security FilterChain) | 信任边界: 未认证网络 → 认证会话 | 可达资产: 商家订单数据,用户认证Token
ENTRY: gRPC 内部调用 (KESS-RPC) | 信任边界: 内部服务 → 当前服务 | 可达资产: 商家订单数据
ENTRY: 后台管理接口 | 信任边界: 认证用户 → 管理员操作 | 可达资产: 系统配置,所有业务数据
```

### 5.7.3 STRIDE 威胁评估

对每个入口点，逐一检查 STRIDE 六类威胁。仅记录有实际可能的威胁（有代码证据或架构特征支撑），跳过不适用的类别。

| STRIDE 类别 | 检查问题 | 前缀 |
|------------|---------|------|
| Spoofing | 威胁主体能否伪造身份绕过认证？ | STRIDE-S |
| Tampering | 威胁主体能否篡改传输中或存储中的数据？ | STRIDE-T |
| Repudiation | 威胁主体能否执行操作后不留可追溯记录？ | STRIDE-R |
| Information Disclosure | 威胁主体能否读取不应访问的数据？ | STRIDE-I |
| Denial of Service | 威胁主体能否耗尽资源使服务不可用？ | STRIDE-D |
| Elevation of Privilege | 威胁主体能否获得比当前更高的权限？ | STRIDE-E |

**评估方法**（基于已有架构信息，无需重新搜索代码）：

1. **Spoofing**: 检查 Step 2 认证体系是否完整覆盖所有入口
   - 无全局认证覆盖 → STRIDE-S 风险
   - 认证仅依赖客户端传递的 userId → STRIDE-S 风险
   - JWT 无签名校验或算法无白名单 → STRIDE-S 风险

2. **Tampering**: 检查 Step 4 数据层是否有参数化查询
   - 存在 SQL 拼接（`${}` 占位符） → STRIDE-T 风险
   - 无输入校验 → STRIDE-T 风险

3. **Repudiation**: 检查是否存在审计日志
   - 关键操作无操作日志 → STRIDE-R 风险
   - 大多数 Web 服务此项不适用，可跳过

4. **Information Disclosure**: 检查 Step 3 授权模型和数据层
   - 列表接口无分页或分页无上限 → STRIDE-I 风险
   - 接口返回多余字段（密码哈希等） → STRIDE-I 风险
   - 无字段级权限控制 → STRIDE-I 风险

5. **Denial of Service**: 检查 Step 5 安全中间件
   - 无请求限流 → STRIDE-D 风险
   - 无请求体大小限制 → STRIDE-D 风险
   - 有文件上传且无大小限制 → STRIDE-D 风险

6. **Elevation of Privilege**: 检查 Step 3 授权模型
   - 仅前端隐藏管理功能，后端无鉴权 → STRIDE-E 风险
   - 角色检查在前端而非后端 → STRIDE-E 风险
   - IDOR 模式（无所有权校验）→ STRIDE-E 风险

**actor 枚举值**：`remote_unauth`（未认证远程用户）、`remote_auth`（已认证远程用户）、`adjacent_network`（同网络）、`local_user`（本地用户）、`insider`（内部人员）

**记录格式**（每条一行）：
```
STRIDE-{S|T|R|I|D|E}: {一句话威胁描述} | actor: {actor} | surface: {文件名.方法名 或 Controller名} | 影响: {low/medium/high/critical} | 状态: {unmitigated/partially_mitigated/mitigated}
```

> **surface 格式契约（下游消费依赖）**：`surface` 字段必须包含具体的文件名或方法名（如 `UserController.updateOrder`），不能仅写 `REST API`。下游 api-audit/report-review/mr-review 通过 surface 字段模糊匹配 finding 与 STRIDE 威胁，实现 severity +1 增强和 `[THREAT-MATCH]` 标签。详见 `references/common/threat-consumption.md`。

**示例**：
```
STRIDE-S: 无全局认证覆盖，部分接口可直接访问 | actor: remote_unauth | surface: REST API | 影响: critical | 状态: unmitigated
STRIDE-T: MyBatis XML 中存在 ${} 拼接 | actor: remote_auth | surface: REST API | 影响: high | 状态: partially_mitigated
STRIDE-I: 列表接口无分页上限，可遍历全量数据 | actor: remote_auth | surface: REST API | 影响: medium | 状态: unmitigated
STRIDE-D: 无请求限流，批量请求可耗尽服务资源 | actor: remote_unauth | surface: REST API | 影响: medium | 状态: unmitigated
STRIDE-E: 管理接口仅有前端隐藏保护，后端无角色校验 | actor: remote_auth | surface: 后台管理接口 | 影响: critical | 状态: unmitigated
```

**跳过规则**：
- 纯前端项目：只评估 XSS 相关的 STRIDE-I 和 STRIDE-S（Token 存储），其余跳过
- 单体无数据库项目：跳过 STRIDE-T（无数据篡改面）
- 无用户体系项目：跳过 STRIDE-S、STRIDE-E

**写入目标**: 写入 .redtrace/code-audit/PROJECT_CONTEXT.md 的 "Threat Model" 章节对应子章节，每条以 `ASSET:`、`ENTRY:`、`STRIDE-{类别}:` 前缀标记。

---

## Step 6: 写入 .redtrace/code-audit/PROJECT_CONTEXT.md

> **核心约束**：.redtrace/code-audit/PROJECT_CONTEXT.md 必须在当前项目根路径下，严禁读取上层或其他位置的 .redtrace/code-audit/PROJECT_CONTEXT.md，严禁搞混。

**必做动作**：

将识别结果写入 .redtrace/code-audit/PROJECT_CONTEXT.md 的对应章节：

1. **Project Overview 章节**：写入 Step 1 识别的语言、框架、项目类型
2. **Architecture 章节**：写入认证体系、授权模型、数据层描述
3. **Modules 章节**：写入识别到的业务模块
4. **Common Components 章节**：写入安全中间件列表
5. **Dangerous Patterns 章节**：写入发现的危险模式
6. **Other Findings 章节**：写入其他安全发现
7. **Other Findings 章节（误报预防上下文）**：写入 Step 5.5 识别的 RPC 下游模式、ID 类型目录、公开数据端点、租户边界（以 `RPC-DOWNSTREAM:`、`ID-TYPE:`、`PUBLIC-DATA:`、`TENANT-BOUNDARY:` 前缀标记）
8. **Threat Model 章节**：写入 Step 5.7 识别的资产（`ASSET:` 前缀）、入口点（`ENTRY:` 前缀）和 STRIDE 威胁（`STRIDE-{类别}:` 前缀）

**写入规则**：
- 遵循 .redtrace/code-audit/PROJECT_CONTEXT.md 的"限制"章节规范
- 每条不超过一行
- 附带文件路径和行号
- 已有内容不重复，只追加新发现
- "限制"、"更新规则"、"Skill 反馈"三个章节禁止更新
- **不创建新章节**：只在 .redtrace/code-audit/PROJECT_CONTEXT.md 已有的空章节模板中追加内容，禁止创建带项目名后缀的新章节（如 `## Architecture (project-name)`）
- **不改章节名称**：保持 .redtrace/code-audit/PROJECT_CONTEXT.md 中已有章节标题不变（如 Architecture 而非 Architecture (project-name)）
- **只在以下章节写入**：Project Overview、Architecture、Modules、Common Components、Dangerous Patterns、Other Findings、Threat Model

---

## 注意事项

1. **不阻塞原则**：arch-scan 失败不应阻止后续审计流程
2. **增量更新**：如果 .redtrace/code-audit/PROJECT_CONTEXT.md 已有内容，只追加不覆盖
3. **准确性**：每个发现都需要有代码证据（文件:行号）
4. **语言覆盖**：根据项目语言只执行对应语言的搜索模式
5. **.redtrace/code-audit/PROJECT_CONTEXT.md 路径约束**：.redtrace/code-audit/PROJECT_CONTEXT.md 必须在当前项目根路径下，严禁读取上层或其他位置的 .redtrace/code-audit/PROJECT_CONTEXT.md，严禁搞混
6. **行号定位精确度**：搜索结果中的行号必须区分以下三种类型，优先记录**定义行号**：
   - **import 行号**：`import com.xxx.XxxInterceptor;` — 不可用作定位行号
   - **Bean 定义行号**：`public XxxInterceptor xxxInterceptor() {` — 这是正确的定位行号，搜索模式 `grep -n "public.*xxxInterceptor\(\)"`
   - **调用/注册行号**：`registry.addInterceptor(xxxInterceptor())` — 可补充记录，但不应作为主行号

   **Spring 配置类行号定位规则**：
   - 拦截器/Filter：用 `grep -n "public.*InterceptorName\(\)"` 定位 Bean 定义方法，而非 `grep -rn "InterceptorName"` （后者返回 import 行号）
   - 配置方法范围（如 `addInterceptors` 方法 117-143 行）不应作为拦截器的行号，应定位到具体 Bean 定义行
   - 如果 Bean 定义与注册在不同位置，优先记录 Bean 定义行号
7. **多模块项目**：多模块项目（含多个 `*-service`、`*-api`、`*-web` 子目录）需在每个模块中搜索拦截器/Filter 配置，不能只搜索主模块。
8. **不适用通用 JSON 输出校验脚本**（`$REDTRACE_SKILLS_DIR/code-audit/scripts/validate-output.cjs`）：arch-scan 输出写入 .redtrace/code-audit/PROJECT_CONTEXT.md 文档而非 JSON，schema 不覆盖。跳过 SKILL.md 通用质量门禁的「输出格式校验」项。
