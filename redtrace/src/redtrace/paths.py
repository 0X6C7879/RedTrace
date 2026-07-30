from __future__ import annotations

import os
import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path, PurePosixPath, PureWindowsPath

WINDOWS_DRIVE_PATH = re.compile(r"^[A-Za-z]:[\\/]")
WINDOWS_DRIVE_PREFIX = re.compile(r"^[A-Za-z]:")
WINDOWS_PRIVATE_USE_DRIVE_PREFIX = re.compile(r"^[A-Za-z]\uf03a")
WINDOWS_UNC_PATH = re.compile(r"^(?:\\\\|//)[^\\/]+[\\/][^\\/]+")
WINDOWS_ENV = re.compile(r"%([^%]+)%")
SAFE_PROJECT_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")


class PathResolutionError(ValueError):
    pass


def is_windows_absolute(value: str) -> bool:
    return bool(WINDOWS_DRIVE_PATH.match(value) or WINDOWS_UNC_PATH.match(value))


def is_wsl(environ: Mapping[str, str] | None = None) -> bool:
    env = environ or os.environ
    if env.get("WSL_DISTRO_NAME") or env.get("WSL_INTEROP"):
        return True
    try:
        return (
            "microsoft"
            in Path("/proc/sys/kernel/osrelease")
            .read_text(encoding="utf-8", errors="ignore")
            .lower()
        )
    except OSError:
        return False


def expand_path_variables(
    value: str,
    environ: Mapping[str, str] | None = None,
) -> str:
    env = environ or os.environ

    def replace_windows(match: re.Match[str]) -> str:
        return env.get(match.group(1), match.group(0))

    expanded = WINDOWS_ENV.sub(replace_windows, value)
    for key, replacement in env.items():
        expanded = expanded.replace(f"${{{key}}}", replacement)
    return os.path.expanduser(expanded)


def windows_path_to_wsl(value: str) -> PurePosixPath:
    if WINDOWS_UNC_PATH.match(value):
        raise PathResolutionError(
            f"UNC path cannot be portably mapped into WSL: {value!r}"
        )
    path = PureWindowsPath(value)
    drive = path.drive.rstrip(":").lower()
    if not drive or len(drive) != 1:
        raise PathResolutionError(f"invalid Windows drive path: {value!r}")
    return PurePosixPath("/mnt") / drive / PurePosixPath(*path.parts[1:])


def resolve_portable_path(
    value: str | Path,
    *,
    base: Path,
    environ: Mapping[str, str] | None = None,
    platform: str | None = None,
    under_wsl: bool | None = None,
) -> Path:
    raw = expand_path_variables(str(value), environ).strip()
    if not raw:
        raise PathResolutionError("path must not be empty")
    if WINDOWS_PRIVATE_USE_DRIVE_PREFIX.match(raw):
        raise PathResolutionError(
            "path contains U+F03A in place of a Windows drive colon; "
            "use a project-relative path or a real drive path"
        )
    platform = platform or os.name
    wsl = under_wsl if under_wsl is not None else is_wsl(environ)
    if is_windows_absolute(raw):
        if platform == "nt":
            return Path(raw).resolve()
        if wsl:
            mapped = windows_path_to_wsl(raw)
            return Path(mapped).resolve() if os.name != "nt" else mapped  # type: ignore[return-value]
        raise PathResolutionError(
            f"Windows path is not valid on this host and will not be treated as relative: {raw!r}"
        )
    if WINDOWS_DRIVE_PREFIX.match(raw):
        raise PathResolutionError(
            f"drive-relative Windows path is not portable: {raw!r}"
        )
    if platform == "nt" and raw.startswith(("/", "\\")):
        raise PathResolutionError(
            f"POSIX absolute path is not valid on native Windows: {raw!r}"
        )
    portable_relative = (
        raw.replace("/", "\\") if platform == "nt" else raw.replace("\\", "/")
    )
    path = Path(portable_relative)
    if not path.is_absolute():
        path = base / path
    return path.resolve()


def safe_project_key(project_id: str) -> str:
    if not SAFE_PROJECT_ID.fullmatch(project_id) or project_id in {".", ".."}:
        raise PathResolutionError(f"unsafe project id: {project_id!r}")
    return project_id


def ensure_safe_root(root: Path) -> Path:
    resolved = root.resolve()
    if resolved == Path(resolved.anchor) or resolved == Path.home().resolve():
        raise PathResolutionError(f"refusing unsafe managed root: {resolved}")
    return resolved


def contained_path(root: Path, *parts: str) -> Path:
    safe_root = ensure_safe_root(root)
    target = safe_root.joinpath(*parts)
    if target.is_symlink() or (hasattr(target, "is_junction") and target.is_junction()):
        raise PathResolutionError(f"refusing linked deletion target: {target}")
    resolved = target.resolve(strict=False)
    try:
        resolved.relative_to(safe_root)
    except ValueError as exc:
        raise PathResolutionError(f"path escapes managed root: {target}") from exc
    return target


@dataclass(frozen=True, slots=True)
class RedTracePaths:
    root: Path
    skills: Path
    mcp: Path
    plugins: Path
    managed: Path
    workspaces: Path
    audit: Path

    @property
    def runtime(self) -> Path:
        return self.managed / "runtime"

    @property
    def workers(self) -> Path:
        return self.managed / "workers"

    @property
    def projects(self) -> Path:
        return self.managed / "projects"
