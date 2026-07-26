from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field

from redtrace.capabilities import CapabilityStore, SkillConflictError
from redtrace.plugin_registry import PluginRegistry
from redtrace.skill_evolution import SkillEvolutionEngine

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


class EvolutionImpact(BaseModel):
    task_succeeded: bool
    tool_calls_saved: int = Field(default=0, ge=0)
    invalid_steps_avoided: int = Field(default=0, ge=0)
    duration_saved_ms: int = Field(default=0, ge=0)


class EvolutionProposal(BaseModel):
    proposed_name: str = Field(min_length=1, max_length=64)
    target_skill: str | None = Field(default=None, max_length=64)
    content: str = Field(min_length=1)
    summary: str = Field(min_length=1, max_length=500)
    validation: list[str] = Field(min_length=1, max_length=8)
    impact: EvolutionImpact
    project_id: str | None = Field(default=None, max_length=128)
    intent_id: str | None = Field(default=None, max_length=128)
    worker: str | None = Field(default=None, max_length=128)
    task_type: str | None = Field(default=None, max_length=64)
    expected_revision: str | None = Field(default=None, max_length=64)


def _store() -> CapabilityStore:
    return CapabilityStore()


def _plugins() -> PluginRegistry:
    return PluginRegistry(_store().root)


def _not_found(kind: str, name: str) -> HTTPException:
    return HTTPException(404, f"{kind} not found: {name}")


def _skill_payload(record, *, include_content: bool = False) -> dict[str, Any]:
    payload = record.summary()
    if include_content:
        payload["content"] = record.content
    return payload


@router.get("")
def get_capabilities():
    store = _store()
    skills = store.list_skills()
    servers = store.list_mcp()
    plugins = _plugins().list_plugins()
    return {
        "root": str(store.root),
        "skillsDir": str(store.skills_dir),
        "mcpDir": str(store.mcp_dir),
        "pluginsDir": str(store.plugins_dir),
        "skills": {"total": len(skills), "enabled": sum(skill.enabled for skill in skills)},
        "mcp": {"total": len(servers), "enabled": sum(server.enabled for server in servers)},
        "plugins": {
            "total": len(plugins),
            "enabled": sum(plugin.enabled for plugin in plugins),
        },
        "agents": [
            {
                "id": "claude",
                "skills": str(store.skills_dir),
                "runtimeSnapshot": ".claude/skills",
                "mcp": "--mcp-config",
                "plugins": ".redtrace/plugins.json",
            },
            {
                "id": "codex",
                "skills": str(store.skills_dir),
                "runtimeSnapshot": ".agents/skills",
                "mcp": "mcp_servers config",
                "plugins": ".redtrace/plugins.json",
            },
            {
                "id": "pi",
                "skills": str(store.skills_dir),
                "runtimeSnapshot": ".agents/skills",
                "mcp": ".pi/mcp.json",
                "plugins": ".redtrace/plugins.json",
            },
        ],
    }


@router.get("/skills")
def list_skills():
    return [_skill_payload(record) for record in _store().list_skills()]


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
            store.write_skill(body.name, body.content, enabled=body.enabled),
            include_content=True,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.put("/skills/{name}")
def update_skill(name: str, body: SkillUpdate):
    store = _store()
    try:
        store.get_skill(name)
        return _skill_payload(
            store.write_skill(
                name,
                body.content,
                enabled=body.enabled,
                expected_revision=body.expected_revision,
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
        _store().delete_skill(name)
    except FileNotFoundError:
        raise _not_found("skill", name) from None
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return Response(status_code=204)


@router.get("/skills/{name}/versions")
def list_skill_versions(name: str):
    try:
        _store().get_skill(name)
        return _store().list_skill_versions(name)
    except FileNotFoundError:
        raise _not_found("skill", name) from None
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/skills/{name}/rollback/{version}")
def rollback_skill(name: str, version: int, body: RollbackRequest):
    try:
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


@router.post("/evolution/proposals", status_code=202)
def submit_evolution(body: EvolutionProposal, request: Request):
    worker = getattr(request.app.state, "skill_evolution", None)
    engine = worker.engine if worker is not None else SkillEvolutionEngine(_store())
    try:
        proposal_id = engine.submit(body.model_dump())
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if worker is not None:
        worker.notify()
    return {"proposalId": proposal_id, "status": "queued"}


@router.get("/evolution")
def evolution_status(request: Request):
    worker = getattr(request.app.state, "skill_evolution", None)
    engine = worker.engine if worker is not None else SkillEvolutionEngine(_store())
    return {
        "pending": engine.pending_count(),
        "maxSkills": engine.store.max_skills,
        "maxSkillChars": engine.store.max_skill_chars,
        "historyLimit": engine.store.history_limit,
        "matchThreshold": engine.match_threshold,
    }


@router.get("/evolution/audit")
def evolution_audit(limit: int = 100):
    return _store().read_skill_audit(limit)


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
    try:
        registry = _plugins()
        return [record.summary(registry.root) for record in registry.list_plugins()]
    except (ValueError, TypeError) as exc:
        raise HTTPException(500, str(exc)) from exc


@router.get("/plugins/{plugin_id}")
def get_plugin(plugin_id: str):
    try:
        registry = _plugins()
        return registry.get_plugin(plugin_id).summary(registry.root)
    except FileNotFoundError:
        raise _not_found("plugin", plugin_id) from None
    except (ValueError, TypeError) as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/plugins", status_code=201)
def create_plugin(body: PluginWrite):
    registry = _plugins()
    try:
        registry.get_plugin(body.id)
    except FileNotFoundError:
        pass
    except (ValueError, TypeError) as exc:
        raise HTTPException(400, str(exc)) from exc
    else:
        raise HTTPException(409, f"plugin already exists: {body.id}")
    try:
        return registry.write_plugin(body.id, body.config).summary(registry.root)
    except (ValueError, TypeError) as exc:
        raise HTTPException(400, str(exc)) from exc


@router.put("/plugins/{plugin_id}")
def update_plugin(plugin_id: str, body: PluginUpdate):
    registry = _plugins()
    try:
        registry.get_plugin(plugin_id)
        return registry.write_plugin(plugin_id, body.config).summary(registry.root)
    except FileNotFoundError:
        raise _not_found("plugin", plugin_id) from None
    except (ValueError, TypeError) as exc:
        raise HTTPException(400, str(exc)) from exc


@router.patch("/plugins/{plugin_id}/enabled")
def set_plugin_enabled(plugin_id: str, body: EnabledUpdate):
    registry = _plugins()
    try:
        return registry.set_enabled(plugin_id, body.enabled).summary(registry.root)
    except FileNotFoundError:
        raise _not_found("plugin", plugin_id) from None
    except (ValueError, TypeError) as exc:
        raise HTTPException(400, str(exc)) from exc


@router.delete("/plugins/{plugin_id}", status_code=204)
def delete_plugin(plugin_id: str):
    try:
        _plugins().delete_plugin(plugin_id)
    except FileNotFoundError:
        raise _not_found("plugin", plugin_id) from None
    except (ValueError, TypeError) as exc:
        raise HTTPException(400, str(exc)) from exc
    return Response(status_code=204)
