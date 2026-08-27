from __future__ import annotations

import hashlib
import io
import json
import logging
import os
import re
import shutil
import tarfile
import tempfile
import threading
import time
from collections.abc import Iterable
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Any

import yaml

from redtrace.board.models import ALL_CAPABILITIES

LOG = logging.getLogger(__name__)

NAME_PATTERN = re.compile(r"^[^\W_][\w-]{0,63}$", re.UNICODE)
MANIFEST_PATH = ".redtrace/capabilities.json"
BLACKBOARD_CLI_PATH = ".redtrace/bin/redtrace-blackboard"
RESOURCE_CLI_PATH = ".redtrace/bin/redtrace-resource"
SKILL_CLI_PATH = ".redtrace/bin/redtrace-skill"
WORKSPACE_CLI_PATHS = {
    BLACKBOARD_CLI_PATH,
    RESOURCE_CLI_PATH,
    SKILL_CLI_PATH,
}
DEFAULT_MAX_SKILLS = 256
DEFAULT_MAX_SKILL_CHARS = 65_536
DEFAULT_HISTORY_LIMIT = 12
SKILL_TRUST_STATES = frozenset({"provisional", "trusted", "retired"})
SKILL_FILE_SCAN_IGNORES = frozenset(
    {".git", ".venv", "__pycache__", "node_modules"}
)

AUDIT_LIMIT_BYTES = 1_048_576


class SkillConflictError(RuntimeError):
    """Raised when an optimistic Skill update uses a stale revision."""


def _positive_env(name: str, default: int) -> int:
    try:
        value = int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


def _content_revision(
    content: str,
    trust: str = "trusted",
    successful_reuses: int = 0,
    failure_count: int = 0,
) -> str:
    digest = hashlib.sha256()
    digest.update(f"trust={trust}\n".encode())
    digest.update(f"successful_reuses={successful_reuses}\n".encode())
    digest.update(f"failure_count={failure_count}\n".encode())
    digest.update(content.encode("utf-8"))
    return digest.hexdigest()


def _utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def resolve_capabilities_root(explicit: str | Path | None = None) -> Path:
    if explicit:
        return Path(explicit).expanduser().resolve()
    configured = os.environ.get("REDTRACE_CAPABILITIES_ROOT")
    if configured:
        return Path(configured).expanduser().resolve()

    source_root = Path(__file__).resolve().parents[3]
    if any((source_root / name).is_dir() for name in ("skills", "mcp")):
        return source_root
    cwd = Path.cwd().resolve()
    if any((cwd / name).is_dir() for name in ("skills", "mcp")):
        return cwd
    if (cwd / "redtrace" / "pyproject.toml").is_file() or (cwd / "pyproject.toml").is_file():
        return cwd
    return source_root


def validate_capability_name(name: str) -> str:
    normalized = name.strip().lower()
    if not NAME_PATTERN.fullmatch(normalized):
        raise ValueError("name must match ^[a-z0-9][a-z0-9_-]{0,63}$")
    return normalized


def _atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise


def _frontmatter(content: str) -> dict[str, Any]:
    """Parse a complete YAML frontmatter block.

    Skill metadata is deliberately read with a YAML parser rather than a
    line-oriented approximation: ``metadata.redtrace`` contains lists and
    booleans, and malformed metadata must be diagnosable by the resolver.
    """
    if not content.startswith("---\n"):
        return {}
    match = re.match(r"^---\n(.*?)\n---(?:\n|$)", content, re.DOTALL)
    if match is None:
        return {}
    try:
        values = yaml.safe_load(match.group(1))
    except yaml.YAMLError:
        return {}
    return values if isinstance(values, dict) else {}


def _strip_frontmatter(content: str) -> str:
    match = re.match(r"^---\n.*?\n---(?:\n|$)", content, re.DOTALL)
    return content[match.end():] if match is not None else content


@dataclass(frozen=True, slots=True)
class SkillRecord:
    name: str
    description: str
    enabled: bool
    content: str
    files: tuple[str, ...]
    version: int
    revision: str
    updated_at: str | None
    directory: Path
    trust: str = "trusted"
    successful_reuses: int = 0
    failure_count: int = 0
    provisional_task: str | None = None
    capabilities: tuple[str, ...] = ()
    competition: Any = False

    def summary(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "enabled": self.enabled,
            "files": list(self.files),
            "version": self.version,
            "revision": self.revision,
            "updatedAt": self.updated_at,
            "trust": self.trust,
            "successfulReuses": self.successful_reuses,
            "failureCount": self.failure_count,
            "capabilities": list(self.capabilities),
            "competition": self.competition,
        }


class SkillCatalogError(ValueError):
    """Raised when an enabled top-level Skill has invalid classification."""

    def __init__(self, diagnostics: list[dict[str, Any]]):
        self.diagnostics = diagnostics
        details = "; ".join(
            f"{item.get('skill', '?')}: {item.get('message', 'invalid metadata')}"
            for item in diagnostics
        )
        super().__init__(details or "invalid Skill catalog metadata")


@dataclass(frozen=True, slots=True)
class McpRecord:
    name: str
    enabled: bool
    config: dict[str, Any]

    def summary(self) -> dict[str, Any]:
        common = _common_mcp_config(self.config)
        transport = str(common.get("transport") or common.get("type") or ("http" if common.get("url") else "stdio"))
        return {
            "name": self.name,
            "enabled": self.enabled,
            "transport": transport,
            "command": common.get("command"),
            "url": common.get("url"),
            "agents": ["dsh"],
            "config": self.config,
        }


class CapabilityStore:
    _skill_list_cache_lock = threading.Lock()
    _skill_list_cache: dict[str, tuple[float, tuple[SkillRecord, ...]]] = {}
    _skill_list_cache_seconds = 1.0

    def __init__(
        self,
        root: str | Path | None = None,
        *,
        skills_dir: str | Path | None = None,
        disabled_skills_dir: str | Path | None = None,
        mcp_dir: str | Path | None = None,
    ):
        self.root = resolve_capabilities_root(root)
        self.skills_dir = (
            Path(skills_dir).resolve() if skills_dir else self.root / "skills"
        )
        # A Skill is enabled by living in ``skills_dir`` and disabled by living
        # in ``disabled_skills_dir``. Agent-native Skill loaders only ever look
        # at the linked ``skills_dir``, so the store layout is the single
        # source of truth for visibility.
        self.disabled_skills_dir = (
            Path(disabled_skills_dir).resolve()
            if disabled_skills_dir
            else self.skills_dir.parent / "disabled-skills"
        )
        self.mcp_dir = Path(mcp_dir).resolve() if mcp_dir else self.root / "mcp"
        self.skill_meta_dir = self.skills_dir / ".redtrace"
        self.max_skills = _positive_env("REDTRACE_MAX_SKILLS", DEFAULT_MAX_SKILLS)
        self.max_skill_chars = _positive_env("REDTRACE_MAX_SKILL_CHARS", DEFAULT_MAX_SKILL_CHARS)
        self.history_limit = _positive_env("REDTRACE_SKILL_HISTORY_LIMIT", DEFAULT_HISTORY_LIMIT)
        self._legacy_state_migrated = False

    def ensure(self) -> None:
        self.skills_dir.mkdir(parents=True, exist_ok=True)
        self.disabled_skills_dir.mkdir(parents=True, exist_ok=True)
        self.mcp_dir.mkdir(parents=True, exist_ok=True)
        self.skill_meta_dir.mkdir(parents=True, exist_ok=True)
        self._migrate_legacy_enabled_state()

    def _migrate_legacy_enabled_state(self) -> None:
        """Move Skills disabled through the legacy ``.redtrace.json`` marker.

        Older RedTrace versions stored ``enabled: false`` inside the Skill
        state file. The directory layout is now authoritative, so those Skills
        are relocated into ``disabled-skills/`` once and the stale marker is
        dropped from the state file.
        """
        if self._legacy_state_migrated:
            return
        self._legacy_state_migrated = True
        for directory in sorted(self.skills_dir.iterdir(), key=lambda item: item.name):
            state_path = directory / ".redtrace.json"
            if not directory.is_dir() or not state_path.is_file():
                continue
            try:
                state = json.loads(state_path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                continue
            if not isinstance(state, dict) or state.get("enabled") is not False:
                continue
            destination = self.disabled_skills_dir / directory.name
            if destination.exists():
                LOG.warning(
                    "cannot migrate disabled Skill %s: %s already exists",
                    directory.name,
                    destination,
                )
                continue
            state.pop("enabled", None)
            shutil.move(str(directory), str(destination))
            _atomic_write(
                destination / ".redtrace.json",
                json.dumps(state, separators=(",", ":")) + "\n",
            )
            LOG.info(
                "migrated legacy disabled Skill %s to %s", directory.name, destination
            )

    def list_skills(self) -> list[SkillRecord]:
        """Read bounded Skill entrypoint metadata without walking dependencies."""
        self.ensure()
        cache_key = str(self.skills_dir)
        now = time.monotonic()
        with self._skill_list_cache_lock:
            cached = self._skill_list_cache.get(cache_key)
            if cached is not None and now - cached[0] < self._skill_list_cache_seconds:
                return list(cached[1])
            records = self._list_skills_uncached()
            self._skill_list_cache[cache_key] = (now, tuple(records))
            return records

    def _list_skills_uncached(self) -> list[SkillRecord]:
        records: list[SkillRecord] = []
        for enabled, root in ((True, self.skills_dir), (False, self.disabled_skills_dir)):
            for directory in sorted(root.iterdir(), key=lambda item: item.name):
                if not directory.is_dir() or not NAME_PATTERN.fullmatch(directory.name):
                    continue
                record = self._read_skill(directory, include_files=False, enabled=enabled)
                if record is not None:
                    records.append(record)
        return records

    def _invalidate_skill_list_cache(self) -> None:
        with self._skill_list_cache_lock:
            self._skill_list_cache.pop(str(self.skills_dir), None)

    def get_skill(
        self,
        name: str,
        *,
        include_files: bool = True,
    ) -> SkillRecord:
        name = validate_capability_name(name)
        for enabled, directory in (
            (True, self.skills_dir / name),
            (False, self.disabled_skills_dir / name),
        ):
            record = self._read_skill(directory, include_files=include_files, enabled=enabled)
            if record is not None:
                return record
        raise FileNotFoundError(name)

    def _read_skill(
        self,
        directory: Path,
        *,
        include_files: bool,
        enabled: bool,
    ) -> SkillRecord | None:
        entrypoint = directory / "SKILL.md"
        if not directory.is_dir() or not entrypoint.is_file():
            return None
        content = entrypoint.read_text(encoding="utf-8")
        metadata = _frontmatter(content)
        redtrace_metadata = metadata.get("metadata", {}).get("redtrace", {}) if isinstance(metadata.get("metadata"), dict) else {}
        raw_capabilities = redtrace_metadata.get("capabilities", []) if isinstance(redtrace_metadata, dict) else []
        skill_capabilities = tuple(
            item.strip().lower() if isinstance(item, str) and item.strip()
            else f"<invalid:{type(item).__name__}>"
            for item in raw_capabilities
        ) if isinstance(raw_capabilities, list) else ()
        competition = redtrace_metadata.get("competition", False) if isinstance(redtrace_metadata, dict) else False
        state_path = directory / ".redtrace.json"
        state: dict[str, Any] = {}
        if state_path.is_file():
            try:
                loaded = json.loads(state_path.read_text(encoding="utf-8"))
                state = loaded if isinstance(loaded, dict) else {}
            except (json.JSONDecodeError, OSError):
                state = {}
        files = self._list_skill_files(directory) if include_files else ()
        try:
            version = max(1, int(state.get("version", 1)))
        except (TypeError, ValueError):
            version = 1
        trust = str(state.get("trust") or "trusted")
        if trust not in SKILL_TRUST_STATES:
            trust = "trusted"
        try:
            successful_reuses = max(0, int(state.get("successfulReuses", 0)))
        except (TypeError, ValueError):
            successful_reuses = 0
        try:
            failure_count = max(0, int(state.get("failureCount", 0)))
        except (TypeError, ValueError):
            failure_count = 0
        stored_revision = str(state.get("revision") or "")
        observed_revision = _content_revision(
            content,
            trust,
            successful_reuses,
            failure_count,
        )
        provisional_task = (
            str(state["provisionalTask"])
            if state.get("provisionalTask")
            else None
        )
        if stored_revision and stored_revision != observed_revision:
            trust = "provisional"
            successful_reuses = 0
            provisional_task = "out-of-band"
            stored_revision = _content_revision(
                content,
                trust,
                successful_reuses,
                failure_count,
            )
        return SkillRecord(
            name=directory.name,
            description=metadata.get("description", ""),
            enabled=enabled,
            content=content,
            files=files,
            version=version,
            revision=stored_revision or observed_revision,
            updated_at=str(state["updatedAt"]) if state.get("updatedAt") else None,
            directory=directory,
            trust=trust,
            successful_reuses=successful_reuses,
            failure_count=failure_count,
            provisional_task=provisional_task,
            capabilities=skill_capabilities,
            competition=competition,
        )

    def classify_skills(self) -> list[dict[str, Any]]:
        """Return deterministic classification diagnostics for enabled roots."""
        classifications: list[dict[str, Any]] = []
        for record in self.list_skills():
            if not record.enabled:
                continue
            diagnostics: list[str] = []
            if not record.capabilities:
                diagnostics.append("metadata.redtrace.capabilities is required")
            unknown = sorted(set(record.capabilities) - set(ALL_CAPABILITIES))
            if unknown:
                diagnostics.append(f"unknown capability(s): {', '.join(unknown)}")
            if len(set(record.capabilities)) != len(record.capabilities):
                diagnostics.append("capabilities must not contain duplicates")
            if not isinstance(record.competition, bool):
                diagnostics.append("metadata.redtrace.competition must be boolean")
            classifications.append({
                "name": record.name,
                "capabilities": list(record.capabilities),
                "competition": record.competition,
                "valid": not diagnostics,
                "diagnostics": diagnostics,
            })
        return classifications

    def resolve_skill_catalog(
        self,
        capabilities: Iterable[str],
        skill_profile: str = "standard",
    ) -> dict[str, Any]:
        """Resolve a Session catalog from Intent directions and project profile.

        The resolver fails closed on any invalid enabled top-level Skill. It
        never falls back to exposing the complete root, which keeps a bad
        metadata edit from silently reintroducing the old 90-Skill catalog.
        """
        requested = [str(item).strip().lower() for item in capabilities]
        if not requested:
            raise ValueError("at least one capability is required")
        if len(set(requested)) != len(requested):
            raise ValueError("capabilities must not contain duplicates")
        unknown_requested = sorted(set(requested) - set(ALL_CAPABILITIES))
        if unknown_requested:
            raise ValueError(f"unknown capability(s): {', '.join(unknown_requested)}")
        if skill_profile not in {"standard", "competition"}:
            raise ValueError("skill_profile must be standard or competition")

        diagnostics = [
            {
                "skill": item["name"],
                "message": message,
            }
            for item in self.classify_skills()
            for message in item["diagnostics"]
        ]
        if diagnostics:
            raise SkillCatalogError(diagnostics)

        requested_set = set(requested)
        selected: list[str] = []
        for record in self.list_skills():
            if not record.enabled or record.name == "ctf-sandbox-orchestrator":
                continue
            record_caps = set(record.capabilities)
            if record.competition:
                if skill_profile == "competition" and record_caps & requested_set:
                    selected.append(record.name)
            elif "common" in record_caps or record_caps & requested_set:
                selected.append(record.name)

        profile_rules = ""
        if skill_profile == "competition":
            try:
                orchestrator = self.get_skill("ctf-sandbox-orchestrator", include_files=False)
            except FileNotFoundError as exc:
                raise SkillCatalogError([{
                    "skill": "ctf-sandbox-orchestrator",
                    "message": "Competition Profile rules source is missing",
                }]) from exc
            if not orchestrator.enabled:
                raise SkillCatalogError([{
                    "skill": "ctf-sandbox-orchestrator",
                    "message": "Competition Profile rules source is disabled",
                }])
            profile_rules = _strip_frontmatter(orchestrator.content).strip()
            if not profile_rules:
                raise SkillCatalogError([{
                    "skill": "ctf-sandbox-orchestrator",
                    "message": "Competition Profile rules source is empty",
                }])

        return {
            "skills": sorted(set(selected)),
            "capabilities": requested,
            "skillProfile": skill_profile,
            "diagnostics": [],
            "competitionRules": profile_rules,
        }

    def _list_skill_files(self, directory: Path) -> tuple[str, ...]:
        files: list[str] = []
        for root, directories, names in os.walk(directory):
            directories[:] = sorted(
                name
                for name in directories
                if name not in SKILL_FILE_SCAN_IGNORES
            )
            root_path = Path(root)
            for name in sorted(names):
                if name == ".redtrace.json":
                    continue
                files.append(
                    str((root_path / name).relative_to(directory)).replace(
                        "\\", "/"
                    )
                )
        return tuple(files)

    def write_skill(
        self,
        name: str,
        content: str,
        *,
        enabled: bool = True,
        expected_revision: str | None = None,
        actor: str = "api",
        reason: str = "manual update",
        action: str = "update",
        trust: str | None = None,
        successful_reuses: int | None = None,
        failure_count: int | None = None,
        provisional_task: str | None = None,
    ) -> SkillRecord:
        name = validate_capability_name(name)
        if not content.strip():
            raise ValueError("SKILL.md content must not be empty")
        content = content.rstrip() + "\n"
        if len(content) > self.max_skill_chars:
            raise ValueError(f"SKILL.md exceeds {self.max_skill_chars} characters")
        self._validate_skill_metadata(name, content, enabled=enabled)
        if trust is not None and trust not in SKILL_TRUST_STATES:
            raise ValueError("Skill trust must be provisional, trusted, or retired")
        with self._skill_lock():
            existing = self._get_skill_direct(name)
            if existing is None and len(self.list_skills()) >= self.max_skills:
                raise ValueError(f"skill count limit reached ({self.max_skills})")
            if expected_revision is not None:
                current_revision = existing.revision if existing else None
                if current_revision != expected_revision:
                    raise SkillConflictError(
                        f"skill revision conflict for {name}: expected {expected_revision}, current {current_revision}"
                    )
            next_trust = trust or (existing.trust if existing else "trusted")
            next_reuses = (
                successful_reuses
                if successful_reuses is not None
                else (existing.successful_reuses if existing else 0)
            )
            next_failures = (
                failure_count
                if failure_count is not None
                else (existing.failure_count if existing else 0)
            )
            next_provisional_task = (
                provisional_task
                if provisional_task is not None
                else (existing.provisional_task if existing else None)
            )
            if next_reuses < 0 or next_failures < 0:
                raise ValueError("Skill quality counters must be non-negative")
            if (
                existing
                and existing.content == content
                and existing.enabled == enabled
                and existing.trust == next_trust
                and existing.successful_reuses == next_reuses
                and existing.failure_count == next_failures
                and existing.provisional_task == next_provisional_task
            ):
                return existing

            version = existing.version + 1 if existing else 1
            revision = _content_revision(
                content,
                next_trust,
                next_reuses,
                next_failures,
            )
            updated_at = _utc_now()
            directory = self.skills_dir if enabled else self.disabled_skills_dir
            directory.mkdir(parents=True, exist_ok=True)
            if existing and existing.directory != directory:
                # Toggling moves the Skill between the enabled and disabled
                # roots; the directory layout is the visibility contract with
                # the agents' native Skill loaders.
                if (directory / name).exists():
                    raise SkillConflictError(
                        f"skill {name} already exists in both roots"
                    )
                shutil.move(str(existing.directory), str(directory / name))
            if existing:
                self._record_history(existing, actor=actor, reason=reason)
            _atomic_write(directory / name / "SKILL.md", content)
            _atomic_write(
                directory / name / ".redtrace.json",
                json.dumps(
                    {
                        "version": version,
                        "revision": revision,
                        "updatedAt": updated_at,
                        "trust": next_trust,
                        "successfulReuses": next_reuses,
                        "failureCount": next_failures,
                        "provisionalTask": next_provisional_task,
                    },
                    separators=(",", ":"),
                )
                + "\n",
            )
            self._invalidate_skill_list_cache()
            record = self._get_skill_direct(name)
            assert record is not None
            self._record_history(record, actor=actor, reason=reason)
            self._append_skill_audit(
                {
                    "action": "create" if existing is None else action,
                    "actor": actor,
                    "skill": name,
                    "version": version,
                    "revision": revision,
                    "previousRevision": existing.revision if existing else None,
                    "reason": reason[:500],
                    "trust": next_trust,
                    "successfulReuses": next_reuses,
                    "failureCount": next_failures,
                    "at": updated_at,
                }
            )
            self._prune_history(name)
        return self.get_skill(name)

    @staticmethod
    def _validate_skill_metadata(name: str, content: str, *, enabled: bool) -> None:
        """Validate the classification contract before an enabled Skill write."""
        if not enabled:
            return
        metadata = _frontmatter(content)
        redtrace = metadata.get("metadata", {}).get("redtrace") if isinstance(metadata.get("metadata"), dict) else None
        if not isinstance(redtrace, dict):
            raise ValueError("enabled Skill requires metadata.redtrace")
        capabilities = redtrace.get("capabilities")
        if not isinstance(capabilities, list) or not capabilities:
            raise ValueError("metadata.redtrace.capabilities must be a non-empty list")
        normalized = [item.strip().lower() for item in capabilities if isinstance(item, str)]
        if len(normalized) != len(capabilities) or len(set(normalized)) != len(normalized):
            raise ValueError("metadata.redtrace.capabilities must contain unique strings")
        unknown = sorted(set(normalized) - set(ALL_CAPABILITIES))
        if unknown:
            raise ValueError(f"unknown capability(s): {', '.join(unknown)}")
        competition = redtrace.get("competition")
        if not isinstance(competition, bool):
            raise ValueError("metadata.redtrace.competition must be boolean")
        if name.startswith("competition-") and competition is not True:
            raise ValueError("competition-* Skills must set metadata.redtrace.competition: true")
        if name == "ctf-sandbox-orchestrator" and competition is not True:
            raise ValueError("ctf-sandbox-orchestrator must set metadata.redtrace.competition: true")

    def set_skill_enabled(self, name: str, enabled: bool) -> SkillRecord:
        record = self.get_skill(name)
        return self.write_skill(
            record.name,
            record.content,
            enabled=enabled,
            expected_revision=record.revision,
            actor="api",
            reason=f"set enabled={enabled}",
            action="toggle",
        )

    def delete_skill(
        self,
        name: str,
        *,
        actor: str = "api",
        reason: str = "manual delete",
        action: str = "delete",
    ) -> None:
        name = validate_capability_name(name)
        with self._skill_lock():
            record = self._get_skill_direct(name)
            if record is None:
                raise FileNotFoundError(name)
            self._record_history(record, actor=actor, reason=reason)
            shutil.rmtree(record.directory)
            self._invalidate_skill_list_cache()
            self._append_skill_audit(
                {
                    "action": action,
                    "actor": actor,
                    "skill": name,
                    "version": record.version,
                    "revision": record.revision,
                    "reason": reason[:500],
                    "at": _utc_now(),
                }
            )

    def list_skill_versions(self, name: str) -> list[dict[str, Any]]:
        name = validate_capability_name(name)
        history_dir = self.skill_meta_dir / "history" / name
        if not history_dir.is_dir():
            return []
        versions: list[dict[str, Any]] = []
        for path in sorted(history_dir.glob("v*.json"), reverse=True):
            try:
                item = json.loads(path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                continue
            if isinstance(item, dict):
                item.pop("content", None)
                versions.append(item)
        return versions

    def rollback_skill(
        self,
        name: str,
        version: int,
        *,
        expected_revision: str | None = None,
        actor: str = "api",
    ) -> SkillRecord:
        name = validate_capability_name(name)
        path = self.skill_meta_dir / "history" / name / f"v{version:06d}.json"
        if not path.is_file():
            raise FileNotFoundError(f"{name}@{version}")
        snapshot = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(snapshot, dict) or not isinstance(snapshot.get("content"), str):
            raise ValueError(f"invalid skill history snapshot: {name}@{version}")
        return self.write_skill(
            name,
            snapshot["content"],
            enabled=bool(snapshot.get("enabled", True)),
            expected_revision=expected_revision,
            actor=actor,
            reason=f"rollback to version {version}",
            action="rollback",
            trust=str(snapshot.get("trust") or "trusted"),
            successful_reuses=max(0, int(snapshot.get("successfulReuses", 0))),
            failure_count=max(0, int(snapshot.get("failureCount", 0))),
            provisional_task=(
                str(snapshot["provisionalTask"])
                if snapshot.get("provisionalTask")
                else ""
            ),
        )

    def read_skill_audit(self, limit: int = 100) -> list[dict[str, Any]]:
        path = self.skill_meta_dir / "audit.jsonl"
        if not path.is_file():
            return []
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()[-max(1, min(limit, 500)) :]
        events: list[dict[str, Any]] = []
        for line in reversed(lines):
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(event, dict):
                events.append(event)
        return events

    def record_skill_audit(self, event: dict[str, Any]) -> None:
        with self._skill_lock():
            payload = dict(event)
            payload.setdefault("at", _utc_now())
            self._append_skill_audit(payload)

    def _get_skill_direct(self, name: str) -> SkillRecord | None:
        for enabled, directory in (
            (True, self.skills_dir / name),
            (False, self.disabled_skills_dir / name),
        ):
            record = self._read_skill(directory, include_files=False, enabled=enabled)
            if record is not None:
                return record
        return None

    @contextmanager
    def _skill_lock(self):
        self.ensure()
        lock_dir = self.skill_meta_dir / "locks" / "store.lock"
        lock_dir.parent.mkdir(parents=True, exist_ok=True)
        deadline = time.monotonic() + 2.0
        while True:
            try:
                lock_dir.mkdir()
                break
            except FileExistsError:
                try:
                    stale = time.time() - lock_dir.stat().st_mtime > 30
                except FileNotFoundError:
                    continue
                if stale:
                    shutil.rmtree(lock_dir, ignore_errors=True)
                    continue
                if time.monotonic() >= deadline:
                    raise SkillConflictError("timed out waiting for Skill store lock")
                time.sleep(0.02)
        try:
            yield
        finally:
            shutil.rmtree(lock_dir, ignore_errors=True)

    def _record_history(self, record: SkillRecord, *, actor: str, reason: str) -> None:
        path = self.skill_meta_dir / "history" / record.name / f"v{record.version:06d}.json"
        if path.is_file():
            return
        _atomic_write(
            path,
            json.dumps(
                {
                    "name": record.name,
                    "version": record.version,
                    "revision": record.revision,
                    "enabled": record.enabled,
                    "content": record.content,
                    "actor": actor,
                    "reason": reason[:500],
                    "trust": record.trust,
                    "successfulReuses": record.successful_reuses,
                    "failureCount": record.failure_count,
                    "provisionalTask": record.provisional_task,
                    "at": record.updated_at or _utc_now(),
                },
                ensure_ascii=False,
                separators=(",", ":"),
            )
            + "\n",
        )

    def _prune_history(self, name: str) -> None:
        paths = sorted((self.skill_meta_dir / "history" / name).glob("v*.json"))
        for path in paths[: -self.history_limit]:
            path.unlink(missing_ok=True)

    def _append_skill_audit(self, event: dict[str, Any]) -> None:
        path = self.skill_meta_dir / "audit.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.is_file() and path.stat().st_size > AUDIT_LIMIT_BYTES:
            tail = path.read_bytes()[-(AUDIT_LIMIT_BYTES // 2) :]
            newline = tail.find(b"\n")
            _atomic_write(path, tail[newline + 1 :].decode("utf-8", errors="ignore"))
        with path.open("a", encoding="utf-8", newline="\n") as handle:
            handle.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")

    def list_mcp(self) -> list[McpRecord]:
        self.ensure()
        records: list[McpRecord] = []
        for path in sorted(self.mcp_dir.glob("*.json")):
            if not NAME_PATTERN.fullmatch(path.stem):
                continue
            try:
                config = json.loads(path.read_text(encoding="utf-8"))
            except json.JSONDecodeError as exc:
                raise ValueError(f"{path.name}: invalid JSON: {exc.msg}") from exc
            if not isinstance(config, dict):
                raise TypeError(f"{path.name}: root value must be an object")
            enabled = bool(config.get("enabled", True))
            records.append(McpRecord(name=path.stem, enabled=enabled, config=config))
        return records

    def get_mcp(self, name: str) -> McpRecord:
        name = validate_capability_name(name)
        path = self.mcp_dir / f"{name}.json"
        if not path.is_file():
            raise FileNotFoundError(name)
        config = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(config, dict):
            raise TypeError(f"{path.name}: root value must be an object")
        return McpRecord(name=name, enabled=bool(config.get("enabled", True)), config=config)

    def write_mcp(self, name: str, config: dict[str, Any]) -> McpRecord:
        name = validate_capability_name(name)
        if not isinstance(config, dict):
            raise TypeError("MCP config must be an object")
        _validate_mcp_config(config)
        self.ensure()
        _atomic_write(
            self.mcp_dir / f"{name}.json",
            json.dumps(config, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        )
        return self.get_mcp(name)

    def set_mcp_enabled(self, name: str, enabled: bool) -> McpRecord:
        record = self.get_mcp(name)
        config = dict(record.config)
        config["enabled"] = enabled
        return self.write_mcp(name, config)

    def delete_mcp(self, name: str) -> None:
        record = self.get_mcp(name)
        (self.mcp_dir / f"{record.name}.json").unlink()

    def digest(self) -> str:
        self.ensure()
        digest = hashlib.sha256()
        for base in (self.skills_dir, self.mcp_dir):
            for path in sorted(base.rglob("*")):
                if not path.is_file():
                    continue
                digest.update(str(path.relative_to(self.root)).replace("\\", "/").encode())
                digest.update(path.read_bytes())
        return digest.hexdigest()


def _validate_mcp_config(config: dict[str, Any]) -> None:
    common = _common_mcp_config(config)
    agents = config.get("agents", {})
    if agents is not None and not isinstance(agents, dict):
        raise ValueError("agents must be an object")
    if (
        not common.get("command")
        and not common.get("url")
        and not any(
            isinstance(value, dict) and (value.get("command") or value.get("url"))
            for value in (agents or {}).values()
        )
    ):
        raise ValueError("MCP config requires command or url")


def _common_mcp_config(config: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in config.items() if key not in {"agents", "enabled", "name"}}


def mcp_config_for(record: McpRecord, agent: str) -> dict[str, Any]:
    """Project an MCP record into the config shape one agent runtime uses.

    The DSH Cordis runtime is the only consumer; ``agent`` stays a parameter
    so per-agent overrides in stored configs keep working.
    """
    result = _common_mcp_config(record.config)
    overrides = record.config.get("agents", {})
    if isinstance(overrides, dict) and isinstance(overrides.get(agent), dict):
        result.update(overrides[agent])

    transport = str(result.get("transport") or result.get("type") or "").lower()
    if transport == "http":
        result["transport"] = "streamable-http"
    elif not transport:
        result["transport"] = "stdio"
    result.pop("type", None)
    return result


def _workspace_cli_bytes(path: str) -> bytes:
    return Path(__file__).with_name(path).read_bytes().replace(b"\r\n", b"\n")


def workspace_payload(store: CapabilityStore) -> tuple[str, dict[str, bytes]]:
    """Runtime infrastructure for a task Workspace.

    Skills are deliberately absent: agents load them natively from their
    user-level Skill directories, which link to the canonical store. The
    Workspace only receives RedTrace's own CLIs, MCP configs, and the
    capability snapshot manifest.
    """
    skills = store.list_skills()
    mcp_records = store.list_mcp()
    files: dict[str, bytes] = {}
    enabled_names: list[str] = []
    skill_versions: dict[str, dict[str, Any]] = {}
    for skill in skills:
        if not skill.enabled:
            continue
        enabled_names.append(skill.name)
        skill_versions[skill.name] = {
            "version": skill.version,
            "revision": skill.revision,
            "trust": skill.trust,
        }

    files[BLACKBOARD_CLI_PATH] = _workspace_cli_bytes("blackboard_cli.py")
    files[RESOURCE_CLI_PATH] = _workspace_cli_bytes("resource_cli.py")
    skill_cli = _workspace_cli_bytes("skill_cli.py")
    files[SKILL_CLI_PATH] = skill_cli
    digest_builder = hashlib.sha256()
    for relative, content in sorted(files.items()):
        digest_builder.update(relative.encode())
        digest_builder.update(content)
    digest_builder.update(b".redtrace/skill-state")
    digest_builder.update(
        json.dumps(
            skill_versions,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    )
    manifest = {
        "digest": digest_builder.hexdigest(),
        "skills": enabled_names,
        "skillVersions": skill_versions,
        "skillTrust": {
            skill.name: skill.trust
            for skill in skills
            if skill.enabled
        },
        "snapshotFrozen": True,
        "runtimeFiles": {
            SKILL_CLI_PATH: hashlib.sha256(skill_cli).hexdigest(),
        },
        "managedFiles": [
            BLACKBOARD_CLI_PATH,
            RESOURCE_CLI_PATH,
            SKILL_CLI_PATH,
        ],
    }
    files[MANIFEST_PATH] = (json.dumps(manifest, separators=(",", ":")) + "\n").encode()
    return manifest["digest"], files


def runtime_workspace_patch(
    manifest: dict[str, Any],
    *,
    force: bool = False,
) -> dict[str, bytes]:
    """Refresh RedTrace runtime infrastructure without thawing task capabilities."""

    runtime_contents = {
        BLACKBOARD_CLI_PATH: _workspace_cli_bytes("blackboard_cli.py"),
        RESOURCE_CLI_PATH: _workspace_cli_bytes("resource_cli.py"),
        SKILL_CLI_PATH: _workspace_cli_bytes("skill_cli.py"),
    }
    runtime_digests = {
        relative: hashlib.sha256(content).hexdigest()
        for relative, content in runtime_contents.items()
    }
    runtime_files = manifest.get("runtimeFiles")
    current = runtime_files if isinstance(runtime_files, dict) else {}
    if not force and all(
        current.get(relative) == digest
        for relative, digest in runtime_digests.items()
    ):
        return {}
    updated = dict(manifest)
    updated["runtimeFiles"] = {**current, **runtime_digests}
    managed = [
        value
        for value in updated.get("managedFiles", [])
        if isinstance(value, str)
    ]
    for relative in runtime_contents:
        if relative not in managed:
            managed.append(relative)
    updated["managedFiles"] = managed
    return {
        **runtime_contents,
        MANIFEST_PATH: (
            json.dumps(updated, separators=(",", ":")) + "\n"
        ).encode(),
    }


def _read_manifest(workspace: Path) -> dict[str, Any]:
    path = workspace / MANIFEST_PATH
    if not path.is_file():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}
    return value if isinstance(value, dict) else {}


def materialize_local_workspace(store: CapabilityStore, workspace: Path) -> str:
    previous = _read_manifest(workspace)
    if previous.get("snapshotFrozen") is True and isinstance(previous.get("digest"), str):
        patch = runtime_workspace_patch(
            previous,
            force=any(
                not (workspace / relative).is_file()
                for relative in ()
            ),
        )
        for relative, content in patch.items():
            target = workspace / Path(relative)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
            if relative in WORKSPACE_CLI_PATHS:
                target.chmod(0o755)
        return previous["digest"]
    digest, files = workspace_payload(store)
    if previous.get("digest") == digest:
        return digest

    for relative, content in files.items():
        target = workspace / Path(relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        if relative in WORKSPACE_CLI_PATHS:
            target.chmod(0o755)
    return digest


def workspace_tar(files: dict[str, bytes]) -> bytes:
    stream = io.BytesIO()
    directories: set[str] = set()
    for relative in files:
        parent = PurePosixPath(relative).parent
        while str(parent) not in {"", "."}:
            directories.add(str(parent))
            parent = parent.parent

    with tarfile.open(fileobj=stream, mode="w") as archive:
        for directory in sorted(directories, key=lambda value: (value.count("/"), value)):
            info = tarfile.TarInfo(directory)
            info.type = tarfile.DIRTYPE
            info.mode = 0o755
            info.uid = 1000
            info.gid = 1000
            archive.addfile(info)
        for relative, content in files.items():
            info = tarfile.TarInfo(relative)
            info.size = len(content)
            if relative in {
                BLACKBOARD_CLI_PATH,
                RESOURCE_CLI_PATH,
                        }:
                info.mode = 0o755
            else:
                info.mode = 0o644
            info.uid = 1000
            info.gid = 1000
            archive.addfile(info, io.BytesIO(content))
    return stream.getvalue()
