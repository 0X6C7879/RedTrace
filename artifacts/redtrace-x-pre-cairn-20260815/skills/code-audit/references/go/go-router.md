# Go 语言路由配置

Go 语言特定的模式映射和检测规则。

## 语言元信息

| 字段 | 值 |
|------|-----|
| 语言名称 | Go |
| 语言代码 | `go` |
| Phase | Phase 2 (已完成) |
| 支持框架 | Gin, Echo |
| 文件扩展名 | `.go` |
| 测试文件排除 | `*_test.go`, `test/`, `tests/` |

---

## 模式关键词到漏洞类型映射

> 「漏洞类型」列的值必须严格使用 `references/common/category-enum.md` 中定义的标准化枚举值。

| 模式关键词 | 漏洞类型 | 规则文档 |
|-----------|---------|---------|
| **SQL关键字（查询）**: SELECT, FROM, WHERE, JOIN, INNER, LEFT, RIGHT, OUTER, ON, GROUP BY, ORDER BY, HAVING, LIMIT, OFFSET | SQLi | go-sql-injection.md |
| **SQL关键字（修改）**: INSERT, UPDATE, DELETE, SET, VALUES, INTO | SQLi | go-sql-injection.md |
| **SQL关键字（结构）**: CREATE, ALTER, DROP, TABLE, INDEX, VIEW, DATABASE, SCHEMA | SQLi | go-sql-injection.md |
| **SQL关键字（控制）**: UNION, CASE, WHEN, THEN, ELSE, END, EXISTS, IN, LIKE, BETWEEN | SQLi | go-sql-injection.md |
| **SQL关键字（函数）**: COUNT, SUM, AVG, MAX, MIN, DISTINCT, AS | SQLi | go-sql-injection.md |
| **SQL执行方法**: Query, QueryRow, Exec, db.Exec, db.Query | SQLi | go-sql-injection.md |
| **拼接操作**: +, +=, fmt.Sprintf, strings.Join | SQLi | go-sql-injection.md |
| **构造器**: strings.Builder, .Write(, .WriteString( | SQLi | go-sql-injection.md |
| **动态替换**: .Replace(, .ReplaceAll( | SQLi | go-sql-injection.md |
| db.Raw, db.Exec, db.Order, db.Table, db.Select (拼接) | SQLi | go-sql-injection.md |
| exec.Command("sh", "-c"), syscall.Exec | RCE | go-rce.md |
| http.Get, http.Post, http.Client, net.Dial | SSRF | go-ssrf.md |
| fmt.Fprintf (HTML), text/template, io.WriteString | XSS | go-xss.md |
| os.Open, os.ReadFile, http.ServeFile, filepath.Join | PathTraversal | go-path-traversal.md |
| template.Parse, template.New, text/template, html/template | SSTI | go-template-injection.md |
| int32, uint32, make([]byte, size), 类型转换 | IntegerOverflow | go-integer-overflow.md |
| math/rand.Seed, math/rand.Int, time.Now().Unix() | WeakRNG | go-weak-rng.md |
| "password", "token", "apiKey", "secret", const string = | Hardcoded | go-hardcoded.md |
| c.Redirect, http.Redirect | OpenRedirect | go-open-redirect.md |
| Access-Control-Allow-Origin, AllowCredentials | CORS | go-cors.md |
| FormFile, SaveUploadedFile, multipart.FormFile | FileUpload | go-file-upload.md |
| xml.Unmarshal, xml.Parse, libxml2 | XXE | go-xxe.md |
| gob.Decode, json.Unmarshal(interface{}) | Deserialization | go-deserialization.md |
| 认证中间件缺失, NoAuth, public 路由, 签名绕过, 角色检查缺失, 权限中间件缺失, 垂直越权, 全局越权 | BrokenAccessControl | go-broken-access-control.md |
| 敏感删改接口无 CSRF Token, gorilla/csrf 缺失 | CSRF | go-csrf.md |
| prompt, system_message, chat_completion, user_input → LLM 调用 | PromptInjection | go-prompt-injection.md |
| 金额篡改, 数量篡改, 状态机绕过, 评分滥用 | BusinessLogic | go-business-logic.md |
| 分页无上限, export, listAll, FindAll 无 limit | BatchExport | go-batch-export.md |
| swag, swagger, swaggo, go-swagger, swaggerUI, doc.json, ginSwagger | SwaggerMisconfig | go-swagger-misconfig.md |

**注意**：
- `db.Where(&Struct{})` / `db.Where(map)` / `db.Where("field = ?", v)` → 安全（GORM 自动预编译）
- `exec.Command("fixed", arg1, arg2)` → 安全（命令固定，参数独立）
- `html/template` → 安全（自动转义）

---

## 公司内部 SDK 映射

| SDK/组件 | 危险方法 | 漏洞类型 | 说明 |
|---------|----------|----------|------|
| （暂无内部 SDK） | - | - | 待补充 |

---

## 高危参数名列表

以下参数名如果直接拼接到 SQL/命令中，属于高风险：

| 参数名 | 常见用途 | 风险类型 |
|--------|----------|----------|
| `searchField`, `fieldName`, `columnName` | 动态字段查询 | SQLi |
| `sortBy`, `orderField`, `sortColumn` | 排序字段 | SQLi |
| `tableName` | 动态表名 | SQLi |
| `condition`, `whereClause` | WHERE 条件 | SQLi |
| `matchField`, `jsonPath` | JSON 路径 | SQLi |
| `command`, `cmd`, `bash` | 命令执行 | RCE |
| `url`, `targetUrl`, `callbackUrl` | URL 请求 | SSRF |
| `redirectUrl`, `returnUrl`, `next` | 重定向 | OpenRedirect |
| `filename`, `filepath`, `path` | 文件操作 | PathTraversal |

---

## HTTP 入口点识别规则

| 类型 | 识别模式 | 规则文档 |
|------|----------|----------|
| Gin | `func.*gin.Context` + 路由注册 | go-common-retrieval.md |
| Echo | `func.*echo.Context` + 路由注册 | go-common-retrieval.md |
| net/http | `http.HandleFunc` / `ServeHTTP` | go-common-retrieval.md |
| gRPC | `Register*Server` / `proto.*Server` | go-common-retrieval.md |

**参数来源**：
| 框架 | 参数来源 |
|------|----------|
| Gin | c.Query(), c.Param(), c.PostForm(), c.GetRawData() |
| Echo | echo.QueryParam(), echo.Param(), echo.FormValue() |
| net/http | r.FormValue(), r.URL.Query() |
| gRPC | RPC 方法参数 |

---

## 快速检测命令

```bash
# SQL 拼接检测
grep -rn "db\.Raw\|db\.Exec\|db\.Order" --include="*.go"

# 命令执行检测
grep -rn "exec\.Command\|syscall\.Exec" --include="*.go"

# SSRF 检测
grep -rn "http\.Get\|http\.Post\|http\.Client" --include="*.go"

# XSS 检测
grep -rn "text/template\|fmt\.Fprintf" --include="*.go"

# 文件操作检测
grep -rn "os\.Open\|os\.ReadFile\|http\.ServeFile" --include="*.go"
```

---

## 支持的漏洞类型列表

| 类型 | 规则文档 |
|------|----------|
| SQL 注入 | go-sql-injection.md |
| RCE | go-rce.md |
| SSRF | go-ssrf.md |
| XSS | go-xss.md |
| 路径遍历 | go-path-traversal.md |
| 模板注入 | go-template-injection.md |
| 硬编码凭据 | go-hardcoded.md |
| 开放重定向 | go-open-redirect.md |
| CORS | go-cors.md |
| 文件上传 | go-file-upload.md |
| XXE | go-xxe.md |
| 反序列化 | go-deserialization.md |
| Swagger 不安全配置 | go-swagger-misconfig.md |
