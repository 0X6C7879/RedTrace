# 反序列化

## 0. 黄金法则

> **漏洞存在性判断 优先于 防护有效性判断**
>
> 使用安全 API（json.loads/yaml.safe_load）= 无反序列化漏洞（这是漏洞本质判断，不是防护有效判断）
>
> 满足此条件时：立即终止分析，无需检查任何防护措施。

**强制执行顺序**：
1. **首先**：找到 sink 点反序列化代码（如 `pickle.loads()`, `yaml.load()`）
2. **然后**：识别 API 类型（安全 API vs 危险 API）
3. **仅当** 使用危险 API 时，才继续检查数据来源和防护措施
4. **禁止**：一上来就检查"有没有签名验证"

---

## 1. 结论判断标准

| 结论 | 定义 | 判定条件 |
|------|------|----------|
| **漏洞** | 反序列化数据来自 HTTP 入口用户输入，使用危险 API，无有效防护 | 1. 存在危险反序列化 API; 2. 数据来自 HTTP 入口用户输入; 3. 无签名验证/类型限制 |
| **风险-A** | 存在危险 API 但无 HTTP 入口可达 | 1. 存在危险 API; 2. 数据流不可追踪到外部入口 |
| **风险-B** | 有 HTTP 入口可达，但防护不充分 | 1. 存在危险 API; 2. HTTP 入口可达; 3. 有弱防护 |
| **安全** | 使用安全 API、数据来自可信源、有充分防护 | 1. json.loads/yaml.safe_load; 2. 数据来自固定配置; 3. 有签名验证 |

---

## 2. 漏洞风险的研判思路

### 2.1 反序列化 API 识别（第一优先级）

| API | 风险等级 | 说明 |
|-----|----------|------|
| `json.loads()` / `json.load()` | 安全 | 仅支持基础类型 |
| `yaml.safe_load()` | 安全 | 仅支持基础类型 |
| `yaml.load(..., Loader=SafeLoader)` | 安全 | 仅支持基础类型 |
| `pickle.loads()` / `pickle.load()` | 高危 | 可 RCE，通过 __reduce__ |
| `yaml.load()` 无 Loader 参数 | 高危 | 默认 UnsafeLoader |
| `jsonpickle.decode()` | 中危 | 支持对象还原 |
| `dill.loads()` | 高危 | 扩展 pickle |
| `shelve.open()` | 中危 | 底层使用 pickle |
| `numpy.load()` 无 allow_pickle | 安全 | 默认不启用 pickle |

### 2.2 研判流程

```
Step 1: API 识别
  ├─ json.loads/yaml.safe_load/SafeLoader？ → 安全
  └─ pickle.loads/yaml.load(无SafeLoader)/jsonpickle.decode → 继续

Step 2: 数据来源检查
  ├─ 固定配置文件/内部常量？ → 安全
  ├─ 数据库查询结果（内部写入）？ → 安全
  └─ HTTP 入口用户输入 → 继续

Step 3: 签名验证检查
  ├─ 有效 HMAC 签名验证？ → 安全
  └─ 无签名/弱签名 → 继续

Step 4: 类型限制检查
  ├─ RestrictedUnpickler 限制？ → 安全
  ├─ 仅基础类型白名单？ → 风险-B
  └─ 无类型限制 → 继续

Step 5: HTTP 入口可达性
  ├─ 无 HTTP 入口？ → 风险-A
  └─ 有 HTTP 入口 → 漏洞
```

### 2.3 降级条件表

| 条件 | 原结论 | 降级后 |
|------|--------|--------|
| 使用 json.loads/yaml.safe_load | 漏洞 | 安全 |
| 数据来自固定配置文件 | 漏洞 | 安全 |
| 有效 HMAC 签名验证 | 漏洞 | 安全 |
| RestrictedUnpickler 限制 | 漏洞 | 安全 |
| 无 HTTP 入口 | 漏洞 | 风险-A |

### 2.4 总结判定表

| 检查项 | 结论 |
|--------|------|
| json.loads / yaml.safe_load / SafeLoader | 安全 |
| 数据来自固定配置文件/数据库（内部写入） | 安全 |
| 有效 HMAC 签名验证 | 安全 |
| pickle.loads/yaml.load 用户数据 + 无防护 | 漏洞 |
| 仅类型白名单/弱签名 | 风险-B |
| 无 HTTP 入口 | 风险-A |

---

## 3. 常见漏洞/风险场景

### 场景1：pickle.loads 用户数据

```python
def load_object(request):
    obj = pickle.loads(request.body)  # 漏洞
```

### 场景2：yaml.load 无 SafeLoader

```python
def load_config(request):
    config = yaml.load(request.body)  # 漏洞：默认 UnsafeLoader
```

### 场景3：jsonpickle.decode 用户输入

```python
def load_user(request):
    obj = jsonpickle.decode(request.body)  # 漏洞
```

### 场景4：风险-B（防护不足）

```python
data = pickle.loads(request.body)
if not isinstance(data, dict):
    raise TypeError("Invalid type")  # 风险-B：isinstance 检查可被绕过
```

---

## 4. 常见防御模式

```python
# 安全 API
data = json.loads(user_input)          # 安全
data = yaml.safe_load(user_input)      # 安全
data = yaml.load(user_input, Loader=yaml.SafeLoader)  # 安全

# 可信数据源
with open("config.pkl", "rb") as f:
    config = pickle.load(f)  # 安全：内部文件

# HMAC 签名验证
expected = hmac.new(key, data_bytes, hashlib.sha256).digest()
if not hmac.compare_digest(expected, signature):
    raise ValueError("Invalid signature")
return pickle.loads(data_bytes)  # 安全

# RestrictedUnpickler
class RestrictedUnpickler(pickle.Unpickler):
    def find_class(self, module, name):
        if module == "builtins" and name in {"int", "float", "str"}:
            return getattr(builtins, name)
        raise pickle.UnpicklingError("Unsupported")
```

---

## 5. 检索技巧

### 关键 Sink 点

| 模块 | 危险函数 | 风险等级 |
|------|----------|----------|
| pickle | `loads()` / `load()` | 高危 |
| yaml | `yaml.load()` 无 Loader | 高危 |
| jsonpickle | `decode()` | 中危 |
| dill | `loads()` | 高危 |
| shelve | `open()` | 中危（底层 pickle） |
| marshal | `loads()` | 中危（代码对象） |

### 扩展 Sink 点说明

- **yaml.load 版本差异**：PyYAML < 5.1 默认 UnsafeLoader；必须显式指定 `Loader=yaml.SafeLoader` 或 `Loader=yaml.CSafeLoader`
- **jsonpickle**：`decode()` 支持对象还原（危险）；`encode()` 是序列化（安全）
- **shelve**：底层使用 pickle，需确认数据来源
- **numpy.load**：默认不启用 pickle（`allow_pickle=False`），安全

### 检测命令

```bash
# 检测危险反序列化 API
grep -rn "pickle\.load\|yaml\.load\|jsonpickle\.decode\|dill\.load" --include="*.py"

# 检测安全 API
grep -rn "json\.loads\|yaml\.safe_load\|SafeLoader" --include="*.py"

# 检测签名验证
grep -rn "hmac\|sign\|verify" --include="*.py"
```

---

## 6. 常见误判场景

### 陷阱1：yaml.load 默认不安全

**错误**：认为 yaml.load 默认安全
**正确**：Python 3.9 之前默认使用 `UnsafeLoader` → 漏洞

### 陷阱2：numpy.load 误报

**错误**：看到 load 就认为危险
**正确**：`numpy.load()` 默认不启用 pickle → 安全

### 陷阱3：音频库误报

**错误**：函数名包含 load 就认为危险
**正确**：`librosa.load()` 是音频处理库 → 安全

### 陷阱4：忽略数据来源

**错误**：看到 pickle 就判定漏洞
**正确**：需追溯数据来源，固定配置文件 → 安全

---

## 7. 特殊风险

### pickle __reduce__ 高级利用

pickle 通过 `__reduce__` 魔术方法执行任意代码，攻击者可构造恶意序列化数据：

```python
class Exploit:
    def __reduce__(self):
        return (os.system, ("id",))
payload = pickle.dumps(Exploit())  # pickle.loads(payload) → RCE
```

### yaml.load 版本差异（核心误判点）

```python
# PyYAML < 5.1：默认 UnsafeLoader → 漏洞
data = yaml.load(request.body)

# PyYAML >= 5.1：必须显式指定 Loader
data = yaml.load(request.body, Loader=yaml.SafeLoader)  # 安全
data = yaml.load(request.body, Loader=yaml.CSafeLoader)  # 安全（C 加速）
```

### dill 扩展攻击面

`dill` 是 pickle 的扩展，支持序列化更多 Python 对象类型（lambda、闭包等），`dill.loads()` 同样高危。

---

## 8. 变更影响分析

| 变更类型 | 变更内容 | 风险 |
|----------|----------|------|
| 新增 | 新增 pickle.loads 调用 | 检查数据来源、防护措施 |
| 新增 | 新增 yaml.load 调用 | 检查 Loader 参数 |
| 修改 | 移除 SafeLoader 参数 | 移除防护 |
| 修改 | 将 json.loads 改为 pickle.loads | 引入危险 API |
| 修改 | 移除签名验证 | 移除防护 |
| 删除 | 删除 RestrictedUnpickler | 移除防护 |

---

## 9. 质量门禁（强制执行）

在输出审计结论前，按顺序验证：

- [ ] 黄金法则强制执行顺序已遵守（先检查 API 类型）
- [ ] 研判流程按顺序执行，无跳过
- [ ] yaml.load 的 Loader 参数已确认
- [ ] 签名验证逻辑已读取实现
- [ ] HTTP 入口可达性已确认，非假设
- [ ] 结论与证据一致，代码行号可追溯
- [ ] 已应用误报排除规则（numpy.load 默认安全等）

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**
