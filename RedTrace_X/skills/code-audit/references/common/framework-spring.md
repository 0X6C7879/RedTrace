# Spring 框架特性

## 核心原则

Spring 框架提供了多种安全机制，正确识别这些机制对告警判定至关重要。

---

## SpEL 注入

### 危险用法

| 模式 | 示例 | 风险等级 |
|------|------|----------|
| `@Value("#{...}")` | `@Value("#{systemProperties[userInput]}")` | 高 |
| `StandardEvaluationContext` | 启用 SpEL 表达式 | 高 |
| `ExpressionParser` | 手动解析用户输入 | 高 |

### 安全用法

| 模式 | 说明 |
|------|------|
| `@Value("${...}")` | 属性占位符，不是 SpEL |
| 禁用 SpEL | `SimpleEvaluationContext` |

### 代码示例

```java
// 危险：SpEL 注入
@Value("#{${userProperty}}")
private String value;

// 安全：属性占位符
@Value("${app.property}")
private String value;
```

---

## SQL 注入

### MyBatis

| 模式 | 安全 | 危险 |
|------|------|------|
| `#{param}` | 参数化 | - |
| `${param}` | - | 字符串拼接 |

### Spring Data JPA

| 模式 | 安全 | 危险 |
|------|------|------|
| `@Query("SELECT u FROM User u WHERE u.name = :name")` | 参数化 | - |
| `@Query(value="... nativeQuery=true")` + 参数化 | 参数化 | - |
| 方法名查询 | 自动参数化 | - |

### 代码示例

```java
// 安全：MyBatis 参数化
@Select("SELECT * FROM users WHERE name = #{name}")
User findByName(String name);

// 危险：MyBatis 拼接
@Select("SELECT * FROM users WHERE name = '${name}'")
User findByName(String name);

// 安全：Spring Data JPA
@Query("SELECT u FROM User u WHERE u.name = :name")
List<User> findByName(@Param("name") String name);
```

---

## SSRF

### 危险用法

| 组件 | 示例 | 风险等级 |
|------|------|----------|
| `RestTemplate` | 用户控制 URL | 高 |
| `WebClient` | 用户控制 URL | 高 |
| `@FeignClient` | URL 用户可控 | 中 |

### 防护措施

| 措施 | 识别信号 |
|------|----------|
| URL 白名单 | `ALLOWED_HOSTS.contains(url.getHost())` |
| 隔离代理 | `httpAntiSsrfClient` |
| DNS-IP 校验 | `isInternalIp(InetAddress.getByName(host))` |

### 代码示例

```java
// 危险：RestTemplate 用户可控 URL
String url = request.getParameter("url");
return restTemplate.getForObject(url, String.class);

// 安全：隔离代理
@Autowired
private RestTemplate httpAntiSsrfClient;  // 名称含 anti
```

---

## 文件操作

### MultipartFile

| 场景 | 验证要求 |
|------|----------|
| 文件名 | 验证文件名，防止路径穿越 |
| 文件内容 | 验证文件类型 |
| 文件大小 | 限制大小 |

### 代码示例

```java
// 危险：文件名用户可控
String filename = file.getOriginalFilename();
Path path = Paths.get(uploadDir, filename);
Files.copy(file.getInputStream(), path);

// 安全：重命名
String ext = FilenameUtils.getExtension(file.getOriginalFilename());
String newFilename = UUID.randomUUID() + "." + ext;
Path path = Paths.get(uploadDir, newFilename);
```

---

## 路径遍历

### 危险用法

| 模式 | 示例 |
|------|------|
| `@GetMapping(path="/**")` | 通配符路径 |
| `@RequestMapping` 动态路径 | 用户控制目录 |

### 代码示例

```java
// 需评估：通配符路径
@GetMapping("/files/**")
public ResponseEntity<Resource> getFile(@PathVariable String path) {
    // path 可能为 ../../etc/passwd
    return ResponseEntity.ok(Files.readAllBytes(Paths.get("/files/" + path)));
}
```

---

## XSS

### Thymeleaf

| 模式 | 安全 | 危险 |
|------|------|------|
| `th:text="${var}"` | 自动转义 | - |
| `th:utext="${var}"` | - | 不转义 |
| `${var}` | 自动转义 | - |

### 代码示例

```html
<!-- 安全：自动转义 -->
<div th:text="${userInput}"></div>

<!-- 危险：不转义 -->
<div th:utext="${userInput}"></div>
```

---

## 反序列化

### Jackson

| 配置 | 安全 | 危险 |
|------|------|------|
| 禁用 DefaultTyping | 安全 | - |
| `@JsonTypeInfo` | 需评估 | 可能有风险 |

### 代码示例

```java
// 安全：禁用 DefaultTyping
ObjectMapper mapper = new ObjectMapper();
mapper.disableDefaultTyping();

// 需评估：启用多态
@JsonTypeInfo(use = Id.NAME, include = As.PROPERTY, property = "@type")
```

---

## 常见陷阱

### 陷阱1：@Value 混淆

**场景**：

```java
@Value("${app.name}")  // 属性占位符，安全
private String name;

@Value("#{systemProperties['user.property']}")  // SpEL，需检查
private String userProperty;
```

**正确分析**：

- `${}` 是属性占位符，从配置文件读取
- `#{}` 是 SpEL 表达式，需检查表达式内容

---

### 陷阱2：MyBatis ${} 误判

**场景**：

```java
@Select("SELECT * FROM users ORDER BY ${column}")
List<User> findAll(String column);
```

**正确分析**：

1. 字段名拼接，无法预编译
2. 需检查是否有白名单/枚举映射
3. 无防护 → 漏洞

---

## 研判提示

1. **区分 SpEL 和属性占位符**：`#{}` vs `${}`
2. **MyBatis 占位符**：`#{}` 安全 vs `${}` 危险
3. **Spring Data JPA**：方法名查询和 `:param` 都是参数化
4. **SSRF 隔离代理**：名称含 `anti` 才是隔离代理
5. **自定义注解参数注入**：非标准注解 + HandlerMethodArgumentResolver → 框架注入，可信来源

---

## 自定义注解参数注入

### 安全用法

| 模式 | 说明 |
|------|------|
| `@EspAccount Long accountId` | 通过 HandlerMethodArgumentResolver 从拦截器注入的身份凭证 |
| `@Visitor VisitorInfo visitor` | 通过 HandlerMethodArgumentResolver 注入的访客信息 |
| `@LoginUser User user` | 通过 HandlerMethodArgumentResolver 注入的当前用户 |
| `request.getAttribute("userId")` | 直接从 request 属性中获取拦截器注入的身份 ID |

### 识别机制

Spring MVC 的参数注入流程：
1. 拦截器（HandlerInterceptor.preHandle）从认证 token 中提取身份信息
2. 拦截器将身份信息存入 `request.setAttribute("key", value)`
3. 自定义 `HandlerMethodArgumentResolver` 在参数解析阶段从 `request.getAttribute()` 读取
4. 框架自动将解析结果绑定到 Controller 方法参数

### 安全判定

- 自定义注解注入的身份 ID → 可信来源（等同于 `SecurityContextHolder.getContext().getAuthentication()`）
- 前提：需确认 HandlerMethodArgumentResolver 的解析来源是 `request.getAttribute()` 而非 `request.getParameter()`

### 检测命令

```bash
# 查找参数解析器注册
grep -rn "addArgumentResolvers\|HandlerMethodArgumentResolver" --include="*.java"

# 查找拦截器属性注入
grep -rn "setAttribute.*userId\|setAttribute.*accountId\|setAttribute.*sellerId" --include="*.java"
```
