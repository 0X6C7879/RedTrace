# N 票独立对抗验证（Adversarial Validation）

对高危 finding 执行 N 次独立验证，以多数票裁决是否为误报。**核心原则：验证者必须独立推导，不继承原审计推理链。**

---

## 验证者 Prompt 规范

**严禁传入原审计的以下字段**（防注入透传）：
- ❌ `description` — 原审计的推理链可能引导验证者
- ❌ `data_flow` — 原审计追踪路径可能固化思维
- ❌ `recommendation` — 修复建议可能暗示漏洞成立
- ❌ `example_payload` — 示例 payload 可能被当作证据

**只传入最简定位信息**（让验证者从源码自行推导）：
- ✅ `category` — 漏洞类别
- ✅ `entry_point / api_path` — 入口位置
- ✅ `affected_locations[0].file_path` — 文件路径
- ✅ `affected_locations[0].line_number` — 行号
- ✅ `root_cause` — 根因简述（≤100字）

**验证者立场**：
> 你是独立安全验证者，默认假设原审计结论是错误的。从源码自行重新推导可达性与防护，找出任何理由证明该 finding 是误报。互不可见其他验证者的结论。

**验证者输出格式**：
```json
{
  "verdict": "TRUE_POSITIVE|FALSE_POSITIVE|CANNOT_VERIFY",
  "refute_reason": "为何是误报（仅 FP 时填写）",
  "exclusion_rule": "命中的 FP 规则编号（如 FP-3.2.4，仅 FP 时填写，无匹配则填 FP-NONE）",
  "first_link": "你追踪到的第一个关键代码位置"
}
```

---

## 独立性保证（子代理实现）

主 agent 对每个高危 finding 启动 **N=2 个子代理并行验证**，各子代理开全新会话、互不可见上下文。这是 N 票有效的前提：如果验证者继承了审计上下文，就失去了独立性。

**主 agent 职责**：
1. 识别高危 finding（触发条件见上）
2. 为每个高危 finding 启动 2 个子代理并行验证
3. 收齐 2 票裁决后，按投票规则（见下）裁决
4. 将裁决结果写入 review 项的 `change_reason`

**子代理 prompt 模板**：
```
你是独立安全验证者，默认假设原审计结论是错误的。
从源码自行重新推导可达性与防护，找出任何理由证明该 finding 是误报。
你不掌握其他验证者的结论，请独立判断。

注意：
- 不要把临时文件放在 `/tmp/` 下，临时文件统一放在当前项目路径的 `.code-audit-tmp/` 下，没有该目录就创建一个。
- 严禁执行 `rm -rf`、`sqlite3`、`drop`、`delete` 等不可逆命令！！
- 代码分析工具选择：见 SKILL.md「工具使用规范」章节

仓库路径：{repo_path}

Finding 信息（仅提供最简定位信息，不含原审计推理链）：
- 类别: {category}
- 入口点: {api_path}
- 文件: {file_hint}
- 行号: {line_hint}
- 根因描述: {root_cause}

请输出 JSON：
{"verdict": "TRUE_POSITIVE|FALSE_POSITIVE|CANNOT_VERIFY",
 "refute_reason": "为何是误报（仅FP时填写）",
 "first_link": "你追踪到的第一个关键代码位置"}
```

**验收**：主 agent 收齐 2 个子代理的 verdict 后，逐票校验：

1. **verdict 枚举校验**：是否为 `{TRUE_POSITIVE, FALSE_POSITIVE, CANNOT_VERIFY}` 之一
2. **refute_reason 校验**：仅 FP 时填写，且需引用 FP 规则编号（如 `FP-3.2.4`）或具体代码位置（如 `utils.ts:18`）
3. **不合格处置**：verdict 不在枚举内 / JSON 解析失败 → 该票记为 `CANNOT_VERIFY`，**重试一次**（重新启动子代理）；重试仍失败 → 维持 `CANNOT_VERIFY`，不阻塞其他票

验收通过的票按投票规则裁决（见下）。

**熔断机制**（避免子代理持续失败时浪费资源）：

- 单个 finding 的 2 票均失败（重试后仍无效）→ 该 finding **保守维持原判定，不降级**
- **连续 3 个 finding** 的对抗验证全部失败 → 触发熔断，跳过剩余高危 finding 的对抗验证，所有未验证 finding **保守维持原判定**
- 熔断后在对应 review 项的 `change_reason` 标注：`[ADVERSARIAL-CIRCUIT-BREAK] 子代理连续失败，保守维持原判定`

---

## 投票裁决规则

使用投票裁决规则：

| 条件 | 裁决 |
|------|------|
| FP ≥ ⌈N/2⌉+1 | **FALSE_POSITIVE** → 降级 |
| TP ≥ ⌈N/2⌉+1 | **TRUE_POSITIVE** → 维持 |
| TP = FP（平局）+ `noise_tolerance=precision` | **FALSE_POSITIVE** → 降级（误报优先） |
| TP = FP（平局）+ `noise_tolerance=recall` | **TRUE_POSITIVE** → 保留（漏报优先） |
| CV > TP 且 CV > FP | **CANNOT_VERIFY** → 保守维持 |
| 其余情况 | TP ≥ FP → TRUE_POSITIVE；TP < FP → FALSE_POSITIVE |

- `CANNOT_VERIFY` **不计入** TP 票数（无法确认漏洞存在≠确认漏洞存在）
- 默认 `noise_tolerance=precision`（安全领域宁可多降级一个高危误报）

---

## 裁决落法（不改输出 schema）

FALSE_POSITIVE 裁决写入 report-review 现有字段：
- `changed = true`
- `new_severity` — 降一级（critical→high, high→medium）
- `change_reason` = `"N 票对抗复核 k/n 判误报，规则 FP-x.y [VOTE: 2/2 TP, 0/2 FP]"`

TRUE_POSITIVE 裁决：
- 不变更（复核结果维持）

CANNOT_VERIFY 裁决：
- 保守维持原判定（不降级）

---

## 平局策略

默认 `precision`：安全审计场景下，误报成本高于漏报成本（误报浪费修复时间且降低信任度）。
`recall` 策略仅在极少数安全要求场景使用（如金融支付核心路径）。

---

## 异步恢复策略

- 单次验证调用失败 → 该票记为 `CANNOT_VERIFY`
- 全部 N 票均失败 → 保守维持原判定，不降级
- 验证超时 → 记为 `CANNOT_VERIFY`，不影响其他票
