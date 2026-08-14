from __future__ import annotations

from typing import Literal


SkillTaskType = Literal["bootstrap", "reason", "explore"]
SKILL_TASK_TYPES = frozenset({"bootstrap", "explore"})

SKILL_RUNTIME_INSTRUCTIONS = """## RedTrace Skill Runtime Policy

- 使用 Worker 原生发现机制加载与任务最具体匹配的专业 Skill；canonical ID 是 Skill 一级目录名（也与 frontmatter `name` 一致）。
- 每个任务选择一个主 Skill，仅在确有知识缺口时补充其他 Skill；同一会话最多四个且不重复加载。
- 每次加载 Skill 后、首次实质操作前，运行一次 `redtrace-skill recall <canonical-id>` 消费该 Skill 已验证的历史经验。
- Worker 不直接修改共享 Skill、Skill Memory、索引或 Agent 用户配置。只有 Learning Checkpoint 可以决定是否通过 `redtrace-skill learn` 沉淀经验。
"""

LEARNING_CHECKPOINT_PROMPT = """## RedTrace Learning Checkpoint

这是 RedTrace 在任务结束前强制执行的唯一 Learning Checkpoint。只复盘本次会话已经完成并验证的工作，不得继续任务、重新调查或修改任务结论。

由你判断是否产生了同时满足以下条件的新经验：可复用、已验证、不属于当前项目事实，并且适用于本次实际加载过的专业 Skill。

- 若满足：在当前 Workspace 写一份脱敏说明，然后对每个确有新经验的 Skill 运行一次 `redtrace-skill learn <canonical-id> --summary <摘要> --evidence <验证依据> --content-file <文件>`。
- 若不满足，或本次没有加载专业 Skill：不要写文件，也不要调用 `learn`。
- 不得修改 Skill 本体、Skill Memory、索引或 Agent 用户配置。

完成判断后只返回：`{"accepted":true,"data":{}}`
"""


def skill_runtime_enabled(task_type: SkillTaskType | str | None) -> bool:
    return task_type is None or task_type in SKILL_TASK_TYPES


def skill_runtime_instructions(task_type: SkillTaskType | str) -> str:
    return SKILL_RUNTIME_INSTRUCTIONS if skill_runtime_enabled(task_type) else ""


def learning_checkpoint_prompt(task_type: SkillTaskType | str) -> str:
    if not skill_runtime_enabled(task_type):
        raise ValueError(f"Skill runtime is disabled for task type: {task_type}")
    return LEARNING_CHECKPOINT_PROMPT
