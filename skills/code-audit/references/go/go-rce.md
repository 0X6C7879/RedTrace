# RCE

## 0. 黄金法则

> **漏洞存在性判断 优先于 防护有效性判断**
>
> 不拼接命令 = 无 RCE（这是漏洞本质判断，不是防护有效判断）
>
> 满足此条件时：立即终止分析，无需检查任何防护措施。

**强制执行顺序**：
1. **首先**：找到 sink 点危险执行代码（如 `exec.Command()`, `template.Execute()`）
2. **然后**：分析用户输入是否拼接进命令/表达式
3. **仅当** 命令/表达式拼接时，才继续检查防护措施
4. **禁止**：一上来就检查"有没有沙箱"、"A 有 B 没有"

---

## 1. 结论判断标准

| 结论 | 定义 | 判定条件 |
|------|------|----------|
| **漏洞** | 用户输入可通过 HTTP/gRPC 入口到达命令执行点，命令本身或表达式内容可控 | 危险执行函数 + 用户可控数据 + HTTP 入口可达 + 无有效防护 |
| **风险-A** | 存在命令执行调用但无 HTTP/gRPC 入口可达 | 危险执行函数 + 内部调用，无 HTTP/gRPC 入口 |
| **风险-B** | 命令执行调用有 HTTP 入口可达，但防护措施不充分 | 危险执行函数 + 用户输入 + 仅黑名单/部分替换 |
| **安全** | 无危险写法，或有充分的有效防护 | exec.Command 不起 shell/命令固定/白名单/类型约束 |

---

## 2. 研判思路

### 2.1 exec.Command 调用方式检查（第一优先级）

Go 的 `exec.Command` **不经过 shell**，这是 Go 与其他语言的**核心差异**。

| 调用方式 | 示例 | 判定 |
|----------|------|------|
| 命令固定，参数独立 | `exec.Command("python", "script.py", userInput)` | 安全 |
| 显式调用 shell | `exec.Command("sh", "-c", userInput)` | 漏洞 |
| 命令本身可控 | `exec.Command(userInput, args...)` | 漏洞 |

| 类型 | 函数 | 危险条件 |
|------|------|----------|
| 命令执行 | `exec.Command`, `exec.CommandContext`, `os.StartProcess`, `syscall.Exec` | 命令用户可控或 shell 模式 |
| 模板注入 | `text/template.New().Parse()` | 模板内容用户可控 |
| 转义绕过 | `template.HTML()`, `template.JS()` | 显式禁用转义 |
| 反序列化 | `json.Unmarshal(data, &interface{})` | 目标类型为 interface{} |

### 2.2 研判流程

```
Step 1: 输入类型检查
  ├─ int/uint/float/bool？ → 安全（终止）
  └─ string → 继续

Step 2: 命令/模板拼接检查
  ├─ exec.Command 命令固定，参数独立？ → 安全（终止）
  ├─ html/template 自动转义？ → 安全（终止）
  ├─ 反序列化到具体 struct？ → 安全（终止）
  └─ shell 模式/命令可控/模板内容可控 → 继续

Step 3: 防护检查
  ├─ 白名单校验？ → 安全（终止）
  ├─ 黑名单过滤？ → 风险-B
  └─ 无防护 → 继续

Step 4: HTTP 入口可达性
  ├─ 无 HTTP/gRPC 入口？ → 风险-A
  └─ 有入口 → 漏洞
```

### 2.3 降级条件表

| 条件 | 原结论 | 降级后 |
|------|--------|--------|
| int/uint/float/bool 类型约束 | 漏洞 | 安全 |
| exec.Command 不起 shell（命令固定） | 漏洞 | 安全 |
| html/template 自动转义 | 漏洞 | 安全 |
| 反序列化到具体 struct | 漏洞 | 安全 |
| 白名单校验 | 漏洞 | 安全 |
| 黑名单过滤 | 漏洞 | 风险-B |

### 2.4 总结判定表

| 检查项 | 结论 |
|--------|------|
| exec.Command 命令固定，参数独立 | 安全 |
| html/template 自动转义 | 安全 |
| 反序列化到具体 struct | 安全 |
| 白名单校验 | 安全 |
| shell 模式/命令可控 + 无防护 + HTTP 入口 | 漏洞 |
| 黑名单过滤 + HTTP 入口 | 风险-B |
| 内部方法无 HTTP/gRPC 入口 | 风险-A |

---

## 3. 常见漏洞/风险场景

### 漏洞

```go
// shell 模式
exec.Command("sh", "-c", c.Query("cmd"))           // 漏洞
exec.Command(c.Query("prog"), args...)             // 漏洞：命令可控
exec.Command(parts[0], parts[1:]...)                // 漏洞：用户分割后命令可控

// text/template 模板注入
t, _ := template.New("user").Parse(c.Query("tpl"))
t.Execute(w, nil)  // 漏洞

// template.HTML 绕过转义
t.Execute(w, gin.H{"Name": template.HTML(c.Query("name"))})  // 漏洞
```

### 风险-A

```go
func executeInternal(cmd string) {
    exec.Command("sh", "-c", cmd).Output()  // 风险-A：需追踪调用方
}
```

### 风险-B

```go
cmd := strings.ReplaceAll(cmd, "rm", "")
cmd = strings.ReplaceAll(cmd, ";", "")
exec.Command("sh", "-c", cmd).Output()  // 风险-B：黑名单可绕过
```

---

## 4. 常见防御模式

### exec.Command 不起 shell（Go 核心特性）

```go
exec.Command("python", "/scripts/token_counter.py", modelName, prompt)  // 安全
exec.Command("ping", "-c", "1", userInput)  // 安全
```

### html/template 自动转义

```go
tmpl := template.Must(template.ParseFiles("templates/user.html"))
tmpl.Execute(c.Writer, gin.H{"name": name})  // 安全
```

### 白名单校验

```go
allowedCmds := map[string]bool{"ping": true, "traceroute": true}
if !allowedCmds[cmd] { return errors.New("invalid") }
exec.Command(cmd, args...)  // 安全
```

### 反序列化到具体类型

```go
var user User
json.Unmarshal(data, &user)  // 安全：目标类型固定
```

---

## 5. 检索技巧

> HTTP 入口可达性检索：详见 [Go 通用检索技巧](go-common-retrieval.md#http-入口可达性检索)

### 搜索关键词

| 类型 | 关键词 |
|------|--------|
| 命令执行 | `exec.Command`, `exec.CommandContext`, `os.StartProcess` |
| 模板引擎 | `template.New`, `template.Parse`, `text/template`, `html/template` |
| 转义绕过 | `template.HTML`, `template.JS`, `template.CSS` |
| 反序列化 | `json.Unmarshal`, `xml.Unmarshal`, `gob.NewDecoder` |

### 检测命令

```bash
grep -rn "exec.Command\|os.StartProcess" --include="*.go"
grep -rn "template.New\|template.Parse\|text/template" --include="*.go"
grep -rn "json.Unmarshal\|xml.Unmarshal\|gob.NewDecoder" --include="*.go"
grep -rn "template.HTML\|template.JS" --include="*.go"
```

---

## 6. 常见误判场景

### 陷阱1：exec.Command 误判为命令注入

**错误**: 看到 `exec.Command` + 用户输入就认为危险
**正确**: Go 的 `exec.Command` 不经过 shell，命令固定，用户输入仅作为参数 → 安全

### 陷阱2：html/template 误判为 SSTI

**错误**: 看到模板 + 用户输入就认为 SSTI
**正确**: 模板来自固定文件，用户输入仅作为变量值，`html/template` 自动转义 → 安全
**对比**: 如果 `tmpl := c.Query("tpl")`，则是漏洞

### 陷阱3：反序列化误判

**错误**: 看到 `json.Unmarshal` 就认为反序列化漏洞
**正确**: 目标类型是具体 struct，Go 的 `encoding/json` 不支持任意对象实例化 → 安全

### 陷阱4：先看防护后看漏洞本质

**错误思路**：发现缺少白名单 → A 有 B 没有 → 判定风险
**正确思路**：先判断漏洞是否存在（命令固定 → 无 RCE）→ 漏洞不存在时防护问题无从谈起

### 陷阱5：被代码对比干扰

**错误判定**：A 有沙箱 B 没有 → B 有风险
**正确判定**：先看 B 漏洞是否存在（是否拼接命令），再谈防护

---

## 7. 特殊风险

### syscall.Exec 低级调用

`syscall.Exec` 直接替换当前进程，与 `exec.Command` 行为不同。若第一个参数用户可控 → 漏洞。搜索时需同时检索 `exec.Command` 和 `syscall.Exec`。

### os.StartProcess 误判

`os.StartProcess(bin, args, procAttr)` — 若 `bin` 固定，通常安全；若 `bin` 固定为 `/bin/sh` 且 `args` 用户可控 → 相当于 `exec.Command("/bin/sh", cmd)` → 漏洞。

### 命令分隔符误判

`exec.Command` 不经过 shell，`exec.Command("ping", userInput)` 中 `userInput` 含 `; cat /etc/passwd` **不会**执行第二条命令。但如果用户输入被分割后 `parts[0]` 作为命令名 → 漏洞。

---

## 8. 变更影响分析

| 变更类型 | 变更内容 | 风险 |
|----------|----------|------|
| 新增 | 新增 exec.Command shell 模式 | 引入命令注入 |
| 新增 | 新增 text/template + 用户可控内容 | 引入模板注入 |
| 修改 | 从 html/template 改为 text/template | 移除自动转义 |
| 修改 | 移除白名单检查 | 扩大攻击面 |
| 删除 | 删除白名单校验/环境判断 | 移除防护 |

## 9. 质量门禁（强制执行）

在输出审计结论前，按顺序验证：

- [ ] 强制执行顺序已遵守（先检查命令拼接分析）
- [ ] exec.Command 调用方式已正确识别（shell 模式 vs 参数独立）
- [ ] 模板类型已确认（html/template vs text/template）
- [ ] HTTP 入口可达性已确认，非假设
- [ ] 结论与证据一致，代码行号可追溯
- [ ] 已应用误报排除规则

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**
