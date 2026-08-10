# 路径遍历

## 0. 黄金法则

> **漏洞存在性判断 优先于 防护有效性判断**
>
> 不拼接文件路径 = 无 路径遍历（这是漏洞本质判断，不是防护有效判断）
>
> 满足此条件时：立即终止分析，无需检查任何防护措施。

**强制执行顺序**：
1. **首先**：找到 sink 点文件操作代码（如 `os.Open()`, `http.ServeFile()`）
2. **然后**：分析用户输入是否拼接进文件路径
3. **仅当** 路径拼接时，才继续检查防护措施
4. **禁止**：一上来就检查"有没有 Clean"、"A 有 B 没有"

---

## 1. 结论判断标准

| 结论 | 定义 | 判定条件 |
|------|------|----------|
| **漏洞** | 用户输入可到达文件操作点，路径用户可控且无有效防护 | 文件操作 + 路径拼接 + HTTP 入口可达 + 无有效防护 |
| **风险-A** | 文件操作存在但无 HTTP/gRPC 入口可达 | 文件操作 + 无外部入口 |
| **风险-B** | 文件操作有入口可达，但防护不充分 | 文件操作 + HTTP 入口 + 弱防护（仅 filepath.Join 无前缀验证） |
| **安全** | 无危险写法，或有充分防护 | 类型约束/filepath.Base/路径规范化+前缀验证/白名单 |

---

## 2. 研判思路

### 2.1 Sink 点与 filepath.Join 核心误报（第一优先级）

| Sink 点 | 危险级别 |
|---------|----------|
| `os.Open(path)` / `os.ReadFile(path)` | 高 |
| `http.ServeFile(w, r, path)` | 高 |
| `filepath.Join(base, userInput)`（需配合验证） | 高 |
| `archive/zip` 解压（Zip Slip 风险） | 高 |

**`filepath.Join` 不能防止路径遍历**：

```go
// 危险：filepath.Join 不能防止路径穿越
path := filepath.Join("/uploads", userFilename)
os.Open(path)
// 若 userFilename = "../../etc/passwd" → /etc/passwd

// 安全：规范化 + 前缀验证
cleanPath := filepath.Clean(filepath.Join("/uploads", userFilename))
if !strings.HasPrefix(cleanPath, "/uploads/") {
    return errors.New("Invalid path")
}
```

### 2.2 研判流程

```
Step 1: 类型约束检查 【终止点】
  ├─ int/uint 类型？ → 安全（终止）
  └─ String 类型 → 继续

Step 2: filepath.Base 检查 【终止点】
  ├─ 仅文件名（filepath.Base()）？ → 安全（终止）
  └─ 完整路径 → 继续

Step 3: 路径规范化+前缀验证 【终止点】
  ├─ filepath.Clean() + strings.HasPrefix() 验证？ → 安全（终止）
  ├─ 仅 filepath.Join() 无验证？ → 风险-B
  ├─ 自定义路径验证函数（validate_safe_path / validate_safe_file_path / sanitizePath 等）？
  │   → 必须读取函数实现
  │   ├─ 实现含 Clean + 前缀验证 + return/throw 拦截 → 安全（终止）
  │   └─ 实现仅做黑名单过滤 → 风险-B
  └─ 无验证 → 继续

Step 4: 白名单检查 【终止点】
  ├─ 严格白名单？ → 安全（终止）
  └─ 无白名单 → 继续

Step 5: Zip Slip 检查
  ├─ Zip 解压无路径验证？ → 漏洞
  └─ 非 Zip 场景 → 继续

Step 6: HTTP 入口可达性 【终止点】
  ├─ 无 HTTP/gRPC 入口？ → 风险-A
  └─ 有 HTTP/gRPC 入口 → 漏洞
```

### 2.3 降级条件表

| 条件 | 原结论 | 降级后 |
|------|--------|--------|
| int/uint 类型约束 | 漏洞 | 安全 |
| filepath.Base() 仅文件名 | 漏洞 | 安全 |
| filepath.Clean() + 前缀验证 | 漏洞 | 安全 |
| 白名单校验 | 漏洞 | 安全 |
| 非线上环境 | 漏洞 | 安全 |
| 仅 filepath.Join() 无验证 | 漏洞 | 风险-B |
| 无 HTTP 入口可达 | 漏洞 | 风险-A |

### 2.4 总结判定表

| 检查项 | 结论 |
|--------|------|
| 类型约束 / filepath.Base / 非用户输入 | 安全 |
| filepath.Clean + 前缀验证 / 白名单 | 安全 |
| 路径拼接 + 无防护 + HTTP 入口 | 漏洞 |
| Zip 解压 + 无路径验证 | 漏洞 |
| filepath.Join 无前缀验证 | 风险-B |
| 无 HTTP/gRPC 入口 | 风险-A |

---

## 3. 常见漏洞/风险场景

### 漏洞

```go
// 直接拼接
path := "/var/app/files/" + file
http.ServeFile(w, r, path)  // 漏洞

// filepath.Join 无验证
path := filepath.Join("/var/app/files", file)
http.ServeFile(w, r, path)  // 漏洞

// Zip Slip
reader, _ := zip.OpenReader(zipPath)
for _, f := range reader.File {
    path := filepath.Join(outputDir, f.Name)
    extractFile(f, path)  // 漏洞：Zip 文件名可含 ../../
}
```

### 风险-B（防护不足）

```go
// 仅 filepath.Join 无前缀验证
path := filepath.Join("/var/app/files", file)
http.ServeFile(w, r, path)  // 风险-B

// 仅 filepath.Clean 无前缀验证
path := filepath.Clean(filepath.Join("/var/app/files", file))
http.ServeFile(w, r, path)  // 风险-B
```

---

## 4. 常见防御模式

### 路径规范化 + 前缀验证

```go
path := filepath.Join(baseDir, userInput)
cleanPath := filepath.Clean(path)
if !strings.HasPrefix(cleanPath, baseDir) {
    return errors.New("Invalid path")
}
```

### filepath.Base 仅文件名

```go
filename := filepath.Base(userInput)
path := filepath.Join(baseDir, filename)
```

### 白名单 / 类型约束 / Zip Slip 验证

```go
// 白名单
allowedFiles := map[string]bool{"config.json": true}
if !allowedFiles[file] { return errors.New("Invalid") }

// 类型约束
fileID, _ := strconv.Atoi(r.URL.Query().Get("id"))
path := fmt.Sprintf("/var/app/files/%d.json", fileID)

// Zip Slip 验证
for _, f := range reader.File {
    path := filepath.Join(outputDir, f.Name)
    cleanPath := filepath.Clean(path)
    if !strings.HasPrefix(cleanPath, outputDir) {
        return errors.New("Zip slip detected")
    }
}
```

### 文件扩展名白名单（目录遍历场景有效防护）

当目录遍历受限于特定文件扩展名时，如果服务器敏感文件不匹配该扩展名，实际攻击价值为零。

```go
// 安全：严格限制可读文件后缀
filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
    if !strings.HasSuffix(path, ".pdf") {
        return nil
    }
    // 仅处理 .pdf 文件
    return nil
})
// 服务器敏感文件（/etc/passwd、密钥文件、配置文件）不以 .pdf 结尾
// → 实际攻击价值为零 → 安全
```

**判定条件**：
- 文件后缀白名单（白名单，非黑名单）
- 服务器敏感文件不匹配该后缀（.pdf/.jpg/.png 等非敏感格式）
- → 判定为安全

### 固定文件名 + 固定内容来源

当文件名硬编码、内容来自固定来源时，即使目录路径可控，实际危害极低。

```go
// 安全：文件名硬编码 + 内容来自固定 API
filePath := filepath.Join(saveDir, "encryptFriendId.pdf")
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

```go
// 安全：用户输入 + 硬编码安全后缀
fileName := taskId + ".json"  // 后缀 .json 硬编码
filePath := filepath.Join(baseDir, fileName)
// 用户只能控制文件名前缀，无法改变文件类型

// 安全：硬编码前后缀
fileName := fmt.Sprintf("report_%s.txt", userId)

// 安全：格式化固定后缀
fileName := fmt.Sprintf("data_%s.csv", date)
```

**安全后缀列表**：`.json` / `.txt` / `.csv` / `.md` / `.pdf` / `.log`

**前置条件**：用户输入部分不含路径分隔符（`/`、`\`、`..`），典型场景为纯 ID（数字/UUID/字母数字标识符）。

**判定规则**：
- 用户输入为纯 ID + 硬编码安全后缀，且后缀不可被用户覆盖 → **safe**
- sink 参数完全由硬编码常量组成 → **safe**
- 用户输入可能包含路径分隔符（如自由文本） + 硬编码后缀 → **需继续分析**（后缀不防路径遍历）

---

## 5. 检索技巧

### 搜索关键词

| 类型 | 关键词 |
|------|--------|
| 文件操作 | `os.Open`, `os.ReadFile`, `http.ServeFile` |
| 路径操作 | `filepath.Join`, `filepath.Clean`, `filepath.Base` |
| Zip 操作 | `archive/zip`, `zip.OpenReader` |

### 检测命令

```bash
# 检测文件操作
grep -rn "os\.Open\|os\.ReadFile\|http\.ServeFile" --include="*.go"

# 检测路径拼接
grep -rn "filepath\.Join" --include="*.go"

# 检测 Zip 解压
grep -rn "archive/zip\|zip\.OpenReader" --include="*.go"
```

---

## 6. 常见误判场景

### 陷阱1：filepath.Join 误判为安全

**错误**: 认为 `filepath.Join` 能防止路径遍历
**正确**: `filepath.Join("/uploads", "../../etc/passwd")` = `/etc/passwd`，不会验证最终路径 → 漏洞

### 陷阱2：仅 filepath.Clean 误判

**错误**: 认为 `filepath.Clean()` 足够安全
**正确**: `filepath.Clean()` 可以解析 `../` 但不验证结果，必须配合 `strings.HasPrefix()` 验证

### 陷阱3：filepath.Base 二次拼接误判

**错误**: 认为使用了 `filepath.Base()` 就安全
**正确**: 需检查完整数据流，中间二次拼接可能引入新的 `../`

### 陷阱4：先看防护，后看漏洞本质

**错误思路**：发现代码缺少 filepath.Clean → A 有 B 没有 → 判定风险
**正确思路**：先判断漏洞是否存在（类型约束/配置来源 → 无路径遍历）

> 漏洞存在性判断 > 防护有效性判断。不拼接文件路径 = 无路径遍历。

### 陷阱5：被代码对比干扰

**错误判定**：A 有 filepath.Clean B 没有 → B 有风险
**正确判定**：先看 B 漏洞是否存在（是否拼接路径），再谈防护

> 代码不一致 ≠ 安全问题。

### 陷阱6：拦截型校验后使用原始变量误判

**错误**：sink 使用原始 filePath 而非 validate 返回的 safePath → 漏洞
**正确**：validate 校验失败即 return → 能到达 sink 的数据已通过校验 → 安全

```go
safePath, err := validateFilePath(filePath, allowedDir)
if err != nil {
    return err  // 校验失败 → 中断
}
// 只有校验通过才能到达这里
os.Open(filePath)  // 使用原始变量，但已通过校验 → 安全
```

**关键**：判断 sink 使用原始变量是否安全，取决于校验函数是"拦截型"（失败即中断）还是"净化型"（返回安全值）。拦截型校验通过后，原始变量与返回值同样安全。

---

## 7. 特殊风险

### Symlink 攻击

攻击者通过创建符号链接使 `filepath.Join`/`path.resolve` 结果指向预期外位置。防御：`os.Lstat()` 检测符号链接，或在 chroot 环境中操作。

### ioutil.ReadFile 已弃用

`ioutil.ReadFile` 在 Go 1.16 后被标记为弃用（应使用 `os.ReadFile`），但线上仍有大量使用。搜索时需同时覆盖 `ioutil.ReadFile` 和 `os.ReadFile`。

---

## 8. 变更影响分析

| 变更类型 | 变更内容 | 风险 |
|----------|----------|------|
| 新增 | 新增文件操作 / filepath.Join | 确认路径验证 |
| 新增 | 新增 Zip 解压功能 | 路径验证 |
| 修改 | 移除 HasPrefix / Clean | 移除防护 |
| 修改 | 从 filepath.Base 改为 filepath.Join | 引入穿越风险 |
| 删除 | 删除白名单 / 前缀验证 | 移除防护 |

---

## 9. 质量门禁（强制执行）

在输出审计结论前，按顺序验证：

- [ ] 强制执行顺序已遵守（先检查路径拼接分析）
- [ ] filepath.Join 不等于安全防护已确认
- [ ] filepath.Clean 是否配合 HasPrefix 已确认
- [ ] HTTP 入口可达性已确认，非假设
- [ ] 结论与证据一致，代码行号可追溯
- [ ] 不因代码对比而判定风险

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**
