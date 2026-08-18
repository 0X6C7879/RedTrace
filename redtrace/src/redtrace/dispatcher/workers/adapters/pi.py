from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any

from redtrace.capabilities import (
    PI_MCP_EXTENSION,
    PI_PROVIDER_EXTENSION_PATH,
)
from redtrace.dispatcher.config import WorkerConfig
from redtrace.dispatcher.workers.base import DriverResult, WorkerDriver
from redtrace.dispatcher.workers.endpoint_relay import EndpointRelay
from redtrace.dispatcher.workers.health import HealthResult, http_ping, proxies_from_env
from redtrace.dispatcher.workers.live import PiLiveControl
from redtrace.skill_runtime import skill_runtime_enabled


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
        if worker.endpoint_mode == "direct":
            ok, detail = EndpointRelay.ping(env["PI_BASE_URL"], timeout=timeout)
            return HealthResult(ok=ok, status=None, detail=detail)
        base = (
            env["PI_BASE_URL"]
            .removesuffix("/v1/messages")
            .removesuffix("/responses")
            .removesuffix("/chat/completions")
        )
        model = env["PI_MODEL"]
        api = env["PI_PROVIDER_API"]
        proxies = proxies_from_env(env)
        headers = {
            "Authorization": f"Bearer {env['PI_API_KEY']}",
            "content-type": "application/json",
        }
        if "anthropic" in api:
            return http_ping(
                f"{base}/v1/messages",
                headers={**headers, "anthropic-version": "2023-06-01"},
                json_body={
                    "model": model,
                    "max_tokens": 10,
                    "messages": [{"role": "user", "content": "ping"}],
                },
                timeout=timeout,
                proxies=proxies,
            )
        if "responses" in api:
            return http_ping(
                f"{base}/responses",
                headers=headers,
                json_body={
                    "model": model,
                    "input": [{"role": "user", "content": "ping"}],
                    "stream": False,
                },
                timeout=timeout,
                proxies=proxies,
            )
        # openai-completions and anything else: OpenAI-compatible chat/completions
        return http_ping(
            f"{base}/chat/completions",
            headers=headers,
            json_body={
                "model": model,
                "max_tokens": 10,
                "messages": [{"role": "user", "content": "ping"}],
            },
            timeout=timeout,
            proxies=proxies,
        )

    def describe_health(self, worker: WorkerConfig) -> str:
        env = worker.env
        if worker.endpoint_mode == "direct":
            return f"relay -> {env['PI_BASE_URL']}"
        return f"POST {env['PI_BASE_URL']} (api={env['PI_PROVIDER_API']}, model={env['PI_MODEL']})"

    def build_execute(
        self,
        worker: WorkerConfig,
        prompt: str,
        session: str | None,
        *,
        task_type: str | None = None,
    ) -> DriverResult:
        return self._build_live(worker, prompt, session, task_type=task_type)

    def build_conclude(
        self,
        worker: WorkerConfig,
        prompt: str,
        session: str,
        *,
        task_type: str | None = None,
    ) -> DriverResult:
        return self._build_live(worker, prompt, session, task_type=task_type)

    def _build_live(
        self,
        worker: WorkerConfig,
        prompt: str,
        session: str | None,
        *,
        task_type: str | None = None,
    ) -> DriverResult:
        control = PiLiveControl(prompt, session)
        if self.local and not worker.api_configured():
            argv = self._local_argv(worker, session, task_type=task_type)
        else:
            env = worker.env
            pi_argv = [
                "--provider",
                "redtrace",
                "--model",
                env["PI_MODEL"],
                "--approve",
                *self._thinking_args(worker),
                "--mode",
                "rpc",
            ]
            if session:
                pi_argv.extend(["--session", session])
            argv = self._configured_argv(worker, pi_argv, task_type=task_type)
        pi_env_overrides: dict[str, str] | None = None
        if worker.endpoint_mode == "direct":
            relay_url = EndpointRelay.register(worker.env["PI_BASE_URL"])
            pi_env_overrides = {"PI_BASE_URL": relay_url}
        return DriverResult(
            argv=argv,
            session=session,
            stdin=control.initial_input,
            live_control=control,
            env=pi_env_overrides,
        )

    def _local_argv(
        self,
        worker: WorkerConfig,
        session: str | None,
        *,
        task_type: str | None = None,
    ) -> list[str]:
        # Native pi: no provider/model overrides, so the host login and global config win.
        argv = [
            "pi",
            "--approve",
            *self._thinking_args(worker),
            "--mode",
            "rpc",
            "--extension",
            worker.env.get("REDTRACE_PI_MCP_EXTENSION", PI_MCP_EXTENSION),
            *self._skill_args(worker, task_type),
            *self._global_instruction_args(worker, task_type),
        ]
        if session:
            argv.extend(["--session", session])
        return argv

    def extract_session(
        self, session: str | None, stdout: str, stderr: str
    ) -> str | None:
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
        saw_message_end = False
        for event in self._iter_events(stdout):
            event_type = event.get("type")
            if event_type == "message_end":
                message = event.get("message")
                if isinstance(message, dict) and message.get("role") == "assistant":
                    assistant_message = message
                    saw_message_end = True
            elif event_type == "turn_end" and not saw_message_end:
                message = event.get("message")
                if isinstance(message, dict) and message.get("role") == "assistant":
                    assistant_message = message
            elif event_type == "agent_end" and not saw_message_end:
                messages = event.get("messages")
                if isinstance(messages, list):
                    for message in reversed(messages):
                        if (
                            isinstance(message, dict)
                            and message.get("role") == "assistant"
                        ):
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

    @classmethod
    def _configured_argv(
        cls,
        worker: WorkerConfig,
        pi_argv: list[str],
        *,
        task_type: str | None = None,
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
            *cls._skill_args(worker, task_type),
            *cls._global_instruction_args(worker, task_type),
            *pi_argv,
        ]

    @staticmethod
    def _skill_args(
        worker: WorkerConfig, task_type: str | None = None
    ) -> list[str]:
        if not skill_runtime_enabled(task_type):
            return []
        try:
            paths = json.loads(worker.env.get("REDTRACE_SKILL_PATHS", "[]"))
        except json.JSONDecodeError as exc:
            raise ValueError("invalid REDTRACE_SKILL_PATHS") from exc
        if not isinstance(paths, list) or any(
            not isinstance(path, str) for path in paths
        ):
            raise ValueError("REDTRACE_SKILL_PATHS must be a JSON string array")
        return [argument for path in paths for argument in ("--skill", path)]

    @staticmethod
    def _global_instruction_args(
        worker: WorkerConfig, task_type: str | None = None
    ) -> list[str]:
        if task_type == "reason":
            return []
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
