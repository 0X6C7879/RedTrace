# 开放重定向

## 0. 黄金法则

> **漏洞存在性判断 优先于 防护有效性判断**
>
> 仅 path/query 可控 = 无 开放重定向（这是漏洞本质判断，不是防护有效判断）
>
> 满足此条件时：立即终止分析，无需检查任何防护措施。

**强制执行顺序**：
1. **首先**：找到 sink 点重定向代码（如 `sendRedirect()`, `redirect:`）
2. **然后**：执行 URL 结构拆解，判断用户输入位置
3. **仅当** Host/Scheme 可控时，才继续检查防护措施
4. **禁止**：一上来就检查"有没有白名单"、"A 有 B 没有"

---

## 1. 结论判断标准

| 结论 | 定义 | 判定条件 |
|------|------|----------|
| **漏洞** | 用户输入可到达重定向点，Host/Scheme 可控且无有效防护 | 重定向调用 + Host/Scheme 可控 + HTTP 入口可达 + 无有效防护 |
| **风险-A** | 重定向存在但无 HTTP/gRPC 入口可达 | 重定向调用 + 无外部入口 |
| **风险-B** | 重定向有入口可达，但防护不充分 | 重定向调用 + HTTP 入口 + 弱防护（仅协议白名单/endsWith/contains） |
| **安全** | 无危险写法，或有充分防护 | 仅 path/query 可控 / 白名单 / 域名校验 / SDK 保护 / 相对路径限制 / gRPC 网关注入 / Kconf 配置 |

---

## 2. 研判思路

### 2.1 Sink 点与 URL 结构拆解（第一优先级）

| Sink 点 | 危险级别 |
|---------|----------|
| `redirect:` + 用户输入 | 高 |
| `HttpServletResponse.sendRedirect(url)` | 高 |
| `ResponseEntity.status(302).location(URI.create(url))` | 高 |
| `response.setHeader("Location", url)` | 高 |

找到 sink 点后，将 URL 拆解为 `Scheme + Host + Port + Path + Query + Fragment`：

| 用户输入位置 | 代码示例 | 结论 |
|------------|----------|------|
| 仅在 Path | `"redirect:" + BASE_URL + path`（BASE_URL 含 scheme://host） | 安全（终止） |
| 仅在 Query | `"redirect:" + BASE_URL + "?id=" + input` | 安全（终止） |
| Host 部分 | `"https://" + input + "/api"` | 需继续研判 |
| 完整 URL | `"redirect:" + input` | 需继续研判 |

**常见拼接模式**：

```
危险模式（Host/Scheme 可控）：
- "redirect:" + user_input
- "redirect:https://" + user_input + "/api"
- new URL(user_input)
- UriComponentsBuilder.fromUriString(user_input)

安全模式（仅 Path 可控）：
- "redirect:" + BASE_URL + user_input  （需确认 BASE_URL 含完整 scheme://host）
- ServletUriComponentsBuilder.fromCurrentContextPath().path(user_input)
```

**误报预警**：`url = BASE_URL + user_input` 务必确认 BASE_URL 是否含完整前缀。若 BASE_URL = `"https://"` 则 user_input 控制 host。

### 2.2 研判流程

```
Step 1: URL 结构拆解 【终止点】
  ├─ 仅 path/query 可控？ → 安全（终止）
  └─ Host/Scheme 可控 → 继续

Step 2: SDK / Kconf 检查 【终止点】
  ├─ UrlRedirectChecker 校验 / Kconf 配置来源？ → 安全（终止）
  └─ 无 → 继续

Step 3: 白名单检查 【终止点】
  ├─ 完整 URL 白名单 / 域名白名单（getHost 检查）？ → 安全（终止）
  └─ 无白名单 → 继续

Step 4: 相对路径检查 【终止点】
  ├─ 限制为相对路径（startsWith("/")）？ → 安全（终止）
  └─ 允许绝对路径 → 继续

Step 5: 防护强度检查
  ├─ 仅协议白名单 / endsWith / contains 弱验证？ → 风险-B
  └─ 无防护 → 继续

Step 6: HTTP 入口可达性 【终止点】
  ├─ 无 HTTP/gRPC 入口？ → 风险-A
  └─ 有 HTTP/gRPC 入口 → 漏洞
```

### 2.3 降级条件表

| 条件 | 原结论 | 降级后 |
|------|--------|--------|
| 仅 path/query 可控 | 漏洞 | 安全 |
| 完整白名单 / 域名白名单 + getHost | 漏洞 | 安全 |
| SDK 保护（UrlRedirectChecker） | 漏洞 | 安全 |
| 相对路径限制 | 漏洞 | 安全 |
| gRPC 网关注入 / Kconf 配置 | 漏洞 | 安全 |
| 非线上环境 | 漏洞 | 安全 |
| 仅协议白名单 / endsWith / contains | 漏洞 | 风险-B |
| 无 HTTP 入口可达 | 漏洞 | 风险-A |

### 2.4 总结判定表

| 检查项 | 结论 |
|--------|------|
| 仅 path/query 可控（BASE_URL 含完整 scheme://host） | 安全 |
| 白名单 / 域名校验 / SDK 保护 / 相对路径限制 | 安全 |
| Host/Scheme 可控 + 无防护 + HTTP 入口 | 漏洞 |
| Host/Scheme 可控 + 弱防护（协议/endsWith/contains） | 风险-B |
| 无 HTTP/gRPC 入口 | 风险-A |

---

## 3. 常见漏洞/风险场景

### 漏洞

```java
// 直接重定向用户输入
return "redirect:" + url;  // 漏洞
response.sendRedirect(url);  // 漏洞
ResponseEntity.status(302).location(URI.create(url)).build();  // 漏洞

// 子域名可控
return "redirect:https://" + tenant + ".example.com";  // 漏洞
```

### 风险-B（防护不足）

```java
// 仅协议校验
if (url.startsWith("https://")) return "redirect:" + url;  // 风险-B

// endsWith 匹配（可被 evil.com.example.com 绕过）
if (goto.endsWith(".example.com")) return "redirect:" + goto;  // 风险-B

// contains 子串匹配（可被 evil.com?example.com 绕过）
if (url.contains("example.com")) return "redirect:" + url;  // 风险-B
```

---

## 4. 常见防御模式

### 白名单 / 域名校验

```java
// 完整 URL 白名单
if (ALLOWED_REDIRECTS.contains(url)) return "redirect:" + url;

// 域名白名单
if (ALLOWED_DOMAINS.contains(URI.create(url).getHost())) return "redirect:" + url;
```

### SDK 保护 / 相对路径限制 / Map 映射 / Kconf 配置 / gRPC 网关注入

```java
// SDK 保护
if (UrlRedirectChecker.checkRedirect(url)) return "redirect:" + url;

// 相对路径限制
if (path.startsWith("/")) return "redirect:" + path;

// Map 映射
String target = REDIRECT_MAP.getOrDefault(page, "/home");

// Kconf 配置
return "redirect:" + kconf.getString("redirect.url");

// ServletUriComponentsBuilder（基于当前 context path）
return ServletUriComponentsBuilder.fromCurrentContextPath().path(next).build().toUriString();
```

---

## 5. 检索技巧

> HTTP 入口可达性检索：详见 [Java 通用检索技巧](java-common-retrieval.md#http-入口可达性检索)

### 搜索关键词

| 类型 | 关键词 |
|------|--------|
| 重定向 | `redirect:`, `sendRedirect`, `setHeader("Location"` |
| URL 拼接 | `"redirect:" +`, `new URL(`, `URI.create(` |
| 校验函数 | `checkRedirect`, `validateUrl`, `ALLOWED` |

### 检测命令

```bash
# 检测重定向关键词
grep -rn "redirect:\|sendRedirect\|setHeader.*Location" --include="*.java"

# 检测 URL 拼接
grep -rn "redirect:.*[+]\|sendRedirect.*[+]" --include="*.java"

# 检测白名单
grep -rn "ALLOWED.*URL\|checkRedirect" --include="*.java"
```

---

## 6. 常见误判场景

### 陷阱1：参数位置误判

**错误**: 看到 `id` 参数就认为可控
**正确**: `id` 仅用于 query 参数，若 BASE_URL 完整固定 → 安全

### 陷阱2：协议校验误判

**错误**: 看到 `url.startsWith("https://")` 就认为安全
**正确**: 协议校验不限制域名，仍可跳转到钓鱼网站 → 漏洞/风险-B

### 陷阱3：弱验证误判

**错误**: 看到 `url.contains("example.com")` 就认为安全
**正确**: contains/endsWith 可被子域名/路径绕过 → 漏洞/风险-B

### 陷阱4：先看防护，后看漏洞本质

**错误思路**：发现代码缺少白名单 → 发现 A 有校验 B 没有 → 判定风险
**正确思路**：先判断漏洞是否存在（URL 拆解 → 仅 path 可控 → 无开放重定向）→ 漏洞不存在时防护问题无从谈起

> 漏洞存在性判断 > 防护有效性判断。仅 path/query 可控 = 无开放重定向。

### 陷阱5：被代码对比干扰

**错误判定**：A 有白名单 B 没有 → B 有风险
**正确判定**：先看 B 漏洞是否存在（Host/Scheme 是否可控），再谈防护

> 代码不一致 ≠ 安全问题。要回答"没有这个校验会导致什么漏洞"。

---

## 7. 特殊风险

### 相对路径 // 绕过

仅检查 `startsWith("/")` 限制相对路径时，`//evil.com` 可绕过——浏览器会将 `//evil.com` 解析为协议相对 URL，跳转到 `evil.com`。需额外排除 `//` 开头：`path.startsWith("/") && !path.startsWith("//")`。

---

## 8. 变更影响分析

| 变更类型 | 变更内容 | 风险 |
|----------|----------|------|
| 新增 | 新增 `redirect:` / `sendRedirect` 调用 | 确认 URL 构造方式，Host/Scheme 是否可控 |
| 新增 | 新增用户可控 URL 参数 | 数据流追踪 |
| 修改 | 移除白名单 / SDK 校验 | 移除防护 |
| 修改 | 改用不完整前缀拼接 | Host 变为可控 |
| 修改 | 移除环境判断 | 代码可能在线上执行 |
| 删除 | 删除域名白名单 / 相对路径限制 | 移除防护 |

---

## 9. 质量门禁（强制执行）

在输出审计结论前，按顺序验证：

- [ ] 强制执行顺序已遵守（先 URL 结构拆解，后防护检查）
- [ ] 仅 path/query 可控时已正确终止（无需检查防护）
- [ ] HTTP 入口可达性已确认，非假设
- [ ] gRPC 参数来源已正确识别（网关注入 vs 用户输入）
- [ ] 结论与证据一致，代码行号可追溯
- [ ] 已应用误报排除规则（协议校验 ≠ 安全、contains/endsWith 可绕过）
- [ ] 不因代码对比而判定风险

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**
