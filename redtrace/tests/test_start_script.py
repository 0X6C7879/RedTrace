from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest
from click.testing import CliRunner

from redtrace import startup
from redtrace.cli import main


REPO_ROOT = Path(__file__).resolve().parents[2]
BASH_SCRIPT = REPO_ROOT / "start-redtrace.sh"
WINDOWS_SCRIPT = REPO_ROOT / "start-redtrace.cmd"


@pytest.mark.skipif(os.name == "nt", reason="Bash syntax is a POSIX check")
def test_start_script_is_valid_bash() -> None:
    subprocess.run(["bash", "-n", str(BASH_SCRIPT)], check=True)


class _FakeCompleted:
    def __init__(self, stdout: str) -> None:
        self.stdout = stdout
        self.returncode = 0


def _fake_parent_comm(monkeypatch: pytest.MonkeyPatch, comm: str) -> None:
    monkeypatch.setattr(startup.os, "getppid", lambda: 4242)

    def fake_run(argv: list[str], **_kwargs: object) -> _FakeCompleted:
        assert "comm=" in argv, f"unexpected probe: {argv}"
        return _FakeCompleted(comm + "\n")

    monkeypatch.setattr(subprocess, "run", fake_run)


@pytest.mark.skipif(os.name == "nt", reason="Unix parent-shell probe")
def test_detect_parent_shell_rejects_launcher_parents(monkeypatch: pytest.MonkeyPatch) -> None:
    # `uv run redtrace start` makes uv the parent process; it must not become DSH_SHELL.
    _fake_parent_comm(monkeypatch, "uv")
    monkeypatch.setenv("SHELL", "/bin/zsh")
    assert startup._detect_parent_shell() == "/bin/zsh"


@pytest.mark.skipif(os.name == "nt", reason="Unix parent-shell probe")
def test_detect_parent_shell_rejects_other_launcher_parents(monkeypatch: pytest.MonkeyPatch) -> None:
    for comm in ("npm", "node", "make", "/opt/homebrew/bin/python3.14"):
        _fake_parent_comm(monkeypatch, comm)
        monkeypatch.setenv("SHELL", "/bin/bash")
        assert startup._detect_parent_shell() == "/bin/bash", comm


@pytest.mark.skipif(os.name == "nt", reason="Unix parent-shell probe")
def test_detect_parent_shell_accepts_real_shell_parents(monkeypatch: pytest.MonkeyPatch) -> None:
    for comm in ("zsh", "-zsh", "/bin/bash", "fish"):
        _fake_parent_comm(monkeypatch, comm)
        monkeypatch.setenv("SHELL", "/bin/bash")
        detected = startup._detect_parent_shell()
        assert startup._looks_like_shell(detected.rsplit("/", 1)[-1]), comm


@pytest.mark.skipif(os.name == "nt", reason="Unix parent-shell probe")
def test_detect_parent_shell_falls_back_to_platform_default(monkeypatch: pytest.MonkeyPatch) -> None:
    _fake_parent_comm(monkeypatch, "uv")
    monkeypatch.delenv("SHELL", raising=False)
    assert startup._detect_parent_shell() is None


def test_dsh_restores_the_python_environment_from_before_uv_run() -> None:
    env = {
        "PATH": "/repo/.venv-linux/bin:/usr/bin",
        "VIRTUAL_ENV": "/repo/.venv-linux",
        "UV_PROJECT_ENVIRONMENT": "/repo/.venv-linux",
        "REDTRACE_PARENT_PATH": "/root/miniconda3/bin:/usr/bin",
        "REDTRACE_PARENT_VIRTUAL_ENV": "",
    }

    startup._restore_parent_python_environment(env)

    assert env["PATH"] == "/root/miniconda3/bin:/usr/bin"
    assert "VIRTUAL_ENV" not in env
    assert "UV_PROJECT_ENVIRONMENT" not in env
    assert not any(name.startswith("REDTRACE_PARENT_") for name in env)


def test_platform_wrappers_use_one_shared_start_command() -> None:
    bash = BASH_SCRIPT.read_text(encoding="utf-8")
    windows = WINDOWS_SCRIPT.read_text(encoding="utf-8")

    assert "run-redtrace-node.mjs" in bash
    assert "run-redtrace-node.mjs" in windows
    assert "Node.js 24.15" in bash
    assert "Node.js 24.15" in windows
    assert "REDTRACE_DSH_ROOT" in bash
    assert "REDTRACE_PARENT_PATH" in bash
    assert "REDTRACE_PARENT_VIRTUAL_ENV" in bash
    assert "node-v24.21.0-win-x64" in windows
    assert "uv sync" not in bash
    assert "uv sync" not in windows


def test_start_scripts_answer_help_without_config() -> None:
    bash = BASH_SCRIPT.read_text(encoding="utf-8")
    windows = WINDOWS_SCRIPT.read_text(encoding="utf-8")

    assert '"$@"' in bash
    assert "%*" in windows
    assert "run-redtrace-node.mjs" in bash
    assert "run-redtrace-node.mjs" in windows


def test_start_command_help_documents_both_components() -> None:
    result = CliRunner().invoke(main, ["start", "--help"])

    assert result.exit_code == 0
    assert "RedTrace Server and Dispatcher" in result.output
    assert "--config" in result.output
    assert "--host" in result.output
    assert "--port" in result.output


def test_start_command_accepts_host_and_port_environment(monkeypatch) -> None:
    captured: dict[str, object] = {}
    monkeypatch.setenv("REDTRACE_HOST", "0.0.0.0")
    monkeypatch.setenv("REDTRACE_PORT", "8765")
    monkeypatch.setattr(
        "redtrace.cli.run_startup",
        lambda **options: captured.update(options) or 0,
    )

    result = CliRunner().invoke(main, ["start"])

    assert result.exit_code == 0
    assert captured["host"] == "0.0.0.0"
    assert captured["port"] == 8765


def test_startup_supervises_and_stops_both_components(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = tmp_path / "redtrace.yaml"
    config.write_text(
        "server: http://127.0.0.1:8000\n"
        "runtime:\n"
        "  execution: local\n"
        "  max_workers: 1\n"
        "  max_running_projects: 1\n"
        "  max_project_workers: 1\n"
        "  interval: 1\n"
        "  healthcheck_timeout: 1\n"
        "  prompt_group: mock\n"
        "tasks:\n"
        "  bootstrap: {timeout: 1, conclude_timeout: 1}\n"
        "  reason: {timeout: 1, conclude_timeout: 1, max_intents: 1}\n"
        "  explore: {timeout: 1, conclude_timeout: 1}\n"
        "local: {}\n"
        "workers:\n"
        "  - {name: mock-1, provider: mock, max_running: 1, priority: 0}\n",
        encoding="utf-8",
    )

    class Process:
        next_pid = 100

        def __init__(self, exit_after: int | None = None):
            self.pid = Process.next_pid
            Process.next_pid += 1
            self.exit_after = exit_after
            self.polls = 0

        def poll(self):
            self.polls += 1
            if self.exit_after is not None and self.polls >= self.exit_after:
                return 7
            return None

    server = Process()
    dispatcher = Process(exit_after=2)
    started: list[tuple[list[str], Path]] = []
    stopped: list[Process] = []
    readiness = iter([False, True])
    signal_default = object()

    def start(arguments: list[str], root: Path):
        started.append((arguments, root))
        return server if len(started) == 1 else dispatcher

    monkeypatch.setattr(startup, "_server_is_ready", lambda _url: next(readiness))
    monkeypatch.setattr(startup, "_start_process", start)
    monkeypatch.setattr(
        startup.db,
        "prepare_database_path",
        lambda root: root / ".redtrace" / "redtrace.db",
    )
    monkeypatch.setattr(
        startup,
        "_stop_process",
        lambda process, _timeout: stopped.append(process),
    )
    monkeypatch.setattr(
        startup.signal, "signal", lambda _signal, _handler: signal_default
    )
    monkeypatch.setattr(startup.time, "sleep", lambda _seconds: None)
    for name in ("REDTRACE_ROOT", "REDTRACE_DISPATCH_CONFIG", "TMPDIR", "TMP", "TEMP"):
        monkeypatch.setenv(name, "test-placeholder")

    status = startup.run(config=config, host="127.0.0.1", port=8765)

    assert status == 7
    assert len(started) == 2
    assert started[0][0][:4] == [sys.executable, "-m", "redtrace", "serve"]
    assert started[1][0][:4] == [sys.executable, "-m", "redtrace", "dispatch"]
    assert stopped == [dispatcher, server]


def test_probe_url_uses_loopback_for_wildcard_binds() -> None:
    assert startup._probe_url("0.0.0.0", 8000) == "http://127.0.0.1:8000/projects"
    assert startup._probe_url("::1", 8000) == "http://[::1]:8000/projects"
