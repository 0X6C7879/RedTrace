"""Worker adapter lookup for RedTrace execution backends."""

from redtrace.dispatcher.workers.registry import get_driver

__all__ = ["get_driver"]
