# 文件上传

## 0. 黄金法则

> **漏洞存在性判断 优先于 防护有效性判断**
>
> UUID 重命名 + 硬编码安全后缀 = 无文件上传漏洞（这是漏洞本质判断，不是防护有效判断）
>
> 满足此条件时：立即终止分析，无需检查任何防护措施。

**强制执行顺序**：
1. **首先**：找到 sink 点文件名最终构造代码（如 `filename = ...`）
2. **然后**：分析文件名来源（UUID？用户输入？）
3. **仅当**文件名用户可控时，才继续检查防护措施
4. **禁止**：一上来就检查"有没有白名单"、"A 有 B 没有"

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
| **漏洞** | 用户可通过 HTTP/gRPC 上传任意文件，无有效防护 | 1. 存在文件上传接口; 2. HTTP/gRPC 入口可达; 3. 无有效防护 |
| **风险-A** | 存在文件上传操作但无外部入口 | 1. 存在文件上传; 2. 无外部入口; 3. 非测试/非配置代码 |
| **风险-B** | 有入口可达，但防护不充分 | 1. 存在文件上传接口; 2. HTTP 入口可达; 3. 仅有弱防护 |
| **安全** | 无危险写法，或有充分防护 | UUID+硬编码后缀 / 白名单+内容校验 / 路径规范化 / 非线上环境 |

---

## 2. 漏洞风险的研判思路

### 2.1 文件名处理检查（第一优先级）

找到 sink 点文件名最终构造代码，分析文件名来源：

| 文件名来源 | 代码示例 | 初步结论 |
|----------|----------|----------|
| UUID + 硬编码后缀 | `UUID.randomUUID() + ".jpg"` | 安全（立即终止） |
| UUID + 用户后缀 | `UUID + "." + getExtension(originalFilename)` | 需继续研判 |
| UUID 无后缀 | `UUID.randomUUID()` | 漏洞（CDN MIME Sniffing） |
| 原始文件名 | `file.getOriginalFilename()` | 需继续研判 |
| 用户输入 | `userFilename` | 漏洞 |

> CDN MIME Sniffing：UUID 无后缀文件上传到 CDN 时，CDN 根据文件内容自动设置 Content-Type，若为 HTML/JS 则导致 XSS。

#### 服务端生成文件名的安全性差异

| 生成方式 | 可预测性 | 安全性 |
|---------|---------|--------|
| 随机 UUID | 不可预测（128bit） | ✅ 安全 |
| 时间戳（毫秒） | 可预测 | ⚠️ 风险-B |
| 时间戳（秒）/ 自增ID | 高度可预测 | 🔴 漏洞 |
| 用户ID + 时间戳 | 可预测 | ⚠️ 风险-B |

**可预测文件名危害**：枚举访问他人私有文件、敏感文件泄露、覆盖攻击。

**常见拼接模式**：

```
危险（文件名/后缀用户可控）：
- filename = file.getOriginalFilename()
- filename = UUID + "." + getExtension(originalFilename)

安全（文件名/后缀固定）：
- filename = UUID.randomUUID() + ".jpg"
- filename = "fixed_" + counter + ".csv"
```

### 2.2 研判流程

```
Step 1: 环境检查
  ├─ 非线上环境？ → 安全
  └─ 线上环境 → 继续

Step 2: 文件名处理检查
  ├─ UUID + 硬编码安全后缀？ → 安全
  ├─ UUID + 用户后缀 → 继续检查白名单
  └─ 原始文件名 → 漏洞

Step 3: 白名单校验检查
  ├─ 白名单仅安全后缀？ → 继续检查内容校验
  ├─ 白名单包含危险后缀 → 漏洞
  └─ 无白名单 → 漏洞

Step 4: 内容校验检查
  ├─ ImageIO.read/isValidImage？ → 安全
  └─ 无内容校验 → 风险-B

Step 5: 路径规范化检查
  ├─ normalize + startsWith(baseDir)？ → 继续
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
| 仅后缀名校验 | 漏洞 | 风险-B |
| UUID+硬编码安全后缀 | 漏洞 | 安全 |
| 严格白名单+ImageIO.read | 漏洞 | 安全 |

### 2.4 总结判定表

| 检查项 | 结论 |
|--------|------|
| UUID+硬编码安全后缀 / 严格白名单+内容校验 | 安全 |
| 直接使用原始文件名 / 白名单含危险后缀 | 漏洞 |
| 仅后缀名/Content-Type 校验 | 风险-B |
| 内部方法无 HTTP 入口 | 风险-A |

---

## 3. 常见漏洞/风险场景

### 场景1：无校验直接保存

```java
String filename = file.getOriginalFilename();
file.transferTo(new File("/uploads/" + filename));  // 漏洞：路径遍历 + 任意文件
```

### 场景2：白名单包含危险后缀

```java
private static final String[] ALLOWED = {"jpg", "png", "jsp", "html"};  // 漏洞
```

### 场景3：仅 Content-Type 校验

```java
if (file.getContentType().startsWith("image/")) { ... }  // 漏洞：客户端可伪造
```

### 场景4：富文本编辑器图片上传（高风险）

```java
// UEditor 危险配置
"imageAllowFiles": [".png", ".jpg", ".gif", ".svg"],  // svg 是危险后缀
"filePathFormat": "/upload/{filename}.{suffix}"       // 保留原始文件名
```

| 场景 | 判定 |
|------|------|
| 白名单含 `svg`/`html` | **漏洞（存储型 XSS）** |
| 白名单仅 `jpg/png/gif` + 后端白名单校验 | 安全 |
| 保留原始文件名 + 无白名单 | **漏洞** |

安全配置：

```java
private static final Set<String> ALLOWED = Set.of("jpg", "png", "gif", "jpeg");
String ext = FilenameUtils.getExtension(upfile.getOriginalFilename()).toLowerCase();
if (!ALLOWED.contains(ext)) throw new IllegalArgumentException("invalid");
String filename = UUID.randomUUID() + "." + ext;
```

### 场景5：路径遍历导致任意文件写入

```java
String filename = file.getOriginalFilename();  // 用户可控：../../etc/passwd
file.transferTo(new File(uploadDir, filename));  // 写入到 /etc/passwd
```

| 场景 | 判定 |
|------|------|
| 原始文件名直接使用 + 无路径规范化 | **漏洞** |
| `filename.contains("..")` 检查 | **风险-B**（URL 编码绕过） |
| `normalize() + startsWith(baseDir)` | 安全 |
| UUID 重命名 | 安全 |

安全模式：

```java
Path uploadPath = Paths.get(uploadDir).normalize();
Path targetPath = uploadPath.resolve(filename).normalize();
if (!targetPath.startsWith(uploadPath)) throw new SecurityException("Invalid path");
file.transferTo(targetPath.toFile());
```

### 场景6：竞争条件（TOCTOU）

```java
// 危险：先检查后使用
if (!target.exists()) {  // 检查点
    file.transferTo(target);  // 攻击窗口中可覆盖
}

// 危险：临时文件 + 校验
File temp = File.createTempFile("upload", ".tmp");
file.transferTo(temp);  // 先写入磁盘
if (!isValidContent(temp)) { temp.delete(); throw ...; }  // 校验期间文件可被替换
```

| 场景 | 判定 |
|------|------|
| `exists()` 检查 + 后续写入 | **风险-B** |
| 临时文件 + 校验 + 移动 | **风险-B** |
| 原子操作（`Files.write` + UUID） | 安全 |
| 内存校验 + 写入 | 安全 |

### 场景7：仅后缀名校验

```java
if (ALLOWED.contains(extension)) { file.transferTo(...); }  // 风险-B
```

### 场景8：内部方法无入口

```java
private void saveFile(MultipartFile file) { ... }  // 风险-A：需追踪调用方
```

---

## 4. 常见防御模式

### UUID 重命名 + 硬编码后缀

```java
String filename = UUID.randomUUID() + ".jpg";
```

### 严格白名单 + 内容校验

```java
if (!ALLOWED.contains(extension)) throw ...;
BufferedImage image = ImageIO.read(file.getInputStream());
if (image == null) throw ...;
String filename = UUID.randomUUID() + "." + extension;
```

### 路径规范化

```java
Path targetPath = Paths.get(uploadDir).resolve(filename).normalize();
if (!targetPath.startsWith(Paths.get(uploadDir))) throw ...;
```

### 上传目录配置安全

| 配置项 | 安全配置 | 危险配置 |
|--------|----------|----------|
| Nginx | 禁止上传目录执行脚本 | 无脚本执行限制 |
| Apache | `SetHandler default-handler` | 允许执行 |
| Tomcat | `readonly=true` | `readonly=false` |
| Spring Boot | 上传目录不在 static/public 下 | 在静态资源目录 |

---

## 5. 检索技巧

> HTTP 入口可达性检索：详见 [Java 通用检索技巧](java-common-retrieval.md#http-入口可达性检索)

| 类型 | 关键词 |
|------|--------|
| 文件上传 | `MultipartFile`, `transferTo`, `getOriginalFilename` |
| 对象存储 | `BlobStore`, `BS3Client`, `putObject` |
| 校验函数 | `FileUploadChecker`, `ALLOWED_EXTENSIONS`, `ImageIO.read` |

```bash
# 文件上传接口
grep -rn "MultipartFile\|transferTo\|getOriginalFilename" --include="*.java"

# 文件类型校验
grep -rn "FileUploadChecker\|ALLOWED_EXTENSIONS\|ImageIO.read" --include="*.java"

# 对象存储上传
grep -rn "BlobStore\|BS3Client\|putObject" --include="*.java"
```

### 受管控组件（公司特定）

| 组件 | 受管控方法 | 不受管控方法 |
|------|-----------|------------|
| UploaderSdk | `issueTokenV4()` | `issueTokenV2()` / `issueTokenV3()` / `batchIssueTokenV2()` / `batchIssueTokenV3()` |
| SecureBlobClient | `put()` | — |
| BS3Client | `putObject(PutObjectRequest, RequestInfo)` | 不带 RequestInfo 的重载 |

---

## 6. 常见误判场景

### 陷阱1：校验函数名误导

**错误**: 看到 `checkFile(file)` 就认为安全
**正确**: 必须读取函数实现，确认实际校验逻辑和阻断机制

### 陷阱2：UUID 重命名忽略后缀检查

**错误**: UUID 文件名 = 安全
**正确**: 后缀若来自用户输入（`UUID + "." + getExtension()`），仍需白名单

### 陷阱3：Content-Type 误判

**错误**: Content-Type 校验可防止恶意文件
**正确**: Content-Type 由请求头指定，客户端可伪造

### 陷阱4：双重扩展名误判

**错误**: `endsWith(".png")` 允许 `evil.html.png` 是安全漏洞

**正确**: 服务端按 `.png` 设 `Content-Type: image/png`，浏览器按图片处理，不是漏洞

### 陷阱5：配置获取失败导致校验跳过

```java
Set<String> allowed = kconf.getSet("file.allowed");
if (allowed == null || allowed.isEmpty()) {
    return true; // 危险：配置不可用时直接放行
}
```

**错误**: Kconf 是可信数据源 → 安全
**正确**: 需检查「获取失败」时的分支，fail-open → **漏洞**

### 陷阱6：校验参数与实际使用参数不一致

```java
String ext = FilenameUtils.getExtension(file.getOriginalFilename());
if (!ALLOWED.contains(ext)) throw ...;
// ⚠️ 但保存时使用了另一个参数 fileName
Path target = Paths.get(uploadDir, fileName);
file.transferTo(target);
```

**错误**: 有白名单 → 安全
**正确**: 校验对象（`originalFilename`）≠ 使用对象（`fileName`）→ **漏洞**

检查要点：找到校验代码记录被校验变量名，找到 sink 点记录使用变量名，**两个变量名必须一致**。

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
- [ ] CDN MIME Sniffing 风险已识别（UUID 无后缀场景）
- [ ] 结论与证据一致，代码行号可追溯
- [ ] 校验函数已读取实现，非仅看函数名
- [ ] 校验参数与使用参数一致

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**
