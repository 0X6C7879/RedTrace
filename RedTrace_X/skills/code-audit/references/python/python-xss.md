# XSS

## 0. 黄金法则

> **漏洞存在性判断 优先于 防护有效性判断**
>
> 不输出到 HTML = 无 XSS（这是漏洞本质判断，不是防护有效判断）
>
> 满足此条件时：立即终止分析，无需检查任何防护措施。

> **Python 为纯后端语言，本文档仅覆盖服务端 XSS（存储型 + 反射型）。前端 DOM XSS 不在范围内。**
> 两种类型的分析流程相同，区别在于输入来源：反射型来自当前请求参数，存储型来自持久化存储（DB/文件/缓存）。

**强制执行顺序**：
1. **首先**：找到 sink 点输出代码（如 `return f'...'`, `render_template`, `|safe`）
2. **然后**：分析输出上下文和模板引擎
3. **仅当** 输出到 HTML 且用户可控时，才继续检查防护措施
4. **禁止**：一上来就检查"有没有编码"、"A 有 B 没有"

---

## 1. 结论判断标准

| 结论 | 定义 | 判定条件 |
|------|------|----------|
| **漏洞** | 用户输入直接输出到危险 Sink，无有效防护 | 危险输出 + 用户可控 + HTTP 入口 + 无防护 |
| **风险-A** | 危险输出但无 HTTP 入口可达 | 危险输出 + 无外部入口 |
| **风险-B** | 有防护但强度不足（黑名单过滤） | 危险输出 + HTTP 入口 + 弱防护 |
| **安全** | 有效防护或参数不可控 | 框架自动转义/编码/白名单/非 HTML 输出 |

---

## 2. 漏洞风险的研判思路

### 2.1 Sink 点与框架安全模式（第一优先级）

| 框架 | 安全方式 | 危险方式 |
|------|----------|----------|
| Jinja2 (Flask) | `{{ var }}` | `{{ var\|safe }}` / `{% autoescape false %}` |
| Django | `{{ var }}` | `{{ var\|safe }}` / `{% autoescape off %}` |
| Tornado | `{% module %}` | `{% raw %}` |

| Sink 点 | 危险级别 |
|---------|----------|
| `return f'<div>{query}</div>'` | 高 |
| `{{ var\|safe }}` | 高 |
| `{% autoescape off %}{{ var }}{% endautoescape %}` | 高 |
| `{% raw %}{{ var }}{% endraw %}` | 高 |
| `HttpResponse(content)` 无转义 | 高 |
| `<script>{callback}(...)</script>` | 极高（JS 上下文） |

> **Python 框架核心**：Django/Jinja2/Tornado 的 `{{ var }}` 默认自动转义 → 安全

### 2.2 研判流程

```
Step 1: 输出上下文分析 【终止点】
  ├─ 非输出场景（日志/数据库）？ → 安全（终止）
  ├─ JSON API（JsonResponse/res.json）？ → 安全（终止）
  ├─ Content-Disposition: attachment？ → 安全（终止）
  ├─ Content-Type 非 HTML（硬编码）？ → 安全（终止）
  └─ HTML/JS/CSS 上下文 → 继续

Step 2: 模板引擎自动转义检查 【终止点】
  ├─ Jinja2 {{ var }} / Django {{ var }} 默认方式？ → 安全（终止）
  ├─ {{ var|safe }} / {% autoescape false %} / {% raw %}？ → 漏洞（终止）
  └─ 字符串拼接（非模板） → 继续

Step 3: 参数可控性检查 【终止点】
  ├─ 硬编码/常量/白名单映射/数据库来源？ → 安全（终止）
  └─ 用户可控 → 继续

Step 4: 防护措施检查
  ├─ html.escape() / markupsafe.escape()？ → 安全（终止）
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
| 框架自动转义（{{ var }}） | 漏洞 | 安全 |
| html.escape() / markupsafe.escape() | 漏洞 | 安全 |
| 白名单校验 | 漏洞 | 安全 |
| JSON 响应（JsonResponse） | 漏洞 | 安全 |
| Content-Disposition: attachment | 漏洞 | 安全 |
| 黑名单过滤 | 漏洞 | 风险-B |
| 无 HTTP 入口 | 漏洞 | 风险-A |

### 2.4 总结判定表

| 检查项 | 结论 |
|--------|------|
| 框架自动转义（{{ var }}） | 安全 |
| html.escape + 白名单 | 安全 |
| 字符串拼接 + 无防护 + HTTP 入口 | 漏洞 |
| {{ var\|safe }} 无额外防护 | 漏洞 |
| 黑名单过滤 | 风险-B |
| 无 HTTP 入口 | 风险-A |

---

## 3. 常见漏洞/风险场景

### 漏洞

```python
# Flask 字符串拼接
@app.route('/search')
def search():
    query = request.args.get('q', '')
    return f'<div>Results: {query}</div>'  # 漏洞

# 字符串拼接 HTML
return HttpResponse(f"<div>{user_input}</div>")  # 漏洞

# f-string HTML
return f"<h1>Welcome {name}</h1>"  # 漏洞

# Jinja2 |safe 过滤器
<div>{{ user_input|safe }}</div>  # 漏洞

# Django autoescape off
{% autoescape off %}{{ user_input }}{% endautoescape %}  # 漏洞

# JavaScript 上下文
return f'<script>{cb}({{data}})</script>'  # 漏洞（极高危）
```

### 风险-A

```python
content = db.query(Model).filter_by(id=idx).first().content
return HttpResponse(f"<div>{content}</div>")  # 风险-A：DB 来源
```

### 风险-B

```python
safe = user_input.replace("<script>", "").replace("</script>", "")
return f'<div>{safe}</div>'  # 风险-B：黑名单可绕过
```

---

## 4. 常见防御模式

### 框架自动转义

```python
# Django/Jinja2 {{ var }} 默认转义 → 安全
render(request, "template.html", {"name": user_input})
```

### HTML 编码

```python
import html
safe = html.escape(user_input)  # 安全
if not re.match(r'^[a-zA-Z0-9_-]+$', input): raise ValueError  # 安全
```

### JSON 响应

```python
from django.http import JsonResponse
return JsonResponse({"name": user_input})  # 安全
```

### 响应头防护

```python
response.headers['Content-Disposition'] = 'attachment'  # 安全
response.headers['Content-Type'] = 'application/json'  # 安全
```

---

## 5. 检索技巧

### 搜索关键词

| 类型 | 关键词 |
|------|--------|
| 字符串拼接 | `return f'`, `return '" +`, `.format(` |
| 模板渲染 | `render_template`, `render(` |
| 模板危险 | `\|safe`, `autoescape off`, `autoescape false`, `{% raw %}` |
| 编码函数 | `html.escape`, `markupsafe.escape` |

### 检测命令

```bash
grep -rn "return f'" --include="*.py"
grep -rn "|safe\|autoescape off\|{% raw" --include="*.html"
grep -rn "|safe\|autoescape\|{% raw %}\|HttpResponse(" --include="*.py"
grep -rn "html\.escape\|markupsafe" --include="*.py"
```

---

## 6. 常见误判场景

### 陷阱1：JSON API 误判

**错误**: 看到 `HttpResponse` 或用户输入被返回就认为存在 XSS
**正确**: JSON API 响应（`JsonResponse` / `Content-Type: application/json`）本身不是 XSS → 通常安全

### 陷阱2：Jinja2 自动转义误判

**错误**: 看到 `{{ user_input }}` 就认为漏洞
**正确**: `{{ var }}` 默认转义 → 安全，`{{ var|safe }}` 才是漏洞

### 陷阱3：Content-Disposition 防护忽略

**错误**: 看到 HTML 输出就认为 XSS
**正确**: `Content-Disposition: attachment` 强制下载 → 安全

### 陷阱4：先看防护，后看漏洞本质

**错误思路**：发现代码缺少 html.escape → 判定风险
**正确思路**：先判断漏洞是否存在（模板自动转义 → 无 XSS）

> 漏洞存在性判断 > 防护有效性判断。不输出到 HTML = 无 XSS。

### 陷阱5：被代码对比干扰

**错误判定**：A 有 html.escape，B 没有 → B 有风险
**正确判定**：先看 B 是否输出到 HTML，再谈防护

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

> **注意**：Jinja2 的 `{{ var }}` 默认仅转义 HTML 内容上下文，在其他上下文中自动转义不足（详见 7.4）。

JavaScript 上下文最危险，HTML 编码在 JS 上下文中无效，需使用 JS 编码。

### 7.3 CSS/SVG 注入

CSS 注入（`<div style='用户输入'>`）可导致 UI 伪造和数据窃取。SVG 文件中的 `<script>` 标签可执行 JS。上传 SVG 文件后若直接嵌入页面，构成 XSS。

### 7.4 Python 特有风险：Jinja2 自动转义范围

Flask 中 Jinja2 的 `{{ var }}` 默认仅转义 HTML 内容上下文。在 JavaScript 上下文（`<script>var x = '{{ var }}'</script>`）中自动转义不足，需使用 `{{ var|tojson }}` 进行 JSON 编码。

---

## 8. 变更影响分析

| 变更类型 | 变更内容 | 风险 |
|----------|----------|------|
| 新增 | 新增 return f'...' 拼接 | 确认输出上下文 |
| 新增 | 新增 \|safe 使用 | 确认防护 |
| 新增 | 新增 HTML 输出/HttpResponse | 确认输出上下文和编码 |
| 修改 | 移除 html.escape() / 添加 \|safe | 移除/禁用转义 |
| 修改 | 从 {{ }} 改为 {{ \|safe }} | 引入危险 |
| 修改 | JsonResponse 改为 HttpResponse HTML | 引入 XSS 风险 |
| 删除 | 删除转义函数/白名单校验 | 移除防护 |

---

## 9. 质量门禁（强制执行）

在输出审计结论前，按顺序验证：

- [ ] 强制执行顺序已遵守（先检查输出上下文）
- [ ] 输出上下文已确认（HTML vs JSON vs 下载）
- [ ] 模板语法安全/危险模式已正确区分（{{ var }} vs \|safe）
- [ ] HTTP 入口可达性已确认，非假设
- [ ] 结论与证据一致，代码行号可追溯
- [ ] 不因代码对比而判定风险

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**
