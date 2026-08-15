# 原型污染

## 0. 黄金法则

> **漏洞存在性判断 优先于 防护有效性判断**
>
> Object.create(null) 目标 / Map/Set 目标 = 无 原型污染（这是漏洞本质判断，不是防护有效判断）
>
> 满足此条件时：立即终止分析，无需检查任何防护措施。

**强制执行顺序**：
1. **首先**：确认目标对象类型（普通 Object vs null 原型 / Map）
2. **然后**：确认来源是否用户可控
3. **仅当** 普通目标 + 用户可控时，才检查防护
4. **禁止**：一上来就检查"有没有过滤 __proto__"

---

## 1. 结论判断标准

| 结论 | 定义 | 判定条件 |
|------|------|----------|
| **漏洞** | 用户输入到达对象合并，可污染原型链 | 危险合并 + 用户可控 + 普通 Object 目标 + 无防护 |
| **风险-A** | 危险合并但无 HTTP 入口可达 | 危险操作 + 无外部入口 |
| **风险-B** | 有入口但防护不充分 | 仅黑名单过滤 |
| **安全** | 无危险写法，或有充分防护 | Object.create(null) / Map / 白名单 / hasOwn 检查 |

---

## 2. 研判思路

### 2.1 Sink 点识别（第一优先级）

| Sink 点 | 危险级别 |
|---------|----------|
| `Object.assign(target, userInput)` | 高 |
| `_.merge(target, userInput)` / `_.defaultsDeep` | 高 |
| 自定义递归合并函数 | 高 |
| `Object.assign(Object.create(null), userInput)` | 安全 |

### 2.2 研判流程

```
Step 1: 对象合并操作识别 【终止点】
  ├─ 无对象合并操作？ → 安全（终止）
  └─ Object.assign / _.merge / 递归合并 → 继续

Step 2: 来源检查 【终止点】
  ├─ 常量/配置/硬编码？ → 安全（终止）
  └─ req.query/req.params/req.body → 继续

Step 3: 目标对象检查 【终止点】
  ├─ Object.create(null) / Map / Set？ → 安全（终止）
  └─ 普通 Object → 继续

Step 4: 防护措施检查
  ├─ 白名单属性过滤？ → 安全（终止）
  ├─ Object.hasOwn 检查？ → 安全（终止）
  ├─ 禁止 __proto__/constructor/prototype？ → 安全（终止）
  ├─ 仅黑名单过滤？ → 风险-B
  └─ 无防护 → 漏洞
```

---

## 3. 常见漏洞/风险场景

### 漏洞

```javascript
// Object.assign 直接合并用户输入
Object.assign(config, req.body);  // 漏洞：可注入 __proto__

// lodash 深度合并
_.merge({}, req.body);  // 漏洞

// 自定义递归合并
function deepMerge(target, source) {
    for (const key in source) {
        target[key] = source[key];  // 漏洞：key 可为 __proto__
    }
}
```

---

## 4. 常见防御模式

### Object.create(null) / Map

```javascript
const target = Object.create(null);  // 安全：无原型
Object.assign(target, userInput);

const target = new Map();  // 安全：Map 不受原型污染
```

### 白名单 / hasOwn / 禁止 __proto__

```javascript
// 白名单
const ALLOWED_KEYS = ['name', 'email', 'age'];
for (const key of Object.keys(req.body)) {
    if (ALLOWED_KEYS.includes(key)) config[key] = req.body[key];
}

// 禁止危险 key
if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;

// hasOwn 检查
if (Object.hasOwn(target, key)) target[key] = value;
```

---

## 5. 检索技巧

### 搜索关键词

| 类型 | 关键词 |
|------|--------|
| 合并操作 | `Object.assign`, `_.merge`, `_.defaultsDeep`, `_.extend` |
| 危险 key | `__proto__`, `constructor`, `prototype` |

### 检测命令

```bash
grep -rn "Object\.assign\|\.merge(\|\.defaultsDeep" --include="*.js"
grep -rn "__proto__\|constructor\[" --include="*.js"
```

---

## 6. 常见误判场景

### 陷阱1：Map/Set 目标误判

**错误**: 看到用户输入合并就判为原型污染
**正确**: Map/Set 不受原型链影响 → 安全

### 陷阱2：Object.create(null) 误判

**错误**: 看到 Object.assign 就判为漏洞
**正确**: 目标是 `Object.create(null)` 无原型 → 安全

### 陷阱3：常量来源误判

**错误**: 看到 _.merge 就判为漏洞
**正确**: 来源是常量/配置，非用户输入 → 安全

---

## 7. 特殊风险

### 原型污染 → RCE 攻击链

原型污染可修改全局对象属性。若污染影响了 `child_process.exec` 的参数或环境变量，可升级为 RCE。关键链路：`_.merge(config, req.body)` → `config.shell` 被污染 → `child_process.exec(cmd, config)` 使用被污染的 shell。

### Object.create(null) 与 Map 安全性

`Object.create(null)` 创建无原型的对象，天然免疫原型污染。`Map` 数据结构同理。推荐在深度合并场景中使用。

---

## 8. 变更影响分析

| 变更类型 | 变更内容 | 风险 |
|----------|----------|------|
| 新增 | 新增 Object.assign(target, req.body) | 确认目标类型 |
| 修改 | 从 Object.create(null) 改为普通 Object | 引入风险 |
| 修改 | 移除 __proto__ 过滤 | 移除防护 |

---

## 9. 质量门禁（强制执行）

在输出审计结论前，按顺序验证：

- [ ] 目标对象类型已确认（普通 Object vs null 原型 / Map）
- [ ] 来源是否用户可控已确认
- [ ] 防护措施完整性已确认
- [ ] HTTP 入口可达性已确认
- [ ] 结论与证据一致，代码行号可追溯

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**
