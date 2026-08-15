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
