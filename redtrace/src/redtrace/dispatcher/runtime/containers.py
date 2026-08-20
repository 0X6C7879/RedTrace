from __future__ import annotations

import io
import logging
import os
import tarfile
import threading
from pathlib import Path, PurePosixPath

import docker
from docker.errors import APIError, DockerException, NotFound
from docker.models.containers import Container
from redtrace.dispatcher.config import ContainerConfig, ContextHarnessConfig
from redtrace.dispatcher.runtime.backend import (
    is_agent_runtime_state,
    session_file_checkpoint,
)
from redtrace.dispatcher.runtime.process import ManagedProcess
from redtrace.paths import RedTracePaths, contained_path, safe_project_key

LOG = logging.getLogger(__name__)


class ContainerManager:
    _PREFIX = "redtrace-dispatch-"
    _WORKSPACE = "/home/kali/workspace"

    def __init__(
        self,
        config: ContainerConfig,
        context_harness: ContextHarnessConfig | None = None,
        paths: RedTracePaths | None = None,
    ):
        self._config = config
        self._context_harness = context_harness or ContextHarnessConfig()
        self._client = docker.from_env()
        self._ensure_running_locks: dict[str, threading.Lock] = {}
        self._ensure_running_locks_guard = threading.Lock()
        self._paths = paths
        self._host_mounts: list[tuple[Path, Path]] | None = None

    def close(self) -> None:
        self._client.close()

    def container_name(self, project_id: str, worker_name: str | None = None) -> str:
        sanitized = safe_project_key(project_id)
        base = f"{self._PREFIX}{sanitized}"
        return f"{base}--{safe_project_key(worker_name)}" if worker_name else base

    def ensure_running(
        self,
        project_id: str,
        worker_name: str | None = None,
        worker_type: str | None = None,
    ) -> str:
        if worker_name is None or worker_type is None:
            raise ValueError("container execution requires worker identity")
        self._ensure_workspace(project_id)
        name = self.container_name(project_id, worker_name)
        with self._ensure_running_lock(name):
            return self._ensure_running_locked(
                project_id, name, worker_name, worker_type
            )

    def ensure_worker_running(
        self, project_id: str, worker_name: str, worker_type: str
    ) -> str:
        return self.ensure_running(project_id, worker_name, worker_type)

    def _ensure_running_locked(
        self, project_id: str, name: str, worker_name: str, worker_type: str
    ) -> str:
        state = self.inspect_state(name)
        if state == "running":
            LOG.debug(
                "container already running project=%s container=%s", project_id, name
            )
            return self._ready(name)
        if state is not None:
            LOG.info(
                "starting existing container project=%s container=%s state=%s",
                project_id,
                name,
                state,
            )
            self._start_existing(name)
            return self._ready(name)
        LOG.info(
            "creating container project=%s container=%s image=%s",
            project_id,
            name,
            self._config.image,
        )
        try:
            self._client.containers.run(
                self._config.image,
                ["sleep", "infinity"],
                detach=True,
                name=name,
                network_mode=self._config.network_mode,
                cap_add=self._config.cap_add or None,
                volumes=self._shared_volumes(project_id, worker_name, worker_type),
            )
            LOG.info("created container project=%s container=%s", project_id, name)
            return self._ready(name)
        except APIError as exc:
            if not self._is_name_conflict(exc):
                raise RuntimeError(f"failed to create container {name}: {exc}") from exc
        LOG.info(
            "container name conflict, reusing existing container project=%s container=%s",
            project_id,
            name,
        )
        state = self.inspect_state(name)
        if state == "running":
            return self._ready(name)
        if state is not None:
            LOG.info(
                "starting conflicted existing container project=%s container=%s state=%s",
                project_id,
                name,
                state,
            )
            self._start_existing(name)
            return self._ready(name)
        raise RuntimeError(f"failed to create container {name}")

    def _ready(self, name: str) -> str:
        return name

    def _ensure_running_lock(self, name: str) -> threading.Lock:
        with self._ensure_running_locks_guard:
            lock = self._ensure_running_locks.get(name)
            if lock is None:
                lock = threading.Lock()
                self._ensure_running_locks[name] = lock
            return lock

    def inspect_state(self, name: str) -> str | None:
        container = self._get_container(name)
        if container is None:
            return None
        try:
            container.reload()
        except DockerException as exc:
            raise RuntimeError(f"failed to inspect container {name}: {exc}") from exc
        state = container.attrs.get("State", {}).get("Status")
        return str(state) if state else None

    def cleanup_completed(self, project_id: str) -> bool:
        return all([self._stop_container(name) for name in self._project_containers(project_id)])

    def cleanup_stopped(self, project_id: str) -> bool:
        return all([self._stop_container(name) for name in self._project_containers(project_id)])

    def cleanup_deleted(self, project_id: str) -> bool:
        return all([self.cleanup_orphan(name) for name in self._project_containers(project_id)])

    def _stop_container(self, name: str) -> bool:
        if self.inspect_state(name) != "running":
            return True
        try:
            self._require_container(name).stop(timeout=1)
        except NotFound:
            return True
        except DockerException as exc:
            LOG.warning("failed to stop container=%s error=%s", name, exc)
            return False
        return self.inspect_state(name) != "running"

    def _project_containers(self, project_id: str) -> list[str]:
        base = self.container_name(project_id)
        names = {base}
        if hasattr(self, "_client"):
            names.update(
                name
                for name in self.managed_container_names()
                if name.startswith(f"{base}--")
            )
        return sorted(names)

    def cleanup_orphan(self, name: str) -> bool:
        state = self.inspect_state(name)
        if state is None:
            return True
        LOG.info("removing orphan project container container=%s state=%s", name, state)
        container = self._require_container(name)
        try:
            container.remove(force=True)
        except NotFound:
            return True
        except DockerException as exc:
            LOG.warning("failed to remove orphan container=%s error=%s", name, exc)
            return False
        return self.inspect_state(name) is None

    def managed_container_names(self) -> list[str]:
        try:
            containers = self._client.containers.list(all=True)
        except DockerException as exc:
            LOG.warning("failed to list managed containers error=%s", exc)
            return []
        return sorted(
            container.name
            for container in containers
            if container.name.startswith(self._PREFIX)
        )

    def needs_completed_cleanup(self, project_id: str) -> bool:
        return any(
            self.inspect_state(name) == "running"
            for name in self._project_containers(project_id)
        )

    def needs_orphan_cleanup(self, name: str) -> bool:
        return self.inspect_state(name) is not None

    def needs_stopped_cleanup(self, project_id: str) -> bool:
        return self.needs_completed_cleanup(project_id)

    def build_exec_process(
        self,
        container_name: str,
        env: dict[str, str],
        command: list[str],
        stdin_text: str | None = None,
        keep_stdin_open: bool = False,
        timeout_seconds: int | None = None,
        kill_after_seconds: int = 5,
    ) -> ManagedProcess:
        container = self._require_container(container_name)
        context_harness = getattr(self, "_context_harness", None)
        if context_harness is None:
            context_harness = ContextHarnessConfig()
        env = {
            **env,
            **context_harness.environment(),
            "PWD": self._WORKSPACE,
            "REDTRACE_WORKSPACE": self._WORKSPACE,
            "TMPDIR": self._WORKSPACE,
            "TMP": self._WORKSPACE,
            "TEMP": self._WORKSPACE,
            "REDTRACE_TOOLS_DIR": "/opt/redtrace/tools",
            "REDTRACE_TOOLS_BIN": "/opt/redtrace/tools/bin",
            "PATH": (
                "/opt/redtrace/runtime/bin:/opt/redtrace/tools/bin:"
                "/home/kali/.local/bin:/home/kali/go/bin:"
                "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
            ),
        }
        argv: list[str] = []
        if timeout_seconds is not None:
            argv.extend(
                [
                    "timeout",
                    "-k",
                    f"{kill_after_seconds}s",
                    f"{timeout_seconds}s",
                ]
            )
        argv.extend(command)
        return ManagedProcess(
            container,
            argv,
            env,
            workdir=self._WORKSPACE,
            stdin_text=stdin_text,
            keep_stdin_open=keep_stdin_open,
            max_output_chars=context_harness.worker_output_chars,
        )

    def conversation_environment(
        self, project_id: str, worker_type: str, worker_name: str = "default"
    ) -> dict[str, str]:
        safe_project_key(project_id)
        if worker_type == "claudecode":
            return {"CLAUDE_CONFIG_DIR": "/home/kali/.claude"}
        if worker_type == "codex":
            return {"CODEX_HOME": "/home/kali/.codex"}
        if worker_type == "pi":
            return {"PI_CODING_AGENT_SESSION_DIR": "/home/kali/.pi/sessions"}
        return {}

    def worker_conversation_environment(
        self, project_id: str, worker_type: str, worker_name: str
    ) -> dict[str, str]:
        return self.conversation_environment(project_id, worker_type, worker_name)

    def session_checkpoint(
        self, project_id: str, worker_type: str, worker_name: str, session_id: str
    ) -> dict[str, object]:
        if self._paths is None:
            return {"path": "", "exists": False, "size_bytes": 0, "mtime_ns": 0}
        root = contained_path(
            self._paths.managed,
            "sessions",
            safe_project_key(project_id),
            worker_type,
            safe_project_key(worker_name),
        )
        return session_file_checkpoint(root, session_id)

    def _shared_volumes(
        self, project_id: str, worker_name: str, worker_type: str
    ) -> dict[str, dict[str, str]]:
        if self._paths is None:
            return {}
        workspace = contained_path(self._paths.workspaces, safe_project_key(project_id))
        session = contained_path(
            self._paths.managed,
            "sessions",
            safe_project_key(project_id),
            worker_type,
            safe_project_key(worker_name),
        )
        agent_homes = {
            "claudecode": (Path.home() / ".claude", "/home/kali/.claude"),
            "codex": (Path.home() / ".codex", "/home/kali/.codex"),
        }
        for directory, _ in agent_homes.values():
            directory.mkdir(parents=True, exist_ok=True)
        pi_home = Path.home() / ".pi"
        pi_home.mkdir(parents=True, exist_ok=True)
        session.mkdir(parents=True, exist_ok=True)
        bindings = {
            self._host_source(workspace): {
                "bind": self._WORKSPACE,
                "mode": "rw",
            },
            self._host_source(self._paths.skills): {
                "bind": "/opt/redtrace/claude-plugin/skills",
                "mode": "rw",
            },
            self._host_source(self._paths.mcp): {
                "bind": "/opt/redtrace/mcp",
                "mode": "ro",
            },
            self._host_source(self._paths.runtime): {
                "bind": "/opt/redtrace/runtime",
                "mode": "ro",
            },
            self._host_source(self._paths.runtime / "tools"): {
                "bind": "/opt/redtrace/tools",
                "mode": "rw",
            },
            self._host_source(self._paths.runtime / "claude-plugin"): {
                "bind": "/opt/redtrace/claude-plugin",
                "mode": "ro",
            },
            self._host_source(self._paths.runtime / "mcp" / "pi.json"): {
                "bind": "/home/kali/workspace/.pi/mcp.json",
                "mode": "ro",
            },
        }
        if worker_type in agent_homes:
            bindings[self._host_source(session)] = {
                "bind": agent_homes[worker_type][1],
                "mode": "rw",
            }
        elif worker_type == "pi":
            bindings[self._host_source(session)] = {
                "bind": "/home/kali/.pi/sessions",
                "mode": "rw",
            }
        selected_home = agent_homes.get(worker_type)
        for user_home, container_home in ((selected_home,) if selected_home else ()):
            for source in user_home.iterdir():
                if is_agent_runtime_state(worker_type, source.name):
                    continue
                bindings[self._host_source(source)] = {
                    "bind": f"{container_home}/{source.name}",
                    "mode": "ro",
                }
        if worker_type == "pi":
            for source in pi_home.iterdir():
                if is_agent_runtime_state("pi", source.name):
                    continue
                bindings[self._host_source(source)] = {
                    "bind": f"/home/kali/.pi/{source.name}",
                    "mode": "rw",
                }
        private_cases = os.environ.get("REDTRACE_CODE_AUDIT_PRIVATE_CASES_DIR")
        if private_cases and Path(private_cases).is_dir():
            bindings[self._host_source(Path(private_cases))] = {
                "bind": "/opt/redtrace/private-code-audit-cases",
                "mode": "ro",
            }
        return {str(source): spec for source, spec in bindings.items()}

    def _ensure_workspace(self, project_id: str) -> None:
        if self._paths is None:
            return
        project_id = safe_project_key(project_id)
        workspace = contained_path(self._paths.workspaces, project_id)
        marker = contained_path(self._paths.projects, project_id, "workspace.created")
        if not workspace.exists() and marker.exists():
            raise RuntimeError(
                f"active project workspace integrity failure: {workspace} disappeared"
            )
        workspace.mkdir(parents=True, exist_ok=True)
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.touch(exist_ok=True)

    def _host_source(self, path: Path) -> Path:
        """Translate a dispatcher-container path to the Docker host mount source."""
        if not os.environ.get("HOSTNAME"):
            return path.resolve()
        host_mounts = self._host_mounts
        if host_mounts is None:
            try:
                current = self._client.containers.get(os.environ["HOSTNAME"])
                mounts = current.attrs.get("Mounts", [])
            except DockerException:
                return path.resolve()
            host_mounts = [
                (Path(str(mount.get("Destination"))), Path(str(mount.get("Source"))))
                for mount in mounts
                if mount.get("Destination") and mount.get("Source")
            ]
            self._host_mounts = host_mounts
        resolved = path.resolve()
        matches: list[tuple[Path, Path]] = []
        for destination, source in host_mounts:
            try:
                relative = resolved.relative_to(destination)
            except (ValueError, OSError):
                continue
            matches.append((destination, source / relative))
        if not matches:
            return resolved
        return max(matches, key=lambda item: len(item[0].parts))[1]

    def write_text_file(self, container_name: str, path: str, content: str) -> str:
        archive_path, archive = self._text_file_archive(path, content)
        container = self._require_container(container_name)
        try:
            ok = container.put_archive(archive_path, archive)
        except DockerException as exc:
            raise RuntimeError(f"failed to write container file {path}: {exc}") from exc
        if not ok:
            raise RuntimeError(f"failed to write container file {path}")
        return path

    def _start_existing(self, name: str) -> None:
        LOG.debug("starting container=%s", name)
        container = self._require_container(name)
        try:
            container.start()
            return
        except DockerException as exc:
            if self.inspect_state(name) == "running":
                return
            raise RuntimeError(f"failed to start container {name}: {exc}") from exc

    def _get_container(self, name: str) -> Container | None:
        try:
            return self._client.containers.get(name)
        except NotFound:
            return None
        except DockerException as exc:
            raise RuntimeError(f"failed to get container {name}: {exc}") from exc

    def _require_container(self, name: str) -> Container:
        container = self._get_container(name)
        if container is None:
            raise RuntimeError(f"container not found: {name}")
        return container

    @staticmethod
    def _is_name_conflict(exc: APIError) -> bool:
        status_code = getattr(getattr(exc, "response", None), "status_code", None)
        explanation = str(getattr(exc, "explanation", "") or exc)
        return status_code == 409 or "is already in use" in explanation

    @staticmethod
    def _text_file_archive(path: str, content: str) -> tuple[str, bytes]:
        target = PurePosixPath(path)
        if not target.is_absolute() or target.name in ("", ".", ".."):
            raise ValueError(f"container file path must be absolute: {path}")
        parts = target.parts[1:]
        if not parts or any(part in ("", ".", "..") for part in parts):
            raise ValueError(f"invalid container file path: {path}")
        if len(parts) == 1:
            archive_path = "/"
            archive_parts = parts
        else:
            archive_path = f"/{parts[0]}"
            archive_parts = parts[1:]

        payload = content.encode("utf-8")
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode="w") as archive:
            parent = ""
            for part in archive_parts[:-1]:
                parent = f"{parent}/{part}" if parent else part
                info = tarfile.TarInfo(parent)
                info.type = tarfile.DIRTYPE
                info.mode = 0o755
                archive.addfile(info)

            file_name = "/".join(archive_parts)
            info = tarfile.TarInfo(file_name)
            info.size = len(payload)
            info.mode = 0o644
            archive.addfile(info, io.BytesIO(payload))
        return archive_path, stream.getvalue()
