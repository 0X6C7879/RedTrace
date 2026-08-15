# Java 通用检索技巧

## HTTP 入口可达性检索

### Spring Boot REST Controller

#### Controller 类识别

| 注解 | 说明 |
|------|------|
| `@RestController` | RESTful 控制器 |
| `@Controller` | MVC 控制器 |

#### 路由映射注解

| 注解 | HTTP 方法 | 示例 |
|------|----------|------|
| `@GetMapping` | GET | `@GetMapping("/api/users/{id}")` |
| `@PostMapping` | POST | `@PostMapping("/api/users")` |
| `@PutMapping` | PUT | `@PutMapping("/api/users/{id}")` |
| `@DeleteMapping` | DELETE | `@DeleteMapping("/api/users/{id}")` |
| `@PatchMapping` | PATCH | `@PatchMapping("/api/users/{id}")` |
| `@RequestMapping` | 任意 | `@RequestMapping(value = "/api", method = RequestMethod.GET)` |

#### 参数来源注解

| 注解 | 参数来源 | 可控性 |
|------|----------|--------|
| `@PathVariable` | URL 路径 | 可控 |
| `@RequestParam` | URL 查询参数 | 可控 |
| `@RequestBody` | 请求体 JSON | 可控 |
| `@RequestHeader` | 请求头 | 部分可控 |
| `@CookieValue` | Cookie | 部分可控 |
| `@ModelAttribute` | 表单数据 | 可控 |

#### 识别命令

```bash
# 查找所有 Controller
grep -rn "@RestController\|@Controller" --include="*.java"

# 查找路由映射
grep -rn "@.*Mapping" --include="*.java"

# 查找用户参数
grep -rn "@RequestParam\|@PathVariable\|@RequestBody" --include="*.java"
```

#### 代码示例

```java
@RestController
@RequestMapping("/api/users")
public class UserController {

    // GET 请求，路径参数可控
    @GetMapping("/{id}")
    public Result getUser(@PathVariable Long userId) {
        // userId 来自 URL 路径，用户可控
    }

    // POST 请求，请求体可控
    @PostMapping
    public Result createUser(@RequestBody UserDTO userDTO) {
        // userDTO 所有字段来自请求体，用户可控
    }

    // GET 请求，查询参数可控
    @GetMapping("/search")
    public Result search(@RequestParam String keyword) {
        // keyword 来自查询参数，用户可控
    }
}
```

---

### gRPC Service 识别

#### 标准 gRPC

| 注解 | 说明 |
|------|------|
| `@GrpcService` | gRPC 服务（标准框架） |

#### 方法特征

- 实现了 proto 定义的方法
- 方法签名匹配 rpc 定义
- 使用 `@Override` 注解
- 继承 `XXXServiceImplBase`

#### 识别命令

```bash
# 查找 gRPC 服务
grep -rn "@GrpcService" --include="*.java"

# 查找 proto 定义
grep -rn "extends.*ImplBase" --include="*.java"
```

#### 代码示例

```java
@GrpcService
public class UserService extends UserServiceGrpc.UserServiceImplBase {

    @Override
    public void getUser(GetUserRequest request, StreamObserver<GetUserResponse> responseObserver) {
        // request 所有字段来自 proto 定义
        String userId = request.getUserId();  // 需判定可控性
    }
}
```

---

### 快手 KESS-RPC 框架

#### 服务注解

| 注解 | 说明 |
|------|------|
| `@KrpcService` | KsBoot 服务注解 |
| `@KrpcReference` | 客户端引用注解 |
| `@EnableKrpc` | 启用注解 |

#### 服务实现基类

| 基类 | 说明 |
|------|------|
| `extends KrpcXXXGrpc.XXXImplBaseV2` | 新版服务实现 |
| `extends XXXGrpc.XXXServiceImplBaseV2` | 旧版服务实现 |

#### 识别命令

```bash
# 查找 KESS-RPC 服务
grep -rn "@KrpcService" --include="*.java"
```

#### 代码示例

```java
@KrpcService
public class QueryRpcService extends QueryServiceImplBaseV2 {

    @Override
    public QueryResponse query(QueryRequest request) {
        // 业务字段可控性需判定
        String searchField = request.getSearchField();
        String keyword = request.getKeyword();
    }
}
```

---

## gRPC 参数可控性判定

### 身份凭据字段（不可控）

以下字段通常由 gRPC 拦截器从认证信息中提取并注入：

| 字段名 | 说明 |
|--------|------|
| `userId` | 用户 ID |
| `sellerId` | 商家 ID |
| `merchantId` | 商户 ID |
| `accountId` | 账户 ID |
| `sessionId` | 会话 ID |
| `token` / `authToken` | 认证令牌 |

**判定规则**：
- **字段名为上述身份凭据名称** → 不可控（安全）
- **其他业务字段** → 用户可控（需继续研判）

### 用户可控字段

- 所有业务字段：proto 中定义的业务字段均为用户可控
- 嵌套 message 字段：包括嵌套消息中的所有字段
- `repeated` 字段：数组类型字段
- `oneof` 字段：联合类型字段
- `map` 字段：键值对字段

---

## .proto 文件检索规则

### 步骤 1：识别 proto 类名

Java 类名通常为 `{MessageName}Proto` 或包含 `OuterClass`

### 步骤 2：定位 .proto 文件

| 优先级 | 路径 | 说明 |
|--------|------|------|
| 高 | `{project}-sdk/src/main/proto/**/*.proto` | 快手 SDK 子项目 |
| 高 | `target/generated-sources/protobuf/**` | 生成代码位置 |
| 中 | `src/main/proto/**/*.proto` | 标准 Maven 目录 |
| 低 | `proto/**/*.proto`、`**/*.proto` | 其他可能位置 |

### 步骤 3：解析 message 定义

找到对应的 message 定义，确认字段类型

### 识别命令

```bash
# 查找 proto 文件
find {project}-sdk -name "*.proto"

# 查找特定 message 定义
grep -rn "message MessageName" --include="*.proto"
```

---

## 数据流追踪方法

### 从 sink 点向上追溯

```java
// Step 1: 识别 sink 点
queryWrapper.like(finalSearchField, v);  // sink: like 操作

// Step 2: 追踪参数来源
// finalSearchField 从哪里来？

// Step 3: 继续向上追溯
// 谁调用了这个方法？使用 Grep 搜索

// Step 4: 找到入口点
// 确认 Controller/gRPC Service 方法
```

### gRPC 特定数据流追踪

1. **识别 proto 请求类型**：从方法签名中找到 Request 类型
2. **定位 proto 文件**：使用 Glob 搜索 `{project}-sdk/**/*.proto`
3. **解析 message 定义**：确认字段类型和名称
4. **判定字段可控性**：
   - 身份凭据字段（userId/sellerId/token 等）→ 不可控
   - 其他业务字段 → 用户可控

### 识别命令

```bash
# 追踪数据流 - 使用 Grep 搜索调用关系

# 跨文件搜索调用关系
grep -rn "methodName(" --include="*.java"

# 搜索类引用
grep -rn "ClassName" --include="*.java"
```

---

## 环境判断检测

```bash
# 检测环境判断
grep -rn "isProd\|isTest\|isDev\|isLocal\|Env\." --include="*.java"

# 检测 Spring Profile
grep -rn "@Profile\|spring.profiles.active" --include="*.java"
```

---

## 防护措施检查方法

| 检查项 | 检索方法 |
|--------|----------|
| 参数化证据 | Grep: `PreparedStatement` / `#{}` / `?` |
| 类型转换 | Grep: `Integer.parseInt` / `Enum.valueOf` |
| 白名单定义 | Grep: `ALLOWED_XXX` / `WHITE_LIST` |
| 校验函数实现 | Grep: 搜索函数定义 |
| Kconf 配置 | Grep: `kconf.getString` / `KconfConstant` |
| 代理名称 | Grep: `anti` / `ssrf` |
| 自定义防护注解 | Grep: `@.*Check\|@.*Filter\|@.*Validate` |
| 切面实现 | Grep: `@Aspect\|@Around\|@Before` + Read |
| 开关默认值 | Read: 查 `Kconf.ofBoolean` / `@Value` 的默认参数 |
| 黑名单定义 | Grep: `BLACKLIST\|KEYWORDS\|INJECTION_` |

**详细防护规则**：
- 净化措施判定：`references/common/sanitization.md`
- 可信数据源判定：`references/common/trusted-sources.md`
- SSRF 隔离代理：`references/common/ssrf-proxy.md`

---

## 可达性判定总结

| 条件 | 可达性 | 结论 |
|------|--------|------|
| 有 Controller，参数来自 @PathVariable/@RequestParam/@RequestBody | 可达 | 漏洞/风险/安全取决于防护 |
| 有 gRPC Service，参数来自 rpc 请求（业务字段） | 可达 | 漏洞/风险/安全取决于防护 |
| 有 gRPC Service，参数为身份凭据（userId/token 等） | 不可达 | 安全 |
| 无入口点，仅内部调用 | 不可达 | 风险 |
| 参数来自常量/配置/数据库 | 不可达 | 风险 |
