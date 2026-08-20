from __future__ import annotations

import contextlib
import hashlib
import json
import logging
import os
import re
import shutil
from pathlib import Path

from redtrace.capabilities import (
    PI_MCP_EXTENSION,
    PI_PROVIDER_EXTENSION,
    CapabilityStore,
    McpRecord,
    _workspace_cli_bytes,
    build_claude_mcp,
    build_pi_mcp,
    codex_mcp_overrides,
)
from redtrace.config_secrets import atomic_write_text
from redtrace.dispatcher.config import WorkerConfig
from redtrace.native_cli_config import _strip_marked_block
from redtrace.paths import RedTracePaths

_CLI_SOURCES = {
    "redtrace-blackboard": "blackboard_cli.py",
    "redtrace-resource": "resource_cli.py",
    "redtrace-context": "context_cli.py",
    "redtrace-skill": "skill_cli.py",
}

# Container workers discover Skills natively at their agent-home Skill
# directory; ContainerManager bind-mounts the canonical store there.
_CONTAINER_SKILL_DIRS = {
    "claudecode": "/home/kali/.claude/skills",
    "codex": "/home/kali/.codex/skills",
    "pi": "/home/kali/.pi/agent/skills",
}

LOG = logging.getLogger(__name__)
_AUTO_DISABLED_MARKER = "autoDisabledBy"
_AUTO_DISABLED_REASON = "missing-command"
_CODEX_MCP_START = "# >>> RedTrace managed MCP >>>"
_CODEX_MCP_END = "# <<< RedTrace managed MCP <<<"
_CODEX_MCP_SECTION_RE = re.compile(
    r"(?:^|\n)\[mcp_servers\.([^\]\.]+)[^\]]*\]\n(?:[^\[\n][^\n]*\n)*",
    re.MULTILINE,
)


def _strip_mcp_server_sections(content: str, names: set[str]) -> str:
    """Remove ``[mcp_servers.X]`` sections whose *X* is in *names*."""
    def _replace(match: re.Match[str]) -> str:
        return "" if match.group(1) in names else match.group(0)
    return _CODEX_MCP_SECTION_RE.sub(_replace, content)


class AgentRuntimeManager:
    """Expose shared Skills and MCP without replacing native Agent configuration."""

    def __init__(self, paths: RedTracePaths, *, execution: str):
        self.paths = paths
        self.execution = execution
        self.runtime = paths.runtime
        self._store = CapabilityStore(
            paths.root,
            skills_dir=paths.skills,
            mcp_dir=paths.mcp,
        )
        self._shared_initialized = False
        self._mcp_args_cache: list[str] = []
        self._capability_signature_cache: tuple[int, ...] | None = None

    def initialize(self, workers: list[WorkerConfig]) -> None:
        if not self._shared_initialized:
            self._store.ensure()
            self._ensure_skill_memory()
            for directory in (
                self.runtime / "bin",
                self.runtime / "tools" / "bin",
                self.runtime / "mcp",
                self.runtime / "pi",
                self.paths.workspaces,
                self.paths.audit,
            ):
                directory.mkdir(parents=True, exist_ok=True)
            self._shared_initialized = True
        self._refresh_shared_resources(force=self._capability_signature_cache is None)
        for worker in workers:
            if worker.enabled and worker.type != "mock":
                self._initialize_worker(worker)

    def refresh_capabilities(self, workers: list[WorkerConfig]) -> bool:
        """Refresh only after a cheap capability-generation check changes."""
        if not self._refresh_shared_resources(force=False):
            return False
        for worker in workers:
            if worker.enabled and worker.type != "mock":
                self._initialize_worker(worker)
        return True

    def _refresh_shared_resources(self, *, force: bool) -> bool:
        signature = self._capability_signature()
        if not force and signature == self._capability_signature_cache:
            return False
        mcp_records = self._sync_mcp_command_availability(self._store.list_mcp())
        self._write_shared_runtime(mcp_records)
        self._deploy_user_mcp(mcp_records)
        self._mcp_args_cache = codex_mcp_overrides(mcp_records)
        self._capability_signature_cache = self._capability_signature()
        return True

    def _ensure_skill_memory(self) -> None:
        """Migrate legacy Skill Memory into per-skill memory directories.

        Old central layout → new per-skill layout:
          managed/skill-memory/<name>.jsonl      → skills/<name>/memory/records.jsonl
          managed/skill-memory/audit.jsonl      → skills/<name>/memory/audit.jsonl (split by skill)
          managed/skill-memory/legacy/*.md       → skills/<name>/memory/legacy/*.md (keyword match)
          skills/.redtrace/learning/<name>.jsonl → skills/<name>/memory/records.jsonl

        Notes matching no skill are copied to skills/_legacy-unmatched/.
        Old sources are preserved (not deleted). Idempotent: copy/merge
        only when the destination does not already contain the record.
        """
        skills = [
            (directory.name, directory)
            for directory in sorted(self.paths.skills.iterdir(), key=lambda d: d.name)
            if directory.is_dir() and (directory / "SKILL.md").is_file()
        ]
        old_memory = self.paths.managed / "skill-memory"
        older_learning = self.paths.skills / ".redtrace" / "learning"

        for name, skill_dir in skills:
            new_memory = skill_dir / "memory"
            new_memory.mkdir(parents=True, exist_ok=True)
            for source in (old_memory, older_learning):
                old_records = source / f"{name}.jsonl"
                if old_records.is_file():
                    _merge_jsonl_by_digest(
                        old_records, new_memory / "records.jsonl"
                    )
            old_audit = old_memory / "audit.jsonl"
            if old_audit.is_file():
                _merge_audit_by_skill(
                    old_audit, new_memory / "audit.jsonl", name
                )

        self._distribute_legacy_notes(skills, old_memory)

    def _distribute_legacy_notes(
        self,
        skills: list[tuple[str, Path]],
        old_memory: Path,
    ) -> None:
        """Distribute curated legacy .md notes to matching skills' memory/legacy/.

        Uses the same keyword-matching logic as skill_cli._legacy_notes:
        a note matches a skill when the skill name (or hyphen→space variant)
        appears in the note text. A note may match multiple skills. Notes
        matching no skill are copied to skills/_legacy-unmatched/ so nothing
        is silently lost. Notes are deduplicated by content, not filename:
        identical content is processed once, while same-name/different-content
        conflicts keep both copies (the second gets a content-hash suffix).
        A MIGRATION.md report is written alongside.
        """
        bundled_legacy = self.paths.root / "redtrace" / "skill-memory" / "legacy"
        unmatched_dir = self.paths.skills / "_legacy-unmatched"
        unmatched_dir.mkdir(parents=True, exist_ok=True)
        skill_names = [name for name, _ in skills]
        report_entries: list[tuple[str, list[str]]] = []
        seen_content: set[str] = set()

        for source_legacy in (bundled_legacy, old_memory / "legacy"):
            if not source_legacy.is_dir():
                continue
            for path in sorted(source_legacy.glob("*.md")):
                if path.name.startswith("_"):
                    continue
                try:
                    content_hash = hashlib.sha256(path.read_bytes()).hexdigest()
                    text = path.read_text(encoding="utf-8", errors="replace")
                except OSError:
                    continue
                if content_hash in seen_content:
                    continue
                seen_content.add(content_hash)
                lowered = text.lower()
                matched: list[str] = []
                for skill_name in skill_names:
                    terms = {skill_name, skill_name.replace("-", " ")}
                    if any(term in lowered for term in terms):
                        dest = (
                            self.paths.skills
                            / skill_name
                            / "memory"
                            / "legacy"
                            / path.name
                        )
                        _copy_note_dedup(path, dest, content_hash)
                        if skill_name not in matched:
                            matched.append(skill_name)
                if not matched:
                    _copy_note_dedup(path, unmatched_dir / path.name, content_hash)
                report_entries.append((path.name, matched))

        report_path = unmatched_dir / "MIGRATION.md"
        lines = [
            "# Legacy Notes Migration Report",
            "",
            "Curated legacy notes distributed from `redtrace/skill-memory/legacy/`",
            "to per-skill `memory/legacy/` directories by keyword matching.",
            "",
            "## Distributed to skills",
            "",
        ]
        for note, matched in sorted(report_entries):
            if matched:
                lines.append(f"- `{note}` → {', '.join(matched)}")
        lines.extend(["", "## Unmatched (no skill name keyword found)", ""])
        for note, matched in sorted(report_entries):
            if not matched:
                lines.append(f"- `{note}`")
        report_content = "\n".join(lines) + "\n"
        if not report_path.is_file() or report_path.read_text(encoding="utf-8") != report_content:
            atomic_write_text(report_path, report_content)

    def _sync_mcp_command_availability(
        self, records: list[McpRecord]
    ) -> list[McpRecord]:
        """Auto-disable stdio MCP servers whose command is not installed.

        Container execution resolves commands inside the Worker image, so the
        host-side availability check only applies to local execution. Records
        disabled automatically are re-enabled once the command reappears;
        manual disables are never overridden.
        """
        if self.execution != "local":
            return [record for record in records if record.enabled]
        usable: list[McpRecord] = []
        for record in records:
            command = record.config.get("command")
            marker = record.config.get(_AUTO_DISABLED_MARKER)
            needs_check = (
                isinstance(command, str)
                and command
                and not Path(command).is_absolute()
            )
            available = (
                shutil.which(command) is not None if needs_check else True
            )
            if needs_check and not available and record.enabled:
                config = dict(record.config)
                config["enabled"] = False
                config[_AUTO_DISABLED_MARKER] = _AUTO_DISABLED_REASON
                self._store.write_mcp(record.name, config)
                LOG.warning(
                    "auto-disabled MCP %s: command %r is not installed",
                    record.name,
                    command,
                )
                continue
            if (
                needs_check
                and available
                and not record.enabled
                and marker == _AUTO_DISABLED_REASON
            ):
                config = dict(record.config)
                config["enabled"] = True
                config.pop(_AUTO_DISABLED_MARKER, None)
                record = self._store.write_mcp(record.name, config)
                LOG.info("re-enabled MCP %s: command %r is available", record.name, command)
            if record.enabled:
                usable.append(record)
        return usable

    def _capability_signature(self) -> tuple[int, ...]:
        watched = (
            self.paths.skills,
            self.paths.skills / ".redtrace" / "audit.jsonl",
            self.paths.mcp,
        )
        return tuple(
            path.stat().st_mtime_ns if path.exists() else -1 for path in watched
        )

    def _write_shared_runtime(self, mcp_records: list[McpRecord]) -> None:
        for name, source in _CLI_SOURCES.items():
            target = self.runtime / "bin" / name
            self._write_bytes(target, _workspace_cli_bytes(source), executable=True)
        self._write_text(
            self.runtime / "mcp" / "claude.json",
            build_claude_mcp(mcp_records),
        )
        self._write_text(
            self.runtime / "mcp" / "pi.json",
            build_pi_mcp(mcp_records),
        )
        self._write_text(
            self.runtime / "pi" / "redtrace-provider.js",
            PI_PROVIDER_EXTENSION,
        )

    # -- User-level MCP deployment -----------------------------------------
    # Each agent platform reads MCP config from its own user home directory.
    # This method keeps those files in sync with the canonical mcp/*.json
    # source definitions so that MCP works both inside RedTrace-managed
    # sessions and in standalone agent invocations.

    def _deploy_user_mcp(self, mcp_records: list[McpRecord]) -> None:
        home = Path.home()
        self._deploy_claude_mcp(home, mcp_records)
        self._deploy_pi_mcp(home, mcp_records)
        self._deploy_codex_mcp(home, mcp_records)

    def _deploy_claude_mcp(
        self, home: Path, mcp_records: list[McpRecord]
    ) -> None:
        """Symlink mcp/*.json into ~/.claude/mcpServers/."""
        target_dir = home / ".claude" / "mcpServers"
        target_dir.mkdir(parents=True, exist_ok=True)
        source_dir = self.paths.mcp
        desired: set[str] = set()
        for record in mcp_records:
            if not record.enabled:
                continue
            desired.add(record.name)
            link = target_dir / f"{record.name}.json"
            source = source_dir / f"{record.name}.json"
            if link.is_symlink():
                if link.resolve() == source.resolve():
                    continue
                link.unlink()
            elif link.exists():
                link.unlink()
            link.symlink_to(source)
        # Remove stale symlinks for deleted/disabled servers.
        for child in target_dir.iterdir():
            if child.suffix == ".json" and child.stem not in desired:
                with contextlib.suppress(FileNotFoundError):
                    child.unlink()

    def _deploy_pi_mcp(
        self, home: Path, mcp_records: list[McpRecord]
    ) -> None:
        """Write merged mcp.json for Pi to ~/.pi/agent/mcp.json."""
        target = home / ".pi" / "agent" / "mcp.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        content = build_pi_mcp(mcp_records)
        self._write_text(target, content)

    def _deploy_codex_mcp(
        self, home: Path, mcp_records: list[McpRecord]
    ) -> None:
        """Append managed MCP section to ~/.codex/config.toml."""
        target = home / ".codex" / "config.toml"
        if not target.parent.is_dir():
            return
        existing = target.read_text(encoding="utf-8") if target.is_file() else ""
        cleaned = _strip_marked_block(existing, _CODEX_MCP_START, _CODEX_MCP_END)
        overrides = codex_mcp_overrides(mcp_records)
        # Group per-server entries from the flat -c key=value list.
        servers: dict[str, list[str]] = {}
        key_iter = iter(overrides)
        for flag in key_iter:
            if flag == "-c":
                pair = next(key_iter, "")
                parts = pair.split(".", 2)
                eq = pair.find("=")
                if len(parts) >= 3 and eq > 0:
                    name = parts[1]
                    servers.setdefault(name, []).append(parts[2])
        # Strip existing [mcp_servers.X] sections for servers we are about
        # to redefine so TOML never contains duplicate section headers.
        if servers:
            cleaned = _strip_mcp_server_sections(cleaned, set(servers))
        if not servers:
            content = cleaned.rstrip("\n") + "\n" if cleaned else ""
        else:
            block_lines = [_CODEX_MCP_START]
            for name in sorted(servers):
                block_lines.append(f"[mcp_servers.{name}]")
                for pair in servers[name]:
                    key, value = pair.split("=", 1)
                    block_lines.append(f"{key} = {value}")
                block_lines.append("")
            block_lines.append(_CODEX_MCP_END)
            block = "\n".join(block_lines)
            content = cleaned.rstrip("\n") + "\n\n" + block + "\n"
        atomic_write_text(target, content)

    def _initialize_worker(self, worker: WorkerConfig) -> None:
        if self.execution == "local":
            runtime = self.runtime
            tools = self.runtime / "tools"
            skills_dir = self.paths.skills
        else:
            runtime = Path("/opt/redtrace/runtime")
            tools = Path("/opt/redtrace/tools")
            skills_dir = Path(
                _CONTAINER_SKILL_DIRS.get(worker.type, "/opt/redtrace/skills")
            )

        resource_args = [*self._mcp_args_cache]
        worker.env.update(
            {
                "REDTRACE_ROOT": (
                    str(self.paths.root)
                    if self.execution == "local"
                    else "/opt/redtrace"
                ),
                "REDTRACE_SKILLS_DIR": str(skills_dir),
                "REDTRACE_EXECUTION": self.execution,
                "REDTRACE_MCP_DIR": (
                    str(self.paths.mcp)
                    if self.execution == "local"
                    else "/opt/redtrace/mcp"
                ),
                "REDTRACE_RUNTIME_DIR": str(runtime),
                "REDTRACE_TOOLS_DIR": str(tools),
                "REDTRACE_TOOLS_BIN": str(tools / "bin"),
                "REDTRACE_CLAUDE_MCP_CONFIG": str(runtime / "mcp" / "claude.json"),
                "REDTRACE_PI_MCP_EXTENSION": PI_MCP_EXTENSION,
                "REDTRACE_PI_PROVIDER_EXTENSION": str(
                    runtime / "pi" / "redtrace-provider.js"
                ),
                # Claude, Codex and Pi all discover Skills natively from their
                # user-level Skill directories; per-skill Memory lives under
                # skills/<name>/memory, so no Skill env plumbing is injected.
                # Codex only receives MCP overrides here, suppressed for custom
                # Responses providers that cannot accept namespace tools.
                "REDTRACE_CODEX_RESOURCE_ARGS": json.dumps(resource_args),
            }
        )
        private_cases = os.environ.get("REDTRACE_CODE_AUDIT_PRIVATE_CASES_DIR")
        if private_cases:
            worker.env["REDTRACE_CODE_AUDIT_PRIVATE_CASES_DIR"] = (
                private_cases
                if self.execution == "local"
                else "/opt/redtrace/private-code-audit-cases"
            )

    @staticmethod
    def _write_text(path: Path, content: str) -> None:
        if path.is_file() and path.read_text(encoding="utf-8") == content:
            return
        atomic_write_text(path, content)

    @staticmethod
    def _write_bytes(path: Path, content: bytes, *, executable: bool = False) -> None:
        if not path.is_file() or path.read_bytes() != content:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
        if executable:
            path.chmod(0o755)


def _read_jsonl(path: Path) -> list[dict]:
    """Read a JSONL file, skipping malformed lines."""
    if not path.is_file():
        return []
    records: list[dict] = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(item, dict):
            records.append(item)
    return records


def _write_jsonl(path: Path, records: list[dict]) -> None:
    """Atomically write JSONL records.

    Migration writes are lossless: no retention cap is applied here. The
    runtime retention policy (``learn()`` capping) only applies to new
    writes, never to migrating historical data.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    content = "".join(
        json.dumps(item, ensure_ascii=False, separators=(",", ":")) + "\n"
        for item in records
    )
    atomic_write_text(path, content)


def _record_digest(record: dict) -> str:
    """Return the record's digest, recomputing it when missing.

    Recomputation uses the same canonical form as ``learn()`` —
    ``skill\\nsummary\\nevidence\\ncontent`` — so migrated records remain
    deduplication-compatible with future ``learn()`` writes.
    """
    digest = record.get("digest")
    if isinstance(digest, str) and digest:
        return digest
    canonical = "\n".join(
        str(record.get(key) or "")
        for key in ("skill", "summary", "evidence", "content")
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _audit_digest(record: dict) -> str:
    """Return an audit entry's digest, synthesizing one when missing.

    Audit entries are projections without summary/evidence/content, so a
    missing digest is derived from the full entry JSON purely for
    deduplication — exact duplicates still collapse, unique entries never
    get silently dropped.
    """
    digest = record.get("digest")
    if isinstance(digest, str) and digest:
        return digest
    canonical = json.dumps(record, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _merge_jsonl_by_digest(source: Path, target: Path) -> None:
    """Merge JSONL records from *source* into *target*, deduplicating by digest.

    Records without a digest get one recomputed and written back so legacy
    data survives the migration intact.
    """
    source_records = _read_jsonl(source)
    if not source_records:
        return
    target_records = _read_jsonl(target) if target.is_file() else []
    existing = {r.get("digest") for r in target_records if isinstance(r, dict)}
    merged = list(target_records)
    for record in source_records:
        digest = _record_digest(record)
        if digest in existing:
            continue
        if record.get("digest") != digest:
            record = {**record, "digest": digest}
        merged.append(record)
        existing.add(digest)
    _write_jsonl(target, merged)


def _merge_audit_by_skill(source: Path, target: Path, skill_name: str) -> None:
    """Merge audit entries for *skill_name* from a central source into *target*."""
    source_records = _read_jsonl(source)
    target_records = _read_jsonl(target) if target.is_file() else []
    existing = {r.get("digest") for r in target_records if isinstance(r, dict)}
    merged = list(target_records)
    for record in source_records:
        if not isinstance(record, dict):
            continue
        if record.get("skill") != skill_name:
            continue
        digest = _audit_digest(record)
        if digest in existing:
            continue
        if record.get("digest") != digest:
            record = {**record, "digest": digest}
        merged.append(record)
        existing.add(digest)
    _write_jsonl(target, merged)


def _copy_note_dedup(source: Path, dest: Path, content_hash: str) -> Path:
    """Copy a legacy note, deduplicating by content rather than filename.

    If *dest* already holds identical content the copy is skipped. If *dest*
    exists with different content (a same-name conflict between sources) the
    note is copied as ``<stem>-<hash8>.md`` so neither version is silently
    lost. Returns the destination path actually used.
    """
    if dest.exists():
        try:
            if hashlib.sha256(dest.read_bytes()).hexdigest() == content_hash:
                return dest
        except OSError:
            pass
        dest = dest.with_name(f"{dest.stem}-{content_hash[:8]}{dest.suffix}")
        if dest.exists():
            return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, dest)
    return dest
