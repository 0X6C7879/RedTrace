from __future__ import annotations

import json
import threading
from pathlib import Path
from types import SimpleNamespace

from fastapi.testclient import TestClient
from redtrace.capabilities import (
    CLAUDE_MCP_PATH,
    PI_MCP_EXTENSION,
    PI_MCP_PATH,
    PI_PROVIDER_EXTENSION_PATH,
    CapabilityStore,
    build_claude_mcp,
    build_pi_mcp,
    codex_mcp_overrides,
    materialize_local_workspace,
)
from redtrace.dispatcher.config import WorkerConfig
from redtrace.dispatcher.runtime.containers import ContainerManager
from redtrace.dispatcher.workers.adapters.claudecode import ClaudeCodeDriver
from redtrace.dispatcher.workers.adapters.codex import CodexDriver
from redtrace.dispatcher.workers.adapters.pi import PiDriver
from redtrace.server.app import app

SKILL = """---
name: recon
description: Run a focused reconnaissance workflow.
---

# Recon

Use the bundled scripts.
"""


def test_redtrace_cli_skills_define_one_cross_worker_protocol() -> None:
    repo_root = Path(__file__).resolve().parents[2]
    for relative_path in (
        "skills/redtrace-blackboard/SKILL.md",
        "skills/redtrace-resource/SKILL.md",
        "skills/skill-evolution/SKILL.md",
    ):
        content = (repo_root / relative_path).read_text(encoding="utf-8")
        assert "Claude Code、Codex 和 Pi" in content
        assert "当前 Worker 的 shell/terminal tool" in content
        assert "不是 MCP server、MCP tool 或 MCP Resource" in content
        assert "不要通过任何 MCP 接口调用" in content


def _worker(worker_type: str) -> WorkerConfig:
    return WorkerConfig.model_validate(
        {
            "name": worker_type,
            "type": worker_type,
            "max_running": 1,
            "priority": 0,
        }
    )


def test_store_and_materializer_share_native_agent_resources(tmp_path: Path) -> None:
    store = CapabilityStore(tmp_path)
    store.write_skill("recon", SKILL)
    (tmp_path / "skills" / "recon" / "scripts").mkdir()
    (tmp_path / "skills" / "recon" / "scripts" / "run.sh").write_text("#!/bin/sh\n", encoding="utf-8")
    store.write_skill("disabled", "# Disabled\n", enabled=False)
    store.write_mcp(
        "context7",
        {
            "enabled": True,
            "transport": "stdio",
            "command": "npx",
            "args": ["-y", "@upstash/context7-mcp"],
            "env": {"TOKEN": "${TOKEN}"},
            "agents": {
                "codex": {"startup_timeout_sec": 30},
                "pi": {"lifecycle": "eager"},
            },
        },
    )

    workspace = tmp_path / "workspace"
    workspace.mkdir()
    materialize_local_workspace(store, workspace)

    # Skills load natively from the agents' user-level Skill directories; the
    # task workspace only receives RedTrace runtime infrastructure.
    assert not (workspace / ".agents" / "skills" / "recon").exists()
    assert not (workspace / ".claude" / "skills" / "recon").exists()
    assert (tmp_path / "skills" / "recon" / "SKILL.md").is_file()
    assert (tmp_path / "skills" / "recon" / "scripts" / "run.sh").is_file()
    # The disabled Skill lives in disabled-skills/, invisible to the native
    # Skill loaders that only look at skills/.
    assert (tmp_path / "disabled-skills" / "disabled" / "SKILL.md").is_file()
    assert not (tmp_path / "skills" / "disabled").exists()

    claude = json.loads((workspace / CLAUDE_MCP_PATH).read_text(encoding="utf-8"))
    assert claude["mcpServers"]["context7"]["type"] == "stdio"
    assert "agents" not in claude["mcpServers"]["context7"]

    pi = json.loads((workspace / PI_MCP_PATH).read_text(encoding="utf-8"))
    assert pi["mcpServers"]["context7"]["lifecycle"] == "eager"
    provider_extension = (
        workspace / PI_PROVIDER_EXTENSION_PATH
    ).read_text(encoding="utf-8")
    assert 'pi.registerProvider("redtrace"' in provider_extension
    assert "supportsDeveloperRole: false" in provider_extension
    assert "PI_CODING_AGENT_DIR" not in provider_extension

    overrides = codex_mcp_overrides(store.list_mcp())
    assert "mcp_servers.context7.command=\"npx\"" in overrides
    assert "mcp_servers.context7.startup_timeout_sec=30" in overrides

    # Toggling moves the Skill between the enabled and disabled roots, so the
    # directory layout stays the single source of visibility truth.
    store.set_skill_enabled("recon", False)
    assert (tmp_path / "disabled-skills" / "recon" / "SKILL.md").is_file()
    assert not (tmp_path / "skills" / "recon").exists()
    materialize_local_workspace(store, workspace)
    assert not (workspace / ".agents" / "skills" / "recon").exists()

    store.set_skill_enabled("recon", True)
    assert (tmp_path / "skills" / "recon" / "SKILL.md").is_file()
    assert not (tmp_path / "disabled-skills" / "recon").exists()


def test_mcp_agent_specific_formats_preserve_native_fields(tmp_path: Path) -> None:
    store = CapabilityStore(tmp_path)
    record = store.write_mcp(
        "remote",
        {
            "url": "https://example.test/mcp",
            "headers": {"X-Key": "${KEY}"},
            "agents": {
                "claude": {"oauth": {"clientId": "client"}},
                "codex": {"tool_timeout_sec": 90},
                "pi": {"transport": "streamable-http", "healthCheckIntervalMs": 5000},
            },
        },
    )

    claude = json.loads(build_claude_mcp([record]))["mcpServers"]["remote"]
    assert claude["type"] == "http"
    assert claude["oauth"]["clientId"] == "client"

    pi = json.loads(build_pi_mcp([record]))["mcpServers"]["remote"]
    assert pi["transport"] == "streamable-http"
    assert pi["healthCheckIntervalMs"] == 5000

    overrides = codex_mcp_overrides([record])
    assert "mcp_servers.remote.http_headers={\"X-Key\"=\"${KEY}\"}" in overrides
    assert "mcp_servers.remote.tool_timeout_sec=90" in overrides


def test_capabilities_api_crud(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("REDTRACE_CAPABILITIES_ROOT", str(tmp_path))
    with TestClient(app) as client:
        index = client.get("/")
        assert index.status_code == 200
        assert 'x-data="skillsPage()"' in index.text
        assert 'x-data="mcpPage()"' in index.text
        assert 'x-data="pluginsPage()"' in index.text
        assert "Skill evolution queue" not in index.text
        assert "个包内 Skill" not in index.text
        assert "选择回滚版本" in index.text
        assert "先选择一个 RedTrace 项目" not in index.text[index.text.index("x-data=\"pluginsPage()\"") :]
        capabilities_script = client.get("/static/capabilities.js")
        assert capabilities_script.status_code == 200
        assert "skill-entries" in capabilities_script.text
        assert "async rollback()" in capabilities_script.text

        status = client.get("/capabilities")
        assert status.status_code == 200
        assert status.json()["root"] == str(tmp_path)
        assert "pluginsDir" not in status.json()

        created = client.post(
            "/capabilities/skills",
            json={"name": "recon", "content": SKILL, "enabled": True},
        )
        assert created.status_code == 201
        assert created.json()["description"] == "Run a focused reconnaissance workflow."

        nested = tmp_path / "skills" / "recon" / "modules" / "deep" / "SKILL.md"
        nested.parent.mkdir(parents=True)
        nested.write_text(
            "---\nname: deep-recon\ndescription: Inspect one nested route.\n---\n\n# Deep\n",
            encoding="utf-8",
        )
        entries = client.get("/capabilities/skills/recon/entries")
        assert entries.status_code == 200
        assert entries.json()[0]["name"] == "deep-recon"
        unified = client.get("/capabilities/skill-entries")
        assert unified.status_code == 200
        unified_by_key = {entry["key"]: entry for entry in unified.json()}
        assert unified_by_key["recon"]["nested"] is False
        assert unified_by_key["recon"]["enabled"] is True
        nested_entry = unified_by_key["recon:modules/deep/SKILL.md"]
        assert nested_entry["nested"] is True
        assert nested_entry["name"] == "deep-recon"
        assert nested_entry["enabled"] is True
        assert client.get("/capabilities").json()["skills"]["total"] == 2
        detail = client.get(
            "/capabilities/skills/recon/entries/modules/deep/SKILL.md"
        )
        assert detail.status_code == 200
        assert detail.json()["content"].endswith("# Deep\n")

        toggled = client.patch("/capabilities/skills/recon/enabled", json={"enabled": False})
        assert toggled.status_code == 200
        assert toggled.json()["enabled"] is False
        toggled_entries = {
            entry["key"]: entry
            for entry in client.get("/capabilities/skill-entries").json()
        }
        assert toggled_entries["recon"]["enabled"] is False
        assert toggled_entries["recon:modules/deep/SKILL.md"]["enabled"] is False

        server = client.post(
            "/capabilities/mcp",
            json={
                "name": "filesystem",
                "config": {
                    "enabled": True,
                    "transport": "stdio",
                    "command": "npx",
                    "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
                },
            },
        )
        assert server.status_code == 201
        assert server.json()["agents"] == ["claude", "codex", "pi"]

        invalid = client.post(
            "/capabilities/mcp",
            json={"name": "broken", "config": {"enabled": True}},
        )
        assert invalid.status_code == 400

        # External plugins are gone: the legacy endpoints are permanent 501
        # stubs so old clients fail loudly instead of 404ing mid-request.
        plugin = client.post(
            "/capabilities/plugins",
            json={
                "id": "browser",
                "config": {
                    "name": "Browser traffic",
                    "kind": "chromium-devtools",
                    "path": "plugins/browser",
                    "entrypoint": "manifest.json",
                    "enabled": True,
                    "agents": ["claude", "codex", "pi"],
                },
            },
        )
        assert plugin.status_code == 501
        assert client.get("/capabilities/plugins").json() == []
        assert client.patch(
            "/capabilities/plugins/browser/enabled", json={"enabled": False}
        ).status_code == 501

        assert client.delete("/capabilities/skills/recon").status_code == 204
        assert client.delete("/capabilities/mcp/filesystem").status_code == 204


def test_skill_list_does_not_walk_dependency_directories(tmp_path: Path) -> None:
    store = CapabilityStore(tmp_path)
    store.write_skill("recon", SKILL)
    skill_dir = tmp_path / "skills" / "recon"
    dependency = skill_dir / "node_modules" / "package" / "index.js"
    dependency.parent.mkdir(parents=True)
    dependency.write_text("module.exports = {};\n", encoding="utf-8")
    reference = skill_dir / "references" / "workflow.md"
    reference.parent.mkdir()
    reference.write_text("# Workflow\n", encoding="utf-8")

    listed = store.list_skills()
    detail = store.get_skill("recon")

    assert listed[0].files == ()
    assert "references/workflow.md" in detail.files
    assert not any(path.startswith("node_modules/") for path in detail.files)


def test_skill_list_reuses_short_process_cache(
    tmp_path: Path,
    monkeypatch,
) -> None:
    store = CapabilityStore(tmp_path)
    store.write_skill("recon", SKILL)
    first = store.list_skills()

    def unexpected_rescan():
        raise AssertionError("Skill metadata was rescanned inside the cache window")

    monkeypatch.setattr(store, "_list_skills_uncached", unexpected_rescan)

    assert store.list_skills() == first


def test_drivers_keep_native_config_and_inject_shared_mcp(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(
        "redtrace.dispatcher.workers.adapters.codex.codex_compat_base_url",
        lambda _upstream: "http://127.0.0.1:1234/token",
    )
    monkeypatch.setenv("REDTRACE_CAPABILITIES_ROOT", str(tmp_path))
    store = CapabilityStore(tmp_path)
    store.write_mcp(
        "filesystem",
        {"transport": "stdio", "command": "mcp-filesystem", "args": ["."]},
    )

    claude_worker = _worker("claudecode")
    claude_worker.env["REDTRACE_CLAUDE_MCP_CONFIG"] = "runtime/mcp/claude.json"
    claude = ClaudeCodeDriver().build_execute(claude_worker, "PROMPT", "session").argv
    assert claude[claude.index("--mcp-config") + 1] == "runtime/mcp/claude.json"

    codex_worker = _worker("codex")
    codex_worker.env["REDTRACE_CODEX_RESOURCE_ARGS"] = json.dumps(
        codex_mcp_overrides(store.list_mcp())
    )
    codex = CodexDriver(local=True).build_execute(codex_worker, "PROMPT", None).argv
    assert any("mcp_servers.filesystem.command" in argument for argument in codex)

    codex_worker.env.update(
        {
            "CODEX_MODEL": "custom-model",
            "CODEX_BASE_URL": "https://example.test/v1",
            "OPENAI_API_KEY": "secret",
        }
    )
    configured_codex = CodexDriver(local=True).build_execute(
        codex_worker, "PROMPT", None
    ).argv
    assert not any(
        "mcp_servers.filesystem.command" in argument for argument in configured_codex
    )
    assert "features.multi_agent=false" in configured_codex
    assert 'web_search="disabled"' in configured_codex

    pi = PiDriver(local=True).build_execute(_worker("pi"), "PROMPT", None).argv
    assert PI_MCP_EXTENSION in pi
    assert "--session-dir" not in pi
    assert "--approve" in pi
    assert "--no-extensions" not in pi
    assert "--no-skills" not in pi
    assert "--tools" not in pi


def test_container_ready_does_not_upload_capabilities_to_workspace() -> None:
    class FakeContainer:
        def __init__(self) -> None:
            self.archives: list[bytes] = []
            self.commands: list[list[str]] = []

        def exec_run(self, command):
            self.commands.append(command)
            return SimpleNamespace(exit_code=0, output=b"initialized")

        def put_archive(self, path: str, archive: bytes) -> bool:
            assert path == "/home/kali/workspace"
            self.archives.append(archive)
            return True

    container = FakeContainer()
    manager = ContainerManager.__new__(ContainerManager)
    manager._require_container = lambda _name: container

    assert manager._ready("worker") == "worker"
    assert container.archives == []
    assert container.commands == []
