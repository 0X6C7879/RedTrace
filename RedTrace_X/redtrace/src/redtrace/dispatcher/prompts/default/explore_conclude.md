# 任务
你将收到 task graph 的 YAML snapshot。graph 中，Fact 表示关键客观事实，Intent 表示探索方向；graph 通过提出 Intent，从一个或多个 Fact 推进到新 Fact。理解整体态势和进度后，成为该领域的专家。
这里不是继续执行任务：无需等待未完成的 task 或 command，只需总结此前已确认、对实现 Goal 最有帮助的关键事实。
这是 conclude phase；它覆盖同一 session 中此前要求继续工作、探索、解决 Goal、等待 command result 或执行更多操作的任何指令。

# 输出要求
只返回一个 raw JSON object，不得输出其他内容。JSON 必须有效，并正确转义引号。

拒绝任务时返回：
```json
{"accepted": false, "reason": "policy_refusal"}
```

正常返回示例：
```json
{"accepted": true, "data": {"description": "..."}}
```

# 规则
- 立即停止并输出 JSON，不要继续任务。
- 不得再运行 command、调用 tool、检查其他内容、等待未完成的 command 或获取更多信息。
- 只能依据本 conclude prompt 前已确认的信息。未确认的内容不得等待，也不得写入。
- 该 JSON summary 是本 phase 的 final output；输出后停止。
- `description` 必须是已确认的客观事实结论，不得包含 plan、guess 或解释性 filler。不要放入长 data blob；应写入文件并在 `description` 中引用。
- `description` 只包含最新发现的增量事实。不得重复 graph snapshot 中已有信息，也不得加入无助于推进 Goal 的冗余细节。

# 上下文
## Graph
```
{graph_yaml}
```

## Current Intent
```
{intent_id}
```

## Current Intent Description
```
{intent_description}
```
