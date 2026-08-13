# 反序列化

## 0. 黄金法则

> **漏洞存在性判断 优先于 防护有效性判断**
>
> 指定具体类型 / 使用安全构造器 = 无反序列化漏洞（这是漏洞本质判断，不是防护有效判断）
>
> 满足此条件时：立即终止分析，无需检查任何防护措施。

**强制执行顺序**：
1. **首先**：找到 sink 点反序列化代码（如 `readObject()`, `Yaml.load()`, `parseObject()`）
2. **然后**：分析是否有类型限制/安全构造器
3. **仅当** 类型无限制时，才继续检查防护措施
4. **禁止**：一上来就检查"有没有安全配置"、"A 有 B 没有"

---

## 1. 结论判断标准

| 结论 | 定义 | 判定条件 |
|------|------|----------|
| **漏洞** | 用户输入可通过 HTTP/gRPC 入口到达反序列化点，无有效防护 | 1. 存在反序列化操作; 2. 数据流可追踪到 HTTP/gRPC 入口; 3. 无类型限制/使用危险配置 |
| **风险-A** | 存在反序列化但无 HTTP/gRPC 入口可达（内部调用） | 1. 存在反序列化操作; 2. 数据流不可追踪到外部入口; 3. 非测试/非配置代码 |
| **风险-B** | 反序列化有 HTTP 入口可达，但防护措施不充分 | 1. 存在反序列化操作; 2. HTTP 入口可达; 3. 有弱防护（如部分类型限制、未完全禁用 autoType） |
| **安全** | 无危险写法，或危险写法有充分的有效防护 | 1. 指定具体类型; 2. 使用安全构造器; 3. 关闭 autoType; 4. 有效类型过滤 |

---

## 2. 漏洞风险的研判思路

### 2.1 反序列化 API 识别（第一优先级）

| API | 危险等级 | 说明 |
|-----|----------|------|
| `XMLDecoder.readObject()` | 极高 | 可执行任意代码 |
| `ObjectInputStream.readObject()` | 高 | 可RCE |
| `Yaml.load()`（默认 Constructor） | 高 | 允许任意类 |
| `Fastjson.parseObject()`（AutoType 开启） | 高 | 取决于版本 |
| `Jackson.enableDefaultTyping()` | 高 | 允许类型信息 |
| `XStream.fromXML()`（无白名单） | 高 | 可实例化任意类 |

### 2.2 研判流程

```
Step 1: 环境检查
  ├─ 非线上环境？ → 安全
  └─ 线上环境/无判断 → 继续

Step 2: API 识别与类型限制检查
  ├─ 指定具体类型？ → 安全
  ├─ 使用 SafeConstructor？ → 安全
  ├─ 关闭 autoType？ → 安全
  ├─ 使用 ObjectInputFilter？ → 安全
  └─ 类型无限制 → 继续

Step 3: 数据来源检查
  ├─ 来自 Kconf/配置文件？ → 安全
  ├─ 来自数据库（非用户字段）？ → 安全
  └─ 用户输入/来源不明 → 继续

Step 4: HTTP 入口可达性分析
  ├─ 无 HTTP/gRPC 入口？ → 风险-A
  └─ 有 HTTP/gRPC 入口 → 继续

Step 5: 最终判定
  ├─ 无防护 → 漏洞
  ├─ 有弱防护 → 风险-B
  └─ 有有效防护 → 安全
```

### 2.3 降级条件表

| 条件 | 原结论 | 降级后 |
|------|--------|--------|
| 指定具体类型 / SafeConstructor / 关闭 autoType | 漏洞 | 安全 |
| ObjectInputFilter 有效 | 漏洞 | 安全 |
| 数据来自 Kconf/配置/数据库 | 漏洞 | 安全 |
| 签名验证有效 | 漏洞 | 安全 |
| 无 HTTP 入口可达 | 漏洞 | 风险-A |
| 部分类型限制 | 漏洞 | 风险-B |

### 2.4 总结判定表

| 检查项 | 结论 |
|--------|------|
| 指定具体类型 / SafeConstructor / 关闭 autoType | 安全 |
| 数据来自 Kconf/配置/数据库 | 安全 |
| 类型无限制 + 用户输入 + HTTP 入口 | 漏洞 |
| 有部分类型限制但不足 | 风险-B |
| 无 HTTP 入口 | 风险-A |

---

## 3. 常见漏洞/风险场景

### 场景1：Java 原生反序列化 / Jackson / Fastjson

```java
ObjectInputStream ois = new ObjectInputStream(new ByteArrayInputStream(data));
return ois.readObject();  // 漏洞

mapper.enableDefaultTyping(ObjectMapper.DefaultTyping.NON_FINAL);
return mapper.readValue(json, Object.class);  // 漏洞

ParserConfig.getGlobalInstance().setAutoTypeSupport(true);
return JSON.parseObject(json, Object.class);  // 漏洞
```

### 场景2：SnakeYAML / XStream / XMLDecoder

```java
new Yaml().load(yaml);  // 漏洞
xStream.fromXML(xml);   // 漏洞
new XMLDecoder(request.getInputStream()).readObject();  // 漏洞（极高危）
```

### 场景3：风险-B（防护不足）

```java
ParserConfig.getGlobalInstance().addAccept("com.example.");  // 风险-B：包名白名单范围过大
xStream.denyTypes(new String[]{"java.lang.ProcessBuilder"});  // 风险-B：黑名单
Object obj = mapper.readValue(json, Object.class);
if (!(obj instanceof String)) throw ...;  // 风险-B：类型检查在反序列化后
```

---

## 4. 常见防御模式

```java
// 指定具体类型
User user = mapper.readValue(json, User.class);  // 安全

// SafeConstructor
new Yaml(new SafeConstructor()).load(yaml);  // 安全

// 关闭 autoType
ParserConfig.getGlobalInstance().setAutoTypeSupport(false);  // 安全

// ObjectInputFilter
ObjectInputFilter filter = ObjectInputFilter.Config.createFilter("java.base/*;java.lang.*;!*");
new ObjectInputStream(in, filter);  // 安全

// 类型白名单
xStream.allowTypes(new String[]{"com.example.SafeClass"});  // 安全

// 可信数据源
kconf.get("config");  // 安全
repository.getData(id);  // 安全（内部写入）
```

---

## 5. 检索技巧

> HTTP 入口可达性检索：详见 [Java 通用检索技巧](java-common-retrieval.md#http-入口可达性检索)

### 关键 Sink 点

| 方法 | 危险级别 |
|------|----------|
| `XMLDecoder.readObject()` | 极高 |
| `ObjectInputStream.readObject()` / `readUnshared()` | 高 |
| `Yaml.load()` | 高 |
| `Fastjson.parseObject()` / `parse()` | 高 |
| `Jackson.enableDefaultTyping()` | 高 |
| `XStream.fromXML()` / `fromJSON()` | 高 |
| `Jackson.readValue(json, Object.class)` | 中 |

### 检测命令

```bash
# 检测反序列化 API
grep -rn "readObject\|readValue\|parseObject\|\.load(" --include="*.java"

# 检测危险配置
grep -rn "enableDefaultTyping\|setAutoTypeSupport" --include="*.java"

# 检测 XMLDecoder / XStream
grep -rn "XMLDecoder\|XStream\|fromXML" --include="*.java"
```

---

## 6. 常见误判场景

### 陷阱1：Fastjson 版本误判

**错误**: 认为 `parseObject` 默认安全
**正确**: 1.2.25 之前 AutoType 默认开启，需检查版本和配置

### 陷阱2：Jackson enableDefaultTyping 误判

**错误**: 认为 Jackson 默认安全
**正确**: 默认安全，但 `enableDefaultTyping()` 会启用类型信息 → 漏洞

### 陷阱3：忽略数据来源

**错误**: 看到 Fastjson 就判定漏洞
**正确**: 需追溯数据来源——配置文件/缓存（内部写入）→ 安全

### 陷阱4：类型检查时机误判

**错误**: 反序列化后做 `instanceof` 检查就认为安全
**正确**: 反序列化已完成，攻击代码可能已执行 → 风险-B/漏洞

---

## 7. 特殊风险

### Gadget Chain（利用链）

Java 反序列化的核心威胁是 Gadget Chain——攻击者不直接执行代码，而是利用classpath中已有类（如 CommonsCollections、CommonsBeanutils、Spring 等）的特定方法链完成 RCE。

| 利用链 | 影响 |
|--------|------|
| CommonsCollections (3.1-4.0) | RCE（TransformedMap / LazyMap） |
| CommonsBeanutils | RCE（无 CommonsCollections 依赖也可利用） |
| Fastjson AutoType | RCE（JdbcRowSetImpl → JNDI 注入） |
| Jackson enableDefaultTyping | RCE（通过 TemplatesImpl / ClassPathXmlApplicationContext） |

### JNDI 注入联动

反序列化常与 JNDI 注入联动：`ObjectInputStream.readObject()` → 触发 JNDI lookup → 加载远程恶意 Class → RCE。

---

## 8. 变更影响分析

| 变更类型 | 变更内容 | 风险 |
|----------|----------|------|
| 新增 | 新增反序列化操作 | 检查 API 类型、数据来源、类型限制 |
| 新增 | 开启 autoType | 可能引入漏洞 |
| 新增 | 新增依赖反序列化库 | 检查库版本和默认配置 |
| 修改 | 移除类型限制 | 扩大攻击面 |
| 修改 | 改用 Object.class | 移除类型限制 |
| 修改 | 移除 SafeConstructor | 移除防护 |
| 删除 | 删除 ObjectInputFilter | 移除防护 |
| 删除 | 删除白名单配置 | 移除防护 |

---

## 9. 质量门禁（强制执行）

在输出审计结论前，按顺序验证：

- [ ] 黄金法则强制执行顺序已遵守（先检查类型限制/安全构造器）
- [ ] 研判流程按顺序执行，无跳过
- [ ] 漏洞本质判断先于防护判断（指定类型直接终止）
- [ ] HTTP 入口可达性已确认，非假设
- [ ] 反序列化 API 识别正确（DocumentBuilder vs YAML vs Fastjson）
- [ ] 结论与证据一致，代码行号可追溯
- [ ] 已应用误报排除规则

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**
