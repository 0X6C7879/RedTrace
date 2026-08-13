# 硬编码凭据

## 0. 黄金法则

> **漏洞存在性判断 优先于 防护有效性判断**
>
> 使用配置中心/环境变量/非敏感数据 = 无 硬编码凭据漏洞（这是漏洞本质判断，不是防护有效判断）
>
> 满足此条件时：立即终止分析，无需检查任何防护措施。

**强制执行顺序**：
1. **首先**：找到疑似硬编码的字符串
2. **然后**：分析是否为真实凭据（排除测试数据/占位符）
3. **仅当** 确认为真实凭据时，才判定为漏洞
4. **禁止**：一上来就检查"有没有用 Kconf"

---

## 1. 结论判断标准

| 结论 | 定义 | 判定条件 |
|------|------|----------|
| **漏洞** | 代码中硬编码敏感信息 | 硬编码敏感信息 + 非测试/非占位符 + 线上环境 |
| **风险-A** | 疑似硬编码但无法确认用途 | 变量名/值疑似敏感 + 无法确认是否真实凭据 |
| **安全** | 使用安全配置方式或非敏感数据 | Kconf/环境变量/dotenv/测试数据/占位符 |

---

## 2. 研判思路

### 2.1 研判流程

```
Step 1: 敏感模式识别 【终止点】
  ├─ 无敏感关键词？ → 安全（终止）
  └─ 发现敏感模式 → 继续

Step 2: 值来源确认 【终止点】
  ├─ Kconf（kconf.getStringValue）/ process.env / dotenv？ → 安全（终止）
  └─ 直接字符串赋值 → 继续

Step 3: 数据性质判断
  ├─ 测试数据 / 占位符 / 测试文件（__tests__/）？ → 安全（终止）
  ├─ 非线上环境（NODE_ENV=test/development）？ → 安全（终止）
  ├─ 疑似但无法确认？ → 风险-A
  └─ 真实凭据 → 漏洞
```

### 2.2 总结判定表

| 检查项 | 结论 |
|--------|------|
| Kconf / process.env / dotenv | 安全 |
| 测试数据 / 占位符 / 测试文件 | 安全 |
| 硬编码真实凭据 + 线上环境 | 漏洞 |
| 疑似凭据但无法确认 | 风险-A |

---

## 3. 常见漏洞/风险场景

### 漏洞

```javascript
const DB_PASSWORD = 'admin123';  // 漏洞
const API_KEY = 'sk-1234567890abcdef';  // 漏洞
const DB_URL = 'mongodb://user:pass123@localhost:27017/db';  // 漏洞
const GITHUB_TOKEN = 'ghp_xxxxxxxxxxxx';  // 漏洞
module.exports = { apiKey: 'sk-1234567890abcdef' };  // 漏洞
```

### 风险-A

```javascript
const SECRET = 'someRandomString';  // 风险-A
const key = 'abcd1234';  // 风险-A
```

---

## 4. 常见防御模式

```javascript
// Kconf
const apiKey = kconf.getStringValue('api.key');  // 安全

// 环境变量
const password = process.env.DB_PASSWORD;  // 安全

// dotenv
require('dotenv').config();
const password = process.env.DB_PASSWORD;  // 安全

// 测试数据/占位符
const TEST_PASSWORD = 'test123';  // 安全
const PASSWORD_PLACEHOLDER = 'xxx';  // 安全
```

---

## 5. 检索技巧

### 搜索关键词

| 类型 | 关键词 |
|------|--------|
| 凭据关键词 | `password`, `token`, `apiKey`, `secret`, `credential` |
| 常量模式 | `const ... = '...'`, `let ... = '...'` |
| 安全配置 | `kconf.getStringValue`, `process.env`, `dotenv` |

### 检测命令

```bash
grep -rn "password\s*=\s*'" --include="*.js"
grep -rn "apiKey\s*=\s*'" --include="*.js"
grep -rn 'sk-[a-zA-Z0-9]' --include="*.js"
grep -rn 'ghp_[a-zA-Z0-9]' --include="*.js"
```

---

## 6. 常见误判场景

### 陷阱1：Kconf key 误判

**错误**: 看到字符串 'db.password' 就认为是硬编码
**正确**: Kconf 的 key，实际值在云端 → 安全

### 陷阱2：环境变量名误判

**错误**: 看到 password 就认为是硬编码
**正确**: 使用 `process.env` 获取 → 安全

### 陷阱3：测试数据误判

**错误**: 看到 'test123' 就认为是硬编码凭据
**正确**: 测试文件中的测试数据 → 安全

### 陷阱4：枚举值误判

**错误**: 看到 'api_key' 就认为是硬编码凭据
**正确**: 枚举定义，仅用于类型标识 → 安全

---

## 7. 特殊风险

### Kconf key vs 硬编码值

`get_string_config("db.password")` 中的 `"db.password"` 是 Kconf 的 key 名，实际值在云端配置中心。只有字符串值本身是敏感信息时才是硬编码漏洞。

---

## 8. 变更影响分析

| 变更类型 | 变更内容 | 风险 |
|----------|----------|------|
| 新增 | 新增硬编码密码/API Key | 确认值来源 |
| 修改 | 从 process.env 改为硬编码 | 引入漏洞 |
| 修改 | 从硬编码改为环境变量 | 修复 |

---

## 9. 质量门禁（强制执行）

在输出审计结论前，按顺序验证：

- [ ] 强制执行顺序已遵守（先检查值来源）
- [ ] Kconf key 与硬编码值已正确区分
- [ ] 测试数据/占位符已排除
- [ ] 结论与证据一致，代码行号可追溯

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**
