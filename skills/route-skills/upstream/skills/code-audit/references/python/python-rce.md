# RCE

## 0. 黄金法则

> **漏洞存在性判断 优先于 防护有效性判断**
>
> 不拼接命令 = 无 RCE（这是漏洞本质判断，不是防护有效判断）
>
> 满足此条件时：立即终止分析，无需检查任何防护措施。

**强制执行顺序**：
1. **首先**：找到 sink 点危险执行代码（如 `os.system()`, `subprocess.run()`, `eval()`）
2. **然后**：分析用户输入是否拼接进命令/表达式
3. **仅当** 命令/表达式拼接时，才继续检查防护措施
4. **禁止**：一上来就检查"有没有沙箱"、"A 有 B 没有"

---

## 1. 结论判断标准

| 结论 | 定义 | 判定条件 |
|------|------|----------|
| **漏洞** | 用户能控制执行关键要素（命令本身/表达式文本/反序列化数据），无有效防护 | 危险执行函数 + 用户可控数据 + HTTP 入口可达 + 无有效防护 |
| **风险-A** | 存在危险命令/表达式执行，但无 HTTP 入口可达 | 危险执行函数 + 内部调用，无 HTTP 入口 |
| **风险-B** | 命令/表达式执行有 HTTP 入口可达，但防护措施不充分 | 危险执行函数 + 用户输入 + 仅黑名单/部分替换 |
| **安全** | 使用安全 API/模式、类型约束、值不可控 | subprocess 参数化/yaml.safe_load/int 类型约束 |

---

## 2. 研判思路

### 2.1 命令执行场景分类

| 场景 | 危险模式 | 安全模式 |
|------|----------|----------|
| 命令执行 | `os.system("cmd " + input)` | `subprocess.run(["cmd", input])` |
| 表达式执行 | `eval(user_input)` | 表达式硬编码，仅变量值来自用户 |
| 反序列化 | `pickle.loads(user_data)` | `yaml.safe_load(user_data)` |
| 模板注入 | `Template(user_input)` | 模板路径固定，仅变量值可控 |

### 2.2 研判流程

```
Step 1: 输入类型检查
  ├─ int/float/bool？ → 安全（终止）
  └─ str → 继续

Step 2: 命令执行检查
  ├─ subprocess.run([...]) 列表形式，无 shell=True？ → 安全（终止）
  ├─ os.system/subprocess shell=True/命令本身可控？ → 继续
  └─ 不涉及命令执行 → 进入 Step 3

Step 3: 表达式注入检查
  ├─ 表达式硬编码，仅变量值可控？ → 安全（终止）
  ├─ eval/exec 用户可控内容？ → 继续
  └─ 不涉及表达式 → 进入 Step 4

Step 4: 反序列化检查
  ├─ yaml.safe_load/SafeLoader？ → 安全（终止）
  ├─ pickle.loads/yaml.load 无 SafeLoader？ → 继续
  └─ 不涉及反序列化 → 进入 Step 5

Step 5: 防护检查
  ├─ 白名单校验？ → 安全（终止）
  ├─ 黑名单过滤？ → 风险-B
  └─ 无防护 → 继续

Step 6: HTTP 入口可达性
  ├─ 无 HTTP/gRPC 入口？ → 风险-A
  └─ 有入口 → 漏洞
```

### 2.3 降级条件表

| 条件 | 原结论 | 降级后 |
|------|--------|--------|
| int/float/bool 类型约束 | 漏洞 | 安全 |
| subprocess 列表形式参数化 | 漏洞 | 安全 |
| 表达式硬编码（仅值可控） | 漏洞 | 安全 |
| yaml.safe_load/SafeLoader | 漏洞 | 安全 |
| 白名单校验 | 漏洞 | 安全 |
| 黑名单过滤 | 漏洞 | 风险-B |

### 2.4 总结判定表

| 检查项 | 结论 |
|--------|------|
| int/float/bool 类型约束 | 安全 |
| subprocess.run([...]) 列表形式 | 安全 |
| 表达式硬编码（仅变量值可控） | 安全 |
| yaml.safe_load/SafeLoader | 安全 |
| 白名单校验 | 安全 |
| 命令/表达式用户可控 + 无防护 + HTTP 入口 | 漏洞 |
| 黑名单过滤 + HTTP 入口 | 风险-B |
| 内部方法无 HTTP 入口 | 风险-A |

---

## 3. 常见漏洞/风险场景

### 漏洞

```python
# 命令注入
os.system("ping -c 1 " + ip)  # 漏洞
subprocess.run(cmd, shell=True)  # 漏洞
subprocess.getoutput(f"ping {host}")  # 漏洞

# 表达式注入
eval(request.GET.get('expr'))  # 漏洞
exec(request.GET.get('code'))  # 漏洞

# 反序列化
pickle.loads(data)  # 漏洞
yaml.load(data)  # 漏洞：无 SafeLoader

# LLM 工具调用
cmd = f"{tool_name} {arguments['input']}"  # arguments 来自用户对话
subprocess.run(cmd, shell=True)  # 漏洞
```

### 风险-A

```python
def internal_cleanup():
    subprocess.run(["rm", "-rf", "/tmp/cache"])  # 风险-A：需追踪调用方
```

### 风险-B

```python
dangerous = ["eval", "exec", "import", "os"]
for keyword in dangerous:
    if keyword in cmd.lower():
        raise SecurityException("Dangerous")
os.system(cmd)  # 风险-B：黑名单可绕过
```

---

## 4. 常见防御模式

### subprocess 参数化

```python
subprocess.run(["ping", "-c", "1", ip])  # 安全：列表形式
subprocess.call(["ls", "-la", directory])  # 安全
```

### 类型约束

```python
count = int(user_input)  # 安全：int 类型
os.system(f"echo {count}")
```

### 表达式硬编码

```python
result = eval(f"{x} + {y}")  # 安全：表达式固定，仅变量值可控
```

### yaml.safe_load

```python
yaml.load(user_input, Loader=yaml.SafeLoader)  # 安全
```

---

## 5. 检索技巧

> HTTP 入口可达性检索：详见 [Python 通用检索技巧](python-common-retrieval.md#http-入口可达性检索)

### 搜索关键词

| 类型 | 关键词 |
|------|--------|
| 命令执行 | `os.system`, `subprocess.`, `os.popen` |
| 表达式执行 | `eval(`, `exec(`, `timeit.timeit` |
| 反序列化 | `pickle.load`, `yaml.load` |
| 模板引擎 | `Template(`, `render_template_string` |

### 检测命令

```bash
# 命令执行
grep -rn "os\.system\|subprocess\.\|os\.popen" --include="*.py"
# 表达式执行
grep -rn "eval\s*[(]\|exec\s*[(]\|timeit\.timeit" --include="*.py"
# 反序列化
grep -rn "pickle\.load\|yaml\.load" --include="*.py"
```

---

## 6. 常见误判场景

### 陷阱1：subprocess.run 误判

**错误**: 看到 `subprocess.run` 就认为危险
**正确**: `subprocess.run(["cmd", arg])` 列表形式，命令固定，参数独立 → 安全

### 陷阱2：numpy.load/librosa.load 误判

**错误**: 看到 load 就认为反序列化
**正确**: `numpy.load()` 默认不启用 pickle（需 `allow_pickle=True`）；`librosa.load()`/`torchaudio.load()` 是音频库 → 安全

### 陷阱3：eval 输入不可控

**错误**: 看到 eval 就认为漏洞
**正确**: `eval(f"{x} + {y}")` 表达式硬编码，仅变量值可控 → 安全；`eval(content)` content 来自 DB → 风险-A

### 陷阱4：先看防护后看漏洞本质

**错误思路**：发现缺少沙箱 → A 有 B 没有 → 判定风险
**正确思路**：先判断漏洞是否存在（命令固定 → 无 RCE）→ 漏洞不存在时防护问题无从谈起

### 陷阱5：被代码对比干扰

**错误判定**：A 有沙箱 B 没有 → B 有风险
**正确判定**：先看 B 漏洞是否存在（是否拼接命令），再谈防护

---

## 7. 特殊风险

### 路径可控 ≠ 内容可控（AI/ML 场景）

`torch.load(user_path)` / `pickle.load(open(user_path))` — 若路径来自用户但文件内容由服务端预置，则无法利用。需文件上传功能配合才能构成有效漏洞。

```python
model_path = request.json.get("model_path")
model = torch.jit.load(model_path)  # 安全：用户只能控制路径，不能控制文件内容
```

### AI/ML 库误判速查

| 库 | 方法 | 说明 |
|-----|------|------|
| PyTorch | `torch.load()` / `torch.jit.load()` | 路径可控但内容不可控时 → 安全 |
| numpy | `numpy.load()` | 默认不启用 pickle，需 `allow_pickle=True` |
| torchaudio | `torchaudio.load()` | 音频库，不涉及反序列化 → 安全 |
| PIL/Pillow | `Image.open()` | 图片库，非图片资源会抛异常 → 安全 |
| librosa | `librosa.load()` | 音频库，不涉及反序列化 → 安全 |

---

## 8. 变更影响分析

| 变更类型 | 变更内容 | 风险 |
|----------|----------|------|
| 新增 | 新增 os.system/subprocess shell=True 调用 | 引入命令注入 |
| 新增 | 新增 eval/exec/pickle.loads 调用 | 引入代码执行/反序列化风险 |
| 修改 | subprocess 列表形式改为字符串拼接 | 引入命令注入 |
| 修改 | yaml.safe_load 改为 yaml.load | 引入反序列化风险 |
| 删除 | 删除类型检查/白名单校验 | 移除防护 |

## 9. 质量门禁（强制执行）

在输出审计结论前，按顺序验证：

- [ ] 强制执行顺序已遵守（先检查命令拼接分析）
- [ ] subprocess 调用形式已确认（列表 vs 字符串、shell=True）
- [ ] 漏洞本质判断先于防护判断（命令固定直接终止）
- [ ] HTTP 入口可达性已确认，非假设
- [ ] 结论与证据一致，代码行号可追溯
- [ ] 已应用误报排除规则（numpy.load、librosa.load 等安全库）

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**
