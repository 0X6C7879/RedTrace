# 威胁清单下游消费（Threat Consumption）

将 arch-scan 产出的 STRIDE 威胁模型结果供下游模式消费，避免威胁建模沦为孤立产物。

---

## 数据源

arch-scan Step 5.7 在 .redtrace/code-audit/PROJECT_CONTEXT.md 的 `## Threat Model` 章节产出三类条目：

```
ASSET: 用户订单数据 | 暴露面: REST API | 保护级别: 高
ENTRY: /api/users/{id} | actor: 已认证用户 | surface: REST Controller
STRIDE-I: 篡改用户订单状态 | actor: 已认证用户 | surface: UserController.updateOrder | 影响: 金额篡改 | 状态: 待验证
STRIDE-E: 权限提升 | actor: 普通用户 | surface: AdminController.promote | 影响: 获取管理员权限 | 状态: 待验证
```

---

## 消费方法

### 1. 提取威胁条目

从 .redtrace/code-audit/PROJECT_CONTEXT.md `## Threat Model` 章节中 grep 出 `STRIDE-{S,T,R,I,D,E}:` 行：

```bash
grep "^STRIDE-" .redtrace/code-audit/PROJECT_CONTEXT.md
```

每行格式契约：`STRIDE-{类}: 描述 | actor:X | surface:Y | 影响:Z | 状态:W`

### 2. 按文件/方法匹配 Finding

对每个 finding，从 `affected_locations[0].file_path` 和 `entry_point` 提取文件名和方法名，
与 STRIDE 条目的 `surface` 字段模糊匹配（文件名包含即可）。

### 3. 威胁匹配影响

- 匹配 ≥1 个 STRIDE 威胁 → severity 允许 +1（**禁止跨两级**）
- 始终受 `conclusion` 天花板封顶（如 conclusion=risk → 最高 medium）
- `description` 追加 `[THREAT-MATCH: STRIDE-I, STRIDE-E]` 标签

---

## 下游消费模式

### api-audit
- Step 0「加载威胁清单」：对 .redtrace/code-audit/PROJECT_CONTEXT.md Threat Model 章节 grep 排序（高威胁优先审）
- Step 4.5：finding 与 STRIDE 匹配，命中则 severity +1（不超天花板），description 加标签

### report-review
- Step 2.3.5 / Step 2.4：威胁匹配允许 +1（与 severity 抗通胀协同）

### mr-review
- Step 6.5：变更代码涉及 STRIDE surface 时，威胁匹配允许 +1

### security-assessment
- Step 1：扩展消费 STRIDE 标签构造风险链路优先级

### arch-scan
- Step 5.7.3：**固定 STRIDE 输出格式契约**（确保下游 grep 稳定）

---

## 格式契约（arch-scan Step 5.7.3 必须）

每行 STRIDE 条目必须包含以下字段，用 ` | ` 分隔：

```
STRIDE-{S|T|R|I|D|E}: {威胁描述} | actor: {威胁主体} | surface: {文件名.方法名} | 影响: {影响描述} | 状态: {待验证|已确认|已缓解}
```

**禁止格式**：
- ❌ `STRIDE-I: 某威胁（影响：xxx）` — 括号嵌套，grep 不稳定
- ❌ 多行描述 — 必须单行
- ❌ 缺少 `surface` 字段 — 下游无法匹配

---

## 匹配算法

1. 逐行解析 .redtrace/code-audit/PROJECT_CONTEXT.md Threat Model 中以 `STRIDE-` 开头的行
2. 提取每行的 `surface:` 字段值
3. 若 finding 的 `file_path` 或 `method_name` 出现在 surface 值中 → 命中该 STRIDE 威胁
4. 返回所有命中的 STRIDE 类型列表（如 `[STRIDE-I, STRIDE-E]`）

---

## 约束

- **不改 .redtrace/code-audit/PROJECT_CONTEXT.md 模板** — 仅消费已存在内容
- **不改输出 schema** — 威胁匹配信号写入 `description` 自由文字
- **severity +1 须受 conclusion 天花板封顶**
- **禁止跨两级** — 命中 STRIDE 最多升一级
