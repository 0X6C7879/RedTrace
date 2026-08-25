from __future__ import annotations

from redtrace.board.models import Settings
from redtrace.server.db import get_conn


def read() -> Settings:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT intent_timeout, reason_timeout FROM settings WHERE rowid = 1"
        ).fetchone()
        assert row is not None
        return Settings(
            intent_timeout=row["intent_timeout"], reason_timeout=row["reason_timeout"]
        )


def replace(settings: Settings) -> Settings:
    with get_conn(immediate=True) as conn:
        conn.execute(
            "UPDATE settings SET intent_timeout = ?, reason_timeout = ? WHERE rowid = 1",
            (settings.intent_timeout, settings.reason_timeout),
        )
    return settings
