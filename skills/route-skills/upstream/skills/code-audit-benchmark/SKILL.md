---
name: code-audit-benchmark
description: 白盒审计 Benchmark 归因分析：分析 code-audit 的 FP/FN 案例与流程缺陷，提取 Worker 会话推理过程，对比人工标注，定位根因并输出改进建议与回归清单。仅在基准评测、回归分析和 Skill 质量诊断时使用，不在普通任务中自动加载。
license: MIT
metadata:
  sourceSkill: benchmark-attribution
  targetSkill: route-skills/code-audit-benchmark
  targetModule: route-skills/code-audit
---

# Benchmark 归因分析（code-audit-benchmark）

分析 benchmark 错误判断案例，找出根因并输出改进建议。

**目标 Skill**: route-skills/code-audit（重点 sast-audit 模式，兼顾其余六种模式）

> 本模块不在普通任务中自动加载，只在基准评测、回归分析和 Skill 质量诊断时使用。

---

## 数据来源（RedTrace）

| 数据 | 位置 |
|------|------|
| Worker 对话与工具事件 | RedTrace 任务会话（`.redtrace/projects/<project_id>/conversations`，可用 `REDTRACE_SESSION_DIR` 覆盖） |
| Blackboard Finding | RedTrace Server 事实图 / Blackboard CLI |
| Code Audit JSON | `<workspace>/.redtrace/code-audit/findings.jsonl` 与 reports/ |
| Runtime Verify 结果 | `<workspace>/.redtrace/evidence/<finding-id>/` |
| 人工确认结论 | Benchmark DB 人工标注列 |
| Learned 复用记录 | `code-audit/learned/learned.index` |

## 输出指标

- Precision / Recall / FP / FN
- 按语言准确率、按漏洞类型准确率、严重等级准确率
- Codegraph 命中率、平均文件读取数、平均工具调用数、平均 Token
- Finding 验证耗时、Learned 经验复用成功率

---

## 脚本速查表

| 脚本 | 用途 | 典型命令 |
|------|------|----------|
| `query_benchmark.py` | 查询错误案例 | `--version {v} --type FP` |
| `batch_extract.py` | 一键提取完整数据 | `--version {v} --type all` |
| `session_parser.py` | 解析会话文件 | `--file {session.jsonl} --types llm_reasoning` |
| `classify_error.py` | 判定错误类型 | `--reasoning "..." --ground-truth Negative` |
| `stats_summary.py` | 统计指标计算 | `--version {v} --by-vul-type` |

---

## 执行流程

### 前置配置

| 配置项 | 环境变量 | 默认值 | 说明 |
|--------|----------|--------|------|
| 会话文件目录 | `REDTRACE_SESSION_DIR`（兼容 `FLICKCLI_SESSION_DIR`） | RedTrace 任务会话目录 | Worker 会话 JSONL 文件存储目录 |
| 数据库路径 | `CODE_AUDIT_BENCHMARK_DB` 或命令行 `--db` | `.redtrace/code-audit/benchmark.db` | Benchmark 结果数据库（任务级，位于 Workspace） |

### 阶段一：数据获取（推荐）

**目标**: 一键获取完整分析数据

```bash
python3 scripts/batch_extract.py \
  --version {version} \
  --type all \
  --output .redtrace/code-audit/reports/full_analysis_{version}.json
```

**输出结构**:
```json
{
  "version": "prompt-0525-glm-5-retry2",
  "total": 28,
  "session_found": 28,
  "session_analyzed": 26,
  "error_type_distribution": {
    "数据流分析不精确": 10,
    "防护有效性判断不一致": 8
  },
  "cases": [
    {
      "issue_id": "cb36a441...",
      "comment": "硬编码文件后缀名为json，无危害",
      "error_type": "数据流分析不精确",
      "confidence": "high",
      "reasoning_preview": "用户输入 taskId 从 Controller..."
    }
  ]
}
```

**质量门禁**:
- [ ] `session_found / total >= 0.7`（会话文件存在率 >= 70%）
- [ ] `session_analyzed >= 1`（至少分析了 1 个案例）

---

### 阶段二：单案例调试（特殊情况）

> **说明**: `batch_extract.py` 已自动完成根因分析，以下仅用于特殊情况调试。

```bash
python3 scripts/session_parser.py --file {session_file} --types llm_reasoning,conclusion
python3 scripts/classify_error.py --reasoning "{推理过程文本}" --ground-truth Negative --agent-conclusion 漏洞
```

| 根因类型 | 目标 Skill 步骤 | 缺陷描述 |
|----------|------------------|----------|
| 数据流分析不精确 | Step 6.2 | 未识别拦截型校验 |
| 防护有效性判断不一致 | Step 6.4 | 白名单匹配方式标准不清 |
| 历史经验使用不当 | Step 5 | 未验证历史记录适用性 |
| 代码版本不一致 | Step 4 | 未验证代码版本一致性 |

---

### 阶段三：报告生成

**目标**: Agent 智能生成归因报告和改进计划

#### Step 3.1: 获取统计数据

```bash
python3 scripts/stats_summary.py --version {version} --by-vul-type --format json
```

#### Step 3.2: 生成归因报告（Agent 生成）

**报告结构**:
```markdown
# Benchmark 归因分析报告 - {version}

## 执行摘要
- 总案例数、FP/FN 数量、根因分布

## 典型案例分析
### 案例 1: {issue_id}
- 漏洞类型、Agent 判断、人工标注
- 差异分析、根因、代码证据

## 流程缺陷映射
- 映射到目标 skill 具体步骤

## 改进建议
- 具体可执行的改进项
```

#### Step 3.3: 生成改进计划（Agent 生成）

**计划结构**:
```markdown
# 优化改进计划 - {version}

## 改进优先级
| P0 | P1 | P2 |

## 详细方案
- 修改哪个文件
- 新增什么检查项

## 回归测试清单
- 测试案例 ID + 预期结果

## 成功指标
- FP 减少 X 个，准确率提升 Y%
```

**质量门禁**:
- [ ] 典型案例数 >= min(2, FP+FN)
- [ ] 改进建议可追溯到具体根因
- [ ] 包含回归测试清单

---

## 准入准出条件

### 准入条件

| 条件 | 验证方法 |
|------|----------|
| 版本号有效 | `query_benchmark.py --type summary` 返回数据 |
| 存在错误案例 | fp_count + fn_count > 0 |
| 数据库可访问 | `CODE_AUDIT_BENCHMARK_DB` 指向的 benchmark.db 存在 |

### 准出条件

| 条件 | 验证方法 |
|------|----------|
| 所有案例已分析 | cases 分析数 = FP+FN |
| 根因覆盖率 >= 80% | 已分类案例 / 总案例 >= 0.8 |
| 报告已保存 | `.redtrace/code-audit/reports/attribution-report-{version}.md` 存在 |

---

## 异常处理

| 异常 | 识别条件 | 处理策略 |
|------|----------|----------|
| 版本不存在 | query 返回空 | 终止，提示有效版本 |
| 会话缺失率 > 30% | session_found / total < 0.7 | 终止，列出缺失清单 |
| 根因置信度低 | confidence == "low" | 标记待确认，继续 |
| 多错误类型 | 匹配多个 error_type | 选最高置信度 |

---

## 输出物清单

| 文件 | 路径 | 来源 |
|------|------|------|
| 完整分析数据 | `.redtrace/code-audit/reports/full_analysis_{version}.json` | 阶段一 |
| 统计摘要 | `.redtrace/code-audit/reports/stats_{version}.json` | Step 3.1 |
| 归因报告 | `.redtrace/code-audit/reports/attribution-report-{version}.md` | Agent 生成 |
| 改进计划 | `.redtrace/code-audit/reports/improvement-plan-{version}.md` | Agent 生成 |

---

## 相关文档

### 目标 Skill 文档
- code-audit 入口: `$REDTRACE_SKILLS_DIR/route-skills/upstream/skills/code-audit/SKILL.md`
- sast-audit 模式: `$REDTRACE_SKILLS_DIR/route-skills/upstream/skills/code-audit/references/modes/sast-audit.md`

### 本 Skill 脚本
- `scripts/query_benchmark.py` - 查询错误案例
- `scripts/batch_extract.py` - 一键提取数据
- `scripts/session_parser.py` - 会话解析
- `scripts/classify_error.py` - 根因判定
- `scripts/stats_summary.py` - 统计计算

### 参考文档
- `references/error-types.md` - 错误类型定义
- `references/analysis-template.md` - 分析模板（参考）
