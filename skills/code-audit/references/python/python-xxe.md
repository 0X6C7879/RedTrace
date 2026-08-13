# XXE

## 0. 黄金法则

> **漏洞存在性判断 优先于 防护有效性判断**
>
> 禁用 DTD / 使用 defusedxml = 无 XXE（这是漏洞本质判断，不是防护有效判断）
>
> 满足此条件时：立即终止分析，无需检查任何防护措施。

**强制执行顺序**：
1. **首先**：找到 sink 点 XML 解析代码（如 `etree.parse()`, `xml.sax.parse()`）
2. **然后**：分析 XML 数据来源和解析器配置
3. **仅当** DTD 未禁用且数据源用户可控时，才继续检查防护措施
4. **禁止**：一上来就检查"有没有安全配置"、"A 有 B 没有"

---

## 1. 结论判断标准

| 结论 | 定义 | 判定条件 |
|------|------|----------|
| **漏洞** | 用户输入可通过 HTTP 入口到达 XML 解析器，可触发 XXE 攻击 | 危险解析器 + 用户可控 XML + HTTP 入口可达 + 无有效防护 |
| **风险-A** | 存在危险 XML 解析但无 HTTP 入口可达（内部调用） | 危险操作 + 数据流不可追踪到外部入口 |
| **风险-B** | 危险 XML 解析有 HTTP 入口，但防护措施不充分 | 危险操作 + HTTP 入口可达 + 有部分防护但可绕过 |
| **安全** | 无危险写法，或危险写法有充分有效防护 | defusedxml / 禁用外部实体 / Python 3.8+ xml.etree / 固定 XML / 非线上环境 |

---

## 2. 研判思路

### 2.1 XML 解析器安全特性（第一优先级）

| 解析器 | 包路径 | DTD 支持 | 默认安全 | 判定 |
|--------|--------|----------|----------|------|
| defusedxml | `defusedxml.*` | 已禁用 | 是 | 安全（立即终止） |
| lxml | `lxml.etree` | 支持 | 否 | 需继续研判 |
| xml.sax | `xml.sax` | 支持 | 否 | 需继续研判 |
| xml.etree (Python 3.8+) | `xml.etree.ElementTree` | 支持 | 是 | 安全（立即终止） |
| xml.etree (Python < 3.8) | `xml.etree.ElementTree` | 支持 | 否 | 需继续研判 |
| minidom | `xml.dom.minidom` | 支持 | 否 | 需继续研判 |

### 2.2 研判流程

```
Step 1: 解析器识别
  ├─ defusedxml / Python 3.8+ xml.etree？ → 安全
  ├─ lxml/xml.sax/minidom？ → 继续
  └─ 其他第三方库？ → 需确认

Step 2: 安全配置检查
  ├─ resolve_entities=False / no_network=True / load_dtd=False？ → 安全
  └─ 无安全配置 → 继续

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
| defusedxml | 漏洞 | 安全 |
| resolve_entities=False / no_network=True / load_dtd=False | 漏洞 | 安全 |
| Python 3.8+ xml.etree | 漏洞 | 安全 |
| 固定 XML 文件 | 漏洞 | 安全 |
| 非线上环境 | 漏洞 | 安全 |
| 无 HTTP 入口 | 漏洞 | 风险-A |

### 2.4 总结判定表

| 检查项 | 结论 |
|--------|------|
| defusedxml / Python 3.8+ xml.etree / resolve_entities=False | 安全 |
| lxml 默认配置 + 用户输入 + HTTP 入口 | 漏洞 |
| 仅 Content-Type/简单过滤 | 风险-B |
| 内部方法无 HTTP 入口 | 风险-A |

---

## 3. 常见漏洞/风险场景

### 场景1：lxml XXE

```python
from lxml import etree

tree = etree.parse(uploaded_file)  # 漏洞
```

### 场景2：xml.sax XXE

```python
import xml.sax

xml.sax.parseString(xml_content, MyHandler())  # 漏洞
```

### 场景3：xml.etree (Python < 3.8)

```python
import xml.etree.ElementTree as ET

root = ET.fromstring(xml_content)  # 漏洞（Python < 3.8）
```

### 场景4：minidom XXE

```python
from xml.dom import minidom

doc = minidom.parseString(xml_content)  # 漏洞
```

**风险-A**：内部方法使用 lxml 默认配置解析 XML，但无 HTTP 入口可达。

**风险-B**：仅通过字符串过滤（如检查 `<!DOCTYPE`）拦截 XXE，可被编码/注释等方式绕过。

---

## 4. 常见防御模式

### defusedxml

```python
from defusedxml.ElementTree import parse

tree = parse(user_file)  # 安全：自动禁用危险特性
```

### lxml 禁用外部实体

```python
from lxml import etree

parser = etree.XMLParser(resolve_entities=False, no_network=True, load_dtd=False)
tree = etree.fromstring(xml_content, parser=parser)  # 安全
```

### Python 3.8+ xml.etree

```python
import xml.etree.ElementTree as ET

root = ET.fromstring(xml_content)  # 安全：Python 3.8+ 默认禁用实体
```

### 固定 XML 文件

```python
import xml.etree.ElementTree as ET

tree = ET.parse('/app/config.xml')  # 安全：固定文件
```

---

## 5. 检索技巧

### 关键词

| 类别 | 关键词 |
|------|--------|
| XML 解析 | `etree.parse` `etree.fromstring` `xml.sax.parse` `minidom.parse` `minidom.parseString` `ET.parse` `ET.fromstring` |
| 危险库 | `from lxml` `xml.sax` `xml.dom.minidom` |
| 安全库 | `defusedxml` |
| 安全配置 | `resolve_entities` `no_network` `load_dtd` |

### 检索命令

```bash
# 检测 XML 解析调用
grep -rn "etree\.parse\|etree\.fromstring\|xml\.sax\.parse\|minidom\.parse\|ET\.parse\|ET\.fromstring" --include="*.py"

# 检测 defusedxml 使用
grep -rn "defusedxml" --include="*.py"

# 检测安全配置
grep -rn "resolve_entities\|no_network\|load_dtd" --include="*.py"
```

---

## 6. 常见误判场景

### 陷阱1：固定 XML 文件误判

**错误**：看到 `ET.parse` 就判 XXE
**正确**：使用固定路径 `/etc/app/config.xml`，用户无法控制 → 安全

### 陷阱2：defusedxml 误判

**错误**：看到 `parse` 就判 XXE
**正确**：使用 `defusedxml` 自动禁用危险特性 → 安全

### 陷阱3：Python 3.8+ 默认安全忽略

**错误**：看到 `ET.fromstring` 就判漏洞
**正确**：Python 3.8+ 的 `xml.etree.ElementTree` 默认禁用实体 → 安全

### 陷阱4：先看防护后看漏洞本质

**错误思路**：发现代码缺少安全配置 → 判定 XXE 风险
**正确思路**：先判断漏洞是否存在（数据源是否用户可控），再谈防护缺失

> 漏洞存在性判断 > 防护有效性判断

### 陷阱5：被代码对比干扰

**场景**：A 方法有安全配置，B 方法没有
**错误**：代码不一致 = 风险
**正确**：先看 B 的漏洞是否存在（数据源是否用户可控），再谈防护

> 要回答"没有配置会导致什么漏洞"，而不是"没有配置就是风险"

---

## 7. 特殊风险

### Python 3.8+ 默认安全

Python 3.8+ 的 `xml.etree.ElementTree` 默认禁用外部实体解析，但仍建议使用 `defusedxml` 以获得完整防护。

### Django REST Framework XMLParser

Django REST Framework 的 `XMLParser` 默认不安全，需确保配置安全解析器或使用 `defusedxml`。

### 反幻觉要求

**必须读取的代码**：
1. import 语句：确认使用哪个 XML 解析库
2. 解析器配置：确认 XMLParser 等配置对象的参数
3. 数据来源：追溯 XML 数据的完整来源链
4. Python 版本：ElementTree 在不同版本行为不同

**禁止的推测**：
- 禁止假设 Python 3.8+ ElementTree 完全安全 → 需确认配置
- 禁止假设 lxml 默认禁用 DTD
- 禁止假设 `resolve_entities` 默认为 False
- 禁止假设框架（Django/Flask）有默认 XXE 防护

### 框架注意事项

| 框架 | 注意事项 |
|------|----------|
| Django | REST framework 的 XMLParser 默认不安全，需配置 |
| Flask | 需开发者手动配置 XML 解析，默认无防护 |
| FastAPI | 使用 defusedxml 的请求体解析器相对安全 |

---

## 8. 变更影响分析

| 变更类型 | 变更内容 | 风险 |
|----------|----------|------|
| 新增 | 新增 XML 解析代码 | 确认解析器类型，defusedxml → 安全；lxml/xml.sax/minidom → 需检查 DTD 配置 |
| 新增 | 新增第三方 XML 库（lxml/xml.sax/minidom） | 确认 DTD/外部实体是否禁用 |
| 修改 | 从安全库改为危险解析器 | 引入 DTD 风险 |
| 修改 | 移除 DTD/外部实体禁用配置 | 引入 XXE 风险 |
| 修改 | 改用用户输入 XML | 扩大攻击面 |
| 删除 | 删除 DTD 禁用配置 | 移除防护 |
| 删除 | 删除环境判断 | 可能在线上执行 |

---

## 9. 质量门禁（强制执行）

在输出审计结论前，按顺序验证：

- [ ] 强制执行顺序已遵守（先检查解析器类型）
- [ ] 解析器安全特性已确认（defusedxml / lxml / xml.sax）
- [ ] 安全配置已检查（resolve_entities / no_network / load_dtd）
- [ ] HTTP 入口可达性已确认，非假设
- [ ] 结论与证据一致，代码行号可追溯
- [ ] 已应用误报排除规则（固定 XML 文件、Python 3.8+ 默认安全）
- [ ] 不因代码对比而判定风险

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**
