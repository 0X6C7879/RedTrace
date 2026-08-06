# Web 调试模式开启

## 0. 黄金法则

> **漏洞存在性判断 优先于 防护有效性判断**
>
> debug=False 或 环境判断生效 = 无 调试模式漏洞（这是漏洞本质判断，不是防护有效判断）
>
> 满足此条件时：立即终止分析，无需检查任何防护措施。

---

## 1. 结论判断标准

| 结论 | 定义 | 判定条件 |
|------|------|----------|
| **漏洞** | 生产环境开启调试模式，外部可访问 | debug=True 硬编码 + 无环境判断 + host='0.0.0.0' |
| **风险-A** | 调试模式仅内网可访问 | debug=True + host='127.0.0.1' / 非生产环境 |
| **风险-B** | 调试模式有防护但可能被绕过 | 环境判断逻辑不完整 |
| **安全** | debug=False 或环境判断正确保护 | debug=False / 环境变量保护 / 已注释代码 |

---

## 2. 研判思路

### 2.1 框架 debug 配置点（第一优先级）

| 框架 | 配置位置 |
|------|----------|
| Flask | `app.run(debug=True)` / `app.config['DEBUG'] = True` |
| Django | `settings.py` 中 `DEBUG = True` |
| FastAPI | `app = FastAPI(debug=True)` |

### 2.2 研判流程

```
Step 1: 代码状态检查 【终止点】
  ├─ 代码被注释或不生效？ → 安全（终止）
  └─ 代码正常生效 → 继续

Step 2: 变量性质检查 【终止点】
  ├─ logger.debug() 调用？ → 安全（终止）
  ├─ 自定义 debug 字段（非框架配置）？ → 安全（终止）
  └─ 框架 debug 配置 → 继续

Step 3: 环境判断检查 【终止点】
  ├─ 有正确的环境变量判断？ → 安全（终止）
  ├─ 环境判断逻辑有缺陷？ → 风险-B
  └─ 无环境判断 → 继续

Step 4: 访问限制检查
  ├─ host='127.0.0.1' / host='localhost'？ → 风险-A（本地访问）
  ├─ host='0.0.0.0' 或默认？ → 漏洞（外部可访问）
  └─ 有反向代理/防火墙限制？ → 风险-A
```

---

## 3. 常见漏洞/风险场景

### 漏洞

```python
# Flask 硬编码 debug=True
app.run(debug=True, host='0.0.0.0')  # 漏洞

# Django 硬编码 DEBUG=True
DEBUG = True  # 漏洞（生产环境）
```

### 风险-B（判断逻辑不完整）

```python
# 环境判断不完整
if os.getenv('ENV') != 'production':  # 风险-B：空值也满足
    app.run(debug=True)
```

---

## 4. 常见防御模式

### 环境变量保护

```python
# Flask
debug = os.getenv('FLASK_DEBUG', 'false').lower() == 'true'
app.run(debug=debug)  # 安全

# Django
DEBUG = os.getenv('DJANGO_DEBUG', 'False').lower() == 'true'  # 安全
```

### 本地访问限制

```python
app.run(debug=True, host='127.0.0.1')  # 风险-A：仅本地
```

---

## 5. 检索技巧

### 搜索关键词

| 类型 | 关键词 |
|------|--------|
| Flask debug | `app.run(debug`, `DEBUG =`, `app.config['DEBUG']` |
| Django debug | `DEBUG = True` |

### 检测命令

```bash
grep -rn "debug\s*=\s*True\|DEBUG\s*=\s*True" --include="*.py"
grep -rn "app\.run(debug" --include="*.py"
```

---

## 6. 常见误判场景

### 陷阱1：logger.debug 误判

**错误**: 看到 debug=True 就判为漏洞
**正确**: `logger.debug()` 是日志调用，非框架配置 → 安全

### 陷阱2：注释代码误判

**错误**: 看到 `# app.run(debug=True)` 就判为漏洞
**正确**: 已注释代码不生效 → 安全

### 陷阱3：自定义 debug 字段误判

**错误**: 看到对象属性 `config.debug = True` 就判为漏洞
**正确**: 自定义字段，非框架 debug 模式 → 安全

---

## 7. 特殊风险

### Flask Werkzeug 调试器交互执行

`debug=True` 启用 Werkzeug 调试器后，访问 `/console` 可执行任意 Python 代码。即使 `host='127.0.0.1'`，若服务器存在 SSRF 漏洞，仍可通过 SSRF 触发调试器 RCE。

### logger.debug vs 框架 debug

`logger.debug("message")` 是日志级别调用，与框架调试模式无关。`app.run(debug=True)` 是 Flask 框架调试模式开关。两者完全不同，不可混淆。

---

## 8. 变更影响分析

| 变更类型 | 变更内容 | 风险 |
|----------|----------|------|
| 新增 | 新增 debug=True 硬编码 | 确认环境判断 |
| 修改 | 从环境变量改为 True | 引入漏洞 |
| 修改 | 从 host='127.0.0.1' 改为 '0.0.0.0' | 扩大访问面 |

---

## 9. 质量门禁（强制执行）

在输出审计结论前，按顺序验证：

- [ ] 代码是否生效已确认（非注释）
- [ ] 是框架 debug 配置（非 logger.debug/自定义字段）
- [ ] 环境判断逻辑正确性已确认
- [ ] host 访问限制已确认
- [ ] 结论与证据一致，代码行号可追溯

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**
