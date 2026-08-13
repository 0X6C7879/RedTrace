# XXE

## 0. 黄金法则

> **漏洞存在性判断 优先于 防护有效性判断**
>
> 禁用 DTD / 使用 fast-xml-parser v4+ 默认配置 = 无 XXE（这是漏洞本质判断，不是防护有效判断）
>
> 满足此条件时：立即终止分析，无需检查任何防护措施。

**强制执行顺序**：
1. **首先**：找到 sink 点 XML 解析调用（如 `parseXml()`, `parseFromString()`）
2. **然后**：分析解析器是否支持 DTD 以及是否已禁用
3. **仅当** DTD 未禁用时，才继续检查防护措施
4. **禁止**：一上来就检查"有没有环境判断"、"A 有 B 没有"

---

## 1. 结论判断标准

| 结论 | 定义 | 判定条件 |
|------|------|----------|
| **漏洞** | XML 解析器未禁用 DTD/外部实体，用户可控数据经 HTTP 入口到达 | 1. 使用支持 DTD 的解析器；2. 未禁用外部实体；3. 数据流可追踪到 HTTP 入口；4. 无有效防护 |
| **风险-A** | 解析配置不安全但无 HTTP 入口可达 | 1. 使用危险解析器；2. 数据流不可追踪到外部入口；3. 非测试/配置代码 |
| **风险-B** | 有 HTTP 入口但防护不充分 | 1. 存在 XML 解析；2. HTTP 入口可达；3. 有部分防护（如环境判断不完整） |
| **安全** | 无危险写法或有充分防护 | fast-xml-parser v4+ 默认配置 / 已禁用 DTD / 可信数据源 / 非线上环境 |

---

## 2. 研判思路

### 2.1 XML 解析器安全特性（第一优先级）

| 解析器 | 包路径 | DTD 支持 | 默认安全 | 判定 |
|--------|--------|----------|----------|------|
| fast-xml-parser v4+ | `fast-xml-parser` | 支持（可禁用） | 是 | 安全（立即终止） |
| fast-xml-parser v3 | `fast-xml-parser` | 支持 | 否 | 需继续研判 |
| libxmljs | `libxmljs` | 支持 | 否 | 需继续研判 |
| xmldom | `xmldom` | 支持 | 否 | 需继续研判 |
| xml2js | `xml2js` | 支持 | 否 | 需继续研判 |
| express-xml-bodyparser | `express-xml-bodyparser` | 支持 | 否 | 需继续研判 |

> JavaScript XML 解析器大多基于 libxml2，默认支持 DTD 和外部实体。

### 2.2 研判流程

```
Step 1: 解析器识别
  ├─ fast-xml-parser v4+ 默认配置？ → 安全
  ├─ libxmljs/xmldom/xml2js/express-xml-bodyparser？ → 继续
  └─ 其他解析器？ → 需确认库特性

Step 2: DTD/外部实体防护检查
  ├─ 已禁用 DTD/外部实体？ → 安全
  └─ 未禁用 → 继续

Step 3: 数据来源检查
  ├─ 固定配置文件？ → 安全
  ├─ 内部 API 返回且用户不可控？ → 安全
  └─ 用户输入 → 继续

Step 4: HTTP 入口可达性
  ├─ 无 HTTP 入口？ → 风险-A
  └─ 有 HTTP 入口 → 漏洞
```

### 2.3 降级条件表

| 条件 | 原结论 | 降级后 |
|------|--------|--------|
| fast-xml-parser v4+ 默认配置 | 漏洞 | 安全 |
| 已禁用 DTD/外部实体 | 漏洞 | 安全 |
| 固定配置文件 | 漏洞 | 安全 |
| 非线上环境 | 漏洞 | 安全 |
| 无 HTTP 入口 | 漏洞 | 风险-A |

### 2.4 总结判定表

| 检查项 | 结论 |
|--------|------|
| fast-xml-parser v4+ / 已禁用 DTD / 固定配置文件 | 安全 |
| libxmljs/xmldom/xml2js/express-xml-bodyparser 默认配置 + 用户输入 + HTTP 入口 | 漏洞 |
| 仅环境判断不完整 | 风险-B |
| 内部方法无 HTTP 入口 | 风险-A |

---

## 3. 常见漏洞/风险场景

### 场景1：libxmljs 解析用户输入

```javascript
const xmlDoc = libxmljs.parseXml(req.body.xml);  // 漏洞：默认支持 DTD
```

### 场景2：xmldom 解析用户输入

```javascript
const doc = new dom.DOMParser().parseFromString(req.body.xml);  // 漏洞
```

### 场景3：xml2js 解析

```javascript
parser.parseString(req.body.xml, (err, result) => { ... });  // 漏洞
```

### 场景4：express-xml-bodyparser 默认配置

```javascript
app.use(xmlBodyParser());  // 漏洞：中间件默认不安全
```

**风险-A**：内部方法使用危险解析器但无 HTTP 入口可达（如 `parseInternalConfig(xmlData)`）。

**风险-B**：有 HTTP 入口但仅有不完整的环境判断（如 `if (process.env.NODE_ENV === 'development')`）。

---

## 4. 常见防御模式

### fast-xml-parser v4+ 默认安全

```javascript
const parser = new XMLParser();  // v4+ 默认安全
const result = parser.parse(req.body.xml);
```

### libxmljs 禁用 DTD

```javascript
libxmljs.parseXml(xml, {
    noent: false, dtdload: false, dtdattr: false, nonet: true
});  // 安全
```

### xml2js 禁用实体

```javascript
new xml2js.Parser({ explicitCharKeys: true, strict: true });  // 安全
```

### 固定配置文件

```javascript
const xmlContent = fs.readFileSync('/etc/app/config.xml', 'utf8');
const xmlDoc = libxmljs.parseXml(xmlContent);  // 安全：固定文件
```

---

## 5. 检索技巧

| 类型 | 关键词 |
|------|--------|
| XML 解析 | `parseXml`, `parseFromString`, `parseString`, `XMLParser` |
| 危险库 | `libxmljs`, `xmldom`, `xml2js`, `express-xml-bodyparser` |
| 安全库 | `fast-xml-parser` |
| 安全配置 | `noent`, `dtdload`, `processEntities` |

```bash
# 检测 XML 解析库
grep -rn "libxmljs\|xmldom\|xml2js\|fast-xml-parser\|express-xml-bodyparser" --include="*.js"

# 检测 XML 解析方法
grep -rn "parseXml\|parseFromString\|parseString\|XMLParser" --include="*.js"

# 检测 DTD/实体相关配置
grep -rn "noent\|dtdload\|dtdattr\|processEntities\|ignoreAttributes" --include="*.js"
```

---

## 6. 常见误判场景

### 陷阱1：假设所有 JS 解析器安全

JavaScript XML 处理不如 Java/Python 常见，但 libxmljs、xmldom、xml2js 支持 DTD → 存在 XXE 风险。

### 陷阱2：fast-xml-parser 版本差异

v3 默认不安全，v4+ 默认安全。需确认 `package.json` 中的版本号，不能看到库名就判定安全。

### 陷阱3：express 中间件默认不安全

express-xml-bodyparser 默认不安全，不能因为 Express 框架而假设有默认保护。建议替换为 fast-xml-parser v4+。

### 陷阱4：先看防护后看漏洞本质

发现缺少环境判断就判风险 → 应先判断漏洞是否存在（DTD 是否已禁用）。漏洞不存在时，防护缺失无从谈起。

### 陷阱5：被代码对比干扰

A 有 DTD 禁用配置 B 没有 → 先看 B 漏洞是否存在，再谈防护。代码不一致 ≠ 安全问题。

---

## 7. 特殊风险

### fast-xml-parser 版本差异

v3 默认处理实体（不安全），v4+ 默认禁用 DTD。需确认 `package.json` 中的版本号。
v3 安全配置：`{ processEntities: false, ignoreAttributes: true }`

### express-xml-bodyparser

默认不安全，建议替换为 fast-xml-parser v4+。

---

## 8. 变更影响分析

| 变更类型 | 变更内容 | 风险 |
|----------|----------|------|
| 新增 | 新增 XML 解析代码 | 确认解析器类型，fast-xml-parser v4+ → 安全；libxmljs/xmldom/xml2js/express-xml-bodyparser → 需检查 DTD 配置 |
| 新增 | 新增第三方 XML 库（libxmljs/xmldom/xml2js/express-xml-bodyparser） | 确认 DTD/外部实体是否禁用 |
| 修改 | 从安全库改为危险解析器 | 引入 DTD 风险 |
| 修改 | 移除 DTD/外部实体禁用配置 | 引入 XXE 风险 |
| 修改 | 改用用户输入 XML | 扩大攻击面 |
| 删除 | 删除 DTD 禁用配置 | 移除防护 |
| 删除 | 删除环境判断 | 可能在线上执行 |

## 9. 质量门禁（强制执行）

在输出审计结论前，按顺序验证：

- [ ] 强制执行顺序已遵守（先检查解析器类型和版本）
- [ ] 解析器安全特性已确认（libxmljs / xmldom / fast-xml-parser 版本）
- [ ] DTD/外部实体禁用配置已检查
- [ ] HTTP 入口可达性已确认，非假设
- [ ] 结论与证据一致，代码行号可追溯
- [ ] 已应用误报排除规则（fast-xml-parser v4+ 默认安全、固定配置文件）
- [ ] 不因代码对比而判定风险

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**
