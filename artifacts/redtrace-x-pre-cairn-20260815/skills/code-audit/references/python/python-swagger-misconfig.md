# Swagger/OpenAPI 不安全配置（Python）

## 0. 黄金法则

> **漏洞存在性判断 优先于 防护有效性判断**
>
> docs_url/redoc_url 设为 None 或 Swagger 仅限开发环境 = 无 Swagger 不安全配置
>
> 满足此条件时：立即终止分析，无需检查任何防护措施。

---

## 1. 结论判断标准

| 结论 | 定义 | 判定条件 |
|------|------|----------|
| **漏洞** | 生产环境 Swagger UI 无认证对外暴露 | 框架默认启用 Swagger + 无环境判断 + 无认证保护 |
| **风险-A** | Swagger UI 仅内网可访问 | host 限制 / 非 0.0.0.0 绑定 |
| **风险-B** | Swagger UI 有防护但可能被绕过 | 环境判断逻辑不完整 |
| **安全** | Swagger 已关闭或仅限开发环境 | `docs_url=None` / `doc=False` / 环境变量保护 |

---

## 2. 子模式详解

### 2.1 Pattern S1: FastAPI 默认 docs 未禁用

**识别特征**：`FastAPI()` 未设置 `docs_url=None, redoc_url=None`

```python
# 漏洞：默认启用 /docs 和 /redoc
app = FastAPI(title="My API")  # /docs 和 /redoc 默认可访问

# 安全：显式禁用
app = FastAPI(docs_url=None, redoc_url=None)
```

```python
# 安全：环境判断保护
if os.getenv("APP_ENV") == "dev":
    app = FastAPI()
else:
    app = FastAPI(docs_url=None, redoc_url=None)
```

### 2.2 Pattern S2: Flask-RESTX 默认暴露 Swagger UI

**识别特征**：`Api(app)` 未设置 `doc=False`

```python
# 漏洞：默认暴露 /swagger-ui
api = Api(app)  # / 和 /swagger.json 默认可访问

# 安全：禁用文档
api = Api(app, doc=False)
```

### 2.3 Pattern S3: drf-yasg 无权限保护

**识别特征**：`SchemaView` 未配置 `permission_classes`

```python
# 漏洞：无认证保护
urlpatterns = [
    path('swagger/', schema_view.with_ui('swagger')),
]

# 安全：使用 permission_classes 限制访问
from rest_framework.permissions import IsAdminUser

urlpatterns = [
    path('swagger/', schema_view.with_ui('swagger',
         permission_classes=[IsAdminUser])),
]
```

### 2.4 Pattern S4: FastAPI openapi_url 暴露 JSON Schema

**识别特征**：`openapi_url` 未禁用，暴露完整 API 定义

```python
# 漏洞：即使禁用 docs，openapi_url 仍暴露 JSON
app = FastAPI(docs_url=None, redoc_url=None)  # /openapi.json 仍可达

# 安全：彻底禁用
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
```

---

## 3. 检测命令

```bash
# 检测 FastAPI 实例化
grep -rn "FastAPI(" --include="*.py"

# 检测 Flask-RESTX
grep -rn "Api(\|flask-restx\|flask_restx" --include="*.py"

# 检测 drf-yasg
grep -rn "drf-yasg\|get_schema_view\|SchemaView" --include="*.py"

# 检测 docs_url / redoc_url 配置
grep -rn "docs_url\|redoc_url\|openapi_url\|doc=False" --include="*.py"
```

---

## 4. 误报排除规则

| 场景 | 判定 | 原因 |
|------|------|------|
| `docs_url=None, redoc_url=None, openapi_url=None` | 安全 | 显式关闭 |
| `doc=False`（Flask-RESTX） | 安全 | 禁用文档 |
| 有认证中间件保护 Swagger 路径 | 安全 | 需登录访问 |
| 仅在 `if __name__ == "__main__"` 中启用 | 安全 | 开发调试 |
| FastAPI `openapi_url` 设为 None | 安全 | 彻底禁用 |
| 自定义 `/docs` 路径非框架 Swagger | 安全 | 非框架配置 |

---

## 5. 变更影响分析

| 变更类型 | 风险 |
|----------|------|
| 新增 `FastAPI()` 无 `docs_url=None` | 检查生产环境是否暴露 |
| 从 `docs_url=None` 改为默认 | 从安全变为不安全 |
| 新增 `Api(app)` 无 `doc=False` | 引入 Swagger UI 暴露 |
| 移除 `permission_classes` 保护 | 引入未认证访问 |

---

## 6. 质量门禁（强制执行）

- [ ] 框架类型已识别（FastAPI / Flask-RESTX / drf-yasg）
- [ ] docs_url / redoc_url / openapi_url 配置状态已确认
- [ ] 认证中间件对 Swagger 路径的保护已确认
- [ ] 环境判断逻辑正确性已确认
- [ ] 结论与证据一致，代码行号可追溯

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**
