from __future__ import annotations

import hashlib
import json
import logging
import sqlite3
import uuid
from collections import deque
from dataclasses import dataclass
from typing import Any

from fastapi import APIRouter, Depends, Header, Query

from redtrace.server.db import get_conn
from redtrace.server.services import get_blackboard_revision, get_project_or_404, intent_to_model, utcnow

router = APIRouter(prefix="/projects/{project_id}/blackboard", tags=["blackboard"])
LOG = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class QueryContext:
    worker: str
    task_type: str
    intent_id: str | None


def query_context(
    worker: str = Header(default="unknown", alias="X-RedTrace-Worker"),
    task_type: str = Header(default="unknown", alias="X-RedTrace-Task"),
    intent_id: str | None = Header(default=None, alias="X-RedTrace-Intent"),
) -> QueryContext:
    return QueryContext(
        worker=(worker.strip() or "unknown")[:128],
        task_type=(task_type.strip() or "unknown")[:64],
        intent_id=(intent_id.strip()[:128] if intent_id and intent_id.strip() else None),
    )


def _node_for_kind(
    conn: sqlite3.Connection,
    project_id: str,
    kind: str,
    node_id: str,
) -> dict[str, Any] | None:
    if kind == "fact":
        row = conn.execute(
            "SELECT id, description FROM facts WHERE project_id = ? AND id = ?",
            (project_id, node_id),
        ).fetchone()
        return {"kind": "fact", **dict(row)} if row else None
    if kind == "hint":
        row = conn.execute(
            "SELECT id, content, creator, created_at FROM hints WHERE project_id = ? AND id = ?",
            (project_id, node_id),
        ).fetchone()
        return {"kind": "hint", **dict(row)} if row else None
    if kind == "intent":
        row = conn.execute(
            "SELECT * FROM intents WHERE project_id = ? AND id = ?",
            (project_id, node_id),
        ).fetchone()
        if row is None:
            return None
        return {
            "kind": "intent",
            **intent_to_model(conn, row, project_id).model_dump(mode="json", by_alias=True),
        }
    return None


def _find_node(conn: sqlite3.Connection, project_id: str, node_id: str) -> dict[str, Any] | None:
    for kind in ("fact", "intent", "hint"):
        node = _node_for_kind(conn, project_id, kind, node_id)
        if node is not None:
            return node
    return None


def _graph_edges(conn: sqlite3.Connection, project_id: str) -> list[dict[str, str]]:
    rows = conn.execute(
        """
        SELECT s.fact_id AS source, i.id AS intent_id, i.to_fact_id AS target
        FROM intent_sources s
        JOIN intents i
          ON i.project_id = s.project_id
         AND i.id = s.intent_id
        WHERE s.project_id = ?
        ORDER BY i.created_at, s.rowid
        """,
        (project_id,),
    ).fetchall()
    edges: list[dict[str, str]] = []
    result_edges: set[tuple[str, str]] = set()
    for row in rows:
        edges.append({"from": row["source"], "to": row["intent_id"], "relation": "source"})
        result_edge = (row["intent_id"], row["target"])
        if row["target"] is not None and result_edge not in result_edges:
            edges.append({"from": row["intent_id"], "to": row["target"], "relation": "result"})
            result_edges.add(result_edge)
    return edges


def _audit_result(
    conn: sqlite3.Connection,
    project_id: str,
    context: QueryContext,
    command: str,
    arguments: dict[str, Any],
    result: dict[str, Any],
    *,
    result_count: int,
) -> dict[str, Any]:
    request_id = uuid.uuid4().hex
    result["query_id"] = request_id
    canonical = json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    revision = int(result.get("revision", 0))
    conn.execute(
        """
        INSERT INTO blackboard_query_audit (
            request_id, project_id, worker, task_type, intent_id, command,
            arguments, revision, result_count, output_sha256, output_bytes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            request_id,
            project_id,
            context.worker,
            context.task_type,
            context.intent_id,
            command,
            json.dumps(arguments, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
            revision,
            result_count,
            hashlib.sha256(canonical).hexdigest(),
            len(canonical),
            utcnow(),
        ),
    )
    LOG.info(
        "blackboard query project=%s worker=%s task=%s intent=%s command=%s revision=%s results=%s query_id=%s",
        project_id,
        context.worker,
        context.task_type,
        context.intent_id or "-",
        command,
        revision,
        result_count,
        request_id,
    )
    return result


@router.get("/status")
def blackboard_status(
    project_id: str,
    since: int = Query(default=0, ge=0),
    context: QueryContext = Depends(query_context),
) -> dict[str, Any]:
    with get_conn() as conn:
        project = get_project_or_404(conn, project_id)
        revision = get_blackboard_revision(conn, project_id)
        counts = conn.execute(
            """
            SELECT
                (SELECT COUNT(*) FROM facts WHERE project_id = ?) AS facts,
                (SELECT COUNT(*) FROM intents WHERE project_id = ?) AS intents,
                (SELECT COUNT(*) FROM hints WHERE project_id = ?) AS hints
            """,
            (project_id, project_id, project_id),
        ).fetchone()
        result = {
            "project": project_id,
            "command": "status",
            "status": project["status"],
            "since": since,
            "revision": revision,
            "changed": revision > since,
            "counts": dict(counts),
        }
        return _audit_result(conn, project_id, context, "status", {"since": since}, result, result_count=0)


@router.get("/changes")
def blackboard_changes(
    project_id: str,
    since: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=100),
    context: QueryContext = Depends(query_context),
) -> dict[str, Any]:
    with get_conn() as conn:
        get_project_or_404(conn, project_id)
        revision = get_blackboard_revision(conn, project_id)
        rows = conn.execute(
            """
            SELECT revision, kind, node_id, action, created_at
            FROM blackboard_events
            WHERE project_id = ? AND revision > ?
            ORDER BY revision
            LIMIT ?
            """,
            (project_id, since, limit + 1),
        ).fetchall()
        selected = rows[:limit]
        changes = []
        for row in selected:
            item = dict(row)
            item["node"] = _node_for_kind(conn, project_id, row["kind"], row["node_id"])
            changes.append(item)
        result = {
            "project": project_id,
            "command": "changes",
            "since": since,
            "revision": revision,
            "next_revision": int(selected[-1]["revision"]) if selected else min(since, revision),
            "has_more": len(rows) > limit,
            "changes": changes,
        }
        return _audit_result(
            conn,
            project_id,
            context,
            "changes",
            {"since": since, "limit": limit},
            result,
            result_count=len(changes),
        )


@router.get("/nodes/{node_id}")
def blackboard_node(
    project_id: str,
    node_id: str,
    context: QueryContext = Depends(query_context),
) -> dict[str, Any]:
    with get_conn() as conn:
        get_project_or_404(conn, project_id)
        node = _find_node(conn, project_id, node_id)
        result = {
            "project": project_id,
            "command": "node",
            "revision": get_blackboard_revision(conn, project_id),
            "found": node is not None,
            "node": node,
        }
        return _audit_result(
            conn,
            project_id,
            context,
            "node",
            {"node_id": node_id},
            result,
            result_count=int(node is not None),
        )


@router.get("/path")
def blackboard_path(
    project_id: str,
    source: str,
    target: str,
    context: QueryContext = Depends(query_context),
) -> dict[str, Any]:
    with get_conn() as conn:
        get_project_or_404(conn, project_id)
        adjacency: dict[str, list[str]] = {}
        for edge in _graph_edges(conn, project_id):
            adjacency.setdefault(edge["from"], []).append(edge["to"])
        parents: dict[str, str | None] = {source: None}
        pending = deque([source])
        while pending and target not in parents:
            current = pending.popleft()
            for neighbor in adjacency.get(current, []):
                if neighbor in parents:
                    continue
                parents[neighbor] = current
                pending.append(neighbor)
        node_ids: list[str] = []
        if target in parents:
            cursor: str | None = target
            while cursor is not None:
                node_ids.append(cursor)
                cursor = parents[cursor]
            node_ids.reverse()
        nodes = [node for node_id in node_ids if (node := _find_node(conn, project_id, node_id)) is not None]
        found = bool(node_ids) and len(nodes) == len(node_ids)
        result = {
            "project": project_id,
            "command": "path",
            "revision": get_blackboard_revision(conn, project_id),
            "source": source,
            "target": target,
            "found": found,
            "path": nodes,
        }
        return _audit_result(
            conn,
            project_id,
            context,
            "path",
            {"source": source, "target": target},
            result,
            result_count=len(nodes),
        )


@router.get("/context/{node_id}")
def blackboard_context(
    project_id: str,
    node_id: str,
    depth: int = Query(default=1, ge=0, le=3),
    limit: int = Query(default=30, ge=1, le=50),
    context: QueryContext = Depends(query_context),
) -> dict[str, Any]:
    with get_conn() as conn:
        get_project_or_404(conn, project_id)
        root = _find_node(conn, project_id, node_id)
        edges = _graph_edges(conn, project_id)
        adjacency: dict[str, list[str]] = {}
        for edge in edges:
            adjacency.setdefault(edge["from"], []).append(edge["to"])
            adjacency.setdefault(edge["to"], []).append(edge["from"])
        selected_ids: list[str] = []
        if root is not None:
            seen = {node_id}
            pending = deque([(node_id, 0)])
            while pending and len(selected_ids) < limit:
                current, current_depth = pending.popleft()
                selected_ids.append(current)
                if current_depth >= depth:
                    continue
                for neighbor in adjacency.get(current, []):
                    if neighbor in seen:
                        continue
                    seen.add(neighbor)
                    pending.append((neighbor, current_depth + 1))
        selected = set(selected_ids)
        nodes = [node for item in selected_ids if (node := _find_node(conn, project_id, item)) is not None]
        selected_edges = [edge for edge in edges if edge["from"] in selected and edge["to"] in selected]
        result = {
            "project": project_id,
            "command": "context",
            "revision": get_blackboard_revision(conn, project_id),
            "root": node_id,
            "found": root is not None,
            "depth": depth,
            "truncated": bool(root is not None and len(selected_ids) >= limit),
            "nodes": nodes,
            "edges": selected_edges,
        }
        return _audit_result(
            conn,
            project_id,
            context,
            "context",
            {"node_id": node_id, "depth": depth, "limit": limit},
            result,
            result_count=len(nodes),
        )
