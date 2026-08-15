"""Real Codegraph CLI / MCP smoke tests.

Skipped when the codegraph binary is not installed (see deploy.sh and
container/Dockerfile for the pinned installation). These tests exercise the
actual stdio MCP handshake instead of trusting the JSON configuration.
"""
from __future__ import annotations

import json
import os
import queue
import shutil
import subprocess
import threading
from pathlib import Path

import pytest


pytestmark = pytest.mark.skipif(
    shutil.which("codegraph") is None,
    reason="codegraph CLI is not installed",
)

# Windows installs codegraph as a .cmd shim that subprocess cannot exec directly.
_USE_SHELL = os.name == "nt"

_SAMPLE = (
    "def add(a, b):\n"
    "    return a + b\n"
    "\n"
    "\n"
    "def main():\n"
    "    print(add(1, 2))\n"
)


def _reader(stdout, out_queue: "queue.Queue[dict]") -> None:
    for line in iter(stdout.readline, ""):
        line = line.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict):
            out_queue.put(payload)


def _roundtrip(proc, messages: "queue.Queue[dict]", payload: dict, timeout: float) -> dict:
    proc.stdin.write(json.dumps(payload) + "\n")
    proc.stdin.flush()
    while True:
        message = messages.get(timeout=timeout)
        if message.get("id") == payload.get("id"):
            return message


def test_codegraph_cli_reports_version() -> None:
    completed = subprocess.run(
        ["codegraph", "--version"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=True,
        timeout=60,
        shell=_USE_SHELL,
    )
    assert completed.stdout.strip() or completed.stderr.strip()


def test_codegraph_mcp_stdio_handshake_exposes_audit_tools(tmp_path: Path) -> None:
    project = tmp_path / "project"
    project.mkdir()
    (project / "app.py").write_text(_SAMPLE, encoding="utf-8")

    init = subprocess.run(
        ["codegraph", "init", str(project)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=300,
        check=False,
        shell=_USE_SHELL,
    )
    assert init.returncode == 0, init.stderr or init.stdout
    assert (project / ".codegraph" / "codegraph.db").is_file()

    proc = subprocess.Popen(
        ["codegraph", "serve", "--mcp", "--path", str(project), "--no-watch"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        encoding="utf-8",
        errors="replace",
        cwd=str(project),
        bufsize=1,
        shell=_USE_SHELL,
    )
    messages: "queue.Queue[dict]" = queue.Queue()
    reader = threading.Thread(target=_reader, args=(proc.stdout, messages), daemon=True)
    reader.start()
    try:
        initialized = _roundtrip(
            proc,
            messages,
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "redtrace-smoke", "version": "1.0"},
                },
            },
            timeout=60,
        )
        assert "result" in initialized, initialized
        server_info = initialized["result"].get("serverInfo", {})
        assert server_info.get("name"), initialized

        proc.stdin.write(
            json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n"
        )
        proc.stdin.flush()

        names: set[str] = set()
        cursor: str | None = None
        request_id = 2
        while True:
            params: dict = {}
            if cursor is not None:
                params["cursor"] = cursor
            tools = _roundtrip(
                proc,
                messages,
                {"jsonrpc": "2.0", "id": request_id, "method": "tools/list", "params": params},
                timeout=60,
            )
            result = tools.get("result", {})
            names.update(tool["name"] for tool in result.get("tools", []))
            cursor = result.get("nextCursor")
            request_id += 1
            if not cursor:
                break
        required = {
            # Standalone codegraph CLI exposes the consolidated explore tool;
            # search/node/callers/callees/files remain available as CLI
            # subcommands (see code-audit SKILL.md tooling note).
            "codegraph_explore",
        }
        assert required <= names, sorted(names)
    finally:
        proc.kill()
        proc.wait(timeout=10)


def test_shared_mcp_config_avoids_shell_expansion_syntax() -> None:
    config_path = (
        Path(__file__).resolve().parents[2] / "mcp" / "codegraph.json"
    )
    config = json.loads(config_path.read_text(encoding="utf-8"))
    serialized = json.dumps(config)
    assert "${" not in serialized, "MCP JSON must not rely on shell variable expansion"
    assert config["command"] == "codegraph"
    assert config["args"][:2] == ["serve", "--mcp"]
