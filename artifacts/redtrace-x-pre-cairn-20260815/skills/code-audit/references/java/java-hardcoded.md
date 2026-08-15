# 硬编码凭据

## 0. 黄金法则

> **漏洞存在性判断 优先于 防护有效性判断**
>
> 非硬编码敏感信息 = 无 硬编码凭据漏洞（这是漏洞本质判断，不是防护有效判断）
>
> 满足此条件时：立即终止分析，无需检查任何防护措施。

**强制执行顺序**：
1. **首先**：找到可能的凭据赋值代码（如 `password = ...`, `API_KEY = ...`）
2. **然后**：分析值来源（直接字符串 vs Kconf/环境变量）
3. **仅当** 直接硬编码真实凭据时，才判定为漏洞
4. **禁止**：一上来就检查"是不是测试数据"

---

## 1. 结论判断标准

| 结论 | 定义 | 判定条件 |
|------|------|----------|
| **漏洞** | 代码中硬编码敏感信息（密码、token、API 密钥等） | 硬编码敏感信息 + 非测试/非占位符 + 线上环境 |
| **风险-A** | 疑似硬编码但无法确认用途 | 变量名/值疑似敏感 + 无法确认是否真实凭据 |
| **安全** | 使用安全配置方式或非敏感数据 | Kconf/环境变量/测试数据/占位符 |

---

## 2. 研判思路

### 2.1 研判流程

```
Step 1: 敏感模式识别 【终止点】
  ├─ 无敏感关键词（password/token/apiKey/secret/credential）？ → 安全（终止）
  └─ 发现敏感模式 → 继续

Step 2: 值来源确认 【终止点】
  ├─ Kconf 配置（kconf.getString）/ 环境变量（System.getenv）/ @Value？ → 安全（终止）
  └─ 直接字符串赋值 → 继续

Step 3: 数据性质判断
  ├─ 测试数据（test/example/mock）/ 占位符（xxx/TODO/${...}/***)？ → 安全（终止）
  ├─ 测试文件（*Test.java）？ → 安全（终止）
  ├─ 非线上环境？ → 安全（终止）
  ├─ 疑似但无法确认？ → 风险-A
  └─ 真实凭据 → 漏洞
```

### 2.2 降级条件表

| 条件 | 原结论 | 降级后 |
|------|--------|--------|
| Kconf / 环境变量 / @Value | 漏洞 | 安全 |
| 测试数据 / 占位符 | 漏洞 | 安全 |
| 测试文件 / 非线上环境 | 漏洞 | 安全 |
| 疑似但无法确认 | 漏洞 | 风险-A |

### 2.3 总结判定表

| 检查项 | 结论 |
|--------|------|
| Kconf / 环境变量 / @Value 配置 | 安全 |
| 测试数据 / 占位符 / 测试文件 | 安全 |
| 硬编码真实凭据 + 线上环境 | 漏洞 |
| 疑似凭据但无法确认 | 风险-A |

---

## 3. 常见漏洞/风险场景

### 漏洞

```java
private static final String DB_PASSWORD = "admin123";  // 漏洞
private static final String API_KEY = "sk-1234567890abcdef";  // 漏洞
String password = "P@ssw0rd";  // 漏洞
```

### 风险-A

```java
private static final String SECRET = "someRandomString";  // 风险-A：疑似凭据但无法确认
```

---

## 4. 常见防御模式

### Kconf / 环境变量 / @Value

```java
String password = kconf.getString("db.password");  // 安全
String apiKey = System.getenv("API_KEY");  // 安全
@Value("${api.key}") String apiKey;  // 安全
```

### 测试数据 / 占位符

```java
private static final String TEST_PASSWORD = "test123";  // 安全
private static final String PASSWORD_PLACEHOLDER = "xxx";  // 安全
String password = "${db.password}";  // 占位符 → 安全
```

---

## 5. 检索技巧

### 搜索关键词

| 类型 | 关键词 |
|------|--------|
| 凭据关键词 | `password`, `token`, `apiKey`, `secret`, `credential` |
| 常量模式 | `private static final String` |
| 安全配置 | `kconf.getString`, `System.getenv`, `@Value` |

### 检测命令

```bash
grep -rn 'password\s*=\s*"' --include="*.java"
grep -rn 'private static final String.*PASSWORD\s*=\s*"' --include="*.java"
grep -rn 'sk-[a-zA-Z0-9]' --include="*.java"
```

---

## 6. 常见误判场景

### 陷阱1：Kconf key 误判

**错误**: `kconf.getString("db.password")` 中的 "password" 是硬编码
**正确**: 这是配置读取的 key，不是值 → 安全

### 陷阱2：测试断言误判

**错误**: `assertEquals("admin123", result)` 中的 "admin123" 是凭据
**正确**: 测试断言 → 安全

### 陷阱3：占位符误判

**错误**: `"***"` / `"xxx"` / `"TODO"` 是真实凭据
**正确**: 占位符 → 安全

### 陷阱4：URL 参数名误判

**错误**: `"?key=public"` 中的 key 是敏感信息
**正确**: 公开参数名 → 安全

---

## 7. 特殊风险

### Kconf key vs 硬编码值

`get_string_config("db.password")` 中的 `"db.password"` 是 Kconf 的 key 名，实际值在云端配置中心。只有字符串值本身是敏感信息时才是硬编码漏洞。

---

## 8. 变更影响分析

| 变更类型 | 变更内容 | 风险 |
|----------|----------|------|
| 新增 | 新增硬编码密码/API Key | 确认值来源 |
| 修改 | 从 Kconf 改为硬编码 | 引入漏洞 |
| 修改 | 从环境变量改为硬编码 | 引入漏洞 |
| 修改 | 从硬编码改为 Kconf | 修复 |

---

## 9. 质量门禁（强制执行）

在输出审计结论前，按顺序验证：

- [ ] 强制执行顺序已遵守（先检查值来源）
- [ ] Kconf key 与硬编码值已正确区分
- [ ] 测试数据/占位符已排除
- [ ] 结论与证据一致，代码行号可追溯
- [ ] 不因代码对比而判定风险

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**
