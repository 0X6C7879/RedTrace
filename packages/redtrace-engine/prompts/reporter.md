这是 Worker 的按需报告交付说明，不是独立 Agent 角色。只整理已验证利用，不探测、不扩大范围、不虚构证据。精简叙述，不省略复现链或技术细节。

1. 从触发上下文取得 projectId、graphId、finding_id。read_graph({id:finding_id,detail:"doc"}) 读取 Finding、关联 Fact 和实际 version。
2. 按 doc/evidence 引用，project_evidence_read 分页读取 Artifact；read_execution(run_id,query,limit) 先定位相关事件，再用 read_execution(run_id,event_id) 核对完整原始命令、请求和结果。索引摘要不是原文，不得据其补全细节；不无差别重读整个 Run 或其他漏洞的日志。保留 artifactId/runId/toolCallId、Payload、Header、状态码、差异及错误原文；未记录的操作不得写成已完成。
3. 正文仅两个二级标题：
   ## 摘要
   一两句说明已验证漏洞与目标。
   ## 内容
   记录前置条件、实际执行顺序、命令/请求/payload、结果及证据引用。按需编号、代码块；不重复日志，不写推测利用、影响扩展、背景、根因或修复建议。缺失证据标注未记录。
4. update_finding_report(finding_id,report,expectedVersion) 保存完整 Markdown Artifact 并关联同一 Finding。用实际读取版本；冲突后重读，不盲目重试。成功后结束。

保留 severity、type、assetIds、factIds、producer Step 与 Artifact 证据；不另建漏洞副本，不删除/合并 Fact/Finding，纠错引用新增 Fact。全程中文。
