# 开放重定向

## 0. 黄金法则

> **漏洞存在性判断 优先于 防护有效性判断**
>
> 仅 path/query 可控 = 无 开放重定向（这是漏洞本质判断，不是防护有效判断）
>
> 满足此条件时：立即终止分析，无需检查任何防护措施。

**强制执行顺序**：
1. **首先**：找到 sink 点重定向代码（如 `c.Redirect()`, `http.Redirect()`）
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
| **安全** | 无危险写法，或有充分防护 | 仅 path/query 可控 / 白名单 / 域名校验 / 相对路径限制 / gRPC 网关注入 / 配置中心 |

---

## 2. 研判思路

### 2.1 Sink 点与 URL 结构拆解（第一优先级）

| Sink 点 | 危险级别 |
|---------|----------|
| `c.Redirect(userInput, code)`（gin/echo/fiber） | 高 |
| `http.Redirect(w, r, userInput, code)` | 高 |
| `w.Header().Set("Location", url)` | 高 |

找到 sink 点后，将 URL 拆解为 `Scheme + Host + Port + Path + Query + Fragment`：

| 用户输入位置 | 代码示例 | 结论 |
|------------|----------|------|
| 仅在 Path | `"https://example.com/" + input` | 安全（终止） |
| 仅在 Query | `"https://example.com/?next=" + input` | 安全（终止） |
| Host 部分 | `"https://" + input + "/api"` | 需继续研判 |
| 完整 URL | `c.Redirect(input, code)` | 需继续研判 |

**常见拼接模式**：

```
危险模式（Host/Scheme 可控）：
- c.Redirect(userInput, code)
- http.Redirect(w, r, userInput, code)
- "https://" + userInput + "/api"

安全模式（仅 Path 可控）：
- "https://fixed.com/" + userInput
- path.Join(basePath, userInput)
```

### 2.2 研判流程

```
Step 1: URL 结构拆解 【终止点】
  ├─ 仅 path/query 可控？ → 安全（终止）
  └─ Host/Scheme 可控 → 继续

Step 2: 配置中心检查 【终止点】
  ├─ URL 来自 viper/env 配置？ → 安全（终止）
  └─ 用户输入 → 继续

Step 3: 白名单检查 【终止点】
  ├─ 完整 URL 白名单 / 域名白名单（u.Host 检查）？ → 安全（终止）
  └─ 无白名单 → 继续

Step 4: 相对路径检查 【终止点】
  ├─ 限制为相对路径（HasPrefix("/")）且排除 "//"？ → 安全（终止）
  └─ 允许绝对路径 → 继续

Step 5: 防护强度检查
  ├─ 仅协议白名单 / HasSuffix / Contains 弱验证？ → 风险-B
  └─ 无防护 → 继续

Step 6: HTTP 入口可达性 【终止点】
  ├─ 无 HTTP/gRPC 入口？ → 风险-A
  └─ 有 HTTP/gRPC 入口 → 漏洞
```

### 2.3 降级条件表

| 条件 | 原结论 | 降级后 |
|------|--------|--------|
| 仅 path/query 可控 | 漏洞 | 安全 |
| 完整白名单 / 域名白名单 + url.Parse | 漏洞 | 安全 |
| 相对路径限制（排除 "//"） | 漏洞 | 安全 |
| gRPC 网关注入 / 配置中心 | 漏洞 | 安全 |
| 非线上环境 | 漏洞 | 安全 |
| 仅协议白名单 / HasSuffix / Contains | 漏洞 | 风险-B |
| 无 HTTP 入口可达 | 漏洞 | 风险-A |

### 2.4 总结判定表

| 检查项 | 结论 |
|--------|------|
| 仅 path/query 可控（BASE_URL 含完整 scheme://host） | 安全 |
| 白名单 / 域名校验 / 相对路径限制 | 安全 |
| Host/Scheme 可控 + 无防护 + HTTP 入口 | 漏洞 |
| Host/Scheme 可控 + 弱防护（协议/HasSuffix/Contains） | 风险-B |
| 无 HTTP/gRPC 入口 | 风险-A |

---

## 3. 常见漏洞/风险场景

### 漏洞

```go
// 直接重定向用户输入
c.Redirect(http.StatusFound, c.Query("url"))  // 漏洞
http.Redirect(w, r, r.URL.Query().Get("url"), http.StatusFound)  // 漏洞

// 子域名可控
url := "https://" + c.Query("tenant") + ".example.com"
c.Redirect(http.StatusFound, url)  // 漏洞

// Host 可控
url := "https://" + c.Query("host") + c.Query("path")
c.Redirect(http.StatusFound, url)  // 漏洞
```

### 风险-B（防护不足）

```go
// 仅协议校验
if strings.HasPrefix(url, "https://") { c.Redirect(http.StatusFound, url) }  // 风险-B

// HasSuffix 匹配（可被 evil.com.example.com 绕过）
if strings.HasSuffix(goto, ".example.com") { c.Redirect(http.StatusFound, goto) }  // 风险-B

// Contains 子串匹配（可被 evil.com?example.com 绕过）
if strings.Contains(url, "example.com") { c.Redirect(http.StatusFound, url) }  // 风险-B
```

---

## 4. 常见防御模式

### 域名白名单 + url.Parse

```go
var allowedDomains = map[string]bool{"example.com": true}

func isUrlAllowed(urlStr string) bool {
    u, err := url.Parse(urlStr)
    if err != nil { return false }
    return allowedDomains[u.Host]
}
```

### 相对路径限制

```go
if strings.HasPrefix(path, "/") && !strings.HasPrefix(path, "//") {
    c.Redirect(http.StatusFound, path)
}
```

### 完整 URL 白名单 / Map 映射 / 配置中心 / gRPC 网关注入

```go
// 完整 URL 白名单
if allowedURLs[url] { c.Redirect(http.StatusFound, url) }

// Map 映射
target := redirectMap[userChoice]

// 配置中心
c.Redirect(http.StatusFound, viper.GetString("app.redirect.url"))

// path.Join 规范化（URL 用 path.Join，文件路径用 filepath.Join）
joined := path.Join(base, path)
if !strings.HasPrefix(joined, base) { return base }
```

---

## 5. 检索技巧

### 搜索关键词

| 类型 | 关键词 |
|------|--------|
| 重定向 | `c.Redirect`, `http.Redirect` |
| URL 解析 | `url.Parse` |
| 域名校验 | `.Host`, `.Hostname` |
| 配置读取 | `viper.GetString`, `os.Getenv` |

### 检测命令

```bash
# 检测重定向
grep -rn "c.Redirect\|http.Redirect" --include="*.go"

# 检测 URL 解析
grep -rn "url.Parse" --include="*.go"

# 检测白名单
grep -rn "allowedDomains\|allowedOrigins" --include="*.go"
```

---

## 6. 常见误判场景

### 陷阱1：参数位置误判

**错误**: 看到参数就认为可控
**正确**: `id` 仅用于 query 参数，BASE_URL 固定 → 安全

### 陷阱2：协议校验误判

**错误**: 看到 `strings.HasPrefix(url, "https://")` 就认为安全
**正确**: 协议校验不限制域名 → 漏洞/风险-B

### 陷阱3：弱验证误判

**错误**: 看到 `strings.Contains(url, "example.com")` 就认为安全
**正确**: Contains/HasSuffix 可被绕过 → 漏洞/风险-B

### 陷阱4：先看防护，后看漏洞本质

**错误思路**：发现代码缺少白名单 → 判定风险
**正确思路**：先判断漏洞是否存在（URL 拆解 → 仅 path 可控 → 无开放重定向）

> 漏洞存在性判断 > 防护有效性判断。仅 path/query 可控 = 无开放重定向。

### 陷阱5：被代码对比干扰

**错误判定**：A 有白名单 B 没有 → B 有风险
**正确判定**：先看 B 漏洞是否存在（Host/Scheme 是否可控），再谈防护

> 代码不一致 ≠ 安全问题。

---

## 7. 特殊风险

### path.Join vs filepath.Join

处理 URL 路径时应使用 `path.Join`（使用 `/` 分隔符），而非 `filepath.Join`（使用操作系统分隔符，Windows 下为 `\`）。

---

## 8. 变更影响分析

| 变更类型 | 变更内容 | 风险 |
|----------|----------|------|
| 新增 | 新增 `c.Redirect` / `http.Redirect` 调用 | 确认 URL 构造方式 |
| 新增 | 新增用户可控 URL 参数 | 数据流追踪 |
| 修改 | 移除白名单 / 域名校验 | 移除防护 |
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
- [ ] 已应用误报排除规则（协议校验 ≠ 安全、Contains/HasSuffix 可绕过）
- [ ] 不因代码对比而判定风险

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**
