from __future__ import annotations

import json
from pathlib import PurePosixPath
from typing import Any

from redtrace.capabilities import PI_MCP_EXTENSION, PI_PROVIDER_EXTENSION_PATH
from redtrace.dispatcher.config import WorkerConfig
from redtrace.dispatcher.workers.base import DriverResult, WorkerDriver
from redtrace.dispatcher.workers.health import HealthResult, http_ping, proxies_from_env


class PiDriver(WorkerDriver):
    type_name = "pi"

    def __init__(self, local: bool = False):
        self.local = local

    def local_binary(self) -> str | None:
        return "pi"

    def check_health(self, worker: WorkerConfig, *, timeout: float) -> HealthResult:
        env = worker.env
        base = env["PI_BASE_URL"].rstrip("/")
        model = env["PI_MODEL"]
        api = env["PI_PROVIDER_API"]
        proxies = proxies_from_env(env)
        headers = {"Authorization": f"Bearer {env['PI_API_KEY']}", "content-type": "application/json"}
        if "anthropic" in api:
            return http_ping(
                f"{base}/v1/messages",
                headers={**headers, "anthropic-version": "2023-06-01"},
                json_body={"model": model, "max_tokens": 10, "messages": [{"role": "user", "content": "ping"}]},
                timeout=timeout,
                proxies=proxies,
            )
        if "responses" in api:
            return http_ping(
                f"{base}/responses",
                headers=headers,
                json_body={"model": model, "input": [{"role": "user", "content": "ping"}], "stream": False},
                timeout=timeout,
                proxies=proxies,
            )
        # openai-completions and anything else: OpenAI-compatible chat/completions
        return http_ping(
            f"{base}/chat/completions",
            headers=headers,
            json_body={"model": model, "max_tokens": 10, "messages": [{"role": "user", "content": "ping"}]},
            timeout=timeout,
            proxies=proxies,
        )

    def describe_health(self, worker: WorkerConfig) -> str:
        env = worker.env
        return f"POST {env['PI_BASE_URL']} (api={env['PI_PROVIDER_API']}, model={env['PI_MODEL']})"

    def build_execute(self, worker: WorkerConfig, prompt: str, session: str | None) -> DriverResult:
        if self.local and not worker.api_configured():
            return DriverResult(argv=self._local_argv(worker, prompt, session), session=session)
        env = worker.env
        argv = [
            "--provider",
            "redtrace",
            "--model",
            env["PI_MODEL"],
            "--approve",
            "--mode",
            "json",
            "--session-dir",
            self._session_dir(worker),
        ]
        if session:
            argv.extend(["--session", session])
        argv.extend(["-p", prompt])
        return DriverResult(argv=self._configured_argv(argv), session=session)

    def build_conclude(self, worker: WorkerConfig, prompt: str, session: str) -> list[str]:
        if self.local and not worker.api_configured():
            return self._local_argv(worker, prompt, session)
        env = worker.env
        argv = [
            "--provider",
            "redtrace",
            "--model",
            env["PI_MODEL"],
            "--approve",
            "--mode",
            "json",
            "--session-dir",
            self._session_dir(worker),
            "--session",
            session,
            "-p",
            prompt,
        ]
        return self._configured_argv(argv)

    def _local_argv(self, worker: WorkerConfig, prompt: str, session: str | None) -> list[str]:
        # Native pi: no provider/model overrides, so the host login and global config win.
        session_dir = self._session_dir(worker)
        argv = [
            "pi",
            "--approve",
            "--mode",
            "json",
            "--session-dir",
            session_dir,
            "--extension",
            PI_MCP_EXTENSION,
        ]
        if session:
            argv.extend(["--session", session])
        argv.extend(["-p", prompt])
        return argv

    def extract_session(self, session: str | None, stdout: str, stderr: str) -> str | None:
        if session:
            return session
        for event in self._iter_events(stdout):
            if event.get("type") != "session":
                continue
            session_id = event.get("id")
            if isinstance(session_id, str) and session_id:
                return session_id
        return None

    def extract_response_text(self, stdout: str, stderr: str) -> str:
        assistant_message: dict[str, Any] | None = None
        for event in self._iter_events(stdout):
            event_type = event.get("type")
            if event_type == "turn_end":
                message = event.get("message")
                if isinstance(message, dict) and message.get("role") == "assistant":
                    assistant_message = message
            elif event_type == "agent_end":
                messages = event.get("messages")
                if isinstance(messages, list):
                    for message in reversed(messages):
                        if isinstance(message, dict) and message.get("role") == "assistant":
                            assistant_message = message
                            break
        if assistant_message is None:
            return stdout
        content = assistant_message.get("content")
        if not isinstance(content, list):
            return stdout
        parts: list[str] = []
        for item in content:
            if not isinstance(item, dict):
                continue
            if item.get("type") != "text":
                continue
            text = item.get("text")
            if isinstance(text, str) and text:
                parts.append(text)
        return "\n".join(parts).strip() or stdout

    @staticmethod
    def _configured_argv(pi_argv: list[str]) -> list[str]:
        return [
            "pi",
            "--extension",
            PI_MCP_EXTENSION,
            "--extension",
            PI_PROVIDER_EXTENSION_PATH,
            *pi_argv,
        ]

    @staticmethod
    def _session_dir(worker: WorkerConfig) -> str:
        return str(
            PurePosixPath(".redtrace")
            / "pi"
            / "sessions"
            / worker.name
        )

    @staticmethod
    def _iter_events(stdout: str) -> list[dict[str, Any]]:
        events: list[dict[str, Any]] = []
        for line in stdout.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(payload, dict):
                events.append(payload)
        return events
