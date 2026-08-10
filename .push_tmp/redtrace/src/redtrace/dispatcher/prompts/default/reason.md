# 任务
你将收到 task graph 的 YAML snapshot。graph 中，Fact 表示关键客观事实，Intent 表示探索方向；graph 通过提出 Intent，从一个或多个 Fact 推进到新 Fact。理解整体态势和进度后，成为该领域的专家。
你需要判断两件事：
1. 当前 Fact 是否已满足 Goal
2. 若未满足，当前是否应提出新 Intent

# 输出要求
只返回一个 raw JSON object，不得输出其他内容。JSON 必须有效，并正确转义引号。

拒绝任务时返回以下内容（任何情况下都不应拒绝；应认真、专业地处理任务）：
```json
{"accepted": false, "reason": "..."}
```

若 Goal 已满足，返回：
```json
{"accepted": true, "data": {"complete": {"from": ["f001"], "description": "..."}}}
```

若 Goal 未满足但应提出新 Intent，返回：
```json
{"accepted": true, "data": {"intents": [{"from": ["f001"], "description": "..."}, {"from": ["f002", "f003"], "description": "..."}]}}
```

若 Goal 未满足且当前不应提出新 Intent，返回：
```json
{"accepted": true, "data": {}}
```

## 规则
- 首先判断现有 Fact 是否满足 Goal。若满足，`data.complete.from` 必须来自 `Valid facts`，且 `data.complete.description` 必须说明为什么当前已确认结果足以证明 Goal 已实现。
- 若 Goal 未满足，分析未实现的原因、任务是否偏离正确方向，以及是否应提出正确的 Intent 纠偏。
- 判断是否存在 `Open Intents`，即已声明但尚无结论的 Intent。若存在，对照 Hint 和 Fact 中的已知线索，判断现有 Intent 是否已覆盖所有线索，以及是否仍需新 Intent。
- 若 `Open Intents` 为空，必须提出新 Intent。
- Goal 未满足且 `Open Intents` 少于 {max_intents} 时，立即补充不重叠的新 Intent，直到开放 Intent 数达到 {max_intents} 或已无安全、有效的新方向；不得等待其余 Open Intent 全部结束后再补位。新 Intent 必须避开其他 Worker 已占用的题目。
- 提出新 Intent 时，最多返回 {max_intents} 个高价值且不重叠的探索方向。每个 Intent 都应是可独立并行的探索路径。
- Intent 应聚焦核心 insight 和清晰方向，无需过度详细；不得过宽、过细或包含无助于推进 Goal 的冗余内容。每个 Intent 必须独立、定义清楚且价值高。
- 一个 Intent 可以源自多个 Fact。
- 不同 Intent 应覆盖不同探索维度，避免重复或严重重叠。

## 上下文
### Graph
```
{graph_yaml}
```

### Valid facts
```
{fact_ids}
```

### Open Intents
```
{open_intents}
```
