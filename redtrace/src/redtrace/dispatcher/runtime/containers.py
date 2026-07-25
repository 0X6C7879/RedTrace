from __future__ import annotations

import io
import json
import logging
import tarfile
import threading
from pathlib import PurePosixPath

import docker
from docker.errors import APIError, DockerException, NotFound
from docker.models.containers import Container

from redtrace.audit import archive_container_workspace
from redtrace.capabilities import (
    MANIFEST_PATH,
    NAME_PATTERN,
    CapabilityStore,
    workspace_payload,
    workspace_tar,
)
from redtrace.dispatcher.config import ContainerConfig
from redtrace.dispatcher.runtime.process import ManagedProcess

LOG = logging.getLogger(__name__)


class ContainerManager:
    _PREFIX = "redtrace-dispatch-"
    _WORKSPACE = "/home/kali/workspace"

    def __init__(self, config: ContainerConfig):
        self._config = config
        self._client = docker.from_env()
        self._ensure_running_locks: dict[str, threading.Lock] = {}
        self._ensure_running_locks_guard = threading.Lock()
        self._capabilities = CapabilityStore()
        self._capability_digests: dict[str, str] = {}

    def close(self) -> None:
        self._client.close()

    def container_name(self, project_id: str) -> str:
        sanitized = project_id.replace("/", "-")
        return f"{self._PREFIX}{sanitized}"

    def ensure_running(self, project_id: str) -> str:
        name = self.container_name(project_id)
        with self._ensure_running_lock(name):
            return self._ensure_running_locked(project_id, name)

    def _ensure_running_locked(self, project_id: str, name: str) -> str:
        state = self.inspect_state(name)
        if state == "running":
            LOG.debug("container already running project=%s container=%s", project_id, name)
            return self._ready(name)
        if state is not None:
            LOG.info("starting existing container project=%s container=%s state=%s", project_id, name, state)
            self._start_existing(name)
            return self._ready(name)
        LOG.info("creating container project=%s container=%s image=%s", project_id, name, self._config.image)
        try:
            self._client.containers.run(
                self._config.image,
                ["sleep", "infinity"],
                detach=True,
                name=name,
                network_mode=self._config.network_mode,
                cap_add=self._config.cap_add or None,
            )
            LOG.info("created container project=%s container=%s", project_id, name)
            return self._ready(name)
        except APIError as exc:
            if not self._is_name_conflict(exc):
                raise RuntimeError(f"failed to create container {name}: {exc}") from exc
        LOG.info("container name conflict, reusing existing container project=%s container=%s", project_id, name)
        state = self.inspect_state(name)
        if state == "running":
            return self._ready(name)
        if state is not None:
            LOG.info("starting conflicted existing container project=%s container=%s state=%s", project_id, name, state)
            self._start_existing(name)
            return self._ready(name)
        raise RuntimeError(f"failed to create container {name}")

    def _ready(self, name: str) -> str:
        self._sync_capabilities(name)
        return name

    def _sync_capabilities(self, name: str) -> None:
        digest, files = workspace_payload(self._capabilities)
        if self._capability_digests.get(name) == digest:
            return

        container = self._require_container(name)
        previous: dict = {}
        try:
            result = container.exec_run(["cat", f"{self._WORKSPACE}/{MANIFEST_PATH}"])
            if result.exit_code == 0:
                previous = json.loads(result.output.decode("utf-8"))
        except (DockerException, UnicodeDecodeError, json.JSONDecodeError):
            previous = {}

        current_manifest = json.loads(files[MANIFEST_PATH].decode("utf-8"))
        managed_names = {
            skill
            for skill in [*previous.get("skills", []), *current_manifest.get("skills", [])]
            if isinstance(skill, str) and NAME_PATTERN.fullmatch(skill)
        }
        if managed_names:
            paths = [
                f"{self._WORKSPACE}/{prefix}/{skill}"
                for skill in sorted(managed_names)
                for prefix in (".agents/skills", ".claude/skills")
            ]
            try:
                container.exec_run(["rm", "-rf", "--", *paths])
            except DockerException as exc:
                raise RuntimeError(f"failed to refresh capabilities in {name}: {exc}") from exc

        try:
            ok = container.put_archive(self._WORKSPACE, workspace_tar(files))
        except DockerException as exc:
            raise RuntimeError(f"failed to sync capabilities into {name}: {exc}") from exc
        if not ok:
            raise RuntimeError(f"failed to sync capabilities into {name}")
        self._capability_digests[name] = digest

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
        name = self.container_name(project_id)
        state = self.inspect_state(name)
        if state is None:
            return True
        container = self._require_container(name)
        if self._config.completed_action == "remove":
            try:
                archive_container_workspace(project_id, container)
            except Exception:
                LOG.warning("failed to archive completed project workspace project=%s", project_id, exc_info=True)
            LOG.info("removing completed project container project=%s container=%s", project_id, name)
            try:
                container.remove(force=True)
            except NotFound:
                return True
            except DockerException as exc:
                LOG.warning("failed to remove container=%s error=%s", name, exc)
                return False
            return self.inspect_state(name) is None
        elif state == "running":
            LOG.info("stopping completed project container project=%s container=%s", project_id, name)
            try:
                container.stop(timeout=1)
            except NotFound:
                return True
            except DockerException as exc:
                LOG.warning("failed to stop container=%s error=%s", name, exc)
                return False
            return self.inspect_state(name) != "running"
        return True

    def cleanup_stopped(self, project_id: str) -> bool:
        name = self.container_name(project_id)
        state = self.inspect_state(name)
        if state != "running":
            return True
        LOG.info("stopping stopped project container project=%s container=%s", project_id, name)
        container = self._require_container(name)
        try:
            container.stop(timeout=1)
        except NotFound:
            return True
        except DockerException as exc:
            LOG.warning("failed to stop stopped project container=%s error=%s", name, exc)
            return False
        return self.inspect_state(name) != "running"

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
        return sorted(container.name for container in containers if container.name.startswith(self._PREFIX))

    def needs_completed_cleanup(self, project_id: str) -> bool:
        name = self.container_name(project_id)
        state = self.inspect_state(name)
        if state is None:
            return False
        if self._config.completed_action == "remove":
            return True
        return state == "running"

    def needs_orphan_cleanup(self, name: str) -> bool:
        return self.inspect_state(name) is not None

    def needs_stopped_cleanup(self, project_id: str) -> bool:
        return self.inspect_state(self.container_name(project_id)) == "running"

    def build_exec_process(
        self,
        container_name: str,
        env: dict[str, str],
        command: list[str],
        timeout_seconds: int | None = None,
        kill_after_seconds: int = 5,
    ) -> ManagedProcess:
        container = self._require_container(container_name)
        env = {
            **env,
            "PATH": f"{self._WORKSPACE}/.redtrace/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
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
        return ManagedProcess(container, argv, env)

    def write_text_file(self, container_name: str, path: str, content: str) -> None:
        archive_path, archive = self._text_file_archive(path, content)
        container = self._require_container(container_name)
        try:
            ok = container.put_archive(archive_path, archive)
        except DockerException as exc:
            raise RuntimeError(f"failed to write container file {path}: {exc}") from exc
        if not ok:
            raise RuntimeError(f"failed to write container file {path}")

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
