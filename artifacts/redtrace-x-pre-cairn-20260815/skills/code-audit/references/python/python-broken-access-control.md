# 访问控制缺失/越权（Python）

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
| vulnerability | 视图函数无认证装饰器 + 无全局中间件覆盖 + HTTP 入口可达 + 非公开数据 |
| risk-a | 无 HTTP 入口可达的认证缺失 |
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
| vulnerability | 接口有认证 + 管理功能无角色校验（路径含 admin/super/manage 但无 @permission_required） |
| risk-a | 管理功能无 HTTP 入口可达 |
| risk-b | 有角色校验但可绕过 |
| safe | 有完善的 RBAC 或权限装饰器 |

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

#### 模式 A1：认证装饰器缺失

**识别特征**：视图函数无 `@login_required` / `@permission_required` 装饰器

```python
# 漏洞代码：无认证装饰器
@api_view(['POST'])
def delete_user(request):
    user_id = request.data.get('user_id')
    User.objects.filter(id=user_id).delete()
    return Response({'status': 'ok'})
```

```python
# 安全写法：有认证装饰器
@api_view(['POST'])
@permission_required('user.delete')
def delete_user(request):
    user_id = request.data.get('user_id')
    User.objects.filter(id=user_id).delete()
    return Response({'status': 'ok'})
```

**判定流程**：
1. 确认视图函数无认证装饰器
2. 检查类视图是否继承 `LoginRequiredMixin`
3. 检查全局中间件是否覆盖（搜索 `MIDDLEWARE` 配置 / Django `authentication_middleware`）
4. 全局中间件未覆盖 → 未授权漏洞

#### 模式 A2：ALLOWED_HOSTS 配置错误

**识别特征**：`ALLOWED_HOSTS = ['*']` 导致 Host 头绕过

```python
# 漏洞代码
ALLOWED_HOSTS = ['*']
```

#### 模式 A3：无 authenticate 调用直接登录

**识别特征**：自定义登录逻辑未调用 `authenticate()`

```python
# 漏洞代码：跳过认证
def login_view(request):
    username = request.POST.get('username')
    user = User.objects.get(username=username)
    login(request, user)  # 未调用 authenticate()
```

### 2.B 权限绕过

#### 模式 B1：签名异常返回 true

**识别特征**：签名验证异常后默认通过

```python
# 漏洞代码：异常时放行
def verify_signature(sign):
    try:
        return hmac.compare_digest(computed, sign)
    except Exception as e:
        logger.error(f"签名验证异常: {e}")
        return True  # 异常时放行
```

```python
# 安全写法：异常时拒绝
def verify_signature(sign):
    try:
        return hmac.compare_digest(computed, sign)
    except Exception as e:
        logger.error(f"签名验证异常: {e}")
        return False
```

#### 模式 B2：token 为空放行

**识别特征**：认证中间件中 token 为空时仍放行

```python
# 漏洞代码：空 token 放行
class AuthMiddleware:
    def process_request(self, request):
        token = request.META.get('HTTP_AUTHORIZATION', '')
        if not token:
            return None  # 放行
        try:
            request.user = jwt.decode(token)
        except:
            return None  # 异常也放行
```

### 2.C 垂直越权

#### 模式 C1：管理接口无角色校验

**识别特征**：路径含 `admin`/`super`/`manage` 但无 `@permission_required`

```python
# 漏洞代码：管理接口无角色校验
@api_view(['POST'])
@login_required
def update_config(request):
    Config.objects.update(value=request.data.get('value'))
    return Response({'status': 'ok'})
```

```python
# 安全写法：管理接口有角色校验
@api_view(['POST'])
@permission_required('config.update', raise_exception=True)
def update_config(request):
    Config.objects.update(value=request.data.get('value'))
    return Response({'status': 'ok'})
```

**数据依据**：BAC 283 条中 105 条（37%）是真正的垂直越权

#### 模式 C2：子账号调用母账号功能

**识别特征**：接口文档标注"管理员"功能但无拦截

```python
# 漏洞代码：仅检查登录状态
@api_view(['GET'])
@login_required
def get_enterprise_settings(request):
    settings = EnterpriseService.get_settings(request.user.enterprise_id)
    return Response(settings)
```

### 2.D 全局越权

#### 模式 D1：无任何权限校验

**识别特征**：已认证用户可触发任意功能

```python
# 漏洞代码：任何认证用户都能修改系统配置
@api_view(['POST'])
@login_required
def update_config(request):
    Config.objects.update(value=request.data.get('value'))
    return Response({'status': 'ok'})
```

#### 模式 D2：权限码过宽

**识别特征**：全员可访问的权限应用于审批/管理接口

```python
# 漏洞代码：审批接口无权限检查
@api_view(['POST'])
@login_required
def approve(request, pk):
    ApprovalService.approve(pk)
    return Response({'status': 'ok'})
```

---

## 3. 检测命令

### 3.1 未授权检测

```bash
# 检测无认证装饰器的视图
grep -rn "def view\|@route\|@app.route\|@api_view" --include="*.py" | grep -v "login_required\|permission_required\|auth"

# 检测 ALLOWED_HOSTS 配置
grep -rn "ALLOWED_HOSTS" --include="*.py"

# 检测 LoginRequiredMixin 使用
grep -rn "LoginRequiredMixin" --include="*.py"
```

### 3.2 权限绕过检测

```bash
# 检测签名验证异常处理
grep -rn "except.*Exception\|return True" --include="*.py" -A2 | grep -B2 "return True"

# 检测空 token 放行
grep -rn "not token\|token == ''\|token is None" --include="*.py" -A2 | grep "return None\|pass"
```

### 3.3 垂直越权检测

```bash
# 检测管理路径无权限装饰器
grep -rn "def.*admin\|def.*manage\|def.*super" --include="*.py" | grep -v "permission_required\|user_passes_test"
```

### 3.4 全局越权检测

```bash
# 检测权限装饰器使用
grep -rn "@permission_required\|@user_passes_test" --include="*.py"
```

---

## 4. 误报排除规则

| 场景 | 判定 | 原因 |
|------|------|------|
| 全局中间件已覆盖 | 不报告（安全） | 即使视图无装饰器，全局认证有效 |
| gRPC 接口由网关认证 | 不报告 | API Gateway 层已认证 |
| 公开 API（公告/字典/配置） | 不报告 | 业务设计为公开 |
| 健康检查接口 | 不报告 | 运维接口 |
| 三方回调接口（有 IP 白名单/签名） | 不报告 | 三方服务回调 |

---

## 5. 变更影响分析

| 变更类型 | 风险 |
|----------|------|
| 新增视图无认证装饰器 | 检查全局中间件覆盖 |
| 新增 ALLOWED_HOSTS = ['*'] | Host 头绕过 |
| 移除认证装饰器 | 引入未授权 |
| 签名验证异常处理改为 return True | 引入权限绕过 |
| 新增管理接口无权限装饰器 | 引入垂直越权 |
| 权限码设为全员可访问 | 引入全局越权 |

---

## 6. 质量门禁

- [ ] 确认无全局中间件覆盖后再判定为未授权
- [ ] 检查 Django MIDDLEWARE 配置
- [ ] 检查 LoginRequiredMixin 使用
- [ ] 签名验证无异常绕过
- [ ] 区分未授权（无认证）vs IDOR（有认证但水平越权）
- [ ] 垂直越权已执行角色校验检查
- [ ] 公开接口已排除

---

## 7. 工程约束（禁止清单）

- 禁止假设路由安全性
- 禁止忽略框架默认行为
- 禁止忽略框架权限装饰器
