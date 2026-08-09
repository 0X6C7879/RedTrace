from __future__ import annotations

import logging
import os
import shutil
import subprocess
from pathlib import Path
from urllib.parse import quote

from redtrace.dispatcher.config import ContextHarnessConfig, LocalConfig
from redtrace.dispatcher.runtime.backend import is_agent_runtime_state
from redtrace.dispatcher.runtime.local_process import LocalProcess
from redtrace.paths import RedTracePaths, contained_path, safe_project_key

LOG = logging.getLogger(__name__)


class LocalBackend:
    """Runs workers directly on the dispatcher host instead of in per-project containers.

    Each project gets an isolated working directory under the configured
    ``workspace_root``. Workers read the host user's Agent configuration, keep
    conversations in project state, and use the root project's shared Skills.
    There are no containers to build or tear down.
    """

    def __init__(
        self,
        config: LocalConfig,
        context_harness: ContextHarnessConfig | None = None,
        paths: RedTracePaths | None = None,
    ):
        self._config = config
        self._context_harness = context_harness or ContextHarnessConfig()
        root = config.workspace_root
        default_root = (
            paths.workspaces
            if paths is not None
            else Path(__file__).resolve().parents[5] / "workspaces"
        )
        self._root = (Path(root).expanduser() if root else default_root).resolve()
        self._runtime_bin = (
            paths.runtime / "bin"
            if paths is not None
            else Path(__file__).resolve().parents[5] / ".redtrace" / "runtime" / "bin"
        )
        self._project_state_root = (
            paths.projects
            if paths is not None
            else Path(__file__).resolve().parents[5] / ".redtrace" / "projects"
        )
        self._path_prepend = tuple(
            part
            for part in os.environ.get("REDTRACE_LOCAL_PATH_PREPEND", "").split(
                os.pathsep
            )
            if part
        )

    def close(self) -> None:
        return None

    def container_name(self, project_id: str) -> str:
        return str(self._project_dir(project_id))

    def ensure_running(self, project_id: str) -> str:
        project_dir = self._project_dir(project_id)
        project_dir.mkdir(parents=True, exist_ok=True)
        pi_mcp = self._runtime_bin.parent / "mcp" / "pi.json"
        if pi_mcp.is_file():
            target = project_dir / ".pi" / "mcp.json"
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.is_symlink() and target.resolve(strict=False) != pi_mcp.resolve():
                target.unlink()
            elif target.exists() and not target.is_symlink():
                target.unlink()
            _ensure_link(target, pi_mcp)
        LOG.debug(
            "local project workdir ready project=%s dir=%s", project_id, project_dir
        )
        return str(project_dir)

    def conversation_environment(
        self, project_id: str, worker_type: str, worker_name: str = ""
    ) -> dict[str, str]:
        worker_key = "worker-" + quote(worker_name or worker_type, safe="")
        state = contained_path(
            self._project_state_root,
            safe_project_key(project_id),
            "conversations",
            worker_type,
            worker_key,
        )
        state.mkdir(parents=True, exist_ok=True)
        if worker_type == "pi":
            return {"PI_CODING_AGENT_SESSION_DIR": str(state)}
        homes = {
            "claudecode": ("CLAUDE_CONFIG_DIR", Path.home() / ".claude"),
            "codex": ("CODEX_HOME", Path.home() / ".codex"),
        }
        if worker_type not in homes:
            return {}
        variable, user_home = homes[worker_type]
        user_home.mkdir(parents=True, exist_ok=True)
        for source in user_home.iterdir():
            if is_agent_runtime_state(worker_type, source.name):
                continue
            _ensure_link(state / source.name, source)
        environment = {variable: str(state)}
        # Claude Code delegates Bash tool calls to $SHELL.  In zsh, `path` is a
        # special array tied to PATH, so ordinary loops such as `for path in ...`
        # silently destroy command lookup.  Use the shell the tool contract names.
        if worker_type == "claudecode" and Path("/bin/bash").is_file():
            environment["SHELL"] = "/bin/bash"
        return environment

    def build_exec_process(
        self,
        container_name: str,
        env: dict[str, str],
        command: list[str],
        stdin_text: str | None = None,
        timeout_seconds: int | None = None,
        kill_after_seconds: int = 5,
    ) -> LocalProcess:
        merged_env = {
            **os.environ,
            **(env or {}),
            **self._context_harness.environment(),
        }
        if all(
            (env or {}).get(key)
            for key in (
                "ANTHROPIC_BASE_URL",
                "ANTHROPIC_AUTH_TOKEN",
                "ANTHROPIC_MODEL",
            )
        ):
            # Claude's alternate host-level provider selectors must not outrank an
            # explicit Worker override. HOME and ~/.claude remain untouched.
            for key in (
                "ANTHROPIC_API_KEY",
                "ANTHROPIC_OAUTH_TOKEN",
                "CLAUDE_CODE_USE_BEDROCK",
                "CLAUDE_CODE_USE_VERTEX",
                "CLAUDE_CODE_USE_FOUNDRY",
            ):
                if key not in (env or {}):
                    merged_env.pop(key, None)
        cli_dir = str(self._runtime_bin)
        merged_env["PATH"] = os.pathsep.join(
            (cli_dir, *self._path_prepend, merged_env.get("PATH", ""))
        )
        return LocalProcess(
            command,
            cwd=container_name,
            env=merged_env,
            stdin_text=stdin_text,
            timeout_seconds=timeout_seconds,
            term_grace_seconds=kill_after_seconds,
            max_output_chars=self._context_harness.worker_output_chars,
        )

    def write_text_file(self, container_name: str, path: str, content: str) -> str:
        if path.startswith("/tmp/redtrace-prompts/"):
            relative = path.removeprefix("/tmp/redtrace-prompts/")
            parts = Path(relative).parts
            if not parts or any(part in ("", ".", "..") for part in parts):
                raise ValueError(f"invalid local prompt path: {path}")
            workspace = Path(container_name).resolve()
            project_id = safe_project_key(workspace.name)
            if workspace != self._project_dir(project_id):
                raise ValueError(
                    f"local workspace is outside managed root: {container_name}"
                )
            target = (
                contained_path(self._project_state_root, project_id)
                / "prompts"
                / Path(*parts)
            )
        else:
            target = Path(path)
            if not target.is_absolute():
                raise ValueError(f"local file path must be absolute: {path}")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        return str(target)

    def needs_completed_cleanup(self, project_id: str) -> bool:
        return False

    def needs_stopped_cleanup(self, project_id: str) -> bool:
        return False

    def cleanup_completed(self, project_id: str) -> bool:
        # Completion preserves project evidence and Workspace. Only the explicit
        # Web/API deletion lifecycle is allowed to release project resources.
        return True

    def cleanup_stopped(self, project_id: str) -> bool:
        return True

    def cleanup_deleted(self, project_id: str) -> bool:
        project_dir = self._project_dir(project_id)
        if not project_dir.exists():
            return True
        LOG.info(
            "removing deleted project workdir project=%s dir=%s",
            project_id,
            project_dir,
        )
        shutil.rmtree(project_dir)
        return not project_dir.exists()

    def managed_container_names(self) -> list[str]:
        return []

    def _project_dir(self, project_id: str) -> Path:
        return contained_path(self._root, safe_project_key(project_id))
def _ensure_link(link: Path, target: Path) -> None:
    if link.exists() or link.is_symlink():
        return
    try:
        link.symlink_to(target, target_is_directory=target.is_dir())
        return
    except OSError:
        if os.name != "nt" or not target.is_dir():
            raise
    completed = subprocess.run(
        ["cmd.exe", "/d", "/c", "mklink", "/J", str(link), str(target)],
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(f"cannot link Agent user configuration: {target}")
