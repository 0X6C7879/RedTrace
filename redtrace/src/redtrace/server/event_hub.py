from __future__ import annotations

import queue
import threading
from collections import defaultdict
from typing import Any


class EventHub:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._subscribers: dict[str, set[queue.Queue[dict[str, Any]]]] = defaultdict(set)

    def subscribe(self, project_id: str) -> queue.Queue[dict[str, Any]]:
        subscriber: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=512)
        with self._lock:
            self._subscribers[project_id].add(subscriber)
        return subscriber

    def unsubscribe(self, project_id: str, subscriber: queue.Queue[dict[str, Any]]) -> None:
        with self._lock:
            subscribers = self._subscribers.get(project_id)
            if not subscribers:
                return
            subscribers.discard(subscriber)
            if not subscribers:
                self._subscribers.pop(project_id, None)

    def publish(self, project_id: str, event: dict[str, Any]) -> None:
        with self._lock:
            subscribers = tuple(self._subscribers.get(project_id, ()))
        for subscriber in subscribers:
            try:
                subscriber.put_nowait(event)
            except queue.Full:
                try:
                    subscriber.get_nowait()
                    subscriber.put_nowait(event)
                except (queue.Empty, queue.Full):
                    pass


event_hub = EventHub()
