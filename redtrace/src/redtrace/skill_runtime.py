from __future__ import annotations

from typing import Literal

SkillTaskType = Literal["bootstrap", "reason", "explore"]
SKILL_TASK_TYPES = frozenset({"bootstrap", "explore"})


def skill_runtime_enabled(task_type: SkillTaskType | str | None) -> bool:
    return task_type is None or task_type in SKILL_TASK_TYPES
