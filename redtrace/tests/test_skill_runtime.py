from __future__ import annotations

from pathlib import Path

from redtrace.skill_cli import build_parser, learn, recall


def _env(monkeypatch, tmp_path: Path) -> tuple[Path, Path, Path]:
    skills = tmp_path / "skills"
    skill = skills / "api-security"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text(
        "---\nname: api-security\ndescription: API security\n---\n",
        encoding="utf-8",
    )
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    memory = tmp_path / ".redtrace" / "skill-memory"
    monkeypatch.setenv("REDTRACE_SKILLS_DIR", str(skills))
    monkeypatch.setenv("REDTRACE_SKILL_MEMORY_DIR", str(memory))
    monkeypatch.setenv("REDTRACE_WORKSPACE", str(workspace))
    monkeypatch.setenv("REDTRACE_PROJECT_ID", "project-1")
    monkeypatch.setenv("REDTRACE_INTENT_ID", "intent-1")
    monkeypatch.setenv("REDTRACE_WORKER", "pi")
    return skills, workspace, memory


def test_learning_is_sanitized_deduplicated_and_recalled(tmp_path: Path, monkeypatch) -> None:
    _skills, workspace, memory = _env(monkeypatch, tmp_path)
    note = workspace / "note.md"
    note.write_text(
        f"Reusable method from {workspace}; token=supersecret and https://target.example/path",
        encoding="utf-8",
    )
    parser = build_parser()
    args = parser.parse_args(
        [
            "learn",
            "api-security",
            "--summary",
            "Validate authorization before replay",
            "--evidence",
            "Two independent requests reproduced the behavior",
            "--content-file",
            str(note),
        ]
    )

    assert learn(args)["status"] == "stored"
    assert learn(args)["status"] == "duplicate"
    stored = (memory / "api-security.jsonl").read_text(encoding="utf-8")
    assert "supersecret" not in stored
    assert "target.example" not in stored
    assert str(workspace) not in stored
    output = recall(parser.parse_args(["recall", "api-security"]))
    assert "Validate authorization before replay" in output
    assert "<redacted>" in output


def test_learning_rejects_noncanonical_or_unknown_skill(tmp_path: Path, monkeypatch) -> None:
    _skills, workspace, _memory = _env(monkeypatch, tmp_path)
    note = workspace / "note.md"
    note.write_text("safe", encoding="utf-8")
    args = build_parser().parse_args(
        ["learn", "*", "--summary", "summary", "--evidence", "evidence", "--content-file", str(note)]
    )

    try:
        learn(args)
    except ValueError as exc:
        assert "unknown canonical Skill" in str(exc)
    else:
        raise AssertionError("wildcard Skill should be rejected")


def test_learning_deduplicates_near_equivalent_wording(
    tmp_path: Path, monkeypatch
) -> None:
    _skills, workspace, memory = _env(monkeypatch, tmp_path)
    first = workspace / "first.md"
    second = workspace / "second.md"
    first.write_text(
        "Check object ownership on the server before replaying the request.",
        encoding="utf-8",
    )
    second.write_text(
        "Before request replay, verify object ownership on the server.",
        encoding="utf-8",
    )
    parser = build_parser()

    stored = learn(
        parser.parse_args(
            [
                "learn",
                "api-security",
                "--summary",
                "Validate object ownership before replay",
                "--evidence",
                "Reproduced twice",
                "--content-file",
                str(first),
            ]
        )
    )
    duplicate = learn(
        parser.parse_args(
            [
                "learn",
                "api-security",
                "--summary",
                "Verify ownership prior to request replay",
                "--evidence",
                "Confirmed with two requests",
                "--content-file",
                str(second),
            ]
        )
    )

    assert stored["status"] == "stored"
    assert duplicate["status"] == "duplicate"
    assert duplicate["match"] == "similar"
    lines = (memory / "api-security.jsonl").read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1


def test_reason_cannot_recall_or_learn(tmp_path: Path, monkeypatch) -> None:
    _skills, workspace, _memory = _env(monkeypatch, tmp_path)
    monkeypatch.setenv("REDTRACE_TASK_TYPE", "reason")
    note = workspace / "note.md"
    note.write_text("safe", encoding="utf-8")
    parser = build_parser()

    for args in (
        parser.parse_args(["recall", "api-security"]),
        parser.parse_args(
            [
                "learn",
                "api-security",
                "--summary",
                "summary",
                "--evidence",
                "evidence",
                "--content-file",
                str(note),
            ]
        ),
    ):
        try:
            recall(args) if args.command == "recall" else learn(args)
        except ValueError as exc:
            assert "disabled during reason" in str(exc)
        else:
            raise AssertionError("reason must not access Skill runtime")


def test_learn_rejects_unloaded_skill(tmp_path: Path, monkeypatch) -> None:
    """learn() should reject a skill not loaded in the current session."""
    _skills, workspace, _memory = _env(monkeypatch, tmp_path)
    note = workspace / "note.md"
    note.write_text("safe", encoding="utf-8")

    # Set up tracking file that only lists "api-security" as loaded
    tracking = tmp_path / "tracking.json"
    tracking.write_text('["api-security"]', encoding="utf-8")
    monkeypatch.setenv("REDTRACE_LOADED_SKILLS_FILE", str(tracking))

    parser = build_parser()
    args = parser.parse_args(
        [
            "learn",
            "api-security",
            "--summary",
            "Valid experience",
            "--evidence",
            "Confirmed",
            "--content-file",
            str(note),
        ]
    )
    # api-security is in the loaded list → should succeed
    assert learn(args)["status"] == "stored"


def test_learn_rejects_skill_not_in_loaded_list(tmp_path: Path, monkeypatch) -> None:
    """learn() should reject a skill NOT in the loaded list."""
    _skills, workspace, _memory = _env(monkeypatch, tmp_path)
    note = workspace / "note.md"
    note.write_text("safe", encoding="utf-8")

    # Set up tracking file that lists "code-audit" but NOT "api-security"
    tracking = tmp_path / "tracking.json"
    tracking.write_text('["code-audit"]', encoding="utf-8")
    monkeypatch.setenv("REDTRACE_LOADED_SKILLS_FILE", str(tracking))

    parser = build_parser()
    args = parser.parse_args(
        [
            "learn",
            "api-security",
            "--summary",
            "Valid experience",
            "--evidence",
            "Confirmed",
            "--content-file",
            str(note),
        ]
    )
    try:
        learn(args)
    except ValueError as exc:
        assert "was not loaded" in str(exc)
    else:
        raise AssertionError("should reject learn for unloaded skill")


def test_learn_skips_check_when_no_tracking_file(tmp_path: Path, monkeypatch) -> None:
    """learn() should work when no tracking file is set (backward compat)."""
    _skills, workspace, _memory = _env(monkeypatch, tmp_path)
    note = workspace / "note.md"
    note.write_text("safe", encoding="utf-8")

    # No REDTRACE_LOADED_SKILLS_FILE set → no validation
    parser = build_parser()
    args = parser.parse_args(
        [
            "learn",
            "api-security",
            "--summary",
            "Valid experience",
            "--evidence",
            "Confirmed",
            "--content-file",
            str(note),
        ]
    )
    assert learn(args)["status"] == "stored"


def test_track_load_records_skill(tmp_path: Path, monkeypatch) -> None:
    """track-load should record a skill to the tracking file."""
    _skills, _workspace, _memory = _env(monkeypatch, tmp_path)
    tracking = tmp_path / "tracking.json"
    monkeypatch.setenv("REDTRACE_LOADED_SKILLS_FILE", str(tracking))

    from redtrace.skill_cli import _track_skill_load
    _track_skill_load("api-security")
    _track_skill_load("code-audit")

    data = tracking.read_text(encoding="utf-8")
    import json
    assert json.loads(data) == ["api-security", "code-audit"]


def test_resolve_session_skill_tracking_path(tmp_path: Path) -> None:
    """resolve_session_skill_tracking_path should produce a determinstic path."""
    from redtrace.dispatcher.tasks.common import resolve_session_skill_tracking_path

    path = resolve_session_skill_tracking_path(str(tmp_path), "session-abc")
    assert path is not None
    assert path.name.startswith("loaded-skills-")
    assert path.suffix == ".json"
    assert ".redtrace" in str(path)


def test_non_evolution_skills_contain_no_learning_instructions() -> None:
    """Non-evolution skills must not contain executive learning instructions.

    Only skills/skill-evolution/ is allowed to control the recall/learn lifecycle.
    """
    import glob
    import re

    patterns = [re.compile(r"redtrace-skill recall"), re.compile(r"redtrace-skill learn")]
    violations: list[str] = []
    for ref in glob.glob(
        "/Users/lxy/Downloads/RedTrace/skills/*/references/*.md"
    ):
        if "skill-evolution" in ref:
            continue
        content = Path(ref).read_text(encoding="utf-8", errors="replace")
        for pattern in patterns:
            if pattern.search(content):
                violations.append(f"{ref}: {pattern.pattern}")

    for ref in glob.glob(
        "/Users/lxy/Downloads/RedTrace/skills/*/learned/*.md"
    ):
        if "skill-evolution" in ref:
            continue
        content = Path(ref).read_text(encoding="utf-8", errors="replace")
        for pattern in patterns:
            if pattern.search(content):
                violations.append(f"{ref}: {pattern.pattern}")

    assert not violations, "\n".join(violations)