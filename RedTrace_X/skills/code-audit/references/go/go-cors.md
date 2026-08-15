# CORS

## 0. 黄金法则

> **漏洞存在性判断 优先于 防护有效性判断**
>
> Credentials=false/null 或 静态特定域名 = 无 CORS 漏洞（这是漏洞本质判断，不是防护有效判断）
>
> 满足此条件时：立即终止分析，无需检查任何防护措施。

**强制执行顺序**：
1. **首先**：找到 CORS 配置代码（如 `cors.New()`, `w.Header().Set()`)
2. **然后**：分析 AllowCredentials 状态和 AllowOrigins 设置方式
3. **仅当** AllowCredentials=true 且 Origin 动态回显/通配符时，才继续检查防护措施
4. **禁止**：一上来就检查"有没有白名单"、"A 有 B 没有"

**审计限定条件**：
1. 无需考虑白名单下存在子域名的 CORS 风险（如 `HasSuffix(".company.com")` 不纳入判定）
2. 无需考虑影响部分接口的 CORS 风险（仅关注影响全量接口）
3. 非登录场景不考虑 CORS 风险

---

## 1. 结论判断标准

| 结论 | 定义 | 判定条件 |
|------|------|----------|
| **漏洞** | Credentials=true + Origin 可回显任意值 + 无有效白名单校验 + HTTP 入口可达 + 影响全量接口 | AllowCredentials=true + 动态回显/通配符 + 无严格白名单 + HTTP 入口 |
| **风险-A** | CORS 配置不安全但无 HTTP 入口可达 | AllowCredentials=true + 动态回显/通配符 + 无外部入口 |
| **风险-B** | CORS 配置有 HTTP 入口可达，但防护措施不充分 | AllowCredentials=true + 动态回显/通配符 + HasPrefix/HasSuffix 校验 |
| **无法确认** | 白名单关键代码缺失 | 白名单校验函数代码缺失（仅白名单 map 值无法感知不算缺失） |
| **安全** | 无危险配置，或有充分的有效防护 | AllowCredentials=false / 静态特定域名 / 严格白名单 / 非线上环境 |

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
Step 1: AllowCredentials 检查
  ├─ false/未设置？ → 安全（终止）
  └─ true → 继续

Step 2: AllowOrigins 设置方式检查
  ├─ 静态特定域名？ → 安全（终止）
  ├─ setHeader("*")？ → 安全（浏览器拒绝，终止）
  └─ 动态回显/通配符 → 继续

Step 3: 白名单校验检查
  ├─ map contains 严格匹配？ → 安全（终止）
  ├─ HasPrefix/HasSuffix 宽松校验？ → 风险-B
  └─ 无校验 → 继续

Step 4: HTTP 入口可达性
  ├─ 无 HTTP 入口？ → 风险-A
  └─ 有 HTTP 入口 → 漏洞
```

### 2.3 框架通配符自动解析规则

| 框架/API | 危险配置 | 实际效果 |
|---------|---------|---------|
| gin-cors | `AllowOrigins: []string{"*"}` + `AllowCredentials: true` | 解析为请求的 Origin |
| echo | `AllowOrigins: []string{"*"}` + `AllowCredentials: true` | 解析为请求的 Origin |
| rs/cors | `AllowedOrigins: []string{"*"}` + `AllowCredentials: true` | 部分版本解析 |

### 2.4 降级条件表

| 条件 | 原结论 | 降级后 |
|------|--------|--------|
| AllowCredentials=false | 漏洞 | 安全 |
| 静态特定域名 | 漏洞 | 安全 |
| 严格白名单校验 | 漏洞 | 安全 |
| 非线上环境 | 漏洞 | 安全 |
| HasPrefix/HasSuffix 宽松校验 | 漏洞 | 风险-B |
| 无 HTTP 入口可达 | 漏洞 | 风险-A |

---

## 3. 常见漏洞/风险场景

### 漏洞

```go
// gin-cors 框架自动解析
r.Use(cors.New(cors.Config{
    AllowOrigins:     []string{"*"},  // 漏洞：框架自动解析为请求 Origin
    AllowCredentials: true,
}))

// 手动动态回显
func corsMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        origin := r.Header.Get("Origin")
        w.Header().Set("Access-Control-Allow-Origin", origin)  // 漏洞：直接回显
        w.Header().Set("Access-Control-Allow-Credentials", "true")
        next.ServeHTTP(w, r)
    })
}

// echo 通配符
e.Use(middleware.CORSWithConfig(middleware.CORSConfig{
    AllowOrigins:     []string{"*"},
    AllowCredentials: true,  // 漏洞
}))
```

### 风险-A

```go
func setInternalCors(w http.ResponseWriter, origin string) {
    w.Header().Set("Access-Control-Allow-Origin", origin)
    w.Header().Set("Access-Control-Allow-Credentials", "true")
}  // 风险-A：需追踪调用方
```

### 风险-B

```go
if strings.HasPrefix(origin, "https://api.trusted.com") {
    w.Header().Set("Access-Control-Allow-Origin", origin)
    w.Header().Set("Access-Control-Allow-Credentials", "true")
}  // 风险-B：HasPrefix 可被 https://api.trusted.com.evil.com 绕过
```

---

## 4. 常见防御模式

### AllowCredentials 未启用

```go
r.Use(cors.New(cors.Config{
    AllowOrigins: []string{"*"},
    // AllowCredentials 未设置，默认 false → 安全
}))
```

### 静态特定域名

```go
r.Use(cors.New(cors.Config{
    AllowOrigins:     []string{"https://trusted1.com", "https://trusted2.com"},
    AllowCredentials: true,
}))  // 安全
```

### 严格白名单校验

```go
var allowedOrigins = map[string]bool{
    "https://trusted1.com": true,
    "https://trusted2.com": true,
}
if allowedOrigins[origin] {
    w.Header().Set("Access-Control-Allow-Origin", origin)
    w.Header().Set("Access-Control-Allow-Credentials", "true")
}  // 安全
```

---

## 5. 检索技巧

### 搜索关键词

| 类型 | 关键词 |
|------|--------|
| CORS 中间件 | `cors.New`, `middleware.CORS` |
| 响应头设置 | `Access-Control-Allow-Origin` |
| CORS 配置 | `AllowOrigins`, `AllowCredentials` |
| 白名单校验 | `isOriginAllowed`, `allowedOrigins` |

### 检测命令

```bash
grep -rn "cors.New\|middleware.CORS" --include="*.go"
grep -rn "Access-Control-Allow-Origin\|AllowCredentials\|AllowOrigins" --include="*.go"
```

---

## 6. 常见误判场景

### 陷阱1：AllowOrigins("*") 误判安全

**错误**: 看到 `*` 就认为浏览器拒绝
**正确**: gin-cors/echo 在 AllowCredentials=true 时将 `*` 自动解析为请求的 Origin → 漏洞

### 陷阱2：setHeader("*") 误判漏洞

**错误**: `w.Header().Set("Access-Control-Allow-Origin", "*")` + Credentials=true 是漏洞
**正确**: 手动 setHeader("*") 浏览器会直接拒绝 → 安全。**必须区分框架自动解析和手动设置**

### 陷阱3：白名单函数未读实现

**错误**: 看到 `isOriginAllowed(origin)` 就认为有白名单
**正确**: 必须读取实现——HasPrefix/HasSuffix → 风险-B；实现缺失 → 无法确认

### 陷阱4：宽松校验误判安全

**错误**: `HasPrefix(origin, "https://api.trusted.com")` 是有效防护
**正确**: `https://api.trusted.com.evil.com` 可绕过 → 风险-B

### 陷阱5：忽略环境判断

**错误**: 未检查环境变量
**正确**: `os.Getenv("ENV") == "dev"` 限定的配置仅测试环境 → 安全

### 陷阱6：|| 短路逻辑绕过白名单

**错误**: `isDebugHost() || isWhiteListDomain(origin)` 同时检查了 debug 和白名单 → 安全
**正确**: `||` 是短路或 — 当 `isDebugHost()` 返回 true 时，`isWhiteListDomain()` 不执行，白名单被完全绕过

**分析规则**：
- `||` 连接的条件必须独立分析每个分支
- 如果任一分支可在无安全校验的情况下返回 true → 该分支是绕过路径
- 必须追溯 `isDebugHost()`/`isTestEnv()`/`isDebugMode()` 等函数实现，确认返回 true 的场景

```go
// 危险：|| 短路绕过
if isDebugHost() || isWhiteListDomain(origin) {
    w.Header().Set("Access-Control-Allow-Origin", origin)
    w.Header().Set("Access-Control-Allow-Credentials", "true")
    // isDebugHost() 在 debug/test/KCS 容器/KWS candidate 机器上返回 true
    // → 任意 Origin 被回显 + Credentials=true → 完整 CORS 漏洞
}
```

---

## 7. 特殊风险

### null Origin 风险

部分浏览器在 iframe sandbox 或本地文件请求时发送 `Origin: null`。若 CORS 配置允许 null Origin，则沙箱 iframe 中的恶意页面可绕过 CORS 限制。

---

## 8. 变更影响分析

| 变更类型 | 变更内容 | 风险 |
|----------|----------|------|
| 新增 | 新增 cors.New/middleware.CORS 调用 | 确认 AllowOrigins + AllowCredentials |
| 修改 | 移除白名单校验 | 扩大攻击面 |
| 修改 | 静态域名改为通配符 | 从安全变为不安全 |
| 修改 | 添加 AllowCredentials(true) | 从安全变为不安全 |
| 删除 | 删除白名单校验/环境判断 | 移除防护 |

## 9. 质量门禁（强制执行）

在输出审计结论前，按顺序验证：

- [ ] 强制执行顺序已遵守（先检查 AllowCredentials 和 AllowOrigins）
- [ ] AllowCredentials=false 直接终止
- [ ] 框架自动解析规则已正确区分（gin-cors vs 手动 setHeader）
- [ ] 白名单校验函数已读取实现
- [ ] HTTP 入口可达性已确认，非假设
- [ ] 结论与证据一致，代码行号可追溯
- [ ] 白名单校验的逻辑条件已分析（|| 短路绕过风险，每个分支独立分析）

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**
