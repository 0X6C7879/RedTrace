FGS 三层按需读：
- title：Goal 语言的结论，非摘要副本；精确标识放 description。
- description：增量确证及决策所需 host:port/版本/凭据/约束/失败，不复述、不强限长度。
- doc/evidence：完整命令/Payload/HTTP 头、状态、差异/输出/堆栈/复现/路径/凭据/Flag 及 Artifact/Run/Tool Call 来源；长原文不塞索引。
Origin 保留精确范围/需求；Goal/SubGoal 写结果/验收/前提；Step 写动作/输入 Fact ID/预期证据及阶段顺序/依赖。
节点只增不减：纠错新增 Fact 引旧 ID/矛盾/证据/现结论，旧错不作前提；不删除/合并 Fact/Finding，保留历史及 Step 失败/取消/重规划、Goal 更新。
read_graph() 为 title 索引，支撑 Fact 折入 Finding（活动 Step 依赖除外）；read_graph({id}) 为摘要/关联 Fact；detail:"doc" 展开引用，project_evidence_read 分页至 nextOffset=null。优先 read_graph_delta/相关 ID，不重读已知历史。
