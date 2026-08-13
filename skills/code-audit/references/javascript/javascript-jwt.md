# JWT 安全漏洞

## 0. 黄金法则

> **漏洞存在性判断 优先于 防护有效性判断**
>
> 强制算法 + 强密钥 + jwt.verify 正确使用 = 安全的 JWT（这是漏洞本质判断）
>
> 满足此条件时：立即终止分析，无需检查额外防护。

---

## 1. 结论判断标准

| 结论 | 定义 | 判定条件 |
|------|------|----------|
| **漏洞** | JWT 实现存在可利用的安全缺陷 | 算法 none / 硬编码弱密钥 / jwt.decode 未验证 |
| **风险-A** | JWT 问题但无 HTTP 入口可达 | 内部使用的 JWT |
| **风险-B** | 有问题但攻击难度较高 | 无 algorithms 参数 / 过期时间过长 / 弱密钥 |
| **安全** | 符合安全最佳实践 | 强制算法 + 强密钥 + 合理过期 |

---

## 2. 研判思路

### 2.1 高危模式（第一优先级）

| 模式 | 危险级别 |
|------|----------|
| `{ algorithms: ['none'] }` | 漏洞（立即终止） |
| `jwt.decode()` 未验证签名 | 漏洞 |
| 空字符串密钥 / 'secret' / '123456' | 漏洞 |
| `jwt.verify()` 无 algorithms 参数 | 风险-B |
| 无 expiresIn 或 > 24h | 风险-B |

### 2.2 研判流程

```
Step 1: JWT 操作识别 【终止点】
  ├─ 无 JWT 操作？ → 安全（终止）
  └─ 发现 jwt.sign/jwt.verify/jwt.decode → 继续

Step 2: 算法检查
  ├─ { algorithms: ['none'] }？ → 漏洞
  ├─ 无 algorithms 参数？ → 风险-B
  └─ 强制指定算法（RS256/HS256） → 继续

Step 3: 密钥检查
  ├─ 硬编码弱密钥（'secret'/'123456'/空字符串）？ → 漏洞
  ├─ crypto.randomBytes 生成？ → 安全
  └─ 配置/环境变量？ → 继续

Step 4: 验证逻辑检查
  ├─ 只使用 jwt.decode（未验证签名）？ → 漏洞
  ├─ jwt.verify 无密钥？ → 漏洞
  └─ 正确 jwt.verify → 继续

Step 5: 过期时间检查
  ├─ 无 expiresIn 或 > 24h？ → 风险-B
  └─ expiresIn <= 1h？ → 安全
```

### 2.3 降级条件表

| 条件 | 原结论 | 降级后 |
|------|--------|--------|
| 强制算法 + 强密钥 + 正确 verify | 漏洞 | 安全 |
| crypto.randomBytes 生成密钥 | 漏洞 | 安全 |
| 无 algorithms 参数 | 漏洞 | 风险-B |
| 过期时间 > 24h | 漏洞 | 风险-B |

---

## 3. 常见漏洞/风险场景

### 漏洞

```javascript
// 算法 none
jwt.verify(token, secret, { algorithms: ['none'] });  // 漏洞

// jwt.decode 未验证签名
const decoded = jwt.decode(token);  // 漏洞：不验证签名

// 硬编码弱密钥
const secret = 'secret';  // 漏洞
jwt.sign({ userId }, secret);
```

### 风险-B

```javascript
// 无 algorithms 参数
jwt.verify(token, secret);  // 风险-B

// 过期时间过长
jwt.sign({ userId }, secret, { expiresIn: '30d' });  // 风险-B
```

---

## 4. 常见防御模式

```javascript
// 安全：强制算法 + 配置密钥 + 合理过期
const secret = process.env.JWT_SECRET;  // 来自配置
jwt.verify(token, secret, { algorithms: ['HS256'] });  // 强制算法
jwt.sign({ userId }, secret, { expiresIn: '1h' });  // 合理过期
```

---

## 5. 检索技巧

### 搜索关键词

| 类型 | 关键词 |
|------|--------|
| JWT 操作 | `jwt.sign`, `jwt.verify`, `jwt.decode`, `jose` |
| 算法配置 | `algorithms`, `HS256`, `RS256`, `none` |
| 密钥 | `JWT_SECRET`, `secret`, `privateKey` |

### 检测命令

```bash
grep -rn "jwt\.sign\|jwt\.verify\|jwt\.decode" --include="*.js"
grep -rn "algorithms.*none\|algorithms.*null" --include="*.js"
```

---

## 6. 常见误判场景

### 陷阱1：jwt.decode vs jwt.verify 混淆

**错误**: 认为 decode 和 verify 等价
**正确**: `jwt.decode` 不验证签名，仅解析 → 漏洞；`jwt.verify` 验证签名 → 安全

### 陷阱2：变量名误判

**错误**: 看到变量名 `secret` 就认为是弱密钥
**正确**: 需检查实际值，`process.env.JWT_SECRET` → 需确认配置

### 陷阱3：忽略 algorithms 参数

**错误**: 看到 jwt.verify 就认为安全
**正确**: 无 algorithms 参数时可能被 none 算法绕过 → 风险-B

---

## 7. 特殊风险

### RS256/HS256 算法混淆攻击

服务端使用 RS256（非对称），公钥验签。若 `jwt.verify()` 的 algorithms 参数包含 HS256，攻击者可用公钥作为 HS256 密钥伪造 token：

```javascript
const publicKey = fs.readFileSync('public.key');
jwt.verify(token, publicKey, { algorithms: ['HS256'] });  // 漏洞：算法混淆
```

防御：algorithms 参数必须只包含预期算法，如 `{ algorithms: ['RS256'] }`。

### jwt.decode vs jwt.verify

`jwt.decode(token)` 仅解析 base64，不验证签名。任何人均可构造合法格式的 token。必须使用 `jwt.verify(token, secret, { algorithms: [...] })` 验证签名。

---

## 8. 变更影响分析

| 变更类型 | 变更内容 | 风险 |
|----------|----------|------|
| 新增 | 新增 jwt.sign/jwt.verify | 确认算法和密钥 |
| 修改 | 从 jwt.verify 改为 jwt.decode | 引入漏洞 |
| 修改 | 移除 algorithms 参数 | 引入风险 |

---

## 9. 质量门禁（强制执行）

在输出审计结论前，按顺序验证：

- [ ] jwt.decode vs jwt.verify 已正确区分
- [ ] algorithms 参数已显式检查
- [ ] 密钥来源和强度已确认
- [ ] 过期时间已检查
- [ ] 结论与证据一致，代码行号可追溯

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**
