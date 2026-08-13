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
            plugins_dir=paths.plugins,
        )
        self._shared_initialized = False
        self._skill_paths_cache: list[Path] = []
        self._mcp_args_cache: list[str] = []
        self._global_instructions_cache = ""
        self._capability_signature_cache: tuple[int, ...] | None = None

    def initialize(self, workers: list[WorkerConfig]) -> None:
        if not self._shared_initialized:
            self._store.ensure()
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
        self._global_instructions_cache = self._load_global_instructions(
            self._skill_paths_cache
        )
        self._capability_signature_cache = self._capability_signature()
        return True

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
            self.paths.skills / "route-skills" / "REDTRACE_RULES.md",
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

    @staticmethod
    def _load_global_instructions(skill_paths: list[Path]) -> str:
        for skill_path in skill_paths:
            rules = skill_path / "REDTRACE_RULES.md"
            if rules.is_file():
                return rules.read_text(encoding="utf-8")
        return ""

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

        resource_args = [
            *self._mcp_args_cache,
            "-c",
            self._codex_skills_config(skills),
        ]
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
        if self._global_instructions_cache:
            worker.env["REDTRACE_GLOBAL_INSTRUCTIONS"] = (
                self._global_instructions_cache
            )
        else:
            worker.env.pop("REDTRACE_GLOBAL_INSTRUCTIONS", None)

    @staticmethod
    def _codex_skills_config(skills: list[str]) -> str:
        values = ",".join(
            f"{{path={json.dumps(path)},enabled=true}}" for path in skills
        )
        return f"skills.config=[{values}]"

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
