from __future__ import annotations

import json
import threading
from pathlib import Path
from types import SimpleNamespace

from fastapi.testclient import TestClient
from redtrace.capabilities import (
    CapabilityStore,
    materialize_local_workspace,
)
from redtrace.dispatcher.config import WorkerConfig
from redtrace.dispatcher.runtime.containers import ContainerManager
from redtrace.server.app import app

SKILL = """---
name: recon
description: Run a focused reconnaissance workflow.
metadata:
  redtrace:
    capabilities: [web]
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
        # The protocol speaks to the current Worker's shell only; no
        # CLI-agent names may leak back into the contract.
        assert "Claude Code" not in content
        assert "当前 Worker 的 shell/terminal tool" in content
        assert "不是 MCP server、MCP tool 或 MCP Resource" in content
        assert "不要通过任何 MCP 接口调用" in content


def _worker(worker_type: str) -> WorkerConfig:
    return WorkerConfig.model_validate(
        {
            "name": worker_type,
            "provider": worker_type,
            "max_running": 1,
            "priority": 0,
        }
    )






def test_capabilities_api_crud(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("REDTRACE_CAPABILITIES_ROOT", str(tmp_path))
    with TestClient(app) as client:
        index = client.get("/")
        assert index.status_code == 200
        assert 'x-data="skillsPage()"' in index.text
        assert 'x-data="mcpPage()"' in index.text
        assert "插件功能已移除" not in index.text
        assert 'x-data="pluginsPage()"' in index.text
        assert "Skill evolution queue" not in index.text
        assert "个包内 Skill" not in index.text
        assert "选择回滚版本" in index.text
        capabilities_script = client.get("/static/capabilities.js")
        assert capabilities_script.status_code == 200
        assert "skill-entries" in capabilities_script.text
        assert "async rollback()" in capabilities_script.text
        assert "pluginsPage" not in capabilities_script.text
        assert "/capabilities/plugins" not in capabilities_script.text
        plugins_script = client.get("/static/plugins.js")
        assert plugins_script.status_code == 200
        assert "pluginsPage" in plugins_script.text
        assert "/__redtrace/plugins" in plugins_script.text

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
        assert server.json()["agents"] == ["dsh"]

        invalid = client.post(
            "/capabilities/mcp",
            json={"name": "broken", "config": {"enabled": True}},
        )
        assert invalid.status_code == 400

        assert client.get("/capabilities/plugins").status_code == 404
        assert client.post("/capabilities/plugins", json={}).status_code == 404

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
    monkeypatch
) -> None:
    store = CapabilityStore(tmp_path)
    store.write_skill("recon", SKILL)
    first = store.list_skills()

    def unexpected_rescan():
        raise AssertionError("Skill metadata was rescanned inside the cache window")

    monkeypatch.setattr(store, "_list_skills_uncached", unexpected_rescan)

    assert store.list_skills() == first
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
