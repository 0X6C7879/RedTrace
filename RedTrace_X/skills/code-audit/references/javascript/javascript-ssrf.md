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
1. **首先**：确认执行环境（前端浏览器 vs Node.js 后端）
2. **然后**：找到 sink 点 URL 最终构造代码
3. **接着**：执行 URL 结构拆解，判断用户输入位置
4. **仅当** Host 可控时，才继续检查防护措施
5. **禁止**：一上来就检查"有没有白名单"

---

## 1. 结论判断标准

| 结论 | 定义 | 判定条件 |
|------|------|----------|
| **漏洞** | 用户输入可通过 HTTP 入口到达网络请求点，Host 可控且无有效防护 | 1. 存在网络请求; 2. Host 用户可控; 3. HTTP 入口可达; 4. 无有效防护 |
| **风险-B** | 有 HTTP 入口可达，但防护不充分 | 1. 存在网络请求; 2. HTTP 入口可达; 3. 仅有弱防护 |
| **安全** | Host 不可控，或有充分防护 | 仅 path/query 可控 / 前端请求 / 隔离代理 / 域名白名单 / URL 来自配置 |

---

## 2. 漏洞风险的研判思路

### 2.1 URL 结构拆解（第一优先级）

找到 sink 点 URL 最终构造代码，拆解为 `URL = Scheme + Host + Port + Path + Query`：

| 用户输入位置 | 代码示例 | 结论 |
|----------|----------|------|
| 仅在 Path | `url = "http://api.com/" + input` | 安全（立即终止） |
| 仅在 Query | `url = "http://api.com/api?id=" + input` | 安全（立即终止） |
| Host 部分 | `url = "http://" + input + "/api"` | 需继续研判 |
| 完整 URL | `url = input` 或 `new URL(input)` | 需继续研判 |

> SSRF 核心是"用户能否控制请求目标 Host"，Host 不可控则 SSRF 不存在。

**常见拼接模式**：

```
危险（Host 可控）：
- url = "http://" + userInput + "/api"
- url = userInput + "/api/v1"

安全（仅 Path 可控）— 需验证固定前缀以 / 结尾：
- url = "http://fixed.com/" + userInput            ← ✅ 前缀以 / 结尾，@ 注入不可行
- url = baseURL + "/" + userInput                  ← ✅ 需确认 baseURL 含 scheme://host/ 形式

⚠️ 需进一步研判（看似仅 Path 可控，但前缀不以 / 结尾）：
- url = "http://docs.internal" + userInput         ← ❌ 无 /，input = "@evil.com" 可改变 Host
- url = BASE_URL + userInput                       ← ❌ 需确认 BASE_URL 是否以 / 结尾
```

### 2.2 研判流程

```
Step 1: 执行环境检查
  ├─ 浏览器前端（fetch/axios 在组件中）？ → 安全
  └─ Node.js 后端 → 继续

Step 1.5: sink 分支触发条件验证（详见 false-positive-filtering.md §3.9）
  ├─ 存在安全分支提前 return，且危险分支需特定输入触发？→ 应用 §3.9 判定
  └─ sink 无条件可达 → 继续

Step 2: URL 结构拆解
  ├─ 仅 path/query 可控？ → 安全
  └─ Host 可控 → 继续

Step 3: 隔离代理检查（完整流程见 references/common/ssrf-proxy.md）
  ├─ 是隔离代理？ → 安全
  └─ 不是隔离代理 → 继续

Step 4: URL/Host 来源检查
  ├─ 来自 config/process.env/数据库？ → 安全
  ├─ 来自可信服务响应（source_method 为 res/response/data 等响应对象）？
  │     → 必须追溯响应的上游请求 URL 来源
  │     ├─ 上游请求 URL 来自配置中心/硬编码 → 可信服务响应，URL 不可控 → 安全
  │     └─ 上游请求 URL 来自用户输入 → 继续
  └─ 用户直接输入 → 继续

Step 5: 白名单校验检查
  ├─ 域名白名单（精确匹配/endsWith）？ → 安全
  ├─ 白名单但 startsWith/includes？ → 漏洞（可绕过）
  └─ 无白名单 → 继续

Step 6: HTTP 入口可达性
  ├─ 无 HTTP 入口？ → 不报告
  └─ 有入口 → 漏洞
```

### 2.3 降级条件表

| 条件 | 原结论 | 降级后 |
|------|--------|--------|
| 仅 path/query 可控 | 漏洞/风险 | 安全（漏洞本质判断，非降级） |
| 前端浏览器请求 | 漏洞 | 安全（浏览器发起，非 SSRF） |
| URL 来自 config/process.env/数据库 | 漏洞 | 安全 |
| URL 来自可信服务响应（上游请求 URL 来自配置/硬编码） | 漏洞 | 安全 |
| 域名白名单（精确匹配） | 漏洞/风险 | 安全 |
| 仅协议白名单 | 漏洞 | 漏洞（HTTP 本身可访问内网） |
| startsWith/includes 校验 | 漏洞 | 漏洞（可绕过） |

### 2.4 总结判定表

| 检查项 | 结论 |
|--------|------|
| 前端请求 / 仅 path/query 可控 / 隔离代理 / 域名白名单（精确匹配） / 可信服务响应（上游 URL 来自配置） | 安全 |
| Host 可控 + 无防护 | 漏洞 |
| 白名单用 startsWith/includes | 漏洞（可绕过） |

---

## 3. 常见漏洞/风险场景

### 场景1：Host 拼接 / 完整 URL

```javascript
const url = req.query.url;                          // 完整 URL
const url = `http://${req.query.host}/api`;         // Host 拼接
const parsedUrl = new URL(req.query.url);           // 解析用户输入
await axios.get(url);  // 漏洞：Host 用户可控
```

### 场景2：重定向链绕过

```javascript
await axios.get(req.query.url, { maxRedirects: 5 });  // 漏洞：跟随重定向到内网
// 攻击载荷：http://external.com → 302 → http://127.0.0.1:6379
```

### 场景3：仅协议白名单（无效防护）

```javascript
if (!url.startsWith('http')) return;
await fetch(url);  // 漏洞：HTTP 协议本身可访问内网
```

### 场景4：startsWith 校验可绕过

```javascript
if (url.startsWith('http://trusted.com')) {
    await axios.get(url);  // 漏洞
}
// 绕过：http://trusted.com@evil.com（@后才是真实Host）
// 绕过：http://trusted.com.evil.com（子域名）
```

---

## 4. 常见防御模式

### 仅 path/query 可控

```javascript
const url = `https://cdn.example.com/${path}`;  // Host 固定
await axios.get(url);  // 安全
```

### URL 来自配置 / 环境变量 / 数据库

```javascript
const baseUrl = config.get('api.external.url');    // 配置中心
const baseUrl = process.env.API_BASE_URL;           // 环境变量
const url = (await callbackDao.getById(id)).url;    // 数据库查询
await axios.get(url);  // 安全：用户无法修改来源
```

### 域名白名单（精确匹配）

```javascript
const allowed = ['api.example.com', 'cdn.example.com'];
const hostname = new URL(url).hostname;
if (!allowed.includes(hostname)) throw new Error('host not allowed');
// 安全：攻击者无法控制白名单中域名的 DNS 解析
```

### 隔离代理

```javascript
const axiosAntiSsrf = axios.create({
    proxy: { host: 'anti-ssrf-proxy.internal', port: 8080 }
});
// 代理名称含 anti/ssrf → 安全
```

### 禁用重定向

```javascript
await axios.get(url, { maxRedirects: 0 });  // 防止重定向链绕过
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
# JS/TS 重定向配置检索
grep -rn "followRedirects\|redirect\|maxRedirects" --include="*.js" --include="*.ts"
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
| HTTP 客户端 | `axios.get(`, `axios.post(`, `fetch(`, `got(`, `needle(`, `request(`, `node-fetch` |
| 内置模块 | `http.get(`, `http.request(`, `https.request(` |
| URL 拼接 | `new URL(`, `"http://" +`, `` `http://${` `` |
| 隔离代理 | `anti.*ssrf`, `ssrf.*client`, `AntiSsrf`, `ssrfProxy` |
| 配置来源 | `process.env`, `config.get(`, `config.get(` |

```bash
# 检测 HTTP 客户端
grep -rn "axios\.get\|axios\.post\|fetch(" --include="*.js"

# 检测 URL 拼接
grep -rn "new URL(" --include="*.js"

# 检测隔离代理
grep -rn -i "anti.*ssrf\|ssrfProxy" --include="*.js"
```

---

## 6. 常见误判场景

### 陷阱1：前端 fetch 误判

**错误**: 看到 `fetch()` 就判为 SSRF
**正确**: 浏览器发起的请求不是服务器 SSRF → 安全

### 陷阱2：仅 path 可控误判

**错误**: 看到用户输入拼接到 URL → SSRF
**正确**: Host 固定，用户仅控制 path → 安全

### 陷阱3：普通代理 vs 隔离代理

**错误**: 看到代理就认为有 SSRF 防护，或代理名称不含 anti/ssrf 就直接判定为普通代理
**正确**: 代理名称不含 anti/ssrf 时，不能直接排除，需按 ssrf-proxy.md 完整流程判定（配置溯源 + 历史记录核查）

### 陷阱4：数据库查询 URL 误判

**错误**: 用户可通过查询键控制 URL
**正确**: URL 来自数据库，用户输入只是查询键 → 安全

### 陷阱5：startsWith 可绕过

**错误**: 有校验就安全
**正确**: `url.startsWith('http://internal.com')` 可被绕过 → 漏洞
- `@` 绕过：`http://internal.com@evil.com`
- 子域名绕过：`http://internal.com.evil.com`

### 陷阱6：先看防护后看漏洞本质

**错误**: 发现缺少白名单 → SSRF 风险
**正确**: 先判断漏洞是否存在（Host 不可控 → 无 SSRF），漏洞不存在时防护问题无从谈起

### 陷阱7：被代码对比干扰

**错误**: A 有白名单，B 没有 → B 有风险
**正确**: 先看 B 的漏洞是否存在，再谈防护缺失

### 陷阱8：字符串拼接误判为仅 path 可控

**错误**: `url = "http://docs.internal" + path` → 固定 Host + path 可控 → 安全
**正确**: 前缀不以 `/` 结尾，path 可通过 `@` 注入改变 URL 语义结构

当 path = "@evil.com/xxx" 时：
  http://docs.internal@evil.com/xxx
  → docs.internal 变成 userInfo，真正 Host 是 evil.com

RFC 3986 URL 格式：`scheme://userInfo@host:port/path`
`@` 之前是 userInfo，`@` 之后才是真正的 Host。

**判定规则**：固定前缀必须以 `/` 结尾，才能确保用户输入只落在 path 位置。

### 陷阱9：代码允许 http/https 就判漏洞，忽略业务层的实际触发场景

**错误**: 看到代码中存在 `fetch(httpUrl)` 分支，直接判定 Host 用户可控 → 漏洞；未分析该分支是否在业务场景中实际可被触发
**正确**: 若代码同时存在提前 return 的安全分支，且历史记录或业务文档表明实际只走安全分支，按 false-positive-filtering.md §3.9 判定

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

### WebSocket SSRF

```javascript
// 漏洞：ws:// 可访问内网
const ws = new WebSocket(req.query.url);
// 攻击载荷: ws://127.0.0.1:6379/
```

WebSocket 使用 `ws://`/`wss://` 协议，可访问内网服务，属于 SSRF sink 点。

### 重定向链绕过

域名白名单通过后，HTTP 客户端可能跟随 302 重定向到内网。防护：`axios.get(url, { maxRedirects: 0 })` 或使用隔离代理。

**审计要求**：当发现 IP 检测/域名白名单等防护时，必须同步检查 HTTP 客户端的重定向配置：
1. 是否跟随重定向？
2. 重定向目标是否经过相同的 IP/域名检查？
3. 如果未配置自定义重定向处理 → 默认跟随重定向 → 重定向目标可能绕过检查

### 内网地址变体

```
http://2130706433     // = 127.0.0.1（十进制）
http://0177.0.0.1     // = 127.0.0.1（八进制）
http://0x7f.0.0.1     // = 127.0.0.1（十六进制）
http://[::1]/         // IPv6 回环
```

需检测范围：`127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16`

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

- [ ] 执行环境已确认（前端浏览器 vs Node.js 后端）
- [ ] 强制执行顺序已遵守（先环境判断，再 URL 拆解）
- [ ] 研判流程按顺序执行，无跳过
- [ ] "仅 path/query 可控"判断前已验证固定前缀以 "/" 结尾（防止 @/:// 注入改变 Host）
- [ ] Host 不可控时直接终止（漏洞本质判断先于防护判断）
- [ ] HTTP 入口可达性已确认，非假设
- [ ] 白名单实现已检查（精确匹配 vs startsWith）
- [ ] **历史记录冲突检查**：初始结论与历史记录冲突时，已执行 Step 1.5 验证
- [ ] 结论与证据一致，代码行号可追溯
- [ ] 已应用误报排除规则（前端请求、内网 IP、localhost 不报告）
- [ ] 不因代码对比而判定风险

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**
