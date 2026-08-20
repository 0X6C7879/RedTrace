"""Skill self-evolution closure tests.

These tests pin the final closure of the Skill learning loop:

- Skill memory lives in each skill's own ``memory/`` directory
  (``skills/<name>/memory/records.jsonl`` and ``audit.jsonl``), not in a
  central store.  The ``REDTRACE_SKILL_MEMORY_DIR`` env var is only an
  optional override; by default it is not set.
- The loaded-skill tracking file is **not** pre-seeded with all exposed
  skills at task start.  Only skills the agent explicitly records via
  ``redtrace-skill track-load`` are considered loaded, so ``learn()``'s
  fail-closed gate reflects actual usage rather than mere availability.
- ``recall()`` only reads memory and never fakes a loaded skill.
- ``learn()`` is fail-closed: it rejects skills not recorded as loaded,
  including the empty/missing tracking file case.
- Only ``skill-evolution`` controls the recall/learn lifecycle; ordinary
  skills and references must not repeat the executive ``skill-evolution``
  trigger or call ``redtrace-skill recall``/``learn``.

All paths are resolved relative to the repository root — no host absolute
paths, so CI machines actually scan the skill tree instead of vacuously
passing on a missing glob.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from redtrace.skill_cli import build_parser, learn, recall

# Repository root resolved from this test file's location so tests work on
# any machine / CI runner, never a hardcoded host absolute path.
REPO_ROOT = Path(__file__).resolve().parents[2]
SKILLS_ROOT = REPO_ROOT / "skills"


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
    memory = skills / "api-security" / "memory"
    monkeypatch.setenv("REDTRACE_SKILLS_DIR", str(skills))
    monkeypatch.setenv("REDTRACE_WORKSPACE", str(workspace))
    monkeypatch.setenv("REDTRACE_PROJECT_ID", "project-1")
    monkeypatch.setenv("REDTRACE_INTENT_ID", "intent-1")
    monkeypatch.setenv("REDTRACE_WORKER", "pi")
    return skills, workspace, memory


def _tracking_env(monkeypatch, tmp_path: Path, loaded: list[str]) -> Path:
    """Create a loaded-skills tracking file and point the env at it."""
    tracking = tmp_path / "tracking.json"
    tracking.write_text(json.dumps(loaded), encoding="utf-8")
    monkeypatch.setenv("REDTRACE_LOADED_SKILLS_FILE", str(tracking))
    return tracking


def _learn_args(note: Path, skill: str = "api-security") -> object:
    return build_parser().parse_args(
        [
            "learn",
            skill,
            "--summary",
            "Valid experience",
            "--evidence",
            "Confirmed twice",
            "--content-file",
            str(note),
        ]
    )


# ---------------------------------------------------------------------------
# Existing behavioural guarantees (sanitise / dedupe / reason isolation)
# ---------------------------------------------------------------------------


def test_learning_is_sanitized_deduplicated_and_recalled(tmp_path: Path, monkeypatch) -> None:
    _skills, workspace, memory = _env(monkeypatch, tmp_path)
    # recall must not fake a loaded skill, so seed the tracking allowlist.
    _tracking_env(monkeypatch, tmp_path, ["api-security"])
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
    stored = (memory / "records.jsonl").read_text(encoding="utf-8")
    assert "supersecret" not in stored
    assert "target.example" not in stored
    assert str(workspace) not in stored
    output = recall(parser.parse_args(["recall", "api-security"]))
    assert "Validate authorization before replay" in output
    assert "<redacted>" in output


def test_learning_rejects_noncanonical_or_unknown_skill(tmp_path: Path, monkeypatch) -> None:
    _skills, workspace, _memory = _env(monkeypatch, tmp_path)
    _tracking_env(monkeypatch, tmp_path, ["api-security"])
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
    _tracking_env(monkeypatch, tmp_path, ["api-security"])
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
    lines = (memory / "records.jsonl").read_text(encoding="utf-8").splitlines()
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


# ---------------------------------------------------------------------------
# recall() must not fake a loaded skill (Point 2)
# ---------------------------------------------------------------------------


def test_recall_does_not_pollute_loaded_tracking(tmp_path: Path, monkeypatch) -> None:
    """recall() must not record the skill as loaded.

    Before the fix, recall() called _track_skill_load(), which let
    skill-evolution recall an unloaded skill and then learn() it.
    """
    _skills, _workspace, _memory = _env(monkeypatch, tmp_path)
    # Tracking starts empty (nothing loaded yet).
    tracking = _tracking_env(monkeypatch, tmp_path, [])

    recall(build_parser().parse_args(["recall", "api-security"]))

    # recall must leave the tracking file empty — it only reads memory.
    assert json.loads(tracking.read_text(encoding="utf-8")) == []


# ---------------------------------------------------------------------------
# learn() is fail-closed (Point 4)
# ---------------------------------------------------------------------------


def test_learn_allows_loaded_skill(tmp_path: Path, monkeypatch) -> None:
    _skills, workspace, _memory = _env(monkeypatch, tmp_path)
    _tracking_env(monkeypatch, tmp_path, ["api-security"])
    note = workspace / "note.md"
    note.write_text("safe", encoding="utf-8")
    assert learn(_learn_args(note))["status"] == "stored"


def test_learn_rejects_skill_not_in_loaded_list(tmp_path: Path, monkeypatch) -> None:
    _skills, workspace, _memory = _env(monkeypatch, tmp_path)
    _tracking_env(monkeypatch, tmp_path, ["code-audit"])
    note = workspace / "note.md"
    note.write_text("safe", encoding="utf-8")
    try:
        learn(_learn_args(note))
    except ValueError as exc:
        assert "was not loaded" in str(exc)
    else:
        raise AssertionError("should reject learn for unloaded skill")


def test_learn_rejects_when_tracking_empty(tmp_path: Path, monkeypatch) -> None:
    """Empty tracking file => reject (fail-closed), not skip validation."""
    _skills, workspace, _memory = _env(monkeypatch, tmp_path)
    _tracking_env(monkeypatch, tmp_path, [])
    note = workspace / "note.md"
    note.write_text("safe", encoding="utf-8")
    try:
        learn(_learn_args(note))
    except ValueError as exc:
        assert "was not loaded" in str(exc)
    else:
        raise AssertionError("empty tracking must reject learn (fail-closed)")


def test_learn_rejects_when_no_tracking_file(tmp_path: Path, monkeypatch) -> None:
    """Missing tracking file => reject (fail-closed)."""
    _skills, workspace, _memory = _env(monkeypatch, tmp_path)
    # Deliberately do NOT set REDTRACE_LOADED_SKILLS_FILE.
    monkeypatch.delenv("REDTRACE_LOADED_SKILLS_FILE", raising=False)
    note = workspace / "note.md"
    note.write_text("safe", encoding="utf-8")
    try:
        learn(_learn_args(note))
    except ValueError as exc:
        assert "was not loaded" in str(exc)
    else:
        raise AssertionError("missing tracking must reject learn (fail-closed)")


def test_track_load_records_skill(tmp_path: Path, monkeypatch) -> None:
    """track-load still records a skill to the tracking file."""
    _skills, _workspace, _memory = _env(monkeypatch, tmp_path)
    tracking = _tracking_env(monkeypatch, tmp_path, [])

    from redtrace.skill_cli import _track_skill_load
    _track_skill_load("api-security")
    _track_skill_load("code-audit")

    data = tracking.read_text(encoding="utf-8")
    assert json.loads(data) == ["api-security", "code-audit"]


# ---------------------------------------------------------------------------
# Skill tracking lifecycle decoupled from provider session id (Points 1 & 3)
# ---------------------------------------------------------------------------


def test_resolve_skill_tracking_path_is_deterministic(tmp_path: Path) -> None:
    """resolve_skill_tracking_path is deterministic for a task identity."""
    from redtrace.dispatcher.tasks.common import resolve_skill_tracking_path

    path = resolve_skill_tracking_path(
        str(tmp_path), "bootstrap", "proj_1", "intent_1", "pi-worker"
    )
    assert path is not None
    assert path.name.startswith("loaded-skills-")
    assert path.suffix == ".json"
    assert ".redtrace" in str(path)
    # Same identity => same path (stable across execute/conclude).
    again = resolve_skill_tracking_path(
        str(tmp_path), "bootstrap", "proj_1", "intent_1", "pi-worker"
    )
    assert again == path


def test_resolve_skill_tracking_path_independent_of_session(tmp_path: Path) -> None:
    """The tracking path does not depend on any provider session id.

    A reason task never gets a tracking file.
    """
    from redtrace.dispatcher.tasks.common import resolve_skill_tracking_path

    # Different sessions for the same task identity resolve to the SAME path.
    a = resolve_skill_tracking_path(
        str(tmp_path), "explore", "proj_1", "intent_1", "pi-worker"
    )
    b = resolve_skill_tracking_path(
        str(tmp_path), "explore", "proj_1", "intent_1", "pi-worker"
    )
    assert a == b
    # Reason never creates a tracking file.
    assert (
        resolve_skill_tracking_path(
            str(tmp_path), "reason", "proj_1", "intent_1", "pi-worker"
        )
        is None
    )


def test_bootstrap_task_tracking_not_pre_seeded(tmp_path: Path) -> None:
    """Bootstrap task start must NOT pre-seed the tracking file.

    Exposed skills are available, not loaded. Only an explicit
    ``track-load`` call creates the tracking file.
    """
    from redtrace.dispatcher.tasks.common import resolve_skill_tracking_path

    tracking = resolve_skill_tracking_path(
        str(tmp_path), "bootstrap", "proj_b", "intent_b", "claude-w"
    )
    assert tracking is not None
    # No seeding: the file does not exist until track-load is called.
    assert not tracking.exists()


def test_explore_task_tracking_not_pre_seeded(tmp_path: Path) -> None:
    """Explore task start must NOT pre-seed the tracking file."""
    from redtrace.dispatcher.tasks.common import resolve_skill_tracking_path

    tracking = resolve_skill_tracking_path(
        str(tmp_path), "explore", "proj_e", "intent_e", "codex-w"
    )
    assert tracking is not None
    assert not tracking.exists()


def test_cleanup_skill_tracking_removes_file(tmp_path: Path) -> None:
    from redtrace.dispatcher.tasks.common import (
        cleanup_skill_tracking,
        resolve_skill_tracking_path,
    )

    tracking = resolve_skill_tracking_path(
        str(tmp_path), "bootstrap", "proj_c", "intent_c", "claude-w"
    )
    assert tracking is not None
    # Simulate a track-load call that created the file.
    tracking.parent.mkdir(parents=True, exist_ok=True)
    tracking.write_text(json.dumps(["api-security"]), encoding="utf-8")
    assert tracking.is_file()
    cleanup_skill_tracking(str(tmp_path), "bootstrap", "proj_c", "intent_c", "claude-w")
    assert not tracking.exists()


def test_cleanup_skill_tracking_noop_when_file_absent(tmp_path: Path) -> None:
    """Cleanup is a no-op when track-load was never called."""
    from redtrace.dispatcher.tasks.common import (
        cleanup_skill_tracking,
        resolve_skill_tracking_path,
    )

    tracking = resolve_skill_tracking_path(
        str(tmp_path), "explore", "proj_n", "intent_n", "pi-w"
    )
    assert tracking is not None
    assert not tracking.exists()
    # Must not raise.
    cleanup_skill_tracking(str(tmp_path), "explore", "proj_n", "intent_n", "pi-w")
    assert not tracking.exists()


def test_reset_skill_tracking_clears_stale_file(tmp_path: Path) -> None:
    """A crashed run's stale tracking is neutralized at task start.

    The tracking id is deterministic per task identity, so a previous run
    that crashed without its finally-cleanup leaves a stale loaded-skill
    set behind. reset_skill_tracking overwrites it with an empty list so a
    retry cannot inherit the previous run's loaded skills.
    """
    from redtrace.dispatcher.tasks.common import (
        reset_skill_tracking,
        resolve_skill_tracking_path,
    )

    tracking = resolve_skill_tracking_path(
        str(tmp_path), "explore", "proj_x", "intent_x", "pi-w"
    )
    assert tracking is not None
    # Simulate the residue of a crashed previous run of the same task.
    tracking.parent.mkdir(parents=True, exist_ok=True)
    tracking.write_text(json.dumps(["api-security", "code-audit"]), encoding="utf-8")

    class Manager:
        def write_text_file(self, container_name: str, path: str, content: str) -> str:
            target = Path(path)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
            return str(target)

    reset_skill_tracking(
        Manager(), str(tmp_path), "explore", "proj_x", "intent_x", "pi-w"
    )

    # The stale loaded-skill set is gone.
    assert json.loads(tracking.read_text(encoding="utf-8")) == []


def test_reset_skill_tracking_rejects_learn_after_reset(
    tmp_path: Path, monkeypatch
) -> None:
    """After a reset, learn() fails closed against the stale loaded set."""
    from redtrace.dispatcher.tasks.common import (
        reset_skill_tracking,
        resolve_skill_tracking_path,
    )

    _skills, workspace, _memory = _env(monkeypatch, tmp_path)
    tracking = resolve_skill_tracking_path(
        str(tmp_path), "explore", "proj_z", "intent_z", "pi-w"
    )
    assert tracking is not None
    tracking.parent.mkdir(parents=True, exist_ok=True)
    tracking.write_text(json.dumps(["api-security"]), encoding="utf-8")
    monkeypatch.setenv("REDTRACE_LOADED_SKILLS_FILE", str(tracking))
    note = workspace / "note.md"
    note.write_text("safe", encoding="utf-8")

    class Manager:
        def write_text_file(self, container_name: str, path: str, content: str) -> str:
            target = Path(path)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
            return str(target)

    reset_skill_tracking(
        Manager(), str(tmp_path), "explore", "proj_z", "intent_z", "pi-w"
    )
    try:
        learn(_learn_args(note))
    except ValueError as exc:
        assert "was not loaded" in str(exc)
    else:
        raise AssertionError("reset must clear the stale loaded-skill set")


# ---------------------------------------------------------------------------
# Claude / Codex / Pi: tracking is NOT pre-seeded for any provider
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("worker_type", ["claudecode", "codex", "pi"])
def test_provider_task_tracking_not_pre_seeded(worker_type: str, tmp_path: Path) -> None:
    """No provider gets its tracking file pre-seeded with exposed skills.

    The tracking id is task-identity based so all three providers resolve a
    deterministic path, but the file is never created until the agent
    explicitly calls ``track-load``.
    """
    from redtrace.dispatcher.tasks.common import resolve_skill_tracking_path

    tracking = resolve_skill_tracking_path(
        str(tmp_path), "explore", "proj_t", "intent_t", f"{worker_type}-w"
    )
    assert tracking is not None
    assert not tracking.exists()


# ---------------------------------------------------------------------------
# Reason isolation (Point 8 / existing guarantee)
# ---------------------------------------------------------------------------


def test_reason_has_no_tracking_no_runtime(tmp_path: Path) -> None:
    """Reason never creates a tracking file and has no Skill Runtime."""
    from redtrace.dispatcher.tasks.common import resolve_skill_tracking_path

    assert (
        resolve_skill_tracking_path(
            str(tmp_path), "reason", "proj_r", "intent_r", "reason-w"
        )
        is None
    )


# ---------------------------------------------------------------------------
# Full-repo scan: no executive skill-evolution / recall / learn in ordinary
# skills (Points 6 & 8). No host absolute paths; must assert scanned > 0.
# ---------------------------------------------------------------------------


def _non_evolution_skill_files() -> list[Path]:
    """Recursively collect every .md under skills/** except skill-evolution.

    Resolved relative to the repo root so it works on any machine, never a
    hardcoded host absolute path.
    """
    if not SKILLS_ROOT.is_dir():
        return []
    files: list[Path] = []
    for path in SKILLS_ROOT.rglob("*.md"):
        # Exclude the skill-evolution skill itself — it owns the lifecycle.
        if "skill-evolution" in path.relative_to(SKILLS_ROOT).parts:
            continue
        files.append(path)
    return files


def test_full_repo_scan_actually_scans_files() -> None:
    """The repo scan must find real skill files (guards against vacuous pass)."""
    files = _non_evolution_skill_files()
    assert files, "no skill .md files found — repo root resolution is broken"
    assert len(files) > 10  # the repo ships ~100 skills


def test_non_evolution_skills_contain_no_learning_instructions() -> None:
    """Only skills/skill-evolution/ controls the recall/learn lifecycle.

    Ordinary skills and references must not embed executive
    redtrace-skill recall / learn / track-load instructions or a
    'load skill-evolution' checklist.
    """
    import re

    files = _non_evolution_skill_files()
    assert files  # vacuous-pass guard
    executive = [
        re.compile(r"redtrace-skill\s+recall"),
        re.compile(r"redtrace-skill\s+learn"),
        re.compile(r"redtrace-skill\s+track"),
    ]
    load_evolution = re.compile(
        r"加载\s*[`]?skill-evolution|skill-evolution[`]?\s*按需加载|"
        r"load\s+[`]?skill-evolution|skill-evolution[`]?\s*load"
    )
    violations: list[str] = []
    for path in files:
        content = path.read_text(encoding="utf-8", errors="replace")
        for pattern in executive:
            if pattern.search(content):
                violations.append(f"{path}: {pattern.pattern}")
        if load_evolution.search(content):
            violations.append(f"{path}: executive skill-evolution load instruction")
    assert not violations, "\n".join(violations)


def test_skill_evolution_documents_write_target() -> None:
    """skill-evolution/SKILL.md must steer experience to professional skills."""
    skill_md = SKILLS_ROOT / "skill-evolution" / "SKILL.md"
    assert skill_md.is_file()
    content = skill_md.read_text(encoding="utf-8")
    # Must document that experience goes to professional skills, not
    # skill-evolution by default.
    assert "skill-evolution" in content
    assert "专业 Skill" in content
