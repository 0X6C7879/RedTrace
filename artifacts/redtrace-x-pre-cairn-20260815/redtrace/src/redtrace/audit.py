from __future__ import annotations

import os
import re
import shutil
import tarfile
import uuid
from pathlib import Path, PurePosixPath
from typing import Any

from redtrace.paths import redtrace_root


AUDIT_ROOT = Path(
    os.environ.get(
        "REDTRACE_AUDIT_ROOT",
        redtrace_root() / ".redtrace" / "audit",
    )
).expanduser().resolve()
MAX_ARCHIVE_BYTES = 100 * 1024 * 1024
MAX_ARCHIVE_FILE_BYTES = 10 * 1024 * 1024
EXCLUDED_PARTS = {
    ".cache",
    ".claude",
    ".codex",
    ".git",
    ".pi",
    "__pycache__",
    "node_modules",
}


def archived_workspace(project_id: str) -> Path:
    key = re.sub(r"[^A-Za-z0-9_.-]+", "-", project_id).strip(".-") or "project"
    return AUDIT_ROOT / key / "workspace"


def archive_local_workspace(project_id: str, source: Path) -> Path:
    destination, staging = _staging_workspace(project_id)
    used = 0
    try:
        for path in source.rglob("*"):
            relative = path.relative_to(source)
            if _excluded(relative) or path.is_symlink():
                continue
            target = staging / relative
            if path.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            if not path.is_file():
                continue
            size = path.stat().st_size
            if size > MAX_ARCHIVE_FILE_BYTES or used + size > MAX_ARCHIVE_BYTES:
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)
            used += size
        return _commit_workspace(destination, staging)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def archive_container_workspace(project_id: str, container: Any) -> Path:
    destination, staging = _staging_workspace(project_id)
    archive_path = staging.with_suffix(".tar")
    used = 0
    try:
        stream, _ = container.get_archive("/home/kali/workspace")
        with archive_path.open("wb") as handle:
            for chunk in stream:
                handle.write(chunk)
        with tarfile.open(archive_path, mode="r:*") as archive:
            for member in archive:
                relative = _container_relative(member.name)
                if relative is None or _excluded(relative):
                    continue
                target = staging / relative
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                if not member.isfile():
                    continue
                if member.size > MAX_ARCHIVE_FILE_BYTES or used + member.size > MAX_ARCHIVE_BYTES:
                    continue
                source = archive.extractfile(member)
                if source is None:
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with source, target.open("wb") as handle:
                    shutil.copyfileobj(source, handle)
                used += member.size
        archive_path.unlink(missing_ok=True)
        return _commit_workspace(destination, staging)
    except Exception:
        archive_path.unlink(missing_ok=True)
        shutil.rmtree(staging, ignore_errors=True)
        raise


def _staging_workspace(project_id: str) -> tuple[Path, Path]:
    destination = archived_workspace(project_id)
    destination.parent.mkdir(parents=True, exist_ok=True)
    staging = destination.parent / f".workspace-{uuid.uuid4().hex}"
    staging.mkdir(parents=True)
    return destination, staging


def _commit_workspace(destination: Path, staging: Path) -> Path:
    if destination.exists():
        shutil.rmtree(destination)
    os.replace(staging, destination)
    return destination


def _container_relative(name: str) -> Path | None:
    parts = list(PurePosixPath(name).parts)
    while parts and parts[0] in {"", "/", ".", "workspace"}:
        parts.pop(0)
    if not parts or any(part in {"", ".", ".."} for part in parts):
        return None
    return Path(*parts)


def _excluded(relative: Path) -> bool:
    return any(part in EXCLUDED_PARTS for part in relative.parts)
