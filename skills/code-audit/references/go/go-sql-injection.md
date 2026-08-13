# SQL 注入

## 0. 黄金法则

> **漏洞存在性判断 优先于 防护有效性判断**
>
> 参数不拼接 SQL = 无 SQL 注入（这是漏洞本质判断，不是防护有效判断）
>
> 满足此条件时：立即终止分析，无需检查任何防护措施。

**强制执行顺序**：
1. **首先**：找到 sink 点 SQL 执行代码（如 `db.Raw()`, `db.Exec()`, `db.Order()`）
2. **然后**：分析用户输入是否拼接进 SQL 语句
3. **仅当** SQL 拼接时，才继续检查防护措施
4. **禁止**：一上来就检查"有没有过滤"、"A 有 B 没有"

---

## 1. 结论判断标准

| 结论 | 定义 | 判定条件 |
|------|------|----------|
| **漏洞** | 用户输入可通过 HTTP/gRPC 到达 SQL 执行点，SQL 结构用户可控 | 1. 存在 SQL 执行调用; 2. SQL 用户可控; 3. HTTP/gRPC 入口可达; 4. 无有效防护 |
| **风险-A** | 存在 SQL 拼接但无 HTTP/gRPC 入口可达 | 1. 存在 SQL 拼接; 2. 无外部入口; 3. 非测试代码 |
| **风险-B** | SQL 拼接有 HTTP 入口可达，但防护不充分 | 1. 存在 SQL 拼接; 2. HTTP 入口可达; 3. 仅有弱防护 |
| **安全** | 参数不拼接 SQL，或有充分防护 | GORM 参数化 / int 类型约束 / 字段名白名单 / 非线上环境 |

---

## 2. 漏洞风险的研判思路

### 2.1 GORM 使用检查（第一优先级）

| GORM 调用方式 | 示例 | 判定 |
|--------------|------|------|
| `db.Where(&Struct{...})` | `db.Where(&User{Name: name})` | 安全 |
| `db.Where("field = ?", value)` | `db.Where("name = ?", name)` | 安全 |
| `db.Where(map[string]interface{}{...})` | `db.Where(map{...})` | 安全（Go 独有） |
| `db.Raw(sql + input)` | `db.Raw("SELECT * FROM users WHERE name = '" + name + "'")` | 漏洞 |
| `db.Order(userInput)` | `db.Order(sortColumn)` | 漏洞（字段名拼接） |

### 2.2 SQL 拼接模式识别

| 模式类型 | 检测特征 | 风险级别 | 示例 |
|---------|---------|----------|------|
| 字符串拼接 | `+`, `+=` | 高 | `"SELECT * FROM users WHERE name = '" + name + "'"` |
| 格式化方法 | `fmt.Sprintf` | 高 | `fmt.Sprintf("SELECT * FROM users WHERE name = '%s'", name)` |
| 构造器 | `strings.Builder`, `.WriteString()` | 高 | `b.WriteString("WHERE id = "); b.WriteString(id)` |
| 动态替换 | `.Replace()` | 中 | `query.Replace("{id}", userId)` |

```go
// 危险模式
sql := "SELECT * FROM users WHERE name = '" + name + "'"           // 漏洞
sql := fmt.Sprintf("SELECT * FROM users WHERE name = '%s'", name)  // 漏洞
sql := fmt.Sprintf("SELECT * FROM %s WHERE id = %d", table, id)   // 漏洞（表名拼接）

// 安全模式
db.Where("name = ?", name).First(&user)  // 参数化
db.Where(&User{Name: name}).First(&user) // struct 自动预编译
```

### 2.3 类型约束检查

| 类型 | 判定 | 示例 |
|------|------|------|
| `int`, `int64`, `uint` | 安全 | `func getUser(id int64)` |
| `float64` | 安全 | `func setPrice(price float64)` |
| `bool` | 安全 | `func setActive(active bool)` |
| `time.Time` | 通常安全 | `func findByDate(t time.Time)` |
| `[]int64` | 安全 | `func findByIds(ids []int64)` |

> `strconv.Atoi()` / `strconv.ParseInt()` 转换后的值是安全的。

### 2.4 研判流程

```
Step 1: 类型约束检查
  ├─ int/uint/float/bool 类型？ → 安全（终止）
  └─ 其他类型 → 继续

Step 2: GORM 使用检查
  ├─ Where + struct/map/参数化？ → 安全（终止）
  ├─ Raw/Order/Table/Select 拼接 → 继续
  └─ 非 GORM 拼接 → 继续

Step 3: 防护措施检查
  ├─ 字段名白名单？ → 安全（终止）
  ├─ 仅正则校验？ → 风险-B
  └─ 无防护 → 继续

Step 4: HTTP 入口可达性
  ├─ 无 HTTP/gRPC 入口？ → 风险-A
  └─ 有入口 → 漏洞
```

### 2.5 降级条件表

| 条件 | 原结论 | 降级后 |
|------|--------|--------|
| int/uint 类型约束 | 漏洞 | 安全 |
| GORM struct/map/参数化 | 漏洞 | 安全 |
| 字段名白名单 | 漏洞 | 安全 |
| 仅正则校验字段名 | 漏洞 | 风险-B |
| 非线上环境 | 漏洞 | 安全 |

### 2.6 总结判定表

| 检查项 | 结论 |
|--------|------|
| GORM 参数化 / int 类型 / 字段名白名单 | 安全 |
| Raw/Order 拼接 + 无防护 | 漏洞 |
| 仅正则校验字段名 | 风险-B |
| 内部方法无 HTTP 入口 | 风险-A |

---

## 3. 常见漏洞/风险场景

### 场景1：SQL 值拼接

```go
query := fmt.Sprintf("SELECT * FROM users WHERE name = '%s'", name)
db.Raw(query).Scan(&user)
// 漏洞：值拼接，无防护
```

### 场景2：GORM 字段名/表名拼接

```go
db.Order(sortColumn).Find(&users)       // 漏洞：排序字段拼接
db.Table(tableName).Find(&results)      // 漏洞：动态表名
db.Select(columns).Find(&users)         // 漏洞：动态列
```

### 场景3：仅正则校验字段名

```go
matched, _ := regexp.MatchString("^[a-zA-Z0-9_]+$", col)
// 风险-B：正则可能允许 SQL 关键字
```

---

## 4. 常见防御模式

### GORM 参数化

```go
db.Where(&User{Name: name}).First(&user)           // struct
db.Where("name = ?", name).First(&user)             // 参数化
db.Where(map[string]interface{}{"name": name})       // map
db.Raw("SELECT * FROM users WHERE id = ?", id)       // Raw 参数化
```

### 类型约束

```go
id, _ := strconv.Atoi(c.Param("id"))
query := fmt.Sprintf("SELECT * FROM users WHERE id = %d", id) // 安全
```

### 字段名白名单

```go
var allowedSorts = map[string]string{"name_asc": "name ASC", "name_desc": "name DESC"}
sortClause, ok := allowedSorts[userInput]
if !ok { sortClause = "id" }
db.Order(sortClause).Find(&users)
```

### GORM Column 可控函数

| 方法 | 风险 | 安全方式 |
|------|------|----------|
| `db.Order(userInput)` | 漏洞 | `db.Order(whitelist[input])` |
| `db.Select(userInput)` | 漏洞 | `db.Select("id", "name")` |
| `db.Table(userInput)` | 漏洞 | `db.Table("fixed_table")` |
| `db.Raw(sql + input)` | 漏洞 | `db.Raw("...WHERE id=?", id)` |

---

## 5. 检索技巧

| 类型 | 关键词 |
|------|--------|
| GORM | `db.Where`, `db.Raw`, `db.Order`, `db.Table`, `db.Select` |
| SQL 拼接 | `fmt.Sprintf.*SELECT`, `+.*SELECT` |
| 类型转换 | `strconv.Atoi`, `strconv.ParseInt` |

```bash
grep -rn "db\.Raw\|db\.Order\|db\.Table\|db\.Select" --include="*.go"
grep -rn "fmt\.Sprintf.*SELECT\|fmt\.Sprintf.*INSERT" --include="*.go"
```

---

## 6. 常见误判场景

### 陷阱1：GORM Where 误判为 SQL 注入

**错误**: 看到用户输入 + GORM Where → SQL 注入
**正确**: GORM `Where` 默认参数化，`&User{Name: name}` → `WHERE name = ?` + 参数绑定 → **安全**

### 陷阱2：GORM map 类型误判

**错误**: 看到 map → 危险
**正确**: GORM map value 自动预编译（Go 独有） → **安全**

### 陷阱3：字段名拼接漏报

**错误**: 看到 GORM → 安全
**正确**: `Order()`/`Table()`/`Select()` 参数是字段名/表名，无法参数化，直接使用用户输入 → **漏洞**

### 陷阱4：类型转换后拼接误判

**错误**: 看到字符串拼接 → SQL 注入
**正确**: `strconv.Atoi()` 转换为 `int`，int 无法包含 SQL 语法 → **安全**

### 陷阱5：忽略解析函数的隐式约束

**错误**: 看到 string 拼接 → 漏洞
**正确**: 经过 `time.Parse()`、`uuid.Parse()` 等解析函数后，输出值已被约束 → **安全**

```go
// 安全：解析函数约束输出格式
t, _ := time.Parse("2006-01-02", dateStr)
query += " AND date = '" + t.Format("2006-01-02") + "'"

// 漏洞：无转换直接拼接
query += " AND name LIKE '%" + keyword + "%'"
```

### 陷阱6：先看防护后看漏洞本质

**错误**: 发现 A 有过滤、B 没有 → B 有风险
**正确**: 先判断漏洞是否存在（GORM 参数化 → 无 SQL 注入），漏洞不存在时防护问题无从谈起

### 陷阱7：被代码对比干扰

**错误**: A 有白名单，B 没有 → B 有风险
**正确**: 先看 B 的漏洞是否存在，再谈防护缺失

---

## 7. 特殊风险

（Go 无特殊扩展 Sink，GORM 覆盖主要场景）

---

## 8. 变更影响分析

| 变更类型 | 变更内容 | 风险 |
|----------|----------|------|
| 新增 | 新增 SQL 拼接 | 是否参数化、字段名是否有白名单 |
| 新增 | 新增 GORM 调用 | Where/First/Find + struct/map 安全；Raw/Order/Table 需检查 |
| 修改 | 从参数化改为拼接 | 引入漏洞 |
| 修改 | 移除白名单检查 | 扩大攻击面 |
| 删除 | 删除白名单校验 | 移除防护 |
| 删除 | 删除环境判断 | 可能在线上执行 |

---

## 9. 质量门禁（强制执行）

在输出审计结论前，按顺序验证：

- [ ] 强制执行顺序已遵守（先检查 SQL 拼接）
- [ ] GORM 使用方式已确认（Where vs Raw/Order）
- [ ] int/uint 类型约束已检查
- [ ] HTTP 入口可达性已确认，非假设
- [ ] 结论与证据一致，代码行号可追溯
- [ ] 已应用误报排除规则（GORM 参数化、类型约束等）
- [ ] 不因代码对比而判定风险

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**
