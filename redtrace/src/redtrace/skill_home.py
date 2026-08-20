"""User-level Skill home management.

RedTrace manages the canonical Skill store (``<root>/skills``); agents load
Skills natively from their own user-level Skill directories. This module keeps
those two facts consistent by pointing every agent's native Skill root at the
canonical store through a single directory link::

    ~/.claude/skills      -> <RedTrace>/skills
    ~/.codex/skills       -> <RedTrace>/skills
    ~/.pi/agent/skills    -> <RedTrace>/skills

Because the agents read through the link, edits in the canonical store are
visible immediately — no copy, sync, or watcher. ``ensure_agent_skill_roots``
is idempotent and never deletes pre-existing user Skills: a real directory is
migrated into the canonical store first (name collisions are reported and the
originals are preserved in a timestamped backup), and a link that points at a
different live directory is refused instead of silently replaced.
"""

from __future__ import annotations

import hashlib
import logging
import os
import shutil
import subprocess
from datetime import datetime
from pathlib import Path

LOG = logging.getLogger(__name__)

# agent id -> Skill root relative to the user home directory.
AGENT_SKILL_HOME_RELATIVE: dict[str, tuple[str, ...]] = {
    "claude": (".claude", "skills"),
    "codex": (".codex", "skills"),
    "pi": (".pi", "agent", "skills"),
}

_BACKUP_PREFIX = "redtrace-backup-"


class SkillHomeError(RuntimeError):
    """Raised when an agent Skill home cannot be linked to the canonical store."""


def ensure_directory_link(link: Path, target: Path) -> None:
    """Ensure ``link`` is a directory link pointing at ``target``.

    Idempotent and self-healing: a link whose target no longer exists (for
    example after the RedTrace checkout moved) is re-created, but a link that
    deliberately points at another live directory is never silently replaced.
    A real directory or a regular file at ``link`` is an error — callers that
    own the directory must migrate it first (see ``ensure_agent_skill_roots``).
    """
    target = target.resolve()
    if not target.is_dir():
        raise SkillHomeError(f"Skill link target is not a directory: {target}")
    is_junction = bool(hasattr(link, "is_junction") and link.is_junction())
    if link.is_symlink() or is_junction:
        if link.resolve(strict=False) == target:
            return
        if link.resolve(strict=False).exists():
            raise SkillHomeError(
                f"refusing to replace {link}: it points at "
                f"{link.resolve(strict=False)}, not {target}"
            )
        # Stale link (its target disappeared); safe to repair.
        if link.is_symlink():
            link.unlink()
        else:
            link.rmdir()
    elif link.exists():
        raise SkillHomeError(
            f"refusing to replace {link}: it is a real {'file' if link.is_file() else 'directory'}"
        )
    _create_directory_link(link, target)


def _create_directory_link(link: Path, target: Path) -> None:
    link.parent.mkdir(parents=True, exist_ok=True)
    try:
        link.symlink_to(target, target_is_directory=True)
        return
    except OSError:
        if os.name != "nt":
            raise SkillHomeError(f"cannot create directory link: {link}") from None
    completed = subprocess.run(
        ["cmd.exe", "/d", "/c", "mklink", "/J", str(link), str(target)],
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0 or not link.is_dir():
        raise SkillHomeError(
            f"cannot create directory link {link}; "
            "enable Windows Developer Mode or allow directory junctions"
        )


def _entry_signature(entry: Path) -> str | None:
    """Content hash used to decide whether two same-named Skills are identical."""
    try:
        entrypoint = entry / "SKILL.md"
        if entrypoint.is_file():
            payload = entrypoint.read_bytes()
        elif entry.is_file():
            payload = entry.read_bytes()
        else:
            return None
    except OSError:
        return None
    return hashlib.sha256(payload).hexdigest()


def _is_skill_entry(entry: Path) -> bool:
    if entry.name.startswith("."):
        return False
    if entry.is_symlink():
        return (entry / "SKILL.md").is_file()
    return entry.is_dir() and (entry / "SKILL.md").is_file()


def _move_entry(entry: Path, destination: Path) -> None:
    if entry.is_symlink():
        # Recreate the link with an absolute target: a relative link would
        # break once it lives under the canonical store.
        target = os.readlink(entry)
        if not os.path.isabs(target):
            target = str((entry.parent / target).resolve(strict=False))
        destination.symlink_to(target)
        entry.unlink()
        return
    shutil.move(str(entry), str(destination))


def _migrate_skill_entries(source: Path, canonical: Path) -> list[str]:
    """Move user Skills from ``source`` into the canonical store.

    Returns the names that could not be migrated because a different Skill
    with the same name already exists in the store. Everything that is not a
    Skill (or could not be migrated) stays in ``source`` for the caller to
    preserve as a backup.
    """
    conflicts: list[str] = []
    for entry in sorted(source.iterdir()):
        if not _is_skill_entry(entry):
            continue
        destination = canonical / entry.name
        if destination.exists() or destination.is_symlink():
            existing = _entry_signature(destination)
            incoming = _entry_signature(entry)
            if existing is not None and existing == incoming:
                continue
            conflicts.append(entry.name)
            continue
        try:
            _move_entry(entry, destination)
        except OSError as exc:
            LOG.error("cannot migrate Skill %s into %s: %s", entry.name, canonical, exc)
            conflicts.append(entry.name)
    return conflicts


def _backup_directory(source: Path) -> Path:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = source.with_name(f"{source.name}.{_BACKUP_PREFIX}{stamp}")
    while backup.exists():
        backup = backup.with_name(backup.name + "-1")
    source.rename(backup)
    return backup


def ensure_agent_skill_roots(skills_dir: str | Path) -> None:
    """Point every agent's native Skill root at the canonical Skill store."""
    canonical = Path(skills_dir).resolve()
    canonical.mkdir(parents=True, exist_ok=True)
    home = Path.home()
    for agent, relative in AGENT_SKILL_HOME_RELATIVE.items():
        link = home.joinpath(*relative)
        if not link.is_symlink() and not (
            hasattr(link, "is_junction") and link.is_junction()
        ) and link.is_dir():
            conflicts = _migrate_skill_entries(link, canonical)
            if conflicts:
                LOG.error(
                    "Skill home %s has name conflicts with the canonical store "
                    "(kept in the pre-link backup): %s",
                    link,
                    ", ".join(sorted(conflicts)),
                )
            try:
                next(link.iterdir())
            except StopIteration:
                link.rmdir()
            else:
                backup = _backup_directory(link)
                LOG.info(
                    "migrated user Skills from %s into %s; "
                    "originals preserved in %s",
                    link,
                    canonical,
                    backup,
                )
        ensure_directory_link(link, canonical)
