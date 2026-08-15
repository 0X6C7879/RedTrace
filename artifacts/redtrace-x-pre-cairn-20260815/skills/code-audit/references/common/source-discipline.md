# 来源纪律标签

定义防护措施描述的来源标签体系，用于标识防护结论的证据来源，辅助判定 confidence。

---

## 三类来源标签

| 标签 | 含义 | confidence 影响 | 适用场景 |
|------|------|----------------|---------|
| `[Code-verified]` | 代码追踪验证的防护 | 不打折（维持原 confidence） | 在代码中明确看到防护逻辑并验证其有效性 |
| `[Config-assumed]` | 框架/配置默认假设 | **降权**（confidence ×0.8，最低 0.3） | 假设 Spring `@Valid` 默认生效、假设框架全局过滤器存在 |
| `[Docs-stated]` | 来自文档/.redtrace/code-audit/PROJECT_CONTEXT.md 声明 | **降权**（confidence ×0.8，最低 0.3） | .redtrace/code-audit/PROJECT_CONTEXT.md 记录了防护但未在代码中验证 |

---

## 使用规则

1. 每条防护措施的 `description` 必须以三类标签之一起首
2. 同一防护措施只能选一个标签（选证据最强的来源）
3. `[Code-verified]` 优先于 `[Config-assumed]` 优先于 `[Docs-stated]`
4. 未标注来源标签的防护措施 → 默认视为 `[Config-assumed]` + 降权

---

## confidence 降权规则

- `[Code-verified]` → confidence 不降
- `[Config-assumed]` / `[Docs-stated]` → confidence × 0.8（最低 0.3）
- 未知标签 → confidence 不降

---

## 典型示例

| 场景 | 标签 | 说明 |
|------|------|------|
| Read 代码看到 `@AuthCheck` 注解且拦截器路径匹配 | `[Code-verified]` | 代码验证 |
| 假设 Spring `@Valid` 默认做参数校验 | `[Config-assumed]` | 框架默认 |
| .redtrace/code-audit/PROJECT_CONTEXT.md 记录「全局认证拦截器覆盖 /api/*」 | `[Docs-stated]` | 文档声明 |
