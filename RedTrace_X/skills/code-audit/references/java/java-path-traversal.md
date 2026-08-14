# 路径遍历

## 0. 黄金法则

> **漏洞存在性判断 优先于 防护有效性判断**
>
> 不拼接文件路径 = 无路径遍历（这是漏洞本质判断，不是防护有效判断）
>
> 硬编码非敏感后缀 + 写入内容为固定结构对象 = 无实际危害（写入场景的本质判断）
>
> 满足上述任一条件时：立即终止分析，无需检查任何防护措施。

**强制执行顺序**：
1. **首先**：找到 sink 点文件操作代码（如 `new File(path)`, `Paths.get(path)`）
2. **然后**：分析用户输入是否拼接进文件路径
3. **仅当** 路径拼接时，才继续检查防护措施
4. **禁止**：一上来就检查"有没有 normalize"、"A 有 B 没有"

---

## 1. 结论判断标准

| 结论 | 定义 | 判定条件 |
|------|------|----------|
| **漏洞** | 用户输入可到达文件操作点，路径用户可控且无有效防护 | 文件操作 + 路径拼接 + HTTP 入口可达 + 无有效防护 |
| **风险-A** | 文件操作存在但无 HTTP/gRPC 入口可达 | 文件操作 + 无外部入口 |
| **风险-B** | 文件操作有入口可达，但防护不充分 | 文件操作 + HTTP 入口 + 弱防护（仅 normalize/黑名单） |
| **安全** | 无危险写法，或有充分防护 | 类型约束/白名单/UUID 重命名/路径规范化+前缀验证/数据库中间来源 |

---

## 2. 研判思路

### 2.1 Sink 点列表（第一优先级）

| 类别 | Sink 点 | 危险级别 |
|------|---------|----------|
| 文件构造 | `new File(userPath)`, `Paths.get(userPath)`, `Path.of(userPath)` | 高 |
| 文件读取 | `FileInputStream(userPath)`, `Files.readAllBytes()`, `Files.readString()`, `FileReader(userPath)` | 高 |
| 文件写入 | `FileOutputStream(userPath)`, `Files.copy()`, `Files.move()`, `FileWriter(userPath)` | 高 |
| NIO 操作 | `Files.delete()`, `Files.createFile()` | 高 |
| Zip 解压 | `ZipInputStream` + `entry.getName()`（Zip Slip 风险） | 高 |
| Commons IO | `FileUtils.readFileToByteArray()`, `FileUtils.copyFile()` | 高 |

找到 sink 点后，判断用户输入是否拼接进路径。

### 2.2 研判流程

```
Step 1: 输入类型检查 【终止点】
  ├─ int/long/Integer/Long/boolean/Enum？ → 安全（终止）
  └─ String 类型 → 继续

Step 1.5: 输入格式约束检查 【终止点】
  ├─ 格式约束排除路径分隔符？ → 安全（终止）
  └─ 无约束或约束不充分 → 继续

Step 1.6: 数据来源追溯 【终止点】
  ├─ 系统生成 UUID/随机 ID？ → 安全（终止）
  └─ 用户可控 → 继续

Step 2: gRPC / 数据库中间来源 【终止点】
  ├─ userId/sellerId 等网关注入字段？ → 安全（终止）
  ├─ 路径来自 mapper.select/redis.get？ → 安全（终止）
  └─ 用户直接输入 → 继续

Step 3: 路径规范化+前缀验证 【终止点】
  ├─ normalize/getCanonicalPath + startsWith 验证？ → 安全（终止）
  ├─ 自定义路径验证函数（validate_safe_path / validate_safe_file_path / sanitizePath 等）？
  │   → 必须读取函数实现
  │   ├─ 实现含 normalize + 前缀验证 + return/throw 拦截 → 安全（终止）
  │   └─ 实现仅做黑名单过滤 → 风险-B
  ├─ 查询型校验（store.get / db.query + null 检查）？
  │   ├─ 查询键为 UUID 等不可预测格式 → 安全（终止）
  │   └─ 查询键可预测但有 null 检查 + return/throw → 继续分析（键存在不代表键值安全）
  └─ 无验证 → 继续

Step 4: 白名单/枚举/UUID/路径分割 【终止点】
  ├─ 枚举值校验/严格扩展名白名单？ → 安全（终止）
  ├─ UUID/时间戳重命名？ → 安全（终止）
  ├─ split("/") 取最后元素/getFileName()？ → 安全（终止）
  └─ 无 → 继续

Step 4.5: 写入场景实际危害检查 【终止点，仅写操作适用】
  ├─ 文件后缀硬编码为非敏感格式（.json/.log/.txt 等）？
  │   ├─ 是 → 写入内容是否为固定结构对象？
  │   │     判定方法：字段类型和值由代码逻辑决定（如 Jackson ObjectMapper.writeValue 写入的 POJO，
  │   │     字段为 String taskId / Long userId 等），不含用户可控自由文本
  │   │   ├─ 是 → 无法覆盖敏感文件，无法注入恶意内容 → 安全（终止）
  │   │   └─ 否（用户可控任意内容）→ 风险-B
  │   └─ 否（后缀可覆盖 .sh/.conf/.ssh 等敏感文件）→ 继续
  └─ 文件后缀用户可控 → 继续

Step 5: 防护强度检查
  ├─ 仅 normalize 无前缀验证？ → 风险-B
  ├─ 黑名单/部分替换？ → 风险-B
  └─ 无防护 → 继续

Step 6: Zip Slip 检查
  ├─ Zip 解压无路径验证？ → 漏洞
  └─ 非 Zip 场景 → 继续

Step 7: HTTP 入口可达性 【终止点】
  ├─ 无 HTTP/gRPC 入口？ → 风险-A
  └─ 有 HTTP/gRPC 入口 → 漏洞
```

#### Step 1.5: 输入格式约束检查

**必做动作**：
1. 搜索输入参数的正则校验模式：
   ```bash
   grep -rn "Pattern.compile" --include="*.java" {相关文件目录}
   ```
2. 检查参数是否受格式约束（如 `[0-9A-z-_]+`）
3. 若格式约束排除了路径分隔符（`/`、`\`、`..`）→ 安全（终止）

**判定规则**：

| 格式约束 | 是否排除路径分隔符 | 结论 |
|----------|-------------------|------|
| `[0-9A-z-_]+` | 是（无 `/`、`\`、`.`） | safe |
| UUID 格式 | 是（无 `/`、`\`、`.`） | safe |
| `[a-zA-Z0-9]+` | 是 | safe |
| `.*`（无约束） | 否 | 继续分析 |

**真实误报案例**：

| 项目 | 告警类型 | 误判根因 | 正确判定 |
|------|---------|---------|---------|
| outlines | Absolute_Path_Traversal | 认为 fileId 是用户可控 String 可路径遍历，但忽略 cosmoId 格式约束 `[0-9A-z-_]{1,32}` 排除所有路径分隔符 | safe |

**关键代码示例**：
```java
// AgentDocOnlineServiceImpl.java:595-603
Pattern pattern = Pattern.compile("^(.+)/([kt])/home/([0-9A-z-_]{1,32})$");
// cosmoId 格式约束：仅允许字母、数字、中划线、下划线，1-32位
// 排除 /、\、. 等危险字符 → 无法路径遍历 → safe
```

#### Step 1.6: 数据来源追溯

**必做动作**：
1. 追溯 source 参数的实际来源：
   - 来自数据库查询结果？
   - 来自系统生成（UUID、cosmoId 等）？
   - 来自用户自由输入？

2. 检索命令：
   ```bash
   # 追溯参数设置来源
   grep -rn "setFileId\|setDocId\|setCosmoId" --include="*.java"

   # 检查参数来自哪个系统的返回值
   grep -rn "getCosmo\|getOnlineDoc\|queryByDocId" --include="*.java"
   ```

**判定规则**：

| 数据来源 | 可预测性 | 结论 |
|----------|---------|------|
| 系统生成 UUID | 不可预测 | safe |
| 数据库查询结果 | 取决于查询条件 | 继续分析 |
| 用户自由输入 | 完全可控 | 继续分析 |

**完整数据流分析示例**：
```
search 接口 → 返回 OutlinesSearchHitVO.docId（来自数据库查询）
           ↓
read 接口 ← 用户从 search 结果中选择 fileId
           ↓
OutlinesLocalStore.readLinesSlice(fileId)
           ↓
路径: {base}/{marioAgentId}/docs/{fileId}/content.lines.txt
```

**关键发现**：
- fileId 实际是 cosmoId（Merlot Cosmo 系统的文档ID）
- cosmoId 由 Merlot Cosmo 系统生成，非用户自由输入
- 用户只能从 search 结果中选择已有的 cosmoId

### 2.3 降级条件表

| 条件 | 原结论 | 降级后 |
|------|--------|--------|
| 类型约束（int/long/Enum） | 漏洞 | 安全 |
| 格式约束（排除路径分隔符） | 漏洞 | 安全 |
| 数据来源（系统生成 UUID/随机 ID） | 漏洞 | 安全 |
| gRPC 身份凭据 / 数据库中间来源 | 漏洞 | 安全 |
| 路径规范化 + 前缀验证 | 漏洞 | 安全 |
| 白名单 / UUID 重命名 / 路径分割 | 漏洞 | 安全 |
| 查询型校验（store.get + null 检查 + return/throw） | 漏洞 | 安全 |
| 硬编码非敏感后缀 + 写入内容为固定结构对象 | 漏洞 | 安全 |
| 参数仅用于日志 | 漏洞 | 安全 |
| 非线上环境 | 漏洞 | 安全 |
| 仅 normalize 无前缀验证 / 黑名单过滤 | 漏洞 | 风险-B |
| 无 HTTP 入口可达 | 漏洞 | 风险-A |

### 2.4 总结判定表

| 检查项 | 结论 |
|--------|------|
| 类型约束 / 格式约束 / 系统生成来源 / 数据库来源 / 仅日志使用 / 非用户输入 | 安全 |
| 路径规范化 + 前缀验证 / 白名单 / UUID 重命名 | 安全 |
| 路径拼接 + 无防护 + HTTP 入口 | 漏洞 |
| Zip 解压 + 无路径验证 | 漏洞 |
| 路径拼接 + 弱防护（仅 normalize/黑名单） | 风险-B |
| 无 HTTP/gRPC 入口 | 风险-A |

---

## 3. 常见漏洞/风险场景

### 漏洞

```java
// 直接拼接路径
String path = "/var/app/files/" + file;  // 漏洞

// Zip Slip 无验证
Files.copy(zis, new File(OUTPUT_DIR, entry.getName()).toPath());  // 漏洞

// 黑名单可绕过
if (file.contains("..")) throw ...;  // 漏洞（可被 URL 编码绕过）
```

### 风险-B（防护不足）

```java
// 仅 normalize 无前缀验证
Path path = Paths.get(BASE_DIR, file).normalize();  // 风险-B

// 部分字符替换
String safeName = file.replace("..", "").replace("/", "");  // 风险-B
```

---

## 4. 常见防御模式

### 路径规范化 + 前缀检查

```java
Path path = Paths.get(BASE_DIR, file).normalize();
if (!path.startsWith(BASE_DIR)) throw new SecurityException();  // 安全
```

### 白名单 / 枚举 / UUID 重命名 / 路径分割

```java
// 白名单
if (!ALLOWED_FILES.contains(file)) throw ...;  // 安全

// 枚举
FileType.valueOf(type);  // 安全

// UUID 重命名
UUID.randomUUID() + "." + ext;  // 安全

// 路径分割（只取文件名）
Paths.get(path).getFileName();  // 安全

// 类型约束
Long fileId → 只能是数字 → 安全
```

### 文件格式校验（辅助防护）

```java
XSSFWorkbook workbook = new XSSFWorkbook(file.getInputStream());  // 非 XLSX 抛异常
BufferedImage image = ImageIO.read(file.getInputStream());  // 非图片返回 null
```

> 注意：格式校验应作为辅助防护，不应作为唯一防护手段。

### 文件扩展名白名单（目录遍历场景有效防护）

当目录遍历受限于特定文件扩展名时，如果服务器敏感文件不匹配该扩展名，实际攻击价值为零。

```java
// 安全：严格限制可读文件后缀
File[] files = dir.listFiles((d, name) -> name.endsWith(".pdf"));
// 服务器敏感文件（/etc/passwd、密钥文件、配置文件）不以 .pdf 结尾
// → 实际攻击价值为零 → 安全
```

**判定条件**：
- 文件后缀白名单（白名单，非黑名单）
- 服务器敏感文件不匹配该后缀（.pdf/.jpg/.png 等非敏感格式）
- → 判定为安全

### 固定文件名 + 固定内容来源

当文件名硬编码、内容来自固定来源时，即使目录路径可控，实际危害极低。

```java
// 安全：文件名硬编码 + 内容来自固定 API
String filePath = saveDir + "/encryptFriendId.pdf";
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

```java
// 安全：用户输入 + 硬编码安全后缀
String fileName = taskId + ".json";  // 后缀 .json 硬编码
File file = new File(baseDir, fileName);
// 用户只能控制文件名前缀，无法改变文件类型

// 安全：硬编码前后缀
String fileName = "report_" + userId + ".txt";
// 前后缀均硬编码

// 安全：格式化固定后缀
String fileName = String.format("data_%s.csv", date);
```

**安全后缀列表**：`.json` / `.txt` / `.csv` / `.md` / `.pdf` / `.log`

**前置条件**：用户输入部分不含路径分隔符（`/`、`\`、`..`），典型场景为纯 ID（数字/UUID/字母数字标识符）。

**判定规则**：
- 用户输入为纯 ID + 硬编码安全后缀，且后缀不可被用户覆盖 → **safe**
- sink 参数完全由硬编码常量组成 → **safe**
- sink 参数通过 `Enum.valueOf()` 转换，值域受枚举限制 → **safe**
- 用户输入可能包含路径分隔符（如自由文本） + 硬编码后缀 → **需继续分析**（后缀不防路径遍历）

---

## 5. 检索技巧

> HTTP 入口可达性检索：详见 [Java 通用检索技巧](java-common-retrieval.md#http-入口可达性检索)

### 搜索关键词

| 类型 | 关键词 |
|------|--------|
| 文件操作 | `new File(`, `Paths.get(`, `FileInputStream(`, `FileOutputStream(` |
| NIO API | `Files.readAllBytes(`, `Files.readString(`, `Files.copy(` |
| Zip 解压 | `ZipInputStream`, `ZipEntry`, `entry.getName()` |
| 路径验证 | `normalize(`, `getCanonicalPath(`, `startsWith(`, `getFileName()` |

### 检测命令

```bash
# 检测文件操作
grep -rn "new File(\|Paths\.get(\|FileInputStream(" --include="*.java"

# 检测 Zip Slip
grep -rn "ZipInputStream\|ZipEntry\|entry\.getName" --include="*.java"

# 检测路径验证
grep -rn "normalize\|getCanonicalPath\|startsWith" --include="*.java"
```

---

## 6. 常见误判场景

### 陷阱1：数据流断裂误判

**错误**: 认为 tenantId 可控，进而认为 filePath 可控
**正确**: 路径来自数据库查询结果，数据流"断裂" → 安全

### 陷阱2：仅 normalize 误判

**错误**: 认为 `normalize()` 足够防护
**正确**: `normalize()` 只解析 `../`，需配合 `startsWith()` 验证

### 陷阱3：枚举值误判

**错误**: 认为 String 参数可控
**正确**: `Enum.valueOf()` 限制只能选预定义值 → 安全

### 陷阱4：先看防护，后看漏洞本质

**错误思路**：发现代码缺少 normalize → A 有 B 没有 → 判定风险
**正确思路**：先判断漏洞是否存在（类型约束/数据来源 → 无路径遍历）

> 漏洞存在性判断 > 防护有效性判断。不拼接文件路径 = 无路径遍历。

### 陷阱5：被代码对比干扰

**错误判定**：A 有路径校验 B 没有 → B 有风险
**正确判定**：先看 B 漏洞是否存在（是否拼接路径），再谈防护

> 代码不一致 ≠ 安全问题。

### 陷阱6：拦截型校验后使用原始变量误判

**错误**：sink 使用原始 filePath 而非 validate 返回的 safePath → 漏洞
**正确**：validate 校验失败即 return/throw → 能到达 sink 的数据已通过校验 → 安全

```java
String safePath = validateFilePath(filePath, allowedDir);
if (safePath == null) {
    return Response.error("unsafe path");  // 校验失败 → 中断
}
// 只有校验通过才能到达这里
new FileInputStream(filePath);  // 使用原始变量，但已通过校验 → 安全
```

**关键**：判断 sink 使用原始变量是否安全，取决于校验函数是"拦截型"（失败即中断）还是"净化型"（返回安全值）。拦截型校验通过后，原始变量与返回值同样安全。

### 陷阱7：查询型校验误判

**错误**: 认为 taskId 可控，文件路径拼接 → 漏洞
**正确**: 先查询 store.get(taskId)，不存在则 return → 控制流中断 → 安全

```java
public boolean cancelTask(String taskId) {
    CompareTask task = taskStore.get(taskId);  // 查询型校验
    if (task == null) {
        return false;  // 查询失败 → 隐式拦截
    }
    // 只有 taskId 存在于系统时才执行后续代码
    publish(taskId, ...);
}

void publish(String taskId, ...) {
    if (!eventMap.containsKey(taskId)) {
        loadFromDisk(taskId);  // 只有通过上面查询的数据流才能到达
    }
}
```

**关键判断**：
- 查询键来源：用户可控（如 @PathVariable）
- 查询键格式：系统生成（如 UUID）→ 不可预测 → 安全
- 查询失败处理：有显式 return/throw → 控制流中断 → 安全
- 查询结果使用：后续代码依赖查询结果（如 task.method()）→ NPE 风险，但控制流实际已中断

**判定流程**：
```
发现查询型校验（如 store.get(userInput)）
    │
    ├─ 检查查询键格式
    │   ├─ UUID/随机字符串 → 不可预测 → 安全
    │   ├─ 数据库自增 ID → 可预测 → 继续分析
    │   └─ 用户输入字符串 → 可预测 → 继续分析
    │
    ├─ 检查查询失败时的控制流
    │   ├─ 有显式 return/throw → 控制流中断 → 安全
    │   └─ 无显式中断，但后续代码依赖查询结果
    │       └─ 实际控制流已中断（NPE 或 null 检查）→ 安全
    │
    └─ 综合判定
        ├─ 查询键不可预测 或 控制流中断 → 安全
        └─ 查询键可预测 且 控制流未中断 → 继续研判
```

**真实误报案例**：

| 项目 | 告警类型 | 误判根因 | 正确判定 |
|------|---------|---------|---------|
| realtime-data-compare | Absolute_Path_Traversal | Agent 认为 taskId 来自 @PathVariable 可控，可到达 loadFromDisk。但忽略 taskStore.get(taskId) 查询失败时的 return 拦截，且 taskId 由 UUID 生成不可预测 | safe |

**识别方法**：
```bash
# 搜索查询型校验模式
grep -rn "\.get\s*(" --include="*.java" | grep -E "(store|cache|map|Map|db)" | head -20

# 搜索 null 检查模式
grep -rn "if\s*(" --include="*.java" | grep -E "(null|==\s*null)" | head -20
```

### 陷阱8：replace/remove 普通字符误判

`replace`/`replaceAll`/`remove` 类操作若**仅处理普通字符**（如 `logUuid.replace("-", "").replaceAll("_", "")` 移除 `-` 和 `_`），不处理路径分隔符（`/`、`\`、`..`），**不影响路径遍历漏洞判定**——攻击者仍可注入 `../`。

```java
// 不影响判定：仅移除 - 和 _，未处理路径分隔符
String id = logUuid.replace("-", "").replaceAll("_", "");
Path path = Paths.get(BASE_DIR, id + ".json");  // 仍可被 ../ 穿越

// 对照（见 3. 风险-B 章节）：处理了路径分隔符，属弱防护（风险-B）
String safeName = file.replace("..", "").replace("/", "");
```

**判定规则**：replace/remove 是否处理了路径分隔符（`/` `\` `..`）——处理了则按风险-B 弱防护研判；未处理则等同于没做防护，仍按漏洞/风险判定，不因有 replace 操作就降级。

---

## 7. 特殊风险

### Symlink 攻击

攻击者通过创建符号链接使 `filepath.Join`/`path.resolve` 结果指向预期外位置。防御：`os.Lstat()` 检测符号链接，或在 chroot 环境中操作。

### Zip Slip

解压 ZIP 文件时 `entry.getName()` 可能包含 `../../` 路径。解压前必须验证每个 entry 的目标路径在预期目录内：
```java
Path targetPath = outputDir.resolve(entry.getName()).normalize();
if (!targetPath.startsWith(outputDir.normalize())) throw new SecurityException();
```

---

## 8. 变更影响分析

| 变更类型 | 变更内容 | 风险 |
|----------|----------|------|
| 新增 | 新增路径拼接文件操作 | 确认防护措施 |
| 新增 | 新增 Zip 解压功能 | 路径验证 |
| 修改 | 移除 startsWith / normalize | 移除防护 |
| 修改 | 将白名单改为黑名单 | 降低防护强度 |
| 修改 | 移除 UUID 重命名 | 用户可控制文件名 |
| 删除 | 删除路径验证 / 白名单 | 移除防护 |

---

## 9. 质量门禁（强制执行）

在输出审计结论前，按顺序验证：

- [ ] 强制执行顺序已遵守（先检查路径拼接分析）
- [ ] 漏洞本质判断先于防护判断（类型约束/数据来源直接终止）
- [ ] 写入场景危害已评估（Step 4.5）
- [ ] HTTP 入口可达性已确认，非假设
- [ ] gRPC 参数来源已正确识别（网关注入的 userId）
- [ ] normalize 是否配合 startsWith 已确认
- [ ] 结论与证据一致，代码行号可追溯
- [ ] 不因代码对比而判定风险

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**
