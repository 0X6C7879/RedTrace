# XXE

## 0. 黄金法则

> **漏洞存在性判断 优先于 防护有效性判断**
>
> 使用 encoding/xml = 无 XXE（这是漏洞本质判断，不是防护有效判断）
>
> 满足此条件时：立即终止分析，无需检查任何防护措施。

**强制执行顺序**：
1. **首先**：找到 sink 点 XML 解析代码（如 `xml.Unmarshal()`, `xml.Decoder()`）
2. **然后**：分析使用的解析器类型
3. **仅当** 使用支持 DTD 的解析器时，才继续检查防护措施
4. **禁止**：一上来就检查"有没有安全配置"、"A 有 B 没有"

---

## 1. 结论判断标准

| 结论 | 定义 | 判定条件 |
|------|------|----------|
| **漏洞** | XML 解析器未禁用 DTD/外部实体，用户可控 XML 数据 | 1. 使用支持 DTD 的解析器; 2. 未禁用外部实体; 3. HTTP 入口可达; 4. 无有效防护 |
| **风险-A** | 危险解析器但无 HTTP 入口可达 | 1. 使用危险解析器; 2. 无外部入口 |
| **风险-B** | 有 HTTP 入口可达，但防护不充分 | 1. 存在 XML 解析; 2. HTTP 入口可达; 3. 仅有弱防护 |
| **安全** | 无危险写法，或有充分防护 | encoding/xml / 已禁用 DTD / 可信数据源 / 非线上环境 |

---

## 2. 漏洞风险的研判思路

### 2.1 XML 解析器安全特性（第一优先级）

| 解析器 | 包路径 | DTD 支持 | 默认安全 | 判定 |
|--------|--------|----------|----------|------|
| encoding/xml | `encoding/xml` | 不支持 | 是 | 安全（立即终止） |
| libxml2 | `github.com/lestrrat-go/libxml2` | 支持 | 否 | 需继续研判 |
| go-xslt | `github.com/wamuir/go-xslt` | 支持 | 否 | 需继续研判 |
| gokogiri | `github.com/moovweb/gokogiri` | 支持 | 否 | 需继续研判 |

> Go 标准库 `encoding/xml` 不支持 DTD 和外部实体，默认安全。

### 2.2 研判流程

```
Step 1: 解析器识别
  ├─ encoding/xml？ → 安全（默认不支持 DTD）
  ├─ libxml2/go-xslt/gokogiri？ → 继续
  └─ 其他第三方库？ → 需确认库特性

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
| 使用 encoding/xml | 漏洞 | 安全 |
| 已禁用 DTD/外部实体 | 漏洞 | 安全 |
| 固定配置文件 | 漏洞 | 安全 |
| 非线上环境 | 漏洞 | 安全 |
| 无 HTTP 入口 | 漏洞 | 风险-A |

### 2.4 总结判定表

| 检查项 | 结论 |
|--------|------|
| encoding/xml / 已禁用 DTD / 固定配置文件 | 安全 |
| libxml2/go-xslt/gokogiri + 用户输入 + 未禁用 DTD + HTTP 入口 | 漏洞 |
| 仅环境判断 / 简单过滤 | 风险-B |
| 内部方法无 HTTP 入口 | 风险-A |

---

## 3. 常见漏洞/风险场景

### 场景1：libxml2 解析用户输入（无防护）

```go
doc, _ := libxml2.ParseXml(userXml)  // 漏洞：支持 DTD，无防护
```

### 场景2：go-xslt 转换用户 XML

```go
result, _ := xslt.Transform(userXml, stylesheet)  // 漏洞：支持 XSLT 外部实体
```

### 场景3：内部方法无入口

```go
func parseInternalConfig() {
    doc, _ := libxml2.ParseXml(getInternalData())  // 风险-A：需追踪数据来源
}
```

---

## 4. 常见防御模式

### encoding/xml 标准库

```go
var config Config
xml.Unmarshal(userXml, &config)  // 安全：不支持 DTD
```

### libxml2 禁用 DTD

```go
opts := libxml2.ParseOption{DisableDTD: true, DisableEntities: true}
doc, _ := libxml2.ParseXmlWithOptions(userXml, opts)  // 安全
```

### 固定配置文件

```go
decoder := xml.NewDecoder(file)  // 安全：XML 来自服务器端固定配置
```

---

## 5. 检索技巧

| 类型 | 关键词 |
|------|--------|
| XML 解析 | `xml.Unmarshal`, `xml.Decoder`, `ParseXml` |
| 危险库 | `libxml2`, `go-xslt`, `gokogiri` |
| 安全配置 | `DisableDTD`, `DisableEntities`, `ParseXmlWithOptions` |

```bash
grep -rn "xml.Unmarshal\|xml.NewDecoder\|ParseXml" --include="*.go"
grep -rn "libxml2\|go-xslt\|gokogiri" --include="*.go"
grep -rn "DisableDTD\|DisableEntities" --include="*.go"
```

---

## 6. 常见误判场景

### 陷阱1：encoding/xml 误判为 XXE

**错误**: 看到 `xml.Unmarshal` 就判为 XXE
**正确**: Go 标准库 `encoding/xml` 不支持 DTD → 安全

### 陷阱2：第三方库安全假设

**错误**: 看到 XML 解析就认为安全
**正确**: C 绑定库（libxml2/gokogiri）支持 DTD → 需确认配置

### 陷阱3：忽略数据来源

**错误**: 看到 XML 解析就判漏洞
**正确**: 固定配置文件 → 安全

### 陷阱4：先看防护后看漏洞本质

**错误**: 发现代码缺少 DTD 禁用配置 → XXE 风险
**正确**: 先判断漏洞是否存在（encoding/xml 不支持 DTD → 无 XXE），漏洞不存在时防护问题无从谈起

### 陷阱5：被代码对比干扰

**错误**: A 有 DTD 禁用配置，B 没有 → B 有风险
**正确**: 先看 B 的漏洞是否存在，再谈防护缺失

---

## 7. 特殊风险

（Go 无特殊扩展，`encoding/xml` 覆盖主要场景）

---

## 8. 变更影响分析

| 变更类型 | 变更内容 | 风险 |
|----------|----------|------|
| 新增 | 新增 XML 解析代码 | 确认解析器类型，encoding/xml → 安全；libxml2/go-xslt/gokogiri → 需检查 DTD 配置 |
| 新增 | 新增第三方 XML 库（libxml2/go-xslt/gokogiri） | 确认 DTD/外部实体是否禁用 |
| 修改 | 从安全库改为危险解析器 | 引入 DTD 风险 |
| 修改 | 移除 DTD/外部实体禁用配置 | 引入 XXE 风险 |
| 修改 | 改用用户输入 XML | 扩大攻击面 |
| 删除 | 删除 DTD 禁用配置 | 移除防护 |
| 删除 | 删除环境判断 | 可能在线上执行 |

## 9. 质量门禁（强制执行）

在输出审计结论前，按顺序验证：

- [ ] 强制执行顺序已遵守（先检查解析器类型）
- [ ] 解析器安全特性已确认（encoding/xml vs libxml2）
- [ ] DTD/外部实体防护已检查
- [ ] HTTP 入口可达性已确认，非假设
- [ ] 结论与证据一致，代码行号可追溯
- [ ] 已应用误报排除规则（encoding/xml 默认安全、固定配置文件）
- [ ] 不因代码对比而判定风险

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**
