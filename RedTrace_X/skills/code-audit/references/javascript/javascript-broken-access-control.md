# 访问控制缺失/越权（JavaScript）

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
| vulnerability | Handler 无认证 Guard/中间件 + 无全局中间件覆盖 + HTTP 入口可达 + 非公开数据 |
| risk-a | 无 HTTP 入口可达的认证缺失 |
| safe | 全局 Guard/中间件已覆盖 / 业务设计为公开接口 |
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
| vulnerability | 接口有认证 + 管理功能无角色校验（路径含 admin/super/manage 但无 Roles Guard） |
| risk-a | 管理功能无 HTTP 入口可达 |
| risk-b | 有角色校验但可绕过 |
| safe | 有完善的 RBAC 或 Roles Guard |

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

#### 模式 A1：认证 Guard 缺失

**识别特征**：Controller 方法无 `@UseGuards(AuthGuard)` 装饰器

```typescript
// 漏洞代码：无认证 Guard
@Post('/admin/deleteUser')
async deleteUser(@Body() body: { userId: number }) {
  await this.userService.delete(body.userId);
  return { success: true };
}
```

```typescript
// 安全写法：有认证 Guard
@UseGuards(AuthGuard, RolesGuard)
@Roles('admin')
@Post('/admin/deleteUser')
async deleteUser(@Body() body: { userId: number }) {
  await this.userService.delete(body.userId);
  return { success: true };
}
```

**判定流程**：
1. 确认方法无认证 Guard/中间件
2. 检查 Controller 类级别是否有 Guard
3. 检查全局 Guard 是否覆盖（搜索 `APP_GUARD` / `useGlobalGuards`）
4. 检查 NestJS Module 中间件是否覆盖（搜索 `MiddlewareConsumer` / `implements NestMiddleware`）
5. 确认中间件的 `forRoutes()` 包含目标路径且不在 `exclude()` 中
6. 以上均未覆盖 → 未授权漏洞

#### 模式 A2：public 标记滥用

**识别特征**：`@Public()` 装饰器应用于敏感接口

```typescript
// 漏洞代码：敏感接口标记为 public
@Public()
@Get('/user/profile/:id')
async getProfile(@Param('id') id: string) {
  return this.userService.getProfile(id);
}
```

#### 模式 A3：中间件链缺失

**识别特征**：路由未注册认证中间件

```typescript
// 漏洞代码：Express 路由无认证中间件
app.post('/api/admin/config/update', updateConfigHandler);
```

```typescript
// 安全写法：有认证中间件
app.post('/api/admin/config/update', authMiddleware, adminMiddleware, updateConfigHandler);
```

### 2.B 权限绕过

#### 模式 B1：签名异常返回 true

**识别特征**：签名验证异常后默认通过

```typescript
// 漏洞代码：异常时放行
function verifySignature(sign: string): boolean {
  try {
    return crypto.timingSafeEqual(
      Buffer.from(computed),
      Buffer.from(sign)
    );
  } catch (e) {
    console.error('签名验证异常', e);
    return true; // 异常时放行
  }
}
```

```typescript
// 安全写法：异常时拒绝
function verifySignature(sign: string): boolean {
  try {
    return crypto.timingSafeEqual(
      Buffer.from(computed),
      Buffer.from(sign)
    );
  } catch (e) {
    console.error('签名验证异常', e);
    return false;
  }
}
```

#### 模式 B2：token 为空放行

**识别特征**：认证中间件中 token 为空时仍调用 `next()`

```typescript
// 漏洞代码：空 token 放行
function authMiddleware(req, res, next) {
  const token = req.headers.authorization;
  if (!token) {
    next(); // 空 token 放行
    return;
  }
  try {
    req.user = jwt.verify(token);
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
  next();
}
```

```typescript
// 安全写法：空 token 拒绝
function authMiddleware(req, res, next) {
  const token = req.headers.authorization;
  if (!token) {
    return res.status(401).json({ error: 'No token' });
  }
  try {
    req.user = jwt.verify(token);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}
```

### 2.C 垂直越权

#### 模式 C1：管理接口无角色 Guard

**识别特征**：路径含 `admin`/`super`/`manage` 但无 `@Roles` / Roles Guard

```typescript
// 漏洞代码：管理接口无角色校验
@UseGuards(AuthGuard)
@Post('/admin/config/update')
async updateConfig(@Body() body: ConfigDTO) {
  return this.configService.update(body);
}
```

```typescript
// 安全写法：管理接口有角色校验
@UseGuards(AuthGuard, RolesGuard)
@Roles('admin')
@Post('/admin/config/update')
async updateConfig(@Body() body: ConfigDTO) {
  return this.configService.update(body);
}
```

**数据依据**：BAC 283 条中 105 条（37%）是真正的垂直越权

#### 模式 C2：子账号调用母账号功能

**识别特征**：接口文档标注"管理员"功能但无拦截

```typescript
// 漏洞代码：仅检查登录状态
@UseGuards(AuthGuard)
@Get('/enterprise/settings')
async getSettings(@Req() req) {
  return this.enterpriseService.getSettings(req.user.enterpriseId);
}
```

#### 模式 C3：后门/调试接口暴露

**识别特征**：路径含 `debug`/`dev` 但生产未限制（Swagger UI/API 文档端点的暴露归为 SwaggerMisconfig，不在此模式范围内）

```typescript
// 漏洞代码：调试接口暴露
@Get('/debug/users')
async getAllUsers() {
  return this.userRepository.find();
}
```

### 2.D 全局越权

#### 模式 D1：无任何权限校验

**识别特征**：已认证用户可触发任意功能

```typescript
// 漏洞代码：任何认证用户都能修改系统配置
@UseGuards(AuthGuard)
@Post('/config/update')
async updateConfig(@Body() body: ConfigDTO) {
  // 未检查用户是否有 config:update 权限
  return this.configService.update(body);
}
```

#### 模式 D2：权限码过宽

**识别特征**：全员可访问的权限应用于审批/管理接口

```typescript
// 漏洞代码：审批接口无权限检查
@UseGuards(AuthGuard)
@Post('/approval/approve/:id')
async approve(@Param('id') id: string) {
  return this.approvalService.approve(id);
}
```

---

## 3. 检测命令

### 3.1 未授权检测

```bash
# 检测无 Guard 的 Controller 方法
grep -rn "@Post\|@Get\|@Put\|@Delete\|@Patch" --include="*.ts" --include="*.js" | grep -v "UseGuards\|@Public\|auth"

# 检测 @Public 装饰器使用
grep -rn "@Public" --include="*.ts" --include="*.js"

# 检测无中间件的 Express 路由
grep -rn "router.get\|router.post\|app.get\|app.post" --include="*.js" --include="*.ts" | grep -v "auth\|middleware"
```

### 3.2 权限绕过检测

```bash
# 检测签名验证异常处理
grep -rn "catch\|return true" --include="*.ts" --include="*.js" -A2 | grep -B2 "return true"

# 检测空 token 放行
grep -rn '!token\|!req.headers.authorization\|token === ""' --include="*.ts" --include="*.js" -A2 | grep "next()\|return"
```

### 3.3 垂直越权检测

```bash
# 检测管理路径无 Roles Guard
grep -rn "@Post\|@Get" --include="*.ts" --include="*.js" | grep -i "admin\|manage\|super" | grep -v "@Roles\|RolesGuard"
```

### 3.4 全局越权检测

```bash
# 检测 Guard 使用
grep -rn "@UseGuards\|@Roles" --include="*.ts" --include="*.js"

# 检测全局 Guard 配置
grep -rn "APP_GUARD\|useGlobalGuards" --include="*.ts" --include="*.js"

# 检测 NestJS Module 中间件
grep -rn "MiddlewareConsumer\|NestMiddleware\|forRoutes\|\.exclude(" --include="*.ts"

# 检测 Express/Koa 全局认证中间件
grep -rn "app\.use.*[Aa]uth\|app\.use.*[Ll]ogin\|app\.use.*[Ss]so" --include="*.ts" --include="*.js"
```

---

## 4. 误报排除规则

| 场景 | 判定 | 原因 |
|------|------|------|
| 全局 Guard 已覆盖 | 不报告（安全） | 即使方法无 Guard，全局认证有效 |
| gRPC 接口由网关认证 | 不报告 | API Gateway 层已认证 |
| 公开 API（公告/字典/配置） | 不报告 | 业务设计为公开 |
| 健康检查接口 | 不报告 | 运维接口 |
| 三方回调接口（有 IP 白名单/签名） | 不报告 | 三方服务回调 |

---

## 5. 变更影响分析

| 变更类型 | 风险 |
|----------|------|
| 新增 Controller 方法无 Guard | 检查全局 Guard 覆盖 |
| 新增 @Public 路径 | 确认是否处理敏感数据 |
| 移除认证 Guard | 引入未授权 |
| 签名验证异常处理改为 return true | 引入权限绕过 |
| 新增管理接口无 Roles Guard | 引入垂直越权 |
| 权限码设为全员可访问 | 引入全局越权 |

---

## 6. 质量门禁

- [ ] 确认无全局 Guard 覆盖后再判定为未授权
- [ ] 检查 APP_GUARD / useGlobalGuards 配置
- [ ] 检查 MiddlewareConsumer / NestModule.configure 中间件配置（NestJS 项目）
- [ ] 检查 @Public 装饰器使用
- [ ] 签名验证无异常绕过
- [ ] 区分未授权（无认证）vs IDOR（有认证但水平越权）
- [ ] 垂直越权已执行角色校验检查
- [ ] 公开接口已排除

---

## 7. 工程约束（禁止清单）

- 禁止假设路由安全性
- 禁止忽略中间件顺序
- 禁止忽略资源归属校验
