# CORS

## 0. 黄金法则

> **漏洞存在性判断 优先于 防护有效性判断**
>
> Credentials=false/null 或 静态特定域名 = 无 CORS 漏洞（这是漏洞本质判断，不是防护有效判断）
>
> 满足此条件时：立即终止分析，无需检查任何防护措施。

**强制执行顺序**：
1. **首先**：找到 CORS 配置代码（如 `cors()`, `setHeader()`, `ctx.set()`）
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
| **漏洞** | Credentials=true + Origin 可回显任意值 + 无有效白名单校验 + HTTP 入口可达 + 影响全量接口 | credentials=true + 动态回显/通配符 + 无严格白名单 + HTTP 入口 |
| **风险-A** | CORS 配置不安全但无 HTTP 入口可达 | credentials=true + 动态回显/通配符 + 无外部入口 |
| **风险-B** | CORS 配置有 HTTP 入口可达，但防护措施不充分 | credentials=true + 动态回显/通配符 + endsWith/startsWith 校验 |
| **无法确认** | 白名单关键代码缺失 | 白名单校验函数代码缺失 |
| **安全** | 无危险配置，或有充分的有效防护 | credentials=false / 静态特定域名 / 严格白名单 / 前端代码 / 非线上环境 |

---

## 2. 研判思路

### 2.1 核心判定矩阵

| 执行环境 | Credentials | Origin 设置方式 | 白名单校验 | 结论 |
|----------|-------------|----------------|-----------|------|
| 浏览器（前端） | 任意 | 任意 | 任意 | 安全 |
| Node.js | false/undefined | 任意 | 任意 | 安全 |
| Node.js | true | 静态特定域名 | 任意 | 安全 |
| Node.js | true | 动态回显 | 严格白名单 | 安全 |
| Node.js | true | 动态回显 | 无/宽松校验 | 漏洞 |

### 2.2 研判流程

```
Step 1: 环境检查
  ├─ 前端代码？ → 安全（终止）
  └─ Node.js 后端 → 继续

Step 2: Credentials 检查
  ├─ false/undefined？ → 安全（终止）
  └─ true → 继续

Step 3: Origin 设置方式检查
  ├─ 静态特定域名？ → 安全（终止）
  ├─ 通配符 *？ → 安全（浏览器拒绝，终止）
  └─ 动态回显 → 继续

Step 4: 白名单校验检查
  ├─ includes/Set.has 严格匹配？ → 安全（终止）
  ├─ endsWith/startsWith 宽松校验？ → 风险-B
  └─ 无校验 → 继续

Step 5: HTTP 入口可达性
  ├─ 无 HTTP 入口？ → 风险-A
  └─ 有 HTTP 入口 → 漏洞
```

### 2.3 框架通配符自动解析规则

| 框架/API | 危险配置 | 实际效果 |
|---------|---------|---------|
| Express cors | `origin: '*'` + `credentials: true` | 某些版本解析 |
| Fastify | `origin: "*"` + `credentials: true` | 解析为请求的 Origin |
| Koa @koa/cors | `origin: "*"` + `credentials: true` | 取决于版本 |

### 2.4 降级条件表

| 条件 | 原结论 | 降级后 |
|------|--------|--------|
| 前端执行环境 | 漏洞 | 安全 |
| credentials=false/undefined | 漏洞 | 安全 |
| 静态特定域名 | 漏洞 | 安全 |
| 通配符 * + credentials | 漏洞 | 安全（浏览器拒绝） |
| 严格白名单校验 | 漏洞 | 安全 |
| endsWith/startsWith 宽松校验 | 漏洞 | 风险-B |

---

## 3. 常见漏洞/风险场景

### 漏洞

```javascript
// Express cors 动态回显
app.use(cors({
    origin: function (origin, callback) {
        callback(null, origin);  // 漏洞：直接回显，无校验
    },
    credentials: true
}));

// Koa 动态回显
ctx.set('Access-Control-Allow-Origin', ctx.headers.origin);  // 漏洞
ctx.set('Access-Control-Allow-Credentials', 'true');

// 自定义中间件
res.setHeader('Access-Control-Allow-Origin', req.headers.origin);  // 漏洞
res.setHeader('Access-Control-Allow-Credentials', 'true');
```

### 风险-A

```javascript
function setCORSHeaders(res, origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
}  // 风险-A：需追踪调用方
```

### 风险-B

```javascript
// endsWith 宽松校验
if (origin.endsWith('.trusted.com')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
}
// 绕过: http://attacker.comtrusted.com → 风险-B

// startsWith 宽松校验
if (origin.startsWith('https://api.trusted.com')) {
    ctx.set('Access-Control-Allow-Origin', origin);
}
// 绕过: https://api.trusted.com.evil.com → 风险-B
```

---

## 4. 常见防御模式

### 前端环境

```javascript
// 前端代码不构成服务端 CORS 漏洞 → 安全
axios.get('/api/data', { withCredentials: true });
```

### Credentials 未启用

```javascript
app.use(cors({ origin: '*' }));  // 安全：credentials 默认 false
```

### 静态特定域名

```javascript
app.use(cors({
    origin: ['https://trusted1.com', 'https://trusted2.com'],
    credentials: true
}));  // 安全
```

### 严格白名单校验

```javascript
const whitelist = ['https://trusted1.com', 'https://trusted2.com'];
if (whitelist.includes(origin)) {
    callback(null, true);  // 安全：严格匹配
}
```

---

## 5. 检索技巧

### 搜索关键词

| 类型 | 关键词 |
|------|--------|
| CORS 中间件 | `cors()`, `@koa/cors` |
| 响应头设置 | `Access-Control-Allow-Origin`, `setHeader` |
| Credentials | `credentials: true`, `allowCredentials` |

### 检测命令

```bash
grep -rn "cors(\|@koa/cors\|Access-Control-Allow-Origin\|credentials.*true" --include="*.js"
```

---

## 6. 常见误判场景

### 陷阱1：前端 axios/fetch 误判

**错误**: 看到 `withCredentials: true` 就判为漏洞
**正确**: 浏览器环境，前端代码不构成服务端 CORS 漏洞 → 安全

### 陷阱2：origin 函数未读实现

**错误**: 看到 `origin: function(origin, callback)` 就假设有校验
**正确**: 读取实现——`callback(null, origin)` 无校验 → 漏洞

### 陷阱3：setHeader("*") 误判漏洞

**错误**: `origin: '*'` + `credentials: true` 是漏洞
**正确**: 浏览器直接拒绝 → 安全。**必须区分框架自动解析和手动设置**

### 陷阱4：宽松校验误判安全

**错误**: `origin.endsWith('.trusted.com')` 是有效防护
**正确**: `http://attacker.comtrusted.com` 可绕过 → 风险-B

### 陷阱5：忽略环境判断

**错误**: 未检查 `NODE_ENV`
**正确**: `if (process.env.NODE_ENV === 'development')` 限定的配置仅测试环境 → 安全

### 陷阱6：|| 短路逻辑绕过白名单

**错误**: `isDebugHost() || isWhiteListDomain(origin)` 同时检查了 debug 和白名单 → 安全
**正确**: `||` 是短路或 — 当 `isDebugHost()` 返回 true 时，`isWhiteListDomain()` 不执行，白名单被完全绕过

**分析规则**：
- `||` 连接的条件必须独立分析每个分支
- 如果任一分支可在无安全校验的情况下返回 true → 该分支是绕过路径
- 必须追溯 `isDebugHost()`/`isTestEnv()`/`isDebugMode()` 等函数实现，确认返回 true 的场景

```javascript
// 危险：|| 短路绕过
if (isDebugHost() || isWhiteListDomain(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    // isDebugHost() 在 debug/test/KCS 容器/KWS candidate 机器上返回 true
    // → 任意 Origin 被回显 + Credentials=true → 完整 CORS 漏洞
}
```

---

## 7. 特殊风险

### null Origin 与 file:// 协议

`Origin: null` 出现在 iframe sandbox 和本地文件请求中。若 CORS 配置允许 null Origin，则沙箱 iframe 可绕过限制。`file://` 协议下 Origin 也为 null。

### Express cors 中间件配置

`app.use(cors({ origin: true, credentials: true }))` 中 `origin: true` 会动态回显请求 Origin，等同于 `Access-Control-Allow-Origin: <请求Origin>` + `credentials: true` → 漏洞。

---

## 8. 变更影响分析

| 变更类型 | 变更内容 | 风险 |
|----------|----------|------|
| 新增 | 新增 cors() 中间件 | 确认 origin + credentials 配置 |
| 修改 | 移除白名单校验 | 扩大攻击面 |
| 修改 | 静态域名改为动态回显 | 引入漏洞 |
| 修改 | 添加 credentials: true | 从安全变为不安全 |
| 删除 | 删除白名单校验/环境判断 | 移除防护 |

## 9. 质量门禁（强制执行）

在输出审计结论前，按顺序验证：

- [ ] 强制执行顺序已遵守（先检查环境和 Credentials）
- [ ] 前端代码直接终止
- [ ] credentials=false 直接终止
- [ ] 白名单校验函数已读取实现
- [ ] HTTP 入口可达性已确认，非假设
- [ ] 结论与证据一致，代码行号可追溯
- [ ] 白名单校验的逻辑条件已分析（|| 短路绕过风险，每个分支独立分析）

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**
