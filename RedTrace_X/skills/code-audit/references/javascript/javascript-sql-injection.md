# SQL 注入

## 0. 黄金法则

> **漏洞存在性判断 优先于 防护有效性判断**
>
> 参数不拼接 SQL = 无 SQL注入（漏洞本质判断，不是防护有效判断）。
> 满足此条件时：立即终止分析，无需检查任何防护措施。
>
> 检查防护前必须先回答：
> 1. 这个防护防的是什么漏洞？
> 2. 这个漏洞是否存在？
>
> **如果漏洞不存在，防护缺失就不再是问题。**

---

## 1. 结论判断标准

| 结论 | 定义 | 判定条件 |
|------|------|----------|
| **漏洞** | 用户输入可通过 HTTP 入口到达数据库操作，无有效防护 | 1. 存在 SQL 拼接或 NoSQL 操作符注入; 2. 用户可控制 SQL/查询条件; 3. 数据流可追踪到 HTTP 入口点; 4. 无有效防护措施 |
| **风险-A** | 危险数据库操作但无 HTTP 入口可达（内部调用） | 1. 存在危险操作; 2. 数据流不可追踪到外部入口; 3. 非测试/非配置代码 |
| **风险-B** | 危险数据库操作有 HTTP 入口可达，但防护措施不充分 | 1. 存在危险操作; 2. HTTP 入口可达; 3. 有弱防护（如仅黑名单过滤） |
| **安全** | 无危险写法，或危险写法有充分的有效防护 | 1. ORM 参数化/自动转义，或; 2. 类型约束/白名单等有效防护，或; 3. 前端无数据库 |

---

## 2. 研判思路

### 2.1 树形 SOP

```
开始
├─ 前端代码？ → 安全（前端无数据库）
└─ Node.js 后端
   ├─ ORM where 参数化（对象形式）？ → 安全
   ├─ 类型约束（number/boolean）？ → 安全
   ├─ NoSQL（Mongoose 等）
   │  ├─ find(req.query)/find(JSON.parse(input)) → 漏洞
   │  ├─ $where 拼接用户输入 → 漏洞
   │  └─ 安全查询方式 → 安全
   ├─ literal/raw/query 拼接
   │  ├─ 模板字符串/+/concat/replace 拼接用户输入
   │  │  ├─ number/parseInt/Number 转换 → 安全
   │  │  ├─ 字段名/表名拼接
   │  │  │  ├─ 白名单校验 → 安全
   │  │  │  └─ 无白名单 → 漏洞
   │  │  ├─ 值拼接
   │  │  │  ├─ 严格转义/escape → 安全
   │  │  │  ├─ 黑名单过滤 → 风险-B
   │  │  │  └─ 无防护 → 漏洞
   │  │  └─ 解析函数隐式约束（Number/parseInt/new Date） → 安全
   │  └─ 固定字符串/无拼接 → 安全
   └─ 无 HTTP 入口可达 → 风险-A
```

### 2.2 拼接模式识别

| 模式 | 检测特征 | 风险 | 示例 |
|------|---------|------|------|
| 模板字符串 | `` `${...}` `` | 高 | `` `SELECT * FROM users WHERE name = '${name}'` `` |
| 字符串拼接 | `+`, `+=` | 高 | `"SELECT * FROM users WHERE name = '" + name + "'"` |
| concat 方法 | `.concat()` | 高 | `"SELECT".concat(" * FROM users")` |
| 动态替换 | `.replace()` / `.replaceAll()` | 中 | `sql.replace("{table}", tableName)` |

### 2.3 类型约束

以下类型拼接 SQL 时无风险：

| 类型 | 判定 | 说明 |
|------|------|------|
| `number` / `boolean` | 安全 | 无法包含 SQL 语法 |
| `number[]` | 安全 | 数字数组 |
| `parseInt()` / `Number()` 转换后 | 安全 | 输出已被约束 |
| `new Date()` + `.toISOString()` | 安全 | 输出固定格式 |

注意：`xxId` 参数名看似 number 但需检查实际类型；TypeScript 类型标注不代表运行时安全。

### 2.4 总结判定表

| 顺序 | 检查项 | 结论 | 后续 |
|------|--------|------|------|
| 1 | 前端代码 / ORM 参数化 / 类型约束？ | 安全 | **终止** |
| 2 | 字段名白名单？ | 安全 | 终止 |
| 3 | 解析函数隐式约束（Number/parseInt/new Date）？ | 安全 | 终止 |
| 4 | literal/raw 拼接用户输入 + 无防护？ | 漏洞 | - |
| 5 | MongoDB find(req.query) / $where / JSON.parse？ | 漏洞 | - |
| 6 | 字段名/表名拼接无白名单？ | 漏洞 | - |
| 7 | 黑名单过滤？ | 风险-B | - |
| 8 | 无 HTTP 入口？ | 风险-A | - |

---

## 3. 常见漏洞/风险场景

### 漏洞

**SQL literal/raw 拼接**：
```javascript
// Sequelize literal
User.findAll({ where: sequelize.literal(`name = '${req.query.name}'`) });
// Knex raw
knex.raw(`SELECT * FROM users WHERE name = '${req.query.name}'`);
// 原生驱动
connection.query(`SELECT * FROM users WHERE name = '${name}'`);
```

**NoSQL 操作符注入**：
```javascript
User.find(req.query);                                    // 攻击: username[$ne]=null
User.find({ $where: `this.username === '${name}'` });    // 代码执行
User.find(JSON.parse(input));                             // JSON 注入
```

**字段名/表名拼接**：
```javascript
db.query(`SELECT * FROM users ORDER BY ${req.query.sort}`);           // 字段名注入
db.query(`SELECT * FROM user_${req.query.type}_orders`);              // 表名注入
```

**动态查询构建**：
```javascript
for (const item of filters) {
    sql += ` AND ${item.field} = '${item.value}'`;  // 字段名+值双拼
}
```

### 风险-A（无 HTTP 入口）

```javascript
// 内部方法，需追踪调用方
async function findUserByName(name) {
    return User.findAll({ where: sequelize.literal(`name = '${name}'`) });
}
```

### 风险-B（防护不足）

```javascript
const blacklist = ['SELECT', 'UNION', 'DROP'];
if (!blacklist.some(word => name.includes(word))) {
    User.findAll({ where: sequelize.literal(`name = '${name}'`) });  // 黑名单可绕过
}
```

---

## 4. 常见防御模式

### ORM 参数化（安全）
```javascript
User.findAll({ where: { name: req.query.name } });   // Sequelize
User.find({ field: value });                          // Mongoose
knex('users').where('name', req.query.name);          // Knex
repo.find({ where: { name: value } });                // TypeORM
```

### 类型约束（安全）
```typescript
function getUser(id: number) {
    db.query(`SELECT * FROM users WHERE id = ${id}`);  // number 无法包含 SQL
}
```

### 白名单校验（安全）
```javascript
const ALLOWED = ['id', 'name', 'created_at'];
if (!ALLOWED.includes(sortColumn)) throw new Error('Invalid');
db.query(`SELECT * FROM users ORDER BY ${sortColumn}`);
```

### escape 转义（安全）
```javascript
const name = sequelize.escape(req.query.name);
sequelize.query(`SELECT * FROM users WHERE name = ${name}`);
```

### Column 可控函数清单

| 框架 | 方法 | 风险 | 结论 |
|------|------|------|------|
| Sequelize | `sequelize.literal(input)` | 高 | 用户可控→漏洞 |
| Sequelize | `sequelize.query(sql + input)` | 高 | 用户可控→漏洞 |
| Knex | `knex.raw(sql + input)` | 高 | 用户可控→漏洞 |
| Knex | `orderBy(column)` / `select(column)` | 中 | 用户可控→漏洞 |
| MongoDB | `find({[field]: value})` | 高 | 用户可控→NoSQL 注入 |

安全对照：`Sequelize.literal("'name' ASC")`（固定字段）、`knex('users').orderBy('name')`（固定字段）、`orderBy(whitelist[sort])`（白名单）

---

## 5. 检索技巧

> HTTP 入口可达性检索：详见 [JavaScript 通用检索技巧](javascript-common-retrieval.md#http-入口可达性检索)

### 搜索关键词

| 类型 | 关键词 |
|------|--------|
| Sequelize | `sequelize.literal(`, `sequelize.query(`, `.escape(` |
| Knex | `knex.raw(`, `knex.query(` |
| MongoDB | `$where:`, `JSON.parse(`, `.find(req.query)` |
| 原生驱动 | `connection.query(`, `mysql.query(`, `pg.query(` |

### 检测命令

```bash
grep -rn "sequelize\.literal\|sequelize\.query" --include="*.js"   # Sequelize
grep -rn "knex\.raw" --include="*.js"                               # Knex
grep -rn '\$where:' --include="*.js"                                # MongoDB $where
grep -rn '\.find(req\.query)\|\.find(req\.body)' --include="*.js"   # MongoDB 直接查询
grep -rn "ORDER BY.*\${\|GROUP BY.*\${" --include="*.js"            # 字段名拼接
```

---

## 6. 常见误判场景

### 陷阱1：前端代码误判

**错误**：看到前端有数据库操作就判漏洞
**正确**：前端无数据库，通过 HTTP API 与后端通信 → 安全

### 陷阱2：ORM where 参数化误判

**错误**：看到用户输入传入 where 就判为 SQLi
**正确**：`where: { field: value }` 对象形式会自动参数化 → 安全

### 陷阱3：number 类型拼接误判

**错误**：看到字符串拼接就判为 SQLi
**正确**：number 类型只能包含数字，无法包含 SQL 语法字符 → 安全

### 陷阱4：先看防护后看漏洞本质

**错误思路**：发现参数没有过滤函数 → 判定风险
**正确思路**：先判断漏洞是否存在（是否拼接 SQL），漏洞不存在时防护问题无从谈起

### 陷阱5：被代码对比干扰

**错误**：A 路由有过滤、B 路由没有 → 判定风险
**正确**：先看漏洞是否存在（是否拼接 SQL），代码不一致 ≠ 安全问题

### 陷阱6：忽略解析函数隐式约束

**错误**：看到 string 类型拼接到 SQL 就判漏洞，忽略参数经过了解析函数
**正确**：`Number()`、`parseInt()`、`new Date()` 等解析函数输出已被约束为安全格式 → 安全

```javascript
// 安全：经过解析函数约束
const safeDate = new Date(req.query.date).toISOString().slice(0, 10);
query += ` AND date = '${safeDate}'`;  // 输出固定 YYYY-MM-DD

// 漏洞：无转换直接拼接
query += ` AND name LIKE '%${req.query.keyword}%'`;
```

---

## 7. 特殊风险

### NoSQL 操作符注入

MongoDB 查询对象直接接受用户输入时，攻击者可注入查询操作符绕过认证：

```javascript
// User.find(req.query) 攻击载荷: username[$ne]=null&password[$ne]=null
// 绕过所有认证，返回第一条用户记录
```

### Sequelize literal / Knex raw 安全用法对比

```javascript
// 漏洞：直接拼接
Sequelize.literal(`'${req.query.sort}'`)
knex.raw(`SELECT ${req.query.col} FROM users`)

// 安全：replacements 参数化
sequelize.query(`SELECT * FROM users WHERE name = ?`, { replacements: [keyword] });
knex.raw(`SELECT * FROM users WHERE name = ?`, [keyword]);

// 安全：固定值
Sequelize.literal("'name' ASC")
knex('users').orderBy('name')
```

---

## 8. 变更影响分析

| 变更类型 | 变更内容 | 风险 |
|----------|----------|------|
| 新增 | 新增 SQL 拼接 | 是否参数化、字段名是否有白名单 |
| 新增 | 新增 Sequelize/TypeORM 调用 | 参数化安全；raw query 需检查 |
| 修改 | 从参数化改为拼接 | 引入漏洞 |
| 修改 | 移除白名单检查 | 扩大攻击面 |
| 删除 | 删除白名单校验 | 移除防护 |
| 删除 | 删除环境判断 | 可能在线上执行 |

---

## 9. 质量门禁

在输出审计结论前，按顺序验证：

- [ ] 前端/后端环境已识别（前端无数据库→安全）
- [ ] ORM 查询方式已确认（参数化 vs literal/raw）
- [ ] 拼接模式已识别（模板字符串/+/concat/replace）
- [ ] 类型约束已检查（number/boolean vs string）
- [ ] 解析函数隐式约束已检查（Number/parseInt/new Date）
- [ ] 黄金法则已遵循：先确认 SQL 拼接，再检查防护
- [ ] HTTP 入口可达性已确认（非假设）
- [ ] 结论与证据一致，代码行号可追溯

**禁止**：
- 先看防护后看漏洞本质（违反黄金法则）
- 看到 where 就判 SQLi（需确认是否参数化）
- 看到拼接就判 SQLi（需检查类型约束）
- 假设白名单存在但未找到代码

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**
