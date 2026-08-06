# XSS

## 0. 前置判断：执行环境检查（强制门禁）

**触发条件**: 开始审计任何 HTML 输出代码（必须首先执行）

**强制动作**:
1. 确定代码执行环境（后端 vs 前端）
2. **纯前端 CSR 降级评估，非服务端安全漏洞**

**执行环境判定表**:

| 执行环境 | 识别特征 | 后续动作 |
|---------|---------|---------|
| 后端模板渲染 | `res.send()`, `res.render()`, `<%- %>`, EJS/Pug 模板 | 正常研判 |
| 前端 SSR | Next.js `getServerSideProps`, Nuxt.js `asyncData` | 正常研判（服务端执行） |
| 前端 CSR | `innerHTML`, `v-html`, `dangerouslySetInnerHTML` 在客户端组件 | 降级评估 |

**黄金法则**（执行环境确定后统一适用）:
> **漏洞存在性判断 优先于 防护有效性判断**
> 不输出到 HTML = 无 XSS（漏洞本质判断，不是防护有效判断）
> 满足此条件时：立即终止分析

**XSS 类型说明**:
- **存储型 XSS**：用户输入经持久化存储后读取渲染 → 需追踪完整链路
- **反射型 XSS**：用户输入直接反射到输出 → 无中间存储
- **DOM XSS**：纯前端 JS 操作 DOM 注入 → 仅前端 CSR 场景

**质量门禁**: 未完成执行环境判定，禁止进入 Step 2.1

---

## 1. 结论判断标准

| 结论 | 定义 | 判定条件 |
|------|------|----------|
| **漏洞** | 用户输入通过 HTTP 入口到达 HTML 输出点，无有效防护 | HTML 输出 + 用户可控 + 无转义 + HTTP 入口 |
| **风险-A** | 存在 HTML 输出但无 HTTP 入口可达 | HTML 输出 + 用户可控 + 无外部入口 |
| **风险-B** | 有 HTTP 入口可达但防护不充分 | HTML 输出 + 用户可控 + 仅部分净化/黑名单 |
| **安全** | 无 HTML 输出，或有充分防护 | JSON 响应/框架自动转义/白名单/DOMPurify |

**执行环境影响**:
- 后端 XSS + 前端 SSR: 正常研判（服务端安全漏洞）
- 前端 CSR（DOM XSS）: 降级评估（非服务端安全漏洞）

---

## 2. 漏洞风险的研判思路

### 2.1 Sink 点与框架安全模式

**后端 Sink 点（Node.js）**:

| 框架 | 安全方式 | 危险方式 |
|------|----------|----------|
| Express | — | `res.send(\`${input}\`)` |
| EJS | `<%= %>` | `<%- %>` |
| Pug | `= var` | `!= var` / `!{var}` |
| Handlebars | `{{var}}` | `{{{var}}}` |
| React SSR | JSX `{var}` | `dangerouslySetInnerHTML` |
| Vue SSR | `{{ var }}` | `v-html` |

**前端 Sink 点（浏览器 DOM）**:

| 框架 | 安全方式 | 危险方式 |
|------|----------|----------|
| React | JSX `{var}` | `dangerouslySetInnerHTML={{__html: input}}` |
| Vue | `{{ var }}` | `v-html="input"` |
| 原生 DOM | `textContent` | `innerHTML` / `outerHTML` / `document.write` |

**Sink 点危险级别**: `innerHTML`/`document.write`/`dangerouslySetInnerHTML`/`v-html`/`<%- %>`/`res.send()`拼接 = **高**；`<script>${input}</script>` = **极高**（JS 上下文）

### 2.2 研判流程

```
Step 0: 执行环境判定 【前置门禁】
  ├─ 后端模板渲染 / 前端 SSR？ → 正常研判
  └─ 前端 CSR（纯浏览器）？ → 降级评估

Step 1: 输出上下文分析 【终止点】
  ├─ 非输出场景（日志/console.log）？ → 安全（终止）
  ├─ 纯 JSON 响应（res.json()）？ → 安全（终止）
  └─ HTML/JS/CSS 上下文 → 继续

Step 2: 框架自动转义检查 【终止点】
  ├─ React JSX {} / Vue {{}} / EJS <%= %>？ → 安全（终止）
  ├─ dangerouslySetInnerHTML / v-html / EJS <%- %>？ → 继续
  └─ innerHTML / document.write → 继续

Step 3: 参数可控性检查 【终止点】
  ├─ 硬编码/常量/白名单映射/数据库来源？ → 安全（终止）
  └─ 用户可控 → 继续

Step 4: 防护措施检查
  ├─ DOMPurify.sanitize()？ → 安全（终止）
  ├─ HTML 实体编码？ → 安全（终止）
  ├─ 白名单校验？ → 安全（终止）
  ├─ 黑名单过滤？ → 风险-B
  └─ 无防护 → 继续

Step 5: HTTP 入口可达性 【终止点】
  ├─ 无 HTTP 入口？ → 风险-A
  └─ 有 HTTP 入口 → 漏洞
```

### 2.3 降级条件表

| 条件 | 原结论 | 降级后 |
|------|--------|--------|
| res.json() / JSON 响应 | 漏洞 | 安全 |
| 框架自动转义（{} / {{ }} / <%= %>） | 漏洞 | 安全 |
| DOMPurify.sanitize() | 漏洞 | 安全 |
| 白名单校验（正则匹配） | 漏洞 | 安全 |
| 部分转义/黑名单 | 漏洞 | 风险-B |
| 前端 CSR（纯浏览器渲染） | 漏洞 | 降级评估 |
| 无 HTTP 入口可达 | 漏洞 | 风险-A |

### 2.4 总结判定表

| 检查项 | 结论 |
|--------|------|
| 框架自动转义（JSX / Vue {{}} / EJS <%=） | 安全 |
| DOMPurify / HTML 编码 / 白名单 | 安全 |
| 后端：dangerouslySetInnerHTML / v-html / <%- %> + 无防护 + HTTP 入口 | 漏洞 |
| 前端 CSR：innerHTML / v-html / dangerouslySetInnerHTML | 降级评估 |
| 黑名单过滤 | 风险-B |
| 无 HTTP 入口 | 风险-A |

---

## 3. 常见漏洞/风险场景

### 漏洞（后端 - 存储型/反射型）

```javascript
res.send(`<div>搜索结果: ${query}</div>`);  // 漏洞
<div><%- userContent %></div>  // 漏洞
res.send(`${callback}({data: 'value'})`);  // 漏洞（极高危：JSONP/JS 上下文）
```

### 漏洞（前端 - DOM XSS，降级评估）

```javascript
element.innerHTML = `<div>${userInput}</div>`;  // 漏洞（降级评估）
<div dangerouslySetInnerHTML={{__html: userInput}} />  // 漏洞（降级评估）
<div v-html="userContent"></div>  // 漏洞（降级评估）
document.write(userInput);  // 漏洞（降级评估）
```

### 风险-A

```javascript
function renderTemplate(data) {
    element.innerHTML = data.content;  // 风险-A：需追踪调用方
}
```

### 风险-B（防护不足）

```javascript
const blacklist = ['<script>', '</script>', 'javascript:'];
const filtered = blacklist.reduce((s, w) => s.replaceAll(w, ''), userInput);
element.innerHTML = filtered;  // 风险-B：黑名单可绕过

element.innerHTML = DOMPurify.sanitize(userInput, {ALLOWED_TAGS: ['*']});  // 风险-B：配置宽松
```

---

## 4. 常见防御模式

```javascript
<div>{userInput}</div>  // React JSX → 安全（自动转义）
<div>{{ userInput }}</div>  // Vue → 安全（自动转义）
<div><%= userInput %></div>  // EJS → 安全（自动转义）
element.textContent = userInput;  // 替代 innerHTML → 安全
element.innerHTML = DOMPurify.sanitize(userInput);  // DOMPurify → 安全
if (!/^[a-zA-Z0-9_-]+$/.test(username)) throw new Error();  // 白名单 → 安全
res.json({ name: userInput });  // JSON 响应 → 安全
```

---

## 5. 检索技巧

### 搜索关键词

| 类型 | 关键词 |
|------|--------|
| DOM 操作 | `innerHTML`, `outerHTML`, `document.write` |
| React | `dangerouslySetInnerHTML` |
| Vue | `v-html` |
| 模板引擎 | `<%-`, `!=`, `!{`, `{{{` |
| 净化库 | `DOMPurify`, `sanitize` |
| 高危 Sink | `eval(`, `new Function`, `setTimeout(` |

### 检测命令

```bash
grep -rn "innerHTML\|outerHTML\|document\.write\|dangerouslySetInnerHTML\|v-html" --include="*.js" --include="*.jsx" --include="*.vue"
grep -rn "<%-\|!{\|{{{" --include="*.ejs" --include="*.pug" --include="*.hbs"
grep -rn "res\.send.*\$\|res\.render" --include="*.js"
grep -rn "DOMPurify\|sanitize" --include="*.js" --include="*.jsx"
grep -rn "eval(\|new Function" --include="*.js"
```

---

## 6. 常见误判场景

### 陷阱1：React 自动转义误判

**错误**: 看到 `{userInput}` 就判为 XSS
**正确**: React JSX `{}` 自动转义 → 安全；`dangerouslySetInnerHTML` 不转义 → 需检查

### 陷阱2：前端 CSR 误判为服务端 XSS

**错误**: 前端 `innerHTML` = 服务端 XSS 漏洞
**正确**: 前端纯浏览器渲染不是服务端 XSS，降级评估

### 陷阱3：JSON 响应误判

**错误**: 用户输入被返回就判为 XSS
**正确**: `res.json()` 自动转义 → 安全

### 陷阱4：先看防护后看漏洞本质

**错误思路**：发现缺少 DOMPurify → 判定风险
**正确思路**：先判断输出上下文（JSON API → 无 XSS）→ 漏洞不存在时防护无从谈起

### 陷阱5：被代码对比干扰

**错误判定**：A 有 DOMPurify B 没有 → B 有风险
**正确判定**：先看 B 是否输出到 HTML，再谈防护

### 陷阱6：白名单校验识别失败

**错误**: 看到用户输入就认为无防护
**正确**: 正则白名单只允许特定值（如 `/^[a-zA-Z0-9_-]+$/`）→ 安全

---

## 7. 特殊风险

### 7.1 存储型 XSS 链路特征

存储型 XSS 与反射型的核心区别：用户输入先**写入**持久化存储（DB/文件/缓存），后续请求**读取**并**渲染**到 HTML 页面。审计时需追踪完整链路：写入接口 → 存储位置 → 读取接口 → HTML 输出。

### 7.2 输出上下文分类与编码匹配

| 上下文 | 危险级别 | 示例 | 所需编码 |
|--------|----------|------|----------|
| HTML 内容 | 高 | `<div>{userInput}</div>` | HTML 实体编码 |
| HTML 属性 | 高 | `<input value='{userInput}'>` | 属性编码 |
| JavaScript | 极高 | `<script>var x = '{userInput}'</script>` | JS 编码 |
| CSS | 高 | `<div style='{userInput}'>` | CSS 编码 |
| URL | 中 | `<a href='{userInput}'>link</a>` | URL 编码 |

JavaScript 上下文最危险，HTML 编码在 JS 上下文中无效，需使用 JS 编码。

### 7.3 eval/new Function/setTimeout 高危 Sink

`eval(userInput)` / `new Function('return ' + userInput)` / `setTimeout(userInput, 1000)` 以字符串形式传入时等同于 eval，可直接执行任意代码。后端代码中使用这些函数且参数用户可控 → 漏洞。

### 7.4 CSS/SVG 注入

CSS 注入（`<div style='用户输入'>`）可导致 UI 伪造和数据窃取。SVG 文件中的 `<script>` 标签可执行 JS。上传 SVG 文件后若直接嵌入页面，构成 XSS。

---

## 8. 变更影响分析

| 变更类型 | 变更内容 | 风险 |
|----------|----------|------|
| 新增 | 新增 innerHTML/dangerouslySetInnerHTML/v-html | 确认输出上下文 |
| 新增 | 新增 res.send() 字符串拼接 | 确认参数可控性 |
| 修改 | React {} 改为 dangerouslySetInnerHTML | 移除自动转义 |
| 修改 | EJS <%= %> 改为 <%- %> | 移除转义 |
| 修改 | 移除 DOMPurify 调用 | 移除防护 |
| 修改 | textContent 改为 innerHTML | 引入危险 |
| 删除 | 删除净化函数/白名单校验 | 移除防护 |

---

## 9. 质量门禁（强制执行）

在输出审计结论前，按顺序验证：

- [ ] 强制执行顺序已遵守（先检查输出上下文）
- [ ] 执行环境已确认（前端 CSR vs 后端 SSR/模板）
- [ ] 框架自动转义已区分（{} vs dangerouslySetInnerHTML）
- [ ] HTTP 入口可达性已确认，非假设
- [ ] 结论与证据一致，代码行号可追溯
- [ ] 不因代码对比而判定风险

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**
