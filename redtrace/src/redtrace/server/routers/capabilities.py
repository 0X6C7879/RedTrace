from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field

from redtrace.capabilities import CapabilityStore

router = APIRouter(prefix="/capabilities", tags=["capabilities"])


class SkillWrite(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    content: str = Field(min_length=1)
    enabled: bool = True


class SkillUpdate(BaseModel):
    content: str = Field(min_length=1)
    enabled: bool = True


class McpWrite(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    config: dict[str, Any]


class McpUpdate(BaseModel):
    config: dict[str, Any]


class EnabledUpdate(BaseModel):
    enabled: bool


def _store() -> CapabilityStore:
    return CapabilityStore()


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
    return {
        "root": str(store.root),
        "skillsDir": str(store.skills_dir),
        "mcpDir": str(store.mcp_dir),
        "skills": {"total": len(skills), "enabled": sum(skill.enabled for skill in skills)},
        "mcp": {"total": len(servers), "enabled": sum(server.enabled for server in servers)},
        "agents": [
            {"id": "claude", "skills": ".claude/skills", "mcp": "--mcp-config"},
            {"id": "codex", "skills": ".agents/skills", "mcp": "mcp_servers config"},
            {"id": "pi", "skills": ".agents/skills", "mcp": ".pi/mcp.json"},
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
            store.write_skill(name, body.content, enabled=body.enabled),
            include_content=True,
        )
    except FileNotFoundError:
        raise _not_found("skill", name) from None
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.patch("/skills/{name}/enabled")
def set_skill_enabled(name: str, body: EnabledUpdate):
    try:
        return _skill_payload(_store().set_skill_enabled(name, body.enabled), include_content=True)
    except FileNotFoundError:
        raise _not_found("skill", name) from None
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.delete("/skills/{name}", status_code=204)
def delete_skill(name: str):
    try:
        _store().delete_skill(name)
    except FileNotFoundError:
        raise _not_found("skill", name) from None
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return Response(status_code=204)


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
