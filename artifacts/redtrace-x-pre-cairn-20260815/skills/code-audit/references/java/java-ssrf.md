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
1. **首先**：找到 sink 点 URL 最终构造代码（如 `String url = ...`）
2. **然后**：执行 URL 结构拆解，判断用户输入位置
3. **Source 实际来源验证**（强制）：URL 变量若来自 Model/DTO/JSON 字段，必须追溯字段实际写入路径——可能来自 DB 查询/Kconf/服务间调用，而非外部用户输入。详见 references/common/trusted-sources.md §6（跨接口数据流）
4. **仅当** Host 可控**且**实际来源为外部输入时，才继续检查防护措施
5. **发现拦截型校验（校验失败即 throw/return）时**：立即应用 false-positive-filtering.md §3.7，判定 safe，无需继续分析绕过可能性
6. **发现白名单来自 Kconf/配置中心时**：立即应用 false-positive-filtering.md §3.1，判定 safe
7. **禁止**：一上来就检查"有没有白名单"；发现 startsWith 白名单即判漏洞，未先确认白名单来源；**未追溯 source 实际来源即假设用户可控**

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

找到 sink 点 URL 最终构造的那一行代码，拆解为 `URL = Scheme + Host + Port + Path + Query`：

| 用户输入位置 | 代码示例 | 结论 |
|----------|----------|------|
| 仅在 Path | `url = "http://api.com/" + input` | 安全（立即终止） |
| 仅在 Query，且参数用于本服务逻辑（过滤/查询/标识） | `url = "http://api.com/api?id=" + input` | 安全（立即终止） |
| 仅在 Query，但参数被下游代理服务用于访问外部 URL | `url = "http://proxy.com/api?targetUrl=" + input` | 需继续研判（代理型 SSRF） |
| Host 部分 | `url = "http://" + input + "/api"` | 需继续研判 |
| 完整 URL | `url = input` 或 `new URL(input)` | 需继续研判 |

> SSRF 核心是"用户能否控制请求目标 Host"，Host 不可控则 SSRF 不存在。
> **例外**：参数名为 `url/targetUrl/figmaUrl/imageUrl/fileUrl` 等暗示外部访问的字段，且目标为代理服务（路径含 `/proxy/`、`/rest/xxx-api/`、`/gateway/` 等），需判断下游服务是否会以该参数为目标发起网络请求，若是则视为 Host 可控。
> **代理型 SSRF 判定原则**：命中代理服务特征时，若无法在代码中找到下游服务具有域名白名单/IP 检测等 SSRF 防护的证据，应判定为漏洞；不得以"下游服务可信"为由推翻此结论。

**常见拼接模式**：

```
危险（Host 可控）：
- url = "http://" + user_input + "/api"
- url = user_input + "/api/v1"

安全（仅 Path 可控）— 需验证固定前缀以 / 结尾：
- url = "http://fixed.com/" + user_input          ← ✅ 前缀以 / 结尾，@ 注入不可行
- url = baseUrl + "/" + user_input                ← ✅ 需确认 baseUrl 含 scheme://host/ 形式

⚠️ 需进一步研判（看似仅 Path 可控，但前缀不以 / 结尾）：
- url = "http://docs.internal" + user_input       ← ❌ 无 /，input = "@evil.com" 可改变 Host
- url = BASE_URL + user_input                     ← ❌ 需确认 BASE_URL 是否以 / 结尾
```

### 2.2 研判流程

```
Step 0: 数据流连通性预验证（必须在所有其他步骤之前执行）
  ├─ 读取 Source 类定义，确认是否存在 URL 相关字段
  │     └─ Source 类无 URL 字段 → 数据流在源头断裂，判定 safe（立即终止，不得继续后续步骤）
  ├─ 追踪 full_call_stack 中关键中间变量的实际赋值
  │     └─ URL 相关变量被硬编码赋值（非用户输入）→ 数据流断裂，判定 safe（立即终止，不得继续后续步骤）
  └─ 验证 full_call_stack 各节点是否属于同一调用链
        └─ Source 所在方法与 sink 所在方法无实际调用关系（路径为不相关路径拼接）→ 数据流断裂，判定 safe（立即终止，不得继续后续步骤）

Step 1: 环境检查
  ├─ 非线上环境？ → 安全
  └─ 线上环境 → 继续

Step 2: URL 结构拆解
  ├─ 仅 path/query 可控？ → 安全
  └─ Host 可控 → 继续

Step 2.5: sink 分支触发条件验证（详见 false-positive-filtering.md §3.9）
  ├─ 存在安全分支提前 return，且危险分支需特定输入触发？→ 应用 §3.9 判定
  └─ sink 无条件可达 → 继续

Step 3: 隔离代理检查（完整流程见 references/common/ssrf-proxy.md）
  ├─ 是隔离代理？ → 安全
  └─ 不是隔离代理 → 继续

Step 4: SSRFChecker 检查
  ├─ 无 SSRFChecker → 继续
  ├─ SSRFChecker 有效阻断？ → 安全
  └─ SSRFChecker 被开关控制 → 按陷阱11判定（区分 Kconf 注入 vs 硬编码）

Step 5: URL/Host 来源检查
  ├─ 来自 Kconf/数据库/枚举/硬编码？ → 安全
  └─ 用户直接输入 → 继续

Step 6: 内网 IP 检测
  ├─ 有 IP 私有地址检测？ → 安全
  └─ 无检测 → 继续

Step 7: 域名白名单检查
  ├─ 域名白名单（精确匹配）？ → 安全
  ├─ 白名单来自 Kconf/数据库/配置中心，且校验失败即 throw/return（拦截型）？ → 应用 false-positive-filtering.md §3.1 + §3.7 → 安全
  ├─ 白名单使用 endsWith/startsWith，必须分析域名归属：
  │     ├─ 白名单域名为内网命名空间（如 *.internal、*.corp.kuaishou.com 等公司专属域名）→ 攻击者无法注册该命名空间下的域名 → 安全
  │     └─ 白名单域名为公网可注册域名（如 api.com）→ 攻击者可注册 evil.api.com → 漏洞（可绕过）
  └─ 无白名单 → 继续

Step 8: HTTP 入口可达性
  ├─ 无 HTTP/gRPC 入口？ → 风险-A
  └─ 有入口 → 漏洞
```

### 2.3 降级条件表

| 条件 | 原结论 | 降级后 |
|------|--------|--------|
| 仅 path/query 可控 | 漏洞/风险 | 安全（漏洞本质判断，非降级） |
| 隔离代理 / SSRFChecker 阻断 | 漏洞/风险 | 安全 |
| URL 来自 Kconf/数据库/枚举/硬编码 | 漏洞 | 安全 |
| 域名白名单（精确匹配） | 漏洞/风险 | 安全 |
| 白名单 endsWith/startsWith 内网命名空间域名（如 *.corp.kuaishou.com） | 漏洞/风险 | 安全（攻击者无法注册该命名空间） |
| 仅协议白名单 / startsWith/contains 公网可注册域名 | 漏洞 | 漏洞（HTTP 本身可访问内网 / 可绕过） |

### 2.4 总结判定表

| 检查项 | 结论 |
|--------|------|
| 仅 path/query 可控 / 隔离代理 / 域名白名单（精确匹配） / endsWith 内网命名空间域名 | 安全 |
| Host 可控 + 无防护 | 漏洞 |
| 白名单用 startsWith/contains 公网可注册域名 | 漏洞（可绕过） |
| 内部方法无 HTTP 入口 | 风险-A |

---

## 3. 常见漏洞/风险场景

### 场景1：Host 拼接 / 完整 URL

```java
restTemplate.getForObject(url, String.class);           // 完整 URL
String url = "http://" + host + "/api";                  // Host 拼接
new URL(uri).openConnection();                            // URI 用户输入
```

### 场景2：仅协议白名单（无效防护）

```java
URL u = new URL(url);
if (!"http".equalsIgnoreCase(u.getProtocol())) throw ...;
// HTTP/HTTPS 本身可访问内网 → 漏洞
```

### 场景3：风险-B（防护不足）

```java
if (url.startsWith("http://internal.com")) {
    fetch(url);  // startsWith 可被绕过 → 风险-B
}
```

### 场景4：移除/替换隔离代理

```java
// 修改前：httpAntiSsrfClient（隔离代理）
// 修改后：httpClient（普通代理）→ 漏洞

ksHttpProxy.get(url);  // 名称不含 anti → 漏洞
```

---

## 4. 常见防御模式

### 仅 path/query 可控

```java
String url = "http://fixed.host.com/" + path;  // Host 固定 → 安全

// 常见模式：endpoint 仅控制 path
String queryUrl = getBaseUrl() + getApiEndpoint(endpoint) + "/" + taskId;
// getBaseUrl() 返回 "http://llm-gateway.internal/" → endpoint 仅控制 path → 安全
```

### 隔离代理

```java
@Autowired private HttpClient httpAntiSsrfClient;  // 名称含 anti/ssrf → 安全
```

### SSRFChecker SDK

```java
if (!SSRFChecker.check(url)) throw ...;  // 公司统一防护 → 安全
```

### 域名白名单（精确匹配）

```java
if (!ALLOWED_HOSTS.contains(u.getHost())) throw ...;  // 精确匹配 → 安全
```

### Host 来自配置/数据库

```java
@Value("${api.external.url}") private String externalUrl;  // Kconf/配置 → 安全

// 二次注入场景：用户输入 ID，系统查库后请求
CallbackConfig config = callbackDao.getById(id);
restTemplate.getForObject(config.getUrl(), ...);  // URL 来自数据库 → 安全
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

### 防护优先级

| 优先级 | 防护方案 | 说明 | 判定影响 |
|--------|----------|------|----------|
| 1（最强） | 隔离代理 | 代理名称含 `anti`/`ssrf` | 安全（立即终止） |
| 2 | SSRFChecker SDK | 公司统一防护工具 | 安全 |
| 3 | 域名白名单（精确匹配） | 攻击者无法控制 DNS 解析 | 安全 |
| 4（较弱） | startsWith/contains | 易被绕过 | 通常为漏洞 |

**隔离代理识别规则**：名称包含 `anti` 或 `ssrf`（不区分大小写），或配置溯源到 `antiSsrfProxiesList`，均为隔离代理；其他代理名称需执行配置溯源+历史记录核查（详见 references/common/ssrf-proxy.md）。

### 防护完整性验证（强制）

当判定"存在防护措施"时，**必须按顺序执行以下检查**。

#### 强制检查清单

| # | 检查项 | 验证方法 | 不通过时 |
|---|--------|---------|---------|
| 0 | **误报排除规则前置检查** | 确认是否命中 false-positive-filtering.md §3.1（配置中心白名单）或 §3.7（拦截型校验）；命中任一则直接判定 safe，不再执行后续检查项 | 未命中 → 继续 |
| 1 | **关联校验器搜索** | 以 source 参数名、URL 字段名为关键词搜索项目中的 Validator/Checker/Filter 类；存在则必须读取其实现，判断是否为有效防护 | 遗漏域名白名单/参数校验类 → 误判为无防护 |
| 2 | **重定向链路** | 搜索 CheckRedirect/followRedirects/redirect 配置 | 重定向目标不经过相同检查 → 防护不完整 |
| 3 | **DNS Rebinding** | IP 检查时机：仅一次 vs 每次请求/重定向 | 仅首次解析检查 → DNS rebinding 可绕过 |
| 4 | **域名形式放行** | 检查是否对域名形式（非 IP）的输入直接放行 | 域名直接放行 + 无二次解析 → DNS rebinding |
| 5 | **验证覆盖范围** | 确认验证函数覆盖所有代码路径 | 存在绕过验证的路径 → 防护不完整 |

#### 判定规则

| 防护完整性 | 结论 |
|-----------|------|
| 所有检查项通过 | 安全 |
| 任一检查项不通过 | 不能直接判安全，需分析绕过可能性 |

#### 代码检索

```bash
# 检查重定向配置
grep -rn "CheckRedirect\|followRedirects\|setRedirectEnabled" --include="*.java"
# 检查 IP 验证是否只在入口处做一次
grep -rn "isPrivateHost\|isInternalIP" --include="*.java"
```

---

## 5. 检索技巧

> HTTP 入口可达性检索：详见 [Java 通用检索技巧](java-common-retrieval.md#http-入口可达性检索)

| 类型 | 关键词 |
|------|--------|
| HTTP 客户端 | `HttpClient`, `RestTemplate`, `OkHttp`, `WebClient` |
| 网络方法 | `execute(`, `exchange(`, `newCall`, `openConnection`, `openStream` |
| URL 构造 | `new URL(`, `URI.create(`, `"http://" +` |
| 隔离代理 | `httpAntiSsrfClient`, `antiSsrfProxiesList`, `SSRFProxy` |
| 校验函数 | `SSRFChecker`, `ALLOWED_HOSTS`, `WHITE_LIST` |
| 配置来源 | `@Value`, `Kconf`, `kswitch` |
| 多媒体处理 | `FFprobe.probe(`, `FFmpeg.parse(` |

**关键 Sink 点**：

| 方法 | 危险级别 |
|------|----------|
| `HttpClient.execute(HttpUriRequest)` | 高 |
| `RestTemplate.getForObject(url, ...)` | 高 |
| `OkHttpClient.newCall(Request)` | 高 |
| `new URL(input).openConnection()` | 高 |
| `WebClient.uri(userInput)` | 高 |
| `URI.create(input).toURL()` | 高 |
| `Jsoup.connect(url)` | 中 |
| `ImageIO.read(URL)` | 中 |
| `FFprobe.probe(url)` | 中 |

```bash
# 检测网络请求
grep -rn "HttpClient\|RestTemplate\|OkHttp\|WebClient" --include="*.java"

# 检测隔离代理
grep -rn -i "anti.*ssrf\|ssrf.*client" --include="*.java"

# 检测 SSRFChecker
grep -rn "SSRFChecker" --include="*.java"

# 检测白名单校验
grep -rn "ALLOWED_HOSTS\|WHITE_LIST\|startsWith" --include="*.java"
```

---

## 6. 常见误判场景

### 陷阱1：协议白名单误判

**错误**: http/https 白名单就能防 SSRF
**正确**: HTTP 本身可访问内网 → 漏洞/风险-B

### 陷阱2：path 可控误判

**错误**: 拼接 URL 就判 SSRF
**正确**: `"http://fixed.com/" + path` → host 固定 → 安全

### 陷阱3：忽略 URL 最终构造

**错误**: 只看 sink 点，不回溯 URL 构造
**正确**: 必须分析 `String url = ...` 那一行，确定用户输入位置

### 陷阱4：代理名称不含 anti

**错误**: `ksHttpProxy` 就有 SSRF 防护
**正确**: 仅名称含 `anti`/`ssrf` 或配置溯源到 `antiSsrfProxiesList` 才是隔离代理；其他代理需按 ssrf-proxy.md 完整流程判定（配置溯源 + 历史记录核查）

### 陷阱5：startsWith 可绕过

- `@` 绕过：`http://internal.com@evil.com` — startsWith 匹配成功，实际请求 evil.com
- 子域名绕过：`http://internal.com.evil.com` — startsWith 匹配成功，实际请求 evil.com

### 陷阱6：IP 进制绕过

`http://2130706433` = `127.0.0.1`（十进制），点分十进制检测不够

### 陷阱7：域名白名单误判为风险-B

**错误**: 域名白名单需要额外 DNS-IP 校验
**正确**: 精确匹配的域名白名单是有效防护，攻击者无法控制 DNS 解析

### 陷阱8：先看防护后看漏洞本质

**错误**: 发现缺少白名单 → SSRF 风险
**正确**: 先判断漏洞是否存在（Host 不可控 → 无 SSRF），漏洞不存在时防护问题无从谈起

### 陷阱9：被代码对比干扰

**错误**: A 有白名单，B 没有 → B 有风险
**正确**: 先看 B 的漏洞是否存在，再谈防护缺失

### 陷阱10：字符串拼接误判为仅 path 可控

**错误**: `url = "http://docs.internal" + path` → 固定 Host + path 可控 → 安全
**正确**: 前缀不以 `/` 结尾，path 可通过 `@` 注入改变 URL 语义结构

当 path = "@evil.com/xxx" 时：
  http://docs.internal@evil.com/xxx
  → docs.internal 变成 userInfo，真正 Host 是 evil.com

RFC 3986 URL 格式：`scheme://userInfo@host:port/path`
`@` 之前是 userInfo，`@` 之后才是真正的 Host。

**判定规则**：固定前缀必须以 `/` 结尾，才能确保用户输入只落在 path 位置。

### 陷阱11：防护被 Kconf 开关控制时假设默认值

**错误**: 发现 SSRFChecker 被 Kconf 开关控制，读取到 Java 默认值为 false → 判定防护关闭 → vulnerability
**正确**: Kconf 注入的开关，Java 默认值仅为占位符，运行时值由 Kconf 配置决定，不得以默认值判断防护状态；应结合历史记录判定；仅硬编码开关（无注入）才以读取到的值为准，且必须用 `grep -n` 精确定位行号，禁止估算

### 陷阱12：未搜索与 source 参数关联的 Validator/Checker 类

**错误**: 在数据流路径附近未发现明显防护代码，直接判定"无域名白名单/无有效防护" → vulnerability
**正确**: 判定"无防护"之前，必须以 source 参数名、URL 字段名为关键词搜索项目中的 Validator/Checker/Filter 类（如搜索 `cdnUrl`、`CdnUrl`）；发现关联校验类后必须读取其实现，确认是否构成有效防护，再输出结论

### 陷阱13：直接信任 CodeQL 数据流，不验证 Source 类字段和中间变量赋值

**错误**: 看到 CodeQL 报告的 full_call_stack 链路，直接沿链路分析防护措施，不验证数据流是否真实连通
**正确**: 在分析防护措施之前，必须先验证以下两点；任一不满足则数据流在该处断裂，直接判定 safe：
1. 读取 Source 类定义，确认类中是否存在 URL 相关字段；若 Source 类只有非 URL 字段（如 taskId、queries），用户输入根本无法携带 URL 进入链路
2. 追踪中间变量的实际赋值，确认用户输入是否可控；若关键变量（如 csvPath）在链路中被硬编码赋值，则用户无法控制该变量

### 陷阱14：代码允许 http/https 就判漏洞，忽略分支触发条件

**错误**: 看到代码中存在 HTTP 请求分支，直接判定 Host 用户可控 → 漏洞；未分析该分支是否在业务场景中实际可被触发
**正确**: 若代码同时存在提前 return 的安全分支（如 `data:` 协议处理后 return），且历史记录或业务文档表明实际只走安全分支，按 false-positive-filtering.md §3.9 判定

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

### Kafka 异步链路

Pattern: `[HTTP Controller] → [Kafka] → [Consumer] → [HTTP Client]`
- Kafka Topic 为内部通信 → **风险-A**（无直接 HTTP 入口）
- Consumer 有独立入口点 → 需单独分析 Consumer 的入口可达性

### 重定向链绕过

域名白名单通过后，HTTP 客户端可能跟随 302 重定向到内网。防护：`HttpClient.setRedirectHandler(NoRedirectHandler.INSTANCE)` 禁用重定向，或使用隔离代理。

**审计要求**：当发现 IP 检测/域名白名单等防护时，必须同步检查 HTTP 客户端的重定向配置：
1. 是否跟随重定向？
2. 重定向目标是否经过相同的 IP/域名检查？
3. 如果未配置自定义 CheckRedirect → 默认跟随重定向 → 重定向目标可能绕过检查

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

## 10. 业务场景分析（常见系统补全字段与误报预防）

### 10.1 核心概念：代码层可控 vs 运行时可控

SSRF 审计中超过一半的误报源于**混淆了"代码层可控"与"运行时可控"**：

| 维度 | 代码层可控 | 运行时可控 |
|------|-----------|-----------|
| 定义 | 字段声明在 @RequestBody DTO 中，形式上可被用户传入 | 用户在业务流程中实际传入该字段 |
| 判断依据 | CodeQL 数据流标记 + 类型声明 | 业务层限制：是否由系统补全、是否非必填、是否仅在响应中 |
| 典型误报 | Map<String,String> 在 DTO 中 → 判定用户可控 | 实际由系统服务补全，用户不传入 |

### 10.2 常见业务补全字段列表

以下字段为**系统自动补全字段**，用户在实际请求中不传入：

| 字段名 | 补全服务/场景 | 安全分析结论 |
|--------|-------------|------------|
| `cover_url` / `coverUrlMap` | 视频服务（VideoApiClient/PhotoInfoFacade）批量补全 | 用户不传入，运行时不可控 |
| `video_url` / `videoPlayUrl` | VOD 服务补全 | 用户不传入，运行时不可控 |
| `asr_text` / `asrResult` | ASR 语音识别服务补全 | 用户不传入，运行时不可控 |
| `author_name` / `userName` | 用户信息服务补全 | 用户不传入，运行时不可控 |
| `photo_url` | 照片/图片服务补全 | 用户不传入，运行时不可控 |
| `avatar_url` | 用户头像服务补全 | 用户不传入，运行时不可控 |
| `thumbnail_url` | 缩略图服务补全 | 用户不传入，运行时不可控 |
| `audio_url` / `music_url` | 音频/音乐服务补全 | 用户不传入，运行时不可控 |

### 10.3 业务补全字段识别流程

当 source 来源为 Map<String, String> 等集合类型时，**必须执行以下分析**：

```
确定字段在 DTO/Controller 中的声明
    │
    ├─ 搜索字段名在项目中的引用
    │   grep -rn "字段名\|fieldName" --include="*.java"
    │   │
    │   ├─ 找到系统补全服务调用（VideoApiClient/VOD/ASR等）
    │   │   └─ ✅ 系统补全字段，用户不传入 → safe
    │   │
    │   ├─ 字段仅在响应 DTO 中（@JsonProperty 在响应类中）
    │   │   └─ ✅ 用户无法传入 → safe
    │   │
    │   ├─ 字段由 DB 查询填充（Dao/Mapper/Repository）
    │   │   └─ ✅ 可信数据源 → safe
    │   │
    │   └─ 未找到系统补全证据 → 按正常 SSRF 流程分析
    │
    └─ 搜索调用方是否传入该字段
        grep -rn "set字段名\|put(\"字段名" --include="*.java"
        │
        ├─ 调用方未赋值 → 运行时值为空
        └─ 调用方有赋值 → 追溯赋值来源
```

### 10.4 处理规则

| 场景 | 处理策略 | 结论 |
|------|---------|------|
| 系统补全字段（VideoApiClient/VOD/ASR等） | 历史标注"不可控/为空"直接适用，无需找到用户输入赋值语句 | safe |
| 字段仅在响应 DTO 中（非请求入参） | 用户无法传入，运行时不可控 | safe |
| 字段由 DB 填充 | 追溯 DB 写入接口的权限控制 | safe（写入侧受限） |
| 非系统补全字段 | 按正常 SSRF 研判流程（§2.2）继续 | - |

### 10.5 误报预防

**典型误报场景**：
1. DTO 声明 `Map<String, String> coverUrlMap` → Agent 判定所有 value 用户可控 → ❌ 实际由 VideoApiClient 补全
2. DTO 声明 `String videoUrl` → Agent 判定用户可传入 URL → ❌ 实际由 VOD 服务填充
3. 历史记录标注"域名不可控/为空" → Agent 要求找到"明确赋值语句"才能推翻 → ❌ 系统补全字段场景无需赋值语句

**预防措施**：
1. 对 Map/Collection 类型的 source 字段，**必须执行业务语义分析**（搜索字段在项目中的实际使用方式）
2. 历史标注"不可控/为空"在系统补全字段场景下**直接适用**，无需额外证据
3. 区分"代码层声明" vs "运行时实际来源"：代码层字段在 DTO 中 ≠ 运行时用户传入
4. 当不确定字段来源时，搜索字段名在项目中的赋值调用（setter/put/JSON序列化）

---

## 9. 质量门禁（强制执行）

在输出审计结论前，按顺序验证：

- [ ] Step 0 数据流连通性预验证已执行
- [ ] 强制执行顺序已遵守（先 URL 拆解判断 Host 是否可控）
- [ ] 研判流程按顺序执行，无跳过
- [ ] "仅 path/query 可控"判断前已验证固定前缀以 "/" 结尾
- [ ] Host 不可控时直接终止（漏洞本质判断先于防护判断）
- [ ] HTTP 入口可达性已确认，非假设
- [ ] 白名单实现已检查（精确匹配 vs startsWith）
- [ ] 结论与证据一致，代码行号可追溯
- [ ] 已应用误报排除规则（§3.1 配置中心白名单、§3.7 拦截型校验）
- [ ] 已追溯 Source 实际来源（区分代码层可控 vs 运行时可控）
- [ ] 对 Map/Collection 类型 source，已执行业务语义分析（搜索字段在业务流程中的实际来源）
- [ ] 不因代码对比而判定风险

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**
