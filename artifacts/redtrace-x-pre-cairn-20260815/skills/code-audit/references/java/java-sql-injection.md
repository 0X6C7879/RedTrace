# SQL 注入

## 0. 黄金法则

> **漏洞存在性判断 优先于 防护有效性判断**
>
> 检查防护前先回答：1) 这个防护防的是什么漏洞？ 2) 这个漏洞是否存在？
> **如果漏洞不存在，防护缺失就不再是问题。**
>
> **参数不拼接 SQL = 无 SQL注入（漏洞本质判断，不是防护有效判断）**
> 满足此条件时：立即终止分析，无需检查任何防护措施。
>
> **SQL 不执行 = 无 SQL注入（漏洞本质判断）**
> 当 SQL 语句仅生成但不执行时（如受控制参数门禁保护、仅返回字符串或写日志），漏洞不存在，立即终止分析。
>
> **⚠️ 强制执行顺序：**
> 1. **首先**：找到 sink 点 SQL 执行代码（`query.execute()`, `jdbcTemplate.query()`）
> 2. **确认 SQL 是否实际执行**：sink 不可达则判定 safe（详见 §2.4 Step 1.5）
> 3. **然后**：分析用户输入是否拼接进 SQL 语句
> 4. **仅当** SQL 拼接时，才继续检查防护措施
> 5. **禁止**：一上来就检查"有没有过滤"、"A 有 B 没有"

---

## 1. 结论判断标准

| 结论 | 定义 | 判定条件 |
|------|------|----------|
| **漏洞** | 用户输入可通过 HTTP/gRPC 入口到达 SQL 拼接点，无有效防护 | 1. 存在 SQL 拼接; 2. 用户输入可控制 SQL 内容; 3. 数据流可追踪到 HTTP/gRPC 入口点; 4. 无有效防护措施 |
| **风险-A** | 存在 SQL 拼接但无 HTTP/gRPC 入口可达（内部调用） | 1. 存在 SQL 拼接; 2. 数据流不可追踪到外部入口; 3. 非测试/非配置代码 |
| **风险-B** | SQL 拼接有 HTTP 入口可达，但防护措施不充分 | 1. 存在 SQL 拼接; 2. HTTP 入口可达; 3. 有弱防护（如仅长度限制、黑名单过滤） |
| **安全** | 无危险写法，或危险写法有充分的有效防护 | 1. 参数不可控（类型约束/可信数据源），或; 2. 使用参数化查询，或; 3. 有白名单/枚举/Map 映射，或; 4. 非线上环境 |

---

## 2. 漏洞风险的研判思路

### 2.1 SQL 结构拆解（第一优先级）

找到 sink 点 SQL 最终构造的那一行代码，将 SQL 拆解分析：

**⚠️ 数据流必须到达 SQL 字符串内容**：

判定 SQL 注入的关键是：用户输入是否**实际拼接到 SQL 字符串中**。数据流仅仅到达"SQL 执行附近的代码"不构成注入。

| 场景 | 数据流方向 | 判定 |
|------|-----------|------|
| 用户输入 → `Enum.valueOf()` → 枚举对象 → `getRealClient(enum)` → client 选择 | client 是连接对象，不是 SQL 参数 | 安全 |
| 用户输入 → `Map.get()` → 固定值 → client 选择 | 同上 | 安全 |
| 用户输入 → `Enum.valueOf()` → 枚举名 → 拼接到 SQL 字符串 | 值被约束为预定义集合，但确认是否拼入 SQL | 需继续分析 |

**关键区分**：`client.query(sql)` 中的 `client` 是连接选择对象，不是 SQL 内容的一部分。

| 数据流路径 | 说明 | 判定 |
|-----------|------|----|
| 用户输入 → `Enum.valueOf()` → 枚举 → `getClient(enum)` → client选择 → `client.query(sql)` | client仅用于选择连接，不参与SQL构建 | 安全 |
| 用户输入 → `Map.get()` → 固定值 → `getDataSource(key)` → dataSource选择 → `jdbcTemplate.query(sql)` | dataSource仅用于选择连接，不参与SQL构建 | 安全 |
| 用户输入 → 字符串拼接 → SQL内容 → `client.query(sql)` | 用户输入实际拼接到SQL字符串中 | 漏洞 |

| 用户输入位置 | 代码示例 | 结论 |
|----------|----------|------|
| 值位置（参数化） | `SELECT * FROM users WHERE id = ?` | 安全（立即终止） |
| 值位置（拼接） | `SELECT * FROM users WHERE name = '` + input + `'` | 需继续研判 |
| 字段名位置 | `SELECT * FROM users ORDER BY ` + input | 需继续研判 |
| 表名位置 | `SELECT * FROM ` + input + ` WHERE ...` | 需继续研判 |

#### 2.1.1 客户端选择 vs SQL拼接区分（强制检查）

**适用条件**：数据流路径包含以下任一特征时强制执行

| 数据流特征 | 必须验证的内容 |
|-----------|---------------|
| 用户输入 → `xxxEnum.valueOf()` → `getClient/getDataSource()` | 验证输入是否转换为枚举后仅用于 client 选择，不进入 SQL |
| 用户输入 → `Map.get()` → `getClient/getDataSource()` | 验证输入是否仅选择连接，不参与 SQL 构建 |
| 数据流到达 `client.query(sql)` / `jdbcTemplate.query(sql)` | 区分：用户输入拼在 sql 参数中？还是只选择了 client？|

**关键判断方法**：
1. 找到 sink 点的 SQL 最终构造代码，确认 SQL 字符串的完整来源
2. 分析用户输入是否**实际出现在 SQL 字符串内容中**
3. 如果用户输入经过 `Enum.valueOf()` / `Map.get()` 后只用于选择连接对象（client/dataSource），而 SQL 字符串是由其他固定逻辑构建 → **判定为安全，立即终止**
4. CodeQL 数据流追踪到 `client.query()` 不等于拼接到 SQL，必须确认用户输入是否进入 sql 参数

```java
// 安全：region 仅用于选择客户端，不参与 SQL 构建
String region = userInput;
ClickHouseClientEnum clientEnum = ClickHouseClientEnum.valueOf(region + "_" + type);
IEventClickHouseClient client = getEventClient(clientEnum);
client.query(sql);  // sql 是固定模板，与 region 无关

// 漏洞：tableName 直接拼接到 SQL
String tableName = userInput;
String sql = "SELECT * FROM " + tableName;  // 用户输入拼进 SQL
client.query(sql);
```

### 2.2 拼接模式识别

| 模式类型 | 检测特征 | 风险 | 示例 |
|---------|---------|------|------|
| 字符串拼接操作符 | `+`, `+=`, `.concat()` | 高 | `"WHERE name = '" + name + "'"` |
| 构造器模式 | `StringBuilder`, `StringBuffer`, `.append()` | 高 | `sb.append("WHERE id = ").append(userId)` |
| 格式化方法 | `String.format()`, `.formatted()`, `MessageFormat` | 高 | `String.format("SELECT * FROM %s", table)` |
| 动态替换 | `.replace()`, `.replaceAll()` | 中 | `sql.replace("{id}", userId)` |
| 流式拼接 | `Stream.of()`, `Collectors.joining()` | 中 | `Stream.of("SELECT", "*").collect(joining(" "))` |
| 复合操作 | 三元表达式、方法组合 | 高 | `sql + (flag ? " AND valid=1" : "")` |

### 2.3 类型约束检查

| 类型 | 说明 | 判定 |
|------|------|------|
| `int`, `long`, `Integer`, `Long` | 数字类型无法包含 SQL 语法 | 安全 |
| `float`, `double`, `Double` | 浮点类型 | 安全 |
| `boolean`, `Boolean` | 布尔类型 | 安全 |
| `LocalDateTime`, `LocalDate`, `Date` | 时间类型（需检查格式化） | 通常安全 |
| `IPage`, `Page` | 分页对象 | 安全 |
| `List<Integer>`, `List<Long>` | 数字类型集合 | 安全 |

**隐式类型约束（解析/转换函数）**——解析失败会抛异常，成功时输出值无法包含 SQL 语法：

| 解析函数 | 约束类型 | 安全说明 |
|---------|---------|---------|
| `Integer.parseInt(s)` / `Long.parseLong(s)` | 整数/长整数 | 非法输入抛 NumberFormatException |
| `DateUtils.parseDate(s)` / `LocalDate.parse(s)` | 日期 | 非法格式抛 ParseException |
| `UUID.fromString(s)` | UUID | 非法格式抛 IllegalArgumentException |
| `new BigDecimal(s)` | 十进制数 | 非法输入抛 NumberFormatException |

**判断条件**：1) 解析函数必须会抛异常（非静默返回）；2) 解析后的值直接或经重新格式化后拼接（中间无其他可控输入）

### 2.4 研判流程（SOP）

```
Step 1: 环境检查 → 非线上？→ 安全（终止）
  识别方式：Env.isLocal()/isDev()/isTest()/isProd() 等框架提供的环境判断；也包括自定义封装函数如 belowStaging()/isStaging()；凡是接口在运行时对非线上环境直接返回错误码或拒绝执行，均视为非线上环境隔离，适用 false-positive-filtering.md §3.6 不报告规则
Step 1.5: SQL 执行可达性检查 → SQL 是否实际执行？
  ├─ sink 位于控制结构内（if/for/try）→ 追踪控制条件在所有调用路径的实际值，任一路径导致 sink 不可达 → safe（终止）
  ├─ SQL 拼接 + `return sql`（仅返回字符串，不执行）→ safe（终止）
  └─ SQL 实际执行 → 继续
Step 2: 类型约束 → int/long/Enum？→ 安全（终止）
Step 2.5: 解析函数 → parseInt/parseDate/UUID？→ 安全（终止）
Step 2.6: 客户端选择 → 用户输入仅用于选择client/dataSource/connection？→ 安全（终止）
Step 2.7: 身份凭证参数 → source 是 userId/merchantId/accountId/sellerId/tenantId 等身份凭证类参数？→ 应用 false-positive-filtering.md §3.3 gRPC参数溯源误报排除规则（网关/拦截器注入，非用户可控）→ 安全（终止）
Step 3: 参数化检查 → PreparedStatement/#{}？→ 安全（终止）
Step 4: 字段名拼接 → sink 调用是否为非标准库封装方法？→ 是：必须先读取该方法内部实现，确认有无拦截型校验，再判定；否：无白名单？→ 漏洞；有白名单？→ 安全
Step 5: 白名单/映射 → 枚举/Set.contains/Map.get？→ 安全（终止）
Step 6: 数据源 → Kconf/数据库/枚举/硬编码？→ 安全（终止）
Step 7: HTTP/gRPC 入口 → 无入口？→ 风险-A（终止）；gRPC 入口时必须追踪调用方身份，调用方为内部可信服务且参数由服务端分配 → 安全（终止）
Step 8: 最终判定 → 无防护→漏洞；弱防护→风险-B
```

### 2.5 总结判定表

| 检查项 | 结论 | 后续动作 |
|--------|------|----------|
| 非线上环境？ | 安全 | 终止 |
| 参数不拼接 SQL（类型约束/#{}/?）？ | 安全 | **终止，无需检查防护** |
| 参数经过解析函数（parseInt/parseDate/UUID等）？ | 安全 | 终止 |
| 用户输入仅用于选择client/dataSource/connection（不参与SQL构建）？ | 安全 | 终止 |
| 参数化查询（PreparedStatement/#{}）？ | 安全 | 终止 |
| 白名单/枚举/Map 映射？ | 安全 | 终止 |
| 可信数据源（Kconf/数据库/枚举）？ | 安全 | 终止 |
| MyBatis-Plus 安全方法（eq/like安全字段）？ | 安全 | 终止 |
| SQL 拼接且无防护？ | 漏洞 | — |
| SQL 拼接且有弱防护？ | 风险-B | — |
| 无 HTTP 入口？ | 风险-A | — |

### 2.6 降级条件表

**通用降级条件**：非线上环境→安全，无 HTTP 入口→风险-A，int/long/Enum 类型→安全，可信数据源→安全

| 条件 | 原结论 | 降级后结论 |
|------|--------|-----------|
| 参数化查询（#{} / ?） | 漏洞 | 安全 |
| 白名单/枚举/Map 映射 | 漏洞 | 安全 |
| 参数经过类型转换/解析函数（输出格式被约束） | 漏洞 | 安全 |
| 仅长度限制/黑名单 | 漏洞 | 风险-B |

---

## 3. 常见漏洞/风险场景

### 3.1 漏洞类型

```java
// 场景1：字段名/表名拼接（高危）
queryWrapper.orderBy(true, true, sort);                         // 漏洞
String joinTable = "user_" + businessType + "_data";            // 漏洞
queryWrapper.apply(field + " = '" + value + "'");               // 漏洞

// 场景2：MyBatis ${} 拼接
@Select("SELECT * FROM users WHERE name = '${name}'")           // 漏洞
@Select("SELECT * FROM users WHERE ${whereClause}")             // 漏洞
@Select("SELECT * FROM users ORDER BY ${sortBy}")               // 漏洞

// 场景3：JDBC 字符串拼接
String sql = "SELECT * FROM users WHERE name = '" + name + "'"; // 漏洞

// 场景4：移除参数化防护
// 修改前：@Select("...#{name}")  修改后：@Select("...'${name}'")  // 漏洞
```

### 3.2 风险-A 类型（无 HTTP 入口）

```java
private void internalQuery(String field) {
    String sql = "SELECT * FROM users ORDER BY " + field;  // 需追踪调用方确认是否可达
}
```

### 3.3 风险-B 类型（防护不足）

```java
queryWrapper.like("name", keyword);  // 仅 @Size(max=100) 不防注入
String safe = name.replace("'", "").replace("--", "");  // 黑名单可绕过
if (input.matches("^[a-zA-Z0-9]+$")) { queryWrapper.like("name", input); }  // LIKE 注入仍可用通配符
```

---

## 4. 常见防御模式

| 防御 | 说明 | 代码示例 |
|------|------|----------|
| 参数化查询 | 占位符传递，数据库自动转义 | `#{name}` / `?` / `QueryWrapper.eq()` |
| 类型约束 | int/long/Enum 无法包含 SQL 语法字符 | `@PathVariable Long id` |
| 白名单映射 | 用户只能选择索引/键，无法控制实际值 | `Set.contains()` / `Enum.valueOf()` / `Map.get()` |
| 可信数据源 | Kconf/数据库/枚举/硬编码 | `kconf.getString("sql.template")` |
| 类型转换/解析 | 解析函数约束输出格式 | `Integer.parseInt()` / `DateUtils.parseDate()` |
| 非线上环境 | 非生产环境代码 | `Env.isLocal()` / `Env.isDev()` |

### 4.1 MyBatis-Plus Column 可控函数清单

**危险方法**（字段名/表名用户可控）：

| 方法/场景 | 风险 | 示例 |
|----------|------|------|
| `@Select("...ORDER BY ${col}")` | 高 | `@Select("SELECT * FROM users ORDER BY ${sortBy}")` |
| `@Select("...WHERE ${col} = ...")` | 高 | `@Select("SELECT * FROM users WHERE ${fieldName} = #{value}")` |
| `queryWrapper.orderBy(true, true, col)` | 高 | `queryWrapper.orderBy(true, true, sort)` |
| `queryWrapper.orderByAsc(col)` / `orderByDesc(col)` | 高 | `queryWrapper.orderByAsc(userField)` |
| `queryWrapper.select(col)` | 中 | `queryWrapper.select(selectColumn)` |
| `queryWrapper.like(userField, val)` | 高 | `queryWrapper.like(fieldName, value)`（字段名可控） |
| `queryWrapper.apply(sql)` | 高（含用户输入且无占位符） | `queryWrapper.apply(field + " = '" + value + "'")` |
| `queryWrapper.apply(sql, params)` | 安全 | `queryWrapper.apply("col = {0}", userInput)`（使用 {0} 占位符，MyBatis 层预编译） |
| `queryWrapper.exists(sql)` | 需判断 sql 内容 | 子查询中若直接拼接用户输入（无占位符）→ 漏洞；子查询为固定模板或参数由 MyBatis #{} 绑定 → 安全 |
| `queryWrapper.last(sql)` | 高 | `queryWrapper.last("LIMIT " + limit)` |

**安全方法**（使用参数化或固定字段）：

| 方法 | 说明 |
|------|------|
| `@Select("...#{name}...")` | 参数化查询 |
| `queryWrapper.eq("name", val)` | 字段名固定，值参数化 |
| `queryWrapper.like("name", val)` | 字段名固定，值参数化 |
| `queryWrapper.select("id", "name")` | 固定字段列表 |
| `queryWrapper.orderByAsc("id")` | 固定排序字段 |
| `queryWrapper.apply("col = {0}", userInput)` | {0} 占位符由 MyBatis 预编译处理 |

**防御方案**：

```java
// 白名单
private static final Set<String> ALLOWED_SORT = Set.of("id", "name", "created_at");
if (!ALLOWED_SORT.contains(sort)) throw new IllegalArgumentException();
// 枚举映射：SortField.valueOf(input).name().toLowerCase()
// Map 映射：SORT_MAP.getOrDefault(input, "id")
```

---

## 5. 检索技巧

> HTTP 入口可达性检索：详见 [Java 通用检索技巧](java-common-retrieval.md#http-入口可达性检索)

### 5.1 搜索关键词

| 类型 | 关键词 |
|------|--------|
| SQL 拼接 | `String sql = "..." +`, `${}`, `String.format("SELECT` |
| MyBatis | `@Select`, `@Insert`, `@Update`, `#{} vs ${}` |
| MyBatis-Plus | `.apply(`, `.last(`, `.like(userField,`, `.orderBy(true, true,` |
| JDBC | `Statement.execute`, `PreparedStatement`, `jdbcTemplate.query` |
| JPA | `@Query`, `entityManager.createQuery`, `CriteriaBuilder` |
| 校验函数 | `ALLOWED_COLUMNS`, `WHITE_LIST`, `.contains(input)`, `Enum.valueOf` |
| 类型转换 | `Integer.parseInt`, `Long.valueOf`, `NumberUtils.toLong` |
| 环境判断 | `isProd`, `isTest`, `isDev`, `isLocal`, `Env.` |

### 5.2 检测命令

```bash
grep -rn "String sql = \".*\" +" --include="*.java"          # SQL 拼接
grep -rn "SELECT.*WHERE.*'" --include="*.java"               # WHERE 拼接
grep -rn '\${' --include="*.xml"                             # MyBatis ${}
grep -rn "\.apply(\|\.last(\|orderBy(true, true," --include="*.java"  # MP 危险方法
grep -rn "ALLOWED_COLUMNS\|WHITE_LIST" --include="*.java"    # 白名单校验
```

---

## 6. 常见误判场景

### 陷阱1：字段名拼接误判为安全

**错误**：变量名像 `sortColumn` 就假设有白名单
**正确**：需追踪来源，用户直接输入 → 漏洞

### 陷阱2：${} 过度敏感

**错误**：看到 `${}` 就判漏洞
**正确**：需检查来源——`long` 类型或 `Enum.valueOf()` → 安全

### 陷阱3：忽略类型约束

**错误**：拼接就判漏洞
**正确**：`@PathVariable Long id` → 安全（类型约束）

### 陷阱4：只看函数名不看实现

**错误**：`validateSql()` 就假定有效防护
**正确**：必须查看函数实现，黑名单/startsWith → 风险-B

### 陷阱5：JPA @Query 误判

**错误**：用户输入在 `@Query` 中就判拼接
**正确**：`:name` / `?1` 是参数化 → 安全

### 陷阱6：枚举映射误判

**错误**：看到拼接就判漏洞
**正确**：`Enum.valueOf()` → 输入必须匹配枚举名 → 安全

### 陷阱7：自定义防护注解（@SqlCheck 需检查开关默认值）

**错误**：看到 `@SqlCheck` 就认为防护有效
**正确**：搜索并读取切面实现，检查开关默认值，`Kconf.ofBoolean("xxx", false)` = 风险-B

### 陷阱8：先看防护后看漏洞本质 / 被代码对比干扰

**错误**：发现 A 处有过滤、B 处没有就判定风险
**正确**：先判断漏洞是否存在（SQL 拼接分析→参数化查询→无注入），漏洞不存在时防护问题无从谈起
> **漏洞存在性判断 > 防护有效性判断。参数不拼接 SQL = 无 SQL注入，再多的防护缺失也不是问题。**

### 陷阱9：忽略类型转换/解析函数的隐式约束

**错误**：看到 String 类型参数拼接到 SQL 就判漏洞，忽略了参数经过了解析函数
**正确**：若参数经过 `DateUtils.parseDate()` / `Integer.parseInt()` / `UUID.fromString()` 等，输出值已被约束为安全格式 → 安全；仅长度限制/黑名单 → 输出格式未被约束 → 不安全

### 陷阱10：只看 sink API 调用处，不追踪其方法内部实现

**错误**：看到封装方法调用（如 `sqlQueryBuilder.orderBy(field)`）就认为参数直接拼接进 SQL，不读取方法内部实现

**正确**：对 sink 调用链上出现的非标准库封装方法，必须追踪其内部实现，确认是否存在拦截型校验（如正则白名单、枚举约束等）；方法内部有拦截型校验时，判定为安全

### 陷阱11：混淆"数据库客户端选择"与"SQL参数拼接"

**错误**：
看到数据流到达 SQL 执行代码附近（如 `client.query()`, `jdbcTemplate.execute()`），就假定用户输入拼进了 SQL。

**正确**：
必须严格区分：
1. SQL参数拼接：用户输入直接拼接到 SQL 字符串中 → 漏洞
2. 客户端选择：用户输入仅用于选择数据库连接/客户端 → 安全

```java
// 安全：region 仅用于选择客户端，不参与 SQL 构建
String region = request.getParameter("region");
ClickHouseClientEnum clientEnum = ClickHouseClientEnum.valueOf(
    StringUtils.join(region, "_", originEnum.name())
);
IEventClickHouseClient client = getEventClient(clientEnum);
client.query(sql);  // region 从未拼接到 sql 中，只是选择客户端

// 漏洞：tableName 直接拼接到 SQL
String tableName = request.getParameter("table");
String sql = "SELECT * FROM " + tableName;
client.query(sql);
```

**关键区分方法**：参见 `2.1.1` 节强制检查步骤。

### 陷阱12：gRPC 参数默认假设用户可控，未追踪调用方

**错误**：看到 gRPC 接口参数（如 `request.getMerchantId()`）就认为是外部用户自由输入，直接判定为用户可控
**正确**：gRPC 接口的调用方可能是内部可信服务；需追踪调用链上游，确认调用方身份；若调用方为内部服务且参数值由服务端分配（如商户ID、租户ID等系统标识），则参数来自可信数据源，不构成用户可控输入

### 陷阱13：历史备注含"已校验"时未追查校验位置

**错误**：历史备注出现"底层已校验"、"已进行过校验"等描述，直接理解为"数据源选择"或忽略，未追问校验的实际位置和方式
**正确**：历史备注出现任何"校验"、"已防护"、"白名单"字样时，必须搜索并读取对应校验代码，确认校验位置、校验方式和覆盖范围，再决定是否采信

---

## 7. 特殊风险

### MyBatis 动态 SQL

```xml
SELECT * FROM ${tableName} WHERE id = #{id}  <!-- 漏洞 -->
ORDER BY ${orderBy}                          <!-- 漏洞 -->
${whereClause}                               <!-- 漏洞 -->
```

### HQL/JPQL 拼接

```java
String hql = "FROM User WHERE name = '" + name + "'";
session.createQuery(hql);  // 漏洞
```

### 公司组件 Sink 点

| 组件 | 特征 | 判定逻辑 |
|------|------|----------|
| KwaiSQL | `KwaiSQL.builder().sql()` / `.execute(sql)` | 检查 SQL 参数来源，用户直接输入 → 优先怀疑有效 |
| ClickHouse SDK | `ClickHouseStatementImpl.execute(sql)` | SQL 参数直接执行，确认是否用户可控 |
| AD Report SDK | `AdReport` / `ReportXxxService` / 包名 `ad.report` | **无法确认**（SQL 模板在外部平台） |

---

## 8. 变更影响分析

| 变更类型 | 变更内容 | 风险 |
|----------|----------|------|
| 新增 | 新增 SQL 拼接 | 检查是否参数化（?#{}占位符） |
| 新增 | 新增 MyBatis 动态 SQL | 检查 ${} vs #{}，${} 为拼接 |
| 修改 | 从 #{} 改为 ${} | 引入漏洞 |
| 修改 | 移除字段名白名单 | 扩大攻击面 |
| 删除 | 删除白名单校验 | 移除防护 |
| 删除 | 删除环境判断 | 可能在线上执行 |

---

## 9. 质量门禁（强制执行）

在输出审计结论前，按顺序验证：

- [ ] 黄金法则强制执行顺序已遵守（先检查 SQL 拼接分析）
- [ ] 研判流程按顺序执行，无跳过
- [ ] 漏洞本质判断先于防护判断（参数化查询直接终止）
- [ ] 客户端选择检查已执行（用户输入是否实际进入 SQL 字符串）
- [ ] 非标准库封装方法已追踪内部实现
- [ ] HTTP 入口可达性已确认，非假设
- [ ] SQL 结构拆解已完成（字段名 vs 值位置）
- [ ] 历史记录冲突已追溯确认
- [ ] 结论与证据一致，代码行号可追溯
- [ ] 已应用误报排除规则

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**

**禁止清单**：
- 禁止看到 `${}` 就判漏洞（需检查来源是否 long/Enum）
- 禁止拼接就判漏洞（int/long/Enum 类型拼接安全）
- 禁止 String 参数拼接就判漏洞（需检查是否经过解析/转换函数）
- 禁止仅看函数名判断安全性（必须读取实现）
- 禁止假设 MyBatis-Plus 方法默认安全（需确认字段是否固定）
- 禁止在研判流程中跳过任何步骤
