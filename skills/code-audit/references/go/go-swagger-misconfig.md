# Swagger/OpenAPI 不安全配置（Go）

## 0. 黄金法则

> **漏洞存在性判断 优先于 防护有效性判断**
>
> Swagger handler 未注册 或 仅限开发环境 = 无 Swagger 不安全配置
>
> 满足此条件时：立即终止分析，无需检查任何防护措施。

---

## 1. 结论判断标准

| 结论 | 定义 | 判定条件 |
|------|------|----------|
| **漏洞** | 生产环境 Swagger UI 无认证对外暴露 | swagger handler 注册到路由 + 无环境判断 + 无认证中间件 |
| **风险-A** | Swagger UI 仅内网可访问 | handler 有 host/IP 限制 / 仅绑定 127.0.0.1 |
| **风险-B** | Swagger UI 有防护但可能被绕过 | 环境判断逻辑不完整 |
| **安全** | Swagger 已关闭或仅限开发环境 | 条件编译 / `if os.Getenv("ENV") == "dev"` 包裹 |

---

## 2. 子模式详解

### 2.1 Pattern S1: Swagger handler 无认证注册

**识别特征**：路由注册 `/swagger` 路径且无认证中间件

**框架识别**：

| 框架 | 导入路径 |
|------|----------|
| swaggo/swag | `github.com/swaggo/swag`, `github.com/swaggo/gin-swagger` |
| go-swagger | `github.com/go-swagger/go-swagger` |

```go
// 漏洞：无环境判断 + 无认证中间件
r.GET("/swagger/*any", ginSwagger.WrapHandler(swaggerFiles.Handler))
```

```go
// 安全：环境判断保护
if os.Getenv("APP_ENV") == "dev" {
    r.GET("/swagger/*any", ginSwagger.WrapHandler(swaggerFiles.Handler))
}
```

### 2.2 Pattern S2: 无环境守卫

**识别特征**：swagger 初始化代码不在条件分支内

```go
// 漏洞：无条件注册
func setupRouter() *gin.Engine {
    r := gin.Default()
    r.GET("/swagger/*any", ginSwagger.WrapHandler(swaggerFiles.Handler))
    return r
}
```

### 2.3 Pattern S3: 注释含敏感信息

**识别特征**：Swagger 注释（`@Host`, `@Schemes`）暴露内部地址

```go
// 漏洞：注释暴露内部 gRPC 地址
// @Host admin-service.internal:8080
```

---

## 3. 检测命令

```bash
# 检测 Swagger handler 注册
grep -rn "swagger\|swag\|ginSwagger" --include="*.go"

# 检测路由注册
grep -rn "swagger.*Handler\|swagger.*any\|/swagger" --include="*.go"

# 检测环境判断
grep -rn "APP_ENV\|GO_ENV\|GIN_MODE" --include="*.go" | grep -i swagger
```

---

## 4. 误报排除规则

| 场景 | 判定 | 原因 |
|------|------|------|
| 条件编译（`//go:build dev`） | 安全 | 生产不编译 |
| `if os.Getenv("APP_ENV") == "dev"` 包裹 | 安全 | 环境判断保护 |
| 仅注册到 test 文件（`_test.go`） | 安全 | 测试代码 |
| 有认证中间件保护 | 安全 | 需登录访问 |
| 自定义 `swagger` 路径非文档框架 | 安全 | 非框架配置 |

---

## 5. 变更影响分析

| 变更类型 | 风险 |
|----------|------|
| 新增 swagger handler 注册无环境判断 | 检查生产环境是否暴露 |
| 移除环境判断条件 | 从安全变为不安全 |
| 注释新增内部地址 | 引入信息泄露 |

---

## 6. 质量门禁（强制执行）

- [ ] swagger handler 是否在生产路由中注册已确认
- [ ] 框架类型已识别（swaggo / go-swagger）
- [ ] 认证中间件覆盖范围已确认
- [ ] 环境判断逻辑正确性已确认
- [ ] 结论与证据一致，代码行号可追溯

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**
