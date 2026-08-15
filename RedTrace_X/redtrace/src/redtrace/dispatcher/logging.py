from __future__ import annotations

import logging

_DISPATCHER_LOG_PREFIX = "redtrace.dispatcher."


class CompactLoggerName(logging.Filter):
    """Expose a concise logger name without mutating the canonical name."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.shortname = record.name.removeprefix(_DISPATCHER_LOG_PREFIX)
        return True


def configure_logging(level: str = "INFO", *, bare: bool = False) -> None:
    handler = logging.StreamHandler()
    handler.addFilter(CompactLoggerName())
    if bare:
        template = "%(message)s"
    else:
        template = "[%(asctime)s] %(levelname)s %(shortname)s %(message)s"
    handler.setFormatter(logging.Formatter(template, datefmt="%Y-%m-%d %H:%M:%S"))
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        handlers=[handler],
        force=True,
    )
    for noisy_logger in ("requests", "urllib3"):
        logging.getLogger(noisy_logger).setLevel(logging.WARNING)
