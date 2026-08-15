# CORS

## 0. 黄金法则

> **漏洞存在性判断 优先于 防护有效性判断**
>
> Credentials=false/null 或 静态特定域名 = 无 CORS 漏洞（这是漏洞本质判断，不是防护有效判断）
>
> 满足此条件时：立即终止分析，无需检查任何防护措施。

**强制执行顺序**：
1. **首先**：找到 CORS 配置代码（如 `CORS()`, `CORSMiddleware`, 响应头设置）
2. **然后**：分析 Credentials 状态和 origins 设置方式
3. **仅当** Credentials=true 且 Origin 动态回显/通配符时，才继续检查防护措施
4. **禁止**：一上来就检查"有没有白名单"、"A 有 B 没有"

**审计限定条件**：
1. 无需考虑白名单下存在子域名的 CORS 风险（如 `endswith(".company.com")` 不纳入判定）
2. 无需考虑影响部分接口的 CORS 风险（仅关注影响全量接口）
3. 非登录场景不考虑 CORS 风险

---

## 1. 结论判断标准

| 结论 | 定义 | 判定条件 |
|------|------|----------|
| **漏洞** | Credentials=true + Origin 可回显任意值 + 无有效白名单校验 + HTTP 入口可达 + 影响全量接口 | supports_credentials=True + 动态回显/通配符 + 无严格白名单 + HTTP 入口 |
| **风险-A** | CORS 配置不安全但无 HTTP 入口可达 | supports_credentials=True + 动态回显/通配符 + 无外部入口 |
| **风险-B** | CORS 配置有 HTTP 入口可达，但防护措施不充分 | supports_credentials=True + 动态回显/通配符 + startswith/endswith 校验 |
| **无法确认** | 白名单关键代码缺失 | 白名单校验函数代码缺失（仅白名单 set 值无法感知不算缺失） |
| **安全** | 无危险配置，或有充分的有效防护 | supports_credentials=False / 静态特定域名 / 严格白名单 / 非线上环境 |

---

## 2. 研判思路

### 2.1 核心判定矩阵

| Credentials | Origin 设置方式 | 白名单校验 | HTTP入口 | 结论 |
|-------------|----------------|-----------|---------|------|
| false/null | 任意 | 任意 | - | 安全（立即终止） |
| true | 静态特定域名 | 任意 | - | 安全（立即终止） |
| true | 动态回显/通配符 | 严格白名单 | - | 安全 |
| true | 动态回显/通配符 | 无/宽松校验 | 可达 | 漏洞 |
| true | 动态回显/通配符 | 无/宽松校验 | 不可达 | 风险-A |
| true | 动态回显/通配符 | 宽松校验 | 可达 | 风险-B |

### 2.2 研判流程

```
Step 1: Credentials 检查
  ├─ supports_credentials=False/未设置？ → 安全（终止）
  └─ True → 继续

Step 2: Origin 设置方式检查
  ├─ 静态特定域名列表？ → 安全（终止）
  ├─ setHeader("*")？ → 安全（浏览器拒绝，终止）
  └─ 动态回显/通配符 → 继续

Step 3: 白名单校验检查
  ├─ set/list contains 严格匹配？ → 安全（终止）
  ├─ startswith/endswith 宽松校验？ → 风险-B
  └─ 无校验 → 继续

Step 4: HTTP 入口可达性
  ├─ 无 HTTP 入口？ → 风险-A
  └─ 有 HTTP 入口 → 漏洞
```

### 2.3 框架通配符自动解析规则

| 框架/API | 危险配置 | 实际效果 |
|---------|---------|---------|
| flask-cors | `origins="*"` + `supports_credentials=True` | 部分版本解析 |
| django-cors-headers | `CORS_ALLOW_ALL_ORIGINS=True` + `CORS_ALLOW_CREDENTIALS=True` | 解析为请求的 Origin |
| fastapi | `allow_origins=["*"]` + `allow_credentials=True` | 解析为请求的 Origin |

### 2.4 降级条件表

| 条件 | 原结论 | 降级后 |
|------|--------|--------|
| supports_credentials=False | 漏洞 | 安全 |
| 静态特定域名 | 漏洞 | 安全 |
| 严格白名单校验 | 漏洞 | 安全 |
| 非线上环境 | 漏洞 | 安全 |
| startswith/endswith 宽松校验 | 漏洞 | 风险-B |
| 无 HTTP 入口可达 | 漏洞 | 风险-A |

---

## 3. 常见漏洞/风险场景

### 漏洞

```python
# flask-cors 通配符
CORS(app, origins="*", supports_credentials=True)  # 漏洞

# django-cors-headers 全允许
CORS_ALLOW_ALL_ORIGINS = True  # 漏洞
CORS_ALLOW_CREDENTIALS = True

# fastapi 通配符
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True)  # 漏洞

# 手动动态回显
response["Access-Control-Allow-Origin"] = request.headers.get("Origin")  # 漏洞
response["Access-Control-Allow-Credentials"] = "true"
```

### 风险-A

```python
def set_internal_cors(response, origin):
    response["Access-Control-Allow-Origin"] = origin
    response["Access-Control-Allow-Credentials"] = "true"
    return response  # 风险-A：需追踪调用方
```

### 风险-B

```python
if origin.startswith("https://api.trusted.com"):
    response["Access-Control-Allow-Origin"] = origin
    response["Access-Control-Allow-Credentials"] = "true"
# 风险-B：startswith 可被 https://api.trusted.com.evil.com 绕过
```

---

## 4. 常见防御模式

### Credentials 未启用

```python
CORS(app, origins="*", supports_credentials=False)  # 安全
```

### 静态特定域名

```python
# Flask
CORS(app, origins=["https://trusted1.com", "https://trusted2.com"], supports_credentials=True)

# Django
CORS_ALLOWED_ORIGINS = ["https://trusted1.com", "https://trusted2.com"]
CORS_ALLOW_CREDENTIALS = True
```

### 严格白名单校验

```python
ALLOWED_ORIGINS = {"https://trusted1.com", "https://trusted2.com"}
if origin in ALLOWED_ORIGINS:
    response["Access-Control-Allow-Origin"] = origin
    response["Access-Control-Allow-Credentials"] = "true"  # 安全
```

---

## 5. 检索技巧

### 搜索关键词

| 类型 | 关键词 |
|------|--------|
| Flask | `flask_cors.CORS`, `CORS(app` |
| Django | `CORS_ALLOWED_ORIGINS`, `CORS_ALLOW_ALL_ORIGINS`, `CORS_ALLOW_CREDENTIALS` |
| FastAPI | `CORSMiddleware`, `allow_origins`, `allow_credentials` |
| 手动设置 | `Access-Control-Allow-Origin` |
| 白名单 | `ALLOWED_ORIGINS`, `is_origin_allowed` |

### 检测命令

```bash
grep -rn "flask_cors\|CORS(app\|CORS_ALLOWED_ORIGINS\|CORS_ALLOW_ALL_ORIGINS\|CORSMiddleware\|Access-Control-Allow-Origin" --include="*.py"
```

---

## 6. 常见误判场景

### 陷阱1：flask-cors origins="*" 误判安全

**错误**: 看到 `*` 就认为会报错
**正确**: flask-cors 某些版本在 supports_credentials=True 时允许组合使用 → 漏洞

### 陷阱2：白名单函数未读实现

**错误**: 看到 `is_origin_allowed(origin)` 就认为有白名单
**正确**: 必须读取实现——endswith/startswith → 风险-B；实现缺失 → 无法确认

### 陷阱3：宽松校验误判安全

**错误**: `origin.startswith("https://api")` 是有效防护
**正确**: `https://api.evil.com` 可绕过 → 风险-B

### 陷阱4：忽略环境判断

**错误**: 未检查 `DEBUG` 或 `os.getenv("ENV")`
**正确**: `if DEBUG:` 限定的配置仅测试环境 → 安全

### 陷阱5：setHeader("*") 误判漏洞

**错误**: 手动设置 `*` + Credentials=true 是漏洞
**正确**: 浏览器直接拒绝 → 安全。**必须区分框架自动解析和手动设置**

### 陷阱6：|| 短路逻辑绕过白名单

**错误**: `is_debug_host() or is_whitelist_domain(origin)` 同时检查了 debug 和白名单 → 安全
**正确**: `or` 是短路或 — 当 `is_debug_host()` 返回 True 时，`is_whitelist_domain()` 不执行，白名单被完全绕过

**分析规则**：
- `or` 连接的条件必须独立分析每个分支
- 如果任一分支可在无安全校验的情况下返回 True → 该分支是绕过路径
- 必须追溯 `is_debug_host()`/`is_test_env()`/`is_debug_mode()` 等函数实现，确认返回 True 的场景

```python
# 危险：or 短路绕过
if is_debug_host() or is_whitelist_domain(origin):
    response["Access-Control-Allow-Origin"] = origin
    response["Access-Control-Allow-Credentials"] = "true"
    # is_debug_host() 在 debug/test/KCS 容器/KWS candidate 机器上返回 True
    # → 任意 Origin 被回显 + Credentials=true → 完整 CORS 漏洞
```

---

## 7. 特殊风险

### Django CORS Middleware 注意事项

`django-cors-headers` 中 `CORS_ALLOW_ALL_ORIGINS = True` + `CORS_ALLOW_CREDENTIALS = True` 构成漏洞。`CORS_ALLOWED_ORIGINS` 列表匹配是精确匹配，不含通配符支持。

---

## 8. 变更影响分析

| 变更类型 | 变更内容 | 风险 |
|----------|----------|------|
| 新增 | 新增 CORS()/CORSMiddleware 调用 | 确认 origins + credentials 配置 |
| 修改 | 移除白名单校验 | 扩大攻击面 |
| 修改 | 静态域名改为通配符 | 从安全变为不安全 |
| 修改 | 添加 supports_credentials=True | 从安全变为不安全 |
| 删除 | 删除白名单校验/环境判断 | 移除防护 |

## 9. 质量门禁（强制执行）

在输出审计结论前，按顺序验证：

- [ ] 强制执行顺序已遵守（先检查 Credentials 和 Origins 设置方式）
- [ ] supports_credentials=False 直接终止
- [ ] 白名单校验函数已读取实现
- [ ] HTTP 入口可达性已确认，非假设
- [ ] 结论与证据一致，配置位置可追溯
- [ ] 白名单校验的逻辑条件已分析（|| 短路绕过风险，每个分支独立分析）

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**
