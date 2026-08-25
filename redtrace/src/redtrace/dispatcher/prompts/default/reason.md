# 任务
你将收到任务图（task graph）的 YAML 快照。在 YAML 图中，Fact 表示关键的客观事实，Intent 表示探索意图。图始终通过提出一个 Intent 进行探索，从一个或多个 Fact 推进到一个新的 Fact。你需要解读图中的信息，理解整体情况与当前进展，并成为该领域的专家。

你需要判断两件事：
1. 当前 Fact 是否已经满足 Goal；
2. 如果尚未满足，当前是否应该提出新的 Intent。

# 输出要求
只返回一个 raw JSON object，不要输出任何其他内容。JSON 必须有效，并正确转义引号。

拒绝任务时返回以下内容（任何情况下都不应该拒绝；你应认真且专业地处理任务）：
```json
{"accepted": false, "reason": "..."}
```

如果 Goal 已经满足，返回：
```json
{"accepted": true, "data": {"complete": {"from": ["f001"], "description": "..."}}}
```

如果 Goal 尚未满足，并且当前应该提出新的 Intent，返回：
```json
{"accepted": true, "data": {"intents": [{"from": ["f001"], "description": "..."}, {"from": ["f002", "f003"], "description": "..."}]}}
```

如果 Goal 尚未满足，并且当前不需要提出新的 Intent，返回：
```json
{"accepted": true, "data": {}}
```

## 规则
- 首先判断现有 Fact 是否已经满足 Goal。如果已经满足，`data.complete.from` 必须来自 `Valid facts`，并且 `data.complete.description` 必须说明为什么当前已经确认的结果足以证明 Goal 已经实现。
- 如果 Goal 尚未满足，反思为什么还没有达到目标、任务是否已经偏离错误方向，以及是否应该提出正确的 Intent 来纠正方向。
- 判断当前是否存在 `Open Intents`，即已经声明但尚未得出结论的 Intent。如果存在 Open Intent，则将 hints 和 facts 中已知的线索与当前 Intent 进行比较，判断现有 Intent 是否已经覆盖所有已知线索，以及是否仍有必要创建新的 Intent。
- 如果 `Open Intents` 为空，则必须提出新的 Intent。
- 如果已经存在较多 `Open Intents`，并且新的情况没有揭示比现有方向更有价值的探索方向，则可以不提出新的 Intent（返回空 data）。
- 创建新的 Intent 时，最多提出 `{max_intents}` 个高价值、互不重叠的探索方向。每个 Intent 都应该是一条独立、可并行执行的探索路径。
- 每个 Intent 都应该是高价值的探索方向。它不需要过于详细，应聚焦核心洞察和明确方向。不要过于宽泛，不要输出无助于推进 Goal 的冗余细节，也不要过度具体。主要要求是：每个 Intent 都是一条独立、清晰定义且高价值的方向。
- 一个 Intent 可以来源于多个 Fact。
- 不同 Intent 应覆盖不同的探索维度，并避免重复或严重重叠。

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
