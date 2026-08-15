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

`req.file.buffer`/`busboy` 流仅用于内存解析（如 `JSON.parse(buffer)`、`xlsx.parse(buffer)`、`fileType.fromBuffer` 校验），且**全程无落盘 sink**（无 `fs.writeFile`/`fs.writeFileSync`、`multer.diskStorage`、对象存储 `s3.upload` 写入）→ **安全（排除文件上传漏洞）**，记入 `passed_checks`，理由以 `[FP-3.10]` 起首。

> ⚠️ 排除仅限"文件上传"类别。内存解析仍可能触发其他漏洞，**必须转查**：XML/Excel 解析的 XXE、大文件/深层 XML 的 OOM 与 zip-bomb DoS、`sharp`/图片解码库漏洞。

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
| **漏洞** | 用户可通过 HTTP 上传任意文件，无有效防护 | 1. 存在文件上传接口; 2. HTTP 入口可达; 3. 无有效防护 |
| **风险-A** | 存在文件上传操作但无外部入口 | 1. 存在文件上传; 2. 无外部入口; 3. 非测试代码 |
| **风险-B** | 有 HTTP 入口可达，但防护不充分 | 1. 存在文件上传接口; 2. HTTP 入口可达; 3. 仅有弱防护 |
| **安全** | 无危险写法，或有充分防护 | UUID+硬编码后缀 / 白名单+内容校验 / 对象存储 / 非线上环境 |

---

## 2. 漏洞风险的研判思路

### 2.1 文件名处理检查（第一优先级）

找到 sink 点文件名最终构造代码，分析文件名来源：

| 文件名来源 | 代码示例 | 初步结论 |
|----------|----------|----------|
| UUID + 硬编码后缀 | `uuid() + ".jpg"` | 安全（立即终止） |
| UUID + 用户后缀 | `uuid() + "." + getExtension(originalName)` | 需继续研判 |
| 原始文件名 | `file.originalname` | 需继续研判 |
| 用户输入 | `req.body.filename` | 漏洞 |

#### 服务端生成文件名的安全性差异

| 生成方式 | 可预测性 | 安全性 |
|---------|---------|--------|
| UUID v4 / crypto.randomBytes | 不可预测 | ✅ 安全 |
| 时间戳（毫秒） | 可预测 | ⚠️ 风险-B |
| 时间戳（秒）/ 自增ID | 高度可预测 | 🔴 漏洞 |

**常见拼接模式**：

```
危险（文件名/后缀用户可控）：
- filename = file.originalname
- filename = uuid() + "." + getExtension(originalName)

安全（文件名/后缀固定）：
- filename = uuid() + ".jpg"
- filename = "fixed_" + counter + ".csv"
```

### 2.2 研判流程

```
Step 1: 环境检查
  ├─ 非线上环境？ → 安全
  └─ 线上环境 → 继续

Step 2: 文件名处理检查
  ├─ UUID + 硬编码安全后缀 / 上传到对象存储？ → 安全
  ├─ UUID + 用户后缀 → 继续检查白名单
  └─ 原始文件名 → 漏洞

Step 3: 白名单校验检查
  ├─ 白名单仅安全后缀？ → 继续检查内容校验
  ├─ 白名单包含危险后缀 → 漏洞
  └─ 无白名单 → 漏洞

Step 4: 内容校验检查
  ├─ sharp/file-type/jimp 校验？ → 安全
  └─ 无内容校验 → 风险-B

Step 5: 路径规范化检查
  ├─ resolve + startsWith(baseDir)？ → 继续
  └─ 无路径规范化 → 漏洞

Step 6: HTTP 入口可达性
  ├─ 无入口？ → 风险-A
  └─ 有入口 → 使用上述结论
```

### 2.3 降级条件表

| 条件 | 原结论 | 降级后 |
|------|--------|--------|
| 非线上环境 | 漏洞 | 安全 |
| 无 HTTP 入口 | 漏洞 | 风险-A |
| 仅后缀名/MIME-Type 校验 | 漏洞 | 风险-B |
| UUID+硬编码安全后缀 / 对象存储 | 漏洞 | 安全 |

### 2.4 总结判定表

| 检查项 | 结论 |
|--------|------|
| UUID+硬编码后缀 / 对象存储 / 白名单+内容校验 | 安全 |
| 原始文件名 / 白名单含危险后缀 | 漏洞 |
| 仅后缀名/MIME-Type 校验 | 风险-B |
| 内部方法无 HTTP 入口 | 风险-A |

---

## 3. 常见漏洞/风险场景

### 场景1：无校验直接保存

```javascript
const storage = multer.diskStorage({
    filename: (req, file, cb) => {
        cb(null, file.originalname);  // 漏洞：原始文件名
    }
});
```

### 场景2：白名单包含危险后缀

```javascript
const ALLOWED = ['jpg', 'png', 'gif', 'html', 'js'];  // 漏洞
```

### 场景3：仅 MIME-Type 校验

```javascript
if (file.mimetype.startsWith('image/')) { ... }  // 漏洞：客户端可伪造
```

### 场景4：富文本编辑器图片上传（高风险）

```javascript
// 危险：保留原始文件名 + 白名单含 svg
const filename = req.file.originalname;  // 用户可控
const ALLOWED = ['jpg', 'png', 'gif', 'svg'];  // svg 是危险后缀
```

| 场景 | 判定 |
|------|------|
| 白名单含 `svg`/`html` | **漏洞（存储型 XSS）** |
| 白名单仅 `jpg/png/gif` + 后端校验 | 安全 |
| 保留原始文件名 + 无白名单 | **漏洞** |

### 场景5：路径遍历导致任意文件写入

```javascript
const filename = req.body.filename;  // 用户可控：../../etc/passwd
fs.writeFileSync(path.join(__dirname, 'uploads', filename), data);  // 漏洞
```

| 场景 | 判定 |
|------|------|
| 原始文件名直接使用 + 无路径规范化 | **漏洞** |
| `filename.includes("..")` 检查 | **风险-B**（URL 编码绕过） |
| `path.resolve() + startsWith(baseDir)` | 安全 |
| UUID 重命名 | 安全 |

### 场景6：竞争条件（TOCTOU）

```javascript
// 危险：先检查后使用
if (!fs.existsSync(filepath)) {  // 检查点
    fs.renameSync(req.file.path, filepath);  // 攻击窗口中可覆盖
}

// 危险：临时文件 + 校验
fs.renameSync(req.file.path, tempPath);  // 先写入磁盘
const isValid = await validateImage(tempPath);  // 校验期间文件可被替换
```

| 场景 | 判定 |
|------|------|
| `existsSync()` 检查 + 后续写入 | **风险-B** |
| 临时文件 + 校验 + 移动 | **风险-B** |
| 原子操作（内存校验 + UUID 写入） | 安全 |

### 场景7：仅后缀名校验

```javascript
if (ALLOWED.includes(ext)) { ... }  // 风险-B：无内容校验，可 MIME 混淆
```

### 场景8：内部方法无入口

```javascript
function saveFile(filename, content) {
    fs.writeFileSync(path.join(__dirname, 'uploads', filename), content);
}  // 风险-A：需追踪调用方
```

---

## 4. 常见防御模式

### UUID 重命名 + 硬编码后缀

```javascript
const filename = uuid() + '.jpg';
fs.renameSync(req.file.path, './uploads/' + filename);
```

### 对象存储

```javascript
await s3.upload({ Bucket: 'my-bucket', Key: uuid() + '.jpg', Body: req.file.buffer }).promise();
```

### 白名单 + 内容校验

```javascript
const type = await fileType.fromBuffer(req.file.buffer);
if (!ALLOWED_MIMES.includes(type.mime)) throw new Error();
const filename = uuid() + '.' + ext;
```

### 图片重新编码

```javascript
await sharp(req.file.path).resize(800, 600).toFormat('jpg').toFile('./uploads/' + filename);
```

### 路径规范化

```javascript
const targetPath = path.resolve(uploadDir, filename);
if (!targetPath.startsWith(uploadDir)) throw new Error();
```

### 上传目录配置安全

| 配置项 | 安全配置 | 危险配置 |
|--------|----------|----------|
| Nginx | 禁止上传目录执行脚本 | 无脚本执行限制 |
| Apache | `SetHandler default-handler` | 允许执行 |
| Express | 上传目录不在 `express.static` 范围 | 上传目录可被静态访问 |
| Next.js | 上传目录不在 `public` 目录 | 在 `public` 目录 |

---

## 5. 检索技巧

| 类型 | 关键词 |
|------|--------|
| 文件上传库 | `multer`, `formidable`, `busboy`, `multiparty` |
| 文件名 | `originalname`, `filename`, `file.name` |
| 路径操作 | `path.join`, `path.resolve`, `fs.writeFile` |
| 对象存储 | `s3.upload`, `blobstore`, `putObject` |

**框架默认行为**：Multer/Formidable 保留原始文件名后缀（需配置 `filename` 函数），Busboy 需手动处理文件名。

```bash
# 检测 multer 使用
grep -rn "multer\|diskStorage" --include="*.js"

# 检测文件名处理
grep -rn "originalname\|file.name" --include="*.js"

# 检测路径操作
grep -rn "path.join\|fs.writeFile\|fs.writeFileSync" --include="*.js"
```

---

## 6. 常见误判场景

### 陷阱1：MIME-Type 误判

**错误**: `mimetype` 校验 = 安全
**正确**: MIME-Type 由客户端设置，可伪造 → 需内容校验

### 陷阱2：后缀名校验误判

**错误**: 后缀白名单 = 安全
**正确**: 需配合内容校验，否则存在 MIME 混淆

### 陷阱3：对象存储误判

**错误**: `fs.writeFile` = 危险
**正确**: 上传到 BlobStore/S3 等对象存储默认安全

### 陷阱4：UUID 重命名误判

**错误**: UUID = 安全
**正确**: 需确认后缀是否硬编码，用户可控后缀仍危险

### 陷阱5：校验参数与实际使用参数不一致

```javascript
const storage = multer.diskStorage({
    filename: (req, file, cb) => {
        // ⚠️ 校验的是 file.originalname
        const ext = path.extname(file.originalname).slice(1);
        if (!ALLOWED.includes(ext)) return cb(new Error('invalid'));
        // ⚠️ 但实际文件名使用了 req.body.fileName（用户可控）
        cb(null, req.body.fileName);
    }
});
```

**错误**: 有白名单 → 安全
**正确**: 文件名校验与使用路径不同 → 校验被绕过 → **漏洞**

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
- [ ] 内容校验与 MIME-Type 校验已区分
- [ ] 结论与证据一致，代码行号可追溯
- [ ] 框架默认行为已确认（Multer 保留原始后缀）
- [ ] 校验参数与使用参数一致

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**
