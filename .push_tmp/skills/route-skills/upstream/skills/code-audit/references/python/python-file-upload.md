# 文件上传

## 0. 黄金法则

> **漏洞存在性判断 优先于 防护有效性判断**
>
> UUID 重命名 + 硬编码安全后缀 = 无文件上传漏洞（这是漏洞本质判断，不是防护有效判断）
>
> 满足此条件时：立即终止分析，无需检查任何防护措施。

**强制执行顺序**：
1. **首先**：找到 sink 点文件名最终构造代码
2. **然后**：分析文件名来源（UUID？用户输入？）
3. **仅当**文件名用户可控时，才继续检查防护措施
4. **禁止**：一上来就检查"有没有白名单"

**前置排除：仅内存解析不持久化（先于黄金法则判断）**

`FileStorage`/`request.files` 的 `stream`/`read()` 仅用于内存解析（如 `pandas.read_csv(file.stream)`、`Image.open(file.stream)`、`json.load`），且**全程无落盘 sink**（无 `file.save`、`open(..., 'w')`、`shutil.copyfileobj`、对象存储写入）→ **安全（排除文件上传漏洞）**，记入 `passed_checks`，理由以 `[FP-3.10]` 起首。

> ⚠️ 排除仅限"文件上传"类别。内存解析仍可能触发其他漏洞，**必须转查**：XML/Excel 解析的 XXE、`pickle`/反序列化、大文件/深层 XML 的 OOM 与 zip-bomb DoS。

**审计原则**：

| 原则 | 说明 |
|------|------|
| 管理员降级 | 仅管理员可达时降级为风险 |
| 用户可控 | 只分析用户上传的文件 |
| 服务端生成 | UUID+硬编码后缀=安全；用户控制后缀=风险 |

---

## 1. 结论判断标准

| 结论 | 定义 | 判定条件 |
|------|------|----------|
| **漏洞** | 用户可通过 HTTP 上传任意文件，无有效防护 | 1. 使用原始文件名; 2. 无白名单/内容校验; 3. HTTP 入口可达 |
| **风险-A** | 文件上传功能无 HTTP 入口可达 | 1. 存在文件保存操作; 2. 无外部入口 |
| **风险-B** | 有 HTTP 入口可达，但防护不充分 | 1. 存在文件上传; 2. HTTP 入口可达; 3. 仅有弱防护 |
| **安全** | 无危险写法，或有充分防护 | 白名单+内容校验 / 硬编码后缀 / 服务端生成文件名 / 非线上环境 |

---

## 2. 漏洞风险的研判思路

### 2.1 文件名处理检查（第一优先级）

找到 sink 点文件名最终构造代码，分析文件名来源：

| 文件名来源 | 代码示例 | 初步结论 |
|----------|----------|----------|
| UUID + 硬编码后缀 | `str(uuid.uuid4()) + ".jpg"` | 安全（立即终止） |
| UUID + 用户后缀 | `uuid + "." + filename.rsplit('.', 1)[-1]` | 需继续研判 |
| 原始文件名 | `file.filename` | 需继续研判 |
| 用户输入 | `request.form.get('filename')` | 漏洞 |

#### 服务端生成文件名的安全性差异

| 生成方式 | 可预测性 | 安全性 |
|---------|---------|--------|
| 随机 UUID | 不可预测 | ✅ 安全 |
| 时间戳（毫秒） | 可预测 | ⚠️ 风险-B |
| 时间戳（秒）/ 自增ID | 高度可预测 | 🔴 漏洞 |

### 2.2 研判流程

```
Step 1: 文件名使用检查
  ├─ 服务端生成 + 硬编码安全后缀？ → 安全
  ├─ 服务端生成 + 用户后缀 → 进入 Step 2
  └─ 原始文件名 → 漏洞

Step 2: 后缀白名单校验
  ├─ 严格白名单（仅安全后缀）？ → 安全
  ├─ 白名单包含危险后缀 → 漏洞
  └─ 无白名单 → 进入 Step 3

Step 3: 内容校验检查
  ├─ PIL Image.open + verify？ → 安全
  ├─ 仅魔数检查 → 风险-B
  └─ 无内容校验 → 进入 Step 4

Step 4: 防护措施综合评估
  ├─ 无任何防护 → 漏洞
  └─ 仅 secure_filename/Content-Type → 风险-B

Step 5: HTTP 入口可达性
  ├─ 无 HTTP 入口？ → 风险-A
  ├─ 仅管理员可达？ → 风险-B
  └─ 外部可访问 → 使用上述结论
```

### 2.3 降级条件表

| 条件 | 原结论 | 降级后 |
|------|--------|--------|
| 非线上环境 | 漏洞 | 安全 |
| 无 HTTP 入口 | 漏洞 | 风险-A |
| 仅后缀名/secure_filename 校验 | 漏洞 | 风险-B |
| UUID+硬编码安全后缀 | 漏洞 | 安全 |
| 严格白名单+PIL verify | 漏洞 | 安全 |

### 2.4 总结判定表

| 检查项 | 结论 |
|--------|------|
| UUID+硬编码安全后缀 / 严格白名单+PIL verify | 安全 |
| 直接使用原始文件名 / 白名单含危险后缀 | 漏洞 |
| 仅 secure_filename/Content-Type 校验 | 风险-B |
| 内部方法无 HTTP 入口 | 风险-A |

---

## 3. 常见漏洞/风险场景

### 场景1：无校验直接保存

```python
file.save(os.path.join(uploads_dir, file.filename))  # 漏洞
```

### 场景2：白名单包含危险后缀

```python
ALLOWED = {'jpg', 'png', 'py', 'html'}  # 漏洞：包含可执行后缀
```

### 场景3：仅 Content-Type 校验

```python
if file.content_type.startswith('image/'):  # 漏洞：客户端可伪造
    file.save(...)
```

### 场景4：富文本编辑器图片上传（高风险）

```python
# 危险：保留原始文件名 + 白名单含 svg
filename = file.filename  # 用户可控
ALLOWED_EXTENSIONS = {'jpg', 'png', 'gif', 'svg'}  # svg 是危险后缀
```

| 场景 | 判定 |
|------|------|
| 白名单含 `svg`/`html` | **漏洞（存储型 XSS）** |
| 白名单仅 `jpg/png/gif` + 后端校验 | 安全 |
| 保留原始文件名 + 无白名单 | **漏洞** |

### 场景5：路径遍历导致任意文件写入

```python
file.save(os.path.join(uploads_dir, file.filename))  # 可 ../../etc/passwd
```

| 场景 | 判定 |
|------|------|
| 原始文件名直接使用 + 无路径规范化 | **漏洞** |
| `".." in filename` 检查 | **风险-B**（URL 编码绕过） |
| `os.path.realpath() + startswith(baseDir)` | 安全 |
| UUID 重命名 | 安全 |

### 场景6：竞争条件（TOCTOU）

```python
# 危险：先检查后使用
if not os.path.exists(filepath):  # 检查点
    file.save(filepath)  # 攻击窗口中可覆盖

# 危险：临时文件 + 校验
temp_path = tempfile.mktemp(suffix='.tmp')
file.save(temp_path)  # 先写入磁盘
if not is_valid_image(temp_path): ...  # 校验期间文件可被替换
```

| 场景 | 判定 |
|------|------|
| `exists()` 检查 + 后续写入 | **风险-B** |
| 临时文件 + 校验 + 移动 | **风险-B** |
| 原子操作（内存校验 + UUID 重命名写入） | 安全 |

### 场景7：仅 secure_filename

```python
filename = secure_filename(file.filename)  # 风险-B：只处理路径遍历，不检查后缀
file.save(os.path.join(uploads_dir, filename))
```

### 场景8：内部方法无入口

```python
def generate_report(data):
    filename = f"report_{int(time.time())}.csv"  # 风险-A
```

---

## 4. 常见防御模式

### 白名单校验

```python
ALLOWED_EXTENSIONS = {'txt', 'pdf', 'png', 'jpg', 'jpeg', 'gif'}
if allowed_file(file.filename):
    file.save(os.path.join(uploads_dir, secure_filename(file.filename)))
```

### 硬编码后缀

```python
filename = str(uuid.uuid4()) + ".jpg"
file.save(os.path.join(uploads_dir, filename))
```

### 内容校验

```python
img = Image.open(file.stream)
img.verify()
filename = str(uuid.uuid4()) + ".jpg"
img.save(os.path.join(uploads_dir, filename))
```

### 上传目录配置安全

| 配置项 | 安全配置 | 危险配置 |
|--------|----------|----------|
| Nginx | 禁止上传目录执行脚本 | 无脚本执行限制 |
| Apache | `SetHandler default-handler` | 允许执行 |
| Gunicorn | 静态文件由 Nginx 处理 | Python 应用直接暴露上传目录 |
| Flask | 上传目录不在 `static` 下 | 在 `static` 下可被访问 |

---

## 5. 检索技巧

| 类型 | 关键词 |
|------|--------|
| 文件上传 | `request.files`, `FileStorage`, `UploadedFile` |
| 文件保存 | `.save(`, `open(.*w)`, `shutil.copyfileobj` |
| 白名单 | `allowed_file`, `ALLOWED_EXTENSIONS` |
| 内容校验 | `Image.open`, `imghdr.what`, `verify()` |

```bash
# 检测文件上传
grep -rn "request\.files\|FileStorage\|UploadedFile" --include="*.py"

# 检测文件保存
grep -rn "\.save(\|open.*w" --include="*.py"

# 检测白名单
grep -rn "allowed_file\|ALLOWED_EXTENSIONS" --include="*.py"
```

---

## 6. 常见误判场景

### 陷阱1：secure_filename 误判

**错误**: 看到 `secure_filename` 就认为安全
**正确**: 只处理路径遍历，不验证文件类型 → 风险-B

### 陷阱2：UUID 重命名忽略后缀

**错误**: UUID 文件名 = 安全
**正确**: `uuid + "." + ext` 后缀仍来自用户 → 需白名单

### 陷阱3：Content-Type 检查

**错误**: Content-Type 可信
**正确**: Content-Type 由请求头指定，客户端可伪造

### 陷阱4：对象存储误判

**错误**: S3 = 安全
**正确**: S3 只是存储后端，需检查文件类型校验

### 陷阱5：校验参数与实际使用参数不一致

```python
file = request.files['file']
save_name = request.form.get('fileName')  # 用户可控的单独参数
# ⚠️ 校验的是 file.filename
ext = file.filename.rsplit('.', 1)[-1].lower()
if ext not in ALLOWED_EXTENSIONS: abort(400)
# ⚠️ 但保存时使用的是 save_name！
file.save(os.path.join(upload_dir, save_name))  # 漏洞
```

**错误**: 有白名单 → 安全
**正确**: 校验对象（`file.filename`）≠ 保存对象（`save_name`）→ **漏洞**

---

## 7. 危险文件后缀

**基础危险后缀**：`jsp`, `php`, `aspx`, `asp`, `html`, `htm`, `js`, `svg`, `xml`, `swf`, `css`

**扩展危险后缀**：`mjs`, `es`, `ecma`, `jscript`, `live-script`, `cjs`, `vbs`, `hta`, `xhtml`, `jspx`

**对应 Content-Type**：`text/javascript`, `text/html`, `image/svg+xml`, `application/xml`, `text/css`

### SVG 特殊风险

> SVG 本质是 XML，浏览器会执行其中的 JavaScript。白名单含 `svg` 且文件可被浏览器直接访问 = **漏洞（存储型 XSS）**。若服务端强制 `Content-Type: application/octet-stream` 则安全。

---

## 8. 变更影响分析

| 变更类型 | 变更内容 | 风险 |
|----------|----------|------|
| 新增 | 新增文件上传接口 | 检查文件名处理、类型校验 |
| 新增 | 新增对象存储上传 | 检查 Content-Type 和 MIME Sniffing |
| 新增 | 新增白名单校验 | 检查是否包含危险后缀 |
| 修改 | 移除白名单检查 | 允许任意文件类型 |
| 修改 | 改用原始文件名 | 路径遍历风险 |
| 修改 | 移除内容校验 | MIME 混淆风险 |
| 删除 | 删除白名单校验 | 移除防护 |
| 删除 | 删除路径规范化 | 路径遍历风险 |
| 删除 | 删除内容校验 | MIME 混淆风险 |

---

## 9. 质量门禁（强制执行）

在输出审计结论前，按顺序验证：

- [ ] 强制执行顺序已遵守（先检查文件名处理方式）
- [ ] 研判流程按顺序执行，无跳过
- [ ] UUID+硬编码后缀直接终止（漏洞本质判断先于防护判断）
- [ ] HTTP 入口可达性已确认，非假设
- [ ] 白名单内容已检查，非仅凭存在判断
- [ ] 结论与证据一致，代码行号可追溯
- [ ] secure_filename 不等于完整防护
- [ ] 校验参数与使用参数一致

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**
