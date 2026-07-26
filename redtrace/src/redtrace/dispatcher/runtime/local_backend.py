from __future__ import annotations

import logging
import os
import shutil
from pathlib import Path

from redtrace.audit import archive_local_workspace
from redtrace.capabilities import CapabilityStore, materialize_local_workspace
from redtrace.dispatcher.config import ContextHarnessConfig, LocalConfig
from redtrace.dispatcher.runtime.local_process import LocalProcess

LOG = logging.getLogger(__name__)


class LocalBackend:
    """Runs workers directly on the dispatcher host instead of in per-project containers.

    Each project gets an isolated working directory under ``workspace_root`` (defaulting
    to the directory the dispatcher was started in). Worker processes inherit the host
    environment so ``claude`` / ``codex`` / ``pi`` keep using the user's global login,
    settings, Skills and extensions. A Worker's configured API values are merged over
    that environment for only that process. There are no containers to build or tear
    down, so the container-lifecycle methods are inert.
    """

    def __init__(
        self,
        config: LocalConfig,
        context_harness: ContextHarnessConfig | None = None,
    ):
        self._config = config
        self._context_harness = context_harness or ContextHarnessConfig()
        root = config.workspace_root
        self._root = Path(root).expanduser() if root else Path.cwd()
        self._capabilities = CapabilityStore()
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
        materialize_local_workspace(self._capabilities, project_dir)
        LOG.debug("local project workdir ready project=%s dir=%s", project_id, project_dir)
        return str(project_dir)

    def build_exec_process(
        self,
        container_name: str,
        env: dict[str, str],
        command: list[str],
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
        if all(
            (env or {}).get(key)
            for key in (
                "CODEX_BASE_URL",
                "OPENAI_API_KEY",
                "CODEX_MODEL",
            )
        ):
            codex_home = Path(container_name) / ".redtrace" / "codex-home"
            codex_home.mkdir(parents=True, exist_ok=True)
            merged_env["CODEX_HOME"] = str(codex_home)
        cli_dir = str(Path(container_name) / ".redtrace" / "bin")
        merged_env["PATH"] = os.pathsep.join(
            (cli_dir, *self._path_prepend, merged_env.get("PATH", ""))
        )
        return LocalProcess(
            command,
            cwd=container_name,
            env=merged_env,
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
            target = Path(container_name) / ".redtrace" / "prompts" / Path(*parts)
        else:
            target = Path(path)
            if not target.is_absolute():
                raise ValueError(f"local file path must be absolute: {path}")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        return str(target)

    def needs_completed_cleanup(self, project_id: str) -> bool:
        return self._config.completed_action == "remove" and self._project_dir(project_id).exists()

    def needs_stopped_cleanup(self, project_id: str) -> bool:
        return False

    def cleanup_completed(self, project_id: str) -> bool:
        if self._config.completed_action == "remove":
            project_dir = self._project_dir(project_id)
            try:
                archive_local_workspace(project_id, project_dir)
            except Exception:
                LOG.warning("failed to archive completed project workdir project=%s", project_id, exc_info=True)
            LOG.info("removing completed project workdir project=%s dir=%s", project_id, project_dir)
            shutil.rmtree(project_dir, ignore_errors=True)
        return True

    def cleanup_stopped(self, project_id: str) -> bool:
        return True

    def managed_container_names(self) -> list[str]:
        return []

    def _project_dir(self, project_id: str) -> Path:
        return self._root / project_id.replace("/", "-")
