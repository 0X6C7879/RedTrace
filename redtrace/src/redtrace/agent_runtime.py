from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

from redtrace.capabilities import (
    PI_MCP_EXTENSION,
    PI_PROVIDER_EXTENSION,
    CapabilityStore,
    _workspace_cli_bytes,
    build_claude_mcp,
    build_pi_mcp,
    codex_mcp_overrides,
)
from redtrace.config_secrets import atomic_write_text
from redtrace.dispatcher.config import WorkerConfig
from redtrace.native_cli_config import sync_native_cli_config
from redtrace.paths import RedTracePaths, safe_project_key

_CLI_SOURCES = {
    "redtrace-blackboard": "blackboard_cli.py",
    "redtrace-resource": "resource_cli.py",
    "redtrace-skill": "skill_cli.py",
    "redtrace-context": "context_cli.py",
}


class AgentRuntimeManager:
    """Prepare shared capabilities and isolated writable Worker state once."""

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
        self._skill_index_cache: str = ""
        self._mcp_records_cache: list[dict] = []
        self._capability_signature_cache: tuple[int, ...] | None = None

    def initialize(self, workers: list[WorkerConfig]) -> None:
        if not self._shared_initialized:
            self._store.ensure()
            for directory in (
                self.runtime / "bin",
                self.runtime / "mcp",
                self.runtime / "pi",
                self.runtime / "plugins",
                self.paths.workers,
                self.paths.projects,
                self.paths.workspaces,
                self.paths.audit,
            ):
                directory.mkdir(parents=True, exist_ok=True)
            self._shared_initialized = True
        self._refresh_shared_resources(force=self._capability_signature_cache is None)
        skill_paths = self._skill_paths_cache
        mcp_records = self._mcp_records_cache
        mcp_args = codex_mcp_overrides(mcp_records)
        pi_mcp = build_pi_mcp(mcp_records)
        for worker in workers:
            if worker.enabled and worker.type != "mock":
                self._initialize_worker(worker, skill_paths, mcp_args, pi_mcp)

    def refresh_capabilities(self, workers: list[WorkerConfig]) -> bool:
        """Refresh only after a cheap capability-generation check changes."""
        if not self._refresh_shared_resources(force=False):
            return False
        mcp_args = codex_mcp_overrides(self._mcp_records_cache)
        pi_mcp = build_pi_mcp(self._mcp_records_cache)
        for worker in workers:
            if worker.enabled and worker.type != "mock":
                self._initialize_worker(
                    worker,
                    self._skill_paths_cache,
                    mcp_args,
                    pi_mcp,
                )
        return True

    def _refresh_shared_resources(self, *, force: bool) -> bool:
        signature = self._capability_signature()
        if not force and signature == self._capability_signature_cache:
            return False
        self._write_shared_runtime()
        self._skill_paths_cache = self._enabled_skill_paths()
        self._skill_index_cache = self._build_skill_index(self._skill_paths_cache)
        self._mcp_records_cache = self._store.list_mcp()
        self._capability_signature_cache = self._capability_signature()
        return True

    def _capability_signature(self) -> tuple[int, ...]:
        watched = (
            self.paths.skills,
            self.paths.skills / ".redtrace" / "audit.jsonl",
            self.paths.mcp,
            self.paths.plugins / "manifest.json",
        )
        return tuple(
            path.stat().st_mtime_ns if path.exists() else -1 for path in watched
        )

    def _write_shared_runtime(self) -> None:
        for name, source in _CLI_SOURCES.items():
            target = self.runtime / "bin" / name
            self._write_bytes(target, _workspace_cli_bytes(source), executable=True)
        self._write_text(
            self.runtime / "mcp" / "claude.json",
            build_claude_mcp(self._store.list_mcp()),
        )
        self._write_text(
            self.runtime / "pi" / "redtrace-provider.js",
            PI_PROVIDER_EXTENSION,
        )
        manifest = self.paths.plugins / "manifest.json"
        plugins: list[dict] = []
        if manifest.is_file():
            payload = json.loads(manifest.read_text(encoding="utf-8"))
            if isinstance(payload, dict) and isinstance(payload.get("plugins"), list):
                plugins = [
                    item
                    for item in payload["plugins"]
                    if isinstance(item, dict) and item.get("enabled", True)
                ]
        self._write_text(
            self.runtime / "plugins" / "catalog.json",
            json.dumps(
                {
                    "schemaVersion": 1,
                    "source": str(self.paths.plugins),
                    "agents": ["claude", "codex", "pi"],
                    "plugins": plugins,
                },
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            )
            + "\n",
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
    def _build_skill_index(skill_paths: list[Path]) -> str:
        """Build a compact skill index from SKILL.md frontmatter at startup."""
        lines: list[str] = []
        for path in skill_paths:
            skill_md = path / "SKILL.md"
            try:
                text = skill_md.read_text(encoding="utf-8")
            except OSError:
                continue
            name = path.name
            description = ""
            # Parse YAML frontmatter between --- delimiters.
            if text.startswith("---"):
                parts = text.split("---", 2)
                if len(parts) >= 3:
                    frontmatter = parts[1]
                    for line in frontmatter.splitlines():
                        stripped = line.strip()
                        if stripped.startswith("name:"):
                            name = stripped[5:].strip().strip("'\"") or path.name
                        elif stripped.startswith("description:"):
                            description = stripped[12:].strip().strip("'\"")
            entry = f"- {name}: {description}" if description else f"- {name}"
            lines.append(entry)
        return "\n".join(lines)

    def _initialize_worker(
        self,
        worker: WorkerConfig,
        local_skill_paths: list[Path],
        mcp_args: list[str],
        pi_mcp: str,
    ) -> None:
        worker_key = safe_project_key(worker.name)
        worker_root = self.paths.workers / worker.type / worker_key
        for relative in ("sessions", "cache", "logs"):
            (worker_root / relative).mkdir(parents=True, exist_ok=True)
        self._seed_login_state(worker_root, worker.type)
        sync_native_cli_config(worker_root, worker)
        if worker.type == "pi":
            self._write_text(worker_root / ".pi" / "agent" / "mcp.json", pi_mcp)

        if self.execution == "local":
            skills = [str(path) for path in local_skill_paths]
            runtime = self.runtime
            worker_home = worker_root
            plugin_dir = self.runtime / "claude-plugin"
        else:
            skills = [
                f"/opt/redtrace/claude-plugin/skills/{path.name}"
                for path in local_skill_paths
            ]
            runtime = Path("/opt/redtrace/runtime")
            worker_home = Path("/opt/redtrace/workers") / worker.type / worker_key
            plugin_dir = Path("/opt/redtrace/claude-plugin")

        resource_args = [
            *mcp_args,
            "-c",
            self._codex_skills_config(skills),
            "-c",
            f"sqlite_home={json.dumps(str(worker_home / 'sessions'))}",
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
                "REDTRACE_MCP_DIR": (
                    str(self.paths.mcp)
                    if self.execution == "local"
                    else "/opt/redtrace/mcp"
                ),
                "REDTRACE_PLUGINS_DIR": (
                    str(self.paths.plugins)
                    if self.execution == "local"
                    else "/opt/redtrace/plugins"
                ),
                "REDTRACE_RUNTIME_DIR": str(runtime),
                "REDTRACE_PLUGIN_CATALOG": str(runtime / "plugins" / "catalog.json"),
                "REDTRACE_CLAUDE_MCP_CONFIG": str(runtime / "mcp" / "claude.json"),
                "REDTRACE_CLAUDE_PLUGIN_DIR": str(plugin_dir),
                "REDTRACE_PI_MCP_EXTENSION": PI_MCP_EXTENSION,
                "REDTRACE_PI_PROVIDER_EXTENSION": str(
                    runtime / "pi" / "redtrace-provider.js"
                ),
                "REDTRACE_PI_SESSION_DIR": str(worker_home / "sessions"),
                "REDTRACE_SKILL_PATHS": json.dumps(skills),
                "REDTRACE_SKILL_INDEX": self._skill_index_cache,
                "REDTRACE_CODEX_RESOURCE_ARGS": json.dumps(resource_args),
            }
        )
        if worker.type == "claudecode":
            worker.env["CLAUDE_CONFIG_DIR"] = str(worker_home / ".claude")
        elif worker.type == "codex":
            worker.env["CODEX_HOME"] = str(worker_home / ".codex")
        elif worker.type == "pi":
            worker.env["PI_CODING_AGENT_DIR"] = str(worker_home / ".pi" / "agent")
            worker.env["PI_CODING_AGENT_SESSION_DIR"] = str(worker_home / "sessions")

    @staticmethod
    def _codex_skills_config(skills: list[str]) -> str:
        values = ",".join(
            f"{{path={json.dumps(path)},enabled=true}}" for path in skills
        )
        return f"skills.config=[{values}]"

    def _seed_login_state(self, worker_root: Path, worker_type: str) -> None:
        marker = worker_root / ".initialized"
        if marker.exists():
            return
        source_home = Path.home()
        candidates: dict[str, tuple[str, ...]] = {
            "claudecode": (
                ".claude/settings.json",
                ".claude/.credentials.json",
            ),
            "codex": (".codex/config.toml", ".codex/auth.json"),
            "pi": (
                ".pi/agent/settings.json",
                ".pi/agent/models.json",
                ".pi/agent/auth.json",
            ),
        }
        for relative in candidates.get(worker_type, ()):
            source = source_home / relative
            target = worker_root / relative
            if source.is_file() and not target.exists():
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
        self._write_text(marker, "initialized\n")

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
