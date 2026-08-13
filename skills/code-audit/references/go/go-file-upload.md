# 文件上传

## 0. 黄金法则

> **漏洞存在性判断 优先于 防护有效性判断**
>
> 文件名由服务端生成 + 硬编码安全后缀 = 无文件上传漏洞（这是漏洞本质判断，不是防护有效判断）
>
> 满足此条件时：立即终止分析，无需检查任何防护措施。

**强制执行顺序**：
1. **首先**：找到 sink 点文件上传代码（如 `FormFile()`, `SaveUploadedFile()`）
2. **然后**：分析文件名来源（服务端生成 vs 用户可控）
3. **仅当**文件名用户可控时，才继续检查防护措施
4. **禁止**：一上来就检查"有没有白名单"

**前置排除：仅内存解析不持久化（先于黄金法则判断）**

`FormFile`/`MultipartForm` 返回的 `File`/`io.Reader` 仅用于内存解析（如 `json.NewDecoder(file).Decode`、`image.Decode`、`csv.NewReader`），且**全程无落盘 sink**（无 `c.SaveUploadedFile`、`os.Create`、`os.OpenFile`、`io.Copy` 写文件、对象存储写入）→ **安全（排除文件上传漏洞）**，记入 `passed_checks`，理由以 `[FP-3.10]` 起首。

> ⚠️ 排除仅限"文件上传"类别。内存解析仍可能触发其他漏洞，**必须转查**：XML 解析的 XXE、解析序列化对象的反序列化、大文件/深层 XML 的 OOM 与 zip-bomb DoS。

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
| **漏洞** | 用户能上传任意文件，或存在 MIME 混淆风险 | 1. 文件后缀用户可控; 2. 无有效白名单; 3. HTTP 入口可达; 4. 无有效防护 |
| **风险-A** | 文件上传存在风险但无 HTTP 入口可达 | 1. 后缀用户可控或校验不足; 2. 无外部入口 |
| **风险-B** | 有 HTTP 入口可达，但防护不充分 | 1. 存在文件上传; 2. HTTP 入口可达; 3. 仅有弱防护 |
| **安全** | 无危险写法，或有充分防护 | UUID+硬编码后缀 / 有效白名单 / 内容校验 / 非线上环境 |

---

## 2. 漏洞风险的研判思路

### 2.1 文件名处理检查（第一优先级）

找到 sink 点文件名最终构造代码，分析文件名来源：

| 文件名来源 | 代码示例 | 初步结论 |
|----------|----------|----------|
| UUID + 硬编码后缀 | `uuid.New().String() + ".jpg"` | 安全（立即终止） |
| UUID + 用户后缀 | `uuid.New() + "." + filepath.Ext(header.Filename)` | 需继续研判 |
| 原始文件名 | `header.Filename` | 需继续研判 |
| 用户输入 | `c.PostForm("filename")` | 漏洞 |

#### 服务端生成文件名的安全性差异

| 生成方式 | 可预测性 | 安全性 |
|---------|---------|--------|
| 随机 UUID | 不可预测 | ✅ 安全 |
| 时间戳（毫秒） | 可预测 | ⚠️ 风险-B |
| 时间戳（秒）/ 自增ID | 高度可预测 | 🔴 漏洞 |

### 2.2 研判流程

```
Step 1: 文件名来源检查
  ├─ 服务端生成 + 硬编码安全后缀？ → 安全
  ├─ 服务端生成 + 白名单后缀？ → 继续
  └─ 用户可控后缀/原始文件名 → 继续

Step 2: 后缀白名单检查
  ├─ 白名单只允许安全后缀？ → 安全
  ├─ 白名单包含危险后缀？ → 漏洞
  └─ 无白名单 → 继续

Step 3: 内容校验检查
  ├─ 内容校验 + 硬编码/白名单后缀？ → 安全
  ├─ 内容校验 + 用户可控后缀？ → 漏洞（MIME 混淆）
  └─ 无内容校验 → 继续

Step 4: CDN MIME Sniffing 检查
  ├─ UUID 无后缀 + CDN？ → 漏洞
  └─ 有后缀 → 继续

Step 5: HTTP 入口可达性
  ├─ 无 HTTP 入口？ → 风险-A
  └─ 有 HTTP 入口 → 使用上述结论
```

### 2.3 降级条件表

| 条件 | 原结论 | 降级后 |
|------|--------|--------|
| 非线上环境 | 漏洞 | 安全 |
| 无 HTTP 入口 | 漏洞 | 风险-A |
| 仅黑名单过滤 | 漏洞 | 风险-B |
| UUID+硬编码安全后缀 | 漏洞 | 安全 |
| 有效白名单校验 | 漏洞 | 安全 |

### 2.4 总结判定表

| 检查项 | 结论 |
|--------|------|
| UUID+硬编码安全后缀 / 有效白名单 / 内容校验+安全后缀 | 安全 |
| 原始文件名直接保存 / MIME 混淆 | 漏洞 |
| 仅黑名单过滤 / 白名单含危险后缀 | 风险-B |
| 内部方法无 HTTP 入口 | 风险-A |

---

## 3. 常见漏洞/风险场景

### 场景1：原始文件名直接保存

```go
file, header, _ := r.FormFile("file")
filename := header.Filename
dst, _ := os.Create("/uploads/" + filename)
io.Copy(dst, file)  // 漏洞：路径遍历 + 文件类型可控
```

### 场景2：用户可控后缀

```go
ext := c.PostForm("ext")  // 用户指定后缀
filename := uuid.New().String() + "." + ext  // 漏洞
```

### 场景3：MIME 类型混淆

```go
src, _ := file.Open()
_, _, err := image.Decode(src)  // 内容校验通过
ext := filepath.Ext(file.Filename)  // 但后缀来自用户
filename := uuid.New().String() + ext  // 漏洞：MIME 混淆
```

### 场景4：UUID 无后缀 + CDN

```go
filename := uuid.New().String()  // 无后缀
// 上传到 CDN → CDN 根据内容自动设置 Content-Type → 漏洞
```

### 场景5：富文本编辑器图片上传（高风险）

```go
filename := file.Filename  // 用户可控
var allowedExtensions = map[string]bool{"jpg": true, "png": true, "svg": true}  // svg 危险
```

| 场景 | 判定 |
|------|------|
| 白名单含 `svg`/`html` | **漏洞（存储型 XSS）** |
| 白名单仅 `jpg/png/gif` + 后端校验 | 安全 |
| 保留原始文件名 + 无白名单 | **漏洞** |

### 场景6：路径遍历导致任意文件写入

```go
filename := c.PostForm("filename")  // 用户可控：../../etc/passwd
c.SaveUploadedFile(file, "/uploads/"+filename)  // 写入到 /etc/passwd
```

| 场景 | 判定 |
|------|------|
| 原始文件名直接使用 + 无路径规范化 | **漏洞** |
| `strings.Contains(filename, "..")` 检查 | **风险-B**（URL 编码绕过） |
| `filepath.Clean() + strings.HasPrefix(baseDir)` | 安全 |
| UUID 重命名 | 安全 |

### 场景7：竞争条件（TOCTOU）

```go
// 危险：先检查后使用
if _, err := os.Stat(filepath); os.IsNotExist(err) {  // 检查点
    c.SaveUploadedFile(file, filepath)  // 攻击窗口中可覆盖
}

// 危险：临时文件 + 校验
tempPath := path.Join("/tmp", uuid.New().String()+".tmp")
c.SaveUploadedFile(file, tempPath)  // 先写入磁盘
if !isValidImage(tempPath) { ... }  // 校验期间文件可被替换
```

| 场景 | 判定 |
|------|------|
| `os.Stat()` 检查 + 后续写入 | **风险-B** |
| 临时文件 + 校验 + 移动 | **风险-B** |
| 原子操作（内存校验 + UUID 重命名写入） | 安全 |

### 场景8：仅黑名单过滤

```go
if ext == ".exe" || ext == ".bat" { ... }  // 风险-B：黑名单可绕过
```

---

## 4. 常见防御模式

### UUID 重命名 + 硬编码后缀

```go
filename := uuid.New().String() + ".jpg"
c.SaveUploadedFile(file, "/uploads/"+filename)
```

### 有效白名单校验

```go
var allowedExtensions = map[string]bool{"jpg": true, "png": true, "gif": true}
if !allowedExtensions[ext] { return }
filename := uuid.New().String() + "." + ext
```

### 内容校验 + 硬编码后缀

```go
_, format, err := image.Decode(src)  // 内容校验
filename := uuid.New().String() + "." + format  // 使用实际格式
```

### 路径规范化

```go
cleanPath := filepath.Clean(filepath.Join(baseDir, filename))
if !strings.HasPrefix(cleanPath, baseDir) { return errors.New("invalid path") }
```

### 上传目录配置安全

| 配置项 | 安全配置 | 危险配置 |
|--------|----------|----------|
| Nginx | 禁止上传目录执行脚本 | 无脚本执行限制 |
| Apache | `SetHandler default-handler` | 允许执行 |
| Gin | 使用 `c.File()` 通过路由返回 | 上传目录在静态资源目录 |
| Go embed | 上传目录不在 embed 范围内 | 上传目录可被静态访问 |

---

## 5. 检索技巧

| 类型 | 关键词 |
|------|--------|
| 文件上传 | `FormFile`, `SaveUploadedFile`, `MultipartForm` |
| 文件操作 | `os.Create`, `os.OpenFile`, `filepath.Join` |
| UUID 生成 | `uuid.New`, `gorand.UUID` |
| 内容校验 | `image.Decode`, `gif.Decode`, `png.Decode` |

```bash
# 检测文件上传
grep -rn "FormFile\|SaveUploadedFile\|MultipartForm" --include="*.go"

# 检测文件操作
grep -rn "os.Create\|os.OpenFile\|filepath.Join" --include="*.go"

# 检测内容校验
grep -rn "image.Decode\|gif.Decode\|png.Decode" --include="*.go"
```

---

## 6. 常见误判场景

### 陷阱1：UUID 重命名忽略后缀检查

**错误**: UUID = 安全
**正确**: 后缀仍来自用户输入，需确认后缀来源

### 陷阱2：内容校验忽略后缀检查

**错误**: 内容校验 = 安全
**正确**: 内容校验 + 用户可控后缀 → MIME 混淆风险

### 陷阱3：前端校验忽略后端校验

**错误**: 前端有校验
**正确**: 前端校验可绕过，必须后端校验

### 陷阱4：路径遍历忽略

**错误**: 只关注文件类型
**正确**: `../../etc/passwd` 可写入任意位置

### 陷阱5：UUID 无后缀 + CDN 误判

**错误**: UUID 文件名 = 安全
**正确**: UUID 无后缀 + CDN → MIME Sniffing → 漏洞

### 陷阱6：校验参数与实际使用参数不一致

```go
file, header, _ := c.Request.FormFile("file")
customName := c.PostForm("fileName")  // 用户可控的单独参数
// ⚠️ 校验的是 header.Filename
ext := filepath.Ext(header.Filename)
if !allowedExtensions[strings.TrimPrefix(ext, ".")] { return }
// ⚠️ 但保存时使用的是 customName！
dst, _ := os.Create(filepath.Join(uploadDir, customName))
```

**错误**: 有白名单 → 安全
**正确**: 校验对象（`header.Filename`）≠ 使用对象（`customName`）→ **漏洞**

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
- [ ] CDN MIME Sniffing 风险已识别
- [ ] 结论与证据一致，代码行号可追溯
- [ ] 内容校验≠后缀安全，需分别检查
- [ ] 校验参数与使用参数一致

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**
