from __future__ import annotations

import io
import json
import tarfile
from pathlib import Path
from types import SimpleNamespace

from fastapi.testclient import TestClient

from redtrace.capabilities import (
    BLACKBOARD_CLI_PATH,
    CLAUDE_MCP_PATH,
    CONTEXT_CLI_PATH,
    MANIFEST_PATH,
    PI_MCP_EXTENSION,
    PI_MCP_PATH,
    PI_PROVIDER_EXTENSION_PATH,
    PLUGIN_CATALOG_PATH,
    RESOURCE_CLI_PATH,
    SKILL_CLI_PATH,
    CapabilityStore,
    build_claude_mcp,
    build_pi_mcp,
    codex_mcp_overrides,
    materialize_local_workspace,
)
from redtrace.plugin_registry import PluginRegistry
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


def _worker(worker_type: str) -> WorkerConfig:
    return WorkerConfig.model_validate(
        {
            "name": worker_type,
            "type": worker_type,
            "task_types": ["explore"],
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
    plugin_dir = tmp_path / "plugins" / "browser"
    plugin_dir.mkdir(parents=True)
    (plugin_dir / "manifest.json").write_text("{}\n", encoding="utf-8")
    PluginRegistry(tmp_path).write_plugin(
        "browser",
        {
            "name": "Browser traffic",
            "description": "Browser ingress",
            "kind": "chromium-devtools",
            "path": "plugins/browser",
            "entrypoint": "manifest.json",
            "enabled": True,
            "agents": ["claude", "codex", "pi"],
        },
    )

    workspace = tmp_path / "workspace"
    workspace.mkdir()
    materialize_local_workspace(store, workspace)

    assert (workspace / ".agents" / "skills" / "recon" / "SKILL.md").read_text(encoding="utf-8") == SKILL
    assert (workspace / ".claude" / "skills" / "recon" / "scripts" / "run.sh").is_file()
    assert (workspace / SKILL_CLI_PATH).is_file()
    assert not (workspace / ".agents" / "skills" / "disabled").exists()

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
    plugins = json.loads((workspace / PLUGIN_CATALOG_PATH).read_text(encoding="utf-8"))
    assert [plugin["id"] for plugin in plugins["plugins"]] == ["browser"]
    assert plugins["plugins"][0]["agents"] == ["claude", "codex", "pi"]

    overrides = codex_mcp_overrides(store.list_mcp())
    assert "mcp_servers.context7.command=\"npx\"" in overrides
    assert "mcp_servers.context7.startup_timeout_sec=30" in overrides

    store.set_skill_enabled("recon", False)
    materialize_local_workspace(store, workspace)
    assert (workspace / ".agents" / "skills" / "recon").exists()
    assert (workspace / ".claude" / "skills" / "recon").exists()

    next_workspace = tmp_path / "next-workspace"
    next_workspace.mkdir()
    materialize_local_workspace(store, next_workspace)
    assert not (next_workspace / ".agents" / "skills" / "recon").exists()
    assert not (next_workspace / ".claude" / "skills" / "recon").exists()


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
        assert "先选择一个 RedTrace 项目" not in index.text[index.text.index("x-data=\"pluginsPage()\"") :]
        assert client.get("/static/capabilities.js").status_code == 200

        status = client.get("/capabilities")
        assert status.status_code == 200
        assert status.json()["root"] == str(tmp_path)
        assert status.json()["pluginsDir"] == str(tmp_path / "plugins")

        created = client.post(
            "/capabilities/skills",
            json={"name": "recon", "content": SKILL, "enabled": True},
        )
        assert created.status_code == 201
        assert created.json()["description"] == "Run a focused reconnaissance workflow."

        toggled = client.patch("/capabilities/skills/recon/enabled", json={"enabled": False})
        assert toggled.status_code == 200
        assert toggled.json()["enabled"] is False

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

        plugin_dir = tmp_path / "plugins" / "browser"
        plugin_dir.mkdir(parents=True)
        (plugin_dir / "manifest.json").write_text("{}\n", encoding="utf-8")
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
        assert plugin.status_code == 201
        assert plugin.json()["ready"] is True
        assert plugin.json()["agents"] == ["claude", "codex", "pi"]

        disabled = client.patch(
            "/capabilities/plugins/browser/enabled",
            json={"enabled": False},
        )
        assert disabled.status_code == 200
        assert disabled.json()["enabled"] is False

        assert client.delete("/capabilities/skills/recon").status_code == 204
        assert client.delete("/capabilities/mcp/filesystem").status_code == 204
        assert client.delete("/capabilities/plugins/browser").status_code == 204
        assert plugin_dir.is_dir()


def test_drivers_keep_native_features_and_add_shared_mcp(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("REDTRACE_CAPABILITIES_ROOT", str(tmp_path))
    CapabilityStore(tmp_path).write_mcp(
        "filesystem",
        {"transport": "stdio", "command": "mcp-filesystem", "args": ["."]},
    )

    claude = ClaudeCodeDriver().build_execute(_worker("claudecode"), "PROMPT", "session").argv
    mcp_index = claude.index("--mcp-config")
    assert claude[mcp_index + 1] == CLAUDE_MCP_PATH

    codex = CodexDriver(local=True).build_execute(_worker("codex"), "PROMPT", None).argv
    assert "mcp_servers.filesystem.command=\"mcp-filesystem\"" in codex

    pi = PiDriver(local=True).build_execute(_worker("pi"), "PROMPT", None).argv
    assert PI_MCP_EXTENSION in pi
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
            return SimpleNamespace(exit_code=1, output=b"")

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
