from __future__ import annotations

from redtrace.board.models import CreateHintRequest, Hint
from redtrace.board.storage import check_project_hint_writable, next_hint_id, utcnow
from redtrace.server.db import get_conn


def create(project_id: str, request: CreateHintRequest) -> Hint:
    with get_conn(immediate=True) as conn:
        check_project_hint_writable(conn, project_id)
        hint = Hint(
            id=next_hint_id(conn, project_id),
            content=request.content,
            creator=request.creator,
            created_at=utcnow(),
        )
        conn.execute(
            "INSERT INTO hints (id, project_id, content, creator, created_at) VALUES (?, ?, ?, ?, ?)",
            (hint.id, project_id, hint.content, hint.creator, hint.created_at),
        )
        return hint
