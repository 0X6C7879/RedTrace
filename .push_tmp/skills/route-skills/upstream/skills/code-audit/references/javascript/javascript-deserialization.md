# 反序列化

## 0. 黄金法则

> **漏洞存在性判断 优先于 防护有效性判断**
>
> 普通 JSON.parse（不用于对象合并）= 无反序列化漏洞（这是漏洞本质判断，不是防护有效判断）
>
> 满足此条件时：立即终止分析，无需检查任何防护措施。

**强制执行顺序**：
1. **首先**：识别反序列化 API 类型（node-serialize/eval vs JSON.parse）
2. **然后**：判断是 RCE 类还是原型污染类
3. **仅当** 使用危险 API 或 JSON.parse + 对象合并时，才继续检查防护措施
4. **禁止**：一上来就检查"有没有白名单"

**JavaScript 两大攻击类型**：
- **RCE**：node-serialize.unserialize / eval / Function / vm.runIn* — 可直接执行代码
- **原型污染**：Object.assign/_.merge + JSON.parse(userInput) — 污染 Object.prototype

---

## 1. 结论判断标准

| 结论 | 定义 | 判定条件 |
|------|------|----------|
| **漏洞** | 用户可控输入到达危险反序列化 API，可导致 RCE 或原型污染 | 1. 存在危险操作; 2. 数据流可追踪到 HTTP 入口; 3. 无有效防护 |
| **风险-A** | 存在危险操作但无 HTTP 入口可达 | 1. 存在危险操作; 2. 数据流不可追踪到外部入口 |
| **风险-B** | 有 HTTP 入口可达，但防护不充分 | 1. 存在危险操作; 2. HTTP 入口可达; 3. 有弱防护（黑名单等） |
| **安全** | 无危险写法，或有充分防护 | 1. JSON.parse 普通使用; 2. 白名单属性; 3. Object.create(null)/Map; 4. 签名验证 |

---

## 2. 漏洞风险的研判思路

### 2.1 反序列化 API 识别（第一优先级）

| API | 危险等级 | 说明 |
|-----|----------|------|
| `node-serialize.unserialize()` | 极高 | 可 RCE |
| `serialize-to-js.unserialize()` 无 safe | 极高 | 可 RCE |
| `eval()` / `Function()` / `vm.runIn*()` | 极高 | 任意代码执行 |
| `msgpack.decode()` | 高 | 取决于配置 |
| `Object.assign()` + `JSON.parse(userInput)` | 中高 | 原型污染 |
| `_.merge()` + 用户输入 | 中高 | 原型污染 |
| 普通 `JSON.parse()` | 低 | 默认安全，除非用于对象合并 |

### 2.2 研判流程

```
Step 1: 环境检查
  ├─ 非线上环境？ → 安全
  └─ 线上环境/无判断 → 继续

Step 2: API 识别
  ├─ eval / Function / vm.runIn*？ → 漏洞
  ├─ node-serialize.unserialize(userInput)？ → 漏洞
  ├─ serialize-to-js.unserialize(userInput) 无 safe？ → 漏洞
  ├─ Object.assign/_.merge + JSON.parse(userInput)？ → 继续原型污染检查
  ├─ JSON.parse 普通使用？ → 安全
  └─ 其他 → 继续

Step 3: 原型污染检查（仅对象合并场景）
  ├─ Object.create(null) 目标？ → 安全
  ├─ Map/Set 目标？ → 安全
  ├─ 白名单属性？ → 安全
  ├─ 仅黑名单过滤？ → 风险-B
  └─ 普通 Object 目标无防护？ → 漏洞

Step 4: 数据来源检查
  ├─ 来自常量/配置文件/环境变量？ → 安全
  └─ 用户输入/来源不明 → 继续

Step 5: HTTP 入口可达性
  ├─ 无 HTTP 入口？ → 风险-A
  └─ 有 HTTP 入口 → 漏洞/风险-B
```

### 2.3 降级条件表

| 条件 | 原结论 | 降级后 |
|------|--------|--------|
| Object.create(null) / Map 目标 | 漏洞 | 安全 |
| 白名单属性 | 漏洞 | 安全 |
| serialize-to-js `safe: true` | 漏洞 | 安全 |
| 数据来自配置文件 | 漏洞 | 安全 |
| 签名验证有效 | 漏洞 | 安全 |
| 仅黑名单过滤 | 漏洞 | 风险-B |
| 无 HTTP 入口 | 漏洞 | 风险-A |

### 2.4 总结判定表

| 检查项 | 结论 |
|--------|------|
| JSON.parse 普通使用（不用于对象合并） | 安全 |
| Object.create(null) / Map / 白名单属性 | 安全 |
| eval / Function / vm.runIn* + 用户输入 | 漏洞 |
| node-serialize.unserialize(userInput) | 漏洞 |
| Object.assign(target, JSON.parse(userInput)) 普通 Object | 漏洞（原型污染） |
| _.merge(target, userInput) 普通 Object | 漏洞（原型污染） |
| 仅黑名单过滤 | 风险-B |
| 无 HTTP 入口 | 风险-A |

---

## 3. 常见漏洞/风险场景

### 场景1：node-serialize RCE

```javascript
const serialize = require('node-serialize');
app.post('/data', async (req, res) => {
    const obj = serialize.unserialize(req.body.data);  // 漏洞：可 RCE
});
```

### 场景2：eval / Function 代码执行

```javascript
app.post('/config', async (req, res) => {
    const config = eval('(' + req.body.config + ')');  // 漏洞
});
```

### 场景3：JSON.parse 原型污染

```javascript
app.post('/config', async (req, res) => {
    const config = JSON.parse(req.body.data);
    Object.assign(globalConfig, config);  // 漏洞：{"__proto__": {"isAdmin": true}}
});
```

### 场景4：lodash.merge 原型污染

```javascript
const _ = require('lodash');
app.post('/preferences', async (req, res) => {
    _.merge(user.preferences, req.body);  // 漏洞：原型污染
});
```

### 场景5：风险-B（黑名单过滤）

```javascript
const blacklist = ['__proto__', 'constructor', 'prototype'];
for (const key in req.body) {
    if (!blacklist.includes(key)) { filtered[key] = req.body[key]; }
}
Object.assign(globalConfig, filtered);  // 风险-B：{"constructor": {"prototype": {...}}} 可绕过
```

---

## 4. 常见防御模式

```javascript
// JSON.parse 普通使用（安全）
const user = JSON.parse(userData);  // 仅读取属性，不用于对象合并

// Object.create(null) 防护原型污染
const safeConfig = Object.create(null);
Object.assign(safeConfig, config);  // 安全：无原型

// Map 替代（安全）
const safeMap = new Map();
for (const [key, value] of Object.entries(config)) { safeMap.set(key, value); }

// 白名单属性（安全）
const ALLOWED_KEYS = ['theme', 'language', 'timezone'];
for (const key of ALLOWED_KEYS) {
    if (req.body[key] !== undefined) { safePrefs[key] = req.body[key]; }
}

// serialize-to-js 安全模式
serialize.unserialize(userData, { safe: true });  // 安全

// 可信数据源（安全）
const config = JSON.parse(fs.readFileSync('/etc/app/config.json', 'utf8'));

// 签名验证（安全）
const hmac = crypto.createHmac('sha256', SECRET_KEY);
hmac.update(JSON.stringify(data));
if (signature !== hmac.digest('hex')) return res.status(401).json({ error: 'Invalid' });
```

---

## 5. 检索技巧

### 关键 Sink 点

| 类型 | Sink 点 | 安全方式 |
|------|---------|----------|
| node-serialize | `unserialize()` | 禁止使用 |
| serialize-to-js | `unserialize()` | `safe: true` |
| 原生 | `eval()` / `Function()` | 禁止使用 |
| vm 模块 | `vm.runIn*()` | 禁止执行用户输入 |
| 对象合并 | `Object.assign()` / `_.merge()` | 白名单或 Map |
| msgpack | `decode()` | 类型白名单 |
| JSON | `JSON.parse()` | 普通使用安全 |

### 检测命令

```bash
# 检测 node-serialize
grep -rn "node-serialize\|unserialize" --include="*.js"

# 检测 eval / Function
grep -rn "eval(\|new Function(" --include="*.js"

# 检测 vm 模块
grep -rn "vm\.runIn" --include="*.js"

# 检测对象合并
grep -rn "Object\.assign(\|_\.merge(" --include="*.js"

# 检测 msgpack
grep -rn "msgpack\|decode(" --include="*.js"
```

---

## 6. 常见误判场景

### 陷阱1：JSON.parse 误判

**错误**: 看到 `JSON.parse` 就判为漏洞
**正确**: 普通的 `JSON.parse` 默认安全，除非用于原型污染操作

### 陷阱2：配置文件误判

**错误**: 看到反序列化就判为漏洞
**正确**: 数据来自服务器端固定配置文件 → 安全

### 陷阱3：Map 误判

**错误**: 看到对象合并就判为原型污染
**正确**: 使用 Map 不影响原型链 → 安全

### 陷阱4：白名单识别失败

**错误**: 未读取完整代码，认为无防护
**正确**: 存在白名单属性过滤 → 安全

### 陷阱5：环境判断忽略

**错误**: 看到危险 API 就判漏洞
**正确**: 非线上环境 → 安全

---

## 7. 特殊风险

### vm 模块沙箱逃逸

`vm.runInNewContext` 的沙箱可被逃逸，攻击者可获取宿主进程的完全控制权：

```javascript
const vm = require('vm');
app.post('/script', async (req, res) => {
    const sandbox = { result: null };
    vm.runInNewContext(req.body.script, sandbox);  // 漏洞：沙箱可逃逸
});

// 逃逸载荷：this.constructor.constructor('return process')().mainModule.require('child_process').execSync('id')
```

### 原型污染链变体

```
__proto__ 污染：{"__proto__": {"isAdmin": true}}
constructor.prototype 污染：{"constructor": {"prototype": {"isAdmin": true}}}
```

黑名单仅过滤 `__proto__` 不够，`constructor.prototype` 是等价变体。

---

## 8. 变更影响分析

| 变更类型 | 变更内容 | 风险 |
|----------|----------|------|
| 新增 | 新增 unserialize / deserialize | 检查用户可控性、防护措施 |
| 新增 | 新增 eval / Function | 检查用户可控性 |
| 新增 | 新增 Object.assign(userInput) | 检查目标对象类型 |
| 新增 | 新增 _.merge(userInput) | 检查目标对象类型 |
| 修改 | 移除白名单过滤 | 扩大攻击面 |
| 修改 | 将 Map 改为 Object | 引入原型污染 |
| 删除 | 删除签名验证 | 移除防护 |

---

## 9. 质量门禁（强制执行）

在输出审计结论前，按顺序验证：

- [ ] 黄金法则强制执行顺序已遵守（先识别 API 类型）
- [ ] 研判流程按顺序执行，无跳过
- [ ] 反序列化 API 类型已确认（JSON.parse vs node-serialize vs eval）
- [ ] 原型污染检查已执行（目标对象类型：Object.create(null)/Map vs 普通 Object）
- [ ] 数据来源已确认（配置文件 vs 用户输入）
- [ ] HTTP 入口可达性已确认，非假设
- [ ] 结论与证据一致，代码行号可追溯
- [ ] 已应用误报排除规则

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**
