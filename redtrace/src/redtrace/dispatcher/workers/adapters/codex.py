from __future__ import annotations

import json
import logging

from redtrace.dispatcher.config import (
    WorkerConfig,
    model_auto_compact_token_limit,
)
from redtrace.dispatcher.workers.base import (
    DriverResult,
    ProviderError,
    RegexSessionDriver,
)
from redtrace.dispatcher.workers.health import HealthResult, http_ping, proxies_from_env
from redtrace.dispatcher.workers.live import CodexLiveControl
from redtrace.dispatcher.workers.codex_compat import codex_compat_base_url
from redtrace.dispatcher.workers.endpoint_relay import EndpointRelay
from redtrace.skill_runtime import skill_runtime_enabled

LOG = logging.getLogger(__name__)

_PROVIDER_ERROR_PATTERNS = (
    "responses_feature_not_supported",
    "unsupported_feature",
    "text.format type",
    "json_schema is not supported",
    "rate_limit",
    "rate limit",
    "authentication_error",
    "invalid_api_key",
    "insufficient_quota",
)


class CodexDriver(RegexSessionDriver):
    type_name = "codex"

    def __init__(self, local: bool = False):
        self.local = local

    def local_binary(self) -> str | None:
        return "codex"

    @staticmethod
    def _long_task_args(
        worker: WorkerConfig, *, web_search: str = "live"
    ) -> list[str]:
        args = [
            "-c",
            f'web_search="{web_search}"',
        ]
        if worker.context_length is not None:
            args.extend(
                [
                    "-c",
                    f"model_context_window={worker.context_length}",
                    "-c",
                    (
                        "model_auto_compact_token_limit="
                        f"{model_auto_compact_token_limit(worker.context_length)}"
                    ),
                    "-c",
                    'model_auto_compact_token_limit_scope="total"',
                ]
            )
        return args

    def check_health(self, worker: WorkerConfig, *, timeout: float) -> HealthResult:
        env = worker.env
        if worker.endpoint_mode == "direct":
            ok, detail = EndpointRelay.ping(env["CODEX_BASE_URL"], timeout=timeout)
            return HealthResult(ok=ok, status=None, detail=detail)
        base = env["CODEX_BASE_URL"].removesuffix("/responses")
        return http_ping(
            f"{base}/responses",
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
        if worker.endpoint_mode == "direct":
            return f"relay -> {worker.env['CODEX_BASE_URL']}"
        base = worker.env["CODEX_BASE_URL"].removesuffix("/responses")
        return f"POST {base}/responses (model={worker.env['CODEX_MODEL']})"

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
        capability_args = (
            [] if worker.api_configured() else self._resource_args(worker, task_type)
        )
        model = worker.env.get("CODEX_MODEL") if worker.api_configured() else None
        control = CodexLiveControl(
            prompt,
            session_id=session,
            model=model,
        )
        if self.local and not worker.api_configured():
            return DriverResult(
                argv=[
                    "codex",
                    "app-server",
                    *self._long_task_args(worker),
                    *capability_args,
                    "-c",
                    self._custom_instructions(worker, task_type),
                ],
                session=session,
                stdin=control.initial_input,
                live_control=control,
            )
        env = worker.env
        upstream = env["CODEX_BASE_URL"]
        codex_base = upstream
        codex_env_overrides: dict[str, str] | None = None
        if worker.endpoint_mode == "direct":
            relay_url = EndpointRelay.register(upstream)
            codex_env_overrides = {"CODEX_BASE_URL": relay_url}
            codex_base = relay_url
        base_url = codex_compat_base_url(codex_base)
        return DriverResult(
            argv=[
                "codex",
                "app-server",
                *self._long_task_args(worker, web_search="disabled"),
                # Third-party Responses endpoints commonly implement the
                # standard function/MCP union but not Codex's namespace tool
                # extension or the newer web_search variant.
                "-c",
                "features.multi_agent=false",
                "-c",
                'model_provider="redtrace"',
                "-c",
                'model_providers.redtrace.name="redtrace"',
                "-c",
                'model_providers.redtrace.wire_api="responses"',
                "-c",
                'model_reasoning_effort="high"',
                "-c",
                'model_reasoning_summary="detailed"',
                "-c",
                self._custom_instructions(worker, task_type),
                "-c",
                f'model_providers.redtrace.base_url="{base_url}"',
                "-c",
                'model_providers.redtrace.env_key="OPENAI_API_KEY"',
                *capability_args,
            ],
            session=session,
            stdin=control.initial_input,
            live_control=control,
            env=codex_env_overrides,
        )

    def extract_session(
        self, session: str | None, stdout: str, stderr: str
    ) -> str | None:
        if session:
            return session
        for event in self._iter_events(stdout):
            if event.get("type") == "thread.started":
                thread_id = event.get("thread_id")
                if isinstance(thread_id, str) and thread_id:
                    return thread_id
            if event.get("method") == "thread/started":
                params = event.get("params")
                thread = params.get("thread") if isinstance(params, dict) else None
                thread_id = thread.get("id") if isinstance(thread, dict) else None
                if isinstance(thread_id, str) and thread_id:
                    return thread_id
        return super().extract_session(session, stdout, stderr)

    def extract_response_text(self, stdout: str, stderr: str) -> str:
        events = self._iter_events(stdout)
        for event in reversed(events):
            if event.get("type") == "item.completed":
                item = event.get("item")
            elif event.get("method") == "item/completed":
                params = event.get("params")
                item = params.get("item") if isinstance(params, dict) else None
            else:
                continue
            if not isinstance(item, dict) or item.get("type") not in {
                "agent_message",
                "agentMessage",
            }:
                continue
            text = item.get("text")
            if isinstance(text, str) and text.strip():
                return text
        self._raise_if_provider_error(events, stdout)
        return stdout

    @staticmethod
    def _raise_if_provider_error(events: list[dict], stdout: str) -> None:
        """Raise ``ProviderError`` when *events* contain a Codex
        app-server error instead of a valid agent response.

        This prevents error event JSON from being fed into
        ``parse_json_output`` / ``validate_*_payload`` where it would
        surface as a misleading contract violation such as
        "accepted must be true or false".
        """
        for event in events:
            error = event.get("error")
            if isinstance(error, dict):
                code = error.get("code") or ""
                message = error.get("message") or ""
                raise ProviderError(code, message, event)
            if event.get("type") == "error":
                code = event.get("code") or ""
                message = event.get("message") or event.get("error") or ""
                if isinstance(message, str) and message:
                    raise ProviderError(str(code), message, event)
            method = event.get("method")
            if isinstance(method, str) and method.startswith("turn/") and method.endswith("/failed"):
                code = method
                error_obj = event.get("error") or event.get("params", {})
                message = ""
                if isinstance(error_obj, dict):
                    message = error_obj.get("message") or error_obj.get("error") or ""
                    # params may nest a deeper error object
                    if not isinstance(message, str) or not message:
                        nested = error_obj.get("error") if isinstance(error_obj.get("error"), dict) else None
                        if nested:
                            message = nested.get("message") or nested.get("error") or ""
                if not isinstance(message, str):
                    message = str(message)
                if not message:
                    message = event.get("reason") or ""
                raise ProviderError(code, message or "turn failed", event)

        # Last resort: check raw stdout for known provider-level error
        # patterns that Codex may emit without structured events.
        lower = stdout.lower()
        for pattern in _PROVIDER_ERROR_PATTERNS:
            if pattern in lower:
                raise ProviderError("provider_error", stdout.strip()[:300])

    @staticmethod
    def _resource_args(
        worker: WorkerConfig, task_type: str | None = None
    ) -> list[str]:
        raw = worker.env.get("REDTRACE_CODEX_RESOURCE_ARGS", "[]")
        try:
            value = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError("invalid REDTRACE_CODEX_RESOURCE_ARGS") from exc
        if not isinstance(value, list) or any(
            not isinstance(item, str) for item in value
        ):
            raise ValueError("REDTRACE_CODEX_RESOURCE_ARGS must be a JSON string array")
        if skill_runtime_enabled(task_type):
            return value
        return [
            item
            for index, item in enumerate(value)
            if not (
                item.startswith("skills.config=")
                or (
                    item == "-c"
                    and index + 1 < len(value)
                    and value[index + 1].startswith("skills.config=")
                )
            )
        ]

    @staticmethod
    def _custom_instructions(
        worker: WorkerConfig, task_type: str | None = None
    ) -> str:
        instructions = "请始终使用中文进行思考、分析和回答。"
        shared = (
            ""
            if task_type == "reason"
            else worker.env.get("REDTRACE_GLOBAL_INSTRUCTIONS", "").strip()
        )
        if shared:
            instructions += "\n\n" + shared
        return f"custom_instructions={json.dumps(instructions, ensure_ascii=False)}"

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
