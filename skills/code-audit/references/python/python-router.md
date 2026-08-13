# Python 语言路由配置

Python 语言特定的模式映射和检测规则。

## 研判流程

### Step 1: 框架识别

**触发条件**: 开始审计 Python Web 应用时

**必做动作**:
1. 检查项目依赖文件（requirements.txt, pyproject.toml, Pipfile）
2. 搜索框架特征导入：
   - Flask: `from flask import`
   - Django: `from django import`, `import django`
   - FastAPI: `from fastapi import`
3. 确认主应用入口文件

**结束门槛**:
- 确认框架类型 → 进入 Step 2
- 非支持框架 → 标记为需人工研判

**禁止**:
- 禁止假设有某些文件就使用对应框架，必须确认导入语句

---

### Step 2: 路由入口点识别

**触发条件**: Step 1 确认框架类型

**必做动作**:
1. **Flask**: 搜索 `@app.route`, `@bp.route`, `@.*\.route`
2. **Django**: 搜索 `def .*_view`, `path(`, `re_path(`, urls.py 文件
3. **FastAPI**: 搜索 `@app\.get`, `@app\.post`, `@app\.put`, `@app\.delete`
4. 记录所有路由处理函数及文件位置

**结束门槛**:
- 找到所有路由入口点 → 进入 Step 3
- 未找到路由 → 标记为非 Web 应用或需人工研判

**禁止**:
- 禁止遗漏蓝图(Blueprint)或子应用的路由

---

### Step 3: 参数来源映射

**触发条件**: Step 2 确认路由入口点

**必做动作**:
1. **Flask**: 检查 `request.args`, `request.form`, `request.json`, `request.files`, `request.view_args`
2. **Django**: 检查 `request.GET`, `request.POST`, `request.body`, `request.FILES`
3. **FastAPI**: 检查路径参数、`Query()`, `Body()`, `Form()` 参数
3. 记录每个参数的来源和类型

**结束门槛**:
- 完成参数来源映射 → 进入 Step 4

**禁止**:
- 禁止假设参数名就代表来源，必须检查代码实际获取方式

---

### Step 4: 模式关键词匹配

**触发条件**: Step 3 完成参数来源映射

**必做动作**:
1. 根据下表"模式关键词到漏洞类型映射"进行关键词搜索
2. 对每个匹配点进行数据流追踪
3. 确认用户输入是否流入危险函数

**结束门槛**:
- 数据流入危险函数且无防护 → 转对应漏洞类型详细研判
- 数据未流入危险函数 → 安全
- 无法确认 → 标记为需人工研判

**禁止**:
- 禁止仅凭关键词匹配就判定漏洞，必须追踪数据流

---

## 语言元信息

| 字段 | 值 |
|------|-----|
| 语言名称 | Python |
| 语言代码 | `python` |
| 支持框架 | Flask, Django, FastAPI |
| 文件扩展名 | `.py` |

---

## 模式关键词到漏洞类型映射

> 「漏洞类型」列的值必须严格使用 `references/common/category-enum.md` 中定义的标准化枚举值。

| 模式关键词 | 漏洞类型 | 规则文档 |
|-----------|---------|---------|
| pickle.loads, yaml.load | Deserialization | python-deserialization.md |
| os.system, subprocess, eval, exec | RCE | python-rce.md |
| **SQL关键字（查询）**: SELECT, FROM, WHERE, JOIN, INNER, LEFT, RIGHT, OUTER, ON, GROUP BY, ORDER BY, HAVING, LIMIT, OFFSET | SQLi | python-sql-injection.md |
| **SQL关键字（修改）**: INSERT, UPDATE, DELETE, SET, VALUES, INTO | SQLi | python-sql-injection.md |
| **SQL关键字（结构）**: CREATE, ALTER, DROP, TABLE, INDEX, VIEW, DATABASE, SCHEMA | SQLi | python-sql-injection.md |
| **SQL关键字（控制）**: UNION, CASE, WHEN, THEN, ELSE, END, EXISTS, IN, LIKE, BETWEEN | SQLi | python-sql-injection.md |
| **SQL关键字（函数）**: COUNT, SUM, AVG, MAX, MIN, DISTINCT, AS | SQLi | python-sql-injection.md |
| **SQL执行方法**: execute, execute_sql, cursor.execute, raw, extra | SQLi | python-sql-injection.md |
| **拼接操作**: +, +=, .format(, f"{", % | SQLi | python-sql-injection.md |
| **动态替换**: .replace(, .replace( | SQLi | python-sql-injection.md |
| cursor.execute, session.execute | SQLi | python-sql-injection.md |
| requests.get, urllib.request | SSRF | python-ssrf.md |
| redirect, HttpResponseRedirect | OpenRedirect | python-open-redirect.md |
| send_file, open, Path | PathTraversal | python-path-traversal.md |
| file.save, file.filename | FileUpload | python-file-upload.md |
| debug=True, DEBUG=True | WebEnableDebug | python-web-enable-debug.md |
| render_template_string, Template | SSTI | python-ssti.md |
| etree.parse, xml.sax.parse, xml.etree | XXE | python-xxe.md |
| % 格式化, .format(), f-string | FormatString | python-format-string.md |
| PASSWORD, TOKEN, API_KEY, SECRET | Hardcoded | python-hardcoded.md |
| |safe, autoescape, f-string HTML | XSS | python-xss.md |
| Access-Control-Allow-Origin, CORS | CORS | python-cors.md |
| @login_required 缺失, 无认证装饰器, authenticate 缺失, 签名绕过, @permission_required 缺失, 角色检查缺失, 垂直越权, 全局越权 | BrokenAccessControl | python-broken-access-control.md |
| 敏感删改接口无 csrf_token, @csrf_exempt, CsrfViewMiddleware 缺失 | CSRF | python-csrf.md |
| prompt, system_message, chat_completion, openai, langchain, user_input → LLM | PromptInjection | python-prompt-injection.md |
| 金额篡改, 数量篡改, 状态机绕过, 评分滥用 | BusinessLogic | python-business-logic.md |
| 分页无上限, export, listAll, values_list 无 limit, Paginator 无上限 | BatchExport | python-batch-export.md |
| FastAPI, docs_url, redoc_url, openapi_url, swagger, flask-restx, drf-yasg, /docs, /redoc | SwaggerMisconfig | python-swagger-misconfig.md |

---

## 高危参数名列表

| 参数名 | 常见用途 | 风险类型 |
|--------|----------|----------|
| `searchField`, `fieldName`, `columnName` | 动态字段查询 | SQLi |
| `sortBy`, `orderField`, `sortColumn` | 排序字段 | SQLi |
| `tableName` | 动态表名 | SQLi |
| `command`, `cmd`, `bash` | 命令执行 | RCE |
| `url`, `targetUrl`, `callbackUrl` | URL 请求 | SSRF |
| `redirectUrl`, `returnUrl`, `next` | 重定向 | OpenRedirect |
| `filename`, `filepath`, `path` | 文件操作 | PathTraversal |

---

## HTTP 入口点识别规则

| 框架 | 识别模式 | 参数来源 |
|------|----------|----------|
| Flask | `@app.route()`, `@bp.route()` | `request.args`, `request.form`, `request.json`, `request.files` |
| Django | `def .*_view`, `path(`, `re_path(` | `request.GET`, `request.POST`, `request.FILES` |
| FastAPI | `@app.get/post/put/delete()` | 路径参数, `Query()`, `Body()` |

---

## 支持的漏洞类型列表

| 类型 | 规则文档 |
|------|----------|
| 反序列化 | python-deserialization.md |
| RCE | python-rce.md |
| SQL 注入 | python-sql-injection.md |
| SSRF | python-ssrf.md |
| 开放重定向 | python-open-redirect.md |
| 路径遍历 | python-path-traversal.md |
| 文件上传 | python-file-upload.md |
| Web调试模式 | python-web-enable-debug.md |
| SSTI 模板注入 | python-ssti.md |
| XXE | python-xxe.md |
| 格式化字符串 | python-format-string.md |
| 硬编码凭据 | python-hardcoded.md |
| XSS | python-xss.md |
| CORS | python-cors.md |
| Swagger 不安全配置 | python-swagger-misconfig.md |

---

## 快速检测命令

```bash
# SQL 注入检测
grep -rn "cursor\.execute\|session\.execute\|db\.execute" --include="*.py"

# RCE 检测
grep -rn "os\.system\|subprocess\.\|eval\s*[(]\|exec\s*[(]" --include="*.py"

# SSRF 检测
grep -rn "requests\.\|urllib\.\|httpx\." --include="*.py"

# 路径遍历检测
grep -rn "open(\|send_file\|Path(" --include="*.py"

# 文件上传检测
grep -rn "request\.files\|FileStorage" --include="*.py"

# XXE 检测
grep -rn "lxml\|xml\.sax\|xml\.etree" --include="*.py"

# SSTI 检测
grep -rn "render_template_string\|jinja2\.Template" --include="*.py"

# 开放重定向检测
grep -rn "redirect(\|HttpResponseRedirect" --include="*.py"

# Web 调试模式检测
grep -rn "app\.run.*debug\|DEBUG = True" --include="*.py"
```

---

## Python 语言特性说明

### Django ORM 自动转义

```python
# 安全：Django ORM 自动参数化
User.objects.filter(name=username)

# 危险：raw SQL 拼接
User.objects.raw(f"SELECT * FROM users WHERE name = '{name}'")
```

### Flask render_template 自动转义

```python
# 安全：Jinja2 默认自动转义
render_template('template.html', user_input=user_input)

# 危险：关闭自动转义
render_template_string(template, autoescape=False)
```

### 参数化查询模式

```python
# 安全：使用 %s 占位符
cursor.execute("SELECT * FROM users WHERE name = %s", (username,))

# 危险：字符串拼接
cursor.execute("SELECT * FROM users WHERE name = '" + username + "'")
```

---

## 质量检查门禁（强制执行）

在输出审计结论前，按顺序验证：

- [ ] Step 1-4 研判流程按顺序执行，无跳过
- [ ] 框架类型已通过导入语句确认，非仅凭文件名判断
- [ ] 所有路由入口点已识别，包括蓝图和子应用
- [ ] 参数来源已通过代码确认，非假设
- [ ] 关键词匹配后已进行数据流追踪
- [ ] 结论与证据一致，代码行号可追溯

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**

---

## 工程约束（禁止清单）

**禁止操作**:
- 禁止假设装饰器/注解存在就生效，必须检查配置
- 禁止假设拦截器注入就覆盖当前路由，必须确认拦截器配置
- 禁止假设下游服务会自动校验，需看到下游代码或明确说明
- 禁止仅看方法名判断安全性，必须追踪数据流
- 禁止遗漏蓝图(Blueprint)或子应用的路由检查
- 禁止假设参数名就代表来源，必须检查代码实际获取方式

**推荐做法**:
- 使用 grep 命令确认框架导入和配置
- 检查 urls.py（Django）或路由注册文件
- 追踪完整调用链路
- 记录代码文件路径和行号作为证据
