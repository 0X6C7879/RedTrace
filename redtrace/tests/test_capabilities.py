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
    PLUGIN_CATALOG_PATH,
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
from redtrace.plugin_registry import PluginRegistry
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
        assert "Skill evolution queue" not in index.text
        assert "包内 Skill" in index.text
        assert "选择回滚版本" in index.text
        assert "先选择一个 RedTrace 项目" not in index.text[index.text.index("x-data=\"pluginsPage()\"") :]
        capabilities_script = client.get("/static/capabilities.js")
        assert capabilities_script.status_code == 200
        assert "skill-entries" in capabilities_script.text
        assert "nestedEntries" not in capabilities_script.text
        assert "async rollback()" in capabilities_script.text

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

        nested = tmp_path / "skills" / "recon" / "modules" / "deep" / "SKILL.md"
        nested.parent.mkdir(parents=True)
        nested.write_text(
            "---\nname: deep-recon\ndescription: Inspect one nested route.\n---\n\n# Deep\n",
            encoding="utf-8",
        )
        entries = client.get("/capabilities/skills/recon/entries")
        assert entries.status_code == 200
        assert entries.json()[0]["name"] == "deep-recon"
        detail = client.get(
            "/capabilities/skills/recon/entries/modules/deep/SKILL.md"
        )
        assert detail.status_code == 200
        assert detail.json()["content"].endswith("# Deep\n")

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


def test_skill_entries_unify_root_and_nested_skills(
    monkeypatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("REDTRACE_CAPABILITIES_ROOT", str(tmp_path))
    store = CapabilityStore(tmp_path)
    for name in ("alpha", "beta", "pack-a"):
        store.write_skill(name, SKILL)
    ida = tmp_path / "skills" / "pack-a" / "upstream" / "skills" / "ida-reverse"
    ida.mkdir(parents=True)
    (ida / "SKILL.md").write_text(
        "---\n"
        "name: ida-reverse\n"
        "description: |\n"
        "  Use IDA Pro to analyze binaries.\n"
        "  Focus on stripping wrappers.\n"
        "---\n"
        "\n"
        "# IDA reverse\n",
        encoding="utf-8",
    )
    ghidra = tmp_path / "skills" / "alpha" / "tools" / "ghidra-flow"
    ghidra.mkdir(parents=True)
    (ghidra / "SKILL.md").write_text(
        "---\n"
        "name: ghidra-flow\n"
        "description: >\n"
        "  Trace control flow\n"
        "  with Ghidra.\n"
        "---\n"
        "\n"
        "# Ghidra flow\n",
        encoding="utf-8",
    )
    # Dependency directories never surface as Skills.
    ignored = tmp_path / "skills" / "pack-a" / "node_modules" / "fake"
    ignored.mkdir(parents=True)
    (ignored / "SKILL.md").write_text("---\nname: fake\n---\n", encoding="utf-8")

    with TestClient(app) as client:
        status = client.get("/capabilities").json()
        assert status["skills"] == {"total": 5, "enabled": 5}

        entries = client.get("/capabilities/skill-entries").json()
        assert len(entries) == 5
        keys = {entry["key"] for entry in entries}
        assert {"alpha", "beta", "pack-a"} <= keys
        assert not any("node_modules" in entry["path"] for entry in entries)

        ida_entry = next(
            entry
            for entry in entries
            if entry["key"] == "pack-a:upstream/skills/ida-reverse/SKILL.md"
        )
        assert ida_entry["name"] == "ida-reverse"
        assert ida_entry["parent"] == "pack-a"
        assert ida_entry["nested"] is True
        assert ida_entry["readonly"] is True
        assert ida_entry["enabled"] is True
        assert ida_entry["depth"] == 3
        assert ida_entry["description"] == (
            "Use IDA Pro to analyze binaries. Focus on stripping wrappers."
        )

        ghidra_entry = next(
            entry for entry in entries if entry["name"] == "ghidra-flow"
        )
        assert ghidra_entry["parent"] == "alpha"
        assert ghidra_entry["description"] == "Trace control flow with Ghidra."

        # Disabling a root package disables every nested Skill inside it,
        # while nested Skills of other packages stay enabled.
        toggled = client.patch(
            "/capabilities/skills/pack-a/enabled", json={"enabled": False}
        )
        assert toggled.status_code == 200

        entries = client.get("/capabilities/skill-entries").json()
        by_key = {entry["key"]: entry for entry in entries}
        assert by_key["pack-a"]["enabled"] is False
        assert by_key["pack-a:upstream/skills/ida-reverse/SKILL.md"]["enabled"] is False
        assert by_key["alpha:tools/ghidra-flow/SKILL.md"]["enabled"] is True
        status = client.get("/capabilities").json()
        assert status["skills"] == {"total": 5, "enabled": 3}


def test_nested_skill_entries_normalize_descriptions_and_degrade_safely(
    tmp_path: Path,
) -> None:
    store = CapabilityStore(tmp_path)
    store.write_skill("pack", SKILL)
    root = tmp_path / "skills" / "pack"
    cases = {
        "literal": (
            "---\n"
            "name: literal-skill\n"
            "description: |\n"
            "  第一段\n"
            "  第二段\n"
            "---\n"
            "\n"
            "# Literal\n"
        ),
        "non-string": (
            "---\n"
            "name: non-string\n"
            "description: [1, 2]\n"
            "---\n"
            "\n"
            "# Non string\n"
        ),
        "broken": "---\nname: [unclosed\ndescription: nope\n---\n\n# Broken\n",
    }
    for directory_name, content in cases.items():
        directory = root / directory_name
        directory.mkdir(parents=True)
        (directory / "SKILL.md").write_text(content, encoding="utf-8")

    entries = {
        entry.path: entry for entry in store.list_skill_entries() if entry.nested
    }
    literal = entries["literal/SKILL.md"]
    assert literal.description == "第一段 第二段"
    assert not literal.description.startswith(("|", ">", "\n", " "))
    assert entries["non-string/SKILL.md"].description == ""
    broken = entries["broken/SKILL.md"]
    assert broken.name == "broken"
    assert broken.description == ""


def test_skill_entries_mark_routers_without_hiding_concrete_skills(
    tmp_path: Path,
) -> None:
    store = CapabilityStore(tmp_path)
    store.write_skill("pack", SKILL)
    root = tmp_path / "skills" / "pack"
    # Router frontmatter: explicit flag plus a routing description.
    (root / "SKILL.md").write_text(
        "---\n"
        "name: pack\n"
        "description: Routes authorized tasks to the most specific Skill.\n"
        "metadata:\n"
        "  router: true\n"
        "---\n"
        "\n"
        "# Pack router\n",
        encoding="utf-8",
    )
    sub_router = root / "upstream" / "skills"
    sub_router.mkdir(parents=True)
    (sub_router / "SKILL.md").write_text(
        "---\n"
        "name: sub-router\n"
        "description: Routes reverse engineering tasks to specialists.\n"
        "---\n"
        "\n"
        "# Sub router\n",
        encoding="utf-8",
    )
    concrete = sub_router / "pentest-tools"
    concrete.mkdir(parents=True)
    (concrete / "SKILL.md").write_text(
        "---\n"
        "name: pentest-tools\n"
        "description: Penetration testing toolchain.\n"
        "---\n"
        "\n"
        "# Pentest\n",
        encoding="utf-8",
    )
    sub_skill = concrete / "src-hunter"
    sub_skill.mkdir(parents=True)
    (sub_skill / "SKILL.md").write_text(
        "---\n"
        "name: src-hunter\n"
        "description: Hunt source code.\n"
        "---\n"
        "\n"
        "# Src hunter\n",
        encoding="utf-8",
    )

    by_key = {entry.key: entry for entry in store.list_skill_entries()}
    assert by_key["pack"].router is True
    assert by_key["pack:upstream/skills/SKILL.md"].router is True
    # Concrete Skills stay visible even when they bundle deeper sub-Skills.
    assert by_key["pack:upstream/skills/pentest-tools/SKILL.md"].router is False
    assert by_key["pack:upstream/skills/pentest-tools/src-hunter/SKILL.md"].router is False


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
    manager._route_skills_initialized = False
    manager._route_skills_init_lock = threading.Lock()

    assert manager._ready("worker") == "worker"
    assert container.archives == []
    assert container.commands == [
        [
            "bash",
            "/opt/redtrace/claude-plugin/skills/route-skills/redtrace-tools/initialize.sh",
        ]
    ]
