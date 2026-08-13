from __future__ import annotations

from pathlib import Path

from redtrace.skill_cli import build_parser, learn, recall


def _env(monkeypatch, tmp_path: Path) -> tuple[Path, Path]:
    skills = tmp_path / "skills"
    skill = skills / "api-security"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text(
        "---\nname: api-security\ndescription: API security\n---\n",
        encoding="utf-8",
    )
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    monkeypatch.setenv("REDTRACE_SKILLS_DIR", str(skills))
    monkeypatch.setenv("REDTRACE_SKILL_MEMORY_DIR", str(skills / ".redtrace" / "learning"))
    monkeypatch.setenv("REDTRACE_WORKSPACE", str(workspace))
    monkeypatch.setenv("REDTRACE_PROJECT_ID", "project-1")
    monkeypatch.setenv("REDTRACE_INTENT_ID", "intent-1")
    monkeypatch.setenv("REDTRACE_WORKER", "pi")
    return skills, workspace


def test_learning_is_sanitized_deduplicated_and_recalled(tmp_path: Path, monkeypatch) -> None:
    skills, workspace = _env(monkeypatch, tmp_path)
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
    stored = (skills / ".redtrace" / "learning" / "api-security.jsonl").read_text(encoding="utf-8")
    assert "supersecret" not in stored
    assert "target.example" not in stored
    assert str(workspace) not in stored
    output = recall(parser.parse_args(["recall", "api-security"]))
    assert "Validate authorization before replay" in output
    assert "<redacted>" in output


def test_learning_rejects_noncanonical_or_unknown_skill(tmp_path: Path, monkeypatch) -> None:
    _skills, workspace = _env(monkeypatch, tmp_path)
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
