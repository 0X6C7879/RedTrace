from __future__ import annotations

import re

from fastapi import HTTPException

from redtrace.board.models import (
    ConcludeRequest,
    ConcludeResponse,
    CreateIntentRequest,
    Fact,
    Intent,
)
from redtrace.board.storage import (
    check_project_active,
    get_blackboard_revision,
    get_owned_open_intent_or_404,
    get_releasable_open_intent_or_404,
    get_unclaimed_open_intent_or_404,
    intent_to_model,
    next_fact_id,
    next_intent_id,
    utcnow,
    validate_facts_exist,
    validate_goal_not_in_sources,
    validate_intent_creator_worker,
)
from redtrace.server.db import get_conn

ACCESS_CLAIM_RE = re.compile(
    r"(?:(?:obtained|acquired|established|connected|accessed|got)[^\n.]{0,40}"
    r"(?:web\s*shell|reverse\s*shell|bind\s*shell|evil[-_ ]?winrm|psexec|wmi|ssh|"
    r"meterpreter|sliver|beacon|c2\s*session|shell))|"
    r"(?:(?:已|成功)?(?:获得|获取|建立|连接|登录|控制)[^。\n]{0,40}"
    r"(?:web\s*shell|反弹\s*shell|直连\s*shell|bind\s*shell|ssh|evil[-_ ]?winrm|"
    r"psexec|wmi|meterpreter|sliver|beacon|c2\s*会话|shell))",
    re.IGNORECASE,
)
RESOURCE_REFERENCE_RE = re.compile(r"\b(?:ws|ses)_[a-z0-9]+\b", re.IGNORECASE)


def create(project_id: str, request: CreateIntentRequest) -> Intent:
    """Create an intent and all of its source edges atomically."""
    with get_conn(immediate=True) as conn:
        check_project_active(conn, project_id)
        validate_facts_exist(conn, project_id, request.from_)
        validate_goal_not_in_sources(request.from_)
        validate_intent_creator_worker(request.creator, request.worker)

        now = utcnow()
        intent_id = next_intent_id(conn, project_id)
        claimed = request.worker is not None
        conn.execute(
            "INSERT INTO intents (id, project_id, to_fact_id, description, creator, worker, last_heartbeat_at, created_at, concluded_at, state) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, NULL, ?)",
            (
                intent_id,
                project_id,
                request.description,
                request.creator,
                request.worker,
                now if claimed else None,
                now,
                "working" if claimed else "open",
            ),
        )
        conn.executemany(
            "INSERT INTO intent_sources (intent_id, project_id, fact_id) VALUES (?, ?, ?)",
            [(intent_id, project_id, fact_id) for fact_id in request.from_],
        )

        return Intent(
            id=intent_id,
            **{"from": request.from_},
            to=None,
            description=request.description,
            creator=request.creator,
            worker=request.worker,
            last_heartbeat_at=now if claimed else None,
            created_at=now,
            concluded_at=None,
            state="working" if claimed else "open",
        )


def claim(project_id: str, intent_id: str, worker: str) -> Intent:
    with get_conn(immediate=True) as conn:
        check_project_active(conn, project_id)
        get_unclaimed_open_intent_or_404(conn, project_id, intent_id)
        now = utcnow()
        conn.execute(
            "UPDATE intents SET worker = ?, last_heartbeat_at = ?, state = 'working', attempt_count = attempt_count + 1 WHERE id = ? AND project_id = ?",
            (worker, now, intent_id, project_id),
        )
        return _load_intent(conn, project_id, intent_id)


def heartbeat(project_id: str, intent_id: str, worker: str) -> dict[str, object]:
    with get_conn(immediate=True) as conn:
        check_project_active(conn, project_id)
        get_owned_open_intent_or_404(conn, project_id, intent_id, worker)
        now = utcnow()
        conn.execute(
            "UPDATE intents SET last_heartbeat_at = ? WHERE id = ? AND project_id = ?",
            (now, intent_id, project_id),
        )
        result = _load_intent(conn, project_id, intent_id).model_dump(
            mode="json", by_alias=True
        )
        result["blackboard_revision"] = get_blackboard_revision(conn, project_id)
        return result


def release(project_id: str, intent_id: str, worker: str) -> Intent:
    with get_conn(immediate=True) as conn:
        check_project_active(conn, project_id)
        get_releasable_open_intent_or_404(conn, project_id, intent_id, worker)
        conn.execute(
            "UPDATE intents SET worker = NULL, state = 'open' WHERE id = ? AND project_id = ?",
            (intent_id, project_id),
        )
        return _load_intent(conn, project_id, intent_id)


def conclude(
    project_id: str, intent_id: str, request: ConcludeRequest
) -> ConcludeResponse:
    """Turn an open intent into a fact in one transaction."""
    with get_conn(immediate=True) as conn:
        check_project_active(conn, project_id)
        get_releasable_open_intent_or_404(
            conn, project_id, intent_id, request.worker
        )
        validate_registered_access_claim(conn, request.description)
        now = utcnow()
        fact_id = next_fact_id(conn, project_id)
        description = _with_linked_resource_secrets(
            conn, project_id, intent_id, request.description
        )
        conn.execute(
            "INSERT INTO facts (id, project_id, description) VALUES (?, ?, ?)",
            (fact_id, project_id, description),
        )
        conn.execute(
            "UPDATE intents SET to_fact_id = ?, worker = ?, last_heartbeat_at = ?, concluded_at = ?, state = 'concluded', fact_yield = fact_yield + 1, last_progress_at = ? WHERE id = ? AND project_id = ?",
            (fact_id, request.worker, now, now, now, intent_id, project_id),
        )
        conn.execute(
            "UPDATE shared_resources SET fact_id = ? WHERE project_id = ? AND intent_id = ?",
            (fact_id, project_id, intent_id),
        )
        return ConcludeResponse(
            fact=Fact(id=fact_id, description=description),
            intent=_load_intent(conn, project_id, intent_id),
        )


def _with_linked_resource_secrets(
    conn, project_id: str, intent_id: str, description: str
) -> str:
    rows = conn.execute(
        "SELECT id, secret_json FROM shared_resources WHERE project_id = ? AND intent_id = ? AND secret_json != '{}' ORDER BY id",
        (project_id, intent_id),
    ).fetchall()
    shared = [
        f"- [resource:{row['id']}] {row['secret_json']}"
        for row in rows
    ]
    if not shared:
        return description
    return f"{description.rstrip()}\n\nShared resource secrets:\n" + "\n".join(shared)


def validate_registered_access_claim(conn, description: str) -> None:
    """A Worker cannot conclude with an unregistered shell hidden outside the hub."""
    if not ACCESS_CLAIM_RE.search(description):
        return
    references = RESOURCE_REFERENCE_RE.findall(description)
    if not references:
        raise HTTPException(409, "shell/session claims must include the registered WebShell or C2 Session Resource ID")
    placeholders = ",".join("?" for _ in references)
    count = conn.execute(
        f"SELECT COUNT(*) FROM shared_resources WHERE id IN ({placeholders}) AND kind IN ('webshell', 'c2_session')",
        references,
    ).fetchone()[0]
    if count != len(set(references)):
        raise HTTPException(409, "shell/session claims reference an unknown WebShell or C2 Session Resource ID")


def _load_intent(conn, project_id: str, intent_id: str) -> Intent:
    row = conn.execute(
        "SELECT * FROM intents WHERE id = ? AND project_id = ?",
        (intent_id, project_id),
    ).fetchone()
    assert row is not None
    return intent_to_model(conn, row, project_id)


