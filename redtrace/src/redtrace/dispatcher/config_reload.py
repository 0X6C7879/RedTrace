from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from redtrace.dispatcher.config import DispatchConfig


@dataclass(frozen=True, slots=True)
class ConfigSignature:
    modified_ns: int
    changed_ns: int
    size: int
    inode: int


@dataclass(frozen=True, slots=True)
class ConfigRefresh:
    config: DispatchConfig | None = None
    error: str | None = None


class DispatchConfigReloader:
    """Stat-gated config reload with last-known-good retention."""

    def __init__(self, path: Path):
        self.path = path
        self.config = DispatchConfig.load(path)
        self._signature = self._stat()

    def refresh(self) -> ConfigRefresh | None:
        try:
            signature = self._stat()
        except OSError as exc:
            return ConfigRefresh(error=f"worker config reload unavailable: {exc}")
        if signature == self._signature:
            return None
        # Record the observed signature even for invalid files. This avoids reparsing and
        # relogging the same bad external edit on every scheduling iteration.
        self._signature = signature
        try:
            candidate = DispatchConfig.load(self.path)
        except Exception as exc:
            return ConfigRefresh(error=f"worker config reload rejected: {exc}")
        if self._requires_restart(self.config, candidate):
            return ConfigRefresh(
                error=(
                    "config reload contains server/runtime/task/backend changes; "
                    "only Worker/common_env changes can be applied without restart"
                )
            )
        self.config = candidate
        return ConfigRefresh(config=candidate)

    def _stat(self) -> ConfigSignature:
        stat = self.path.stat()
        return ConfigSignature(
            modified_ns=stat.st_mtime_ns,
            changed_ns=stat.st_ctime_ns,
            size=stat.st_size,
            inode=stat.st_ino,
        )

    @staticmethod
    def _requires_restart(current: DispatchConfig, candidate: DispatchConfig) -> bool:
        excluded = {
            "workers": True,
            "common_env": True,
        }
        return current.model_dump(exclude=excluded) != candidate.model_dump(exclude=excluded)
