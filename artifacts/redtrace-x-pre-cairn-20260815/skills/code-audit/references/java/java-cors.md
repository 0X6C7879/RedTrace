# CORS

## 0. 黄金法则

> **漏洞存在性判断 优先于 防护有效性判断**
>
> Credentials=false/null 或 静态特定域名 = 无 CORS 漏洞（这是漏洞本质判断，不是防护有效判断）
>
> 满足此条件时：立即终止分析，无需检查任何防护措施。

**强制执行顺序**：
1. **首先**：找到 CORS 配置代码（如 `setAllowCredentials()`, `setHeader("Access-Control-Allow-Origin")`）
2. **然后**：分析 Credentials 状态和 Origin 设置方式
3. **仅当** Credentials=true 且 Origin 动态回显/通配符时，才继续检查防护措施
4. **禁止**：一上来就检查"有没有白名单"、"A 有 B 没有"

**审计限定条件**：
1. 无需考虑白名单下存在子域名的 CORS 风险（如 `endsWith(".company.com")` 不纳入判定）
2. 无需考虑影响部分接口的 CORS 风险（仅关注影响全量接口）
3. 非登录场景不考虑 CORS 风险

---

## 1. 结论判断标准

| 结论 | 定义 | 判定条件 |
|------|------|----------|
| **漏洞** | Credentials=true + Origin 可回显任意值 + 无有效白名单校验 + HTTP 入口可达 + 影响全量接口 | Credentials=true + 动态回显/通配符 + 无严格白名单 + HTTP 入口 |
| **风险-A** | CORS 配置不安全但无 HTTP 入口可达 | Credentials=true + 动态回显/通配符 + 无外部入口 |
| **风险-B** | CORS 配置有 HTTP 入口可达，但防护措施不充分 | Credentials=true + 动态回显/通配符 + endsWith/startsWith 校验 |
| **无法确认** | 白名单关键代码缺失 | 白名单校验函数代码缺失（仅白名单 List 值无法感知不算缺失） |
| **安全** | 无危险配置，或有充分的有效防护 | Credentials=false/null / 静态特定域名 / 严格白名单 / 非线上环境 |

---

## 2. 研判思路

### 2.1 核心判定矩阵

| Credentials | Origin 设置方式 | 白名单校验 | HTTP入口 | 结论 |
|-------------|----------------|-----------|---------|------|
| false/null | 任意 | 任意 | - | 安全（立即终止） |
| true | 静态特定域名 | 任意 | - | 安全（立即终止） |
| true | 动态回显/通配符 | 严格白名单 | - | 安全 |
| true | 动态回显/通配符 | 无/宽松校验 | 可达 | 漏洞 |
| true | 动态回显/通配符 | 无/宽松校验 | 不可达 | 风险-A |
| true | 动态回显/通配符 | 宽松校验 | 可达 | 风险-B |

### 2.2 研判流程

```
Step 1: Credentials 检查
  ├─ false/null/未设置？ → 安全（终止）
  └─ true → 继续

Step 2: Origin 设置方式检查
  ├─ 静态特定域名？ → 安全（终止）
  ├─ setHeader("*")？ → 安全（浏览器拒绝，终止）
  └─ 动态回显/通配符 → 继续

Step 3: 白名单校验检查
  ├─ Set.contains 严格匹配？ → 安全（终止）
  ├─ endsWith/startsWith 宽松校验？ → 风险-B
  └─ 无校验 → 继续

Step 4: HTTP 入口可达性
  ├─ 无 HTTP 入口？ → 风险-A
  └─ 有 HTTP 入口 → 漏洞
```

> **白名单校验注意**：仅考虑 Host 是否在白名单，无需考虑端口/协议差异

### 2.3 框架通配符自动解析规则

当 Credentials=true 时，以下配置会被框架自动解析为请求的 Origin：

| 框架/API | 危险配置 | 实际效果 |
|---------|---------|---------|
| CorsConfiguration | `addAllowedOrigin("*")` | 解析为请求的 Origin |
| CorsConfiguration | `addAllowedOriginPattern("*")` | 解析为请求的 Origin |
| CorsRegistry | `allowedOrigins("*")` | 解析为请求的 Origin |
| @CrossOrigin | `origins = "*"` | 解析为请求的 Origin |

### 2.4 降级条件表

| 条件 | 原结论 | 降级后 |
|------|--------|--------|
| Credentials 为 false/null | 漏洞 | 安全 |
| 静态特定域名 | 漏洞 | 安全 |
| 严格白名单校验 | 漏洞 | 安全 |
| 非线上环境 | 漏洞 | 安全 |
| endsWith/startsWith 宽松校验 | 漏洞 | 风险-B |
| 无 HTTP 入口可达 | 漏洞 | 风险-A |

### 2.5 影响面判定

| 判定类型 | 场景 | 示例 |
|---------|------|------|
| 全量接口 | Filter/Config 类配置 | `CorsConfiguration` 全局配置 |
| 全量接口 | 无法推断影响面 | 默认全量 |
| 部分接口 | 路径限定 | `addMapping("/api/public/**")` |
| 部分接口 | 注解限定 | `@CrossOrigin` 在特定方法上 |

---

## 3. 常见漏洞/风险场景

### 漏洞

```java
// Spring Boot 框架自动解析
config.addAllowedOrigin("*");  // 漏洞：Spring 自动解析为请求 Origin
config.setAllowCredentials(true);

// 手动动态回显
String origin = request.getHeader("Origin");
response.setHeader("Access-Control-Allow-Origin", origin);  // 漏洞：直接回显
response.setHeader("Access-Control-Allow-Credentials", "true");

// @CrossOrigin 通配符
@CrossOrigin(origins = "*", allowCredentials = "true")  // 漏洞
```

### 风险-A

```java
private void configureCors(HttpServletResponse response, String origin) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Access-Control-Allow-Credentials", "true");
}  // 风险-A：需追踪调用方
```

### 风险-B

```java
if (origin.startsWith("https://api.trusted.com")) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Access-Control-Allow-Credentials", "true");
}  // 风险-B：startsWith 可被子域名绕过
```

---

## 4. 常见防御模式

### Credentials 未启用

```java
config.setAllowCredentials(false);  // 安全
config.addAllowedOrigin("*");
```

### 静态特定域名

```java
config.addAllowedOrigin("https://trusted1.com");  // 安全
config.addAllowedOrigin("https://trusted2.com");
config.setAllowCredentials(true);
```

### 严格白名单校验

```java
private static final Set<String> ALLOWED = Set.of("https://trusted1.com", "https://trusted2.com");
if (ALLOWED.contains(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Access-Control-Allow-Credentials", "true");
}  // 安全
```

---

## 5. 检索技巧

> HTTP 入口可达性检索：详见 [Java 通用检索技巧](java-common-retrieval.md#http-入口可达性检索)

### 搜索关键词

| 类型 | 关键词 |
|------|--------|
| CORS 注解 | `@CrossOrigin` |
| 响应头设置 | `Access-Control-Allow-Origin`, `setAllowCredentials` |
| Spring 配置 | `corsConfigurationSource`, `addCorsMappings`, `addAllowedOrigin` |
| 白名单校验 | `isOriginAllowed`, `ALLOWED_ORIGINS` |

### 检测命令

```bash
grep -rn "@CrossOrigin" --include="*.java"
grep -rn "Access-Control-Allow-Origin\|setAllowCredentials\|allowCredentials" --include="*.java"
grep -rn "corsConfigurationSource\|addCorsMappings\|addAllowedOrigin\|allowedOrigins" --include="*.java"
```

---

## 6. 常见误判场景

### 陷阱1：allowedOrigins("*") 误判安全

**错误**: 看到 `*` 就认为浏览器拒绝
**正确**: Spring 在 Credentials=true 时将 `*` 自动解析为请求的 Origin → 漏洞

### 陷阱2：setHeader("*") 误判漏洞

**错误**: `setHeader("Access-Control-Allow-Origin", "*")` + Credentials=true 是漏洞
**正确**: 手动 setHeader("*") 浏览器会直接拒绝 → 安全。**必须区分框架自动解析和手动设置**

### 陷阱3：白名单函数未读实现

**错误**: 看到 `isOriginAllowed(origin)` 就认为有白名单
**正确**: 必须读取实现——endsWith/startsWith → 风险-B；实现缺失 → 无法确认

### 陷阱4：宽松校验误判安全

**错误**: `startsWith("https://api.trusted.com")` 是有效防护
**正确**: `https://api.trusted.com.evil.com` 可绕过 → 风险-B

### 陷阱5：忽略环境判断

**错误**: 未检查 @Profile 注解
**正确**: `@Profile("test")` 限定的配置仅测试环境执行 → 安全

### 陷阱6：|| 短路逻辑绕过白名单

**错误**: `debugHost() || isWhiteListDomain(origin)` 同时检查了 debug 和白名单 → 安全
**正确**: `||` 是短路或 — 当 `debugHost()` 返回 true 时，`isWhiteListDomain()` 不执行，白名单被完全绕过

**分析规则**：
- `||` 连接的条件必须独立分析每个分支
- 如果任一分支可在无安全校验的情况下返回 true → 该分支是绕过路径
- 必须追溯 `debugHost()`/`isTestEnv()`/`isDebugMode()` 等函数实现，确认返回 true 的场景

```java
// 危险：|| 短路绕过
if (HostInfo.debugHost() || isWhiteListDomain(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Access-Control-Allow-Credentials", "true");
    // debugHost() 在 debug/test/KCS 容器/KWS candidate 机器上返回 true
    // → 任意 Origin 被回显 + Credentials=true → 完整 CORS 漏洞
}
```

---

## 7. 特殊风险

### allowedOriginPatterns("*") 行为

`allowedOriginPatterns("*")` 允许任意 Origin，若同时设置 `allowCredentials(true)` 则等同于 `Access-Control-Allow-Origin: *` + `credentials: include`，浏览器会拒绝此组合。但若代码中动态回显 Origin 头（而非通配符），则构成漏洞。

### null Origin 风险

部分浏览器在 iframe sandbox 或本地文件请求时发送 `Origin: null`。若 CORS 配置允许 null Origin，则沙箱 iframe 中的恶意页面可绕过 CORS 限制。

---

## 8. 变更影响分析

| 变更类型 | 变更内容 | 风险 |
|----------|----------|------|
| 新增 | 新增 @CrossOrigin/CorsFilter/CorsConfiguration | 确认 Credentials + Origin 配置 |
| 修改 | 移除白名单校验 | 扩大攻击面 |
| 修改 | 静态域名改为通配符 | 从安全变为不安全 |
| 修改 | 添加 allowCredentials(true) | 从安全变为不安全 |
| 修改 | contains 改为 endsWith | 防护变弱 |
| 删除 | 删除白名单校验/环境判断 | 移除防护 |

## 9. 质量门禁（强制执行）

在输出审计结论前，按顺序验证：

- [ ] 强制执行顺序已遵守（先检查 Credentials 和 Origin 设置方式）
- [ ] Credentials=false/null 直接终止
- [ ] 框架自动解析规则已正确区分（Spring vs 手动 setHeader）
- [ ] 白名单校验函数已读取实现
- [ ] HTTP 入口可达性已确认，非假设
- [ ] 结论与证据一致，代码行号可追溯
- [ ] 白名单校验的逻辑条件已分析（|| 短路绕过风险，每个分支独立分析）

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**
