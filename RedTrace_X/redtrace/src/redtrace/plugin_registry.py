from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from redtrace.capabilities import resolve_capabilities_root, validate_capability_name


SUPPORTED_AGENTS = ("claude", "codex", "pi")


@dataclass(frozen=True, slots=True)
class PluginRecord:
    id: str
    name: str
    kind: str
    version: str
    path: str
    entrypoint: str
    build: str | None
    legacy_protocol: str | None
    enabled: bool
    description: str
    agents: tuple[str, ...]
    config: dict[str, Any]

    def summary(self, root: Path) -> dict[str, Any]:
        plugin_dir = root / self.path
        return {
            "id": self.id,
            "name": self.name,
            "kind": self.kind,
            "version": self.version,
            "path": self.path,
            "entrypoint": self.entrypoint,
            "build": self.build,
            "legacyProtocol": self.legacy_protocol,
            "enabled": self.enabled,
            "description": self.description,
            "agents": list(self.agents),
            "ready": plugin_dir.is_dir() and (plugin_dir / self.entrypoint).is_file(),
            "config": self.config,
        }


class PluginRegistry:
    """Global plugin registry backed by RedTrace/plugins/manifest.json."""

    def __init__(self, root: str | Path | None = None):
        self.root = resolve_capabilities_root(root).resolve()
        self.plugins_dir = self.root / "plugins"
        self.manifest_path = self.plugins_dir / "manifest.json"

    def list_plugins(self) -> list[PluginRecord]:
        payload = self._read_payload()
        records: list[PluginRecord] = []
        seen: set[str] = set()
        for item in payload["plugins"]:
            if not isinstance(item, dict):
                raise ValueError("plugin manifest entries must be objects")
            record = self._record_from(item)
            if record.id in seen:
                raise ValueError(f"duplicate plugin id: {record.id!r}")
            plugin_id = record.id
            seen.add(plugin_id)
            records.append(record)
        return records

    def get_plugin(self, plugin_id: str) -> PluginRecord:
        plugin_id = validate_capability_name(plugin_id)
        for record in self.list_plugins():
            if record.id == plugin_id:
                return record
        raise FileNotFoundError(plugin_id)

    def write_plugin(self, plugin_id: str, config: dict[str, Any]) -> PluginRecord:
        plugin_id = validate_capability_name(plugin_id)
        if not isinstance(config, dict):
            raise TypeError("plugin config must be an object")
        item = dict(config)
        item["id"] = plugin_id
        record = self._record_from(item)
        payload = self._read_payload()
        plugins = [
            entry
            for entry in payload["plugins"]
            if isinstance(entry, dict) and str(entry.get("id") or "").strip() != plugin_id
        ]
        plugins.append(record.config)
        plugins.sort(key=lambda entry: str(entry.get("id") or ""))
        self._write_payload({"schemaVersion": 1, "plugins": plugins})
        return self.get_plugin(plugin_id)

    def set_enabled(self, plugin_id: str, enabled: bool) -> PluginRecord:
        record = self.get_plugin(plugin_id)
        config = dict(record.config)
        config["enabled"] = enabled
        return self.write_plugin(plugin_id, config)

    def delete_plugin(self, plugin_id: str) -> None:
        record = self.get_plugin(plugin_id)
        payload = self._read_payload()
        payload["plugins"] = [
            item
            for item in payload["plugins"]
            if not isinstance(item, dict) or str(item.get("id") or "").strip() != record.id
        ]
        self._write_payload(payload)

    def catalog(self) -> dict[str, Any]:
        plugins = self.list_plugins()
        return {
            "root": str(self.plugins_dir),
            "manifest": str(self.manifest_path),
            "plugins": [plugin.summary(self.root) for plugin in plugins],
        }

    def _read_payload(self) -> dict[str, Any]:
        try:
            payload = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {"schemaVersion": 1, "plugins": []}
        if not isinstance(payload, dict):
            raise ValueError("plugins/manifest.json root must be an object")
        if payload.get("schemaVersion") != 1 or not isinstance(payload.get("plugins"), list):
            raise ValueError("plugins/manifest.json must use schemaVersion 1")
        return payload

    def _write_payload(self, payload: dict[str, Any]) -> None:
        self.plugins_dir.mkdir(parents=True, exist_ok=True)
        temporary = self.manifest_path.with_suffix(".json.tmp")
        temporary.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        os.replace(temporary, self.manifest_path)

    def _record_from(self, item: dict[str, Any]) -> PluginRecord:
        plugin_id = validate_capability_name(str(item.get("id") or "").strip())
        relative_path = str(item.get("path") or "").strip().replace("\\", "/")
        entrypoint = str(item.get("entrypoint") or "").strip().replace("\\", "/")
        if not relative_path or not entrypoint:
            raise ValueError(f"plugin {plugin_id} requires path and entrypoint")

        plugin_dir = (self.root / relative_path).resolve()
        try:
            plugin_dir.relative_to(self.plugins_dir.resolve())
        except ValueError as exc:
            raise ValueError(f"plugin {plugin_id} path escapes RedTrace/plugins") from exc
        entrypoint_path = (plugin_dir / entrypoint).resolve()
        try:
            entrypoint_path.relative_to(plugin_dir)
        except ValueError as exc:
            raise ValueError(f"plugin {plugin_id} entrypoint escapes its plugin directory") from exc

        raw_agents = item.get("agents", list(SUPPORTED_AGENTS))
        if not isinstance(raw_agents, list) or not raw_agents:
            raise ValueError(f"plugin {plugin_id} agents must be a non-empty list")
        agents = tuple(dict.fromkeys(str(agent).strip().lower() for agent in raw_agents))
        if any(agent not in SUPPORTED_AGENTS for agent in agents):
            raise ValueError(
                f"plugin {plugin_id} agents must be selected from {', '.join(SUPPORTED_AGENTS)}"
            )

        normalized = dict(item)
        normalized.update(
            {
                "id": plugin_id,
                "name": str(item.get("name") or plugin_id),
                "kind": str(item.get("kind") or "external"),
                "version": str(item.get("version") or ""),
                "path": relative_path,
                "entrypoint": entrypoint,
                "enabled": bool(item.get("enabled", True)),
                "description": str(item.get("description") or ""),
                "agents": list(agents),
            }
        )
        if not item.get("build"):
            normalized.pop("build", None)
        if not item.get("legacyProtocol"):
            normalized.pop("legacyProtocol", None)

        return PluginRecord(
            id=plugin_id,
            name=normalized["name"],
            kind=normalized["kind"],
            version=normalized["version"],
            path=relative_path,
            entrypoint=entrypoint,
            build=str(item["build"]) if item.get("build") else None,
            legacy_protocol=str(item["legacyProtocol"]) if item.get("legacyProtocol") else None,
            enabled=normalized["enabled"],
            description=normalized["description"],
            agents=agents,
            config=normalized,
        )
