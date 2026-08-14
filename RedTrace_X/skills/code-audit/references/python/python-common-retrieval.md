# Python 通用检索技巧

## 研判流程

### Step 1: 框架识别与入口点定位

**触发条件**: 开始审计 Python Web 应用时

**必做动作**:
1. 检查项目依赖文件确认框架
2. 搜索框架特征路由装饰器/配置：
   - Flask: `grep -rn "@app.route\|@bp.route" --include="*.py"`
   - Django: `grep -rn "def .*_view\|path(\|re_path(" --include="*.py"`
   - FastAPI: `grep -rn "@app\.\(get\|post\|put\|delete\|patch\)" --include="*.py"`
3. 记录所有路由处理函数及文件位置

**结束门槛**:
- 找到所有路由入口点 → 进入 Step 2
- 未找到路由 → 标记为非 Web 应用或需人工研判

**禁止**:
- 禁止遗漏蓝图、子应用或动态注册的路由

---

### Step 2: 参数来源确认

**触发条件**: Step 1 确认路由入口点

**必做动作**:
1. 读取路由处理函数代码
2. 确认参数获取方式：
   - Flask: `request.args`, `request.form`, `request.json`, `request.files`
   - Django: `request.GET`, `request.POST`, `request.body`, `request.FILES`
   - FastAPI: 路径参数、`Query()`, `Body()` 等
3. 记录每个可控参数

**结束门槛**:
- 完成参数来源映射 → 进入 Step 3

**禁止**:
- 禁止假设参数名就代表来源，必须检查代码实际获取方式

---

### Step 3: Sink 点识别

**触发条件**: Step 2 确认参数来源

**必做动作**:
1. 根据审计类型搜索对应 sink 点
2. 使用 grep 命令搜索危险函数
3. 记录所有 sink 点位置

**结束门槛**:
- 找到 sink 点 → 进入 Step 4
- 未找到 sink 点 → 安全，流程结束

**禁止**:
- 禁止仅凭函数名判断，必须读取调用上下文

---

### Step 4: 数据流追踪

**触发条件**: Step 3 找到 sink 点

**必做动作**:
1. 从 sink 点向上追溯参数来源
2. 使用 Grep 追踪变量
3. 确认用户输入是否流入 sink 点

**结束门槛**:
- 用户输入流入 sink 点且无防护 → 转对应漏洞类型详细研判
- 用户输入未流入 sink 点 → 安全，流程结束
- 无法确认 → 标记为需人工研判

**禁止**:
- 禁止假设数据流，必须逐层追踪

---

### Step 5: 防护措施检查

**触发条件**: Step 4 确认数据流入 sink 点

**必做动作**:
1. 检查是否存在类型转换（如 `int()`）
2. 检查是否存在白名单校验
3. 检查是否存在净化函数
4. 检查框架自动防护是否生效

**结束门槛**:
- 存在有效防护 → 安全，流程结束
- 无有效防护 → 漏洞/风险，输出结论

**禁止**:
- 禁止假设框架默认防护就生效，必须检查配置

---

## HTTP 入口点识别

### Flask 框架

#### 路由识别

| 装饰器 | 说明 |
|--------|------|
| `@app.route()` | 应用级路由 |
| `@bp.route()` | 蓝图级路由 |
| `@xxx.route` | 其他扩展路由 |

#### 参数来源

| 属性 | 来源 | 可控性 |
|------|------|--------|
| `request.args` | URL 查询参数 | 可控 |
| `request.form` | POST 表单数据 | 可控 |
| `request.json` / `request.get_json()` | JSON 请求体 | 可控 |
| `request.files` | 上传文件 | 可控 |
| `request.values` | args + form 合并 | 可控 |
| `request.view_args` | URL 路径参数 | 可控 |

#### 识别命令

```bash
# 查找 Flask 路由装饰器
grep -rn "@app.route\|@bp.route\|@.*\.route" --include="*.py"

# 查找路由定义
grep -rn "def.*request\." --include="*.py"

# 查找 Flask 请求参数
grep -rn "request\.args\|request\.form\|request\.json\|request\.files" --include="*.py"
```

#### 代码示例

```python
@app.route('/user/<int:id>', methods=['GET'])
def get_user(id):
    # URL 路径参数，可控
    user_id = id

    # 查询参数，可控
    name = request.args.get('name')

    return jsonify({'id': user_id, 'name': name})

@app.route('/user', methods=['POST'])
def create_user():
    # JSON 请求体，可控
    data = request.get_json()
    username = data.get('username')
    return jsonify({'username': username})
```

---

### Django 框架

#### 路由识别

| 模式 | 说明 |
|------|------|
| `def .*_view` | 视图函数命名约定 |
| `@.*route` | 路由装饰器 |
| `path(` / `re_path(` | URL 配置 |

#### 参数来源

| 属性 | 来源 | 可控性 |
|------|------|--------|
| `request.GET` | URL 查询参数 | 可控 |
| `request.POST` | POST 表单数据 | 可控 |
| `request.body` | 请求体原始数据 | 可控 |
| `request.FILES` | 上传文件 | 可控 |
| `request.META` | 请求头 | 部分可控 |

#### 识别命令

```bash
# 查找 Django 视图函数
grep -rn "def .*_view\|@.*route" --include="*.py"

# 查找 Django URL 参数
grep -rn "request\.GET\|request\.POST" --include="*.py"

# 查找 JSON 解析
grep -rn "json\.loads\(request\." --include="*.py"
```

#### 代码示例

```python
def user_view(request):
    # 查询参数，可控
    name = request.GET.get('name')

    # POST 表单数据，可控
    email = request.POST.get('email')

    # JSON 请求体
    data = json.loads(request.body)
    username = data.get('username')

    return JsonResponse({'name': name})
```

---

### FastAPI 框架

#### 路由识别

| 装饰器 | 说明 |
|--------|------|
| `@app.get()` | GET 路由 |
| `@app.post()` | POST 路由 |
| `@app.put()` | PUT 路由 |
| `@app.delete()` | DELETE 路由 |
| `@app.patch()` | PATCH 路由 |

#### 参数来源

| 方式 | 来源 | 可控性 |
|------|------|--------|
| 路径参数函数参数 | URL 路径 | 可控 |
| `Query()` | URL 查询参数 | 可控 |
| `Body()` / 请求体模型 | JSON 请求体 | 可控 |
| `Form()` | 表单数据 | 可控 |
| `Header()` | 请求头 | 部分可控 |

#### 识别命令

```bash
# 查找 FastAPI 路由装饰器
grep -rn "@app\.\(get\|post\|put\|delete\|patch\)" --include="*.py"

# 查找 Pydantic 模型
grep -rn "class.*BaseModel\|from pydantic" --include="*.py"
```

#### 代码示例

```python
@app.get("/user/{user_id}")
async def get_user(user_id: int, name: str = Query(None)):
    # URL 路径参数，可控
    # 查询参数，可控
    return {"user_id": user_id, "name": name}

@app.post("/user")
async def create_user(user: UserCreate):
    # Pydantic 模型，请求体可控
    username = user.username
    return {"username": username}
```

---

## 数据流追踪方法

### 从 sink 点向上追溯

```python
# Step 1: 识别 sink 点
cursor.execute(f"SELECT * FROM users WHERE name = '{name}'")  # sink

# Step 2: 追踪参数来源
# name 从哪里来？

# Step 3: 继续向上追溯
# 使用 Grep 搜索调用者

# Step 4: 找到入口点
# 确认路由处理函数
```

### 识别命令

```bash
# 追踪数据流 - 使用 Grep 搜索调用关系

# 追踪函数调用
grep -rn "def function_name\|function_name(" --include="*.py"

# 追踪类方法
grep -rn "def method_name\|\.method_name(" --include="*.py"
```

---

## 环境判断检测

```bash
# 检测环境判断
grep -rn "is_prod\|is_test\|is_dev\|is_local\|DEBUG\|ENV" --include="*.py"

# 检测 settings/environment 模块
grep -rn "from django.conf import settings\|os\.environ" --include="*.py"

# 检测 Flask 配置
grep -rn "app.config\|current_app.config" --include="*.py"
```

---

## 防护措施检查方法

| 检查项 | 检索方法 |
|--------|----------|
| 参数化查询 | Grep: `execute(.*%s\|executemany\|?` |
| 类型转换 | Grep: `int(\|str(\|float(` |
| 白名单定义 | Grep: `allowed\|whitelist\|set(\|in \[` |
| 校验函数实现 | Grep: 搜索函数定义 |

**详细防护规则**：
- 净化措施判定：`references/common/sanitization.md`
- 可信数据源判定：`references/common/trusted-sources.md`
- SSRF 隔离代理：`references/common/ssrf-proxy.md`

---

## 可达性判定总结

| 条件 | 可达性 | 结论 |
|------|--------|------|
| 有 Flask/Django/FastAPI 路由，参数来自用户输入 | 可达 | 漏洞/风险/安全取决于防护 |
| 无入口点，仅内部函数 | 不可达 | 风险 |
| 参数来自常量/配置 | 不可达 | 风险 |

---

## 质量检查门禁（强制执行）

在输出审计结论前，按顺序验证：

- [ ] Step 1-5 研判流程按顺序执行，无跳过
- [ ] 框架类型已通过导入语句确认，非仅凭文件名判断
- [ ] 所有路由入口点已识别，包括蓝图和子应用
- [ ] 参数来源已通过代码确认，非假设
- [ ] sink 点代码已实际读取，非仅凭函数名判断
- [ ] 数据流已逐层追踪，有明确证据链
- [ ] 防护措施已检查，非假设框架默认生效
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
- 禁止假设框架默认防护就生效，必须检查配置

**推荐做法**:
- 使用 grep 命令确认框架导入和配置
- 检查 urls.py（Django）或路由注册文件
- 使用 Grep 追踪数据流
- 记录代码文件路径和行号作为证据
