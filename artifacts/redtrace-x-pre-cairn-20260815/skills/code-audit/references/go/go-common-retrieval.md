# Go 通用检索技巧

## HTTP 入口点识别

### Gin 框架

#### 路由识别

| 模式 | 说明 |
|------|------|
| `func.*gin.Context` | Gin 处理函数 |
| `\.GET|\.POST|\.PUT|\.DELETE|\.PATCH` | 路由注册（配合 grep -E） |

#### 参数来源

| 方法 | 来源 | 可控性 |
|------|------|--------|
| `c.Query()` | URL 查询参数 | 可控 |
| `c.PostForm()` | POST 表单数据 | 可控 |
| `c.Param()` | URL 路径参数 | 可控 |
| `c.GetRawData()` | 请求体原始数据 | 可控 |
| `c.BindJSON()` / `c.ShouldBindJSON()` | JSON 请求体 | 可控 |

#### 识别命令

```bash
# 查找 Gin 路由
grep -rn "func.*gin.Context" --include="*.go"
grep -rn -E "\.GET|\.POST|\.PUT|\.DELETE" --include="*.go"

# 查找用户参数
grep -rn "c\.Query(\|c\.PostForm(\|c\.Param(" --include="*.go"
```

#### 代码示例

```go
func GetUser(c *gin.Context) {
    // URL 路径参数，可控
    id := c.Param("id")

    // 查询参数，可控
    name := c.Query("name")

    // JSON 请求体，可控
    var req UserRequest
    c.BindJSON(&req)
}
```

---

### Echo 框架

#### 路由识别

| 模式 | 说明 |
|------|------|
| `func.*echo.Context` | Echo 处理函数 |
| `e\.GET|e\.POST|e\.PUT|e\.DELETE` | 路由注册（配合 grep -E） |

#### 参数来源

| 方法 | 来源 | 可控性 |
|------|------|--------|
| `c.QueryParam()` | URL 查询参数 | 可控 |
| `c.FormValue()` | 表单数据 | 可控 |
| `c.Param()` | URL 路径参数 | 可控 |
| `c.Bind()` | 绑定请求体 | 可控 |

#### 识别命令

```bash
# 查找 Echo 路由
grep -rn "func.*echo.Context" --include="*.go"
grep -rn -E "e\.GET|e\.POST|e\.PUT|e\.DELETE" --include="*.go"

# 查找用户参数
grep -rn "c\.Query\|c\.FormValue\|c\.Param" --include="*.go"
```

#### 代码示例

```go
func GetUser(c echo.Context) error {
    // URL 路径参数，可控
    id := c.Param("id")

    // 查询参数，可控
    name := c.QueryParam("name")

    // 绑定请求体，可控
    var req UserRequest
    c.Bind(&req)
}
```

---

### net/http 标准库

#### 路由识别

| 模式 | 说明 |
|------|------|
| `http.HandleFunc` | 路由注册 |
| `http.ServeHTTP` | Handler 接口实现 |
| `func.*http.ResponseWriter` | 处理函数签名 |

#### 参数来源

| 方法 | 来源 | 可控性 |
|------|------|--------|
| `r.URL.Query()` | URL 查询参数 | 可控 |
| `r.FormValue()` | 表单数据 | 可控 |
| `r.PostFormValue()` | POST 表单数据 | 可控 |
| `io.ReadAll(r.Body)` | 请求体 | 可控 |

#### 识别命令

```bash
# 查找 net/http 路由
grep -rn "http.HandleFunc\|http.ServeHTTP" --include="*.go"
grep -rn "func.*http.ResponseWriter" --include="*.go"

# 查找用户参数
grep -rn "r\.URL\.Query\|r\.FormValue\|r\.PostFormValue" --include="*.go"
```

#### 代码示例

```go
func GetUserHandler(w http.ResponseWriter, r *http.Request) {
    // URL 查询参数，可控
    name := r.URL.Query().Get("name")

    // 表单数据，可控
    email := r.FormValue("email")
}
```

---

### gRPC Service（Go）

#### 服务识别

| 模式 | 说明 |
|------|------|
| `Register*Server` | gRPC 服务注册 |
| `proto.*Server` | 生成的服务接口 |

#### 识别命令

```bash
# 查找 gRPC 服务
grep -rn "Register.*Server" --include="*.go"
grep -rn "func.*.*proto.*Server" --include="*.go"
```

#### 代码示例

```go
type server struct {
    proto.UnimplementedUserServiceServer
}

func (s *server) GetUser(ctx context.Context, req *proto.GetUserRequest) (*proto.GetUserResponse, error) {
    // req 所有字段来自 proto 定义
    userId := req.GetUserId()  // 需判定可控性
}
```

---

## 数据流追踪方法

### 从 sink 点向上追溯

```go
// Step 1: 识别 sink 点
db.Query("SELECT * FROM users WHERE name = '" + name + "'")  // sink

// Step 2: 追踪参数来源
// name 从哪里来？

// Step 3: 继续向上追溯
// 使用 Grep 搜索调用者

// Step 4: 找到入口点
// 确认 HTTP/gRPC 处理函数
```

### 识别命令

```bash
# 使用 Grep 搜索调用关系追踪数据流

# 跨文件搜索调用关系
grep -rn "functionName(" --include="*.go"

# 搜索结构体方法
grep -rn "func.*StructName.*MethodName" --include="*.go"
```

---

## 环境判断检测

```bash
# 检测环境判断
grep -rn "isProd\|isTest\|isDev\|isLocal\|os.Getenv" --include="*.go"

# 检测环境变量
grep -rn "ENV\|MODE\|environment" --include="*.go"
```

---

## 防护措施检查方法

| 检查项 | 检索方法 |
|--------|----------|
| 参数化查询 | Grep: `Prepare\|QueryContext\|?` |
| 类型转换 | Grep: `strconv.Atoi\|int()` |
| 白名单定义 | Grep: `allowed\|whitelist\|map\[string\]` |
| 校验函数实现 | Grep: 搜索函数定义 |

**详细防护规则**：
- 净化措施判定：`references/common/sanitization.md`
- 可信数据源判定：`references/common/trusted-sources.md`
- SSRF 隔离代理：`references/common/ssrf-proxy.md`

---

## 可达性判定总结

| 条件 | 可达性 | 结论 |
|------|--------|------|
| 有 Gin/Echo/http 处理函数，参数来自用户输入 | 可达 | 漏洞/风险/安全取决于防护 |
| 有 gRPC Service，参数来自 rpc 请求 | 可达 | 漏洞/风险/安全取决于防护 |
| 无入口点，仅内部函数 | 不可达 | 风险 |
| 参数来自常量/配置 | 不可达 | 风险 |
