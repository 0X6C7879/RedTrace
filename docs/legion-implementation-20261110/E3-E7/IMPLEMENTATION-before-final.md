# 实施检查点

完整迁移尚未完成。最新需求是移除 Reason、全面替换、清空所有 Step/Run/Agent Session，同时保留项目与成果；旧迁移文档中的保留 Reason/可选模式方案已失效。

已落地：E0 基线；E1 的组织字段、Campaign 事件游标、STATE、持久消息记录、同题委派/Park/接力事务、项目级证据索引及读取 API。新增15项测试通过。

未落地：完整 Finding/Session 附件预检，以及 E2–E7。没有启用 Commander，没有删除或停止实际任务。

下一步：先扩展 ProjectEvidence 对 Finding.details 和 Session 附件的保全与完整删除预检，再实现真正的 Commander DSH 执行与迁移上游 Mission。以 CHECKPOINT.json 的输入路径与验收事件续接，不重做已完成基线。

回归：Engine 217通过/4失败/1跳过，4项失败与基线相同；类型检查及DSH构建通过，DSH57通过/1跳过。

回滚演练：补丁精确重建10个变更文件；ROLLBACK.sh 在独立临时副本还原405个基线文件哈希。源码归档与补丁只包含本次增量，不包含生产配置或任务数据。ROLLBACK.sh依赖同目录BASELINE.tar.gz，接受目标副本目录参数。


## E1 续接结果
已扩展 Finding.details 结构化引用、DSH Session 图片/文件附件保全和非破坏性 preflightReset。26 项定向测试通过（本批新增11项）；原生明文与Zstd落盘 Session fixture 删除后，4个保留引用仍可读、哈希一致，二进制可无损解码。Engine 228通过/4项原有缺Python失败/1跳过；DSH57通过/1跳过。
累计补丁重建10文件；副本回滚405原文件哈希一致，已重新应用补丁。四角色交付物仍沿用原路径。
preflightReset 的 dataReady 仅表示该项目本次扫描及detach计划无阻塞，cleanupAllowed始终false。自由文本引用需明确映射；没有运行生产全项目清理预检、停止服务或清理实际数据。E2–E7仍未实现，本批不宣称真实军团闭环。


## E2 原生运行链与真实模型验收
新增原生 Commander Session、四角色 Mission、legion_* 工具、显式角色模型路由和实际消息投递状态；沿用原 DSH Worker 执行器、FGS、并发与隔离。指定模型 auto/deepseek-flash 的严格本地算术验收退出0：Scout先完成，General后启动，两个专项Soldier并发写入5/7，General核验汇总12，Commander验收，4个Run均成功且无未决工具。原生协议fixture另验HELP应答入模与同Session恢复。
首轮真实模型发现Board遗漏Scope/Goal ID，修复并增加测试；强化Scout时序、相对路径与隔离继承。没有以mock替代失败。详细结果见 /Users/lxy/Downloads/RedTrace/docs/legion-implementation-20261110/E2-runtime/real-model-evidence-1794362806542/result.json。
定向36通过；最终Engine238通过/4项原有缺Python失败/1跳过；类型检查通过，DSH57通过/1跳过。旧FGS短提醒断言出现过一次偶发失败，单测和最终全量复测通过，未声称已修复该偶发问题。
累计18文件补丁重建及405文件哈希回滚通过。E3–E7仍未完成；原Reason执行链尚存，未停止实际服务、未删生产数据、未进行平台验收，未将临时模型凭据写入生产配置。下一步见CHECKPOINT的E3动作。
