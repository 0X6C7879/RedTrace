# NoSQL 注入

## 0. 黄金法则

> **漏洞存在性判断 优先于 防护有效性判断**
>
> 参数化查询 / 类型约束 = 无 NoSQL 注入（这是漏洞本质判断，不是防护有效判断）
>
> 满足此条件时：立即终止分析，无需检查任何防护措施。

**强制执行顺序**：
1. **首先**：确认执行环境（前端 vs Node.js 后端）
2. **然后**：确认查询方式（参数化 vs 操作符注入）
3. **仅当** 非参数化且用户可控时，才检查防护
4. **禁止**：一上来就检查"有没有白名单"

---

## 1. 结论判断标准

| 结论 | 定义 | 判定条件 |
|------|------|----------|
| **漏洞** | 用户输入到达 NoSQL 操作，无有效防护 | 操作符注入/条件拼接 + 用户可控 + HTTP 入口 + 无防护 |
| **风险-A** | 危险 NoSQL 操作但无 HTTP 入口可达 | 危险操作 + 无外部入口 |
| **风险-B** | 有入口但防护不充分 | 仅黑名单过滤 |
| **安全** | 参数化查询 / 类型约束 / 前端代码 | Mongoose 参数化 / ObjectId / number / 白名单 |

---

## 2. 研判思路

### 2.1 Sink 点识别（第一优先级）

| Sink 点 | 危险级别 |
|---------|----------|
| `Model.find(req.query)` / `Model.find(req.body)` | 高（直接传递） |
| `$where` / `$ne` / `$gt` / `$regex` / `$expr` 操作符 | 高 |
| `JSON.parse(userInput)` 作为查询条件 | 高 |
| `Model.find({ field: value })` 参数化 | 安全 |

### 2.2 研判流程

```
Step 1: 环境检查 【终止点】
  ├─ 前端代码？ → 安全（终止）
  └─ Node.js 后端 → 继续

Step 2: 查询方式检查 【终止点】
  ├─ where 参数化对象（{ field: value }）/ findById / findOne？ → 安全（终止）
  ├─ req.query / req.body 直接传递为查询条件？ → 漏洞
  ├─ 使用 $where/$ne/$gt/$regex/$expr？ → 漏洞
  └─ JSON.parse 作为查询条件？ → 漏洞

Step 3: 类型约束检查 【终止点】
  ├─ ObjectId 转换（new ObjectId(id)）？ → 安全（终止）
  ├─ number/boolean / parseInt 转换？ → 安全（终止）
  └─ string 类型 → 继续

Step 4: 防护措施检查
  ├─ 字段名白名单（ALLOWED_FIELDS.includes()）？ → 安全（终止）
  ├─ 严格正则白名单？ → 安全（终止）
  ├─ 仅黑名单过滤？ → 风险-B
  └─ 无防护 → 漏洞
```

### 2.3 降级条件表

| 条件 | 原结论 | 降级后 |
|------|--------|--------|
| 前端代码 | 漏洞 | 安全 |
| 参数化查询（{ field: value }） | 漏洞 | 安全 |
| 类型约束（ObjectId/number/parseInt） | 漏洞 | 安全 |
| 字段名白名单 | 漏洞 | 安全 |
| 仅黑名单过滤 | 漏洞 | 风险-B |
| 无 HTTP 入口 | 漏洞 | 风险-A |

---

## 3. 常见漏洞/风险场景

### 漏洞

```javascript
// 直接传递请求体为查询条件
User.find(req.body);  // 漏洞：可注入 {"$ne": ""}

// 直接传递查询参数
User.find({ name: req.query.name });  // 可注入 {"$regex": ".*"}

// $where 注入
User.find({ $where: `this.name === '${input}'` });  // 漏洞
```

---

## 4. 常见防御模式

### 参数化查询

```javascript
User.find({ _id: new ObjectId(req.params.id) });  // 安全
User.findById(req.params.id);  // 安全
```

### 类型约束 / 白名单

```javascript
const id = new ObjectId(req.params.id);  // 安全：类型转换
const age = parseInt(req.query.age, 10);  // 安全

// 字段名白名单
const ALLOWED_FIELDS = ['name', 'email', 'age'];
const filter = {};
for (const key of Object.keys(req.query)) {
    if (ALLOWED_FIELDS.includes(key)) filter[key] = req.query[key];
}  // 安全
```

---

## 5. 检索技巧

### 搜索关键词

| 类型 | 关键词 |
|------|--------|
| 查询操作 | `Model.find(`, `Model.findOne(`, `Model.aggregate(` |
| 操作符 | `$where`, `$ne`, `$gt`, `$regex`, `$expr` |
| 危险传递 | `req.query`, `req.body`, `JSON.parse` |

### 检测命令

```bash
grep -rn "\.find(req\.\|\.findOne(req\." --include="*.js"
grep -rn '\$where\|\$ne\|\$gt\|\$regex' --include="*.js"
```

---

## 6. 常见误判场景

### 陷阱1：前端代码误判

**错误**: 看到数据库操作就认为有注入
**正确**: 前端代码无数据库 → 安全

### 陷阱2：参数化查询误判

**错误**: 看到用户输入就认为注入
**正确**: `{ field: value }` 参数化，value 是具体值不是操作符 → 安全

### 陷阱3：类型转换忽略

**错误**: 看到 string 参数就认为注入
**正确**: 经过 `new ObjectId()` / `parseInt()` 转换后无法注入操作符 → 安全

---

## 7. 特殊风险

### 前端 vs 后端环境

Node.js 后端执行 MongoDB 操作 → 可构成 NoSQL 注入漏洞。前端浏览器执行 → 无安全风险（前端代码可在开发者工具中修改，无法构成服务器端漏洞）。

---

## 8. 变更影响分析

| 变更类型 | 变更内容 | 风险 |
|----------|----------|------|
| 新增 | 新增 Model.find(req.body) | 直接传递，高危 |
| 修改 | 从参数化改为直接传递 | 引入注入风险 |
| 修改 | 移除类型转换 | 引入注入风险 |

---

## 9. 质量门禁（强制执行）

在输出审计结论前，按顺序验证：

- [ ] 执行环境已确认（前端 vs 后端）
- [ ] 查询方式已确认（参数化 vs 操作符注入）
- [ ] 类型约束已检查
- [ ] HTTP 入口可达性已确认
- [ ] 结论与证据一致，代码行号可追溯

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**
