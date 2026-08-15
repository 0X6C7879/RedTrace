# 跨站请求伪造（Go）

## 结论判断标准

| 结论 | 判定条件 |
|------|---------|
| vulnerability | **敏感删改接口**（密码修改、账号绑定、支付、权限变更等）无 CSRF Token 校验 |
| risk-a | 无 HTTP 入口可达的 CSRF 风险 |
| risk-b | 非敏感删改接口无 CSRF 校验，或敏感接口有 CSRF 防护但配置不当 |
| safe | 有 CSRF Token 校验、Stateless API、查询接口、指定 ID 删除 |
| unknown | 无法判断 CSRF 防护状态 |

### 排除场景（不报告为 CSRF 漏洞）

| 场景 | 正确判定 | 原因 |
|------|---------|------|
| 查询接口（GET） | safe | 无副作用，不构成 CSRF 风险 |
| 删除/修改指定 ID 的接口 | safe | 攻击者无法预知目标 ID，无法定向攻击 |
| 非敏感删改（修改昵称、保存草稿、偏好设置） | risk-b 或不报告 | 数据影响有限，危害较低 |

### 判定流程

1. **操作类型**：是否为删改（PUT/PATCH/DELETE/状态变更 POST）？查询接口 → safe
2. **可定向性**：攻击者能否指定目标？（批量操作/无 ID 参数 → 可定向；指定 ID → 不可定向 → safe）
3. **敏感度**：是否涉及账号安全、支付、权限等敏感操作？非敏感 → risk-b

## 常见漏洞/风险类型

- 模式1：敏感删改接口（PUT/DELETE）无 CSRF 校验
- 模式2：gorilla/csrf 中间件缺失
- 模式3：Session Cookie 无 SameSite 属性

## 常见安全类型

- gorilla/csrf 中间件
- 自定义 CSRF Token 校验
- SameSite Cookie 属性
- Stateless REST API（无 CSRF 风险）

## 关键 Sink 点列表

| Sink 点 | 说明 |
|---------|------|
| PUT / DELETE | 敏感删改接口（重点检测） |
| POST | 需评估敏感度后再判定 |
| csrf middleware | CSRF 中间件 |
| Cookie | Session Cookie 配置 |

## 检测命令

```bash
# 检测删改路由（重点）
grep -rn "r.PUT\|r.DELETE" --include="*.go"

# 检测 POST 路由（需评估敏感度）
grep -rn "r.POST" --include="*.go"

# 检测 CSRF 中间件
grep -rn "csrf\|gorilla" --include="*.go"
```

## 常见误判场景

| 场景 | 正确判定 |
|------|---------|
| Stateless JWT 认证 | safe（无 CSRF 风险） |
| 公开 API 无需 CSRF | safe |

## 质量检查门禁

- [ ] 确认应用是否 Stateless
- [ ] 检查 CSRF 中间件配置
- [ ] 区分 Session 和 Token 认证
- [ ] 确认接口操作类型（查询/删改）
- [ ] 评估接口敏感度（是否涉及账号安全、支付、权限）

## 工程约束（禁止清单）

- 禁止对 Stateless API 报 CSRF 漏洞
- 禁止忽略认证方式
- 禁止对查询接口（GET）报 CSRF 漏洞
- 禁止对指定 ID 删除/修改接口报 CSRF 漏洞
