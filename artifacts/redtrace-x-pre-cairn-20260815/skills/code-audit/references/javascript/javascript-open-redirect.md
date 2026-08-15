# 开放重定向

## 0. 黄金法则

> **漏洞存在性判断 优先于 防护有效性判断**
>
> 仅 path/query 可控 = 无 开放重定向（这是漏洞本质判断，不是防护有效判断）
>
> 满足此条件时：立即终止分析，无需检查任何防护措施。

**强制执行顺序**：
1. **首先**：找到 sink 点重定向操作（如 `res.redirect()`, `window.location.href`）
2. **然后**：分析用户输入是否可控制完整 URL（而不仅是 path/query）
3. **仅当** 完整 URL 可控时，才继续检查防护措施
4. **禁止**：一上来就检查"有没有白名单"、"A 有 B 没有"

---

## 1. 结论判断标准

| 结论 | 定义 | 判定条件 |
|------|------|----------|
| **漏洞** | 用户输入可到达重定向操作，完整 URL 可控且无有效防护 | 重定向操作 + 完整 URL 可控 + HTTP 入口可达 + 无有效防护 |
| **风险-A** | 危险重定向但无 HTTP 入口可达 | 重定向操作 + 无外部入口 |
| **风险-B** | 重定向有入口可达，但防护不充分 | 重定向操作 + HTTP 入口 + 弱防护（仅协议白名单/endsWith/includes/黑名单） |
| **安全** | 无危险写法，或有充分防护 | 仅 path/query 可控 / 域名白名单 / 相对路径限制 / Token 编码 / 白名单映射 |

---

## 2. 研判思路

### 2.1 Sink 点与 URL 结构拆解（第一优先级）

| Sink 点 | 环境 | 危险级别 |
|---------|------|----------|
| `res.redirect(userUrl)` | Express/NestJS | 高 |
| `res.location(userUrl)` | Express/NestJS | 高 |
| `response.writeHead(302, { Location: userUrl })` | Node.js 原生 | 高 |
| `window.location.href = userUrl` | 前端浏览器 | 高 |
| `window.location.replace(userUrl)` | 前端浏览器 | 高 |

找到 sink 点后，将 URL 拆解为 `Scheme + Host + Port + Path + Query + Fragment`：

| 用户输入位置 | 代码示例 | 结论 |
|------------|----------|------|
| 仅在 Path | `res.redirect('/api/' + path)` | 安全（终止） |
| 仅在 Query | `res.redirect('https://example.com?id=' + input)` | 安全（终止） |
| 白名单映射 | `REDIRECT_MAP.get(input)` | 安全（终止） |
| 完整 URL | `res.redirect(req.query.url)` | 需继续研判 |
| 前端完整 URL | `window.location.href = params.get('redirect')` | 需继续研判 |

### 2.2 研判流程

```
Step 1: URL 可控性分析 【终止点】
  ├─ 仅 path/query 可控 / 常量 / 白名单映射？ → 安全（终止）
  └─ 完整 URL 可控 → 继续

Step 2: 域名白名单检查 【终止点】
  ├─ new URL(hostname) 白名单校验？ → 安全（终止）
  └─ 无白名单 → 继续

Step 3: 相对路径 / Token 编码检查 【终止点】
  ├─ 限制为相对路径（startsWith("/") 且排除 "//"）？ → 安全（终止）
  ├─ JWT 签名验证？ → 安全（终止）
  └─ 无 → 继续

Step 4: 防护强度检查
  ├─ 仅黑名单过滤（可被 /////evil.com 绕过）？ → 风险-B
  └─ 无防护 → 继续

Step 5: HTTP 入口可达性 【终止点】
  ├─ 无 HTTP 入口？ → 风险-A
  └─ 有 HTTP 入口 → 漏洞
```

### 2.3 降级条件表

| 条件 | 原结论 | 降级后 |
|------|--------|--------|
| 仅 path/query 可控 | 漏洞 | 安全 |
| 域名白名单（new URL().hostname） | 漏洞 | 安全 |
| 相对路径限制 / Token 编码 | 漏洞 | 安全 |
| 白名单映射（Map/Object） | 漏洞 | 安全 |
| 非线上环境 | 漏洞 | 安全 |
| 仅黑名单过滤 | 漏洞 | 风险-B |
| 无 HTTP 入口可达 | 漏洞 | 风险-A |

### 2.4 总结判定表

| 检查项 | 结论 |
|--------|------|
| 仅 path/query 可控（域名固定） | 安全 |
| 域名白名单 / 相对路径限制 / Token 编码 | 安全 |
| 完整 URL 可控 + 无防护 + HTTP 入口 | 漏洞 |
| 完整 URL 可控 + 弱防护（黑名单） | 风险-B |
| 无 HTTP 入口 | 风险-A |

---

## 3. 常见漏洞/风险场景

### 漏洞

```javascript
// 后端：直接重定向用户输入
app.post('/login', (req, res) => {
    res.redirect(req.body.redirect);  // 漏洞
});

// 后端：短链接用户可控 target
const link = await Link.findOne({ code: req.params.code });
res.redirect(link.target);  // 漏洞：用户可控 target

// 前端：重定向参数可控
const redirect = new URLSearchParams(location.search).get('redirect') || '/';
window.location.href = redirect;  // 漏洞
```

### 风险-B（防护不足）

```javascript
// 仅黑名单过滤（可被 /////evil.com 或 https:\evil.com 绕过）
let url = req.query.url;
if (url.startsWith('//') || url.startsWith('http://')) {
    throw new Error('Invalid');
}
res.redirect(url);  // 风险-B
```

---

## 4. 常见防御模式

### 域名白名单

```javascript
const ALLOWED_DOMAINS = ['example.com', 'app.example.com'];
const url = new URL(req.query.url);
if (!ALLOWED_DOMAINS.includes(url.hostname)) {
    throw new Error('Invalid domain');
}
res.redirect(url.href);
```

### 相对路径限制

```javascript
if (!path.startsWith('/') || path.startsWith('//')) {
    throw new Error('Only relative paths allowed');
}
res.redirect(path);
```

### Token 编码 / 白名单映射

```javascript
// JWT 签名验证
const decoded = jwt.verify(token, SECRET);
res.redirect(decoded.url);

// 白名单映射
const REDIRECT_MAP = new Map([['home', '/home'], ['dashboard', '/dashboard']]);
const target = REDIRECT_MAP.get(req.query.target);
if (!target) throw new Error('Invalid');
res.redirect(target);
```

---

## 5. 检索技巧

> HTTP 入口可达性检索：详见 [JavaScript 通用检索技巧](javascript-common-retrieval.md#http-入口可达性检索)

### 搜索关键词

| 类型 | 关键词 |
|------|--------|
| 后端重定向 | `res.redirect(`, `res.location(` |
| 原生 HTTP | `writeHead(`, `'Location':` |
| 前端重定向 | `window.location.href`, `window.location.replace` |

### 检测命令

```bash
# 检测后端重定向
grep -rn "res\.redirect(\|res\.location(" --include="*.js"

# 检测前端重定向
grep -rn "window\.location\|document\.location" --include="*.js"
```

---

## 6. 常见误判场景

### 陷阱1：内部重定向误判

**错误**: 看到 redirect 就判为开放重定向
**正确**: URL 来源是常量 `'/login'`，用户无法控制 → 安全

### 陷阱2：协议/黑名单校验误判

**错误**: 看到 `url.startsWith('http://')` 检查就认为安全
**正确**: 黑名单可被 /////evil.com 绕过 → 漏洞/风险-B

### 陷阱3：前端 vs 后端环境混淆

**错误**: 将前端重定向当成后端漏洞处理
**正确**: 前端 `window.location.href` 和后端 `res.redirect` 攻击面不同，需分别分析

### 陷阱4：先看防护，后看漏洞本质

**错误思路**：发现代码缺少域名白名单 → 判定风险
**正确思路**：先判断漏洞是否存在（完整 URL 可控分析 → 仅 path 可控 → 无开放重定向）

> 漏洞存在性判断 > 防护有效性判断。仅 path/query 可控 = 无开放重定向。

### 陷阱5：被代码对比干扰

**错误判定**：A 有域名校验 B 没有 → B 有风险
**正确判定**：先看 B 漏洞是否存在（完整 URL 是否可控），再谈防护

> 代码不一致 ≠ 安全问题。

---

## 7. 特殊风险

### 前端重定向风险

`window.location.href = userInput` 和 `window.location.replace(userInput)` 在前端执行时虽非服务器端漏洞，但可被钓鱼攻击利用。若重定向目标来自 URL 参数（如 `?redirect=evil.com`），应在前端也做域名校验。

---

## 8. 变更影响分析

| 变更类型 | 变更内容 | 风险 |
|----------|----------|------|
| 新增 | 新增 `res.redirect(userUrl)` | 确认 URL 可控性 |
| 新增 | 新增 `window.location` 赋值 | 前端重定向风险 |
| 新增 | 新增短链接功能 | 用户可控 target |
| 修改 | 移除域名白名单 / Token 验证 | 移除防护 |
| 修改 | 添加域名校验 | 从危险变为安全 |
| 删除 | 删除相对路径限制 | 允许外部跳转 |

---

## 9. 质量门禁（强制执行）

在输出审计结论前，按顺序验证：

- [ ] 强制执行顺序已遵守（先 URL 可控性分析，后防护检查）
- [ ] 仅 path/query 可控时已正确终止（无需检查防护）
- [ ] HTTP 入口可达性已确认，非假设
- [ ] 前端/后端环境已正确区分
- [ ] 结论与证据一致，代码行号可追溯
- [ ] 已应用误报排除规则（黑名单可绕过、常量 URL 安全）
- [ ] 不因代码对比而判定风险

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**
