# 严重程度评级标准

本文档定义 `severity` 字段的评级规则。适用于 api-audit、mr-review、report-review 模式。

---

## 核心原则

- severity = `clamp(基础等级 + 利用难度调节 + 数据敏感度调节, conclusion天花板)`
- 等级排序：`critical > high > medium > low > info`
- **conclusion 天花板**（优先级最高）：

| conclusion | severity 上限 |
|------------|--------------|
| vulnerability | 不封顶 |
| risk-b | **high** |
| risk-a | **medium** |
| unknown | **low** |
| safe | 固定 **info** |

---

## 一、维度一：漏洞类型基础等级

| 基础等级 | 漏洞类型 |
|---------|---------|
| **critical** | RCE、反序列化（可 RCE）、SSTI |
| **high** | SQL 注入、SSRF（可访问内网）、XXE、路径遍历、存储型 XSS、文件上传（可执行文件） |
| **medium** | 反射型 XSS、CSRF、NoSQL 注入、JWT 问题、原型链污染、格式化字符串 |
| **low** | 开放重定向、CORS、硬编码凭据、信息泄露（非敏感）、Debug 开启、Swagger 不安全配置（暴露敏感基础设施信息时升至 medium） |
| **info** | 代码质量、最佳实践建议 |

### IDOR 基础等级（由数据级别直接决定，不再叠加维度三）

IDOR 危害完全取决于越权访问的数据，基础等级直接映射为数据级别：

| 数据级别 | 基础等级 | 说明 |
|---------|---------|------|
| L4 敏感（密码、支付、token、PII） | **high** | 手机号/身份证号/支付记录/认证 token |
| L3 受限（团队、好友、项目） | **medium** | 需权限或关系验证的资源 |
| L2 内部（组织架构、内部文档） | **low** | 登录即可访问的内部资源 |
| L1 公开（公告、帮助文档） | **low** | 无需登录即可访问的公开资源 |

> L1-L4 定义详见 `references/{lang}/{lang}-idor.md` Step 2.05。

---

## 二、维度二：利用难度（从代码推断）

三个子因子，**取最大调节值**：

| 子因子 | 容易 (+1) | 普通 (0) | 困难 (-1) |
|--------|----------|---------|----------|
| **认证要求** | 无 auth middleware、公开接口 | 需登录（普通用户） | 需管理员/特殊角色 |
| **用户交互** | 无需（SQLi、RCE、IDOR、SSRF 等） | 一次（反射 XSS、CSRF） | 多次交互/社会工程 |
| **ID 可预测性**（仅 IDOR） | 自增 ID | 雪花 ID | UUID/Hash ID |

> 非IDOR漏洞仅取「认证要求」和「用户交互」两个子因子。

---

## 三、维度三：数据敏感度（从代码推断）

**仅适用于通用漏洞。IDOR 已在基础等级中内置，跳过此步。**

| 调节 | 代码特征 |
|------|---------|
| **+1** | 密码、支付、token、PII；可批量获取（无 LIMIT/无分页）；金融操作 |
| **0** | 内部业务数据、配置信息、单条记录 |
| **-1** | 公开数据、无业务数据、仅返回成功/失败 |

---

## 四、IDOR专项快速判定表

> IDOR 占日常扫描量最大，直接查表。

### [表4.1] 基础判定表（考虑数据级别）

**前提条件**：IDOR 要求接口必须有认证机制（登录态、Token 等）。无认证场景应定性为 BrokenAccessControl（未授权子类型），不使用本判定表。

| 数据级别 | 批量/单条 | ID类型 | 认证 | 基础severity |
|---------|----------|--------|------|-------------|
| **L4 敏感** | 批量 | 自增 | 需登录 | **high** |
| L4 敏感 | 批量 | 自增 | 需管理员 | **medium** |
| L4 敏感 | 单条 | 自增 | 需登录 | **high** |
| L4 敏感 | 单条 | 雪花/UUID | 需登录 | **medium** |
| **L3 受限** | 批量 | 自增 | 需登录 | **high** |
| L3 受限 | 单条 | 自增 | 需登录 | **medium** |
| L3 受限 | 单条 | 雪花/UUID | 需登录 | **low** |
| **L2 内部** | 单条 | 自增 | 需登录 | **medium** |
| L2 内部 | 单条 | UUID | 需登录 | **low** |
| **L1 公开** | 任意 | 任意 | 任意 | **不报告** |

> **注意**：无认证接口访问敏感数据，应定性为 BrokenAccessControl（使用 BrokenAccessControl 评级标准），不属于 IDOR 范畴。

### [表4.2] 读写操作调整表

| 操作类型 | 基础severity | 调整后severity | 说明 |
|---------|-------------|---------------|------|
| 查询（GET） | [表4.1]值 | [表4.1]值 | 无调整 |
| 修改（PUT/PATCH） | [表4.1]值 | [表4.1]值 **+1** | 数据篡改风险 |
| 删除（DELETE） | [表4.1]值 | [表4.1]值 **+1** | 数据破坏风险 |
| 创建（POST） | [表4.1]值 | [表4.1]值 | 无调整 |

**上限**: critical（即使 L3 + 批量 + 删除，最高为 critical）

**特殊升级规则**：
- 修改操作若涉及**金额字段**或**权限字段** → 直接升级为 **critical**
- 批量删除 → **critical**（数据破坏范围大）

### [表4.3] 返回数据类型降级表（仅读操作）

| 返回类型 | severity调整 | 说明 |
|---------|-------------|------|
| 布尔值（boolean） | 固定 **low** | 攻击价值极低 |
| 统计数据（count/sum） | 固定 **low** | 无隐私泄露 |
| 已公开数据（搜索可见） | **不报告** | 无访问控制需求 |
| 部分 PII（仅昵称/头像） | [表4.1]值 **-1** | 低敏感度 |

### 4.4 最终计算公式

```
severity = clamp(
    基础severity（[表4.1]）
    + 读写调整（[表4.2]）
    + 返回数据调整（[表4.3]）,
    conclusion天花板
)
```

**天花板限制**：
- conclusion = vulnerability → severity ≤ critical
- conclusion = risk-b → severity ≤ high
- conclusion = risk-a → severity ≤ medium
- conclusion = safe → severity = info

### 4.5 完整判定示例

| 场景 | 数据级别 | ID类型 | 操作 | 批量 | 认证 | 返回类型 | 基础值 | 调整 | 最终severity |
|------|---------|--------|------|------|------|---------|--------|------|-------------|
| 查询他人完整PII | L4 | 自增 | GET | 单条 | 需登录 | 完整PII | high | 0 | **high** |
| 查询他人文档（UUID） | L3 | UUID | GET | 单条 | 需登录 | 业务数据 | low | 0 | **low** |
| 删除他人订单 | L4 | 自增 | DELETE | 单条 | 需登录 | - | high | +1 | **critical** |
| 批量查询受限数据 | L3 | 自增 | GET | 批量 | 需登录 | 业务数据 | high | 0 | **high** |
| 查询是否收藏 | L3 | 自增 | GET | 单条 | 需登录 | boolean | medium | 强制low | **low** |
| 查询用户昵称头像 | L4 | 自增 | GET | 单条 | 需登录 | 已公开 | high | 不报告 | **不报告** |
| 修改他人金额配置 | L4 | 自增 | PUT | 单条 | 需登录 | - | high | critical | **critical** |

> 以上示例均假设 conclusion = vulnerability

### 4.6 UUID 对结论和 severity 的完整影响链

**关键规则**：UUID 不可枚举 → 漏洞可利用性降低 → conclusion 降级为 risk-b → severity 天花板受 risk-b 限制（≤ high）

**完整示例**：

| 步骤 | 判定 | 依据 |
|------|------|------|
| 1. 基础等级 | L3 + 单条 + GET = medium | [表4.1] |
| 2. ID 类型检查 | UUID → 不可枚举 | false-positive-filtering.md 3.2.4 |
| 3. 单条查询 + UUID | 不可实际利用（无法遍历预测ID） | IDOR 依赖 ID 可枚举性 |
| 4. conclusion | **risk-b** | 有入口但利用困难 |
| 5. severity 天花板 | risk-b ≤ **high** | conclusion 天花板表 |
| 6. 可利用性进一步降级 | UUID + 单条查询 → 实际不可利用 | false-positive-filtering.md 3.2.4：不可枚举 ID + 单条查询 → 降为 risk-b 或不报告 |
| 7. 最终 severity | **low** 或不报告 | [表4.1] 中 UUID 列的基础值已为 low，risk-b 天花板不影响 low |

> **注意**：步骤 5 到 7 的逻辑链——risk-b 天花板为 high，但 UUID 本身在[表4.1] 中将基础值降到了 low（如 L3+UUID=low），所以最终 severity 直接落在 low。只有 L4+UUID 的基础值仍为 medium，此时 risk-b 天花板限制为 high，但结合 3.2.4 的"不可枚举 + 单条"规则仍建议进一步降为 low 或不报告。

---

## 五、[表5] 通用快速判定表

> 未覆盖的场景按公式逐步计算：基础等级 + 利用难度 + 数据敏感度，再应用 conclusion 天花板。

| 漏洞 | 认证 | 交互 | 数据 | conclusion | severity |
|------|------|------|------|-----------|----------|
| SQL 注入 + PII + 批量 | 无需 | 无需 | +1 | vulnerability | **critical** |
| SQL 注入 + PII | 无需 | 无需 | +1 | vulnerability | **critical** |
| SQL 注入 | 需登录 | 无需 | 0 | vulnerability | **high** |
| SQL 注入 + 管理员接口 | 需管理员 | 无需 | 0 | vulnerability | **medium** |
| SQL 注入 | — | — | — | risk-a | ≤ **medium** |
| RCE | 无需/需登录 | 无需 | — | vulnerability | **critical** |
| RCE | 需管理员 | 无需 | — | vulnerability | **high** |
| RCE | — | — | — | risk-b | ≤ **high** |
| 反序列化（可 RCE） | 任意 | 无需 | — | vulnerability | **critical** |
| SSTI | 无需/需登录 | 无需 | — | vulnerability | **critical** |
| SSRF + 内网全量访问 | 无需 | 无需 | 内网 | vulnerability | **critical** |
| SSRF + 内网访问 | 需登录 | 无需 | 内网 | vulnerability | **high** |
| SSRF + 代理可绕过 | 需登录 | 无需 | 内网 | vulnerability | **high** |
| SSRF | — | — | — | risk-a | ≤ **medium** |
| 存储型 XSS + 全量用户 | 任意 | 无需 | — | vulnerability | **high** |
| 存储型 XSS + 部分用户 | 需登录 | 无需 | — | vulnerability | **medium** |
| 反射型 XSS | 任意 | 一次 | — | vulnerability | **medium** |
| XXE + 文件读取 | 无需 | 无需 | 敏感文件 | vulnerability | **high** |
| 路径遍历 + 敏感文件 | 无需 | 无需 | +1 | vulnerability | **high** |
| 路径遍历 | 需登录 | 无需 | 0 | vulnerability | **high** |
| 文件上传 + 可执行 | 需登录 | 无需 | — | vulnerability | **high** |
| CSRF + 敏感删改操作（密码/绑定/支付/权限） | 需登录 | 一次 | +1 | vulnerability | **medium** |
| CSRF + 普通删改操作（昵称/草稿/偏好） | 需登录 | 一次 | 0 | risk-b | **medium** |
| CSRF + 查询接口 | — | — | — | safe | **info** |
| CSRF + 指定 ID 删除/修改 | 需登录 | 一次 | 0 | safe | **info** |
| NoSQL 注入 + 用户数据 | 无需 | 无需 | +1 | vulnerability | **high** |
| NoSQL 注入 | 需登录 | 无需 | 0 | vulnerability | **medium** |
| JWT 算法混淆 | 无需 | — | — | vulnerability | **medium** |
| 开放重定向 | 无需 | 一次 | — | vulnerability | **low** |
| CORS + 携带凭据 | 无需 | — | — | vulnerability | **low** |
| 硬编码凭据 | — | — | 密钥 | vulnerability | **low** |
| 信息泄露（堆栈/路径） | — | — | -1 | vulnerability | **low** |
| Debug 模式开启 | — | — | — | vulnerability | **low** |

---

## 六、[表6] 维度四：前提条件 × 可达性 基础 severity 重述矩阵

> 与维度二「利用难度三因子取最大」是同一事实的更结构化交叉校验，**不替换现有 clamp 公式**，用于复核时二次校准。

| 前提条件数 | 可达性 | 基础 severity 上限 | 说明 |
|-----------|--------|-------------------|------|
| 0（无认证+远程） | 未认证即可达 | **critical** | 零门槛，最危险 |
| 1（需登录） | 普通用户可达 | **high** | 低门槛 |
| 2（需特定角色/权限） | 受限可达 | **medium** | 中门槛 |
| 3+（需管理员+内网+多步交互） | 本地/高门槛 | **low** | 高门槛，攻击成本大 |

**前提条件定义**：
- 无 auth middleware / 公开接口 → 0 前提
- 需登录（普通用户）→ 1 前提
- 需特定角色/权限（非管理员）→ 2 前提
- 需管理员 + 内网访问 + 多步交互/社会工程 → 3+ 前提

**使用方式**：按此矩阵得出的 severity 上限与维度一~三计算的 severity 取**较小值**，作为校验。若矩阵上限 < 公式计算值，说明计算可能有误，需重新审视。

---

## 七、抗通胀校准（severity_alignment）

复核时对 `original_severity` 给 **alignment 分**（-5..+5），表达"原评级是否合理"：

| alignment | 含义 | 动作 |
|-----------|------|------|
| +3..+5 | 合理/低估 | 允许升一级（受 conclusion 天花板封顶） |
| 0..+2 | 大致合理 | 维持原级 |
| -1..-2 | 轻微通胀 | 维持原级，但记录信号 |
| **-3** | 通胀一级 | **强制降一级** |
| -4..-5 | 严重通胀 | **强制降一级**（禁止跨两级，保守降一级） |

**规则**：
1. `alignment ≤ -3` → 强制降一级（如 critical→high、high→medium）
2. `alignment ≥ +3` → 允许升一级，但受 conclusion 天花板封顶
3. **任何情况不跨两级**（即使 alignment=-5，也只降一级）
4. 评分嵌入 `change_reason` 文字：`[SEV-ALIGN: -3]`
5. 与威胁匹配 +1 交互：先应用 alignment 降级/升级，再应用威胁 +1（仍受天花板封顶）

**判定参考**：
- 通胀信号（alignment 负值）：前提条件未满足就给了高分、IDOR L2却标critical、需管理员却标high
- 低估信号（alignment 正值）：零前提却标medium、批量获取PII却标low

---

## 八、威胁模型匹配 +1

与 arch-scan 产出的 STRIDE 威胁清单协同：

**规则**：
1. finding 命中 ≥1 条 STRIDE 威胁 → severity **允许 +1**（如 medium→high）
2. **禁止跨两级**（即使命中多条威胁也只 +1）
3. 仍受 conclusion 天花板封顶（risk-b ≤ high、risk-a ≤ medium）
4. 匹配方法：按 `affected_locations.file_path` 的文件名 + 入口方法名与 .redtrace/code-audit/PROJECT_CONTEXT.md Threat Model 中 STRIDE 条目的 `surface` 字段模糊匹配
5. 匹配结果在 `description` 追加 `[THREAT-MATCH: STRIDE-I, STRIDE-E]`

**计算顺序**：
```
step1 = 基础severity + 利用难度 + 数据敏感度  （维度一~三）
step2 = min(step1, 前提条件矩阵上限)           （维度四校验）
step3 = apply_severity_alignment(step2, alignment)  （第七节抗通胀）
step4 = apply_threat_match(step3, threat_matches)    （第八节+1）
final = clamp(step4, conclusion天花板)
```

**注意**：维度四（第六节）是校验层不直接修改值，实际降级/升级由第七节 alignment 和第八节威胁匹配执行。
