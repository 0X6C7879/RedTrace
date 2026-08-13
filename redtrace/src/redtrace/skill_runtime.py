from __future__ import annotations


SKILL_RUNTIME_INSTRUCTIONS = """## RedTrace Skill runtime

- `reason` 阶段不调用工具或 Skill；`bootstrap` / `explore` 直接使用 Claude、Codex 或 Pi 的原生 Skill 发现机制加载最具体的专业 Skill。
- 不存在总路由 Skill。禁止调用 `route-skills`、`skills`、`*`、`all` 或其他枚举/路由占位名。Skill 的 canonical ID 是其一级目录名（也与 frontmatter `name` 一致），审计中不使用插件前缀。
- 每个任务选择一个主 Skill，仅在确有知识缺口时补充其他 Skill；同一会话最多四个且不重复加载。
- 每次加载 Skill 后、首次实质操作前，运行一次 `redtrace-skill recall <canonical-id>` 消费该 Skill 已验证的历史经验。
- 任务结束前，只有产生了已验证、可复用且不属于当前项目事实的新经验时，才在 Workspace 写脱敏说明并运行 `redtrace-skill learn <canonical-id> --summary <摘要> --evidence <验证依据> --content-file <文件>`。没有新经验就不写。
- RedTrace Core 负责路由约束、并发锁、脱敏、去重、原子写入、索引和审计；Worker 不直接修改共享 Skill、学习索引或 Agent 用户配置，也不创建额外 Router、Manager 或 Evolution Agent。
"""
