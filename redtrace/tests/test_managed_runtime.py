from __future__ import annotations

import json
from pathlib import Path

import pytest
import yaml
from conftest import make_config
from redtrace.agent_runtime import AgentRuntimeManager
from redtrace.dispatcher.config import DispatchConfig, WorkerConfig
from redtrace.dispatcher.workers.adapters.claudecode import ClaudeCodeDriver
from redtrace.dispatcher.workers.adapters.codex import CodexDriver
from redtrace.dispatcher.workers.adapters.pi import PiDriver
from redtrace.paths import (
    PathResolutionError,
    RedTracePaths,
    contained_path,
    resolve_portable_path,
)


def _layout(root: Path) -> RedTracePaths:
    return RedTracePaths(
        root=root,
        skills=root / "skills",
        mcp=root / "mcp",
        managed=root / ".redtrace",
        workspaces=root / "workspaces",
        audit=root / ".redtrace" / "audit",
    )


def test_portable_path_rejects_foreign_windows_path_and_maps_wsl() -> None:
    with pytest.raises(PathResolutionError):
        resolve_portable_path(
            r"D:\AI\RedTrace",
            base=Path("/srv/redtrace"),
            platform="posix",
            under_wsl=False,
        )
    with pytest.raises(PathResolutionError):
        resolve_portable_path(
            r"D:AI\RedTrace",
            base=Path("/srv/redtrace"),
            platform="posix",
            under_wsl=False,
        )
    with pytest.raises(PathResolutionError, match="U\\+F03A"):
        resolve_portable_path(
            "D\uf03a/AI/RedTrace/workspaces",
            base=Path("/srv/redtrace"),
            platform="posix",
            under_wsl=True,
        )
    assert (
        str(
            resolve_portable_path(
                r"D:\AI\RedTrace",
                base=Path("/srv/redtrace"),
                platform="posix",
                under_wsl=True,
            )
        )
        == "/mnt/d/AI/RedTrace"
    )


def test_config_paths_are_anchored_to_config_file_not_cwd(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "portable-redtrace"
    root.mkdir()
    payload = make_config().model_dump(mode="json")
    payload["paths"] = {"root": "."}
    payload["runtime"]["execution"] = "local"
    payload["container"] = None
    payload["local"] = {"completed_action": "keep"}
    config_path = root / "redtrace.yaml"
    config_path.write_text(
        yaml.safe_dump(payload, sort_keys=False),
        encoding="utf-8",
    )
    other = tmp_path / "other"
    other.mkdir()
    monkeypatch.chdir(other)

    loaded = DispatchConfig.load(config_path)

    assert loaded.paths.root == str(root.resolve())
    assert loaded.paths.skills == str((root / "skills").resolve())
    assert loaded.local is not None
    assert loaded.local.workspace_root == str((root / "workspaces").resolve())


def test_workers_use_native_agent_state_and_shared_capabilities(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "redtrace"
    layout = _layout(root)
    skill = layout.skills / "recon"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text("# recon\n", encoding="utf-8")
    layout.mcp.mkdir()
    (layout.mcp / "filesystem.json").write_text(
        '{"command":"mcp-filesystem","args":["."]}\n',
        encoding="utf-8",
    )
    empty_home = tmp_path / "home"
    empty_home.mkdir()
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: empty_home))
    monkeypatch.setattr(
        "redtrace.agent_runtime.shutil.which",
        lambda _name: "/usr/local/bin/mcp-filesystem",
    )
    workers = [
        WorkerConfig(
            name=name,
            type="pi",
            task_types=["bootstrap", "reason", "explore"],
            max_running=1,
            priority=0,
        )
        for name in ("pi-a", "pi-b")
    ]
    manager = AgentRuntimeManager(layout, execution="local")
    scans = 0
    original_scan = manager._enabled_skill_paths

    def counted_scan() -> list[Path]:
        nonlocal scans
        scans += 1
        return original_scan()

    monkeypatch.setattr(manager, "_enabled_skill_paths", counted_scan)

    manager.initialize(workers)
    manager.initialize(workers)

    assert scans == 1
    audit_generation = layout.skills / ".redtrace" / "audit.jsonl"
    audit_generation.write_text('{"action":"toggle"}\n', encoding="utf-8")
    assert manager.refresh_capabilities(workers) is True
    assert manager.refresh_capabilities(workers) is False
    assert scans == 2
    assert (layout.runtime / "mcp" / "claude.json").is_file()
    assert (layout.runtime / "mcp" / "pi.json").is_file()
    assert not (layout.managed / "workers").exists()
    isolated_keys = {
        "CLAUDE_CONFIG_DIR",
        "CODEX_HOME",
        "PI_CODING_AGENT_DIR",
        "PI_CODING_AGENT_SESSION_DIR",
        "REDTRACE_PI_SESSION_DIR",
    }
    assert all(isolated_keys.isdisjoint(worker.env) for worker in workers)
    assert json.loads(workers[0].env["REDTRACE_SKILL_PATHS"]) == [str(skill.resolve())]
    resource_args = workers[0].env["REDTRACE_CODEX_RESOURCE_ARGS"]
    assert "mcp_servers.filesystem.command" in resource_args
    assert "skills.config=" not in resource_args
    assert "sqlite_home" not in resource_args
    assert workers[0].env["REDTRACE_PI_MCP_EXTENSION"] == "npm:pi-mcp-extension@1.5.0"
    workspace = layout.workspaces / "project-1"
    workspace.mkdir()
    assert not any((workspace / name).exists() for name in (".claude", ".pi", ".agents"))


def test_contained_path_rejects_traversal_and_root_deletion(tmp_path: Path) -> None:
    with pytest.raises(PathResolutionError):
        contained_path(tmp_path, "..", "escape")
    with pytest.raises(PathResolutionError):
        contained_path(Path(Path.cwd().anchor), "project")


def test_shared_skill_link_recovers_after_project_move(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "redtrace-before"
    layout = _layout(root)
    (layout.skills / "portable").mkdir(parents=True)
    (layout.skills / "portable" / "SKILL.md").write_text(
        "# portable\n",
        encoding="utf-8",
    )
    layout.mcp.mkdir()
    empty_home = tmp_path / "home"
    empty_home.mkdir()
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: empty_home))

    AgentRuntimeManager(layout, execution="local").initialize([])
    moved = tmp_path / "redtrace-after"
    root.rename(moved)
    moved_layout = _layout(moved)

    AgentRuntimeManager(moved_layout, execution="local").initialize([])

    skill_link = moved_layout.runtime / "claude-plugin" / "skills"
    assert skill_link.resolve() == moved_layout.skills.resolve()
    assert (skill_link / "portable" / "SKILL.md").is_file()


def test_runtime_defaults_to_per_skill_memory(
    tmp_path: Path,
) -> None:
    layout = _layout(tmp_path / "redtrace")
    skill = layout.skills / "api-security"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text("---\nname: api-security\ndescription: API security\n---\n", encoding="utf-8")
    layout.mcp.mkdir()
    worker = WorkerConfig(
        name="pi",
        type="pi",
        task_types=["bootstrap", "reason", "explore"],
        max_running=1,
        priority=0,
    )

    AgentRuntimeManager(layout, execution="local").initialize([worker])

    assert "REDTRACE_GLOBAL_INSTRUCTIONS" not in worker.env
    # REDTRACE_SKILL_MEMORY_DIR is not set by default — skill memory lives
    # inside each skill's own directory (skills/<name>/memory/).
    assert "REDTRACE_SKILL_MEMORY_DIR" not in worker.env
    assert (layout.skills / "api-security" / "memory").is_dir()
    assert not (layout.skills / ".redtrace" / "learning").exists()
    assert worker.env["REDTRACE_TOOLS_DIR"] == str(layout.runtime / "tools")
    assert worker.env["REDTRACE_TOOLS_BIN"] == str(layout.runtime / "tools" / "bin")
    assert (layout.runtime / "tools" / "bin").is_dir()


def test_all_native_workers_receive_and_can_invoke_specialist_skills(tmp_path: Path) -> None:
    layout = _layout(tmp_path / "redtrace")
    skill = layout.skills / "api-security"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text("---\nname: api-security\ndescription: API security\n---\n", encoding="utf-8")
    layout.mcp.mkdir()
    workers = [
        WorkerConfig(
            name=worker_type,
            type=worker_type,
            task_types=["bootstrap", "reason", "explore"],
            max_running=1,
            priority=0,
        )
        for worker_type in ("claudecode", "codex", "pi")
    ]

    AgentRuntimeManager(layout, execution="local").initialize(workers)
    expected_path = str(skill.resolve())
    claude = ClaudeCodeDriver(local=True).build_execute(
        workers[0], "prompt", "session", task_type="explore"
    ).argv
    codex = CodexDriver(local=True).build_execute(
        workers[1], "prompt", None, task_type="explore"
    ).argv
    pi = PiDriver(local=True).build_execute(
        workers[2], "prompt", None, task_type="explore"
    ).argv

    assert claude[claude.index("--plugin-dir") + 1].endswith("claude-plugin")
    assert "skills.config=" not in " ".join(codex)
    assert pi[pi.index("--skill") + 1] == expected_path
    assert all("REDTRACE_GLOBAL_INSTRUCTIONS" not in worker.env for worker in workers)

    reason_claude = ClaudeCodeDriver(local=True).build_execute(
        workers[0], "prompt", "session", task_type="reason"
    ).argv
    reason_codex = CodexDriver(local=True).build_execute(
        workers[1], "prompt", None, task_type="reason"
    ).argv
    reason_pi = PiDriver(local=True).build_execute(
        workers[2], "prompt", None, task_type="reason"
    ).argv
    assert "--plugin-dir" not in reason_claude
    assert expected_path not in " ".join(reason_codex)
    assert "--skill" not in reason_pi


def test_runtime_migrates_existing_skill_memory_without_deleting_it(
    tmp_path: Path,
) -> None:
    """Old central managed/skill-memory/<name>.jsonl → skills/<name>/memory/records.jsonl."""
    layout = _layout(tmp_path / "redtrace")
    skill = layout.skills / "api-security"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text("---\nname: api-security\ndescription: API security\n---\n", encoding="utf-8")
    old_memory = layout.managed / "skill-memory"
    old_memory.mkdir(parents=True)
    record = (
        '{"at":"2026-01-01T00:00:00Z","skill":"api-security","summary":"s",'
        '"evidence":"e","content":"c","digest":"d1","project":"p","intent":"i","worker":"w"}'
    )
    (old_memory / "api-security.jsonl").write_text(record + "\n", encoding="utf-8")
    layout.mcp.mkdir(parents=True)

    AgentRuntimeManager(layout, execution="local").initialize([])

    migrated = (layout.skills / "api-security" / "memory" / "records.jsonl").read_text(
        encoding="utf-8"
    )
    assert "d1" in migrated
    # Old source is preserved (not deleted).
    assert (old_memory / "api-security.jsonl").is_file()


def test_runtime_migration_is_idempotent(tmp_path: Path) -> None:
    """Running initialize twice does not duplicate migrated records."""
    layout = _layout(tmp_path / "redtrace")
    skill = layout.skills / "api-security"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text("---\nname: api-security\ndescription: API security\n---\n", encoding="utf-8")
    old_memory = layout.managed / "skill-memory"
    old_memory.mkdir(parents=True)
    record = (
        '{"at":"2026-01-01T00:00:00Z","skill":"api-security","summary":"s",'
        '"evidence":"e","content":"c","digest":"d1","project":"p","intent":"i","worker":"w"}'
    )
    (old_memory / "api-security.jsonl").write_text(record + "\n", encoding="utf-8")
    layout.mcp.mkdir(parents=True)

    manager = AgentRuntimeManager(layout, execution="local")
    manager.initialize([])
    manager._shared_initialized = False
    manager.initialize([])

    lines = (layout.skills / "api-security" / "memory" / "records.jsonl").read_text(
        encoding="utf-8"
    ).splitlines()
    assert len(lines) == 1


def test_runtime_migration_splits_central_audit_by_skill(tmp_path: Path) -> None:
    """Central audit.jsonl entries are split into per-skill audit.jsonl by digest."""
    layout = _layout(tmp_path / "redtrace")
    for name in ("api-security", "code-audit"):
        skill = layout.skills / name
        skill.mkdir(parents=True)
        (skill / "SKILL.md").write_text(f"---\nname: {name}\ndescription: test\n---\n", encoding="utf-8")
    old_memory = layout.managed / "skill-memory"
    old_memory.mkdir(parents=True)
    audit_entries = [
        '{"at":"2026-01-01T00:00:00Z","skill":"api-security","digest":"a1","project":"p","intent":"i","worker":"w"}',
        '{"at":"2026-01-01T00:01:00Z","skill":"code-audit","digest":"c1","project":"p","intent":"i","worker":"w"}',
        '{"at":"2026-01-01T00:02:00Z","skill":"api-security","digest":"a2","project":"p","intent":"i","worker":"w"}',
    ]
    (old_memory / "audit.jsonl").write_text("\n".join(audit_entries) + "\n", encoding="utf-8")
    layout.mcp.mkdir(parents=True)

    AgentRuntimeManager(layout, execution="local").initialize([])

    api_audit = (layout.skills / "api-security" / "memory" / "audit.jsonl").read_text(
        encoding="utf-8"
    )
    code_audit = (layout.skills / "code-audit" / "memory" / "audit.jsonl").read_text(
        encoding="utf-8"
    )
    assert "a1" in api_audit
    assert "a2" in api_audit
    assert "c1" not in api_audit
    assert "c1" in code_audit
    assert "a1" not in code_audit


def test_runtime_migration_distributes_legacy_notes(tmp_path: Path) -> None:
    """Legacy .md notes are distributed to matching skills; unmatched go to _legacy-unmatched/."""
    layout = _layout(tmp_path / "redtrace")
    skill = layout.skills / "api-security"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text(
        "---\nname: api-security\ndescription: API security\n---\n",
        encoding="utf-8",
    )
    bundled_legacy = layout.root / "redtrace" / "skill-memory" / "legacy"
    bundled_legacy.mkdir(parents=True)
    (bundled_legacy / "api-security-note.md").write_text(
        "This note is about api-security testing.",
        encoding="utf-8",
    )
    (bundled_legacy / "unmatched-note.md").write_text(
        "This note is about something entirely different.",
        encoding="utf-8",
    )
    layout.mcp.mkdir(parents=True)

    AgentRuntimeManager(layout, execution="local").initialize([])

    # Matching note is distributed to the skill's memory/legacy/.
    assert (
        layout.skills / "api-security" / "memory" / "legacy" / "api-security-note.md"
    ).is_file()
    # Non-matching note goes to _legacy-unmatched/.
    assert (
        layout.skills / "_legacy-unmatched" / "unmatched-note.md"
    ).is_file()
    # Migration report is generated.
    assert (layout.skills / "_legacy-unmatched" / "MIGRATION.md").is_file()


def test_local_runtime_auto_disables_and_recovers_mcp_with_missing_command(
    tmp_path: Path,
    monkeypatch,
) -> None:
    layout = _layout(tmp_path / "redtrace")
    layout.skills.mkdir(parents=True)
    layout.mcp.mkdir(parents=True)
    mcp_file = layout.mcp / "ghost.json"
    mcp_file.write_text(
        json.dumps(
            {
                "enabled": True,
                "transport": "stdio",
                "command": "redtrace-nonexistent-mcp-tool",
                "args": ["serve"],
            }
        ),
        encoding="utf-8",
    )

    AgentRuntimeManager(layout, execution="local").initialize([])

    saved = json.loads(mcp_file.read_text(encoding="utf-8"))
    assert saved["enabled"] is False
    assert saved["autoDisabledBy"] == "missing-command"
    claude_config = json.loads(
        (layout.runtime / "mcp" / "claude.json").read_text(encoding="utf-8")
    )
    assert "ghost" not in claude_config["mcpServers"]

    monkeypatch.setattr(
        "redtrace.agent_runtime.shutil.which",
        lambda _name: "/usr/local/bin/redtrace-nonexistent-mcp-tool",
    )
    AgentRuntimeManager(layout, execution="local").initialize([])

    recovered = json.loads(mcp_file.read_text(encoding="utf-8"))
    assert recovered["enabled"] is True
    assert "autoDisabledBy" not in recovered
    claude_config = json.loads(
        (layout.runtime / "mcp" / "claude.json").read_text(encoding="utf-8")
    )
    assert "ghost" in claude_config["mcpServers"]
