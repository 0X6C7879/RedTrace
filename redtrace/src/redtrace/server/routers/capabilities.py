from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path, PurePosixPath
from typing import Any

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field

from redtrace.capabilities import CapabilityStore, SkillConflictError, _frontmatter

router = APIRouter(prefix="/capabilities", tags=["capabilities"])


class SkillWrite(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    content: str = Field(min_length=1)
    enabled: bool = True


class SkillUpdate(BaseModel):
    content: str = Field(min_length=1)
    enabled: bool = True
    expected_revision: str | None = None


class McpWrite(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    config: dict[str, Any]


class McpUpdate(BaseModel):
    config: dict[str, Any]


class PluginWrite(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    config: dict[str, Any]


class PluginUpdate(BaseModel):
    config: dict[str, Any]


class EnabledUpdate(BaseModel):
    enabled: bool
    expected_revision: str | None = None


class RollbackRequest(BaseModel):
    expected_revision: str | None = None


def _store() -> CapabilityStore:
    return CapabilityStore()


def _not_found(kind: str, name: str) -> HTTPException:
    return HTTPException(404, f"{kind} not found: {name}")


def _skill_payload(record, *, include_content: bool = False) -> dict[str, Any]:
    payload = record.summary()
    if include_content:
        payload["content"] = record.content
    return payload


def _nested_skill_payload(parent: str, root: Path, entrypoint: Path) -> dict[str, Any]:
    content = entrypoint.read_text(encoding="utf-8")
    relative = entrypoint.relative_to(root).as_posix()
    metadata = _frontmatter(content)
    return {
        "key": f"{parent}:{relative}",
        "parent": parent,
        "path": relative,
        "name": metadata.get("name") or entrypoint.parent.name,
        "description": metadata.get("description", ""),
        "depth": len(PurePosixPath(relative).parts) - 1,
        "nested": True,
    }


def _nested_skill_path(parent: str, entry_path: str) -> tuple[Path, Path]:
    store = _store()
    store.get_skill(parent, include_files=False)
    root = (store.skills_dir / parent).resolve()
    relative = PurePosixPath(entry_path)
    if (
        relative.is_absolute()
        or ".." in relative.parts
        or relative.name != "SKILL.md"
    ):
        raise HTTPException(400, "invalid nested Skill path")
    entrypoint = root.joinpath(*relative.parts).resolve()
    try:
        entrypoint.relative_to(root)
    except ValueError as exc:
        raise HTTPException(400, "nested Skill path escapes its package") from exc
    if not entrypoint.is_file():
        raise _not_found("nested Skill", entry_path)
    return root, entrypoint


# Directories that never contain Skills; pruning keeps package walks fast.
_NESTED_SCAN_IGNORES = frozenset(
    {
        ".git",
        ".redtrace",
        ".venv",
        ".runtime",
        ".pytest_cache",
        ".ruff_cache",
        "__pycache__",
        "node_modules",
    }
)
_SKILL_ENTRIES_CACHE_SECONDS = 1.0
_skill_entries_cache_lock = threading.Lock()
_skill_entries_cache: dict[str, tuple[float, tuple[dict[str, Any], ...]]] = {}


def _invalidate_skill_entries_cache() -> None:
    with _skill_entries_cache_lock:
        _skill_entries_cache.clear()


def _iter_nested_entrypoints(root_dir: Path) -> list[Path]:
    found: list[Path] = []
    for directory, subdirs, names in os.walk(root_dir):
        subdirs[:] = sorted(
            name for name in subdirs if name not in _NESTED_SCAN_IGNORES
        )
        if Path(directory) != root_dir and "SKILL.md" in names:
            found.append(Path(directory) / "SKILL.md")
    return sorted(found)


def _build_skill_entries(store: CapabilityStore) -> list[dict[str, Any]]:
    """One walk per package; nested entries inherit enabled from their root."""
    entries: list[dict[str, Any]] = []
    for record in store.list_skills():
        root_dir = store.skills_dir / record.name
        entries.append(
            {
                "key": record.name,
                "name": record.name,
                "description": record.description,
                "parent": "",
                "path": "SKILL.md",
                "nested": False,
                "readonly": False,
                "enabled": record.enabled,
                "depth": 0,
                "trust": record.trust,
            }
        )
        for entrypoint in _iter_nested_entrypoints(root_dir):
            try:
                content = entrypoint.read_text(encoding="utf-8")
            except OSError:
                continue
            metadata = _frontmatter(content)
            relative = entrypoint.relative_to(root_dir).as_posix()
            name = (metadata.get("name") or "").strip()
            entries.append(
                {
                    "key": f"{record.name}:{relative}",
                    "name": name or entrypoint.parent.name,
                    "description": (metadata.get("description") or "").strip(),
                    "parent": record.name,
                    "path": relative,
                    "nested": True,
                    "readonly": True,
                    "enabled": record.enabled,
                    "depth": len(PurePosixPath(relative).parts) - 1,
                }
            )
    return entries


@router.get("")
def get_capabilities():
    store = _store()
    skill_entries = list_skill_entries()
    servers = store.list_mcp()
    return {
        "root": str(store.root),
        "skillsDir": str(store.skills_dir),
        "mcpDir": str(store.mcp_dir),
        "skills": {
            "total": len(skill_entries),
            "enabled": sum(entry["enabled"] for entry in skill_entries),
        },
        "mcp": {"total": len(servers), "enabled": sum(server.enabled for server in servers)},
        "agents": [
            {
                "id": "claude",
                "skills": str(store.skills_dir),
                "runtimeSnapshot": None,
                "mcp": "--mcp-config",
            },
            {
                "id": "codex",
                "skills": str(store.skills_dir),
                "runtimeSnapshot": None,
                "mcp": "mcp_servers config",
            },
            {
                "id": "pi",
                "skills": str(store.skills_dir),
                "runtimeSnapshot": None,
                "mcp": "worker-managed mcp.json",
            },
        ],
    }


@router.get("/skills")
def list_skills():
    return [_skill_payload(record) for record in _store().list_skills()]


@router.get("/skill-entries")
def list_skill_entries():
    """One scan returns every displayable Skill: roots plus nested entries.

    The result is cached briefly so concurrent page loads and the status
    endpoint share a single directory walk; mutations invalidate it.
    """
    store = _store()
    store.ensure()
    cache_key = str(store.skills_dir)
    now = time.monotonic()
    with _skill_entries_cache_lock:
        cached = _skill_entries_cache.get(cache_key)
        if cached is not None and now - cached[0] < _SKILL_ENTRIES_CACHE_SECONDS:
            return list(cached[1])
    entries = _build_skill_entries(store)
    with _skill_entries_cache_lock:
        _skill_entries_cache[cache_key] = (time.monotonic(), tuple(entries))
    return entries


@router.get("/skills/{name}/entries")
def list_nested_skills(name: str):
    store = _store()
    try:
        store.get_skill(name, include_files=False)
    except FileNotFoundError:
        raise _not_found("skill", name) from None
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    root = store.skills_dir / name
    return [
        _nested_skill_payload(name, root, entrypoint)
        for entrypoint in sorted(root.rglob("SKILL.md"))
        if entrypoint.parent != root
    ]


@router.get("/skills/{name}/entries/{entry_path:path}")
def get_nested_skill(name: str, entry_path: str):
    try:
        root, entrypoint = _nested_skill_path(name, entry_path)
        return {
            **_nested_skill_payload(name, root, entrypoint),
            "content": entrypoint.read_text(encoding="utf-8"),
        }
    except FileNotFoundError:
        raise _not_found("skill", name) from None
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get("/skills/{name}")
def get_skill(name: str):
    try:
        return _skill_payload(_store().get_skill(name), include_content=True)
    except FileNotFoundError:
        raise _not_found("skill", name) from None
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/skills", status_code=201)
def create_skill(body: SkillWrite):
    store = _store()
    _invalidate_skill_entries_cache()
    try:
        store.get_skill(body.name)
    except FileNotFoundError:
        pass
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    else:
        raise HTTPException(409, f"skill already exists: {body.name}")
    try:
        return _skill_payload(
            store.write_skill(
                body.name,
                body.content,
                enabled=body.enabled,
                trust="provisional",
                successful_reuses=0,
                provisional_task="manual:api",
            ),
            include_content=True,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.put("/skills/{name}")
def update_skill(name: str, body: SkillUpdate):
    store = _store()
    _invalidate_skill_entries_cache()
    try:
        current = store.get_skill(name)
        content_changed = current.content.rstrip() != body.content.rstrip()
        return _skill_payload(
            store.write_skill(
                name,
                body.content,
                enabled=body.enabled,
                expected_revision=body.expected_revision,
                trust="provisional" if content_changed else current.trust,
                successful_reuses=(
                    0 if content_changed else current.successful_reuses
                ),
                failure_count=current.failure_count,
                provisional_task=(
                    "manual:api" if content_changed else current.provisional_task
                ),
            ),
            include_content=True,
        )
    except FileNotFoundError:
        raise _not_found("skill", name) from None
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except SkillConflictError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.patch("/skills/{name}/enabled")
def set_skill_enabled(name: str, body: EnabledUpdate):
    try:
        store = _store()
        _invalidate_skill_entries_cache()
        record = store.get_skill(name)
        return _skill_payload(
            store.write_skill(
                name,
                record.content,
                enabled=body.enabled,
                expected_revision=body.expected_revision or record.revision,
                reason=f"set enabled={body.enabled}",
                action="toggle",
            ),
            include_content=True,
        )
    except FileNotFoundError:
        raise _not_found("skill", name) from None
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except SkillConflictError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.delete("/skills/{name}", status_code=204)
def delete_skill(name: str):
    try:
        _invalidate_skill_entries_cache()
        _store().delete_skill(name)
    except FileNotFoundError:
        raise _not_found("skill", name) from None
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return Response(status_code=204)


@router.get("/skills/{name}/versions")
def list_skill_versions(name: str):
    try:
        _store().get_skill(name, include_files=False)
        return _store().list_skill_versions(name)
    except FileNotFoundError:
        raise _not_found("skill", name) from None
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/skills/{name}/rollback/{version}")
def rollback_skill(name: str, version: int, body: RollbackRequest):
    try:
        _invalidate_skill_entries_cache()
        return _skill_payload(
            _store().rollback_skill(
                name,
                version,
                expected_revision=body.expected_revision,
            ),
            include_content=True,
        )
    except FileNotFoundError:
        raise _not_found("skill version", f"{name}@{version}") from None
    except SkillConflictError as exc:
        raise HTTPException(409, str(exc)) from exc
    except (ValueError, json.JSONDecodeError) as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get("/mcp")
def list_mcp():
    try:
        return [record.summary() for record in _store().list_mcp()]
    except ValueError as exc:
        raise HTTPException(500, str(exc)) from exc


@router.get("/mcp/{name}")
def get_mcp(name: str):
    try:
        return _store().get_mcp(name).summary()
    except FileNotFoundError:
        raise _not_found("MCP server", name) from None
    except (ValueError, TypeError) as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/mcp", status_code=201)
def create_mcp(body: McpWrite):
    store = _store()
    try:
        store.get_mcp(body.name)
    except FileNotFoundError:
        pass
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    else:
        raise HTTPException(409, f"MCP server already exists: {body.name}")
    try:
        return store.write_mcp(body.name, body.config).summary()
    except (ValueError, TypeError) as exc:
        raise HTTPException(400, str(exc)) from exc


@router.put("/mcp/{name}")
def update_mcp(name: str, body: McpUpdate):
    store = _store()
    try:
        store.get_mcp(name)
        return store.write_mcp(name, body.config).summary()
    except FileNotFoundError:
        raise _not_found("MCP server", name) from None
    except (ValueError, TypeError) as exc:
        raise HTTPException(400, str(exc)) from exc


@router.patch("/mcp/{name}/enabled")
def set_mcp_enabled(name: str, body: EnabledUpdate):
    try:
        return _store().set_mcp_enabled(name, body.enabled).summary()
    except FileNotFoundError:
        raise _not_found("MCP server", name) from None
    except (ValueError, TypeError) as exc:
        raise HTTPException(400, str(exc)) from exc


@router.delete("/mcp/{name}", status_code=204)
def delete_mcp(name: str):
    try:
        _store().delete_mcp(name)
    except FileNotFoundError:
        raise _not_found("MCP server", name) from None
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return Response(status_code=204)


@router.get("/plugins")
def list_plugins():
    return []


@router.get("/plugins/{plugin_id}")
def get_plugin(plugin_id: str):
    raise HTTPException(404, f"plugin not found: {plugin_id}")


@router.post("/plugins", status_code=201)
def create_plugin(body: PluginWrite):
    raise HTTPException(501, "plugins are no longer supported")


@router.put("/plugins/{plugin_id}")
def update_plugin(plugin_id: str, body: PluginUpdate):
    raise HTTPException(501, "plugins are no longer supported")


@router.patch("/plugins/{plugin_id}/enabled")
def set_plugin_enabled(plugin_id: str, body: EnabledUpdate):
    raise HTTPException(501, "plugins are no longer supported")


@router.delete("/plugins/{plugin_id}", status_code=204)
def delete_plugin(plugin_id: str):
    raise HTTPException(501, "plugins are no longer supported")
    except (ValueError, TypeError) as exc:
        raise HTTPException(400, str(exc)) from exc
    return Response(status_code=204)
