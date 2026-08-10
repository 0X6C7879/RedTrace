# SQL 注入

## 0. 黄金法则

> **漏洞存在性判断 优先于 防护有效性判断**
>
> 参数不拼接 SQL = 无 SQL 注入（这是漏洞本质判断，不是防护有效判断）
>
> 满足此条件时：立即终止分析，无需检查任何防护措施。

**强制执行顺序**：
1. **首先**：找到 sink 点 SQL 执行代码（如 `cursor.execute()`, `Model.objects.raw()`, `session.execute()`)
2. **然后**：分析用户输入是否拼接进 SQL 语句
3. **仅当** SQL 拼接时，才继续检查防护措施
4. **禁止**：一上来就检查"有没有过滤"、"A 有 B 没有"

---

## 1. 结论判断标准

| 结论 | 定义 | 判定条件 |
|------|------|----------|
| **漏洞** | 用户输入未经处理直接拼接到 SQL，或字段名/表名用户可控且无防护 | 1. 字符串拼接 SQL; 2. 数据流可追踪到 HTTP 入口; 3. 无参数化/白名单防护 |
| **风险-A** | 存在 SQL 拼接，但无 HTTP 入口可达 | 1. 存在 SQL 拼接; 2. 数据流不可追踪到外部入口 |
| **风险-B** | SQL 拼接有 HTTP 入口可达，但防护措施不充分 | 1. 存在 SQL 拼接; 2. HTTP 入口可达; 3. 有弱防护（如简单过滤） |
| **安全** | 使用参数化查询、类型约束、白名单、ORM 安全使用 | 1. 占位符参数化; 2. int/float 类型约束; 3. 字段名白名单校验 |

---

## 2. 漏洞风险的研判思路

### 2.1 SQL 执行场景分类

| 场景 | 安全模式 | 危险模式 |
|------|----------|----------|
| 原生游标 | `cursor.execute(sql, args)` | `cursor.execute(sql % args)` |
| SQLAlchemy | `text().bindparams()` | `text(f"...{value}")` |
| Django ORM | `Model.objects.filter(field=value)` | `Model.objects.raw(f"...{value}")` |
| 字段名拼接 | 白名单校验 | 直接拼接用户输入 |

### 2.2 SQL 拼接模式识别

| 模式类型 | 检测特征 | 风险级别 | 示例 |
|---------|---------|----------|------|
| f-string | `f"{...}"` | 高 | `f"SELECT * FROM users WHERE name = '{name}'"` |
| format | `.format()` | 高 | `"...WHERE name = '{}'".format(name)` |
| % 格式化 | `%s`, `%d` | 高 | `"...WHERE name = '%s'" % name` |
| 字符串拼接 | `+`, `+=` | 高 | `"...WHERE name = '" + name + "'"` |
| 动态替换 | `.replace()` | 中 | `sql.replace("{table}", tableName)` |

```python
# 危险模式
sql = f"SELECT * FROM users WHERE name = '{name}'"        # f-string
sql = "...WHERE name = '{}'".format(name)                  # format
sql = "...WHERE name = '%s'" % name                        # % 格式化
sql = "...WHERE name = '" + name + "'"                     # 字符串拼接
sql = template.replace("{table}", tableName)               # 动态替换（可控）

# 安全模式
cursor.execute("SELECT * FROM users WHERE name = %s", (name,))  # 参数化
User.objects.filter(name=username)                                # ORM
```

### 2.3 类型约束检查

| 类型 | 判定 | 示例 |
|------|------|------|
| `int`, `float` | 安全 | `user_id = int(request.GET.get('id'))` |
| `bool` | 安全 | `def set_active(is_active: bool)` |
| `Decimal` | 安全 | `def set_price(amount: Decimal)` |
| `datetime`, `date`, `time` | 通常安全 | 需检查格式化是否影响注入 |
| `List[int]` | 安全 | `def find_by_ids(ids: List[int])` |

> `int()` / `float()` 转换后的值是安全的。`xx_id` 参数名不等于 int 类型，需检查实际转换。

### 2.4 研判流程

```
Step 1: 类型约束检查
  ├─ int/float/bool/Decimal/List[int] 类型？ → 安全（终止）
  └─ str 类型 → 继续

Step 2: 参数化查询检查
  ├─ cursor.execute(sql, args) 第二参数是元组？ → 安全（终止）
  ├─ text().bindparams()？ → 安全（终止）
  ├─ Model.objects.filter/get（安全方法）？ → 安全（终止）
  └─ 字符串拼接/f-string → 继续

Step 3: 字段名/表名拼接检查（高危）
  ├─ 有白名单/枚举/Map 映射？ → 安全（终止）
  └─ 字段名/表名拼接无防护 → 继续

Step 4: HTTP 入口可达性
  ├─ 无 HTTP/gRPC 入口？ → 风险-A
  ├─ 有入口 + 弱防护（黑名单/转义）？ → 风险-B
  └─ 有入口 + 无防护 → 漏洞
```

### 2.5 降级条件表

| 条件 | 原结论 | 降级后 |
|------|--------|--------|
| int/float 类型约束 | 漏洞 | 安全 |
| 参数化查询（cursor 第二参数、bindparams） | 漏洞 | 安全 |
| ORM filter/get 安全使用 | 漏洞 | 安全 |
| 字段名白名单/枚举映射 | 漏洞 | 安全 |
| 非线上环境 | 漏洞 | 安全 |

### 2.6 总结判定表

| 检查项 | 结论 |
|--------|------|
| 参数化查询 / int 类型 / ORM filter / 字段名白名单 | 安全 |
| f-string/format/% SQL 拼接 + 无防护 | 漏洞 |
| 黑名单/转义防护 | 风险-B |
| 内部方法无 HTTP 入口 | 风险-A |

---

## 3. 常见漏洞/风险场景

```python
# 场景1：f-string/format/% 值拼接
name = request.GET.get('name')
sql = f"SELECT * FROM users WHERE name = '{name}'"  # 漏洞

# 场景2：ORDER BY 字段名拼接（高危）
sort = request.GET.get('sort')
sql = f"SELECT * FROM users ORDER BY {sort}"  # 漏洞

# 场景3：Django filter(**dict) 注入
data = json.loads(request.body)
User.objects.filter(**data)  # 漏洞：参数名可控，可用 lookup 语法

# 场景4：Django Q 对象字段名拼接
Q(**{f"{field}__icontains": value})  # 漏洞：字段名无白名单

# 场景5：表名动态拼接
sql = f"SELECT * FROM user_{order_type}_orders"  # 漏洞：表名拼接

# 场景6：风险-B（弱防护）
name = request.GET.get('name').replace("'", "''")  # 转义不完整
sql = f"SELECT * FROM users WHERE name = '{name}'"
```

---

## 4. 常见防御模式

### 参数化查询

```python
cursor.execute("SELECT * FROM users WHERE id = %s", (user_id,))              # cursor 参数化
text("SELECT * FROM users WHERE name = :name").bindparams(name=username)      # SQLAlchemy
User.objects.filter(name=username)                                             # Django ORM
```

### 类型约束

```python
user_id = int(request.GET.get('id'))
sql = f"SELECT * FROM users WHERE id = {user_id}"  # 安全：int 类型
```

### 字段名白名单

```python
ALLOWED_COLUMNS = {'id', 'name', 'created_at'}
if column not in ALLOWED_COLUMNS: raise ValueError("Invalid column")
sql = f"SELECT * FROM users ORDER BY {column}"  # 安全：白名单
```

### Django ORM Column 可控函数

| 方法 | 风险 | 安全方式 |
|------|------|----------|
| `order_by(user_field)` | 漏洞 | `order_by("name")` / `order_by(whitelist[sort])` |
| `extra(select/where/tables=...)` | 漏洞 | 避免 extra，用 annotate |
| `Q(**{field: value})` | 漏洞（字段名可控） | 固定字段名 |
| `raw(f"...{col}...")` | 漏洞 | `raw("...WHERE id=%s", [id])` |

---

## 5. 检索技巧

| 类型 | 关键词 |
|------|--------|
| SQL 执行 | `cursor.execute`, `session.execute`, `db.execute` |
| f-string 拼接 | `f".*{.*}.*execute` |
| raw SQL | `.raw(`, `.extra(` |
| ORDER BY 拼接 | `ORDER BY.*{` |
| Django ORM | `objects.filter`, `objects.raw`, `objects.extra` |

```bash
grep -rn "cursor\.execute\|session\.execute\|db\.execute" --include="*.py"
grep -rn "f\".*{.*}.*\"\s*execute" --include="*.py"
grep -rn "\.raw(\|\.extra(" --include="*.py"
grep -rn "ORDER BY.*{" --include="*.py"
```

---

## 6. 常见误判场景

### 陷阱1：参数化误判为拼接

**错误**: 看到 `%s` 就认为是字符串拼接
**正确**: `cursor.execute(sql, args)` 第二参数是元组 → 参数化 → **安全**

```python
cursor.execute("...WHERE name = %s", (name,))   # 安全：参数化占位符
cursor.execute("...WHERE name = '%s'" % name)    # 漏洞：字符串拼接
```

### 陷阱2：ORM 默认安全误判

**错误**: 看到 ORM 就认为安全
**正确**: `raw()`/`extra()` 直接执行原生 SQL → **漏洞**

### 陷阱3：字段名拼接漏报

**错误**: 看到拼接就假设有白名单保护
**正确**: 追踪字段名来源，无白名单/枚举/Map → **漏洞**

### 陷阱4：Django filter(**dict) 误判

**错误**: 看到 `filter()` 就认为安全
**正确**: `**dict` 展开时键和值都来自用户 → **漏洞**（`filter(name=x)` 固定字段名才安全）

### 陷阱5：先看防护后看漏洞本质

**错误**: 发现 A 有过滤、B 没有 → B 有风险
**正确**: 先判断漏洞是否存在（参数化查询 → 无 SQL 注入），漏洞不存在时防护问题无从谈起

### 陷阱6：被代码对比干扰

**错误**: A 有白名单，B 没有 → B 有风险
**正确**: 代码不一致 ≠ 安全问题，先看漏洞是否存在再谈防护缺失

### 陷阱7：忽略解析函数的隐式约束

**错误**: 看到 str 拼接 → 漏洞
**正确**: 经过 `int()`/`float()`/`datetime.strptime()`/`uuid.UUID()` 等解析函数后，输出值已被约束 → **安全**（解析失败抛 ValueError）

---

## 7. 特殊风险

### Django extra() 注入

```python
User.objects.extra(where=[f"u.{field} = '{value}'"])   # 漏洞：where 子句拼接
User.objects.extra(select={col: "value"})                # 漏洞：select 子句拼接
User.objects.extra(tables=[f"app_{table}"])              # 漏洞：tables 子句拼接
```

### NoSQL 操作符注入

```python
db.users.find({'name': {'$regex': user_input}})  # 漏洞：$regex 用户可控
db.users.find({field: {'$ne': value}})            # 漏洞：字段名/$ne 可控
```

### 参数化不正确使用

```python
cursor.execute("SELECT * FROM users WHERE name = '%s'" % name, (name,))  # 风险-B：已拼接
cursor.execute(f"SELECT * FROM users WHERE name = '{name}'")              # 漏洞：f-string
```

---

## 8. 变更影响分析

| 变更类型 | 变更内容 | 风险 |
|----------|----------|------|
| 新增 | 新增 SQL 拼接 | 是否参数化、字段名是否有白名单 |
| 新增 | 新增 SQLAlchemy/Django ORM 调用 | filter 参数化安全；raw/extra 需检查 |
| 修改 | 从参数化改为 f-string/format 拼接 | 引入漏洞 |
| 修改 | 移除白名单检查 | 扩大攻击面 |
| 删除 | 删除白名单校验 | 移除防护 |
| 删除 | 删除环境判断 | 可能在线上执行 |

---

## 9. 质量门禁（强制执行）

在输出审计结论前，按顺序验证：

- [ ] 强制执行顺序已遵守（先检查 SQL 拼接）
- [ ] 参数化 vs 拼接已区分（`%s` 是占位符还是拼接）
- [ ] int/float 类型约束已检查
- [ ] ORM 方法已确认（filter vs raw/extra）
- [ ] HTTP 入口可达性已确认，非假设
- [ ] sink 点代码已实际读取，非仅凭函数名判断
- [ ] 结论与证据一致，代码行号可追溯
- [ ] 已应用误报排除规则（参数化查询、类型约束、解析函数等）
- [ ] 不因代码对比而判定风险

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**
