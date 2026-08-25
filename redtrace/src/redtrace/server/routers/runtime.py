from __future__ import annotations

from fastapi import APIRouter, HTTPException

from redtrace.config_secrets import resolve_dispatch_config_path
from redtrace.dispatcher import dsh
from redtrace.dispatcher.config import DispatchConfig

router = APIRouter(prefix="/runtime", tags=["runtime"])


@router.get("/config")
def get_runtime_config():
    """Hot-reloadable DSH runtime config for the Cordis scheduler.

    Read fresh from the dispatcher config on every call so Worker edits in the
    Web UI or on disk are visible without a server restart.
    """

    path = resolve_dispatch_config_path(None)
    try:
        config = DispatchConfig.load(path)
    except Exception as exc:
        raise HTTPException(503, f"dispatcher config unavailable: {exc}") from exc
    try:
        return dsh.runtime_config(config)
    except ValueError as exc:
        raise HTTPException(503, str(exc)) from exc
