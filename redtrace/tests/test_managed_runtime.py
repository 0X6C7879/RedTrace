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
        plugins=root / "plugins",
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
    layout.plugins.mkdir()
    (layout.plugins / "manifest.json").write_text(
        '{"schemaVersion":1,"plugins":[]}\n',
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
    assert "sqlite_home" not in resource_args
    assert workers[0].env["REDTRACE_PI_MCP_EXTENSION"] == "npm:pi-mcp-extension@1.5.0"
    workspace = layout.workspaces / "project-1"
    workspace.mkdir()
    assert not any(
        (workspace / name).exists() for name in (".claude", ".codex", ".pi", ".agents")
    )


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
    layout.plugins.mkdir()
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


def test_runtime_loads_route_skills_rules_as_global_worker_instructions(
    tmp_path: Path,
) -> None:
    layout = _layout(tmp_path / "redtrace")
    route_skills = layout.skills / "route-skills"
    route_skills.mkdir(parents=True)
    (route_skills / "SKILL.md").write_text("# route-skills\n", encoding="utf-8")
    (route_skills / "REDTRACE_RULES.md").write_text(
        "automatic route rules\n",
        encoding="utf-8",
    )
    layout.mcp.mkdir()
    layout.plugins.mkdir()
    worker = WorkerConfig(
        name="pi",
        type="pi",
        task_types=["bootstrap", "reason", "explore"],
        max_running=1,
        priority=0,
    )

    AgentRuntimeManager(layout, execution="local").initialize([worker])

    assert worker.env["REDTRACE_GLOBAL_INSTRUCTIONS"] == "automatic route rules\n"
    assert worker.env["REDTRACE_TOOLS_DIR"] == str(layout.runtime / "tools")
    assert worker.env["REDTRACE_TOOLS_BIN"] == str(layout.runtime / "tools" / "bin")
    assert (layout.runtime / "tools" / "bin").is_dir()


def test_all_native_workers_receive_and_can_invoke_route_skills(tmp_path: Path) -> None:
    layout = _layout(tmp_path / "redtrace")
    route_skills = layout.skills / "route-skills"
    route_skills.mkdir(parents=True)
    (route_skills / "SKILL.md").write_text("# route-skills\n", encoding="utf-8")
    (route_skills / "REDTRACE_RULES.md").write_text("automatic\n", encoding="utf-8")
    layout.mcp.mkdir()
    layout.plugins.mkdir()
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
    expected_path = str(route_skills.resolve())
    claude = ClaudeCodeDriver(local=True).build_execute(
        workers[0], "prompt", "session"
    ).argv
    codex = CodexDriver(local=True).build_execute(workers[1], "prompt", None).argv
    pi = PiDriver(local=True).build_execute(workers[2], "prompt", None).argv

    assert claude[claude.index("--plugin-dir") + 1].endswith("claude-plugin")
    assert expected_path in " ".join(codex)
    assert pi[pi.index("--skill") + 1] == expected_path
    assert all(worker.env["REDTRACE_GLOBAL_INSTRUCTIONS"] == "automatic\n" for worker in workers)


def test_local_runtime_auto_disables_and_recovers_mcp_with_missing_command(
    tmp_path: Path,
    monkeypatch,
) -> None:
    layout = _layout(tmp_path / "redtrace")
    layout.skills.mkdir(parents=True)
    layout.mcp.mkdir(parents=True)
    layout.plugins.mkdir(parents=True)
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
