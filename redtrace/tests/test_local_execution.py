from __future__ import annotations

import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest
from conftest import FakeClient, make_config, make_intent, make_project
from pydantic import ValidationError
from redtrace.capabilities import (
    CapabilityStore,
    materialize_local_workspace,
)
from redtrace.dispatcher.config import DispatchConfig, LocalConfig, WorkerConfig
from redtrace.dispatcher.runtime.cancellation import TaskCancellation
from redtrace.dispatcher.runtime.local_backend import LocalBackend
from redtrace.dispatcher.runtime.containers import ContainerManager
from redtrace.dispatcher.runtime.local_process import LocalProcess
from redtrace.dispatcher.scheduler import loop as loop_module
from redtrace.dispatcher.tasks import common, explore
from redtrace.dispatcher.workers.registry import get_driver
from redtrace.paths import RedTracePaths

REPO_ROOT = Path(__file__).resolve().parents[2]
PI_TEST_BINARY = shutil.which("pi.cmd" if os.name == "nt" else "pi")


# --------------------------------------------------------------------------- LocalProcess


def test_local_process_captures_stdout_and_exit_code() -> None:
    process = LocalProcess(
        [sys.executable, "-c", "import sys; print('hello'); sys.exit(3)"],
        cwd=os.getcwd(),
        env=dict(os.environ),
        timeout_seconds=10,
    )
    process.start()
    result = process.communicate(timeout=20)

    assert result.stdout.strip() == "hello"
    assert result.returncode == 3
    assert not result.timed_out


def test_local_process_inherits_cwd(tmp_path: Path) -> None:
    process = LocalProcess(
        [sys.executable, "-c", "import os; print(os.getcwd())"],
        cwd=str(tmp_path),
        env=dict(os.environ),
        timeout_seconds=10,
    )
    process.start()
    result = process.communicate(timeout=20)

    assert Path(result.stdout.strip()).resolve() == tmp_path.resolve()


@pytest.mark.skipif(os.name != "nt", reason="Windows npm shim behavior")
def test_local_process_preserves_json_arguments_through_powershell_shim(
    tmp_path: Path
) -> None:
    (tmp_path / "fake.cmd").write_text("@echo off\r\n")
    (tmp_path / "fake.ps1").write_text(
        "param([string]$Value)\n[Console]::Write($Value)\n",
        encoding="utf-8",
    )
    env = {**os.environ, "PATH": f"{tmp_path}{os.pathsep}{os.environ['PATH']}"}
    payload = '{"accepted":true,"data":{"description":"ok"}}'
    process = LocalProcess(
        ["fake", payload],
        cwd=str(tmp_path),
        env=env,
        timeout_seconds=10,
    )

    process.start()
    result = process.communicate(timeout=20)

    assert result.returncode == 0
    assert result.stdout == payload


def test_local_process_times_out_and_kills_within_grace() -> None:
    process = LocalProcess(
        [sys.executable, "-c", "import time; time.sleep(30)"],
        cwd=os.getcwd(),
        env=dict(os.environ),
        timeout_seconds=1,
        term_grace_seconds=2,
    )
    process.start()
    started = time.monotonic()
    result = process.communicate(timeout=30)
    elapsed = time.monotonic() - started

    assert result.timed_out
    assert elapsed < 10  # killed on its own timeout, not the 30s outer backstop


def test_local_process_kill_terminates_child_process_group(tmp_path: Path) -> None:
    if os.name == "nt":
        pytest.skip(
            "POSIX process-group assertion; Windows tree kill is covered by timeout tests"
        )
    pid_file = tmp_path / "child.pid"
    script = f"sleep 30 & echo $! > {pid_file}; wait"
    process = LocalProcess(
        ["sh", "-c", script],
        cwd=str(tmp_path),
        env=dict(os.environ),
        timeout_seconds=1,
        term_grace_seconds=2,
    )
    process.start()
    result = process.communicate(timeout=30)

    assert result.timed_out
    child_pid = int(pid_file.read_text().strip())
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        try:
            os.kill(child_pid, 0)
        except ProcessLookupError:
            break
        time.sleep(0.1)
    else:
        raise AssertionError(f"child process {child_pid} survived the group kill")


def test_local_process_cancel_records_reason() -> None:
    process = LocalProcess(
        [sys.executable, "-c", "import time; time.sleep(30)"],
        cwd=os.getcwd(),
        env=dict(os.environ),
        timeout_seconds=30,
        term_grace_seconds=2,
    )
    process.start()
    process.cancel("project stopped")
    result = process.communicate(timeout=30)

    assert result.cancelled
    assert result.cancel_reason == "project stopped"


def test_local_process_accepts_live_stdin_without_restart() -> None:
    process = LocalProcess(
        [
            sys.executable,
            "-c",
            "import sys; [print(line.strip(), flush=True) for line in sys.stdin]",
        ],
        cwd=os.getcwd(),
        env=dict(os.environ),
        stdin_text="first\n",
        keep_stdin_open=True,
        timeout_seconds=10,
    )
    process.start()
    assert process.send_stdin("second\n")
    process.close_stdin()
    result = process.communicate(timeout=20)

    assert result.returncode == 0
    assert result.stdout.splitlines() == ["first", "second"]


# --------------------------------------------------------------------------- LocalBackend


def test_local_backend_creates_isolated_project_dir(tmp_path: Path) -> None:
    backend = LocalBackend(LocalConfig(workspace_root=str(tmp_path)))
    handle = backend.ensure_running("proj_001")

    assert Path(handle) == tmp_path / "proj_001" / "workspace"
    assert Path(handle).is_dir()
    assert (tmp_path / "proj_001" / "cache").is_dir()
    assert (tmp_path / "proj_001" / "runtime").is_dir()
    assert backend.container_name("proj_001") == str(tmp_path / "proj_001" / "workspace")


def test_local_backend_retries_transient_workspace_create_race(
    tmp_path: Path,
    monkeypatch
) -> None:
    workspace_dir = tmp_path / "proj_001" / "workspace"
    original_mkdir = Path.mkdir
    raced = False

    def racing_mkdir(path: Path, *args, **kwargs) -> None:
        nonlocal raced
        if path == workspace_dir and not raced:
            raced = True
            original_mkdir(path, *args, **kwargs)
            raise FileExistsError(path)
        original_mkdir(path, *args, **kwargs)

    monkeypatch.setattr(Path, "mkdir", racing_mkdir)
    backend = LocalBackend(LocalConfig(workspace_root=str(tmp_path)))

    assert Path(backend.ensure_running("proj_001")) == workspace_dir


def test_local_backend_refuses_to_recreate_missing_active_workspace(
    tmp_path: Path
) -> None:
    backend = LocalBackend(LocalConfig(workspace_root=str(tmp_path)))
    workspace = Path(backend.ensure_running("proj_001"))
    shutil.rmtree(workspace.parent)

    with pytest.raises(RuntimeError, match="workspace integrity failure"):
        backend.ensure_running("proj_001")


def test_local_backend_does_not_replace_workspace_file(tmp_path: Path) -> None:
    project_path = tmp_path / "proj_001"
    project_path.mkdir(parents=True)
    workspace_file = project_path / "workspace"
    workspace_file.write_text("keep me", encoding="utf-8")
    backend = LocalBackend(LocalConfig(workspace_root=str(tmp_path)))

    with pytest.raises(NotADirectoryError, match="managed directory path"):
        backend.ensure_running("proj_001")

    assert workspace_file.read_text(encoding="utf-8") == "keep me"


def test_local_backend_reports_wsl_ghost_directory_with_guidance(
    tmp_path: Path,
    monkeypatch
) -> None:
    workspace_dir = tmp_path / "proj_001" / "workspace"

    def ghosted_mkdir(path: Path, *args, **kwargs) -> None:
        if path == workspace_dir:
            # WSL drvfs ghost: mkdir says EEXIST while stat says ENOENT.
            raise FileExistsError(17, "File exists", str(path))
        Path.mkdir(path, *args, **kwargs)

    monkeypatch.setattr(Path, "mkdir", ghosted_mkdir)
    backend = LocalBackend(LocalConfig(workspace_root=str(tmp_path)))

    with pytest.raises(RuntimeError, match="wsl.exe --shutdown"):
        backend.ensure_running("proj_001")

    assert not workspace_dir.exists()






def test_local_graph_snapshot_uses_managed_project_path(tmp_path: Path) -> None:
    root = tmp_path / "redtrace"
    paths = RedTracePaths(
        root=root,
        skills=root / "skills",
        mcp=root / "mcp",
        managed=root / ".redtrace",
        workspaces=root / "workspaces",
        audit=root / ".redtrace" / "audit",
    )
    backend = LocalBackend(
        LocalConfig(workspace_root=str(paths.workspaces)),
        paths=paths,
    )
    handle = backend.ensure_running("proj_001")

    reference = common.write_graph_snapshot_reference(
        backend,
        handle,
        "facts:\n- id: f001\n",
        phase="reason_execute",
        runtime_dir=str(backend.runtime_dir("proj_001")),
    )

    snapshot = next(
        (paths.workspaces / "proj_001" / "runtime" / ".redtrace" / "prompts").glob(
            "reason_execute-*/graph.yaml"
        )
    )
    assert snapshot.read_text(encoding="utf-8") == "facts:\n- id: f001\n"
    assert str(snapshot) in reference


def test_local_backend_merges_host_env_with_worker_env(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("REDTRACE_HOST_VAR", "host")
    backend = LocalBackend(LocalConfig(workspace_root=str(tmp_path)))
    handle = backend.ensure_running("proj_001")

    process = backend.build_exec_process(
        handle,
        {"REDTRACE_WORKER_VAR": "worker"},
        [
            "sh",
            "-c",
            'printf "%s-%s|%s|%s|%s" "$REDTRACE_HOST_VAR" "$REDTRACE_WORKER_VAR" "$PWD" "$REDTRACE_WORKSPACE" "$TMPDIR"',
        ],
        timeout_seconds=10,
    )
    process.start()
    result = process.communicate(timeout=20)

    workspace = str((tmp_path / "proj_001" / "workspace").resolve())
    assert process.env["PWD"] == workspace
    # Without project_id, TMPDIR falls back to workspace
    assert process.env["TMPDIR"] == workspace
    assert result.stdout.split("|")[0] == "host-worker"
    assert result.stdout.split("|")[2] == workspace




def test_local_backend_write_text_file_writes_to_host(tmp_path: Path) -> None:
    backend = LocalBackend(LocalConfig(workspace_root=str(tmp_path)))
    handle = backend.ensure_running("proj_001")
    target = Path(handle) / "snapshots" / "graph.yaml"

    backend.write_text_file(handle, str(target), "facts: []\n")

    assert target.read_text() == "facts: []\n"
    with pytest.raises(ValueError, match="outside workspace"):
        backend.write_text_file(handle, str(tmp_path / "outside.yaml"), "nope")


def test_local_backend_keep_leaves_dir_and_reports_no_cleanup(tmp_path: Path) -> None:
    backend = LocalBackend(
        LocalConfig(workspace_root=str(tmp_path))
    )
    handle = backend.ensure_running("proj_001")

    assert backend.needs_completed_cleanup("proj_001") is False
    assert backend.cleanup_completed("proj_001") is True
    assert Path(handle).is_dir()


def test_local_backend_completion_preserves_workspace_until_deletion(
    tmp_path: Path
) -> None:
    backend = LocalBackend(
        LocalConfig(workspace_root=str(tmp_path))
    )
    handle = backend.ensure_running("proj_001")

    assert backend.needs_completed_cleanup("proj_001") is False
    assert backend.cleanup_completed("proj_001") is True
    assert Path(handle).exists()
    assert backend.cleanup_deleted("proj_001") is True
    assert not Path(handle).exists()


def test_local_backend_stopped_cleanup_is_noop(tmp_path: Path) -> None:
    backend = LocalBackend(LocalConfig(workspace_root=str(tmp_path)))
    backend.ensure_running("proj_001")

    assert backend.needs_stopped_cleanup("proj_001") is False
    assert backend.cleanup_stopped("proj_001") is True


# --------------------------------------------------------------------------- config


def _local_payload() -> dict:
    return {
        "server": "http://127.0.0.1:8000",
        "runtime": {
            "execution": "local",
            "worker_healthcheck": "disabled",
            "interval": 3,
            "max_workers": 2,
            "max_running_projects": 1,
            "max_project_workers": 2,
            "healthcheck_timeout": 5,
            "prompt_group": "default",
        },
        "tasks": {
            "bootstrap": {"timeout": 10, "conclude_timeout": 5},
            "reason": {"timeout": 10, "conclude_timeout": 5, "max_intents": 3},
            "explore": {"timeout": 10, "conclude_timeout": 5},
        },
        "providers": {
            "gw": {
                "api": "openai-completions",
                "base_url": "https://gw.example.test",
                "api_key": "sk-test",
                "models": [
                    {"id": "deepseek-chat"},
                    {"id": "deepseek-reasoner"},
                    {"id": "glm-5.3"},
                ],
            }
        },
        "workers": [
            {
                "name": "local-claude",
                "provider": "gw",
                "model": "deepseek-chat",
                "max_running": 1,
                "priority": 0,
            },
            {
                "name": "local-codex",
                "provider": "gw",
                "model": "deepseek-reasoner",
                "max_running": 1,
                "priority": 1,
            },
            {
                "name": "local-pi",
                "provider": "gw",
                "model": "glm-5.3",
                "max_running": 1,
                "priority": 2,
            },
        ],
    }


def test_local_execution_needs_no_container_or_worker_env() -> None:
    config = DispatchConfig.model_validate(_local_payload())

    assert config.container is None
    assert config.local is not None
    assert all(worker.env == {} for worker in config.workers)
    assert {worker.provider for worker in config.workers} == {"gw"}


def test_local_workspace_root_is_optional_and_defaults_null() -> None:
    payload = _local_payload()
    payload["local"] = {}
    config = DispatchConfig.model_validate(payload)

    assert config.local is not None
    assert config.local.workspace_root is None


def test_container_execution_requires_container_block() -> None:
    payload = make_config().model_dump()
    payload["container"] = None

    with pytest.raises(ValidationError, match="container config is required"):
        DispatchConfig.model_validate(payload)








# --------------------------------------------------------------------------- startup CLI check


def _bare_loop(config: DispatchConfig) -> loop_module.DispatcherLoop:
    loop = loop_module.DispatcherLoop.__new__(loop_module.DispatcherLoop)
    loop.config = config
    return loop






# --------------------------------------------------------------------------- drivers


def _bare_worker(worker_type: str) -> WorkerConfig:
    return WorkerConfig.model_validate(
        {
            "name": worker_type,
            "provider": worker_type,
            "max_running": 1,
            "priority": 0,
        }
    )










# --------------------------------------------------------------------------- end to end


def _local_config_for_worker(name: str, worker_type: str) -> DispatchConfig:
    return DispatchConfig.model_validate(
        {
            "server": "in-process",
            "runtime": {
                "execution": "local",
                "worker_healthcheck": "disabled",
                "interval": 60,
                "max_workers": 1,
                "max_running_projects": 1,
                "max_project_workers": 1,
                "healthcheck_timeout": 5,
                "prompt_group": "default",
            },
            "tasks": {
                "bootstrap": {"timeout": 30, "conclude_timeout": 10},
                "reason": {"timeout": 30, "conclude_timeout": 10, "max_intents": 3},
                "explore": {"timeout": 30, "conclude_timeout": 10},
            },
            "workers": [
                {
                    "name": name,
                    "provider": worker_type,
                    "max_running": 1,
                    "priority": 0,
                }
            ],
        }
    )


def _install_fake_cli(tmp_path: Path, monkeypatch, name: str, body: str) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    if os.name == "nt":
        script = bin_dir / f"{name}.cmd"
        cmd_body = body
        if body.startswith("echo '") and body.endswith("'"):
            cmd_body = f"echo {body[6:-1]}"
        script.write_text(f"@echo off\r\n{cmd_body}\r\n")
    else:
        script = bin_dir / name
        script.write_text(f"#!/bin/sh\n{body}\n")
    script.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ['PATH']}")



