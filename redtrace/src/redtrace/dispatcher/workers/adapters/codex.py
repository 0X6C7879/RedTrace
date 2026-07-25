from __future__ import annotations

import json

from redtrace.capabilities import CapabilityStore, codex_mcp_overrides
from redtrace.dispatcher.config import WorkerConfig
from redtrace.dispatcher.workers.base import DriverResult, RegexSessionDriver
from redtrace.dispatcher.workers.health import HealthResult, http_ping, proxies_from_env


class CodexDriver(RegexSessionDriver):
    type_name = "codex"

    def __init__(self, local: bool = False):
        self.local = local

    def local_binary(self) -> str | None:
        return "codex"

    def check_health(self, worker: WorkerConfig, *, timeout: float) -> HealthResult:
        env = worker.env
        return http_ping(
            f"{env['CODEX_BASE_URL']}/responses",
            headers={
                "Authorization": f"Bearer {env['OPENAI_API_KEY']}",
                "content-type": "application/json",
            },
            json_body={
                "model": env["CODEX_MODEL"],
                "input": [{"role": "user", "content": "ping"}],
                "stream": False,
            },
            timeout=timeout,
            proxies=proxies_from_env(env),
        )

    def describe_health(self, worker: WorkerConfig) -> str:
        return f"POST {worker.env['CODEX_BASE_URL']}/responses (model={worker.env['CODEX_MODEL']})"

    def build_execute(self, worker: WorkerConfig, prompt: str, session: str | None) -> DriverResult:
        capability_args = codex_mcp_overrides(CapabilityStore().list_mcp())
        if self.local:
            return DriverResult(
                argv=[
                    "codex",
                    "exec",
                    "--json",
                    "--dangerously-bypass-approvals-and-sandbox",
                    *capability_args,
                    "--",
                    prompt,
                ]
            )
        env = worker.env
        return DriverResult(
            argv=[
                "codex",
                "exec",
                "--json",
                "--dangerously-bypass-approvals-and-sandbox",
                "--model",
                env["CODEX_MODEL"],
                "-c",
                'model_provider="redtrace"',
                "-c",
                'model_providers.redtrace.name="redtrace"',
                "-c",
                'model_providers.redtrace.wire_api="responses"',
                "-c",
                'model_reasoning_effort="high"',
                "-c",
                f'model_providers.redtrace.base_url="{env["CODEX_BASE_URL"]}"',
                "-c",
                'model_providers.redtrace.env_key="OPENAI_API_KEY"',
                *capability_args,
                "--",
                prompt,
            ]
        )

    def build_conclude(self, worker: WorkerConfig, prompt: str, session: str) -> list[str]:
        capability_args = codex_mcp_overrides(CapabilityStore().list_mcp())
        if self.local:
            return [
                "codex",
                "exec",
                "--json",
                "resume",
                session,
                "--dangerously-bypass-approvals-and-sandbox",
                *capability_args,
                "--",
                prompt,
            ]
        env = worker.env
        return [
            "codex",
            "exec",
            "--json",
            "resume",
            session,
            "--dangerously-bypass-approvals-and-sandbox",
            "--model",
            env["CODEX_MODEL"],
            "-c",
            'model_provider="redtrace"',
            "-c",
            'model_providers.redtrace.name="redtrace"',
            "-c",
            'model_providers.redtrace.wire_api="responses"',
            "-c",
            'model_reasoning_effort="high"',
            "-c",
            f'model_providers.redtrace.base_url="{env["CODEX_BASE_URL"]}"',
            "-c",
            'model_providers.redtrace.env_key="OPENAI_API_KEY"',
            *capability_args,
            "--",
            prompt,
        ]

    def extract_session(self, session: str | None, stdout: str, stderr: str) -> str | None:
        if session:
            return session
        for event in self._iter_events(stdout):
            if event.get("type") == "thread.started":
                thread_id = event.get("thread_id")
                if isinstance(thread_id, str) and thread_id:
                    return thread_id
        return super().extract_session(session, stdout, stderr)

    def extract_response_text(self, stdout: str, stderr: str) -> str:
        for event in reversed(self._iter_events(stdout)):
            if event.get("type") != "item.completed":
                continue
            item = event.get("item")
            if not isinstance(item, dict) or item.get("type") != "agent_message":
                continue
            text = item.get("text")
            if isinstance(text, str) and text.strip():
                return text
        return stdout

    @staticmethod
    def _iter_events(stdout: str) -> list[dict]:
        events = []
        for line in stdout.splitlines():
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(payload, dict):
                events.append(payload)
        return events
