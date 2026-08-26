from __future__ import annotations

import contextlib
import errno
import json
import logging
import os
import shutil
import subprocess
import time
from pathlib import Path

from redtrace.capabilities import CapabilityStore
from redtrace.dispatcher.config import LocalConfig
from redtrace.dispatcher.runtime.local_process import LocalProcess
from redtrace.paths import RedTracePaths, contained_path, safe_project_key

LOG = logging.getLogger(__name__)

# Output safety cap for mock-engine process streams (bytes expressed in chars).
WORKER_OUTPUT_CHAR_LIMIT = 8 * 1024 * 1024


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
        paths: RedTracePaths | None = None,
    ):
        self._config = config
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
        self._tools_dir = self._runtime_bin.parent / "tools"
        self._capability_store = (
            CapabilityStore(
                paths.root,
                skills_dir=paths.skills,
                mcp_dir=paths.mcp,
            )
            if paths is not None
            else None
        )
        self._project_state_root = (
            paths.projects
            if paths is not None
            else self._root / ".redtrace-state" / "projects"
        )
        self._session_root = self._project_state_root.parent / "sessions"
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

    def ensure_running(
        self,
        project_id: str,
        worker_name: str | None = None,
        worker_type: str | None = None,
    ) -> str:
        project_dir = self._project_dir(project_id)
        marker = contained_path(
            self._project_state_root, safe_project_key(project_id), "workspace.created"
        )
        if not project_dir.exists() and marker.exists():
            raise RuntimeError(
                f"active project workspace integrity failure: {project_dir} disappeared"
            )
        _ensure_directory(project_dir)
        cache_dir = self._cache_dir(project_id)
        runtime_dir = self.runtime_dir(project_id)
        _ensure_directory(cache_dir)
        _ensure_directory(runtime_dir)
        _ensure_directory(marker.parent)
        marker.touch(exist_ok=True)
        LOG.debug(
            "local project workdir ready project=%s dir=%s", project_id, project_dir
        )
        return str(project_dir)

    def conversation_environment(
        self, project_id: str, worker_type: str, worker_name: str = "default"
    ) -> dict[str, str]:
        # Only the mock test engine runs locally; it keeps no CLI session
        # state and no agent homes are touched.
        return {}

    def ensure_worker_running(
        self, project_id: str, worker_name: str, worker_type: str
    ) -> str:
        return self.ensure_running(project_id, worker_name, worker_type)

    def worker_conversation_environment(
        self, project_id: str, worker_type: str, worker_name: str
    ) -> dict[str, str]:
        return self.conversation_environment(project_id, worker_type, worker_name)

    def build_exec_process(
        self,
        container_name: str,
        env: dict[str, str],
        command: list[str],
        stdin_text: str | None = None,
        keep_stdin_open: bool = False,
        timeout_seconds: int | None = None,
        kill_after_seconds: int = 5,
        project_id: str | None = None,
    ) -> LocalProcess:
        merged_env = {
            **os.environ,
            **(env or {}),
        }
        workspace = str(Path(container_name).resolve())
        merged_env.update(
            {
                "PWD": workspace,
                "REDTRACE_WORKSPACE": workspace,
            }
        )
        if project_id is not None:
            cache_dir = str(self._cache_dir(project_id))
            runtime_dir = str(self.runtime_dir(project_id))
            merged_env.update(
                {
                    "XDG_CACHE_HOME": cache_dir,
                    "TMPDIR": runtime_dir,
                    "TMP": runtime_dir,
                    "TEMP": runtime_dir,
                }
            )
        else:
            merged_env.update(
                {
                    "TMPDIR": workspace,
                    "TMP": workspace,
                    "TEMP": workspace,
                }
            )
        cli_dir = str(self._runtime_bin)
        tools_bin = str(self._tools_dir / "bin")
        merged_env["PATH"] = os.pathsep.join(
            (cli_dir, tools_bin, *self._path_prepend, merged_env.get("PATH", ""))
        )
        merged_env["REDTRACE_TOOLS_DIR"] = str(self._tools_dir)
        merged_env["REDTRACE_TOOLS_BIN"] = tools_bin
        return LocalProcess(
            command,
            cwd=workspace,
            env=merged_env,
            stdin_text=stdin_text,
            keep_stdin_open=keep_stdin_open,
            timeout_seconds=timeout_seconds,
            term_grace_seconds=kill_after_seconds,
            max_output_chars=WORKER_OUTPUT_CHAR_LIMIT,
        )

    def write_text_file(
        self,
        container_name: str,
        path: str,
        content: str,
        *,
        runtime_dir: str | None = None,
    ) -> str:
        workspace = Path(container_name).resolve()
        project_id = safe_project_key(workspace.parent.name)
        if workspace != self._project_dir(project_id):
            raise ValueError(
                f"local workspace is outside managed root: {container_name}"
            )
        virtual_root = "/home/kali/workspace/"
        if path.startswith(virtual_root):
            relative = Path(path.removeprefix(virtual_root)).parts
            if runtime_dir is not None:
                target = contained_path(
                    Path(runtime_dir), *relative
                )
            else:
                target = contained_path(workspace, *relative)
        else:
            target = Path(path).resolve()
            allowed = [workspace]
            if runtime_dir is not None:
                allowed.append(Path(runtime_dir).resolve())
            if not any(
                target.is_relative_to(root) for root in allowed
            ):
                raise ValueError(f"local file path is outside workspace: {path}")
        _ensure_directory(target.parent)
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
        project_root = self._project_root_dir(project_id)
        if project_root.exists():
            LOG.info(
                "removing deleted project root project=%s dir=%s",
                project_id,
                project_root,
            )
            shutil.rmtree(project_root)
        marker = contained_path(
            self._project_state_root, safe_project_key(project_id), "workspace.created"
        )
        with contextlib.suppress(FileNotFoundError):
            marker.unlink()
        return not project_root.exists()

    def managed_container_names(self) -> list[str]:
        return []

    def _project_root_dir(self, project_id: str) -> Path:
        """Return the top-level directory for a project (contains workspace/cache/runtime)."""
        return contained_path(self._root, safe_project_key(project_id))

    def _project_dir(self, project_id: str) -> Path:
        return self._project_root_dir(project_id) / "workspace"

    def _cache_dir(self, project_id: str) -> Path:
        return self._project_root_dir(project_id) / "cache"

    def runtime_dir(self, project_id: str) -> Path:
        """Return the runtime directory for a project (temp files, session state)."""
        return self._project_root_dir(project_id) / "runtime"


def _ensure_directory(path: Path) -> None:
    """Ensure ``path`` is a usable directory; truth is ``path.is_dir()``.

    On WSL drvfs (/mnt/<drive>) a directory deleted from the Windows side
    while a WSL process pins it (cwd or open handle) leaves a ghost dentry:
    ``mkdir`` reports EEXIST while ``stat`` reports ENOENT, and neither
    unlink nor rename can touch it. The ghost lives in the WSL 9P client
    cache and persists until ``wsl --shutdown``; retrying in-process can
    never heal it, so it is surfaced with actionable guidance instead of a
    misleading ``FileExistsError``.
    """
    if path.is_dir():
        return
    last_error: OSError | None = None
    for delay in (0.0, 0.05):
        if delay:
            time.sleep(delay)
        try:
            path.mkdir(parents=True, exist_ok=True)
        except FileExistsError as exc:
            last_error = exc
        if path.is_dir():
            # Covers both a plain create and an EEXIST raced/ghost retry
            # that resolved into a real directory.
            return
    if path.exists() or path.is_symlink():
        raise NotADirectoryError(f"managed directory path is not a directory: {path}")
    if isinstance(last_error, FileExistsError):
        raise RuntimeError(
            f"workspace directory {path} is stuck in an inconsistent WSL "
            "drvfs state (mkdir reports EEXIST while stat reports ENOENT). "
            "This happens when the directory was deleted from the Windows "
            "side while a WSL process still pinned it. Run "
            "'wsl.exe --shutdown' from PowerShell, then restart the "
            "dispatcher."
        ) from last_error
    if last_error is not None:
        raise last_error
    raise FileNotFoundError(errno.ENOENT, "managed directory missing", str(path))


