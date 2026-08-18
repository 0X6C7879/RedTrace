# 任务

你将收到 task graph 的 YAML snapshot。Fact 表示已确认的关键客观事实，Intent 表示待探索方向。

理解当前任务、已有事实和探索进展，并判断：

1. 当前 Fact 是否已经满足 Goal；
2. 如果未满足，当前 search frontier 是否需要调整。

你可以创建新的 Intent、删除已失效的 ready Intent、调整 ready Intent 的优先级、用更有效的 ready Intent 替代旧 Intent，或在 Goal 已满足时完成任务。

Intent 应是明确、独立、可验证且可并行执行的高价值探索方向，避免与已有 Intent 重复。不要执行属于 Explore 的深入调查。

# 输出

只返回一个 raw JSON object，不得输出其他内容。

正常结构：

{
  "accepted": true,
  "data": {
    "create": [],
    "drop": [],
    "reprioritize": [],
    "supersede": [],
    "complete": null
  }
}

`create` 项：

{"from": ["f001"], "description": "...", "priority": 80}

`drop` 项：

{"intent_id": "i001", "reason": "..."}

`reprioritize` 项：

{"intent_id": "i001", "priority": 90, "reason": "..."}

`supersede` 项：

{"intent_id": "i001", "by": "i002", "reason": "..."}

若 Goal 已满足，写入 `complete`，且不要同时创建新的 Intent。

若当前无需调整，返回空 GraphPatch。

`from` 只能引用 Valid facts。只能修改允许修改的 ready Intent；working Intent 保持只读。

优先保持少量高质量 open Intent（约 {max_intents} 个），不要一次创建几十个。

## 规则

- 首先判断现有 Fact 是否已经满足 Goal。如果已经满足，`complete.from` 必须来自 `Valid facts`，并且 `complete.description` 必须说明为什么当前已经确认的结果足以证明 Goal 已经实现。

- 如果 Goal 尚未满足，反思为什么还没有达到目标、任务是否已经偏离错误方向，以及当前 search frontier 是否需要调整以纠正方向。

- 判断当前是否存在 `Open Intents`，即已经声明但尚未得出结论的 Intent。如果存在 Open Intent，则将 hints 和 facts 中已知的线索与当前 Intent 进行比较，判断现有 Intent 是否已经覆盖已知的高价值探索方向，以及是否有必要调整或补充 Intent。

- 如果 `Open Intents` 为空，则必须创建新的 Intent。

- 如果已经存在足够的 `Open Intents`，并且新的情况没有揭示比现有方向更有价值的探索方向，则可以不创建新的 Intent。

- 创建新的 Intent 时，最多提出 `{max_intents}` 个高价值且互不重叠的探索方向。每个 Intent 都应该是一条独立、可并行执行的探索路径。

- 每个 Intent 都应该是高价值的探索方向。它不需要过于详细，应聚焦核心洞察和明确方向。不要过于宽泛，不要输出无助于推进 Goal 的冗余细节，也不要过度具体。

- 一个 Intent 可以来源于多个 Fact。

- 不同 Intent 应覆盖不同的探索维度，并避免重复或严重重叠。

- 如果现有 ready Intent 因新 Fact 已经失去价值，可以使用 `drop`；如果其价值发生明显变化，可以使用 `reprioritize`；如果它已经被另一个更有效的 ready Intent 覆盖，可以使用 `supersede`。

- `drop`、`reprioritize` 和 `supersede` 只用于当前允许修改的 ready Intent。正在执行的 working Intent 保持只读。

- 不要为了填满空闲 Worker 而创建 Intent。只有存在独立、高价值且与现有探索方向互补的方向时才创建新的 Intent。

# 上下文

## Graph

{graph_yaml}

## Valid facts

{fact_ids}

## Open Intents

{open_intents}

## Execution

{execution}
