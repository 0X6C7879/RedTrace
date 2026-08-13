# Swagger/OpenAPI 不安全配置（Java）

## 0. 黄金法则

> **漏洞存在性判断 优先于 防护有效性判断**
>
> Swagger 已关闭（`enabled=false`）或 仅限开发环境（`@Profile("!prod")`）= 无 Swagger 不安全配置（这是漏洞本质判断，不是防护有效判断）
>
> 满足此条件时：立即终止分析，无需检查任何防护措施。

---

## 1. 结论判断标准

| 结论 | 定义 | 判定条件 |
|------|------|----------|
| **漏洞** | 生产环境 Swagger UI 无认证对外暴露 | Swagger 配置类生效 + 无 `@Profile` 限制 + SecurityConfig 中 permitAll 或未拦截 Swagger 路径 |
| **风险-A** | Swagger UI 仅内网/非生产环境可访问 | 有环境限制但逻辑不严格（如 `@Profile("dev")` 但生产未排除） |
| **风险-B** | Swagger UI 有防护但可能被绕过 | 有认证但配置不完整 / Knife4j production 配置缺失 |
| **安全** | Swagger 已关闭或有强认证保护 | `springfox.documentation.enabled=false` / `@Profile("!prod")` / SecurityConfig 强制认证 + IP 白名单 |

---

## 2. 子模式详解

### 2.1 Pattern S1: Swagger UI 生产环境无认证暴露

**识别特征**：存在 Swagger 配置类 + 无 `@Profile` 限制 + SecurityConfig 未拦截

**框架识别**：

| 框架 | 配置注解 |
|------|----------|
| Springfox | `@EnableSwagger2`, `Docket` Bean |
| SpringDoc | `@OpenAPIDefinition`, `OpenAPI` Bean |
| Knife4j | `@EnableKnife4j`, `Knife4jProperties` |

```java
// 漏洞：无环境限制 + 无认证保护
@Configuration
@EnableSwagger2
public class SwaggerConfig {
    @Bean
    public Docket api() {
        return new Docket(DocumentationType.SWAGGER_2).select()
            .apis(RequestHandlerSelectors.basePackage("com.example"))
            .paths(PathSelectors.any())
            .build();
    }
}
```

```java
// 安全：Profile 限制非生产环境
@Configuration
@EnableSwagger2
@Profile({"dev", "test"})  // 生产不加载
public class SwaggerConfig { ... }
```

### 2.2 Pattern S2: 包扫描范围过大

**识别特征**：`basePackage` 包含 internal/admin/debug 包

```java
// 漏洞：扫描了内部接口包
.apis(RequestHandlerSelectors.basePackage("com.example"))  // 含 internal/admin 子包
```

```java
// 安全：精确控制扫描范围
.apis(RequestHandlerSelectors.basePackage("com.example.controller.publicapi"))
```

### 2.3 Pattern S3: Swagger 注释泄露基础设施细节

**识别特征**：`@ApiOperation` / `@ApiParam` 描述含数据库连接、内部 URL、密钥信息

```java
// 漏洞：注释暴露内部信息
@ApiOperation(value = "内部管理接口，调用 grpc://admin-service:8080，数据库 jdbc:mysql://10.0.0.1:3306")
```

### 2.4 Pattern S4: Try-It-Out 生产环境启用

**识别特征**：配置中未禁用 Try-It-Out 或 Knife4j 增强功能

```yaml
# SpringDoc：生产环境应禁用
springdoc:
  swagger-ui:
    tryItOutEnabled: false  # 安全
```

### 2.5 Pattern S5: SecurityConfig 未拦截 Swagger 路径

**识别特征**：`permitAll()` 或 `WebSecurity.ignoring()` 含 Swagger 路径

```java
// 漏洞：Swagger 路径绕过认证
@Override
public void configure(WebSecurity web) {
    web.ignoring().antMatchers("/swagger-ui/**", "/v2/api-docs/**");
}
```

### 2.6 Pattern S6: Knife4j 生产配置缺失

**识别特征**：`knife4j.enable=true` 且 `knife4j.production` 未设置或为 false

```yaml
# 安全：生产环境禁用 Knife4j
knife4j:
  enable: true
  production: true  # 禁用 UI
```

---

## 3. 检测命令

```bash
# 检测 Swagger 配置类
grep -rn "@EnableSwagger2\|@EnableKnife4j\|@OpenAPIDefinition" --include="*.java"

# 检测 Swagger Bean
grep -rn "Docket\|OpenAPI\s*" --include="*.java" | grep -i "bean\|public"

# 检测 Swagger 路径绕过认证
grep -rn "swagger\|api-docs\|doc.html" --include="*.java" | grep -i "permitAll\|ignoring"

# 检测 Swagger 启用配置
grep -rn "springfox.documentation.enabled\|springdoc.swagger-ui.enabled\|knife4j" --include="*.yaml" --include="*.yml" --include="*.properties"
```

---

## 4. 误报排除规则

| 场景 | 判定 | 原因 |
|------|------|------|
| `@Profile("dev")` / `@Profile("!prod")` | 安全 | 非生产环境不加载 |
| `springfox.documentation.enabled=false` | 安全 | 显式关闭 |
| Swagger 路径在 SecurityConfig 中需认证 | 安全 | 有认证保护 |
| 仅暴露公开 API 文档，无内部端点 | 安全 | 业务设计为公开 API |
| Knife4j `production: true` | 安全 | 已禁用 UI |
| `@ConditionalOnProperty` 控制加载 | 安全 | 配置开关保护 |
| SpringDoc `springdoc.api-docs.enabled=false` | 安全 | 显式关闭 |

---

## 5. 变更影响分析

| 变更类型 | 风险 |
|----------|------|
| 新增 Swagger 配置类无 `@Profile` | 检查生产环境是否暴露 |
| 新增 `permitAll` 含 swagger 路径 | 引入未认证访问 |
| 移除 `@Profile` 注解 | 从安全变为不安全 |
| Swagger 注释新增连接字符串 | 引入信息泄露 |
| `knife4j.production` 改为 false | 引入 UI 暴露 |

---

## 6. 质量门禁（强制执行）

在输出审计结论前，按顺序验证：

- [ ] Swagger 配置类是否生效已确认（非注释、非 `@Profile` 排除）
- [ ] 框架类型已识别（Springfox / SpringDoc / Knife4j）
- [ ] SecurityConfig 对 Swagger 路径的拦截状态已确认
- [ ] 包扫描范围是否包含 internal/admin 包已确认
- [ ] Swagger 注释是否泄露基础设施信息已确认
- [ ] 结论与证据一致，代码行号可追溯

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**
