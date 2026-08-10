from __future__ import annotations

from conftest import make_intent, make_project

from redtrace.dispatcher.prompting import (
    add_blackboard_guidance,
    format_explore_context,
    load_prompt,
    preload_primary_skill,
    select_primary_skill,
)
from redtrace.dispatcher.tasks.common import is_transient_model_failure


def test_explore_context_is_current_intent_bounded() -> None:
    project = make_project()
    project.facts.append(type(project.facts[0])(id="f999", description="unrelated"))

    context = format_explore_context(project, make_intent())

    assert '"id":"origin"' in context
    assert '"id":"goal"' in context
    assert '"id":"f001"' in context
    assert "unrelated" not in context


def test_explore_context_exposes_only_active_peer_work() -> None:
    current = make_intent("i001").model_copy(update={"worker": "pi-1"})
    peer = make_intent("i002").model_copy(
        update={"worker": "pi-2", "description": "solve b-01"}
    )
    concluded = make_intent("i003").model_copy(
        update={
            "worker": "claude-1",
            "description": "solve c-02",
            "concluded_at": "2026-01-01T00:01:00Z",
        }
    )

    context = format_explore_context(
        make_project(intents=[current, peer, concluded]),
        current,
    )

    assert '"active_peer_work":[{"intent_id":"i002","worker":"pi-2"' in context
    assert "solve b-01" in context
    assert "solve c-02" not in context


def test_primary_skill_is_selected_and_loaded_without_router_reads(tmp_path) -> None:
    entrypoint = (
        tmp_path
        / "route-skills"
        / "upstream"
        / "skills"
        / "api-security"
        / "SKILL.md"
    )
    entrypoint.parent.mkdir(parents=True)
    entrypoint.write_text(
        "# API workflow\nACTION REQUIRED: `../tool-index.md` and `references/flow.md`",
        encoding="utf-8",
    )

    name, content, skill_dir = preload_primary_skill(
        "validate a GraphQL JWT flow",
        {"REDTRACE_HOST_SKILLS_DIR": str(tmp_path)},
    )

    assert select_primary_skill("validate a GraphQL JWT flow") == "api-security"
    assert name == "api-security"
    assert skill_dir == str(entrypoint.parent)
    assert content == (
        f"REDTRACE_PRIMARY_SKILL_DIR={entrypoint.parent}\n\n"
        "# API workflow\nACTION REQUIRED: "
        f"`{(entrypoint.parent / '../tool-index.md').resolve()}` and "
        f"`{(entrypoint.parent / 'references/flow.md').resolve()}`"
    )


def test_transient_gateway_errors_are_recoverable() -> None:
    assert is_transient_model_failure("", "502 Bad Gateway")
    assert is_transient_model_failure("429 Too Many Requests", "")
    assert not is_transient_model_failure("", "400 invalid request")


def test_explore_prompt_resumes_after_known_facts() -> None:
    prompt = load_prompt("default", "explore.md")

    assert "第一次工具调用必须从 Current Intent 中尚未验证的下一步开始" in prompt
    assert "不得重跑整套枚举" in prompt


def test_preloaded_skill_uses_runtime_fast_path_and_multi_challenge_scope() -> None:
    prompt = add_blackboard_guidance(
        "base",
        1,
        primary_skill="pentest-tools",
        primary_skill_content="skill body",
    )

    assert "跳过 Skill 中的授权先例、scope 初始化、tool-index 发现" in prompt
    assert "一道或多道" in prompt
    assert "active_peer_work" in prompt
