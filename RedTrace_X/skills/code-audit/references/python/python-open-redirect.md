# 开放重定向

## 0. 黄金法则

> **漏洞存在性判断 优先于 防护有效性判断**
>
> 仅 path/query 可控 = 无 开放重定向（这是漏洞本质判断，不是防护有效判断）
>
> 满足此条件时：立即终止分析，无需检查任何防护措施。

**强制执行顺序**：
1. **首先**：找到 sink 点重定向代码（如 `redirect()`, `HttpResponseRedirect()`）
2. **然后**：执行 URL 结构拆解，判断用户输入位置
3. **仅当** Host/Scheme 可控时，才继续检查防护措施
4. **禁止**：一上来就检查"有没有白名单"、"A 有 B 没有"

---

## 1. 结论判断标准

| 结论 | 定义 | 判定条件 |
|------|------|----------|
| **漏洞** | 用户输入可到达重定向点，Host/Scheme 可控且无有效防护 | 重定向调用 + Host/Scheme 可控 + HTTP 入口可达 + 无有效防护 |
| **风险-A** | 重定向存在但无 HTTP 入口可达 | 重定向调用 + 无外部入口 |
| **风险-B** | 重定向有入口可达，但防护不充分 | 重定向调用 + HTTP 入口 + 弱防护（仅协议白名单/endswith/contains） |
| **安全** | 无危险写法，或有充分防护 | 仅 path/query 可控 / 白名单 / 域名校验 / 枚举映射 / Django url_has_allowed_host_and_scheme |

---

## 2. 研判思路

### 2.1 Sink 点与 URL 结构拆解（第一优先级）

| Sink 点 | 框架 | 危险级别 |
|---------|------|----------|
| `redirect(url)` | Flask/Django | 高 |
| `HttpResponseRedirect(url)` | Django | 高 |
| `RedirectResponse(url=url)` | FastAPI | 高 |

找到 sink 点后，将 URL 拆解为 `Scheme + Host + Port + Path + Query + Fragment`：

| 用户输入位置 | 代码示例 | 结论 |
|------------|----------|------|
| 仅在 Path | `redirect(f"https://example.com{path}")` | 安全（终止） |
| 仅在 Query | `redirect(f"https://example.com/api?id={input}")` | 安全（终止） |
| Host 部分 | `redirect(f"https://{host}/api")` | 需继续研判 |
| 完整 URL | `redirect(user_input)` | 需继续研判 |
| 枚举/Map 查找 | `REDIRECT_MAP.get(input)` | 安全（终止） |

### 2.2 研判流程

```
Step 1: URL 结构拆解 【终止点】
  ├─ 仅 path/query 可控 / 枚举映射？ → 安全（终止）
  └─ Host/Scheme 可控 → 继续

Step 2: 白名单检查 【终止点】
  ├─ 完整 URL 白名单 / 域名白名单（urlparse.netloc 检查）？ → 安全（终止）
  └─ 无白名单 → 继续

Step 3: Django 安全函数检查 【终止点】
  ├─ url_has_allowed_host_and_scheme（Django ≥ 3.0）？ → 安全（终止）
  └─ 无 → 继续

Step 4: 防护强度检查
  ├─ 仅协议白名单 / endswith / contains 弱验证？ → 风险-B
  └─ 无防护 → 继续

Step 5: HTTP 入口可达性 【终止点】
  ├─ 无 HTTP 入口？ → 风险-A
  └─ 有 HTTP 入口 → 漏洞
```

### 2.3 降级条件表

| 条件 | 原结论 | 降级后 |
|------|--------|--------|
| 仅 path/query 可控 | 漏洞 | 安全 |
| 完整白名单 / 域名白名单（urlparse.netloc） | 漏洞 | 安全 |
| url_has_allowed_host_and_scheme（Django ≥ 3.0） | 漏洞 | 安全 |
| 枚举映射 | 漏洞 | 安全 |
| 非线上环境 | 漏洞 | 安全 |
| 仅协议白名单 / endswith / contains | 漏洞 | 风险-B |
| 无 HTTP 入口可达 | 漏洞 | 风险-A |

### 2.4 总结判定表

| 检查项 | 结论 |
|--------|------|
| 仅 path/query 可控（BASE_URL 含完整 scheme://host） | 安全 |
| 白名单 / 域名校验 / url_has_allowed_host_and_scheme | 安全 |
| Host/Scheme 可控 + 无防护 + HTTP 入口 | 漏洞 |
| Host/Scheme 可控 + 弱防护（协议/endswith/contains） | 风险-B |
| 无 HTTP 入口 | 风险-A |

---

## 3. 常见漏洞/风险场景

### 漏洞

```python
# 直接重定向用户输入
@app.route('/redirect')
def handler():
    url = request.args.get('url')
    return redirect(url)  # 漏洞

# 子域名可控
subdomain = request.args.get('tenant')
return redirect(f"https://{subdomain}.example.com")  # 漏洞
```

### 风险-B（防护不足）

```python
# 仅协议校验
if url.startswith(('http://', 'https://')):
    return redirect(url)  # 风险-B：域名仍可控

# contains 子串匹配（可被 evil.com?example.com 绕过）
if 'example.com' in url:
    return redirect(url)  # 风险-B

# endswith 匹配（可被 evil.com.example.com 绕过）
if url.endswith('.example.com'):
    return redirect(url)  # 风险-B
```

---

## 4. 常见防御模式

### 白名单 / 域名校验

```python
# 完整 URL 白名单
ALLOWED_REDIRECTS = ['https://auth.example.com']
if next_url in ALLOWED_REDIRECTS:
    return redirect(next_url)

# 域名白名单
from urllib.parse import urlparse
ALLOWED_DOMAINS = ['example.com']
if urlparse(next_url).netloc in ALLOWED_DOMAINS:
    return redirect(next_url)
```

### Path 可控但 Host 固定 / 枚举映射

```python
# Host 固定
BASE_URL = 'https://example.com'
return redirect(f"{BASE_URL}{path}")  # 安全

# 枚举映射
REDIRECT_MAP = {'home': '/home', 'profile': '/profile'}
target = REDIRECT_MAP.get(user_choice, default_url)  # 安全
```

### Django url_has_allowed_host_and_scheme

```python
from django.utils.http import url_has_allowed_host_and_scheme
if url_has_allowed_host_and_scheme(url, allowed_hosts=['example.com']):
    return redirect(url)  # 安全（Django ≥ 3.0）
```

> 注意：Django < 1.11 的 `is_safe_url` 存在 CVE-2017-7233 可被绕过，需确认版本。

---

## 5. 检索技巧

### 搜索关键词

| 类型 | 关键词 |
|------|--------|
| 重定向 | `redirect(`, `HttpResponseRedirect`, `RedirectResponse` |
| URL 解析 | `urlparse`, `netloc`, `hostname` |
| 校验函数 | `ALLOWED`, `is_safe_url`, `url_has_allowed_host_and_scheme` |

### 检测命令

```bash
# 检测重定向
grep -rn "redirect(\|HttpResponseRedirect" --include="*.py"

# 检测白名单
grep -rn "ALLOWED.*URL\|WHITELIST" --include="*.py"

# 检测域名校验
grep -rn "urlparse\|netloc\|url_has_allowed_host_and_scheme" --include="*.py"
```

---

## 6. 常见误判场景

### 陷阱1：参数位置误判

**错误**: 看到 `user_id` 就认为可控
**正确**: `user_id` 仅用于 query 参数，BASE_URL 决定域名 → 安全

### 陷阱2：Django is_safe_url 版本问题

**错误**: 看到 `is_safe_url` 就认为安全
**正确**: Django < 1.11 存在 CVE-2017-7233 可被绕过 → 需确认版本

### 陷阱3：弱验证误判

**错误**: 看到 `url.endswith('.example.com')` 就认为安全
**正确**: endswith/contains 可被绕过 → 漏洞/风险-B

### 陷阱4：先看防护，后看漏洞本质

**错误思路**：发现代码缺少白名单 → 判定风险
**正确思路**：先判断漏洞是否存在（URL 拆解 → 仅 path 可控 → 无开放重定向）

> 漏洞存在性判断 > 防护有效性判断。仅 path/query 可控 = 无开放重定向。

### 陷阱5：被代码对比干扰

**错误判定**：A 有白名单 B 没有 → B 有风险
**正确判定**：先看 B 漏洞是否存在（Host/Scheme 是否可控），再谈防护

> 代码不一致 ≠ 安全问题。

---

## 7. 特殊风险

### URL 编码绕过

`%2F%2Fevil.com` URL 解码后为 `//evil.com`，可绕过仅检查 `//` 的防护。防护时需先 URL 解码再检查。

---

## 8. 变更影响分析

| 变更类型 | 变更内容 | 风险 |
|----------|----------|------|
| 新增 | 新增 `redirect()` / `RedirectResponse` 调用 | 确认 URL 构造方式 |
| 新增 | 新增用户可控 URL 参数 | 数据流追踪 |
| 修改 | 移除白名单 / 域名校验 | 移除防护 |
| 修改 | 改用不完整前缀拼接 | Host 变为可控 |
| 修改 | 移除环境判断 | 代码可能在线上执行 |
| 删除 | 删除域名白名单 / 枚举映射 | 移除防护 |

---

## 9. 质量门禁（强制执行）

在输出审计结论前，按顺序验证：

- [ ] 强制执行顺序已遵守（先 URL 结构拆解，后防护检查）
- [ ] 仅 path/query 可控时已正确终止（无需检查防护）
- [ ] HTTP 入口可达性已确认，非假设
- [ ] Django `is_safe_url` 版本已确认（< 1.11 不安全）
- [ ] 结论与证据一致，代码行号可追溯
- [ ] 已应用误报排除规则（协议校验 ≠ 安全、endswith/contains 可绕过）
- [ ] 不因代码对比而判定风险

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**
