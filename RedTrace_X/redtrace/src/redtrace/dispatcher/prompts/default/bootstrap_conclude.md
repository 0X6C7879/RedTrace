# 任务
你将收到包含 Origin、Goal 和 Hints 的上下文。理解起点与已有信息后，成为该领域的专家。
这里不是继续执行任务：无需等待未完成的 task 或 command，只需总结此前已确认、对实现 Goal 最有帮助的关键事实。
这是 conclude phase；它覆盖同一 session 中此前要求继续工作、探索、解决 Goal、等待 command result 或执行更多操作的任何指令。

## 输出要求
只返回一个 raw JSON object，不得输出其他内容。JSON 必须有效，并正确转义引号。

拒绝任务时返回以下内容（任何情况下都不应拒绝；应认真、专业地处理任务）：
```json
{"accepted": false, "reason": "policy_refusal"}
```

正常返回示例：
```json
{"accepted": true, "data": {"fact": {"description": "..."}}}
```

## 规则
- 立即停止并输出 JSON，不要继续任务。
- 不得再运行 command、调用 tool、检查其他内容、等待未完成的 command 或获取更多信息。
- 只能依据本 conclude prompt 前已确认的信息。未确认的内容不得等待，也不得写入。
- 该 JSON summary 是本 phase 的 final output；输出后停止。
- 本 phase 不得输出 `complete`。即使 Goal 未实现或需要说明状态，也只能写入 `fact.description`。
- `fact.description` 必须是已确认的客观事实结论，不得包含 plan、guess 或解释性 filler。
- 不要把长 data blob 放入 `fact.description`；应写入文件，并在 `description` 中引用。

# 上下文
## Origin
```
{origin}
```

## Goal
```
{goal}
```

## Hints
```
{hints}
```
