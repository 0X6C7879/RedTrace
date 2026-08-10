# RCE

## 0. 黄金法则

> **漏洞存在性判断 优先于 防护有效性判断**
>
> 不拼接命令 = 无 RCE（这是漏洞本质判断，不是防护有效判断）
>
> 满足此条件时：立即终止分析，无需检查任何防护措施。

**强制执行顺序**：
1. **首先**：找到 sink 点代码执行调用（如 `eval()`, `exec()`, `new Function()`）
2. **然后**：分析用户输入是否拼接进命令/代码
3. **仅当** 命令/代码拼接时，才继续检查防护措施
4. **禁止**：一上来就检查"有没有白名单"、"A 有 B 没有"

---

## 1. 结论判断标准

| 结论 | 定义 | 判定条件 |
|------|------|----------|
| **漏洞** | 用户输入可通过 HTTP 入口到达代码执行点，无有效防护 | 危险执行函数 + 用户可控数据 + HTTP 入口可达 + 无有效防护 |
| **风险-A** | 存在代码执行调用但无 HTTP 入口可达（内部调用） | 危险执行函数 + 内部调用，无 HTTP 入口 |
| **风险-B** | 代码执行有 HTTP 入口可达，但防护措施不充分 | 危险执行函数 + 用户输入 + 仅黑名单/部分替换 |
| **安全** | 无危险写法，或有充分的有效防护 | 前端执行/类型约束/白名单/参数化 |

---

## 2. 研判思路

### 2.1 执行环境检查（第一优先级）

**前端环境 → 安全**，详见 [JavaScript 通用检索技巧](javascript-common-retrieval.md#环境识别)

| 类型 | 函数 | 危险条件 |
|------|------|----------|
| 代码注入 | `eval`, `new Function`, `setTimeout`(字符串), `setInterval`(字符串) | 代码内容用户可控 |
| 命令注入 | `child_process.exec`, `child_process.execSync` | 命令字符串用户可控 |
| VM 沙箱 | `vm.runInNewContext`, `vm.runInThisContext`, `new vm.Script` | 代码内容用户可控（沙箱可逃逸） |
| 参数化（安全） | `child_process.spawn` 参数数组 | 命令固定，仅参数可控 → 安全 |

### 2.2 研判流程

```
Step 1: 环境检查
  ├─ 前端环境？ → 安全（终止，非服务器 RCE）
  └─ Node.js 后端 → 继续

Step 2: 输入类型检查
  ├─ number/boolean？ → 安全（终止）
  └─ string → 继续

Step 3: 代码/命令拼接检查
  ├─ 代码内容固定，仅变量值可控？ → 安全（终止）
  ├─ spawn 参数数组？ → 安全（终止）
  ├─ 白名单映射？ → 安全（终止）
  └─ eval/exec 内容用户可控 → 继续

Step 4: 防护检查
  ├─ 严格正则白名单？ → 安全（终止）
  ├─ 黑名单过滤？ → 风险-B
  └─ 无防护 → 继续

Step 5: HTTP 入口可达性
  ├─ 无 HTTP 入口？ → 风险-A
  └─ 有入口 → 漏洞
```

### 2.3 降级条件表

| 条件 | 原结论 | 降级后 |
|------|--------|--------|
| 前端执行环境 | 漏洞 | 安全 |
| number/boolean 类型约束 | 漏洞 | 安全 |
| 白名单映射/spawn 参数数组 | 漏洞 | 安全 |
| 黑名单过滤 | 漏洞 | 风险-B |

### 2.4 总结判定表

| 检查项 | 结论 |
|--------|------|
| 前端执行环境 | 安全 |
| number/boolean 类型约束 | 安全 |
| 白名单映射/spawn 参数数组 | 安全 |
| 代码内容固定，仅变量值可控 | 安全 |
| eval/exec/vm + 用户可控 + 无防护 + HTTP 入口 | 漏洞 |
| 黑名单过滤 + HTTP 入口 | 风险-B |
| 内部方法无 HTTP 入口 | 风险-A |

---

## 3. 常见漏洞/风险场景

### 漏洞

```javascript
// 代码注入
eval(req.query.code);  // 漏洞
new Function('return ' + req.query.expr)();  // 漏洞
setTimeout(req.query.code, 1000);  // 漏洞：字符串形式

// 命令注入
exec(`ping -c 1 ${req.query.host}`);  // 漏洞
execSync(`cat ${req.query.file}`);  // 漏洞

// VM 沙箱逃逸
vm.runInNewContext(req.query.code, {});  // 漏洞：沙箱可逃逸
```

### 风险-A

```javascript
function processInternalCommand(cmd) {
    exec(cmd);  // 风险-A：需确认调用方
}
```

### 风险-B

```javascript
// 黑名单过滤
const blacklist = ['rm', 'shutdown', 'reboot'];
if (!blacklist.some(word => cmd.includes(word))) {
    exec(cmd);  // 风险-B：黑名单可绕过
}

// 简单 startsWith 校验
if (cmd.startsWith('allowed_')) { eval(cmd); }  // 风险-B：可绕过
```

---

## 4. 常见防御模式

### 前端执行环境

```javascript
function Calculator({ expression }) {
    const result = eval(expression);  // 安全：前端执行，非服务器 RCE
    return <div>{result}</div>;
}
```

### 类型约束

```typescript
function process(id: number) {
    eval(`process(${id})`);  // 安全：number 类型无法注入
}
```

### 白名单映射

```javascript
const COMMANDS = { 'status': 'git status', 'log': 'git log -10' };
const cmd = COMMANDS[req.query.cmd];  // 安全：白名单映射
if (cmd) exec(cmd);
```

### 参数化执行

```javascript
spawn('ping', ['-c', '1', req.query.host]);  // 安全：命令固定，仅参数可控
```

---

## 5. 检索技巧

> HTTP 入口可达性检索：详见 [JavaScript 通用检索技巧](javascript-common-retrieval.md#http-入口可达性检索)

### 搜索关键词

| 类型 | 关键词 |
|------|--------|
| 代码注入 | `eval(`, `new Function(`, `setTimeout(`, `setInterval(` |
| 命令执行 | `child_process`, `exec(`, `execSync(`, `spawn(` |
| VM 模块 | `vm.runInNewContext`, `vm.runInThisContext`, `vm.Script` |

### 检测命令

```bash
# 代码注入
grep -rn "eval(\|new Function(\|setTimeout(" --include="*.js"
# 命令执行
grep -rn "child_process\|\.exec(\|\.execSync(\|\.spawn(" --include="*.js"
# VM 模块
grep -rn "vm\.runInNewContext\|vm\.runInThisContext\|vm\.Script" --include="*.js"
```

---

## 6. 常见误判场景

### 陷阱1：前端 eval 误判

**错误**: 看到 `eval()` 就判为 RCE
**正确**: 浏览器执行，不是服务器 RCE → 安全

### 陷阱2：忽略类型约束

**错误**: 看到 `eval` 就判为漏洞
**正确**: `number` 类型只能包含数字，无法注入代码 → 安全

### 陷阱3：黑名单不可靠

**错误**: 有 `startsWith('allowed_')` 检查就安全
**正确**: `allowed_; malicious()` 可绕过 → 风险-B

### 陷阱4：先看防护后看漏洞本质

**错误思路**：发现缺少白名单 → A 有 B 没有 → 判定风险
**正确思路**：先判断漏洞是否存在（代码内容固定 → 无 RCE）→ 漏洞不存在时防护问题无从谈起

### 陷阱5：被代码对比干扰

**错误判定**：A 有白名单 B 没有 → B 有风险
**正确判定**：先看 B 漏洞是否存在（是否拼接命令），再谈防护

---

## 7. 特殊风险

### 原型污染 → RCE 攻击链

`_.merge(config, req.body)` 等深度合并可污染原型链。攻击载荷 `{"__proto__": {"isAdmin": true}}` 可修改全局对象属性。若污染影响 `child_process.exec` 的参数或环境变量，可升级为 RCE。

### eval/new Function/setTimeout 字符串形式

`setTimeout(userInput, 1000)` 和 `setInterval(userInput, 1000)` 以字符串形式传入时等价于 `eval()`，可直接执行任意代码。与 `eval()` 同等危险。

---

## 8. 变更影响分析

| 变更类型 | 变更内容 | 风险 |
|----------|----------|------|
| 新增 | 新增 eval/new Function/vm 调用 | 确认执行环境、用户可控性 |
| 新增 | 新增 child_process 调用 | 确认调用方式、参数来源 |
| 修改 | 从 spawn 改为 exec | 从参数化变为字符串拼接 |
| 修改 | 移除白名单检查 | 扩大攻击面 |
| 删除 | 删除类型检查/白名单校验 | 移除防护 |

## 9. 质量门禁（强制执行）

在输出审计结论前，按顺序验证：

- [ ] 强制执行顺序已遵守（先检查代码/命令拼接分析）
- [ ] 执行环境已确认（前端 vs Node.js 后端）
- [ ] 类型约束已检查（number/boolean vs string）
- [ ] HTTP 入口可达性已确认，非假设
- [ ] 结论与证据一致，代码行号可追溯
- [ ] 已应用误报排除规则（前端执行、类型约束等）

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**
