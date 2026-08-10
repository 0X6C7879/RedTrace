# 净化措施判定规则

判定防护措施是否有效，需区分有效防护与无效防护。

> **防护类型**：拦截型（校验失败即 return/throw 中断执行）= 有效；净化型（变换/编码为安全值）= 有效；约束型（类型/枚举/白名单）= 有效。
> **关键**：拦截型防护不需要 sink 使用校验返回值，校验不通过时执行流已中断。

---

## 有效防护识别信号

### 1. 参数化查询（最强）

| 识别信号 | 说明 |
|---------|------|
| `PreparedStatement` / `#{}` / `?` / `:param` | SQL 参数化 |
| `QueryWrapper` / `CriteriaBuilder` | ORM 条件构造器 |
| `execute(sql, params)` | 参数分离执行 |

### 2. 类型约束

| 识别信号 | 判定 |
|---------|------|
| `Integer.parseInt` / `Long.parseLong` / `NumberUtils.toInt` | 天然防护 |
| `Enum.valueOf` / `enumClass.valueOf` | 隐式白名单（不匹配抛异常） |
| `map.get(input)` 后作为固定值使用 | 白名单映射 |

### 3. 白名单校验

| 识别信号 | 判定 |
|---------|------|
| `ALLOWED_XXX.contains(input)` | 集合白名单 |
| `WHITE_LIST.get(input) != null` | Map 白名单 |
| `Arrays.binarySearch(ALLOWED, input) >= 0` | 数组白名单 |
| `enumClass.values().contains(input)` | 枚举白名单 |

**控制流判定（强制）**：遇到 `whitelist.contains()` 必须追踪后续控制流——throw/return = 强防护，仅 log = 弱防护。

**自定义拦截型函数（遇到强制读取实现）**：`hasForbid*` / `isForbidden*` / `isAllowed*` / `isSafe*` / `isZip*` / `isFileType*` / `validate*Path` / `sanitize*Path` / `checkAndBlock*`。

### 4. 编码转义

| 识别信号 | 适用场景 |
|---------|---------|
| `escapeHtml` / `escapeXml` | XSS/XXE |
| `URLEncoder.encode` | URL 参数 |
| `escapeSql` | SQL（弱） |

### 5. 框架自动转义

| 识别信号 | 判定 |
|---------|------|
| Thymeleaf `th:text="${var}"` | 安全（默认转义） |
| FreeMarker `${var}` | 安全（默认转义） |
| Thymeleaf `th:utext` | 危险（不转义） |

### 6. 自定义防护注解/AOP

| 识别信号 | 判定 |
|---------|------|
| `@.*Check` / `@.*Filter` / `@.*Validate` + 切面实现 | 需读切面实现确认 |
| `Kconf.ofBoolean("xxx", false)` 开关默认关闭 | 风险-B |
| `INJECTION_KEYWORDS` / `BLACK_LIST` 黑名单 | 风险-B |
| 仅 `log.error` 不阻断 | 风险-B |

---

## 无效防护识别信号

| 识别信号 | 无效原因 |
|---------|---------|
| `replace("..", "")` / `replaceAll("[^0-9]","")` | 编码绕过 |
| 黑名单数组 `{"..", "/"}` | 变体绕过 |
| `@Size(max=100)` / `length() < 100` / `substring(0,10)` | 长度不防注入，只防 DoS |
| 正则 `[^']+`（未锚定） | 未锚定可前后注入 |
| 客户端 JS 验证 / HTML5 属性 | 可被代理工具绕过 |

---

## 正则锚定判定

| 正则模式 | 锚定 | 判定 |
|---------|------|------|
| `^[a-zA-Z0-9_-]+$` | 是 | 强防护 |
| `^\d+$` | 是 | 强防护 |
| `[a-zA-Z]+` | 否 | 弱防护（可前后注入） |
| `.*` | 否 | 无防护 |

**规则**：锚定正则（`^...$`）+ 拦截型控制流（throw/return）= 强防护。

---

## 框架注解判定

| 注解 | 判定 |
|------|------|
| `@NotNull` / `@Size` / `@Min` / `@Max` / `@Pattern` / `@Email` / `@Valid` | **需确认处理器存在**：类上有 `@Validated` 或参数有 `@Valid`，否则不生效 |

---

## 特殊场景速查

| 场景 | 防护 | 判定 |
|------|------|------|
| SQL 字段名/ORDER BY/GROUP BY 拼接 | 白名单/枚举/Map 映射 | 需确认防护存在 |
| XSS `href`/`src` 属性 | 需 `javascript:` 过滤 | 需确认过滤 |
| SSRF 仅 path 可控 | Host 固定 | 安全 |
| SSRF 隔离代理 | 名称含 anti/ssrf | 安全 |
| SSRF 域名白名单 | 需 DNS-IP 二次校验 | 需确认 IP 校验 |

---

## 禁止的误判

| 错误判定 | 正确判定 |
|----------|----------|
| 看到注解就认为验证生效 | 必须确认处理器存在 |
| 假设校验函数有效 | 必须读取函数实现 |
| 认为长度限制防注入 | 长度限制只防 DoS |
| 认为黑名单过滤安全 | 黑名单可编码绕过 |
| 看到正则就认为安全 | 必须是锚定白名单正则 |
