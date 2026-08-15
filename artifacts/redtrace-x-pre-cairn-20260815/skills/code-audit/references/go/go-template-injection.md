# 模板注入

## 0. 黄金法则

> **漏洞存在性判断 优先于 防护有效性判断**
>
> 固定模板文件 + 用户仅控制变量值 = 无 模板注入（这是漏洞本质判断，不是防护有效判断）
>
> 满足此条件时：立即终止分析，无需检查任何防护措施。

**强制执行顺序**：
1. **首先**：区分模板内容 vs 模板变量
2. **然后**：确认模板内容是否用户可控
3. **仅当** 模板内容用户可控时，才检查防护
4. **禁止**：一上来就检查"有没有白名单"

---

## 1. 结论判断标准

| 结论 | 定义 | 判定条件 |
|------|------|----------|
| **漏洞** | 用户输入到达模板渲染，可执行模板语法 | 动态模板内容 + 用户可控 + HTTP 入口 |
| **风险-A** | 危险模板操作但无 HTTP 入口可达 | 危险操作 + 无外部入口 |
| **风险-B** | 有入口但防护不充分 | html/template + 用户模板（仍有 XSS 风险） |
| **安全** | 固定模板 / 仅变量可控 | 固定模板文件 / Execute 传变量 / 白名单 |

---

## 2. 研判思路

### 2.1 Sink 点识别（第一优先级）

| Sink 点 | 危险级别 |
|---------|----------|
| `template.New("x").Parse(userInput)` | 高 |
| `template.Parse(userInput)` | 高 |
| `template.ParseFiles("dir/" + userInput)` | 高（路径穿越） |
| `template.ParseFiles("fixed.tmpl")` + `tmpl.Execute(data)` | 安全 |

### 2.2 研判流程

```
Step 1: 模板操作识别 【终止点】
  ├─ template.ParseFiles("fixed.tmpl") 固定文件？ → 安全（终止）
  ├─ template.Parse(userInput) 动态内容？ → 继续
  └─ 未发现模板操作？ → 安全（终止）

Step 2: 用户可控性检查（关键区分） 【终止点】
  ├─ 模板字符串来自常量/固定文件？ → 安全（终止）
  ├─ 仅模板变量来自用户输入？ → 安全（终止）
  └─ 模板内容来自用户输入 → 继续

Step 3: 模板类型检查
  ├─ text/template + 用户模板？ → 漏洞
  ├─ html/template + 用户模板？ → 风险-B（仍有 XSS 风险）
  └─ text/template + call 函数？ → 漏洞（可调用函数）

Step 4: HTTP 入口可达性 【终止点】
  ├─ 无 HTTP 入口？ → 风险-A
  └─ 有 HTTP 入口 → 漏洞
```

### 2.3 降级条件表

| 条件 | 原结论 | 降级后 |
|------|--------|--------|
| 固定模板文件 | 漏洞 | 安全 |
| 仅模板变量用户可控 | 漏洞 | 安全 |
| html/template 自动转义 | 漏洞 | 风险-B |
| 白名单变量 | 漏洞 | 安全 |

---

## 3. 常见漏洞/风险场景

### 漏洞

```go
// text/template 用户模板
templateContent := r.URL.Query().Get("template")
tmpl, _ := template.New("user").Parse(templateContent)  // 漏洞

// 路径穿越
reportName := r.URL.Query().Get("report")
template.ParseFiles("templates/" + reportName + ".tmpl")  // 漏洞

// text/template + call 函数
tmpl = tmpl.Funcs(template.FuncMap{"exec": os.Exec})
tmpl.Parse(userInput)  // 漏洞：可调用函数
```

---

## 4. 常见防御模式

### 固定模板 + 变量传递

```go
tmpl := template.Must(template.ParseFiles("templates/report.tmpl"))
tmpl.Execute(w, data)  // 安全：固定模板，用户仅控制变量值
```

### 白名单变量

```go
data := map[string]interface{}{
    "name": name,
    "email": email,
}  // 安全：白名单变量
```

---

## 5. 检索技巧

### 搜索关键词

| 类型 | 关键词 |
|------|--------|
| 动态模板 | `template.Parse(`, `template.New(`, `.Parse(` |
| 固定模板 | `template.ParseFiles("` |
| 函数注册 | `Funcs(`, `FuncMap{` |

### 检测命令

```bash
grep -rn "template\.Parse\|template\.New.*Parse" --include="*.go"
grep -rn "Funcs(\|FuncMap{" --include="*.go"
```

---

## 6. 常见误判场景

### 陷阱1：混淆模板内容和变量值

**错误**: 看到 Execute(w, data) 就判为模板注入
**正确**: data 是变量值，模板内容固定 → 安全

### 陷阱2：html/template 自动转义

**错误**: 认为所有模板注入都是 RCE
**正确**: html/template 自动转义 HTML，但仍有信息泄露风险 → 风险-B

### 陷阱3：固定 ParseFiles 误判

**错误**: 看到 ParseFiles 就判为漏洞
**正确**: `ParseFiles("fixed.tmpl")` 模板文件固定 → 安全

---

## 7. 特殊风险

### text/template vs html/template

`html/template` 自动转义 HTML 上下文（`{{ .Var }}` → 安全），但 `text/template` 不转义任何内容。若代码使用 `text/template` 输出 HTML，需手动转义。

### FuncMap 注册危险函数

`template.FuncMap{"exec": os.Exec}` 将危险函数注册到模板中，即使模板内容部分可控，攻击者也可通过调用 `{{ exec "cmd" }}` 执行系统命令。注册函数时应避免暴露危险操作。

---

## 8. 变更影响分析

| 变更类型 | 变更内容 | 风险 |
|----------|----------|------|
| 新增 | 新增 template.Parse(userInput) | 确认模板内容来源 |
| 新增 | 新增 FuncMap 注册危险函数 | 引入 RCE 风险 |
| 修改 | 从 ParseFiles 改为 Parse(userInput) | 引入风险 |

---

## 9. 质量门禁（强制执行）

在输出审计结论前，按顺序验证：

- [ ] 模板内容 vs 变量值已正确区分
- [ ] 模板内容来源已确认
- [ ] text/template vs html/template 已区分
- [ ] HTTP 入口可达性已确认
- [ ] 结论与证据一致，代码行号可追溯

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**
