# LDAP 注入 - 漏洞案例库

> 数据来源：内部漏洞数据库（vul_type_id=74）+ 乌云经典案例
> 脱敏处理：系统名称、域名、IP 均已脱敏

---

## 内部案例

### 案例1：IT 自助服务系统 - /user/exist 接口 LDAP 注入

**来源**：内部漏洞数据库 vul_type_id=74
**系统**：某内部 IT 自助服务平台
**接口**：`/user/exist`
**危害等级**：高

**漏洞描述**：
用户存在性查询接口，接收 `userId` 参数后直接拼接到 LDAP Filter 字符串中，未做任何转义处理。攻击者可通过注入 LDAP 特殊字符（`*)(uid=*)` 等）修改查询逻辑，枚举 LDAP 目录中的用户信息或绕过用户存在性检查。

**漏洞代码（已脱敏）**：
```java
@GetMapping("/user/exist")
public ResponseEntity<Boolean> userExist(@RequestParam String userId) {
    String filter = "(uid=" + userId + ")";  // 漏洞：未转义
    List<Object> result = ldapTemplate.search(
        "ou=users,dc=internal,dc=example,dc=com",
        filter,
        (AttributesMapper<Object>) attrs -> attrs.get("uid").get()
    );
    return ResponseEntity.ok(!result.isEmpty());
}
```

**攻击载荷**：
```
GET /user/exist?userId=*)(uid=*))(|(uid=*
```

**注入后 Filter**：
```
(uid=*)(uid=*))(|(uid=*)
```

**攻击效果**：
- 查询返回所有用户（Filter 逻辑被破坏）
- 可用于用户枚举（构造 `*(uid=a*)` 探测以特定字母开头的用户）
- 可用于绕过"用户是否存在"检查逻辑

**修复方案**：
```java
// 方案1：使用 Spring LDAP EqualsFilter（推荐）
AndFilter filter = new AndFilter();
filter.and(new EqualsFilter("uid", userId));
ldapTemplate.search(base, filter.encode(), mapper);

// 方案2：使用 LdapEncoder.filterEncode() 转义
String safeFilter = "(uid=" + LdapEncoder.filterEncode(userId) + ")";
ldapTemplate.search(base, safeFilter, mapper);

// 方案3：白名单正则（userId 格式固定时）
if (!userId.matches("[a-zA-Z0-9._-]{1,50}")) {
    throw new IllegalArgumentException("Invalid userId format");
}
```

---

## 乌云经典案例

### 案例2：某企业内部系统 - LDAP Filter 认证绕过

**来源**：乌云漏洞知识库（历史案例）
**类型**：LDAP Filter 注入 → 认证绕过
**危害等级**：高

**漏洞描述**：
企业内部登录系统使用 LDAP 验证用户身份，将用户名和密码拼接到 LDAP 搜索 Filter 中。通过注入 `*` 通配符可绕过密码验证。

**漏洞代码模式**：
```java
// 典型不安全写法
String filter = "(&(uid=" + username + ")(userPassword=" + password + "))";
NamingEnumeration<?> result = ctx.search(base, filter, controls);
if (result.hasMore()) {
    // 认证成功
}
```

**攻击载荷**：
```
username = admin)(|(uid=*
password = anything
```

**注入后 Filter**：
```
(&(uid=admin)(|(uid=*)(userPassword=anything))
```

**攻击效果**：Filter 逻辑改变，`(|(uid=*)` 条件恒为真，绕过密码验证
**结论**：漏洞

**修复方案**：LDAP 认证应使用 bind 操作而非 Filter 搜索验证密码

```java
// 正确做法：bind 认证
Hashtable<String, String> authEnv = new Hashtable<>();
authEnv.put(Context.SECURITY_AUTHENTICATION, "simple");
authEnv.put(Context.SECURITY_PRINCIPAL, "uid=" + LdapEncoder.nameEncode(username) + ",ou=users,dc=example,dc=com");
authEnv.put(Context.SECURITY_CREDENTIALS, password);
try {
    new InitialDirContext(authEnv);  // bind 失败会抛异常
    // 认证成功
} catch (AuthenticationException e) {
    // 认证失败
}
```

---

### 案例3：某 HR 系统 - 员工信息查询接口枚举

**来源**：乌云漏洞知识库（历史案例）
**类型**：LDAP Filter 注入 → 信息枚举
**危害等级**：中

**漏洞描述**：
HR 系统员工搜索功能，搜索关键词直接拼接到 LDAP Filter 中，攻击者可注入通配符枚举所有员工信息（姓名、邮箱、部门、电话等）。

**漏洞代码模式**：
```java
@GetMapping("/employee/search")
public List<Employee> searchEmployee(@RequestParam String keyword) {
    String filter = "(|(cn=*" + keyword + "*)(mail=*" + keyword + "*))";
    return ldapTemplate.search(base, filter, employeeMapper);
}
```

**攻击载荷**：
```
GET /employee/search?keyword=*)(|(cn=*)  
```

**攻击效果**：返回目录中所有用户（通配符注入使条件恒真）
**洞察**：LIKE 模糊搜索场景中，用户输入前后已有 `*`，攻击者注入 `)(|(cn=*` 即可突破原有过滤逻辑
**结论**：漏洞

---

## 案例规律总结

| 维度 | 规律 |
|------|------|
| **高发场景** | 用户存在性查询、登录认证、员工搜索 |
| **高发参数** | `userId`、`username`、`cn`、`keyword`、`empId` |
| **常见 Sink** | `LdapTemplate.search()`、`DirContext.search()`、`NamingEnumeration` |
| **主要危害** | 信息枚举（获取全部用户）、认证绕过（密码校验逻辑被破坏） |
| **典型注入字符** | `*`（通配符）、`(`、`)`、`\`、`\0` |
| **核心防护** | Spring `EqualsFilter`/`AndFilter`（自动转义）、`LdapEncoder.filterEncode()` |

---

## 参考资料

- OWASP: LDAP Injection Prevention Cheat Sheet
- Spring Security LDAP: `LdapEncoder`, `AndFilter`, `EqualsFilter`
- RFC 4515: LDAP Filter String Representation
- 内部漏洞数据库：vul_type_id=74，1 条真实案例
