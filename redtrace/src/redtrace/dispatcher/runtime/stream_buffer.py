from __future__ import annotations

from collections import deque


TRUNCATED_STREAM_LINE = (
    "[redtrace] oversized worker output line omitted from live audit\n"
)


class BoundedTextBuffer:
    """Retain a parse-safe prefix and recent tail without keeping a full stream."""

    def __init__(self, max_chars: int, prefix_chars: int | None = None):
        self.max_chars = max(16, max_chars)
        self.prefix_chars = min(
            self.max_chars // 2,
            prefix_chars if prefix_chars is not None else 256 * 1024,
        )
        self.tail_chars = self.max_chars - self.prefix_chars
        self._prefix: list[str] = []
        self._prefix_size = 0
        self._tail: deque[str] = deque()
        self._tail_size = 0
        self.total_chars = 0
        self.total_bytes = 0

    @property
    def truncated(self) -> bool:
        return self.total_chars > self._prefix_size + self._tail_size

    def append(self, value: str) -> None:
        if not value:
            return
        self.total_chars += len(value)
        self.total_bytes += len(value.encode("utf-8", errors="replace"))
        remaining = value
        prefix_room = self.prefix_chars - self._prefix_size
        if prefix_room > 0:
            head = remaining[:prefix_room]
            self._prefix.append(head)
            self._prefix_size += len(head)
            remaining = remaining[len(head) :]
        if not remaining or self.tail_chars <= 0:
            return
        self._tail.append(remaining)
        self._tail_size += len(remaining)
        while self._tail_size > self.tail_chars and self._tail:
            excess = self._tail_size - self.tail_chars
            first = self._tail[0]
            if len(first) <= excess:
                self._tail.popleft()
                self._tail_size -= len(first)
                continue
            self._tail[0] = first[excess:]
            self._tail_size -= excess

    def text(self) -> str:
        prefix = "".join(self._prefix)
        tail = "".join(self._tail)
        if not self.truncated:
            return prefix + tail
        omitted = self.total_chars - self._prefix_size - self._tail_size
        return (
            prefix
            + f"\n… {omitted} streamed characters omitted from the in-memory window …\n"
            + tail
        )


class BoundedLineEmitter:
    """Emit complete lines while bounding a pathological no-newline record."""

    def __init__(self, callback, max_line_chars: int = 2 * 1024 * 1024):
        self._callback = callback
        self._max_line_chars = max(1024, max_line_chars)
        self._parts: list[str] = []
        self._size = 0
        self._overflow = False

    def feed(self, value: str) -> None:
        cursor = 0
        while cursor < len(value):
            newline = value.find("\n", cursor)
            end = len(value) if newline < 0 else newline + 1
            segment = value[cursor:end]
            if not self._overflow:
                room = self._max_line_chars - self._size
                if len(segment) <= room:
                    self._parts.append(segment)
                    self._size += len(segment)
                else:
                    if room:
                        self._parts.append(segment[:room])
                        self._size += room
                    self._overflow = True
            if newline >= 0:
                self._finish_line()
            cursor = end

    def flush(self) -> None:
        if self._parts or self._overflow:
            self._finish_line()

    def _finish_line(self) -> None:
        if self._overflow:
            self._callback(TRUNCATED_STREAM_LINE)
        elif self._parts:
            self._callback("".join(self._parts))
        self._parts.clear()
        self._size = 0
        self._overflow = False
