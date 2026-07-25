from __future__ import annotations

import hashlib
import io
import json
import os
import re
import shutil
import tarfile
import tempfile
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
MANIFEST_PATH = ".redtrace/capabilities.json"
BLACKBOARD_CLI_PATH = ".redtrace/bin/redtrace-blackboard"
CLAUDE_MCP_PATH = ".redtrace/mcp/claude.json"
PI_MCP_PATH = ".pi/mcp.json"
PI_MCP_EXTENSION = "npm:pi-mcp-extension@1.5.0"


def resolve_capabilities_root(explicit: str | Path | None = None) -> Path:
    if explicit:
        return Path(explicit).expanduser().resolve()
    configured = os.environ.get("REDTRACE_CAPABILITIES_ROOT")
    if configured:
        return Path(configured).expanduser().resolve()

    cwd = Path.cwd().resolve()
    if (cwd / "skills").is_dir() or (cwd / "mcp").is_dir():
        return cwd

    source_root = Path(__file__).resolve().parents[3]
    if (source_root / "skills").is_dir() or (source_root / "mcp").is_dir():
        return source_root
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


def _frontmatter(content: str) -> dict[str, str]:
    if not content.startswith("---"):
        return {}
    parts = content.split("---", 2)
    if len(parts) < 3:
        return {}
    values: dict[str, str] = {}
    for line in parts[1].splitlines():
        key, separator, value = line.partition(":")
        if separator and key.strip() in {"name", "description"}:
            values[key.strip()] = value.strip().strip("\"'")
    return values


@dataclass(frozen=True, slots=True)
class SkillRecord:
    name: str
    description: str
    enabled: bool
    content: str
    files: tuple[str, ...]

    def summary(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "enabled": self.enabled,
            "files": list(self.files),
        }


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
            "agents": ["claude", "codex", "pi"],
            "config": self.config,
        }


class CapabilityStore:
    def __init__(self, root: str | Path | None = None):
        self.root = resolve_capabilities_root(root)
        self.skills_dir = self.root / "skills"
        self.mcp_dir = self.root / "mcp"

    def ensure(self) -> None:
        self.skills_dir.mkdir(parents=True, exist_ok=True)
        self.mcp_dir.mkdir(parents=True, exist_ok=True)

    def list_skills(self) -> list[SkillRecord]:
        self.ensure()
        records: list[SkillRecord] = []
        for directory in sorted(self.skills_dir.iterdir(), key=lambda item: item.name):
            if not directory.is_dir() or not NAME_PATTERN.fullmatch(directory.name):
                continue
            entrypoint = directory / "SKILL.md"
            if not entrypoint.is_file():
                continue
            content = entrypoint.read_text(encoding="utf-8")
            metadata = _frontmatter(content)
            state_path = directory / ".redtrace.json"
            enabled = True
            if state_path.is_file():
                try:
                    enabled = bool(json.loads(state_path.read_text(encoding="utf-8")).get("enabled", True))
                except (json.JSONDecodeError, OSError):
                    enabled = True
            files = tuple(
                str(path.relative_to(directory)).replace("\\", "/")
                for path in sorted(directory.rglob("*"))
                if path.is_file() and path.name != ".redtrace.json"
            )
            records.append(
                SkillRecord(
                    name=directory.name,
                    description=metadata.get("description", ""),
                    enabled=enabled,
                    content=content,
                    files=files,
                )
            )
        return records

    def get_skill(self, name: str) -> SkillRecord:
        name = validate_capability_name(name)
        for record in self.list_skills():
            if record.name == name:
                return record
        raise FileNotFoundError(name)

    def write_skill(self, name: str, content: str, *, enabled: bool = True) -> SkillRecord:
        name = validate_capability_name(name)
        if not content.strip():
            raise ValueError("SKILL.md content must not be empty")
        directory = self.skills_dir / name
        _atomic_write(directory / "SKILL.md", content.rstrip() + "\n")
        _atomic_write(directory / ".redtrace.json", json.dumps({"enabled": enabled}, separators=(",", ":")) + "\n")
        return self.get_skill(name)

    def set_skill_enabled(self, name: str, enabled: bool) -> SkillRecord:
        record = self.get_skill(name)
        _atomic_write(
            self.skills_dir / record.name / ".redtrace.json",
            json.dumps({"enabled": enabled}, separators=(",", ":")) + "\n",
        )
        return self.get_skill(name)

    def delete_skill(self, name: str) -> None:
        record = self.get_skill(name)
        shutil.rmtree(self.skills_dir / record.name)

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
    result = _common_mcp_config(record.config)
    overrides = record.config.get("agents", {})
    if isinstance(overrides, dict) and isinstance(overrides.get(agent), dict):
        result.update(overrides[agent])

    transport = str(result.get("transport") or result.get("type") or "").lower()
    if agent == "claude":
        if transport in {"streamable-http", "http"} or result.get("url"):
            result["type"] = "http"
        elif transport == "sse":
            result["type"] = "sse"
        else:
            result["type"] = "stdio"
        result.pop("transport", None)
        result.pop("lifecycle", None)
    elif agent == "pi":
        if transport == "http":
            result["transport"] = "streamable-http"
        elif not transport:
            result["transport"] = "stdio"
        result.pop("type", None)
    elif agent == "codex":
        result.pop("type", None)
        result.pop("transport", None)
        result.pop("lifecycle", None)
        if "headers" in result and "http_headers" not in result:
            result["http_headers"] = result.pop("headers")
    return result


def build_claude_mcp(records: Iterable[McpRecord]) -> str:
    servers = {
        record.name: mcp_config_for(record, "claude")
        for record in records
        if record.enabled
    }
    return json.dumps({"mcpServers": servers}, ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def build_pi_mcp(records: Iterable[McpRecord]) -> str:
    servers = {
        record.name: mcp_config_for(record, "pi")
        for record in records
        if record.enabled
    }
    payload = {
        "settings": {"toolPrefix": "mcp"},
        "mcpServers": servers,
    }
    return json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def _toml_literal(value: Any) -> str:
    if value is None:
        raise ValueError("null is not supported by Codex config")
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return "[" + ",".join(_toml_literal(item) for item in value) + "]"
    if isinstance(value, dict):
        entries = (
            f"{json.dumps(str(key), ensure_ascii=False)}={_toml_literal(item)}"
            for key, item in value.items()
            if item is not None
        )
        return "{" + ",".join(entries) + "}"
    raise ValueError(f"unsupported Codex config value: {type(value).__name__}")


def codex_mcp_overrides(records: Iterable[McpRecord]) -> list[str]:
    overrides: list[str] = []
    for record in records:
        config = mcp_config_for(record, "codex")
        config["enabled"] = record.enabled
        for key, value in config.items():
            if value is None:
                continue
            overrides.extend(["-c", f"mcp_servers.{record.name}.{key}={_toml_literal(value)}"])
    return overrides


def workspace_payload(store: CapabilityStore) -> tuple[str, dict[str, bytes]]:
    skills = store.list_skills()
    mcp_records = store.list_mcp()
    files: dict[str, bytes] = {}
    enabled_names: list[str] = []
    for skill in skills:
        if not skill.enabled:
            continue
        enabled_names.append(skill.name)
        source_dir = store.skills_dir / skill.name
        for source in sorted(source_dir.rglob("*")):
            if not source.is_file() or source.name == ".redtrace.json":
                continue
            relative = source.relative_to(source_dir)
            content = source.read_bytes()
            for prefix in (".agents/skills", ".claude/skills"):
                target = PurePosixPath(prefix) / skill.name / PurePosixPath(relative.as_posix())
                files[str(target)] = content

    files[CLAUDE_MCP_PATH] = build_claude_mcp(mcp_records).encode()
    files[PI_MCP_PATH] = build_pi_mcp(mcp_records).encode()
    files[BLACKBOARD_CLI_PATH] = Path(__file__).with_name("blackboard_cli.py").read_bytes()
    digest_builder = hashlib.sha256()
    for relative, content in sorted(files.items()):
        digest_builder.update(relative.encode())
        digest_builder.update(content)
    manifest = {
        "digest": digest_builder.hexdigest(),
        "skills": enabled_names,
        "managedFiles": [BLACKBOARD_CLI_PATH, CLAUDE_MCP_PATH, PI_MCP_PATH],
    }
    files[MANIFEST_PATH] = (json.dumps(manifest, separators=(",", ":")) + "\n").encode()
    return manifest["digest"], files


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
    digest, files = workspace_payload(store)
    previous = _read_manifest(workspace)
    if previous.get("digest") == digest:
        return digest

    for name in previous.get("skills", []):
        if not isinstance(name, str) or not NAME_PATTERN.fullmatch(name):
            continue
        for prefix in (".agents/skills", ".claude/skills"):
            shutil.rmtree(workspace / prefix / name, ignore_errors=True)
    for relative, content in files.items():
        target = workspace / Path(relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        if relative == BLACKBOARD_CLI_PATH:
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
            info.mode = 0o755 if relative == BLACKBOARD_CLI_PATH else 0o644
            info.uid = 1000
            info.gid = 1000
            archive.addfile(info, io.BytesIO(content))
    return stream.getvalue()
