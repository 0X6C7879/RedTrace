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
    PI_PROVIDER_EXTENSION_PATH,
    CapabilityStore,
    materialize_local_workspace,
)
from redtrace.dispatcher.config import DispatchConfig, LocalConfig, WorkerConfig
from redtrace.dispatcher.runtime.cancellation import TaskCancellation
from redtrace.dispatcher.runtime.local_backend import LocalBackend
from redtrace.dispatcher.runtime.local_process import LocalProcess
from redtrace.dispatcher.scheduler import loop as loop_module
from redtrace.dispatcher.tasks import common, explore
from redtrace.dispatcher.workers.adapters.codex import CodexDriver
from redtrace.dispatcher.workers.adapters.pi import PiDriver
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
    tmp_path: Path,
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

    assert Path(handle) == tmp_path / "proj_001"
    assert Path(handle).is_dir()
    assert backend.container_name("proj_001") == str(tmp_path / "proj_001")


def test_local_backend_retries_transient_workspace_create_race(
    tmp_path: Path,
    monkeypatch,
) -> None:
    project_dir = tmp_path / "proj_001"
    original_mkdir = Path.mkdir
    raced = False

    def racing_mkdir(path: Path, *args, **kwargs) -> None:
        nonlocal raced
        if path == project_dir and not raced:
            raced = True
            original_mkdir(path, *args, **kwargs)
            raise FileExistsError(path)
        original_mkdir(path, *args, **kwargs)

    monkeypatch.setattr(Path, "mkdir", racing_mkdir)
    backend = LocalBackend(LocalConfig(workspace_root=str(tmp_path)))

    assert Path(backend.ensure_running("proj_001")) == project_dir
    assert project_dir.is_dir()


def test_local_backend_does_not_replace_workspace_file(tmp_path: Path) -> None:
    project_path = tmp_path / "proj_001"
    project_path.write_text("keep me", encoding="utf-8")
    backend = LocalBackend(LocalConfig(workspace_root=str(tmp_path)))

    with pytest.raises(NotADirectoryError, match="managed directory path"):
        backend.ensure_running("proj_001")

    assert project_path.read_text(encoding="utf-8") == "keep me"


def test_local_backend_reports_wsl_ghost_directory_with_guidance(
    tmp_path: Path,
    monkeypatch,
) -> None:
    project_dir = tmp_path / "proj_001"

    def ghosted_mkdir(path: Path, *args, **kwargs) -> None:
        if path == project_dir:
            # WSL drvfs ghost: mkdir says EEXIST while stat says ENOENT.
            raise FileExistsError(17, "File exists", str(path))
        Path.mkdir(path, *args, **kwargs)

    monkeypatch.setattr(Path, "mkdir", ghosted_mkdir)
    backend = LocalBackend(LocalConfig(workspace_root=str(tmp_path)))

    with pytest.raises(RuntimeError, match="wsl.exe --shutdown"):
        backend.ensure_running("proj_001")

    assert not project_dir.exists()


def test_local_backend_keeps_agent_config_linked_and_conversations_in_project(
    tmp_path: Path,
    monkeypatch,
) -> None:
    home = tmp_path / "home"
    codex_home = home / ".codex"
    codex_home.mkdir(parents=True)
    config = codex_home / "config.toml"
    config.write_text('model = "user-model"\n', encoding="utf-8")
    (codex_home / "sessions").mkdir()
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: home))
    paths = RedTracePaths(
        root=tmp_path,
        skills=tmp_path / "skills",
        mcp=tmp_path / "mcp",
        plugins=tmp_path / "plugins",
        managed=tmp_path / ".redtrace",
        workspaces=tmp_path / "workspaces",
        audit=tmp_path / ".redtrace" / "audit",
    )
    pi_mcp = paths.runtime / "mcp" / "pi.json"
    pi_mcp.parent.mkdir(parents=True)
    pi_mcp.write_text('{"mcpServers":{}}\n', encoding="utf-8")
    backend = LocalBackend(
        LocalConfig(workspace_root=str(paths.workspaces)), paths=paths
    )

    workspace = Path(backend.ensure_running("proj_001"))
    env = backend.conversation_environment("proj_001", "codex")
    state = paths.workspaces / "proj_001" / ".redtrace" / "conversations" / "codex"

    assert env == {"CODEX_HOME": str(state)}
    assert (state / "config.toml").read_text(encoding="utf-8") == config.read_text(
        encoding="utf-8"
    )
    assert not (state / "sessions").exists()
    assert (workspace / ".pi" / "mcp.json").resolve() == pi_mcp.resolve()
    assert backend.conversation_environment("proj_001", "pi") == {
        "PI_CODING_AGENT_SESSION_DIR": str(
            paths.workspaces / "proj_001" / ".redtrace" / "conversations" / "pi"
        )
    }


def test_local_graph_snapshot_uses_managed_project_path(tmp_path: Path) -> None:
    root = tmp_path / "redtrace"
    paths = RedTracePaths(
        root=root,
        skills=root / "skills",
        mcp=root / "mcp",
        plugins=root / "plugins",
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
    )

    snapshot = next(
        (paths.workspaces / "proj_001" / ".redtrace" / "prompts").glob(
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

    workspace = str((tmp_path / "proj_001").resolve())
    assert result.stdout == f"host-worker|{workspace}|{workspace}|{workspace}"


def test_local_common_env_reaches_worker_subprocess(
    tmp_path: Path, monkeypatch
) -> None:
    # common_env (e.g. an outbound proxy) merges into every worker's env and must survive
    # all the way to the host subprocess in local mode.
    payload = _local_payload()
    payload["local"] = {"workspace_root": str(tmp_path)}
    payload["common_env"] = {
        "https_proxy": "http://127.0.0.1:7897",
        "http_proxy": "http://127.0.0.1:7897",
        "all_proxy": "http://127.0.0.1:7897",
    }
    config = DispatchConfig.model_validate(payload)
    worker = next(w for w in config.workers if w.type == "claudecode")
    assert worker.env["https_proxy"] == "http://127.0.0.1:7897"

    assert config.local is not None
    backend = LocalBackend(config.local)
    handle = backend.ensure_running("proj_001")
    process = backend.build_exec_process(
        handle,
        dict(worker.env),
        ["sh", "-c", 'printf "%s|%s|%s" "$https_proxy" "$http_proxy" "$all_proxy"'],
        timeout_seconds=10,
    )
    process.start()
    result = process.communicate(timeout=20)

    proxy = "http://127.0.0.1:7897"
    assert result.stdout == f"{proxy}|{proxy}|{proxy}"


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
        LocalConfig(workspace_root=str(tmp_path), completed_action="keep")
    )
    handle = backend.ensure_running("proj_001")

    assert backend.needs_completed_cleanup("proj_001") is False
    assert backend.cleanup_completed("proj_001") is True
    assert Path(handle).is_dir()


def test_local_backend_completion_preserves_workspace_until_deletion(
    tmp_path: Path,
) -> None:
    backend = LocalBackend(
        LocalConfig(workspace_root=str(tmp_path), completed_action="remove")
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
            "reason": {"timeout": 10, "max_intents": 3},
            "explore": {"timeout": 10, "conclude_timeout": 5},
        },
        "workers": [
            {
                "name": "local-claude",
                "type": "claudecode",
                "task_types": ["bootstrap", "reason", "explore"],
                "max_running": 1,
                "priority": 0,
            },
            {
                "name": "local-codex",
                "type": "codex",
                "task_types": ["bootstrap", "reason", "explore"],
                "max_running": 1,
                "priority": 1,
            },
            {
                "name": "local-pi",
                "type": "pi",
                "task_types": ["bootstrap", "reason", "explore"],
                "max_running": 1,
                "priority": 2,
            },
        ],
    }


def test_local_execution_needs_no_container_or_worker_env() -> None:
    config = DispatchConfig.model_validate(_local_payload())

    assert config.container is None
    assert config.local is not None
    assert config.local.completed_action == "keep"
    assert all(worker.env == {} for worker in config.workers)


def test_local_workspace_root_is_optional_and_defaults_null() -> None:
    payload = _local_payload()
    payload["local"] = {"completed_action": "remove"}
    config = DispatchConfig.model_validate(payload)

    assert config.local is not None
    assert config.local.workspace_root is None
    assert config.local.completed_action == "remove"


def test_container_execution_requires_container_block() -> None:
    payload = make_config().model_dump()
    payload["container"] = None

    with pytest.raises(ValidationError, match="container config is required"):
        DispatchConfig.model_validate(payload)


def test_container_execution_still_requires_worker_env() -> None:
    payload = _local_payload()
    payload["runtime"]["execution"] = "container"
    payload["runtime"]["worker_healthcheck"] = "startup_only"
    payload["container"] = {
        "image": "img",
        "network_mode": "host",
        "completed_action": "stop",
    }

    with pytest.raises(ValidationError, match="missing env keys"):
        DispatchConfig.model_validate(payload)


def test_local_execution_rejects_partial_worker_api_override() -> None:
    payload = _local_payload()
    payload["workers"][0]["env"] = {
        "ANTHROPIC_BASE_URL": "https://api.example.test",
        "ANTHROPIC_MODEL": "claude-test",
    }

    with pytest.raises(ValidationError, match="must configure all API override"):
        DispatchConfig.model_validate(payload)


def test_shipped_local_example_config_is_valid() -> None:
    config = DispatchConfig.load(REPO_ROOT / "redtrace.local.example.yaml")

    assert config.runtime.execution == "local"
    assert config.container is None
    assert config.local is not None
    assert config.local.completed_action == "keep"
    assert config.runtime.healthcheck_timeout == 60
    assert config.tasks.bootstrap.timeout == 1800
    assert config.tasks.bootstrap.conclude_timeout == 300
    assert config.tasks.reason.timeout == 300
    assert config.tasks.explore.timeout == 1800
    assert config.tasks.explore.conclude_timeout == 300
    assert config.context_harness.inline_bytes == 256 * 1024
    assert config.context_harness.visible_bytes == 64 * 1024
    assert config.context_harness.query_bytes == 1024 * 1024
    assert config.context_harness.parse_bytes == 64 * 1024 * 1024
    assert config.context_harness.worker_output_chars == 8 * 1024 * 1024


# --------------------------------------------------------------------------- startup CLI check


def _bare_loop(config: DispatchConfig) -> loop_module.DispatcherLoop:
    loop = loop_module.DispatcherLoop.__new__(loop_module.DispatcherLoop)
    loop.config = config
    return loop


def test_local_cli_check_passes_when_cli_present() -> None:
    payload = _local_payload()
    payload["workers"] = [
        {
            "name": "m",
            "type": "mock",
            "max_running": 1,
            "priority": 0,
        }
    ]
    config = DispatchConfig.model_validate(payload)

    _bare_loop(
        config
    )._run_local_binary_check()  # mock -> python3 --help runs; must not raise


def test_local_cli_check_exits_when_no_cli_installed(monkeypatch) -> None:
    monkeypatch.setattr(loop_module.shutil, "which", lambda _binary: None)
    config = DispatchConfig.model_validate(_local_payload())

    with pytest.raises(RuntimeError, match="none of the configured worker CLIs"):
        _bare_loop(config)._run_local_binary_check()


# --------------------------------------------------------------------------- drivers


def _bare_worker(
    worker_type: str,
    *,
    context_length: int | None = None,
) -> WorkerConfig:
    return WorkerConfig.model_validate(
        {
            "name": worker_type,
            "type": worker_type,
            "task_types": ["bootstrap", "reason", "explore"],
            "max_running": 1,
            "priority": 0,
            "context_length": context_length,
        }
    )


def test_codex_local_driver_omits_provider_injection() -> None:
    worker = _bare_worker("codex", context_length=1_048_576)
    execute = CodexDriver(local=True).build_execute(worker, "PROMPT", None)
    argv = execute.argv

    assert argv[:2] == ["codex", "app-server"]
    assert 'web_search="live"' in argv
    assert "model_context_window=1048576" in argv
    assert "model_auto_compact_token_limit=943718" in argv
    assert execute.live_control.prompt == "PROMPT"
    assert '"method":"initialize"' in execute.stdin
    assert not any("model_providers" in part for part in argv)
    assert "--model" not in argv

    conclude = CodexDriver(local=True).build_conclude(worker, "PROMPT", "sess-1")
    assert conclude.argv[:2] == ["codex", "app-server"]
    assert conclude.live_control.session_id == "sess-1"
    assert conclude.live_control.prompt == "PROMPT"
    assert '"method":"initialize"' in conclude.stdin
    assert not any("model_providers" in part for part in conclude.argv)


def test_pi_local_driver_omits_models_json_and_provider() -> None:
    worker = _bare_worker("pi")
    execute = PiDriver(local=True).build_execute(worker, "PROMPT", None)
    argv = execute.argv

    assert argv[0] == "pi"
    assert "--approve" in argv
    assert "--provider" not in argv
    assert "--model" not in argv
    assert argv[argv.index("--mode") + 1] == "rpc"
    assert '"type":"prompt","message":"PROMPT"' in execute.stdin
    assert execute.live_control is not None


@pytest.mark.skipif(PI_TEST_BINARY is None, reason="pi CLI is not installed")
def test_pi_runtime_extension_registers_worker_model_without_api_call(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    materialize_local_workspace(CapabilityStore(tmp_path / "capabilities"), workspace)
    env = {
        **os.environ,
        "PI_CODING_AGENT_DIR": str(tmp_path / "global-pi-config"),
        "PI_BASE_URL": "https://api.example.test/v1",
        "PI_API_KEY": "pi-worker-secret",
        "PI_MODEL": "redtrace-test-model",
        "PI_PROVIDER_API": "openai-completions",
    }

    result = subprocess.run(
        [
            PI_TEST_BINARY,
            "--extension",
            PI_PROVIDER_EXTENSION_PATH,
            "--list-models",
            "redtrace-test-model",
        ],
        cwd=workspace,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )

    assert result.returncode == 0, result.stderr
    # Pi releases may render the model table on either output stream.
    assert "redtrace-test-model" in result.stdout + result.stderr


def test_get_driver_selects_local_or_container_variant() -> None:
    assert get_driver("codex", "local").local is True
    assert get_driver("codex").local is False
    assert get_driver("pi", "local").local is True
    assert get_driver("claudecode", "local").local is True
    assert get_driver("claudecode").local is False
    # mock has no native CLI mode differences.
    assert get_driver("mock", "local") is get_driver("mock")


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
                "reason": {"timeout": 30, "max_intents": 3},
                "explore": {"timeout": 30, "conclude_timeout": 10},
            },
            "workers": [
                {
                    "name": name,
                    "type": worker_type,
                    "task_types": ["bootstrap", "reason", "explore"],
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


def test_explore_runs_real_local_cli_end_to_end(tmp_path: Path, monkeypatch) -> None:
    # A fake `claude` on PATH stands in for the real CLI: the whole local path is exercised
    # for real — driver argv -> LocalBackend -> LocalProcess subprocess -> stdout parsing.
    _install_fake_cli(
        tmp_path,
        monkeypatch,
        "claude",
        'echo \'{"accepted":true,"data":{"description":"local fake fact"}}\'',
    )
    config = _local_config_for_worker("test-worker", "claudecode")
    backend = LocalBackend(LocalConfig(workspace_root=str(tmp_path / "work")))
    intent = make_intent()
    project = make_project(intents=[intent])
    client = FakeClient(project)

    outcome = explore.run_explore_task(
        config,
        client,
        backend,
        project,
        "facts:\n- id: f001\n",
        intent,
        config.workers[0],
        TaskCancellation(),
    )

    assert outcome == "success"
    assert client.concluded == [("proj_001", "i001", "test-worker", "local fake fact")]
    # graph snapshot was materialised on the host under the patched root
    snapshot_root = tmp_path / "work" / "proj_001" / ".redtrace" / "prompts"
    assert any(p.name == "graph.yaml" for p in snapshot_root.rglob("*"))


def test_explore_local_cli_rejection_releases_intent(
    tmp_path: Path, monkeypatch
) -> None:
    _install_fake_cli(
        tmp_path,
        monkeypatch,
        "claude",
        'echo \'{"accepted":false,"reason":"policy_refusal"}\'',
    )
    config = _local_config_for_worker("test-worker", "claudecode")
    backend = LocalBackend(LocalConfig(workspace_root=str(tmp_path / "work")))
    intent = make_intent()
    project = make_project(intents=[intent])
    client = FakeClient(project)

    outcome = explore.run_explore_task(
        config,
        client,
        backend,
        project,
        "facts:\n- id: f001\n",
        intent,
        config.workers[0],
        TaskCancellation(),
    )

    assert outcome == "rejected"
    assert client.concluded == []
    assert client.released == [("proj_001", "i001", "test-worker")]
