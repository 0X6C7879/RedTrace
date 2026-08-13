# 访问控制缺失/越权（Java）

## 0. 前置判断：与 IDOR 的边界

| 条件 | 归类 | 后续动作 |
|------|------|---------|
| 接口完全无认证 | BrokenAccessControl（未授权） | 继续本文档 |
| 有认证但可绕过 | BrokenAccessControl（权限绕过） | 继续本文档 |
| 有认证 + 无角色/权限校验 + 管理功能 | BrokenAccessControl（垂直越权） | 继续本文档 |
| 有认证 + 无归属校验 + 访问他人资源 | **IDOR** | 切换到 IDOR 流程 |
| 有认证 + 权限码过宽 | BrokenAccessControl（全局越权） | 继续本文档 |

---

## 1. 结论判断标准

按 4 个子类型分别定义判定条件：

### 1.1 未授权

| 结论 | 判定条件 |
|------|---------|
| vulnerability | Controller 方法无认证注解 + 无全局拦截器覆盖 + HTTP 入口可达 + 非公开数据 |
| risk-a | 无 HTTP/gRPC 入口可达的认证缺失 |
| safe | 全局拦截器已覆盖 / 业务设计为公开接口 |
| unknown | 无法判断是否有全局认证 |

### 1.2 权限绕过

| 结论 | 判定条件 |
|------|---------|
| vulnerability | 认证机制存在但可绕过（签名异常返回 true / 拦截器排除路径 / token 为空放行） |
| risk-a | 绕过路径无 HTTP 入口可达 |
| risk-b | 有部分防护但实现薄弱 |
| safe | 认证机制完善无绕过 |

### 1.3 垂直越权

| 结论 | 判定条件 |
|------|---------|
| vulnerability | 接口有认证 + 管理功能无角色校验（路径含 admin/super/manage 但无 @RolesAllowed） |
| risk-a | 管理功能无 HTTP 入口可达 |
| risk-b | 有角色校验但可绕过 |
| safe | 有完善的 RBAC 或权限注解 |

### 1.4 全局越权

| 结论 | 判定条件 |
|------|---------|
| vulnerability | 已认证 + 无权限码或权限码过宽（如 R003 全员可访问）+ 非公开功能 |
| risk-a | 功能无 HTTP 入口可达 |
| risk-b | 有部分权限控制 |
| safe | 有精确的权限码配置 |

---

## 2. 子模式详解

### 2.A 未授权

#### 模式 A1：认证注解缺失

**识别特征**：Controller 方法无 `@PreAuthorize` / `@Secured` / `@RolesAllowed` 注解

```java
// 漏洞代码：无任何认证注解
@PostMapping("/api/admin/deleteUser")
public Result deleteUser(@RequestParam Long userId) {
    userService.delete(userId);
    return Result.success();
}
```

```java
// 安全写法：有认证注解
@PreAuthorize("hasRole('ADMIN')")
@PostMapping("/api/admin/deleteUser")
public Result deleteUser(@RequestParam Long userId) {
    userService.delete(userId);
    return Result.success();
}
```

**判定流程**：
1. 确认方法无认证注解
2. 检查类级别是否有认证注解
3. 检查全局拦截器是否覆盖该路径（搜索 `WebMvcConfigurer` / `SpringSecurity` 配置）
4. 全局拦截器未覆盖 → 未授权漏洞

#### 模式 A2：permitAll 暴露

**识别特征**：`SecurityConfig.permitAll()` 包含敏感路径

```java
// 漏洞代码：敏感路径设为 permitAll
@Override
protected void configure(HttpSecurity http) throws Exception {
    http.authorizeRequests()
        .antMatchers("/api/user/info", "/api/order/list").permitAll()
        .anyRequest().authenticated();
}
```

```java
// 安全写法：敏感路径需要认证
@Override
protected void configure(HttpSecurity http) throws Exception {
    http.authorizeRequests()
        .antMatchers("/api/public/**").permitAll()
        .anyRequest().authenticated();
}
```

#### 模式 A3：拦截器排除路径

**识别特征**：`LoginInterceptor` 排除 `/outer/` 等路径

```java
// 漏洞代码：拦截器排除了敏感路径
@Override
public void addInterceptors(InterceptorRegistry registry) {
    registry.addInterceptor(new LoginInterceptor())
        .excludePathPatterns("/outer/**", "/api/callback/**");
}
```

**判定**：排除路径下的接口需逐一检查是否处理敏感数据。

### 2.B 权限绕过

#### 模式 B1：签名异常返回 true

**识别特征**：`hmacshaAuth catch` 异常后 `return true`

```java
// 漏洞代码：异常时默认通过
public boolean verifySignature(String sign) {
    try {
        return hmacshaAuth.verify(sign);
    } catch (Exception e) {
        log.error("签名验证异常", e);
        return true; // 异常时放行
    }
}
```

```java
// 安全写法：异常时拒绝
public boolean verifySignature(String sign) {
    try {
        return hmacshaAuth.verify(sign);
    } catch (Exception e) {
        log.error("签名验证异常", e);
        return false;
    }
}
```

**数据依据**：外网未授权案例 20 条中 12 条是 `hmacshaAuth 异常返回 true`

#### 模式 B2：token 为空放行

**识别特征**：认证 Filter 中 `token==null` 时仍 `return true`

```java
// 漏洞代码：token 为空时放行
@Override
public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
    String token = request.getHeader("Authorization");
    if (token == null || token.isEmpty()) {
        return true; // 空 token 放行
    }
    return jwtUtil.verify(token);
}
```

```java
// 安全写法：token 为空时拒绝
@Override
public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
    String token = request.getHeader("Authorization");
    if (token == null || token.isEmpty()) {
        response.setStatus(401);
        return false;
    }
    return jwtUtil.verify(token);
}
```

#### 模式 B3：Referer 白名单绕过

**识别特征**：仅依赖 `Referer` 头做认证，可伪造

```java
// 漏洞代码：仅依赖 Referer
String referer = request.getHeader("Referer");
if (referer != null && referer.contains("trusted-domain.com")) {
    return true; // Referer 可伪造
}
```

### 2.C 垂直越权

#### 模式 C1：管理接口无角色校验

**识别特征**：路径含 `admin`/`super`/`manage` 但无 `@RolesAllowed`

```java
// 漏洞代码：管理接口无角色校验
@PostMapping("/api/admin/config/update")
public Result updateConfig(@RequestBody ConfigDTO config) {
    configService.update(config);
    return Result.success();
}
```

```java
// 安全写法：管理接口有角色校验
@PreAuthorize("hasRole('ADMIN')")
@PostMapping("/api/admin/config/update")
public Result updateConfig(@RequestBody ConfigDTO config) {
    configService.update(config);
    return Result.success();
}
```

**数据依据**：BAC 283 条中 105 条（37%）是真正的垂直越权

#### 模式 C2：子账号调用母账号功能

**识别特征**：接口文档标注"管理员"功能但无拦截

```java
// 漏洞代码：仅检查登录状态，未检查角色
@GetMapping("/api/enterprise/settings")
public Result getSettings(@LoginUser User user) {
    // 任何登录用户都能访问企业设置
    return Result.success(enterpriseService.getSettings(user.getEnterpriseId()));
}
```

#### 模式 C3：后门/调试接口暴露

**识别特征**：路径含 `devTools`/`debug` 但生产未限制（Swagger UI/API 文档端点的暴露归为 SwaggerMisconfig，不在此模式范围内）

```java
// 漏洞代码：调试接口未做环境判断
@GetMapping("/api/debug/allUsers")
public List<User> getAllUsers() {
    return userRepository.findAll();
}
```

#### 模式 C4：权限注解未启用

**识别特征**：`@PreAuthorize` 存在但未 `@EnableGlobalMethodSecurity`

```java
// 配置类缺少 @EnableGlobalMethodSecurity
@Configuration
public class SecurityConfig extends WebSecurityConfigurerAdapter {
    // 缺少 @EnableGlobalMethodSecurity(prePostEnabled = true)
    // 导致 @PreAuthorize 注解不生效
}
```

### 2.D 全局越权

#### 模式 D1：无任何权限校验

**识别特征**：已认证用户可触发任意功能（如 ES 数据写入、系统配置修改）

```java
// 漏洞代码：任何认证用户都能修改系统配置
@PostMapping("/api/config/update")
public Result updateConfig(@RequestBody ConfigDTO config, @LoginUser User user) {
    // 未检查用户是否有 config:update 权限
    configService.update(config);
    return Result.success();
}
```

#### 模式 D2：权限码过宽

**识别特征**：R003（全员可访问）应用于审批/管理接口

```java
// 漏洞代码：审批接口使用过宽的权限码
@PreAuthorize("hasAuthority('R003')") // R003 = 全员可访问
@PostMapping("/api/approval/approve")
public Result approve(@RequestParam Long id) {
    approvalService.approve(id);
    return Result.success();
}
```

**数据依据**：BAC 不采纳案例 + "任意认证用户可批量修改所有准入数据"等 root_cause

---

## 3. 检测命令

### 3.1 未授权检测

```bash
# 检测无认证注解的 Controller 方法
grep -rn "@RequestMapping\|@GetMapping\|@PostMapping\|@PutMapping\|@DeleteMapping" --include="*.java" | grep -v "@PreAuthorize\|@Secured\|@RolesAllowed"

# 检测 permitAll 配置
grep -rn "permitAll" --include="*.java"

# 检测拦截器排除路径
grep -rn "excludePathPatterns\|addPathPatterns" --include="*.java"
```

### 3.2 权限绕过检测

```bash
# 检测签名验证异常处理
grep -rn "catch.*Exception\|return true" --include="*.java" -A2 | grep -B2 "return true"

# 检测空 token 放行
grep -rn "token.*null\|token.*isEmpty\|token.*blank" --include="*.java" -A3 | grep "return true"
```

### 3.3 垂直越权检测

```bash
# 检测管理路径无角色注解
grep -rn "@.*Mapping.*admin\|@.*Mapping.*manage\|@.*Mapping.*super" --include="*.java" | grep -v "@PreAuthorize\|@Secured\|@RolesAllowed"
```

### 3.4 全局越权检测

```bash
# 检测权限码使用
grep -rn "hasAuthority\|hasPermission" --include="*.java"

# 检测 R003 等过宽权限码
grep -rn "R003\|R001\|hasAuthority('.*')" --include="*.java"
```

---

## 4. 误报排除规则

| 场景 | 判定 | 原因 |
|------|------|------|
| 全局拦截器已覆盖 | 不报告（安全） | 即使方法无注解，全局认证有效 |
| gRPC 接口由网关认证 | 不报告 | API Gateway 层已认证 |
| 公开 API（公告/字典/配置） | 不报告 | 业务设计为公开 |
| 健康检查接口 | 不报告 | 运维接口 |
| 三方回调接口（有 IP 白名单/签名） | 不报告 | 三方服务回调 |
| Swagger/API 文档接口 | 转为 SwaggerMisconfig 评估 | 使用 SwaggerMisconfig 规则评估是否为不安全配置 |

---

## 5. 变更影响分析

| 变更类型 | 风险 |
|----------|------|
| 新增 Controller 方法无认证注解 | 检查全局拦截器覆盖 |
| 新增 permitAll 路径 | 确认是否处理敏感数据 |
| 移除认证注解 | 引入未授权 |
| 签名验证异常处理改为 return true | 引入权限绕过 |
| 新增管理接口无角色注解 | 引入垂直越权 |
| 权限码设为全员可访问 | 引入全局越权 |

---

## 6. 质量门禁

- [ ] 确认无全局拦截器覆盖后再判定为未授权
- [ ] 检查 SecurityConfig permitAll 路径
- [ ] 检查拦截器排除路径
- [ ] 签名验证无异常绕过
- [ ] 区分未授权（无认证）vs IDOR（有认证但水平越权）
- [ ] 垂直越权已执行角色校验检查
- [ ] 公开接口已排除

---

## 7. 工程约束（禁止清单）

- 禁止假设业务逻辑正确
- 禁止忽略框架权限注解
- 禁止假设路径安全性
- 禁止忽略框架默认行为
