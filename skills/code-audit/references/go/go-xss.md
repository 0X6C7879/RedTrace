# XSS

## 0. 黄金法则

> **漏洞存在性判断 优先于 防护有效性判断**
>
> 不输出到 HTML = 无 XSS（这是漏洞本质判断，不是防护有效判断）
>
> 满足此条件时：立即终止分析，无需检查任何防护措施。

> **注意**：Go 为后端语言，本文档仅覆盖服务端 XSS。前端 DOM XSS 不在范围内。XSS 分为存储型和反射型，研判流程相同。

**强制执行顺序**：
1. **首先**：找到 sink 点输出代码（如 `fmt.Fprintf()`, `template.Execute()`）
2. **然后**：分析使用的模板引擎类型（html/template vs text/template）
3. **仅当** 使用 text/template 或直接字符串拼接时，才继续检查防护
4. **禁止**：一上来就检查"有没有 EscapeString"

---

## 1. 结论判断标准

| 结论 | 定义 | 判定条件 |
|------|------|----------|
| **漏洞** | 用户输入未经转义直接输出到 HTML 响应 | 危险输出 + 用户可控 + HTTP 入口 + 无防护 |
| **风险-A** | 危险输出但无 HTTP 入口可达 | 危险输出 + 无外部入口 |
| **风险-B** | 有防护但强度不足（黑名单过滤） | 危险输出 + HTTP 入口 + 弱防护 |
| **安全** | 有效防护或参数不可控 | html/template / 编码 / 白名单 |

---

## 2. 漏洞风险的研判思路

### 2.1 Sink 点与模板引擎对比（第一优先级）

| 模板引擎 | 转义行为 | 判定 |
|----------|----------|------|
| `html/template` | 默认转义 HTML/JS/CSS/URL | 安全 |
| `text/template` | 不转义 | 漏洞 |
| 第三方模板 | 需确认 | 需评估 |

| Sink 点 | 危险级别 |
|---------|----------|
| `fmt.Fprintf(w, "<div>%s</div>", input)` | 高 |
| `text/template.Execute()` | 高 |
| `template.HTML(input)` | 高（显式禁用转义） |
| `template.JS(input)` / `template.CSS(input)` | 高（显式禁用转义） |
| `fmt.Fprintf(w, "<script>%s</script>", input)` | 极高（JS 上下文） |

> **Go 核心差异**：`html/template` 自动转义 → 安全；`text/template` 不转义 → 危险。

### 2.2 研判流程

```
Step 1: 输出上下文与模板引擎检查 【终止点】
  ├─ html/template + 无 template.HTML/JS/CSS？ → 安全（终止）
  ├─ 非输出场景（JSON API / Content-Disposition: attachment）？ → 安全（终止）
  └─ text/template / fmt.Fprintf 拼接 → 继续

Step 2: 参数可控性检查 【终止点】
  ├─ 硬编码/常量/白名单映射？ → 安全（终止）
  └─ 用户可控 → 继续

Step 3: 防护措施检查
  ├─ html.EscapeString()？ → 安全（终止）
  ├─ bluemonday.Sanitize()？ → 安全（终止）
  ├─ 白名单校验？ → 安全（终止）
  ├─ 黑名单过滤？ → 风险-B
  └─ 无防护 → 继续

Step 4: HTTP 入口可达性 【终止点】
  ├─ 无 HTTP 入口？ → 风险-A
  └─ 有 HTTP 入口 → 漏洞
```

### 2.3 降级条件表

| 条件 | 原结论 | 降级后 |
|------|--------|--------|
| html/template 自动转义 | 漏洞 | 安全 |
| html.EscapeString() / bluemonday | 漏洞 | 安全 |
| 白名单校验 | 漏洞 | 安全 |
| 黑名单过滤 | 漏洞 | 风险-B |
| 无 HTTP 入口 | 漏洞 | 风险-A |

### 2.4 总结判定表

| 检查项 | 结论 |
|--------|------|
| html/template | 安全 |
| text/template + 无防护 + HTTP 入口 | 漏洞 |
| fmt.Fprintf 拼接 + 无防护 + HTTP 入口 | 漏洞 |
| 黑名单过滤 | 风险-B |
| 无 HTTP 入口 | 风险-A |

---

## 3. 常见漏洞/风险场景

### 漏洞

```go
// text/template 不转义
import "text/template"
t := template.Must(template.New("page").Parse("<div>{{.}}</div>"))
t.Execute(w, input)  // 漏洞

// fmt.Fprintf 字符串拼接
fmt.Fprintf(w, "<div>Search: %s</div>", input)  // 漏洞

// template.HTML 绕过转义
t.Execute(w, gin.H{"Name": template.HTML(c.Query("name"))})  // 漏洞

// JavaScript 上下文注入（极高危）
fmt.Fprintf(w, "<script>%s({data: 'value'})</script>", callback)  // 漏洞（极高危）

// javascript: 协议注入
fmt.Fprintf(w, "<a href='%s'>link</a>", userInput)  // 漏洞：可注入 javascript:
```

### 风险-A / 风险-B

```go
// 风险-A：无 HTTP 入口
func renderInternal(w io.Writer, content string) {
    fmt.Fprintf(w, "<div>%s</div>", content)  // 需追踪调用方
}

// 风险-B：黑名单可绕过
safe := strings.ReplaceAll(input, "<script>", "")
fmt.Fprintf(w, "<div>%s</div>", safe)
```

---

## 4. 常见防御模式

```go
// html/template 自动转义
import "html/template"
t := template.Must(template.New("page").Parse("<div>{{.}}</div>"))
t.Execute(w, input)  // 安全：自动转义

// HTML 转义
safe := html.EscapeString(userInput)  // 安全
fmt.Fprintf(w, "<div>%s</div>", safe)

// bluemonday 清理
safe := bluemonday.UGCPolicy().Sanitize(userInput)  // 安全

// 白名单校验
if !regexp.MustCompile(`^[a-zA-Z0-9_-]+$`).MatchString(input) {
    return errors.New("Invalid")
}  // 安全
```

---

## 5. 检索技巧

### 搜索关键词

| 类型 | 关键词 |
|------|--------|
| 模板引擎 | `html/template`, `text/template`, `template.New`, `template.Parse` |
| 输出函数 | `fmt.Fprintf`, `fmt.Sprintf` |
| 转义函数 | `html.EscapeString`, `bluemonday` |
| 转义绕过 | `template.HTML`, `template.JS`, `template.CSS` |

### 检测命令

```bash
# 检测模板引擎类型
grep -rn "html/template\|text/template" --include="*.go"

# 检测字符串拼接输出
grep -rn "fmt\.Fprintf.*<\|fmt\.Sprintf.*<" --include="*.go"

# 检测转义函数
grep -rn "html\.EscapeString\|bluemonday" --include="*.go"
```

---

## 6. 常见误判场景

### 陷阱1：模板引擎混淆

**错误**: 看到模板就认为安全
**正确**: `html/template` 自动转义 → 安全；`text/template` 不转义 → 漏洞，需确认引擎类型

### 陷阱2：template.HTML 误判

**错误**: 看到使用模板就认为安全
**正确**: `template.HTML(input)` 显式禁用转义 → 漏洞

### 陷阱3：忽略输出上下文 / JavaScript 上下文漏报

**错误**: 只检查 HTML 内容上下文
**正确**: JavaScript 上下文 `<script>var x = '%s'</script>` 即使 HTML 转义也可能被 `'` 绕过，需使用 JS 编码

### 陷阱4：URL 上下文 javascript: 漏报

**错误**: 忽略 `javascript:` 协议
**正确**: href 属性无过滤 → 漏洞

### 陷阱5：先看防护后看漏洞本质

**错误思路**：发现代码缺少 EscapeString → 判定风险
**正确思路**：先判断漏洞是否存在（html/template → 无 XSS）

### 陷阱6：被代码对比干扰

**错误判定**：A 有 EscapeString B 没有 → B 有风险
**正确判定**：先看 B 是否输出到 HTML，再谈防护

---

## 7. 特殊风险

### 7.1 存储型 XSS 链路特征

存储型 XSS 与反射型的核心区别：用户输入先**写入**持久化存储（DB/文件/缓存），后续请求**读取**并**渲染**到 HTML 页面。审计时需追踪完整链路：写入接口 → 存储位置 → 读取接口 → HTML 输出。

### 7.2 输出上下文分类与编码匹配

| 上下文 | 危险级别 | 示例 | 所需编码 |
|--------|----------|------|----------|
| HTML 内容 | 高 | `<div>{userInput}</div>` | HTML 编码 |
| HTML 属性 | 高 | `<input value='{userInput}'>` | HTML 属性编码 |
| JavaScript | 极高 | `<script>var x = '{userInput}'</script>` | JS 编码 |
| CSS | 高 | `<div style='{userInput}'>` | CSS 编码 |
| URL | 中 | `<a href='{userInput}'>link</a>` | URL 编码 |

> JavaScript 上下文最危险，HTML 编码在 JS 上下文中无效，需使用 JS 编码。

### 7.3 CSS/SVG 注入

CSS 注入（`<div style='用户输入'>`）可导致 UI 伪造和数据窃取。SVG 文件中的 `<script>` 标签可执行 JS。上传 SVG 文件后若直接嵌入页面，构成 XSS。

---

## 8. 变更影响分析

| 变更类型 | 变更内容 | 风险 |
|----------|----------|------|
| 新增 | 新增 fmt.Fprintf HTML 拼接 | 确认输出上下文和编码 |
| 新增 | 新增 text/template 使用 | 不转义 |
| 修改 | 从 html/template 改为 text/template | 移除自动转义 |
| 修改 | 移除 html.EscapeString | 移除防护 |
| 修改 | 添加 template.HTML() 绕过 | 禁用转义 |
| 删除 | 删除转义函数/白名单校验 | 移除防护 |

---

## 9. 质量门禁（强制执行）

在输出审计结论前，按顺序验证：

- [ ] 强制执行顺序已遵守（先确认模板引擎类型）
- [ ] html/template vs text/template 已正确区分
- [ ] template.HTML/JS/CSS 绕过已检查
- [ ] HTTP 入口可达性已确认，非假设
- [ ] 结论与证据一致，代码行号可追溯
- [ ] 不因代码对比而判定风险

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**
