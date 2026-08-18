from __future__ import annotations

import json
import logging
import threading
import uuid
from typing import Any

LOG = logging.getLogger(__name__)


def _json_line(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"


class LiveControl:
    """Small adapter over a Worker's native bidirectional stdin protocol."""

    def __init__(self, prompt: str, session_id: str | None = None):
        self.prompt = prompt
        self.session_id = session_id
        self.session_file: str | None = None
        self._process: Any | None = None
        self._lock = threading.Lock()

    def attach(self, process: Any) -> None:
        with self._lock:
            self._process = process

    def handle_output(self, channel: str, line: str) -> None:
        raise NotImplementedError

    def send_signal(self, message: str) -> bool:
        raise NotImplementedError

    def _send(self, payload: dict[str, Any]) -> bool:
        with self._lock:
            process = self._process
        return bool(process is not None and process.send_stdin(_json_line(payload)))

    def _close(self) -> None:
        with self._lock:
            process = self._process
        if process is not None:
            process.close_stdin()


class ClaudeLiveControl(LiveControl):
    def __init__(self, prompt: str, session_id: str):
        super().__init__(prompt, session_id)
        self._outstanding = 1
        self._closing = False
        self.initial_input = self._message(prompt)

    def _message(self, text: str) -> str:
        return _json_line(
            {
                "type": "user",
                "message": {"role": "user", "content": text},
                "parent_tool_use_id": None,
                "session_id": self.session_id,
            }
        )

    def send_signal(self, message: str) -> bool:
        with self._lock:
            process = self._process
            if process is None or self._closing:
                return False
            self._outstanding += 1
            sent = process.send_stdin(self._message(message))
            if not sent:
                self._outstanding -= 1
            return bool(sent)

    def handle_output(self, channel: str, line: str) -> None:
        event = _event(channel, line)
        if event is None:
            return
        session_id = event.get("session_id")
        if isinstance(session_id, str) and session_id:
            self.session_id = session_id
        if event.get("type") != "result":
            return
        with self._lock:
            self._outstanding = max(0, self._outstanding - 1)
            done = self._outstanding == 0
            self._closing = done
        if done:
            self._close()


class PiLiveControl(LiveControl):
    def __init__(self, prompt: str, session_id: str | None = None):
        super().__init__(prompt, session_id)
        self.initial_input = "".join(
            (
                _json_line({"id": "redtrace-state", "type": "get_state"}),
                _json_line(
                    {"id": "redtrace-prompt", "type": "prompt", "message": prompt}
                ),
            )
        )

    def send_signal(self, message: str) -> bool:
        return self._send({"type": "steer", "message": message})

    def handle_output(self, channel: str, line: str) -> None:
        event = _event(channel, line)
        if event is None:
            return
        if event.get("type") == "response" and event.get("command") == "get_state":
            data = event.get("data")
            session_id = data.get("sessionId") if isinstance(data, dict) else None
            if isinstance(session_id, str) and session_id:
                self.session_id = session_id
            session_file = data.get("sessionFile") if isinstance(data, dict) else None
            if isinstance(session_file, str) and session_file:
                self.session_file = session_file
        elif event.get("type") == "session":
            session_id = event.get("id")
            if isinstance(session_id, str) and session_id:
                self.session_id = session_id
        elif event.get("type") == "agent_settled":
            self._close()


class CodexLiveControl(LiveControl):
    INITIALIZE_ID = 1
    THREAD_ID = 2
    TURN_ID = 3

    def __init__(
        self,
        prompt: str,
        *,
        session_id: str | None = None,
        model: str | None = None,
    ):
        super().__init__(prompt, session_id)
        self.model = model
        self.turn_id: str | None = None
        self._next_id = 10
        self._queued_signals: list[str] = []
        self.initial_input = _json_line(
            {
                "method": "initialize",
                "id": self.INITIALIZE_ID,
                "params": {
                    "clientInfo": {
                        "name": "redtrace",
                        "title": "RedTrace",
                        "version": "0.3.0",
                    }
                },
            }
        )

    def send_signal(self, message: str) -> bool:
        with self._lock:
            ready = bool(self._process and self.session_id and self.turn_id)
            if not ready:
                self._queued_signals = (self._queued_signals + [message])[-4:]
                return self._process is not None
        return self._send_steer(message)

    def handle_output(self, channel: str, line: str) -> None:
        event = _event(channel, line)
        if event is None:
            return
        request_id = event.get("id")
        if request_id in {
            self.INITIALIZE_ID,
            self.THREAD_ID,
            self.TURN_ID,
        } and event.get("error"):
            LOG.warning("Worker live protocol request failed: %s", event.get("error"))
            self._close()
            return
        if request_id == self.INITIALIZE_ID and "result" in event:
            self._send({"method": "initialized", "params": {}})
            self._send_thread_request()
            return
        if request_id == self.THREAD_ID:
            result = event.get("result")
            thread = result.get("thread") if isinstance(result, dict) else None
            thread_id = thread.get("id") if isinstance(thread, dict) else None
            if isinstance(thread_id, str) and thread_id:
                self.session_id = thread_id
                self._send_turn_request()
            return
        if request_id == self.TURN_ID:
            result = event.get("result")
            turn = result.get("turn") if isinstance(result, dict) else None
            turn_id = turn.get("id") if isinstance(turn, dict) else None
            if isinstance(turn_id, str) and turn_id:
                self.turn_id = turn_id
                self._flush_signals()
            return
        method = event.get("method")
        params = event.get("params")
        if method == "thread/started" and isinstance(params, dict):
            thread = params.get("thread")
            thread_id = thread.get("id") if isinstance(thread, dict) else None
            if isinstance(thread_id, str) and thread_id:
                self.session_id = thread_id
        elif method == "turn/started" and isinstance(params, dict):
            turn = params.get("turn")
            turn_id = turn.get("id") if isinstance(turn, dict) else None
            if isinstance(turn_id, str) and turn_id:
                self.turn_id = turn_id
                self._flush_signals()
        elif method == "turn/completed":
            self._close()

    def _send_thread_request(self) -> None:
        params: dict[str, Any] = {
            "approvalPolicy": "never",
            "sandbox": "danger-full-access",
        }
        if self.model:
            params["model"] = self.model
        if self.session_id:
            method = "thread/resume"
            params["threadId"] = self.session_id
        else:
            method = "thread/start"
        self._send({"method": method, "id": self.THREAD_ID, "params": params})

    def _send_turn_request(self) -> None:
        params: dict[str, Any] = {
            "threadId": self.session_id,
            "input": [{"type": "text", "text": self.prompt}],
            "approvalPolicy": "never",
            "sandboxPolicy": {"type": "dangerFullAccess"},
        }
        self._send({"method": "turn/start", "id": self.TURN_ID, "params": params})

    def _send_steer(self, message: str) -> bool:
        with self._lock:
            request_id = self._next_id
            self._next_id += 1
            thread_id = self.session_id
            turn_id = self.turn_id
        return self._send(
            {
                "method": "turn/steer",
                "id": request_id,
                "params": {
                    "threadId": thread_id,
                    "expectedTurnId": turn_id,
                    "clientUserMessageId": f"redtrace-fact-{uuid.uuid4().hex[:12]}",
                    "input": [{"type": "text", "text": message}],
                },
            }
        )

    def _flush_signals(self) -> None:
        with self._lock:
            messages = self._queued_signals
            self._queued_signals = []
        for message in messages:
            if not self._send_steer(message):
                break


def _event(channel: str, line: str) -> dict[str, Any] | None:
    if channel != "stdout":
        return None
    try:
        value = json.loads(line)
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None
