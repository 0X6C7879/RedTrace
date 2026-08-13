# XSS

## 0. 黄金法则

> **漏洞存在性判断 优先于 防护有效性判断**
>
> 不输出到 HTML = 无 XSS（这是漏洞本质判断，不是防护有效判断）
>
> 满足此条件时：立即终止分析，无需检查任何防护措施。

Java 是纯后端语言，本文档覆盖后端 XSS（服务端模板渲染 / HTTP 响应构造）。前端 DOM XSS 发生在浏览器 JS 代码中，不在本文档范围内。

XSS 分为存储型（持久化存储后渲染）和反射型（直接反射输出），但分析流程相同。

**强制执行顺序**：
1. **首先**：找到 sink 点输出代码（如 `response.getWriter().write()`, `th:utext`, `<%= %>`）
2. **然后**：分析输出上下文（HTML/JS/CSS/非输出）
3. **仅当** 输出到 HTML/JS/CSS 且用户可控时，才继续检查防护措施
4. **禁止**：一上来就检查"有没有编码"、"A 有 B 没有"

---

## 1. 结论判断标准

| 结论 | 定义 | 判定条件 |
|------|------|----------|
| **漏洞** | 用户输入到达 HTML 输出点，无有效防护 | 危险输出 + 用户可控 + HTTP 入口 + 无防护 |
| **风险-A** | 危险输出但无 HTTP 入口可达 | 危险输出 + 用户可控 + 无外部入口 |
| **风险-B** | 有 HTTP 入口可达但防护不充分 | 危险输出 + 用户可控 + 仅部分编码/黑名单 |
| **安全** | 有效防护或参数不可控 | 框架自动转义/编码/白名单/非 HTML 输出 |

---

## 2. 漏洞风险的研判思路

### 2.1 Sink 点与框架安全模式（第一优先级）

| 框架 | 安全方式 | 危险方式 |
|------|----------|----------|
| Thymeleaf | `th:text="${...}"` | `th:utext="${...}"` |
| JSP/JSTL | `<c:out value="${...}">` | `<%= %>` 直接输出 |
| Freemarker | `${...}` 默认转义 | `<#noescape>${...}</#noescape>` |
| Velocity | `$esc.html()` | `${...}` 直接输出 |

| Sink 点 | 危险级别 |
|---------|----------|
| `response.getWriter().write(html + input)` | 高 |
| `response.getWriter().print(html + input)` | 高 |
| `<%= request.getParameter("name") %>` | 高 |
| `th:utext="${param.name}"` | 高 |
| `<#noescape>${userInput}</#noescape>` | 高 |

### 2.2 研判流程

```
Step 1: 输出上下文分析 【终止点】
  ├─ 非输出场景（数据库/日志）？ → 安全（终止）
  ├─ JSON API（@RestController/Content-Type: application/json）？ → 安全（终止）
  ├─ Content-Disposition: attachment？ → 安全（终止）
  ├─ Content-Type 非 HTML（硬编码 application/json）？ → 安全（终止）
  └─ HTML/JS/CSS 上下文 → 继续

Step 2: 框架自动转义检查 【终止点】
  ├─ th:text / c:out / Freemarker 默认？ → 安全（终止）
  └─ th:utext / <%= %> / 直接拼接 → 继续

Step 3: 参数可控性检查 【终止点】
  ├─ 硬编码/常量/白名单映射/数据库来源？ → 安全（终止）
  └─ 用户可控 → 继续

Step 4: 防护措施检查
  ├─ HTML 实体编码（HtmlUtils.htmlEscape）？ → 安全（终止）
  ├─ 白名单校验？ → 安全（终止）
  ├─ 黑名单过滤/部分编码？ → 风险-B
  └─ 无防护 → 继续

Step 5: HTTP 入口可达性 【终止点】
  ├─ 无 HTTP 入口？ → 风险-A
  └─ 有 HTTP 入口 → 漏洞
```

### 2.3 降级条件表

| 条件 | 原结论 | 降级后 |
|------|--------|--------|
| 非 HTML 输出 / 非输出场景 | 漏洞 | 安全 |
| 框架自动转义（th:text / c:out） | 漏洞 | 安全 |
| @RestController（JSON 响应） | 漏洞 | 安全 |
| Content-Disposition: attachment | 漏洞 | 安全 |
| HTML 实体编码 / 白名单 | 漏洞 | 安全 |
| 黑名单过滤 | 漏洞 | 风险-B |
| 无 HTTP 入口 | 漏洞 | 风险-A |

### 2.4 总结判定表

| 检查项 | 结论 |
|--------|------|
| 非 HTML 输出 / JSON API / 附件下载 | 安全 |
| 框架自动转义 / HTML 编码 / 白名单 | 安全 |
| HTML/JS 上下文 + 无防护 + HTTP 入口 | 漏洞 |
| 黑名单过滤 | 风险-B |
| 无 HTTP 入口 | 风险-A |

---

## 3. 常见漏洞/风险场景

### 漏洞

```java
// Servlet 直接输出
response.getWriter().write("<div>" + userInput + "</div>");  // 漏洞

// JSP 表达式
<%= request.getParameter("name") %>  // 漏洞

// Thymeleaf 未转义
<div th:utext="${param.name}">  // 漏洞

// Freemarker 未转义
<#noescape>${userInput}</#noescape>  // 漏洞

// JavaScript 上下文注入（极高危）
response.getWriter().write(callback + "({data: 'value'})");  // 漏洞

// HTML 属性注入
out.print("<input value='" + url + "'>");  // 漏洞
```

### 风险-A

```java
out.print("<div>" + dbContent + "</div>");  // 风险-A：DB 来源，需确认写入权限
```

### 风险-B

```java
String safe = input.replace("<", "&lt;");  // 风险-B：未处理引号/事件属性
response.getWriter().write("<div class='" + safe + "'>");

String safe = input.replace("<script>", "").replace("</script>", "");
out.print(safe);  // 风险-B：黑名单可绕过
```

---

## 4. 常见防御模式

### 框架自动转义

```html
<div th:text="${userInput}">  <!-- Thymeleaf 安全 -->
<c:out value="${param.name}" />  <!-- JSTL 安全 -->
```

### HTML 实体编码

```java
String safe = HtmlUtils.htmlEscape(input);  // 安全
String safe = StringEscapeUtils.escapeHtml4(input);  // 安全
```

### JSON 响应

```java
@RestController  // 默认 Content-Type: application/json → 安全
public class ApiController {
    @GetMapping("/api/data")
    public Map<String, String> data() { return Map.of("name", userInput); }
}
```

### 响应头防护 / 白名单

```java
response.setHeader("Content-Disposition", "attachment");  // 安全
response.setContentType("application/json");  // 安全
if (!input.matches("^[a-zA-Z0-9_-]+$")) throw ...;  // 安全
```

---

## 5. 检索技巧

> HTTP 入口可达性检索：详见 [Java 通用检索技巧](java-common-retrieval.md#http-入口可达性检索)

### 搜索关键词

| 类型 | 关键词 |
|------|--------|
| Servlet 输出 | `getWriter().write`, `getWriter().print` |
| JSP 输出 | `<%= %>`, `out.print` |
| 模板引擎 | `th:utext`, `th:text`, `<#noescape` |
| 编码函数 | `escapeHtml`, `htmlEscape`, `HtmlUtils`, `StringEscapeUtils` |

### 检测命令

```bash
# 检测危险输出
grep -rn "getWriter().write\|getWriter().print" --include="*.java"
grep -rn "th:utext" --include="*.html"
grep -rn "<#noescape" --include="*.ftl"

# 检测编码防护
grep -rn "escapeHtml\|htmlEscape\|HtmlUtils\|StringEscapeUtils" --include="*.java"
```

---

## 6. 常见误判场景

### 陷阱1：@RestController 误判

**错误**: 看到 HTML 拼接就判为 XSS
**正确**: `@RestController` 默认返回 `application/json` → 安全

### 陷阱2：JSON API 误判

**错误**: 用户输入被返回就认为存在 XSS
**正确**: JSON API 响应本身不是 XSS → 通常安全

### 陷阱3：Content-Disposition 忽略

**错误**: 看到 `getWriter().write()` 就判为漏洞
**正确**: `Content-Disposition: attachment` 浏览器下载而非渲染 → 安全

### 陷阱4：th:text vs th:utext 混淆

**错误**: 看到 Thymeleaf 变量输出就判为 XSS
**正确**: `th:text` 自动转义 → 安全；`th:utext` 不转义 → 需检查

### 陷阱5：先看防护后看漏洞本质

**错误思路**：发现缺少 htmlEscape → A 有 B 没有 → 判定风险
**正确思路**：先判断输出是否到 HTML（JSON API → 无 XSS）→ 漏洞不存在时防护无从谈起

### 陷阱6：被代码对比干扰

**错误判定**：A 有转义 B 没有 → B 有风险
**正确判定**：先看 B 漏洞是否存在（是否输出到 HTML），再谈防护

> 代码不一致 ≠ 安全问题。不输出到 HTML = 无 XSS。

---

## 7. 特殊风险

### 7.1 存储型 XSS 链路特征

存储型 XSS 与反射型的核心区别：用户输入先**写入**持久化存储（DB/文件/缓存），后续请求**读取**并**渲染**到 HTML 页面。审计时需追踪完整链路：写入接口 → 存储位置 → 读取接口 → HTML 输出。

### 7.2 输出上下文分类与编码匹配

| 上下文 | 危险级别 | 示例 |
|--------|----------|------|
| HTML 内容 | 高 | `<div>{userInput}</div>` |
| HTML 属性 | 高 | `<input value='{userInput}'>` |
| JavaScript | 极高 | `<script>var x = '{userInput}'</script>` |
| CSS | 高 | `<div style='{userInput}'>` |
| URL | 中 | `<a href='{userInput}'>link</a>` |

HTML 编码在 JavaScript 上下文中无效。`<script>var x = '${htmlEscape(input)}'</script>` 仍可被 `'; alert(1)//` 绕过。必须根据输出上下文选择对应编码方式。

### 7.3 CSS/SVG 注入

CSS 注入（`<div style='用户输入'>`）可导致 UI 伪造和数据窃取。SVG 文件中的 `<script>` 标签可执行 JS。上传 SVG 文件后若直接嵌入页面，构成 XSS。

---

## 8. 变更影响分析

| 变更类型 | 变更内容 | 风险 |
|----------|----------|------|
| 新增 | 新增 HTML 输出/th:utext/Servlet write | 确认输出上下文和编码 |
| 修改 | th:text 改为 th:utext | 移除自动转义 |
| 修改 | 移除 htmlEscape 调用 | 移除防护 |
| 修改 | JSON 响应改为 HTML 响应 | 引入 XSS 风险 |
| 删除 | 删除编码函数/白名单校验 | 移除防护 |
| 删除 | 删除 Content-Disposition | 可能引入 XSS |

---

## 9. 质量门禁（强制执行）

在输出审计结论前，按顺序验证：

- [ ] 强制执行顺序已遵守（先检查输出上下文）
- [ ] 非 HTML 输出已正确排除（JSON API、附件下载、非输出场景）
- [ ] 模板引擎转义模式已区分（th:text vs th:utext）
- [ ] HTTP 入口可达性已确认，非假设
- [ ] 结论与证据一致，代码行号可追溯
- [ ] 已应用误报排除规则
- [ ] 不因代码对比而判定风险

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**
