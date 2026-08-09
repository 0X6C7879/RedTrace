from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any

from redtrace.capabilities import (
    PI_MCP_EXTENSION,
    PI_PROVIDER_EXTENSION_PATH,
)
from redtrace.dispatcher.config import WorkerConfig
from redtrace.dispatcher.output_parser import extract_json_object
from redtrace.dispatcher.workers.base import DriverResult, WorkerDriver
from redtrace.dispatcher.workers.health import HealthResult, http_ping, proxies_from_env


class PiDriver(WorkerDriver):
    type_name = "pi"

    # Pi thinking levels accepted by `pi --thinking`, weakest to strongest.
    THINKING_LEVELS = frozenset(
        {"off", "minimal", "low", "medium", "high", "xhigh", "max"}
    )

    def __init__(self, local: bool = False):
        self.local = local

    def local_binary(self) -> str | None:
        return "pi"

    @classmethod
    def _thinking_args(cls, worker: WorkerConfig) -> list[str]:
        # Workers run at full thinking strength by default; operators can
        # override (or disable) via REDTRACE_PI_THINKING_LEVEL in dispatch env.
        level = str(worker.env.get("REDTRACE_PI_THINKING_LEVEL", "max")).strip().lower()
        if level not in cls.THINKING_LEVELS:
            level = "max"
        return ["--thinking", level]

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
            return DriverResult(
                argv=self._local_argv(worker, prompt, session),
                session=session,
                stdin=prompt,
            )
        env = worker.env
        argv = [
            "--provider",
            "redtrace",
            "--model",
            env["PI_MODEL"],
            "--approve",
            *self._thinking_args(worker),
            "--mode",
            "json",
        ]
        if session:
            argv.extend(["--session", session])
        argv.extend(["-p", prompt])
        return DriverResult(argv=self._configured_argv(worker, argv), session=session)

    def build_conclude(
        self,
        worker: WorkerConfig,
        prompt: str,
        session: str,
    ) -> DriverResult:
        if self.local and not worker.api_configured():
            return DriverResult(
                argv=self._local_argv(worker, prompt, session),
                session=session,
                stdin=prompt,
            )
        env = worker.env
        argv = [
            "--provider",
            "redtrace",
            "--model",
            env["PI_MODEL"],
            "--approve",
            *self._thinking_args(worker),
            "--mode",
            "json",
            "--session",
            session,
            "-p",
            prompt,
        ]
        return DriverResult(
            argv=self._configured_argv(worker, argv),
            session=session,
        )

    def _local_argv(self, worker: WorkerConfig, prompt: str, session: str | None) -> list[str]:
        # Native pi: no provider/model overrides, so the host login and global config win.
        argv = [
            "pi",
            "--approve",
            *self._thinking_args(worker),
            "--mode",
            "json",
            "--extension",
            worker.env.get("REDTRACE_PI_MCP_EXTENSION", PI_MCP_EXTENSION),
            *self._skill_args(worker),
            *self._global_instruction_args(worker),
        ]
        if session:
            argv.extend(["--session", session])
        argv.append("-p")
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
        text = "\n".join(parts).strip() or stdout
        if '"accepted"' not in text:
            return text
        try:
            payload = extract_json_object(text)
        except (TypeError, ValueError):
            return text
        return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))

    @classmethod
    def _configured_argv(
        cls,
        worker: WorkerConfig,
        pi_argv: list[str],
    ) -> list[str]:
        return [
            "pi",
            "--extension",
            worker.env.get(
                "REDTRACE_PI_PROVIDER_EXTENSION",
                PI_PROVIDER_EXTENSION_PATH,
            ),
            "--extension",
            worker.env.get("REDTRACE_PI_MCP_EXTENSION", PI_MCP_EXTENSION),
            *cls._skill_args(worker),
            *cls._global_instruction_args(worker),
            *pi_argv,
        ]

    @staticmethod
    def _skill_args(worker: WorkerConfig) -> list[str]:
        try:
            paths = json.loads(worker.env.get("REDTRACE_SKILL_PATHS", "[]"))
        except json.JSONDecodeError as exc:
            raise ValueError("invalid REDTRACE_SKILL_PATHS") from exc
        if not isinstance(paths, list) or any(not isinstance(path, str) for path in paths):
            raise ValueError("REDTRACE_SKILL_PATHS must be a JSON string array")
        return [argument for path in paths for argument in ("--skill", path)]

    @staticmethod
    def _global_instruction_args(worker: WorkerConfig) -> list[str]:
        instructions = worker.env.get("REDTRACE_GLOBAL_INSTRUCTIONS", "").strip()
        return ["--append-system-prompt", instructions] if instructions else []

    @staticmethod
    def _iter_events(stdout: str) -> Iterator[dict[str, Any]]:
        for line in stdout.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(payload, dict):
                yield payload
