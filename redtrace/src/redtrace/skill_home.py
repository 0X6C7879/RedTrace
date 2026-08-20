"""User-level Skill home management.

RedTrace manages the canonical Skill store (``<root>/skills``); agents load
Skills natively from their own user-level Skill directories. This module
keeps the two consistent by appending one directory link per Skill into each
agent's native Skill directory::

    ~/.claude/skills/<name>   -> <RedTrace>/skills/<name>
    ~/.codex/skills/<name>    -> <RedTrace>/skills/<name>
    ~/.pi/agent/skills/<name> -> <RedTrace>/skills/<name>

The user's own directory is never replaced, migrated, or backed up — only
links that RedTrace itself created are ever touched. The sync is idempotent:
re-running it adds missing links, repairs stale ones (for example after the
checkout moved), and removes links whose Skill was disabled or deleted,
while user entries (real directories, files, or links pointing elsewhere)
are left strictly alone. A Skill name the user already occupies is reported
as a conflict, never overwritten.
"""

from __future__ import annotations

import logging
import os
import subprocess
from pathlib import Path

LOG = logging.getLogger(__name__)

# agent id -> Skill root relative to the user home directory.
AGENT_SKILL_HOME_RELATIVE: dict[str, tuple[str, ...]] = {
    "claude": (".claude", "skills"),
    "codex": (".codex", "skills"),
    "pi": (".pi", "agent", "skills"),
}


class SkillHomeError(RuntimeError):
    """Raised when an agent Skill home cannot be synced with the store."""


def _is_link(path: Path) -> bool:
    return path.is_symlink() or bool(hasattr(path, "is_junction") and path.is_junction())


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


def ensure_directory_link(link: Path, target: Path) -> None:
    """Ensure ``link`` is a directory link pointing at ``target``.

    Idempotent and self-healing: a link whose target no longer exists (for
    example after the RedTrace checkout moved) is re-created, but a link
    that deliberately points at another live directory is never silently
    replaced. A real directory or a regular file at ``link`` is an error —
    this helper is only for locations RedTrace owns.
    """
    target = target.resolve()
    if not target.is_dir():
        raise SkillHomeError(f"Skill link target is not a directory: {target}")
    if _is_link(link):
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
            f"refusing to replace {link}: it is a real "
            f"{'file' if link.is_file() else 'directory'}"
        )
    _create_directory_link(link, target)


def _points_into_store(link: Path, store: Path, disabled_root: Path) -> bool:
    """True when ``link`` is a RedTrace-managed link into the Skill store."""
    if not _is_link(link):
        return False
    try:
        target = link.resolve(strict=False)
    except OSError:
        return False
    return store == target or store in target.parents or (
        disabled_root == target or disabled_root in target.parents
    )


def _remove_link(link: Path) -> None:
    if link.is_symlink():
        link.unlink()
    else:
        link.rmdir()


def _sync_agent_skill_home(
    user_dir: Path,
    store: Path,
    disabled_root: Path,
    skill_names: set[str],
) -> list[str]:
    """Append one link per store Skill into ``user_dir``; remove stale ones.

    Returns the names the user already occupies (their entry is kept and the
    store Skill stays invisible for this agent).
    """
    if _is_link(user_dir):
        if user_dir.resolve(strict=False) == store:
            # A root link from an earlier RedTrace release already exposes
            # the whole store; appending per-Skill links into it would create
            # self-referencing loops.
            return []
        # The user's own link to their Skill hub: append through it.
    if user_dir.exists() and not user_dir.is_dir():
        raise SkillHomeError(
            f"agent Skill home is not a directory: {user_dir}"
        )
    user_dir.mkdir(parents=True, exist_ok=True)

    conflicts: list[str] = []
    for name in sorted(skill_names):
        entry = user_dir / name
        target = (store / name).resolve()
        if _is_link(entry):
            if entry.resolve(strict=False) == target:
                continue
            if _points_into_store(entry, store, disabled_root) or not (
                entry.resolve(strict=False).exists()
            ):
                # Our own stale link (moved store, renamed Skill) or a
                # dangling link of the same name — repair it.
                _remove_link(entry)
                _create_directory_link(entry, target)
                continue
            conflicts.append(name)
            continue
        if entry.exists():
            # The user's own real directory or file shadows this Skill.
            conflicts.append(name)
            continue
        _create_directory_link(entry, target)

    # Remove RedTrace links whose Skill was disabled or deleted while the
    # user's own entries stay untouched.
    try:
        existing = list(user_dir.iterdir())
    except OSError:
        return conflicts
    for entry in existing:
        if not _is_link(entry) or not _points_into_store(entry, store, disabled_root):
            continue
        target = entry.resolve(strict=False)
        keep = (
            entry.name in skill_names
            and target == (store / entry.name).resolve()
        )
        if not keep:
            _remove_link(entry)
    return conflicts


def ensure_agent_skill_roots(skills_dir: str | Path) -> None:
    """Sync every agent's native Skill home with the canonical Skill store.

    Appends one directory link per enabled Skill into ``~/.claude/skills``,
    ``~/.codex/skills`` and ``~/.pi/agent/skills``. Idempotent; never
    replaces, migrates, or deletes user-owned entries.
    """
    store = Path(skills_dir).resolve()
    store.mkdir(parents=True, exist_ok=True)
    disabled_root = store.parent / "disabled-skills"
    skill_names = {
        directory.name
        for directory in store.iterdir()
        if directory.is_dir() and (directory / "SKILL.md").is_file()
    }
    home = Path.home()
    for agent, relative in AGENT_SKILL_HOME_RELATIVE.items():
        user_dir = home.joinpath(*relative)
        conflicts = _sync_agent_skill_home(user_dir, store, disabled_root, skill_names)
        if conflicts:
            LOG.warning(
                "agent %s keeps its own entries for %s; the canonical store "
                "versions stay hidden for this agent",
                agent,
                ", ".join(sorted(conflicts)),
            )
