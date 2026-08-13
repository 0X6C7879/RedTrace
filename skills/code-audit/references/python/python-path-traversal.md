# 路径遍历

## 0. 黄金法则

> **漏洞存在性判断 优先于 防护有效性判断**
>
> 不拼接文件路径 = 无 路径遍历（这是漏洞本质判断，不是防护有效判断）
>
> 满足此条件时：立即终止分析，无需检查任何防护措施。

**强制执行顺序**：
1. **首先**：找到 sink 点文件操作代码（如 `open()`, `Path.read_text()`, `send_file()`）
2. **然后**：分析用户输入是否拼接进文件路径
3. **仅当** 路径拼接时，才继续检查防护措施
4. **禁止**：一上来就检查"有没有 normalize"、"A 有 B 没有"

---

## 1. 结论判断标准

| 结论 | 定义 | 判定条件 |
|------|------|----------|
| **漏洞** | 用户能控制文件路径，未经有效防护，可访问预期之外的文件 | 路径拼接 + 用户可控 + HTTP 入口可达 + 无有效防护 |
| **风险-A** | 文件操作无 HTTP 入口可达 | 路径拼接 + 无外部入口 |
| **风险-B** | 文件操作有入口可达，但防护不充分 | 路径拼接 + HTTP 入口 + 弱防护（仅 secure_filename/字符替换） |
| **安全** | 无危险写法，或有充分防护 | 固定路径/abspath+startswith/白名单/UUID 重命名 |

---

## 2. 研判思路

### 2.1 Sink 点列表（第一优先级）

| Sink 点 | 风险 |
|---------|------|
| `open(user_path)` | 高危 |
| `Path(user_path).read_text()` | 高危 |
| `flask.send_file(user_path)` | 高危 |
| `os.remove(user_path)` / `shutil.rmtree(user_path)` | 高危 |
| `zipfile.ZipFile.extractall()`（无验证时） | 高危（Zip Slip） |
| `Path.joinpath(user_path)` / `(Path(base) / user_path)` | 高危 |

找到 sink 点后，判断用户输入是否拼接进路径。

### 2.2 研判流程

```
Step 1: 参数实际可控性检查 【终止点】
  ├─ 参数仅用于日志记录？ → 安全（终止）
  ├─ 固定文件路径？ → 安全（终止）
  └─ 参数用于文件操作 → 继续

Step 2: 类型约束 / 数据库来源 【终止点】
  ├─ int 类型约束 / 数据库中间来源？ → 安全（终止）
  └─ 用户直接输入 → 继续

Step 3: 路径规范化+前缀验证 【终止点】
  ├─ os.path.abspath() + startswith() / Path.resolve() + startswith()？ → 安全（终止）
  ├─ 自定义路径验证函数（validate_safe_path / validate_safe_file_path / sanitizePath 等）？
  │   → 必须读取函数实现，并判断类型（见陷阱6）：
  │   ├─ 拦截型（校验失败 return False/raise，调用处有 if not is_safe: return）→ 安全（终止）
  │   ├─ 净化型（返回净化后路径，调用处 sink 使用原始变量）→ 漏洞
  │   └─ 实现仅做黑名单过滤 → 风险-B
  └─ 无验证 → 继续

Step 4: 白名单/固定后缀+前缀约束/UUID 【终止点】
  ├─ 白名单校验 / 固定后缀 + 强约束前缀？ → 安全（终止）
  ├─ UUID 重命名？ → 安全（终止）
  └─ 无 → 继续

Step 5: 防护强度检查
  ├─ secure_filename（不验证是否在基础目录内）？ → 风险-B
  ├─ 字符替换（可被 URL 编码绕过）？ → 风险-B
  └─ 无防护 → 继续

Step 6: Zip Slip 检查
  ├─ extractall 无路径验证？ → 漏洞
  └─ 非 Zip 场景 → 继续

Step 7: HTTP 入口可达性 【终止点】
  ├─ 无 HTTP 入口？ → 风险-A
  └─ 有 HTTP 入口 → 漏洞
```

### 2.3 降级条件表

| 条件 | 原结论 | 降级后 |
|------|--------|--------|
| 参数仅用于日志 / 固定文件路径 | 漏洞 | 安全 |
| 类型约束 / 数据库中间来源 | 漏洞 | 安全 |
| abspath() + startswith() / resolve() + startswith() | 漏洞 | 安全 |
| 白名单 / UUID 重命名 | 漏洞 | 安全 |
| 非线上环境 | 漏洞 | 安全 |
| secure_filename（不验证基础目录） | 漏洞 | 风险-B |
| 字符替换过滤 | 漏洞 | 风险-B |
| 无 HTTP 入口可达 | 漏洞 | 风险-A |

### 2.4 总结判定表

| 检查项 | 结论 |
|--------|------|
| 固定路径 / 仅日志使用 / 类型约束 / 数据库来源 | 安全 |
| abspath + startswith / 白名单 / UUID 重命名 | 安全 |
| 路径拼接 + 无防护 + HTTP 入口 | 漏洞 |
| extractall 无验证（Zip Slip） | 漏洞 |
| secure_filename / 字符替换 | 风险-B |
| 无 HTTP 入口 | 风险-A |

---

## 3. 常见漏洞/风险场景

### 漏洞

```python
# 直接拼接无防护
@app.route('/download')
def download():
    filename = request.args.get('file')
    return send_file(f"/var/app/files/{filename}")  # 漏洞

# 基础目录用户可控
base_dir = request.args.get('dir')
file_path = os.path.join(base_dir, filename)
return send_file(file_path)  # 漏洞

# Zip Slip 无验证
with zipfile.ZipFile(zip_path, 'r') as zip_ref:
    zip_ref.extractall(EXTRACT_DIR)  # 漏洞
```

### 风险-B（防护不足）

```python
# secure_filename 不验证基础目录
filename = secure_filename(request.args.get('file'))
return send_file(f"/uploads/{filename}")  # 风险-B

# 字符替换可被绕过
safe_key = key.replace(':', '_').replace('/', '_')
return send_file(f"/app/data/{safe_key}.json")  # 风险-B
```

---

## 4. 常见防御模式

### 路径规范化 + 前缀验证

```python
# os.path 方式
file_path = os.path.abspath(os.path.join(BASE_DIR, filename))
if not file_path.startswith(BASE_DIR):
    return "Invalid path", 400

# pathlib 方式
full_path = (base_dir / user_path).resolve()
if not str(full_path).startswith(str(base_dir)):
    return "Invalid path", 400
```

### 固定文件名 / 白名单 / UUID

```python
# 固定文件名
file_path = "/app/data/login.json"  # 安全

# 固定后缀 + 强约束前缀
file_name = re.sub(r'[^a-zA-Z0-9]', '', user_input) + ".json"  # 安全

# UUID 重命名
safe_name = str(uuid.uuid4()) + ext  # 安全
```

### Zip 路径验证

```python
for entry in zip_ref.infolist():
    path = os.path.abspath(os.path.join(extract_dir, entry.filename))
    if not path.startswith(extract_dir):
        raise ValueError("Zip slip detected")
    zip_ref.extract(entry, extract_dir)
```

### 文件扩展名白名单（目录遍历场景有效防护）

当目录遍历受限于特定文件扩展名时，如果服务器敏感文件不匹配该扩展名，实际攻击价值为零。

```python
# 安全：严格限制可读文件后缀
files = [f for f in os.listdir(dir) if f.endswith(".pdf")]
# 服务器敏感文件（/etc/passwd、密钥文件、配置文件）不以 .pdf 结尾
# → 实际攻击价值为零 → 安全
```

**判定条件**：
- 文件后缀白名单（白名单，非黑名单）
- 服务器敏感文件不匹配该后缀（.pdf/.jpg/.png 等非敏感格式）
- → 判定为安全

### 固定文件名 + 固定内容来源

当文件名硬编码、内容来自固定来源时，即使目录路径可控，实际危害极低。

```python
# 安全：文件名硬编码 + 内容来自固定 API
file_path = os.path.join(save_dir, "encryptFriendId.pdf")
# save_dir 虽可控但：
# 1. 文件名 encryptFriendId.pdf 硬编码（不可控）
# 2. 内容来自固定远程 API（非用户上传）
# → 实际危害极低 → 安全
```

**判定条件**：
- 文件名硬编码（用户不可控）
- 文件内容来自固定/已知来源
- → 判定为安全

#### 用户输入 + 硬编码后缀

当文件名由用户输入与硬编码后缀拼接时，后缀固定限制了文件类型，用户无法通过路径遍历读取任意类型文件。

```python
# 安全：用户输入 + 硬编码安全后缀
file_name = f"{task_id}.json"  # 后缀 .json 硬编码
file_path = os.path.join(base_dir, file_name)
# 用户只能控制文件名前缀，无法改变文件类型

# 安全：硬编码前后缀
file_name = f"report_{user_id}.txt"

# 安全：格式化固定后缀
file_name = "data_{}.csv".format(date)
```

**安全后缀列表**：`.json` / `.txt` / `.csv` / `.md` / `.pdf` / `.log`

**前置条件**：用户输入部分不含路径分隔符（`/`、`\`、`..`），典型场景为纯 ID（数字/UUID/字母数字标识符）。

**判定规则**：
- 用户输入为纯 ID + 硬编码安全后缀，且后缀不可被用户覆盖 → **safe**
- sink 参数完全由硬编码常量组成 → **safe**
- sink 参数通过枚举映射转换，值域受限制 → **safe**
- 用户输入可能包含路径分隔符（如自由文本） + 硬编码后缀 → **需继续分析**（后缀不防路径遍历）

---

## 5. 检索技巧

### 搜索关键词

| 类型 | 关键词 |
|------|--------|
| 文件操作 | `open(`, `send_file`, `Path(` |
| Zip 操作 | `zipfile`, `extractall`, `.extract(` |
| 路径验证 | `abspath`, `normpath`, `resolve`, `startswith` |

### 检测命令

```bash
# 检测文件操作
grep -rn "open(\|send_file\|Path(" --include="*.py"

# 检测路径拼接
grep -rn "f\".*{.*}\".*open\|os\.path\.join.*{" --include="*.py"

# 检测 Zip 解压
grep -rn "zipfile\|extractall\|\.extract(" --include="*.py"
```

---

## 6. 常见误判场景

### 陷阱1：参数仅用于日志误判（高频）

**错误**: 看到参数就认为可控
**正确**: 参数仅用于 `logger.info()`，实际文件操作使用固定路径 → 安全

### 陷阱2：secure_filename 误认为完全防护

**错误**: 认为 `secure_filename()` 足够防护
**正确**: 只删除危险字符，不验证是否在基础目录内 → 风险-B

### 陷阱3：字符替换过滤强度误判

**错误**: 认为有替换就安全
**正确**: 替换可能被 URL 编码绕过（`%252e%252e%252f` → `../`） → 风险-B

### 陷阱4：先看防护，后看漏洞本质

**错误思路**：发现代码缺少 abspath → A 有 B 没有 → 判定风险
**正确思路**：先判断漏洞是否存在（固定路径 → 无路径遍历）

> 漏洞存在性判断 > 防护有效性判断。不拼接文件路径 = 无路径遍历。

### 陷阱5：被代码对比干扰

**错误判定**：A 有路径校验 B 没有 → B 有风险
**正确判定**：先看 B 漏洞是否存在（是否拼接路径），再谈防护

> 代码不一致 ≠ 安全问题。

### 陷阱6：拦截型校验后使用原始变量误判

**错误**：sink 使用原始 file_path 而非 validate 返回的 safe_path → 直接判漏洞
**正确**：必须先判断校验函数是"拦截型"还是"净化型"，再决定 sink 使用哪个变量是否安全

拦截型 vs 净化型判断表：

| 校验类型 | 函数特征 | 调用处特征 | sink 使用原始变量时 |
|------|---------|-----------|------------------|
| 拦截型  | 校验失败 → `return False` / `return (False, ...)` / `raise` | 调用后有 `if not is_safe: return` 等控制流中断 | **安全**（能到达 sink 的数据已通过校验） |
| 净化型  | 校验失败 → `return None` / 校验成功 → `return safe_path` | 调用后控制流不中断，期望 sink 使用返回的净化值 | **漏洞**（sink 绕过了净化结果） |

强制验证步骤（当发现自定义校验函数 + sink 使用原始变量时，必须按顺序执行）：
1. 读取校验函数实现，找到校验失败的分支
2. 判断失败时的行为：`return False/(False, ...)` → 拦截型；`return None/safe_value` → 净化型
3. 检查调用处：失败后是否有 `if not is_safe: return` 等语句阻断控制流？
4. 拦截型 + 控制流中断 → safe（原始变量与净化值同样安全）；净化型且 sink 用原始变量 → vulnerability

```python
# 拦截型示例（安全）：校验失败直接 return，控制流被阻断
is_safe, abs_file_path = validate_safe_file_path(file_path)  # 返回 (bool, path)
if not is_safe:
    return jsonify({"error": "unsafe"})  # 拦截型：校验失败 → 中断
# 只有 is_safe=True 才能到达这里，file_path 已通过校验
open(file_path, 'r')  # 使用原始变量 → 安全

# 拦截型示例 - 多 sink 混用（安全）：同一函数内部分 sink 用返回值、部分用原始变量
is_safe, abs_file_path = validate_safe_file_path(file_path)
if not is_safe:
    return jsonify({"error": "unsafe"})  # 拦截型：校验失败 → 中断
with open(abs_file_path, 'r') as f:        # sink1：使用返回值 → 安全
    data = f.read()
total_rows = sum(1 for _ in open(file_path, 'r'))  # sink2：使用原始变量 → 同样安全
# file_path 已通过拦截型校验，sink2 使用原始变量是代码冗余，非安全漏洞

# 净化型示例（漏洞）：校验函数返回净化值，但 sink 仍用原始变量
safe_path = sanitize_path(file_path)  # 净化型：返回安全路径
# 此处没有控制流中断
open(file_path, 'r')  # 使用原始变量而非 safe_path → 漏洞
```

**关键**：判断 sink 使用原始变量是否安全，核心在于控制流是否中断，而非变量名称是否一致。拦截型校验通过后，原始变量与返回值指向的是同一份已验证数据。当同一函数内存在多处 sink，部分使用校验返回值、部分使用原始变量时，判断依据相同：只要控制流在校验点中断，所有后续 sink 均安全，与使用哪个变量名无关。

---

## 7. 特殊风险

### Symlink 攻击

攻击者通过创建符号链接使 `filepath.Join`/`path.resolve` 结果指向预期外位置。防御：`os.Lstat()` 检测符号链接，或在 chroot 环境中操作。

### tarfile 路径遍历

`tarfile.extractall()` 解压 tar 文件时，成员名可包含 `../../` 路径。Python 3.12+ 默认启用 `filter='data'` 防护，旧版本需手动过滤：
```python
for member in tar.getmembers():
    if member.name.startswith('/') or '..' in member.name:
        raise SecurityException()
```

---

## 8. 变更影响分析

| 变更类型 | 变更内容 | 风险 |
|----------|----------|------|
| 新增 | 新增 open/send_file 调用 | 确认路径拼接方式 |
| 新增 | 新增 zipfile 操作 | 路径验证 |
| 修改 | 移除 abspath/startswith 验证 | 移除防护 |
| 修改 | 移除 Zip 路径验证 | 移除防护 |
| 删除 | 删除路径规范化 / 白名单 | 移除防护 |

---

## 9. 质量门禁（强制执行）

在输出审计结论前，按顺序验证：

- [ ] 强制执行顺序已遵守（先检查路径拼接分析）
- [ ] 参数是否实际参与文件操作已确认（排除仅日志场景）
- [ ] abspath + startswith 完整性已确认（两者缺一不可）
- [ ] 发现自定义校验函数时，已读取函数实现并判断类型（拦截型/净化型），已验证调用处控制流是否中断
- [ ] HTTP 入口可达性已确认，非假设
- [ ] 结论与证据一致，代码行号可追溯
- [ ] 不因代码对比而判定风险

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**
