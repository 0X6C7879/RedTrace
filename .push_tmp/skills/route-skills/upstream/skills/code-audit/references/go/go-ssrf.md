# SSRF

## 0. 黄金法则

> **漏洞存在性判断 优先于 防护有效性判断**
>
> 仅 path/query 可控 = 无 SSRF（这是漏洞本质判断，不是防护有效判断）
>
> 满足此条件时：立即终止分析，无需检查任何防护措施。

**⚠️ "仅 path 可控"结论的前提验证**：

在断言"仅 path/query 可控 → 立即终止"之前，必须先验证前提成立：
- **字符串拼接 ≠ URL 结构拼接**：用户输入可能通过 `@`、`://`、`#` 等 URL 保留字符"溢出"到 authority（Host）部分
- 验证方法：确认固定前缀是否以 `/` 结尾

| 拼接形式 | 前缀示例 | @ 注入风险 | 结论 |
|---------|---------|-----------|------|
| `scheme://host/` + input | `"http://api.com/"` | `/` 阻止 @ 注入 | 仅 path 可控 → 安全 |
| `scheme://host` + input | `"http://docs.internal"` | @ 可改变 Host | 需继续研判 |
| `scheme://host:port/` + input | `"http://api.com:8080/"` | `/` 阻止 @ 注入 | 仅 path 可控 → 安全 |
| `scheme://host:port` + input | `"http://api.com:8080"` | @ 可改变 Host | 需继续研判 |

**强制执行顺序**：
1. **首先**：找到 sink 点 URL 最终构造代码
2. **然后**：执行 URL 结构拆解，判断用户输入位置
3. **仅当** Host 可控时，才继续检查防护措施
4. **禁止**：一上来就检查"有没有白名单"

---

## 1. 结论判断标准

| 结论 | 定义 | 判定条件 |
|------|------|----------|
| **漏洞** | 用户输入可通过 HTTP/gRPC 到达网络请求点，Host 可控且无有效防护 | 1. 存在网络请求; 2. Host 用户可控; 3. HTTP 入口可达; 4. 无有效防护 |
| **风险-A** | 存在网络请求但无外部入口 | 1. 存在网络请求; 2. 无外部入口; 3. 非测试代码 |
| **风险-B** | 有 HTTP 入口可达，但防护不充分 | 1. 存在网络请求; 2. HTTP 入口可达; 3. 仅有弱防护 |
| **安全** | Host 不可控，或有充分防护 | 仅 path/query 可控 / 隔离代理 / 域名白名单 / URL 来自配置 |

---

## 2. 漏洞风险的研判思路

### 2.1 URL 结构拆解（第一优先级）

找到 sink 点 URL 最终构造代码，拆解为 `URL = Scheme + Host + Port + Path + Query`：

| 用户输入位置 | 代码示例 | 结论 |
|----------|----------|------|
| 仅在 Path | `url = "http://api.com/" + input` | 安全（立即终止） |
| 仅在 Query | `url = "http://api.com/api?id=" + input` | 安全（立即终止） |
| Host 部分 | `url = "http://" + input + "/api"` | 需继续研判 |
| 完整 URL | `url = input` 或 `url.Parse(input)` | 需继续研判 |

> SSRF 核心是"用户能否控制请求目标 Host"，Host 不可控则 SSRF 不存在。

**常见拼接模式**：

```
危险（Host 可控）：
- url = "http://" + user_input + "/api"
- url = user_input + "/api/v1"

安全（仅 Path 可控）— 需验证固定前缀以 / 结尾：
- url = "http://fixed.host.com/" + c.Query("path")  ← ✅ 前缀以 / 结尾，@ 注入不可行
- url = baseURL + "/" + c.Query("path")              ← ✅ 需确认 baseURL 含 scheme://host/ 形式

⚠️ 需进一步研判（看似仅 Path 可控，但前缀不以 / 结尾）：
- url = "http://docs.internal" + c.Query("path")     ← ❌ 无 /，input = "@evil.com" 可改变 Host
- url = BASE_URL + c.Query("path")                    ← ❌ 需确认 BASE_URL 是否以 / 结尾
```

### 2.2 研判流程

```
Step 1: 环境检查
  ├─ 非线上环境？ → 安全
  └─ 线上环境 → 继续

Step 2: URL 结构拆解
  ├─ 仅 path/query 可控？ → 安全
  └─ Host 可控 → 继续

Step 3: 隔离代理检查
  ├─ 代理名称含 anti/ssrf？ → 安全
  └─ 普通代理/无代理 → 继续

Step 4: URL/Host 来源检查
  ├─ 来自 Viper/环境变量/数据库？ → 安全
  └─ 用户直接输入 → 继续

Step 5: 内网 IP 检测
  ├─ 有 IsLoopback/IsPrivate 检测？ →  不能直接判安全，进入防护完整性验证（见第4节）
  └─ 无检测 → 继续

Step 6: 白名单检查
  ├─ 域名白名单（精确匹配）？ → 安全
  ├─ 白名单但 HasPrefix/Contains？ → 漏洞（可绕过）
  └─ 无白名单 → 继续

Step 7: HTTP 入口可达性
  ├─ 无 HTTP/gRPC 入口？ → 风险-A
  └─ 有入口 → 漏洞
```

### 2.3 降级条件表

| 条件 | 原结论 | 降级后 |
|------|--------|--------|
| 仅 path/query 可控 | 漏洞/风险 | 安全（漏洞本质判断，非降级） |
| URL 来自 Viper/环境变量/数据库 | 漏洞 | 安全 |
| Go 内网 IP 检测（防护完整性验证通过） | 漏洞 | 安全 |
| 域名白名单（精确匹配） | 漏洞/风险 | 安全 |
| 仅协议白名单 | 漏洞 | 漏洞（HTTP 本身可访问内网） |

### 2.4 总结判定表

| 检查项 | 结论 |
|--------|------|
| 仅 path/query 可控 / 隔离代理 / 域名白名单（精确匹配） | 安全 |
| Host 可控 + 无防护 | 漏洞 |
| 白名单用 HasPrefix/Contains | 漏洞（可绕过） |
| 内部方法无 HTTP 入口 | 风险-A |

---

## 3. 常见漏洞/风险场景

### 场景1：Host 拼接 / 完整 URL

```go
url := c.Query("url")                     // 完整 URL
url := "http://" + c.Query("host")        // Host 拼接
parsedURL, _ := url.Parse(c.Query("url")) // Parse 用户输入
http.Get(url)  // 漏洞：Host 用户可控
```

### 场景2：TCP SSRF

```go
net.Dial("tcp", c.Query("host")+":"+c.Query("port"))  // 漏洞
```

### 场景3：仅协议白名单（无效防护）

```go
if !strings.HasPrefix(url, "http") { return }
http.Get(url)  // 漏洞：HTTP 协议本身可访问内网
```

---

## 4. 常见防御模式

### 仅 path/query 可控

```go
url := "http://fixed.host.com/" + c.Query("path")
http.Get(url)  // 安全
```

### Viper 配置中心

```go
baseURL := viper.GetString("api.base_url")  // 如 http://internal.com
url := baseURL + "/api/" + c.Query("path")
http.Get(url)  // 安全：Host 来自配置
```

### Go 内网 IP 检测

```go
ips, _ := net.LookupIP(parsedURL.Hostname())
for _, ip := range ips {
    if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() {
        return errors.New("internal IP not allowed")
    }
}
```

发现内网 IP 检测时，必须验证以下两点，任一不通过即防护不完整：

| 验证项 | 正确实现 | 有缺陷的实现 | 绕过方式 |
|--------|----------|-------------|---------|
| DNS 解析覆盖域名 | `net.LookupIP(hostname)` 对所有输入做 DNS 解析 | `net.ParseIP(hostname)`：若输入为域名形式则返回 nil，直接放行 | 输入域名 `evil.internal.com` → ParseIP 返回 nil → 放行 → 请求时 DNS 解析到内网 IP |
| 重定向链覆盖 | `CheckRedirect` 对每个重定向目标重新执行 IP 校验 | `CheckRedirect` 仅限制次数（如 `≤3`）但不重新校验目标 IP | 请求外网 URL → 302 跳转到 `169.254.169.254` → CheckRedirect 未调用 isPrivateHost → 绕过 |

```bash
# 检查 isPrivateHost/isInternalIP 实现：使用 ParseIP 还是 LookupIP
grep -n "ParseIP\|LookupIP" {dest_file}

# 检查 CheckRedirect 配置
grep -n "CheckRedirect" {dest_file}
```

### 域名白名单（精确匹配）

```go
parsedURL, _ := url.Parse(urlStr)
if !allowedHosts[parsedURL.Host] { return errors.New("host not allowed") }
// 安全：攻击者无法控制白名单中域名的 DNS 解析
```

### 数据库查询 URL

```go
config := callbackDao.getById(callbackId)  // URL 来自数据库
http.Get(config.Url)  // 安全：管理员配置的可信 URL
```

### 内部可信服务（重定向链可信）

当 URL 重定向链经过**内部可信服务**时，重定向目标是受控的，攻击者无法利用重定向绕过 SSRF 防护。

| 服务特征 | 判定 | 说明 |
|---------|------|------|
| 内部短链服务（仅内部人员可创建映射） | 重定向目标受控 | 攻击者无法自行创建指向内网地址的短链 |
| 内部网关/代理（路由规则由内部配置） | 路由目标受控 | 目的地址由内部配置决定 |

**⚠️ 不能假设所有短链服务都是公开的**：
- 公开短链服务（bit.ly、tinyurl.com）：任何人可创建指向任意地址的短链 → 不可信
- 内部短链服务（ksurl.cn 等）：仅内部人员可创建映射 → 可信

**识别方法**：搜索域名/服务的归属文档或配置，判断是否为内部受控服务。

### 防护完整性验证（强制）

当判定"存在防护措施"时，**必须验证防护的完整性**。存在防护 ≠ 防护有效。

#### 强制检查清单

| # | 检查项 | 验证方法 | 不通过时 |
|---|--------|---------|---------|
| 1 | **重定向链路** | 搜索 redirect/CheckRedirect/followRedirects 配置 | 重定向目标不经过相同检查 → 防护不完整 |
| 2 | **DNS Rebinding** | IP 检查时机：仅一次 vs 每次请求/重定向 | 仅首次解析检查 → DNS rebinding 可绕过 |
| 3 | **域名形式放行** | 检查是否对域名形式（非 IP）的输入直接放行 | 域名直接放行 + 无二次解析 → DNS rebinding |
| 4 | **验证覆盖范围** | 确认验证函数覆盖所有代码路径 | 存在绕过验证的路径 → 防护不完整 |

```bash
# Go 重定向配置检索
grep -rn "CheckRedirect\|FollowRedirect\|NoRedirect" --include="*.go"
```

#### 判定规则

| 防护完整性 | 结论 |
|-----------|------|
| 所有检查项通过 | 安全 |
| 任一检查项不通过 | 不能直接判安全，需分析绕过可能性 |

---

## 5. 检索技巧

| 类型 | 关键词 |
|------|--------|
| HTTP 客户端 | `http.Get`, `http.Post`, `http.Client`, `http.NewRequest` |
| 网络连接 | `net.Dial`, `net.DialTimeout` |
| URL 解析 | `url.Parse`, `url.ParseRequestURI` |
| 隔离代理 | `httpAntiSsrfClient`, `antiSsrfProxiesList`, `SSRFProxy` |
| 配置来源 | `viper.GetString`, `os.Getenv` |

```bash
# 检测网络请求
grep -rn "http\.Get\|http\.Post\|http\.Client" --include="*.go"

# 检测 URL 解析
grep -rn "url\.Parse" --include="*.go"

# 检测隔离代理
grep -rn "antiSsrf\|SSRFProxy\|httpAntiSsrf" --include="*.go"
```

---

## 6. 常见误判场景

### 陷阱1：仅 path/query 可控误判为 SSRF

**错误**: 看到用户输入拼接 URL → SSRF
**正确**: Host 固定，用户仅控制 path → 安全

### 陷阱2：忽略 URL 最终构造代码

**错误**: 只看数据流流向 sink 点
**正确**: 必须回溯到 URL 构造行，分析用户输入在 URL 的哪个位置

### 陷阱3：Viper 配置 URL 误判为用户可控

**错误**: `cfg.APIBaseURL` 用户可控制
**正确**: Go 配置来自 Viper/YAML/环境变量，用户无法修改 → 安全

### 陷阱4：协议白名单误判为 SSRF 防护

**错误**: 限制为 http/https 即可防止 SSRF
**正确**: HTTP 本身可访问内网（`http://127.0.0.1:6379`）→ 仍为漏洞

### 陷阱5：startsWith 校验可绕过

**绕过方式**：
- `@` 绕过：`http://internal.com@evil.com` — HasPrefix 匹配成功，实际请求 evil.com
- 子域名绕过：`http://internal.com.evil.com` — HasPrefix 匹配成功，实际请求 evil.com

### 陷阱6：域名白名单误判为风险-B

**错误**: 要求域名白名单必须 DNS-IP 校验
**正确**: 精确匹配的域名白名单是有效防护，攻击者无法控制 DNS 解析

### 陷阱7：先看防护后看漏洞本质

**错误**: 发现缺少白名单 → SSRF 风险
**正确**: 先判断漏洞是否存在（Host 不可控 → 无 SSRF），漏洞不存在时防护问题无从谈起

### 陷阱8：被代码对比干扰

**错误**: A 服务有白名单，B 服务没有 → B 有风险
**正确**: 先看 B 的漏洞是否存在，再谈防护缺失

### 陷阱9：字符串拼接误判为仅 path 可控

**错误**: `url = "http://docs.internal" + path` → 固定 Host + path 可控 → 安全
**正确**: 前缀不以 `/` 结尾，path 可通过 `@` 注入改变 URL 语义结构

当 path = "@evil.com/xxx" 时：
  http://docs.internal@evil.com/xxx
  → docs.internal 变成 userInfo，真正 Host 是 evil.com

RFC 3986 URL 格式：`scheme://userInfo@host:port/path`
`@` 之前是 userInfo，`@` 之后才是真正的 Host。

**判定规则**：固定前缀必须以 `/` 结尾，才能确保用户输入只落在 path 位置。

### 陷阱10：内网 IP 检测存在即判安全（防护存在 ≠ 防护有效）

**错误**: 发现 `isPrivateHost`/`isInternalIP` 函数存在 → 直接判定 safe
**正确**: 必须验证防护实现的完整性，存在两类常见缺陷：

缺陷A — `net.ParseIP` 对域名形式放行：
```go
func isPrivateHost(hostname string) bool {
    ip := net.ParseIP(hostname)  //  若 hostname 是域名形式，返回 nil
    if ip == nil {
        return false  // 域名形式直接放行 → DNS Rebinding 可绕过
    }
    return ip.IsPrivate() || ip.IsLoopback()
}
```
正确实现应使用 `net.LookupIP(hostname)` 对域名做 DNS 解析后再检查 IP。

缺陷B — `CheckRedirect` 仅限制次数但不校验重定向目标 IP：
```go
httpClient := &http.Client{
    CheckRedirect: func(req *http.Request, via []*http.Request) error {
        if len(via) >= 3 {
            return errors.New("too many redirects")  //  仅限制次数，重定向目标 IP 未经 isPrivateHost 校验
        }
        return nil
    },
}
```
攻击者可先请求外网 URL，服务端 302 重定向到 `169.254.169.254`，CheckRedirect 未调用 `isPrivateHost` 导致绕过。

---

## 7. 特殊风险

### 云元数据服务

| 云平台 | 元数据端点 | 可窃取信息 |
|-------|-----------|-----------|
| AWS | http://169.254.169.254/latest/meta-data/ | IAM 凭据 |
| GCP | http://metadata.google.internal/computeMetadata/v1/ | 服务账号令牌 |
| Azure | http://169.254.169.254/metadata/identity/oauth2/token | 托管身份令牌 |
| K8s | http://kubernetes.default.svc/api/v1/ | Pod 信息、Secret |

检测：将 `169.254.169.254` 加入内网 IP 黑名单，检测 `metadata.google.internal`、`kubernetes.default.svc`。

### 协议绕过

```
file:///etc/passwd            // 本地文件读取
gopher://127.0.0.1:6379/_INFO // Redis
```

### 内网地址变体

```
http://2130706433     // = 127.0.0.1（十进制）
http://0177.0.0.1     // = 127.0.0.1（八进制）
http://0x7f.0.0.1     // = 127.0.0.1（十六进制）
http://[::1]/         // IPv6 回环
```

需检测范围：`127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16`

### 重定向链绕过

域名白名单通过后，HTTP 客户端可能跟随 302 重定向到内网。防护：使用自定义 `CheckRedirect` 禁用重定向，或使用隔离代理。

**审计要求**：当发现 IP 检测/域名白名单等防护时，必须同步检查 HTTP 客户端的重定向配置：
1. 是否跟随重定向？
2. 重定向目标是否经过相同的 IP/域名检查？
3. 如果未配置自定义重定向处理 → 默认跟随重定向 → 重定向目标可能绕过检查

---

## 8. 变更影响分析

| 变更类型 | 变更内容 | 风险 |
|----------|----------|------|
| 新增 | 新增用户可控 URL | 确认 Host 是否可控、是否有防护 |
| 新增 | 新增网络请求调用 | 追踪参数来源 |
| 修改 | 移除白名单/内网 IP 检测 | 移除防护 |
| 修改 | Host 拼接从固定改为可变 | 扩大攻击面 |
| 删除 | 删除内网 IP 检测 | 移除防护 |
| 删除 | 删除域名白名单 | 移除防护 |
| 删除 | 删除环境判断 | 可能在线上执行 |

---

## 9. 质量门禁（强制执行）

在输出审计结论前，按顺序验证：

- [ ] 强制执行顺序已遵守（先 URL 拆解判断 Host 是否可控）
- [ ] 研判流程按顺序执行，无跳过
- [ ] "仅 path/query 可控"判断前已验证固定前缀以 "/" 结尾（防止 @/:// 注入改变 Host）
- [ ] Host 不可控时直接终止（漏洞本质判断先于防护判断）
- [ ] HTTP 入口可达性已确认，非假设
- [ ] 白名单实现已检查（精确匹配 vs HasPrefix）
- [ ] 发现内网 IP 检测时，已验证：(a) 使用 LookupIP 而非 ParseIP（域名形式不放行）；(b) CheckRedirect 对重定向目标重新执行 IP 校验
- [ ] 结论与证据一致，代码行号可追溯
- [ ] 已应用误报排除规则（内网 IP/域名/localhost 不报告）
- [ ] 不因代码对比而判定风险

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**
