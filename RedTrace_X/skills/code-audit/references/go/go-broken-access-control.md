# 访问控制缺失/越权（Go）

## 0. 前置判断：与 IDOR 的边界

| 条件 | 归类 | 后续动作 |
|------|------|---------|
| 接口完全无认证 | BrokenAccessControl（未授权） | 继续本文档 |
| 有认证但可绕过 | BrokenAccessControl（权限绕过） | 继续本文档 |
| 有认证 + 无角色/权限校验 + 管理功能 | BrokenAccessControl（垂直越权） | 继续本文档 |
| 有认证 + 无归属校验 + 访问他人资源 | **IDOR** | 切换到 IDOR 流程 |
| 有认证 + 权限码过宽 | BrokenAccessControl（全局越权） | 继续本文档 |

---

## 1. 结论判断标准

按 4 个子类型分别定义判定条件：

### 1.1 未授权

| 结论 | 判定条件 |
|------|---------|
| vulnerability | Handler 无认证中间件 + 无全局中间件覆盖 + HTTP 入口可达 + 非公开数据 |
| risk-a | 无 HTTP/gRPC 入口可达的认证缺失 |
| safe | 全局中间件已覆盖 / 业务设计为公开接口 |
| unknown | 无法判断是否有全局认证 |

### 1.2 权限绕过

| 结论 | 判定条件 |
|------|---------|
| vulnerability | 认证机制存在但可绕过（签名异常返回 true / 中间件跳过路径 / token 为空放行） |
| risk-a | 绕过路径无 HTTP 入口可达 |
| risk-b | 有部分防护但实现薄弱 |
| safe | 认证机制完善无绕过 |

### 1.3 垂直越权

| 结论 | 判定条件 |
|------|---------|
| vulnerability | 接口有认证 + 管理功能无角色校验（路径含 admin/super/manage 但无角色中间件） |
| risk-a | 管理功能无 HTTP 入口可达 |
| risk-b | 有角色校验但可绕过 |
| safe | 有完善的 RBAC 中间件 |

### 1.4 全局越权

| 结论 | 判定条件 |
|------|---------|
| vulnerability | 已认证 + 无权限码或权限码过宽 + 非公开功能 |
| risk-a | 功能无 HTTP 入口可达 |
| risk-b | 有部分权限控制 |
| safe | 有精确的权限码配置 |

---

## 2. 子模式详解

### 2.A 未授权

#### 模式 A1：认证中间件缺失

**识别特征**：路由无认证中间件

```go
// 漏洞代码：无认证中间件
r.POST("/api/admin/deleteUser", deleteUserHandler)
```

```go
// 安全写法：有认证中间件
admin := r.Group("/api/admin")
admin.Use(authMiddleware())
admin.POST("/deleteUser", deleteUserHandler)
```

**判定流程**：
1. 确认路由无认证中间件
2. 检查路由组级别是否有中间件
3. 检查全局中间件是否覆盖（搜索 `r.Use` / `engine.Use`）
4. 全局中间件未覆盖 → 未授权漏洞

#### 模式 A2：NoAuth / public 路由标记滥用

**识别特征**：路由含 `NoAuth`/`public`/`skipAuth` 标记但处理敏感数据

```go
// 漏洞代码：敏感接口标记为 NoAuth
r.GET("/api/user/profile/:id", NoAuth(), getUserProfile)
```

#### 模式 A3：中间件链缺失

**识别特征**：路由组未注册认证中间件

```go
// 漏洞代码：中间件链不完整
api := r.Group("/api")
// 缺少 api.Use(authMiddleware())
api.GET("/orders", listOrders)
```

### 2.B 权限绕过

#### 模式 B1：签名异常返回 true

**识别特征**：签名验证异常后默认通过

```go
// 漏洞代码：签名异常时放行
func verifySignature(sign string) bool {
    mac := hmac.New(sha256.New, []byte(secret))
    _, err := mac.Write([]byte(data))
    if err != nil {
        log.Printf("签名验证异常: %v", err)
        return true // 异常时放行
    }
    return hmac.Equal(mac.Sum(nil), decoded)
}
```

```go
// 安全写法：异常时拒绝
func verifySignature(sign string) bool {
    mac := hmac.New(sha256.New, []byte(secret))
    _, err := mac.Write([]byte(data))
    if err != nil {
        log.Printf("签名验证异常: %v", err)
        return false
    }
    return hmac.Equal(mac.Sum(nil), decoded)
}
```

#### 模式 B2：token 为空放行

**识别特征**：认证中间件中 `token == ""` 时仍放行

```go
// 漏洞代码：空 token 放行
func authMiddleware() gin.HandlerFunc {
    return func(c *gin.Context) {
        token := c.GetHeader("Authorization")
        if token == "" {
            c.Next() // 空 token 放行
            return
        }
        claims, err := jwt.Parse(token)
        if err != nil {
            c.AbortWithStatus(401)
            return
        }
        c.Set("user", claims)
        c.Next()
    }
}
```

### 2.C 垂直越权

#### 模式 C1：管理接口无角色校验

**识别特征**：路径含 `admin`/`super`/`manage` 但无角色中间件

```go
// 漏洞代码：管理接口无角色校验
r.POST("/api/admin/config/update", updateConfigHandler)
```

```go
// 安全写法：管理接口有角色校验
admin := r.Group("/api/admin")
admin.Use(authMiddleware(), roleMiddleware("admin"))
admin.POST("/config/update", updateConfigHandler)
```

**数据依据**：BAC 283 条中 105 条（37%）是真正的垂直越权

#### 模式 C2：子账号调用母账号功能

**识别特征**：接口文档标注"管理员"功能但无角色拦截

```go
// 漏洞代码：仅检查登录状态，未检查角色
func getEnterpriseSettings(c *gin.Context) {
    user := c.MustGet("user").(*User)
    settings := enterpriseService.GetSettings(user.EnterpriseID)
    c.JSON(200, settings)
}
```

#### 模式 C3：后门/调试接口暴露

**识别特征**：路径含 `debug`/`pprof`/`dev` 但生产未限制（Swagger UI/API 文档端点的暴露归为 SwaggerMisconfig，不在此模式范围内）

```go
// 漏洞代码：pprof 接口暴露
import _ "net/http/pprof"
```

### 2.D 全局越权

#### 模式 D1：无任何权限校验

**识别特征**：已认证用户可触发任意功能

```go
// 漏洞代码：任何认证用户都能修改系统配置
r.POST("/api/config/update", authMiddleware(), updateConfigHandler)
// 缺少权限码校验
```

#### 模式 D2：权限码过宽

**识别特征**：全员可访问的权限码应用于审批/管理接口

```go
// 漏洞代码：审批接口使用过宽的权限码
func approveHandler(c *gin.Context) {
    user := c.MustGet("user").(*User)
    // 未检查 user 是否有 approval 权限
    approvalService.Approve(id)
}
```

---

## 3. 检测命令

### 3.1 未授权检测

```bash
# 检测无中间件的路由
grep -rn "r.GET\|r.POST\|r.PUT\|r.DELETE\|router.GET\|router.POST" --include="*.go" | grep -v "Use\|middleware\|authMiddleware"

# 检测 NoAuth 标记
grep -rn "NoAuth\|public\|skipAuth" --include="*.go"

# 检测中间件排除路径
grep -rn "Skip\|Exclude\|Ignore" --include="*.go" | grep -i "auth\|middleware"
```

### 3.2 权限绕过检测

```bash
# 检测签名验证异常处理
grep -rn "return true" --include="*.go" -B5 | grep -A5 "err\|Error\|panic"

# 检测空 token 放行
grep -rn 'token == ""\|token == ""\|len(token) == 0' --include="*.go" -A3 | grep "c.Next\|return"
```

### 3.3 垂直越权检测

```bash
# 检测管理路径无角色中间件
grep -rn "admin\|manage\|super" --include="*.go" | grep "r.GET\|r.POST\|Handle\|Handler"
```

### 3.4 全局越权检测

```bash
# 检测权限校验缺失
grep -rn "authMiddleware" --include="*.go" | grep -v "roleMiddleware\|permissionMiddleware\|rbac"
```

---

## 4. 误报排除规则

| 场景 | 判定 | 原因 |
|------|------|------|
| 全局中间件已覆盖 | 不报告（安全） | 即使 Handler 无中间件，全局认证有效 |
| gRPC 接口由网关认证 | 不报告 | API Gateway 层已认证 |
| 公开 API（公告/字典/配置） | 不报告 | 业务设计为公开 |
| 健康检查接口 | 不报告 | 运维接口 |
| 三方回调接口（有 IP 白名单/签名） | 不报告 | 三方服务回调 |

---

## 5. 变更影响分析

| 变更类型 | 风险 |
|----------|------|
| 新增 Handler 无认证中间件 | 检查全局中间件覆盖 |
| 新增 skipAuth 路径 | 确认是否处理敏感数据 |
| 移除认证中间件 | 引入未授权 |
| 签名验证异常处理改为 return true | 引入权限绕过 |
| 新增管理接口无角色中间件 | 引入垂直越权 |
| 权限码设为全员可访问 | 引入全局越权 |

---

## 6. 质量门禁

- [ ] 确认无全局中间件覆盖后再判定为未授权
- [ ] 检查路由组中间件链
- [ ] 检查 skipAuth/NoAuth 路径
- [ ] 签名验证无异常绕过
- [ ] 区分未授权（无认证）vs IDOR（有认证但水平越权）
- [ ] 垂直越权已执行角色校验检查
- [ ] 公开接口已排除

---

## 7. 工程约束（禁止清单）

- 禁止假设路由安全性
- 禁止忽略中间件顺序
- 禁止忽略资源归属校验
