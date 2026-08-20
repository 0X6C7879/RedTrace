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
from redtrace.dispatcher.config import ContextHarnessConfig, LocalConfig
from redtrace.dispatcher.runtime.backend import (
    is_agent_runtime_state,
    session_file_checkpoint,
)
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
        _ensure_directory(marker.parent)
        marker.touch(exist_ok=True)
        if self._capability_store is not None:
            self._ensure_native_skill_links(project_dir)
        pi_mcp = self._runtime_bin.parent / "mcp" / "pi.json"
        if pi_mcp.is_file():
            target = project_dir / ".pi" / "mcp.json"
            _ensure_directory(target.parent)
            if target.is_symlink() and target.resolve(strict=False) != pi_mcp.resolve():
                with contextlib.suppress(FileNotFoundError):
                    # WSL drvfs ghost entries report is_symlink() but unlink()
                    # fails with ENOENT; nothing can be removed in-process.
                    target.unlink()
            elif target.exists() and not target.is_symlink():
                with contextlib.suppress(FileNotFoundError):
                    target.unlink()
            _ensure_link(target, pi_mcp)
        LOG.debug(
            "local project workdir ready project=%s dir=%s", project_id, project_dir
        )
        return str(project_dir)

    def _ensure_native_skill_links(self, project_dir: Path) -> None:
        assert self._capability_store is not None
        roots = (
            project_dir / ".agents" / "skills",
            project_dir / ".claude" / "skills",
        )
        for root in roots:
            _ensure_directory(root)
        for skill in self._capability_store.list_skills():
            if not skill.enabled:
                continue
            source = self._capability_store.skills_dir / skill.name
            for root in roots:
                _ensure_link(root / skill.name, source)

    def conversation_environment(
        self, project_id: str, worker_type: str, worker_name: str = "default"
    ) -> dict[str, str]:
        state = contained_path(
            self._session_root,
            safe_project_key(project_id),
            worker_type,
            safe_project_key(worker_name),
        )
        _ensure_directory(state)
        if worker_type == "pi":
            return {"PI_CODING_AGENT_SESSION_DIR": str(state)}
        homes = {
            "claudecode": ("CLAUDE_CONFIG_DIR", Path.home() / ".claude"),
            "codex": ("CODEX_HOME", Path.home() / ".codex"),
        }
        if worker_type not in homes:
            return {}
        variable, user_home = homes[worker_type]
        if user_home.is_dir():
            for source in user_home.iterdir():
                if (
                    is_agent_runtime_state(worker_type, source.name)
                    or not source.is_file()
                ):
                    continue
                _copy_config(source, state / source.name)
            # Always refresh settings.json from the home config so that
            # native_cli_config changes (e.g. removing ANTHROPIC_BASE_URL
            # in direct endpoint mode) propagate to the session directory.
            # _copy_config skips existing files, so we force-overwrite here.
            settings_file = "settings.json"
            source = user_home / settings_file
            if source.is_file():
                shutil.copy2(source, state / settings_file)
        if worker_type == "claudecode":
            # Scrub provider routing keys from the session settings.json so
            # they can never override the per-process env vars set by
            # build_exec_process (relay URL, auth token, model, etc.).
            _scrub_claude_provider_env(state / "settings.json")
            _ensure_claude_workspace_trust(state)
        return {variable: str(state)}

    def ensure_worker_running(
        self, project_id: str, worker_name: str, worker_type: str
    ) -> str:
        return self.ensure_running(project_id, worker_name, worker_type)

    def worker_conversation_environment(
        self, project_id: str, worker_type: str, worker_name: str
    ) -> dict[str, str]:
        return self.conversation_environment(project_id, worker_type, worker_name)

    def session_checkpoint(
        self, project_id: str, worker_type: str, worker_name: str, session_id: str
    ) -> dict[str, object]:
        root = contained_path(
            self._session_root,
            safe_project_key(project_id),
            worker_type,
            safe_project_key(worker_name),
        )
        return session_file_checkpoint(root, session_id)

    def build_exec_process(
        self,
        container_name: str,
        env: dict[str, str],
        command: list[str],
        stdin_text: str | None = None,
        keep_stdin_open: bool = False,
        timeout_seconds: int | None = None,
        kill_after_seconds: int = 5,
    ) -> LocalProcess:
        merged_env = {
            **os.environ,
            **(env or {}),
            **self._context_harness.environment(),
        }
        workspace = str(Path(container_name).resolve())
        merged_env.update(
            {
                "PWD": workspace,
                "REDTRACE_WORKSPACE": workspace,
                "TMPDIR": workspace,
                "TMP": workspace,
                "TEMP": workspace,
            }
        )
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
            max_output_chars=self._context_harness.worker_output_chars,
        )

    def write_text_file(self, container_name: str, path: str, content: str) -> str:
        workspace = Path(container_name).resolve()
        project_id = safe_project_key(workspace.name)
        if workspace != self._project_dir(project_id):
            raise ValueError(
                f"local workspace is outside managed root: {container_name}"
            )
        virtual_root = "/home/kali/workspace/"
        if path.startswith(virtual_root):
            target = contained_path(
                workspace, *Path(path.removeprefix(virtual_root)).parts
            )
        else:
            target = Path(path).resolve()
            try:
                target.relative_to(workspace)
            except ValueError as exc:
                raise ValueError(f"local file path is outside workspace: {path}") from exc
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
        project_dir = self._project_dir(project_id)
        if project_dir.exists():
            LOG.info(
                "removing deleted project workdir project=%s dir=%s",
                project_id,
                project_dir,
            )
            shutil.rmtree(project_dir)
        marker = contained_path(
            self._project_state_root, safe_project_key(project_id), "workspace.created"
        )
        with contextlib.suppress(FileNotFoundError):
            marker.unlink()
        return not project_dir.exists()

    def managed_container_names(self) -> list[str]:
        return []

    def _project_dir(self, project_id: str) -> Path:
        return contained_path(self._root, safe_project_key(project_id))


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
        raise RuntimeError(f"cannot create Agent runtime link: {target}")


def _copy_config(source: Path, target: Path) -> None:
    if target.exists() or target.is_symlink():
        return
    _ensure_directory(target.parent)
    shutil.copy2(source, target)


# Provider routing keys that must be controlled exclusively by per-process
# env vars (from WorkerConfig + EndpointRelay).  If these appear in the
# session settings.json, the Claude CLI treats them as higher-priority than
# the process environment and breaks direct-mode relay routing.
_CLAUDE_PROVIDER_ENV_KEYS = frozenset({
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_OAUTH_TOKEN",
    "ANTHROPIC_MODEL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
})


def _scrub_claude_provider_env(settings_path: Path) -> None:
    """Remove provider routing keys from a Claude settings.json.

    The Claude CLI treats ``settings.json`` ``env`` entries as higher
    priority than the process environment.  RedTrace sets these values
    via per-process env vars (including the relay URL for direct mode),
    so stale values in settings.json must be removed.
    """
    if not settings_path.is_file():
        return
    try:
        data = json.loads(settings_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return
    env = data.get("env")
    if not isinstance(env, dict):
        return
    changed = False
    for key in _CLAUDE_PROVIDER_ENV_KEYS:
        if key in env:
            del env[key]
            changed = True
    if changed:
        settings_path.write_text(
            json.dumps(data, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )


def _ensure_claude_workspace_trust(state: Path) -> None:
    """Ensure ``.claude.json`` in the session directory has
    ``hasTrustDialogAccepted: true``.

    Claude Code refuses to honour ``permissions.allow`` entries from
    ``settings.local.json`` when the workspace trust flag is missing.
    RedTrace workers run non-interactively, so the trust dialog can
    never be accepted interactively — we patch it here instead.
    """
    config_file = state / ".claude.json"
    data: dict[str, object] = {}
    if config_file.exists():
        try:
            data = json.loads(config_file.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            data = {}
    if data.get("hasTrustDialogAccepted") is True:
        return
    data["hasTrustDialogAccepted"] = True
    _ensure_directory(state)
    config_file.write_text(
        json.dumps(data, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
