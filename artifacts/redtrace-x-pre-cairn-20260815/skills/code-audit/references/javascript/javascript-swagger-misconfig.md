# Swagger/OpenAPI 不安全配置（JavaScript）

## 0. 黄金法则

> **漏洞存在性判断 优先于 防护有效性判断**
>
> swagger-ui-express 未注册 或 SwaggerModule 仅限开发环境 = 无 Swagger 不安全配置
>
> 满足此条件时：立即终止分析，无需检查任何防护措施。

---

## 1. 结论判断标准

| 结论 | 定义 | 判定条件 |
|------|------|----------|
| **漏洞** | 生产环境 Swagger UI 无认证对外暴露 | swagger 中间件注册到路由 + 无环境判断 + 无认证中间件 |
| **风险-A** | Swagger UI 仅内网可访问 | 绑定 127.0.0.1 / 非 public 路径 |
| **风险-B** | Swagger UI 有防护但可能被绕过 | 环境判断逻辑不完整 |
| **安全** | Swagger 已关闭或仅限开发环境 | 条件注册 / `if (isDev)` / 认证中间件保护 |

---

## 2. 子模式详解

### 2.1 Pattern S1: swagger-ui-express 无认证注册

**识别特征**：`app.use('/api-docs', ...)` 无认证中间件

```javascript
// 漏洞：无认证中间件
const swaggerUi = require('swagger-ui-express');
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(spec));
```

```javascript
// 安全：环境判断保护
if (process.env.NODE_ENV === 'development') {
    app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(spec));
}
```

```javascript
// 安全：认证中间件保护
app.use('/api-docs', requireAuth, swaggerUi.serve, swaggerUi.setup(spec));
```

### 2.2 Pattern S2: NestJS SwaggerModule 无环境检查

**识别特征**：`SwaggerModule.setup()` 不在条件分支内

```typescript
// 漏洞：无条件注册
const document = SwaggerModule.createDocument(app, config);
SwaggerModule.setup('api', app, document);
```

```typescript
// 安全：环境判断保护
if (process.env.NODE_ENV !== 'production') {
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api', app, document);
}
```

### 2.3 Pattern S3: spec 含敏感信息

**识别特征**：swagger spec 定义含内部 URL、数据库连接、密钥

```javascript
// 漏洞：spec 暴露内部服务地址
const spec = {
    host: 'admin-service.internal:8080',
    basePath: '/api/v1',
    // ...
};
```

---

## 3. 检测命令

```bash
# 检测 swagger-ui-express
grep -rn "swagger-ui-express\|swaggerUi" --include="*.js" --include="*.ts"

# 检测 NestJS Swagger
grep -rn "SwaggerModule\|@nestjs/swagger\|DocumentBuilder" --include="*.js" --include="*.ts"

# 检测路由注册
grep -rn "api-docs\|swagger.*setup\|swagger.*serve" --include="*.js" --include="*.ts"

# 检测环境判断
grep -rn "NODE_ENV\|isDev\|isProduction" --include="*.js" --include="*.ts" | grep -i swagger
```

---

## 4. 误报排除规则

| 场景 | 判定 | 原因 |
|------|------|------|
| `if (NODE_ENV === 'development')` 包裹 | 安全 | 仅开发环境 |
| 有认证中间件保护 | 安全 | 需登录访问 |
| spec 文件仅在测试中引用 | 安全 | 测试代码 |
| 自定义 `/api-docs` 路径非 Swagger 框架 | 安全 | 非框架配置 |
| Docker 环境变量 `SWAGGER_ENABLED=false` 控制 | 安全 | 配置开关保护 |

---

## 5. 变更影响分析

| 变更类型 | 风险 |
|----------|------|
| 新增 swagger 中间件无环境判断 | 检查生产环境是否暴露 |
| 移除环境判断条件 | 从安全变为不安全 |
| spec 新增内部服务地址 | 引入信息泄露 |
| 移除认证中间件 | 引入未认证访问 |

---

## 6. 质量门禁（强制执行）

- [ ] 框架类型已识别（swagger-ui-express / @nestjs/swagger）
- [ ] swagger 中间件是否在生产路由中注册已确认
- [ ] 认证中间件覆盖范围已确认
- [ ] 环境判断逻辑正确性已确认
- [ ] spec 是否包含敏感信息已确认
- [ ] 结论与证据一致，代码行号可追溯

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**
