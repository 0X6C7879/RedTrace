# Benchmark 归因分析 Skill

分析 route-skills/code-audit skill 的 benchmark 测试错误案例，自动提取推理过程，定位根因，生成改进报告。

---

## 准入条件

使用本 skill 前必须满足：

| 条件 | 验证方法 | 不满足时的处理 |
|------|----------|----------------|
| 版本号有效 | 数据库中存在该版本 | 提示用户提供有效版本号 |
| 存在错误案例 | FP + FN > 0 | 告知用户该版本无错误案例 |
| 数据库可访问 | `.redtrace/code-audit/benchmark.db`（或 `CODE_AUDIT_BENCHMARK_DB`）存在 | 检查数据库路径 |
| 目标 Skill 存在 | `$REDTRACE_SKILLS_DIR/route-skills/upstream/skills/code-audit/` 可读 | 提示用户安装目标 skill |

**准入检查**:
```bash
python3 scripts/query_benchmark.py --version {version} --type summary
# 如果 fp_count + fn_count == 0 → 无分析价值，终止
```

---

## 快速开始

### 查询有效版本列表

```bash
python3 scripts/query_benchmark.py --type summary
# 输出示例：
# 版本: prompt-0525-glm-5-retry2, TP: 45, TN: 30, FP: 8, FN: 3
# 版本: prompt-0524-glm-5-retry1, TP: 42, TN: 28, FP: 10, FN: 6
```

### 完整流程（推荐）

```bash
# Step 1: 查询错误案例
python3 scripts/query_benchmark.py --version v1.0 --type FP --output tmp/fp_cases.json

# Step 2: 一键提取完整数据（含会话解析 + 根因判定）
python3 scripts/batch_extract.py --version v1.0 --type all --output tmp/full_analysis_v1.0.json

# Step 3: 查看统计摘要
python3 scripts/stats_summary.py --version v1.0 --by-vul-type
```

### 一键执行（调试用）

```bash
python3 scripts/batch_extract.py --version v1.0 --type FP --format text
```

### 单案例调试（特殊情况）

当需要深入分析某个特定案例时：

```bash
# 1. 解析单个会话文件
python3 scripts/session_parser.py --file {session_file} --types llm_reasoning,conclusion

# 2. 判定单个案例的错误类型
python3 scripts/classify_error.py --reasoning "{推理过程文本}" --ground-truth Negative --agent-conclusion 漏洞
```

---

## 准出条件

报告生成后，必须验证：

| 条件 | 验证方法 | 不满足时的处理 |
|------|----------|----------------|
| 所有案例已分析 | results 数量 = FP+FN | 补充缺失案例 |
| 根因覆盖率 >= 80% | 已分类/总数 >= 0.8 | 检查未分类案例 |
| 报告格式正确 | Markdown 渲染无报错 | 修复格式问题 |
| 无低置信度累积 | low_confidence_count < 总数 20% | 人工审查低置信度案例 |

**准出检查清单**:
- [ ] `tmp/full_analysis_{version}.json` 中 cases 分析数 = FP + FN
- [ ] error_type_distribution 中 "unknown" 占比 < 20%
- [ ] 报告已保存到 `tmp/attribution-report-{version}.md`

---

## 脚本说明

| 脚本 | 用途 | 典型命令 |
|------|------|----------|
| `query_benchmark.py` | 查询错误案例 | `--version {v} --type FP` |
| `batch_extract.py` | 一键提取完整数据 | `--version {v} --type all` |
| `session_parser.py` | 解析会话文件 | `--file {session.jsonl} --types llm_reasoning` |
| `classify_error.py` | 判定错误类型 | `--reasoning "..." --ground-truth Negative` |
| `stats_summary.py` | 统计指标计算 | `--version {v} --by-vul-type` |

### 输出格式说明

**`--format json`**（默认）：结构化 JSON，适合程序处理

**`--format text`**：人类可读摘要，包含关键发现和下一步建议

```markdown
## 批量分析结果

**版本**: v1.0
**总数**: 8
**成功**: 7 (87.5%)

### 错误类型分布

- 数据流分析不精确: 3
- 防护有效性判断不一致: 2

### ⚠️ 低置信度案例

- `abc12345`: unknown

---
**下一步**: 运行 classify_error.py 进行详细分类
```

---

## 目录结构

```
benchmark-attribution/
├── SKILL.md                      # Skill 入口（Agent 读取）
├── README.md                     # 本文件
├── scripts/
│   ├── query_benchmark.py        # 查询错误案例
│   ├── batch_extract.py          # 一键提取完整数据
│   ├── session_parser.py         # 解析会话文件
│   ├── classify_error.py         # 判定错误类型
│   └── stats_summary.py          # 统计指标计算
└── references/
    ├── error-types.md            # 错误类型定义
    └── analysis-template.md      # 分析模板（参考）
```

---

## 输出物清单

分析完成后，产出以下文件：

| 文件 | 路径 | 内容 |
|------|------|------|
| 完整分析数据 | `tmp/full_analysis_{version}.json` | 含根因分类的完整结果 |
| 统计摘要 | `tmp/stats_{version}.json` | TP/TN/FP/FN 及错误类型分布 |
| 归因报告 | `tmp/attribution-report-{version}.md` | Agent 生成的归因报告 |
| 改进计划 | `tmp/improvement-plan-{version}.md` | Agent 生成的改进计划 |

---

## 更新日志

- **2026-05-26**: 同步 README.md 与实际脚本列表
