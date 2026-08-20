from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
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
from redtrace.paths import RedTracePaths

_CLI_SOURCES = {
    "redtrace-blackboard": "blackboard_cli.py",
    "redtrace-resource": "resource_cli.py",
    "redtrace-context": "context_cli.py",
    "redtrace-skill": "skill_cli.py",
}

LOG = logging.getLogger(__name__)
_AUTO_DISABLED_MARKER = "autoDisabledBy"
_AUTO_DISABLED_REASON = "missing-command"


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
        self._skill_paths_cache: list[Path] = []
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
        skill_paths = self._skill_paths_cache
        for worker in workers:
            if worker.enabled and worker.type != "mock":
                self._initialize_worker(worker, skill_paths)

    def refresh_capabilities(self, workers: list[WorkerConfig]) -> bool:
        """Refresh only after a cheap capability-generation check changes."""
        if not self._refresh_shared_resources(force=False):
            return False
        for worker in workers:
            if worker.enabled and worker.type != "mock":
                self._initialize_worker(worker, self._skill_paths_cache)
        return True

    def _refresh_shared_resources(self, *, force: bool) -> bool:
        signature = self._capability_signature()
        if not force and signature == self._capability_signature_cache:
            return False
        mcp_records = self._sync_mcp_command_availability(self._store.list_mcp())
        self._write_shared_runtime(mcp_records)
        self._mcp_args_cache = codex_mcp_overrides(mcp_records)
        self._skill_paths_cache = self._enabled_skill_paths()
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
                        old_records, new_memory / "records.jsonl", _MIGRATION_RECORD_CAP
                    )
            old_audit = old_memory / "audit.jsonl"
            if old_audit.is_file():
                _merge_audit_by_skill(
                    old_audit, new_memory / "audit.jsonl", name, _MIGRATION_AUDIT_CAP
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
        is silently lost. A MIGRATION.md report is written alongside.
        """
        bundled_legacy = self.paths.root / "redtrace" / "skill-memory" / "legacy"
        unmatched_dir = self.paths.skills / "_legacy-unmatched"
        unmatched_dir.mkdir(parents=True, exist_ok=True)
        skill_names = [name for name, _ in skills]
        distribution: dict[str, list[str]] = {}

        for source_legacy in (bundled_legacy, old_memory / "legacy"):
            if not source_legacy.is_dir():
                continue
            for path in sorted(source_legacy.glob("*.md")):
                if path.name.startswith("_"):
                    continue
                if path.name in distribution:
                    continue
                try:
                    text = path.read_text(encoding="utf-8", errors="replace")
                except OSError:
                    continue
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
                        if not dest.exists():
                            dest.parent.mkdir(parents=True, exist_ok=True)
                            shutil.copy2(path, dest)
                        if skill_name not in matched:
                            matched.append(skill_name)
                if not matched:
                    dest = unmatched_dir / path.name
                    if not dest.exists():
                        shutil.copy2(path, dest)
                distribution[path.name] = matched

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
        for note, matched in sorted(distribution.items()):
            if matched:
                lines.append(f"- `{note}` → {', '.join(matched)}")
        lines.extend(["", "## Unmatched (no skill name keyword found)", ""])
        for note, matched in sorted(distribution.items()):
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
        self._ensure_claude_plugin()

    def _enabled_skill_paths(self) -> list[Path]:
        paths: list[Path] = []
        for directory in sorted(
            self.paths.skills.iterdir(), key=lambda item: item.name
        ):
            if not directory.is_dir() or not (directory / "SKILL.md").is_file():
                continue
            state = directory / ".redtrace.json"
            if state.is_file():
                try:
                    if (
                        json.loads(state.read_text(encoding="utf-8")).get("enabled")
                        is False
                    ):
                        continue
                except (OSError, json.JSONDecodeError, TypeError):
                    pass
            paths.append(directory.resolve())
        return paths

    def _initialize_worker(
        self,
        worker: WorkerConfig,
        local_skill_paths: list[Path],
    ) -> None:
        if self.execution == "local":
            skills = [str(path) for path in local_skill_paths]
            runtime = self.runtime
            tools = self.runtime / "tools"
            plugin_dir = self.runtime / "claude-plugin"
        else:
            skills = [
                f"/opt/redtrace/claude-plugin/skills/{path.name}"
                for path in local_skill_paths
            ]
            runtime = Path("/opt/redtrace/runtime")
            tools = Path("/opt/redtrace/tools")
            plugin_dir = Path("/opt/redtrace/claude-plugin")

        resource_args = [*self._mcp_args_cache]
        worker.env.update(
            {
                "REDTRACE_ROOT": (
                    str(self.paths.root)
                    if self.execution == "local"
                    else "/opt/redtrace"
                ),
                "REDTRACE_SKILLS_DIR": (
                    str(self.paths.skills)
                    if self.execution == "local"
                    else "/opt/redtrace/claude-plugin/skills"
                ),
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
                "REDTRACE_CLAUDE_PLUGIN_DIR": str(plugin_dir),
                "REDTRACE_PI_MCP_EXTENSION": PI_MCP_EXTENSION,
                "REDTRACE_PI_PROVIDER_EXTENSION": str(
                    runtime / "pi" / "redtrace-provider.js"
                ),
                "REDTRACE_SKILL_PATHS": json.dumps(skills),
                # Codex discovers Skills from the canonical project links in
                # .agents/skills. Its driver suppresses MCP only for custom
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

    def _ensure_claude_plugin(self) -> None:
        plugin = self.runtime / "claude-plugin"
        self._write_text(
            plugin / ".claude-plugin" / "plugin.json",
            json.dumps(
                {
                    "name": "redtrace-capabilities",
                    "version": "1.0.0",
                    "description": "RedTrace shared Skills",
                },
                indent=2,
            )
            + "\n",
        )
        link = plugin / "skills"
        target = self.paths.skills.resolve()
        is_junction = bool(hasattr(link, "is_junction") and link.is_junction())
        if link.is_symlink() or is_junction:
            if link.resolve(strict=False) == target:
                return
            if link.is_symlink():
                link.unlink()
            else:
                link.rmdir()
        elif link.exists():
            raise RuntimeError(
                f"refusing to replace non-link Claude Skill directory: {link}"
            )
        try:
            link.symlink_to(
                os.path.relpath(target, start=link.parent),
                target_is_directory=True,
            )
            return
        except OSError:
            if os.name != "nt":
                raise RuntimeError(
                    f"cannot expose shared Skills to Claude without a directory link: {link}"
                )
        completed = subprocess.run(
            ["cmd.exe", "/d", "/c", "mklink", "/J", str(link), str(target)],
            capture_output=True,
            text=True,
            check=False,
        )
        if completed.returncode != 0 or not link.is_dir():
            raise RuntimeError(
                "cannot create the Claude shared-Skills junction; "
                "enable Windows Developer Mode or allow directory junctions"
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


_MIGRATION_RECORD_CAP = 100
_MIGRATION_AUDIT_CAP = 1000


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


def _write_jsonl(path: Path, records: list[dict], cap: int) -> None:
    """Atomically write JSONL records, keeping at most the last ``cap`` entries."""
    path.parent.mkdir(parents=True, exist_ok=True)
    content = "".join(
        json.dumps(item, ensure_ascii=False, separators=(",", ":")) + "\n"
        for item in records[-cap:]
    )
    atomic_write_text(path, content)


def _merge_jsonl_by_digest(source: Path, target: Path, cap: int) -> None:
    """Merge JSONL records from *source* into *target*, deduplicating by digest."""
    source_records = _read_jsonl(source)
    if not source_records:
        return
    target_records = _read_jsonl(target) if target.is_file() else []
    existing = {r.get("digest") for r in target_records if isinstance(r, dict)}
    merged = list(target_records)
    for record in source_records:
        digest = record.get("digest")
        if digest and digest not in existing:
            merged.append(record)
            existing.add(digest)
    _write_jsonl(target, merged, cap)


def _merge_audit_by_skill(
    source: Path, target: Path, skill_name: str, cap: int
) -> None:
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
        digest = record.get("digest")
        if digest and digest not in existing:
            merged.append(record)
            existing.add(digest)
    _write_jsonl(target, merged, cap)
