# 路径遍历

## 0. 黄金法则

> **漏洞存在性判断 优先于 防护有效性判断**
>
> 不拼接文件路径 = 无 路径遍历（这是漏洞本质判断，不是防护有效判断）
>
> 满足此条件时：立即终止分析，无需检查任何防护措施。

**强制执行顺序**：
1. **首先**：找到 sink 点文件操作代码（如 `fs.readFile()`, `res.sendFile()`, `path.join()`）
2. **然后**：分析用户输入是否拼接进文件路径
3. **仅当** 路径拼接时，才继续检查防护措施
4. **禁止**：一上来就检查"有没有 normalize"、"A 有 B 没有"

---

## 1. 结论判断标准

| 结论 | 定义 | 判定条件 |
|------|------|----------|
| **漏洞** | 用户输入可到达文件操作，路径可控且无有效防护 | 路径拼接 + 用户可控 + HTTP 入口可达 + 无有效防护 |
| **风险-A** | 危险文件操作但无 HTTP 入口可达 | 路径拼接 + 无外部入口 |
| **风险-B** | 文件操作有入口可达，但防护不充分 | 路径拼接 + HTTP 入口 + 弱防护（仅黑名单） |
| **安全** | 无危险写法，或有充分防护 | 常量路径/path.resolve+startsWith/path.basename/UUID/白名单 |

---

## 2. 研判思路

### 2.1 Sink 点与 path.join 核心误报（第一优先级）

| Sink 点 | 危险级别 |
|---------|----------|
| `fs.readFile(base + userInput)` | 高 |
| `fs.writeFile(base + userInput)` | 高 |
| `res.sendFile(base + userInput)` | 高 |
| `path.join(base, userInput)`（需配合验证） | 高 |
| `path.resolve(base, userInput)`（需配合验证） | 高 |
| `require(userInput)` / `import(userInput)` | 极高 |

**`path.join` 不能防止路径遍历**：

```javascript
// 危险：path.join 不阻止路径穿越
path.join(__dirname, 'uploads', '../../../etc/passwd')
// 结果指向 /etc/passwd

// 安全：path.resolve + startsWith
const baseDir = path.resolve(__dirname, 'uploads');
const filepath = path.resolve(baseDir, userInput);
if (!filepath.startsWith(baseDir)) throw new Error('Invalid');
```

### 2.2 研判流程

```
Step 1: 路径来源检查 【终止点】
  ├─ 常量/配置/硬编码？ → 安全（终止）
  └─ 用户输入 → 继续

Step 2: 路径规范化+前缀检查 【终止点】
  ├─ path.resolve() + startsWith() 验证？ → 安全（终止）
  ├─ 自定义路径验证函数（validate_safe_path / validate_safe_file_path / sanitizePath 等）？
  │   → 必须读取函数实现
  │   ├─ 实现含 resolve + 前缀验证 + return/throw 拦截 → 安全（终止）
  │   └─ 实现仅做黑名单过滤 → 风险-B
  └─ 无验证 → 继续

Step 3: path.basename / UUID / 白名单 【终止点】
  ├─ path.basename 移除路径？ → 安全（终止）
  ├─ UUID 重命名？ → 安全（终止）
  ├─ 白名单文件列表？ → 安全（终止）
  └─ 无 → 继续

Step 4: 防护强度检查
  ├─ 黑名单过滤（可被 URL 编码绕过）？ → 风险-B
  └─ 无防护 → 继续

Step 5: HTTP 入口可达性 【终止点】
  ├─ 无 HTTP 入口？ → 风险-A
  └─ 有 HTTP 入口 → 漏洞
```

### 2.3 降级条件表

| 条件 | 原结论 | 降级后 |
|------|--------|--------|
| 常量路径 / 配置来源 | 漏洞 | 安全 |
| path.resolve + startsWith | 漏洞 | 安全 |
| path.basename / UUID 重命名 | 漏洞 | 安全 |
| 白名单文件列表 | 漏洞 | 安全 |
| 非线上环境 | 漏洞 | 安全 |
| 黑名单过滤（可绕过） | 漏洞 | 风险-B |
| 无 HTTP 入口可达 | 漏洞 | 风险-A |

### 2.4 总结判定表

| 检查项 | 结论 |
|--------|------|
| 常量路径 / 非用户输入 | 安全 |
| path.resolve + startsWith / path.basename / UUID / 白名单 | 安全 |
| 路径拼接 + 无防护 + HTTP 入口 | 漏洞 |
| 路径拼接 + 黑名单过滤 | 风险-B |
| 无 HTTP 入口 | 风险-A |

---

## 3. 常见漏洞/风险场景

### 漏洞

```javascript
// fs.readFile 直接拼接
fs.readFile('./uploads/' + req.query.name, 'utf-8');  // 漏洞

// res.sendFile 直接拼接
res.sendFile(__dirname + '/uploads/' + req.params.file);  // 漏洞

// path.join 无验证
path.join(__dirname, 'public', req.query.file);  // 漏洞

// 黑名单可绕过
let filename = req.query.name.replace(/\.\.\//g, '');
fs.readFile('./uploads/' + filename, 'utf-8');  // 漏洞（%2e%2e%2f 绕过）

// 动态导入
require(req.query.module);  // 极高危
```

### 风险-B（防护不足）

```javascript
// 黑名单替换
const filename = req.query.name.replace('../', '').replace('..\\', '');
fs.readFile('./uploads/' + filename, 'utf-8');  // 风险-B
```

---

## 4. 常见防御模式

### path.resolve + startsWith

```javascript
const baseDir = path.resolve(__dirname, 'uploads');
const filepath = path.resolve(baseDir, req.query.file);
if (!filepath.startsWith(baseDir)) {
    throw new Error('Path traversal detected');
}
res.sendFile(filepath);
```

### path.basename / UUID / 白名单

```javascript
// path.basename 移除路径
const filename = path.basename(req.query.file);
res.sendFile(path.join(__dirname, 'files', filename));

// UUID 重命名
const safeName = uuidv4() + path.extname(req.file.originalname);

// 白名单文件
const ALLOWED_FILES = ['profile.pdf', 'logo.png'];
if (!ALLOWED_FILES.includes(filename)) throw new Error('Not allowed');

// 白名单扩展名 + basename
const ALLOWED_EXTS = ['.jpg', '.png', '.pdf'];
const ext = path.extname(filename).toLowerCase();
if (!ALLOWED_EXTS.includes(ext)) throw new Error('Invalid type');
const safeName = path.basename(filename);
```

### 文件扩展名白名单（目录遍历场景有效防护）

当目录遍历受限于特定文件扩展名时，如果服务器敏感文件不匹配该扩展名，实际攻击价值为零。

```javascript
// 安全：严格限制可读文件后缀
const files = fs.readdirSync(dir).filter(f => f.endsWith('.pdf'));
// 服务器敏感文件（/etc/passwd、密钥文件、配置文件）不以 .pdf 结尾
// → 实际攻击价值为零 → 安全
```

**判定条件**：
- 文件后缀白名单（白名单，非黑名单）
- 服务器敏感文件不匹配该后缀（.pdf/.jpg/.png 等非敏感格式）
- → 判定为安全

### 固定文件名 + 固定内容来源

当文件名硬编码、内容来自固定来源时，即使目录路径可控，实际危害极低。

```javascript
// 安全：文件名硬编码 + 内容来自固定 API
const filePath = path.join(saveDir, 'encryptFriendId.pdf');
// saveDir 虽可控但：
// 1. 文件名 encryptFriendId.pdf 硬编码（不可控）
// 2. 内容来自固定远程 API（非用户上传）
// → 实际危害极低 → 安全
```

**判定条件**：
- 文件名硬编码（用户不可控）
- 文件内容来自固定/已知来源
- → 判定为安全

#### 用户输入 + 硬编码后缀

当文件名由用户输入与硬编码后缀拼接时，后缀固定限制了文件类型，用户无法通过路径遍历读取任意类型文件。

```javascript
// 安全：用户输入 + 硬编码安全后缀
const fileName = `${taskId}.json`;  // 后缀 .json 硬编码
const filePath = path.join(baseDir, fileName);
// 用户只能控制文件名前缀，无法改变文件类型

// 安全：硬编码前后缀
const fileName = `report_${userId}.txt`;

// 安全：格式化固定后缀
const fileName = `data_${date}.csv`;
```

**安全后缀列表**：`.json` / `.txt` / `.csv` / `.md` / `.pdf` / `.log`

**前置条件**：用户输入部分不含路径分隔符（`/`、`\`、`..`），典型场景为纯 ID（数字/UUID/字母数字标识符）。

**判定规则**：
- 用户输入为纯 ID + 硬编码安全后缀，且后缀不可被用户覆盖 → **safe**
- sink 参数完全由硬编码常量组成 → **safe**
- 用户输入可能包含路径分隔符（如自由文本） + 硬编码后缀 → **需继续分析**（后缀不防路径遍历）

---

## 5. 检索技巧

> HTTP 入口可达性检索：详见 [JavaScript 通用检索技巧](javascript-common-retrieval.md#http-入口可达性检索)

### 搜索关键词

| 类型 | 关键词 |
|------|--------|
| fs 模块 | `fs.readFile`, `fs.writeFile`, `fs.unlink` |
| path 模块 | `path.join`, `path.resolve`, `path.normalize` |
| Express | `res.sendFile`, `res.download` |
| 动态导入 | `require(userInput)`, `import(userInput)` |

### 检测命令

```bash
# 检测文件操作
grep -rn "fs\.readFile\|fs\.writeFile\|fs\.unlink" --include="*.js"

# 检测 res.sendFile
grep -rn "res\.sendFile\|res\.download" --include="*.js"

# 检测路径拼接
grep -rn "path\.join.*req\.\|path\.resolve.*req\." --include="*.js"
```

---

## 6. 常见误判场景

### 陷阱1：path.basename 误判

**错误**: 看到用户输入就判为路径遍历
**正确**: 使用 `path.basename` 移除路径部分 → 安全

### 陷阱2：path.resolve 无 startsWith 误判

**错误**: 认为 `path.resolve()` 自动防止穿越
**正确**: `path.resolve()` 只规范化路径，不验证是否在基础目录内，必须配合 `startsWith()`

### 陷阱3：黑名单过滤误判

**错误**: 认为 `replace('../', '')` 有效
**正确**: 可被 URL 编码（`%2e%2e%2f`）或双重编码（`%252e%252e%252f`）绕过

### 陷阱4：先看防护，后看漏洞本质

**错误思路**：发现代码缺少 normalize → A 有 B 没有 → 判定风险
**正确思路**：先判断漏洞是否存在（路径来源是常量 → 无路径遍历）

> 漏洞存在性判断 > 防护有效性判断。不拼接文件路径 = 无路径遍历。

### 陷阱5：被代码对比干扰

**错误判定**：A 有路径校验 B 没有 → B 有风险
**正确判定**：先看 B 漏洞是否存在（是否拼接路径），再谈防护

> 代码不一致 ≠ 安全问题。

### 陷阱6：拦截型校验后使用原始变量误判

**错误**：sink 使用原始 filePath 而非 validate 返回的 safePath → 漏洞
**正确**：validate 校验失败即 return/throw → 能到达 sink 的数据已通过校验 → 安全

```javascript
const safePath = validateFilePath(filePath, allowedDir);
if (!safePath) {
    return res.status(400).json({ error: 'unsafe path' });  // 校验失败 → 中断
}
// 只有校验通过才能到达这里
fs.readFileSync(filePath, 'utf-8');  // 使用原始变量，但已通过校验 → 安全
```

**关键**：判断 sink 使用原始变量是否安全，取决于校验函数是"拦截型"（失败即中断）还是"净化型"（返回安全值）。拦截型校验通过后，原始变量与返回值同样安全。

---

## 7. 特殊风险

### Symlink 攻击

攻击者通过创建符号链接使 `filepath.Join`/`path.resolve` 结果指向预期外位置。防御：`os.Lstat()` 检测符号链接，或在 chroot 环境中操作。

### Zip Slip（Node.js）

解压 ZIP 文件时 `entry.fileName` 可能包含 `../../` 路径。使用 `yauzl`/`adm-zip` 等库解压前必须验证每个 entry 的目标路径：
```javascript
const targetPath = path.resolve(outputDir, entry.fileName);
if (!targetPath.startsWith(path.resolve(outputDir))) throw new Error('Path traversal');
```

---

## 8. 变更影响分析

| 变更类型 | 变更内容 | 风险 |
|----------|----------|------|
| 新增 | 新增 fs.readFile / res.sendFile 调用 | 确认路径拼接方式 |
| 新增 | 新增 path.join 拼接 | 验证措施 |
| 修改 | 移白名单 / 路径验证 | 移除防护 |
| 修改 | 添加 path.resolve + startsWith | 从危险变为安全 |
| 删除 | 删除路径验证 / basename 限制 | 移除防护 |

---

## 9. 质量门禁（强制执行）

在输出审计结论前，按顺序验证：

- [ ] 强制执行顺序已遵守（先检查路径拼接分析）
- [ ] path.join / path.resolve 不等于安全防护已确认
- [ ] path.resolve 是否配合 startsWith 已确认
- [ ] HTTP 入口可达性已确认，非假设
- [ ] 结论与证据一致，代码行号可追溯
- [ ] 不因代码对比而判定风险

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**
