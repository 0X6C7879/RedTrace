# 任务

你将收到一个包含 Origin、Goal 和 Hints 的上下文包。你需要理解当前的起点以及已经掌握的信息（Origin 和 Hints），然后成为该领域的专家。

但请注意，你现在不是要继续执行任务，也不需要等待尚未完成的任务或命令。你只需要总结到目前为止已经确认、并且最有助于实现 Goal 的关键事实。

这是 conclude phase。它会覆盖同一 session 中此前所有要求你继续工作、继续探索、解决 Goal、等待命令结果或执行更多操作的指令。

## 规则

- 立即停止并现在就输出 JSON。不要继续执行任务。
- 不要再运行任何命令、调用任何工具、检查任何其他内容、等待任何未完成的命令，也不要尝试获取任何额外信息。
- 只能基于收到本 conclude prompt 之前已经确认的信息生成答案。如果某项信息此前尚未确认，不要等待它，也不要将其包含在结果中。
- 这个 JSON summary 是当前 phase 的最终输出。输出之后立即停止。
- 当前 phase 不得输出 `complete`。即使 Goal 尚未实现，或者需要说明当前状态，也只能将相关信息写入 `fact.description`。
- `fact.description` 必须是已经确认的客观事实结论。不要输出计划、猜测或解释性填充内容。
- 不要把长数据块放入 `fact.description`。长数据应写入文件，并在 `description` 中引用。

# 输出要求

只返回一个 raw JSON object，不得输出其他内容。

正常返回：

{"accepted": true, "data": {"fact": {"description": "..."}}}

本阶段不得输出 `complete`。

`fact.description` 只能包含已经确认的客观事实，不得包含计划、猜测或未确认信息。

# 上下文

## Origin

{origin}

## Goal

{goal}

## Hints

{hints}