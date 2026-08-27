from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import URLError
from urllib.request import ProxyHandler, build_opener

# Readiness probes target loopback services; routing them through an
# http_proxy would make startup depend on the proxy process being up.
_LOOPBACK_OPENER = build_opener(ProxyHandler({}))



class StartupError(RuntimeError):
    pass


def _looks_like_shell(name: str) -> bool:
    """Whether a process name is a real shell (zsh/bash/sh/dash/ksh/fish/pwsh...).

    Launchers such as ``uv run``/``npm``/``make`` sit between the invoking shell
    and this process; accepting them as DSH_SHELL would make every worker bash
    command spawn ``uv -c ...`` instead of a shell.
    """
    base = name.rstrip("/").rsplit("/", 1)[-1].lower()
    return "sh" in base


def _detect_parent_shell() -> str | None:
    """Detect the shell that launched this process.

    Returns an absolute path on Unix (e.g. /bin/zsh) or a command name on
    Windows (e.g. cmd.exe).  Returns None when detection fails so callers
    can fall back to platform defaults.
    """
    import platform as _platform
    import subprocess as _sp

    if _platform.system() == "Windows":
        # ComSpec is almost always cmd.exe; PSModulePath signals PowerShell.
        if os.environ.get("PSModulePath"):
            return "powershell.exe"
        return os.environ.get("ComSpec") or "cmd.exe"

    # Unix: probe the parent process first (most reliable). The parent may be a
    # launcher (uv/npm/...) rather than a shell, so only accept shell-like names.
    try:
        ppid = os.getppid()
        result = _sp.run(
            ["ps", "-p", str(ppid), "-o", "comm="],
            capture_output=True, text=True, timeout=2,
        )
        if result.returncode == 0:
            name = result.stdout.strip().lstrip("-")
            if name and _looks_like_shell(name):
                # ps may return a bare name ("zsh") or an absolute path.
                if name.startswith("/"):
                    return name
                for candidate in (f"/bin/{name}", f"/usr/bin/{name}"):
                    if os.path.isfile(candidate):
                        return candidate
                return name
    except (OSError, _sp.SubprocessError, _sp.TimeoutExpired):
        pass

    # Fallback: $SHELL (login shell, may differ from the invoking shell).
    shell = os.environ.get("SHELL")
    if shell and os.path.isfile(shell):
        return shell

    return None


def _ensure_dsh_ready(root: Path) -> None:
    if not (root / "vendor" / "deepseek-harness" / "package.json").is_file():
        raise StartupError(
            "DSH submodule is missing; run git submodule update --init --recursive"
        )
    required = (
        root
        / "vendor"
        / "deepseek-harness"
        / "packages"
        / "boot"
        / "app-boot"
        / "lib"
        / "index.js",
        root / "packages" / "redtrace-dsh" / "lib" / "index.js",
        root / "profiles" / "redtrace" / "runtime.cordis.yml",
        root
        / "vendor"
        / "deepseek-harness"
        / "packages"
        / "mcp"
        / "mcp-client"
        / "lib"
        / "index.js",
        root
        / "vendor"
        / "deepseek-harness"
        / "packages"
        / "settings"
        / "settings-file"
        / "lib"
        / "index.js",
    )
    missing = next((path for path in required if not path.is_file()), None)
    if missing is not None:
        raise StartupError(
            f"DSH artifacts are missing ({missing}); run npm run dsh:install then npm run dsh:build"
        )
    try:
        version = subprocess.run(
            ["node", "--version"],
            capture_output=True,
            text=True,
            check=True,
            timeout=5,
        ).stdout.strip().removeprefix("v")
        major, minor, *_ = (int(part) for part in version.split("."))
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        raise StartupError("Node.js >=22.19 is required for DSH") from exc
    if major < 22 or major == 22 and minor < 19:
        raise StartupError(f"Node.js >=22.19 is required for DSH; found {version}")


def _positive_env(name: str, default: int) -> int:
    raw = os.environ.get(name, str(default))
    try:
        value = int(raw)
    except ValueError as exc:
        raise StartupError(f"{name} must be a positive integer") from exc
    if value <= 0:
        raise StartupError(f"{name} must be a positive integer")
    return value


def _probe_url(host: str, port: int) -> str:
    if host in {"0.0.0.0", "::", "[::]"}:
        host = "127.0.0.1"
    elif ":" in host and not host.startswith("["):
        host = f"[{host}]"
    return f"http://{host}:{port}/projects"


def _server_is_ready(url: str) -> bool:
    try:
        with _LOOPBACK_OPENER.open(url, timeout=2) as response:
            return response.status < 400
    except (OSError, URLError):
        return False


def _start_process(
    arguments: list[str],
    root: Path,
    *,
    env: dict[str, str] | None = None,
) -> subprocess.Popen[bytes]:
    options: dict[str, object] = {}
    if os.name == "nt":
        options["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        options["start_new_session"] = True
    return subprocess.Popen(arguments, cwd=root, env=env, **options)


def _free_loopback_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def _restore_parent_python_environment(env: dict[str, str]) -> None:
    parent_path = env.pop("REDTRACE_PARENT_PATH", None)
    parent_virtual_env = env.pop("REDTRACE_PARENT_VIRTUAL_ENV", None)
    if parent_path is None:
        return
    env["PATH"] = parent_path
    if parent_virtual_env:
        env["VIRTUAL_ENV"] = parent_virtual_env
    else:
        env.pop("VIRTUAL_ENV", None)
    env.pop("UV_PROJECT_ENVIRONMENT", None)


def _dsh_environment(config, root: Path, api_url: str, host: str, port: int) -> dict[str, str]:
    from redtrace.agent_runtime import AgentRuntimeManager
    from redtrace.dispatcher.dsh import dsh_providers

    paths = config.paths.layout()
    providers, api_keys = dsh_providers(config)
    child_env = dict(os.environ)
    _restore_parent_python_environment(child_env)
    for name, value in api_keys.items():
        child_env[name] = value
    for name, value in config.common_env.items():
        child_env[name] = value

    manager = AgentRuntimeManager(paths, execution="local")
    runtime_config = {
        "runtime": True,
        "server": api_url,
        "root": str(paths.root),
        "sessionRoot": str(paths.managed / "dsh" / "sessions"),
        "skillsDir": str(paths.skills),
        "workspacesDir": str(paths.workspaces),
        "staticDir": str(Path(__file__).resolve().parent / "server" / "static"),
        "interval": config.runtime.interval,
        "maxWorkers": config.runtime.max_workers,
        "maxRunningProjects": config.runtime.max_running_projects,
        "maxProjectWorkers": config.runtime.max_project_workers,
        "tasks": config.tasks.model_dump(),
        "mcpConfigs": manager.dsh_mcp_configs(),
    }
    profile = root / "profiles" / "redtrace" / "runtime.cordis.yml"
    child_env.update(
        {
            "DSH_CORDIS_CONFIG": str(profile),
            "DSH_SESSION_ROOT": runtime_config["sessionRoot"],
            "REDTRACE_DSH_SETTINGS": str(paths.managed / "dsh" / "settings.yaml"),
            "REDTRACE_DSH_WEB_HOST": "0.0.0.0" if host == "0.0.0.0" else "127.0.0.1",
            "REDTRACE_DSH_WEB_PORT": str(port),
            "REDTRACE_DSH_RUNTIME_CONFIG": json.dumps(
                runtime_config, ensure_ascii=False, separators=(",", ":")
            ),
            "REDTRACE_DSH_PI_AI_CONFIG": json.dumps(
                {"providers": providers}, ensure_ascii=False, separators=(",", ":")
            ),
        }
    )
    return child_env


def _signal_process_tree(process: subprocess.Popen[bytes], *, force: bool) -> None:
    if process.poll() is not None:
        return
    if os.name == "nt":
        command = ["taskkill", "/PID", str(process.pid), "/T"]
        if force:
            command.append("/F")
        subprocess.run(
            command,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        return
    try:
        os.killpg(
            os.getpgid(process.pid),
            getattr(signal, "SIGKILL", signal.SIGTERM) if force else signal.SIGTERM,
        )
    except ProcessLookupError:
        pass


def _stop_process(process: subprocess.Popen[bytes] | None, timeout: int) -> None:
    if process is None or process.poll() is not None:
        return
    _signal_process_tree(process, force=False)
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        _signal_process_tree(process, force=True)
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()


def run(*, config: Path | None, host: str, port: int) -> int:
    if not 1 <= port <= 65535:
        raise StartupError("--port must be between 1 and 65535")

    root = Path(__file__).resolve().parents[3]
    dsh_root = Path(
        os.environ.get("REDTRACE_DSH_ROOT", os.environ.get("REDTRACE_DSH_RUNTIME_ROOT", root))
    ).expanduser().resolve()
    config_path = (config or root / "redtrace.yaml").expanduser().resolve()
    if not config_path.is_file():
        raise StartupError(f"dispatcher config not found: {config_path}")
    from redtrace.dispatcher.config import DispatchConfig

    dispatch_config = DispatchConfig.load(config_path)
    # The Worker type decides the runtime: provider Workers run on the
    # long-lived DSH Cordis runtime; mock Workers use the test engine.
    dsh_engine = any(
        worker.enabled and worker.provider != "mock"
        for worker in dispatch_config.workers
    )
    if dsh_engine:
        _ensure_dsh_ready(dsh_root)

    start_timeout = _positive_env("REDTRACE_START_TIMEOUT", 40)
    shutdown_timeout = _positive_env("REDTRACE_SHUTDOWN_TIMEOUT", 8)
    data = root / ".redtrace"
    temporary = data / "tmp"
    temporary.mkdir(parents=True, exist_ok=True)
    (root / "output" / "webshell").mkdir(parents=True, exist_ok=True)
    (root / "output" / "c2").mkdir(parents=True, exist_ok=True)
    # Detect the invoking shell so the DSH runtime can spawn child processes
    # with the same shell instead of hardcoding "bash". The launcher exports
    # REDTRACE_PARENT_SHELL because its own immediate parent is always Bash.
    detected = os.environ.get("REDTRACE_PARENT_SHELL") or _detect_parent_shell()
    if detected is not None:
        os.environ["REDTRACE_PARENT_SHELL"] = detected
        os.environ["DSH_SHELL"] = detected

    os.environ.update(
        {
            "REDTRACE_ROOT": str(root),
            "REDTRACE_DISPATCH_CONFIG": str(config_path),
            "TMPDIR": str(temporary),
            "TMP": str(temporary),
            "TEMP": str(temporary),
        }
    )

    python = sys.executable
    server: subprocess.Popen[bytes] | None = None
    dispatcher: subprocess.Popen[bytes] | None = None
    owns_server = False
    requested_exit = 0

    def request_stop(signum: int, _frame: object) -> None:
        nonlocal requested_exit
        requested_exit = 128 + signum

    previous_handlers: dict[int, object] = {}
    for signum in (signal.SIGINT, signal.SIGTERM, getattr(signal, "SIGHUP", None)):
        if signum is not None:
            previous_handlers[signum] = signal.signal(signum, request_stop)

    url = _probe_url(host, port)
    try:
        if dsh_engine and _server_is_ready(url):
            raise StartupError(f"DSH Web port is already in use: {url}")
        api_port = _free_loopback_port() if dsh_engine else port
        api_url = _probe_url("127.0.0.1" if dsh_engine else host, api_port)
        if not dsh_engine and _server_is_ready(url):
            print(f"RedTrace Server is already available at {url}; reusing it.", flush=True)
        else:
            print(f"Starting RedTrace Server at {api_url} ...", flush=True)
            server = _start_process(
                [
                    python,
                    "-m",
                    "redtrace",
                    "serve",
                    "--db-path",
                    str(data / "redtrace.db"),
                    "--host",
                    "127.0.0.1" if dsh_engine else host,
                    "--port",
                    str(api_port),
                ],
                root,
            )
            owns_server = True
            deadline = time.monotonic() + start_timeout
            while not _server_is_ready(api_url):
                if requested_exit:
                    return requested_exit
                status = server.poll()
                if status is not None:
                    raise StartupError(
                        f"Server exited before becoming ready (status {status})"
                    )
                if time.monotonic() >= deadline:
                    raise StartupError(
                        f"Server health check timed out after {start_timeout}s"
                    )
                time.sleep(0.1)

        if dsh_engine:
            assert dispatch_config is not None
            print(f"Starting RedTrace Cordis Runtime with {config_path} ...", flush=True)
            dispatcher = _start_process(
                ["node", str(dsh_root / "scripts" / "run-redtrace-dsh.mjs")],
                root,
                env=_dsh_environment(
                    dispatch_config,
                    dsh_root,
                    f"http://127.0.0.1:{api_port}",
                    host,
                    port,
                ),
            )
            deadline = time.monotonic() + start_timeout
            while not _server_is_ready(url):
                if requested_exit:
                    return requested_exit
                status = dispatcher.poll()
                if status is not None:
                    raise StartupError(
                        f"Cordis Runtime exited before becoming ready (status {status})"
                    )
                if time.monotonic() >= deadline:
                    raise StartupError(
                        f"Cordis Runtime health check timed out after {start_timeout}s"
                    )
                time.sleep(0.1)
        else:
            print(f"Starting RedTrace Dispatcher with {config_path} ...", flush=True)
            dispatcher = _start_process(
                [python, "-m", "redtrace", "dispatch", "--config", str(config_path)],
                root,
            )
        print("RedTrace is running. Press Ctrl+C to stop.", flush=True)
        while not requested_exit:
            dispatcher_status = dispatcher.poll()
            if dispatcher_status is not None:
                print(
                    f"{'Cordis Runtime' if dsh_engine else 'Dispatcher'} exited (status {dispatcher_status}).",
                    file=sys.stderr,
                    flush=True,
                )
                return dispatcher_status
            if owns_server and server is not None:
                server_status = server.poll()
                if server_status is not None:
                    print(
                        f"Server exited (status {server_status}).",
                        file=sys.stderr,
                        flush=True,
                    )
                    return server_status
            time.sleep(0.5)
        return requested_exit
    finally:
        if dispatcher is not None:
            print(f"Stopping {'Cordis Runtime' if dsh_engine else 'Dispatcher'}...", flush=True)
            _stop_process(dispatcher, shutdown_timeout)
        if owns_server:
            print("Stopping Server...", flush=True)
            _stop_process(server, shutdown_timeout)
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)
