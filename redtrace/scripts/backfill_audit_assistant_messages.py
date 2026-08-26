#!/usr/bin/env python3
"""Backfill durable assistant.message rows dropped by the event_uid collision.

Before the fix in packages/redtrace-dsh/src/audit.ts, one assistant/message
session event with both reasoning and text blocks projected two rows that
shared the same event_uid (`<session>-<seq>`). The audit store dedupes by
event_uid with INSERT OR IGNORE, so the thinking row won and the model's text
output was never persisted: the logs page showed it live via transient
assistant.delta events, but it vanished on reload.

This script replays the durable DSH session logs (session.jsonl) and inserts
the missing assistant.message rows with the fixed id scheme. The dropped
insert had still burned an AUTOINCREMENT id, so each row reclaims the free
slot right after its paired thinking row — the id order the timeline pages
by is restored as if the drop never happened. It is idempotent: every insert
is INSERT OR IGNORE keyed on event_uid, so re-running never duplicates rows.

Usage:
    python3 redtrace/scripts/backfill_audit_assistant_messages.py \
        [--db PATH] [--session-root PATH] [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


def iso_from_ms(value: Any) -> str:
    return datetime.fromtimestamp(int(value) / 1000, UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def blocks_text(blocks: list[dict[str, Any]], wanted: str) -> str:
    return "".join(str(block.get("text") or "") for block in blocks if block.get("type") == wanted)


def assistant_rows(event: dict[str, Any], flags: dict[str, bool]) -> list[dict[str, Any]] | None:
    """Mirror the fixed assistant/message projection from audit.ts."""
    if event.get("type") == "assistant/chunk":
        chunk = (event.get("data") or {}).get("chunk") or {}
        if chunk.get("type") == "text-delta":
            flags["streamed_text"] = True
        elif chunk.get("type") == "reasoning-delta":
            flags["streamed_thinking"] = True
        return None
    if event.get("type") != "assistant/message":
        return None
    message = (event.get("data") or {}).get("message") or {}
    blocks = message.get("content") or []
    reasoning = blocks_text(blocks, "reasoning")
    content = blocks_text(blocks, "text")
    rows: list[dict[str, Any]] = []
    if content:
        base_uid = f"{flags['session_id']}-{event.get('seq')}"
        rows.append({
            "event_uid": f"{base_uid}-text" if reasoning else base_uid,
            "run_sequence": int(event.get("seq") or 0),
            "timestamp": iso_from_ms(event.get("time")),
            "kind": "assistant.message",
            "role": "assistant",
            "content": content,
            "persist_only": flags["streamed_text"],
        })
    flags["streamed_text"] = False
    flags["streamed_thinking"] = False
    return rows


def backfill(db_path: Path, session_root: Path, dry_run: bool) -> int:
    conn = sqlite3.connect(str(db_path), timeout=30.0)
    conn.row_factory = sqlite3.Row
    inserted = 0
    try:
        conn.execute("PRAGMA foreign_keys=ON")
        runs = conn.execute(
            "SELECT id, project_id, task_type, worker, provider, session_id"
            " FROM audit_runs WHERE session_id IS NOT NULL"
        ).fetchall()
        logs = {path.parent.name: path for path in session_root.rglob("session.jsonl")}
        for run in runs:
            log = logs.get(run["session_id"])
            if log is None:
                continue
            flags = {"session_id": run["session_id"], "streamed_text": False, "streamed_thinking": False}
            for line in log.read_text(encoding="utf-8", errors="replace").splitlines():
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                rows = assistant_rows(event, flags)
                if not rows:
                    continue
                for row in rows:
                    exists = conn.execute(
                        "SELECT 1 FROM audit_events WHERE event_uid = ?", (row["event_uid"],)
                    ).fetchone()
                    if exists:
                        continue
                    # The dropped insert still burned an AUTOINCREMENT id, so
                    # the slot right after the paired reasoning row is free.
                    # Filling it restores the id order the timeline pages by;
                    # ties break on id, keeping text after reasoning.
                    target = conn.execute(
                        "SELECT id, timestamp FROM audit_events"
                        " WHERE run_id = ? AND run_sequence = ? AND kind = 'thinking.message'",
                        (run["id"], row["run_sequence"]),
                    ).fetchone()
                    timestamp = row["timestamp"] if target is None else target["timestamp"]
                    explicit_id = None
                    if target is not None:
                        free = conn.execute(
                            "SELECT 1 FROM audit_events WHERE id = ?", (target["id"] + 1,)
                        ).fetchone()
                        if free is None:
                            explicit_id = target["id"] + 1
                    payload = {
                        "event_uid": row["event_uid"],
                        "run_sequence": row["run_sequence"],
                        "timestamp": timestamp,
                        "kind": row["kind"],
                        "role": row["role"],
                        "persist_only": row["persist_only"],
                        "project_id": run["project_id"],
                        "run_id": run["id"],
                        "task_type": run["task_type"],
                        "worker": run["worker"],
                        "provider": run["provider"],
                    }
                    if dry_run:
                        inserted += 1
                        continue
                    conn.execute(
                        "INSERT OR IGNORE INTO audit_events ("
                        " id, event_uid, project_id, run_id, run_sequence, timestamp,"
                        " kind, role, title, content, payload, is_redacted"
                        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 0)",
                        (
                            explicit_id, row["event_uid"], run["project_id"], run["id"],
                            row["run_sequence"], timestamp, row["kind"], row["role"],
                            row["content"],
                            json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                        ),
                    )
                    inserted += 1
        conn.commit()
    finally:
        conn.close()
    return inserted


def main() -> int:
    root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--db", type=Path, default=root / ".redtrace" / "redtrace.db")
    parser.add_argument("--session-root", type=Path, default=root / ".redtrace" / "dsh" / "sessions")
    parser.add_argument("--dry-run", action="store_true", help="Count the rows that would be inserted")
    args = parser.parse_args()
    if not args.db.is_file():
        print(f"database not found: {args.db}", file=sys.stderr)
        return 1
    if not args.session_root.is_dir():
        print(f"session root not found: {args.session_root}", file=sys.stderr)
        return 1
    inserted = backfill(args.db, args.session_root, args.dry_run)
    print(f"{'would insert' if args.dry_run else 'inserted'} {inserted} assistant.message rows")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
