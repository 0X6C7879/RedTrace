---
name: skill-evolution
description: Task-end learning hook — review verified outcomes and evolve only the Skills actually loaded in the current session.
---

# Skill Evolution

task-end Learning 机制。仅在当前 Explore/Bootstrap 任务已完成并返回结果后，由 Runtime hook 触发。

## 判断标准

由你判断是否产生了同时满足以下条件的新经验：

- 可复用：不绑定特定项目/题目/目标
- 已验证：基于本次实际执行并确认的结果
- 非项目事实：不是当前目标的特有信息
- 适用 Skill：适用于本次实际加载过的专业 Skill（由 Runtime allowlist 强制）

## 行动

- 若满足：在当前 Workspace 写一份脱敏说明，然后对每个确有新经验的 Skill 运行一次 `redtrace-skill learn <canonical-id> --summary <摘要> --evidence <验证依据> --content-file <文件>`
- 若不满足，或本次没有加载专业 Skill：不加载本 Skill，不写文件，不调用 learn

## 禁止

- 不得修改 Skill 本体、Skill Memory、索引或 Agent 用户配置
- 不得继续攻击、扫描或扩大任务范围

## 控制权

完成经验判断和必要的 redtrace-skill learn 后，将控制权交还当前任务。
不得覆盖、替代或修改 Bootstrap/Explore/Reason 的最终输出协议。
skill-evolution 是 side-effect/control Skill，不是独立 Task。
