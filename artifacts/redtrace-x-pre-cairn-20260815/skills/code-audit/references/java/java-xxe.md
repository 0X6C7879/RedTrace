# XXE

## 0. 黄金法则

> **漏洞存在性判断 优先于 防护有效性判断**
>
> disallow-doctype-decl=true / 使用 XmlDtdSafeguard = 无 XXE（这是漏洞本质判断，不是防护有效判断）
>
> 满足此条件时：立即终止分析，无需检查任何防护措施。

**强制执行顺序**：
1. **首先**：找到 sink 点 XML 解析代码（如 `DocumentBuilder.parse()`, `SAXParser.parse()`）
2. **然后**：分析 XML 数据来源和解析器配置
3. **仅当** DTD 未禁用且数据源用户可控时，才继续检查防护措施
4. **禁止**：一上来就检查"有没有安全配置"、"A 有 B 没有"

---

## 1. 结论判断标准

| 结论 | 定义 | 判定条件 |
|------|------|----------|
| **漏洞** | 用户输入可通过 HTTP/gRPC 入口到达 XML 解析点，无有效防护 | 危险解析器 + 用户可控数据 + HTTP 入口可达 + 无 DTD/外部实体防护 |
| **风险-A** | 危险解析代码存在但无外部入口可达 | 危险解析器 + 内部调用，无 HTTP/gRPC 入口 |
| **风险-B** | 有入口可达但防护不充分 | 危险解析器 + 用户输入 + 仅部分 DTD 禁用（如仅禁用外部实体） |
| **安全** | 无危险写法，或有充分防护 | disallow-doctype-decl=true / XmlDtdSafeguard / 固定配置文件 / 非线上环境 |

---

## 2. 研判思路

### 2.1 XML 解析器安全特性（第一优先级）

| 解析器 | 包路径 | 危险 API | 判定 |
|--------|--------|----------|------|
| DocumentBuilder | javax.xml.parsers | `parse()` | 需检查 DTD 配置 |
| SAXParser | javax.xml.parsers | `parse()` | 需检查 DTD 配置 |
| XMLReader | org.xml.sax | `parse()` | 需检查 DTD 配置 |
| SAXReader | org.dom4j.io | `read()` | 需检查 DTD 配置 |
| SAXBuilder | org.jdom2.input | `build()` | 需检查 DTD 配置 |
| XMLInputFactory | javax.xml.stream | `createXMLStreamReader()` | 需检查 DTD 配置 |
| TransformerFactory | javax.xml.transform | `newTransformer()` | 需检查 DTD 配置（XSLT） |
| Unmarshaller | javax.xml.bind | `unmarshal()` | 需检查 DTD 配置 |
| Digester | org.apache.commons.digester3 | `parse()` | 需检查 DTD 配置 |

> 以上均为危险解析器，默认支持 DTD 和外部实体。

### 2.2 研判流程

```
Step 1: 解析器识别
  ├─ 危险解析器（上表）？ → 继续
  └─ 非危险（如 Jsoup）？ → 安全

Step 2: DTD/外部实体防护检查
  ├─ disallow-doctype-decl=true / XmlDtdSafeguard？ → 安全
  ├─ 外部实体组合禁用？ → 安全
  └─ 无防护 → 继续

Step 3: 数据来源检查
  ├─ 固定配置文件？ → 安全
  ├─ 内部 API 返回且用户不可控？ → 安全
  └─ 用户输入 → 继续

Step 4: HTTP 入口可达性
  ├─ 无 HTTP/gRPC 入口？ → 风险
  └─ 有入口 → 漏洞
```

### 2.3 降级条件表

| 条件 | 原结论 | 降级后 |
|------|--------|--------|
| disallow-doctype-decl=true | 漏洞 | 安全 |
| XmlDtdSafeguard | 漏洞 | 安全 |
| 外部实体组合禁用 | 漏洞 | 安全 |
| 固定配置文件 | 漏洞 | 安全 |
| 非线上环境 | 漏洞 | 安全 |

### 2.4 总结判定表

| 检查项 | 结论 |
|--------|------|
| disallow-doctype-decl=true / XmlDtdSafeguard / 固定配置文件 | 安全 |
| 默认配置 + 用户输入 + HTTP 入口 | 漏洞 |
| 仅部分 DTD 禁用（如仅禁用外部实体） | 风险-B |
| 内部方法无 HTTP/gRPC 入口 | 风险-A |

---

## 3. 常见漏洞/风险场景

### 漏洞

```java
// 默认配置解析用户输入
DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(userInput);  // 漏洞
SAXReader.read(file.getInputStream());  // 漏洞
XMLReaderFactory.createXMLReader().parse(xmlData);  // 漏洞
context.createUnmarshaller().unmarshal(xmlData);  // 漏洞
```

### 风险-A

```java
// 内部方法需追踪调用方
private void parseConfig(String xml) { ... }  // 风险：需追踪调用方是否有 HTTP 入口
```

### 风险-B

```java
// 仅禁用外部实体，缺少 disallow-doctype-decl → 参数实体可绕过
dbf.setFeature("http://xml.org/sax/features/external-general-entities", false);
// 缺少 external-parameter-entities=false 和 load-external-dtd=false
```

---

## 4. 常见防御模式

### DTD 完全禁用

```java
dbf.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);  // 最强防护
```

### 外部实体组合禁用

```java
dbf.setFeature("http://xml.org/sax/features/external-general-entities", false);
dbf.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
dbf.setFeature("http://apache.org/xml/features/nonvalidating/load-external-dtd", false);
```

### XmlDtdSafeguard / 固定配置文件

```java
XmlDtdSafeguard.safeParse(xmlInput);  // 安全：公司统一防护组件
db.parse(new File("/etc/app/config.xml"));  // 安全：固定路径
```

---

## 5. 检索技巧

> HTTP 入口可达性检索：详见 [Java 通用检索技巧](java-common-retrieval.md#http-入口可达性检索)

### 搜索关键词

| 类型 | 关键词 |
|------|--------|
| 解析器 | DocumentBuilder, SAXParser, XMLReader, SAXReader, SAXBuilder, Unmarshaller |
| 安全特征 | disallow-doctype-decl, XmlDtdSafeguard |
| 工厂类 | DocumentBuilderFactory, SAXParserFactory, XMLReaderFactory |

### 检测命令

```bash
# 检测 XML 解析器
grep -rn "DocumentBuilder\|SAXParser\|XMLReader\|SAXReader\|Unmarshaller" --include="*.java"

# 检测安全配置
grep -rn "disallow-doctype-decl\|XmlDtdSafeguard" --include="*.java"

# 检测危险方法
grep -rn "\.parse(\|\.read(\|\.build(\|\.unmarshal(" --include="*.java"
```

---

## 6. 常见误判场景

### 陷阱1：FEATURE_SECURE_PROCESSING 误判

**错误**: 看到 `setFeature(FEATURE_SECURE_PROCESSING, true)` 就认为安全
**正确**: 此特性不能完全防护 XXE，仍需显式设置 `disallow-doctype-decl=true`

### 陷阱2：部分防护不足

**错误**: 仅设置 `external-general-entities=false`
**正确**: 参数实体可绕过，需完整配置所有 DTD/外部实体相关特性

### 陷阱3：方法名误导

**错误**: 看到 `createSecureBuilder()` / `safeParseXml()` 就认为安全
**正确**: 必须读取方法实现确认实际配置

### 陷阱4：先看防护后看漏洞本质

**错误思路**：发现代码缺少安全配置 → 发现 A 有配置 B 没有 → 判定风险
**正确思路**：先判断漏洞是否存在（固定配置文件 → 无 XXE）→ 漏洞不存在时防护问题无从谈起

> 漏洞存在性判断 > 防护有效性判断。固定配置文件 = 无 XXE，防护缺失不再是问题。

### 陷阱5：被代码对比干扰

**错误判定**：A 有安全配置 B 没有 → B 有风险
**正确判定**：先看 B 漏洞是否存在（数据源是否用户可控），再谈防护

> 代码不一致 ≠ 安全问题。要回答"没有这个配置会导致什么漏洞"，而不是"没有配置就是风险"。

---

## 7. 特殊风险

### TransformerFactory XSLT 风险

TransformerFactory 用于 XSLT 转换，同样支持外部实体。需设置安全特性或使用 XmlDtdSafeguard。

### XmlDtdSafeguard 公司组件

公司统一 XXE 防护组件，`XmlDtdSafeguard.safeParse()` 封装了完整的安全配置，优先使用。

### FEATURE_SECURE_PROCESSING 局限性

`FEATURE_SECURE_PROCESSING` 不能完全防护 XXE，仅限制部分处理功能。仍需显式设置 `disallow-doctype-decl=true`。

---

## 8. 变更影响分析

| 变更类型 | 变更内容 | 风险 |
|----------|----------|------|
| 新增 | 新增 XML 解析代码 | 确认解析器类型，disallow-doctype-decl=true / XmlDtdSafeguard → 安全；其他 → 需检查 DTD 配置 |
| 新增 | 新增第三方 XML 库（dom4j/jdom2/woodstox 等） | 确认 DTD/外部实体是否禁用 |
| 修改 | 从安全库改为危险解析器 | 引入 DTD 风险 |
| 修改 | 移除 DTD/外部实体禁用配置 | 引入 XXE 风险 |
| 修改 | 改用用户输入 XML | 扩大攻击面 |
| 删除 | 删除 DTD 禁用配置 | 移除防护 |
| 删除 | 删除环境判断 | 可能在线上执行 |

## 9. 质量门禁（强制执行）

在输出审计结论前，按顺序验证：

- [ ] 强制执行顺序已遵守（先检查解析器类型）
- [ ] 解析器类型已正确识别（危险 vs 非危险）
- [ ] DTD/外部实体防护已检查（disallow-doctype-decl / XmlDtdSafeguard）
- [ ] HTTP 入口可达性已确认，非假设
- [ ] 结论与证据一致，代码行号可追溯
- [ ] 已应用误报排除规则（固定配置文件、FEATURE_SECURE_PROCESSING 不完全安全）
- [ ] 不因代码对比而判定风险

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**
