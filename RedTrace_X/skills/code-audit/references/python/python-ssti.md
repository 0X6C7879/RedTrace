# SSTI 模板注入

## 0. 黄金法则

> **漏洞存在性判断 优先于 防护有效性判断**
>
> 固定模板文件 + 用户仅控制变量值 = 无 SSTI（这是漏洞本质判断，不是防护有效判断）
>
> 满足此条件时：立即终止分析，无需检查任何防护措施。

**强制执行顺序**：
1. **首先**：区分模板内容 vs 模板变量
2. **然后**：确认模板内容是否用户可控
3. **仅当** 模板内容用户可控时，才检查防护
4. **禁止**：一上来就检查"有没有沙箱"

---

## 1. 结论判断标准

| 结论 | 定义 | 判定条件 |
|------|------|----------|
| **漏洞** | 用户输入到达模板渲染，可执行模板语法 | 动态模板内容 + 用户可控 + HTTP 入口 + 无沙箱 |
| **风险-A** | 危险模板操作但无 HTTP 入口可达 | 危险操作 + 无外部入口 |
| **风险-B** | 有入口但防护不充分 | Jinja2 + SandboxedEnvironment |
| **安全** | 固定模板 / 模板变量 / Django 模板 | 固定模板文件 / 用户仅控制变量值 / 白名单 |

---

## 2. 研判思路

### 2.1 研判流程

```
Step 1: 模板操作识别 【终止点】
  ├─ render_template('file.html') 固定模板？ → 安全（终止）
  ├─ render_template_string/Template/动态模板 → 继续
  └─ 未发现模板操作？ → 安全（终止）

Step 2: 用户可控性检查（关键区分） 【终止点】
  ├─ 模板字符串来自常量/固定文件？ → 安全（终止）
  ├─ 仅模板变量来自用户输入？ → 安全（终止）
  └─ 模板内容来自用户输入 → 继续

Step 3: 模板引擎检查
  ├─ Django 模板？ → 安全（限制大，终止）
  ├─ Jinja2 + SandboxedEnvironment？ → 风险-B
  └─ Mako / 无沙箱 Jinja2 → 继续

Step 4: HTTP 入口可达性 【终止点】
  ├─ 无 HTTP 入口？ → 风险-A
  └─ 有 HTTP 入口 → 漏洞
```

### 2.2 降级条件表

| 条件 | 原结论 | 降级后 |
|------|--------|--------|
| 固定模板文件 | 漏洞 | 安全 |
| 仅模板变量用户可控（模板内容固定） | 漏洞 | 安全 |
| Django 模板 | 漏洞 | 安全 |
| Jinja2 SandboxedEnvironment | 漏洞 | 风险-B |
| 白名单变量 | 漏洞 | 安全 |

---

## 3. 常见漏洞/风险场景

### 漏洞

```python
# render_template_string 用户可控
template = request.args.get('template')
return render_template_string(template)  # 漏洞

# Template 用户可控
from jinja2 import Template
t = Template(user_input)
return t.render()  # 漏洞
```

### 风险-B

```python
from jinja2 import Environment, BaseLoader
from jinja2.sandbox import SandboxedEnvironment
env = SandboxedEnvironment()
t = env.from_string(user_input)  # 风险-B：沙箱有限制
```

---

## 4. 常见防御模式

### 固定模板 + 用户变量

```python
# 安全：固定模板，用户仅控制变量值
@app.route('/hello')
def hello():
    name = request.args.get('name', '')
    return render_template('hello.html', name=name)  # 安全
```

### 白名单变量 / 类型约束

```python
if not name.isalnum(): raise ValueError  # 安全
```

---

## 5. 检索技巧

### 搜索关键词

| 类型 | 关键词 |
|------|--------|
| 动态模板 | `render_template_string`, `Template(`, `from_string(` |
| 固定模板 | `render_template('` |
| 沙箱 | `SandboxedEnvironment` |

### 检测命令

```bash
grep -rn "render_template_string\|Template(" --include="*.py"
grep -rn "from_string\|SandboxedEnvironment" --include="*.py"
```

---

## 6. 常见误判场景

### 陷阱1：混淆模板内容和模板变量

**错误**: 看到用户输入传入 render_template 就判为 SSTI
**正确**: 用户输入仅作为变量值，模板内容固定 → 安全

### 陷阱2：Django 模板误判

**错误**: 认为所有模板引擎都相同
**正确**: Django 模板不支持任意 Python 表达式，限制大 → 安全

### 陷阱3：固定模板文件误判

**错误**: 看到 render_template 就认为 SSTI
**正确**: `render_template('file.html')` 模板文件固定 → 安全

---

## 7. 特殊风险

### Mako 模板引擎

Mako 模板支持任意 Python 代码执行（`<% ... %>` 代码块），与 Jinja2 无沙箱同等危险。`Template(user_input)` 在 Mako 中直接执行用户输入的模板代码。

---

## 8. 变更影响分析

| 变更类型 | 变更内容 | 风险 |
|----------|----------|------|
| 新增 | 新增 render_template_string | 确认模板内容来源 |
| 修改 | 从 render_template 改为 render_template_string | 引入风险 |
| 修改 | 移除 SandboxedEnvironment | 引入风险 |

---

## 9. 质量门禁（强制执行）

在输出审计结论前，按顺序验证：

- [ ] 模板内容 vs 模板变量已正确区分
- [ ] 模板内容来源已确认
- [ ] 模板引擎类型已确认
- [ ] HTTP 入口可达性已确认
- [ ] 结论与证据一致，代码行号可追溯

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**
