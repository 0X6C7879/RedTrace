from __future__ import annotations

import json
import os

from redtrace.capabilities import CLAUDE_MCP_PATH
from redtrace.dispatcher.config import WorkerConfig
from redtrace.dispatcher.workers.base import (
    REDTRACE_OUTPUT_SCHEMA_OBJECT,
    DriverResult,
    SeedSessionDriver,
)
from redtrace.dispatcher.workers.health import HealthResult, http_ping, proxies_from_env
from redtrace.dispatcher.workers.live import ClaudeLiveControl
from redtrace.skill_runtime import skill_runtime_enabled

ANTHROPIC_VERSION = "2023-06-01"
# Maximum extended-thinking budget for Claude Code workers. Setting
# MAX_THINKING_TOKENS turns extended thinking on; 31999 is the largest budget
# Claude Code accepts, so RedTrace workers always run at full thinking
# strength unless an operator overrides the variable in redtrace.yaml env.
CLAUDE_MAX_THINKING_TOKENS = "31999"
if not hasattr(os, "geteuid"):
    os.geteuid = lambda: -1  # type: ignore[attr-defined]
REDTRACE_OUTPUT_SCHEMA = json.dumps(
    REDTRACE_OUTPUT_SCHEMA_OBJECT, separators=(",", ":")
)


class ClaudeCodeDriver(SeedSessionDriver):
    type_name = "claudecode"

    def __init__(self, local: bool = False):
        self.local = local

    def local_binary(self) -> str | None:
        return "claude"

    @staticmethod
    def _permission_args(task_type: str | None = None) -> list[str]:
        # Claude Code rejects bypassPermissions/--dangerously-skip-permissions
        # when executed as root. WSL deployments intentionally run RedTrace as
        # root, so use its non-interactive deny-by-default mode with the
        # workspace tools explicitly allowed instead.
        if task_type == "reason" or (hasattr(os, "geteuid") and os.geteuid() == 0):
            tools = [
                "--permission-mode",
                "dontAsk",
                "--allowedTools",
                "Bash(*)",
                "Read",
                "Edit",
                "Write",
                "Glob",
                "Grep",
                "NotebookEdit",
                "Agent",
                "Task",
                "WebFetch",
                "WebSearch",
                "mcp__*",
            ]
            if skill_runtime_enabled(task_type):
                tools.append("Skill")
            return tools
        return ["--dangerously-skip-permissions"]

    def check_health(self, worker: WorkerConfig, *, timeout: float) -> HealthResult:
        env = worker.env
        return http_ping(
            f"{env['ANTHROPIC_BASE_URL']}/v1/messages",
            headers={
                "Authorization": f"Bearer {env['ANTHROPIC_AUTH_TOKEN']}",
                "anthropic-version": ANTHROPIC_VERSION,
                "content-type": "application/json",
            },
            json_body={
                "model": env["ANTHROPIC_MODEL"],
                "max_tokens": 10,
                "messages": [{"role": "user", "content": "ping"}],
            },
            timeout=timeout,
            proxies=proxies_from_env(env),
        )

    def describe_health(self, worker: WorkerConfig) -> str:
        return f"POST {worker.env['ANTHROPIC_BASE_URL']}/v1/messages (model={worker.env['ANTHROPIC_MODEL']})"

    def build_execute(
        self,
        worker: WorkerConfig,
        prompt: str,
        session: str | None,
        *,
        task_type: str | None = None,
    ) -> DriverResult:
        assert session is not None
        control = ClaudeLiveControl(prompt, session)
        model_args = (
            ["--model", worker.env["ANTHROPIC_MODEL"]]
            if worker.api_configured()
            else []
        )
        argv = [
            "claude",
            "--session-id",
            session,
            *self._permission_args(task_type),
            *model_args,
            "--mcp-config",
            self._mcp_config(worker),
            *self._plugin_args(worker, task_type),
            *self._global_instruction_args(worker, task_type),
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--json-schema",
            REDTRACE_OUTPUT_SCHEMA,
        ]
        return DriverResult(
            argv=argv,
            session=session,
            stdin=control.initial_input,
            live_control=control,
        )

    def build_conclude(
        self,
        worker: WorkerConfig,
        prompt: str,
        session: str,
        *,
        task_type: str | None = None,
    ) -> DriverResult:
        control = ClaudeLiveControl(prompt, session)
        model_args = (
            ["--model", worker.env["ANTHROPIC_MODEL"]]
            if worker.api_configured()
            else []
        )
        argv = [
            "claude",
            "-r",
            session,
            *self._permission_args(task_type),
            *model_args,
            "--mcp-config",
            self._mcp_config(worker),
            *self._plugin_args(worker, task_type),
            *self._global_instruction_args(worker, task_type),
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--json-schema",
            REDTRACE_OUTPUT_SCHEMA,
        ]
        return DriverResult(
            argv=argv,
            session=session,
            stdin=control.initial_input,
            live_control=control,
        )

    @classmethod
    def _mcp_config(cls, worker: WorkerConfig) -> str:
        return worker.env.get("REDTRACE_CLAUDE_MCP_CONFIG", CLAUDE_MCP_PATH)

    @classmethod
    def _plugin_args(
        cls, worker: WorkerConfig, task_type: str | None = None
    ) -> list[str]:
        if not skill_runtime_enabled(task_type):
            return []
        plugin_dir = worker.env.get("REDTRACE_CLAUDE_PLUGIN_DIR")
        return ["--plugin-dir", plugin_dir] if plugin_dir else []

    @staticmethod
    def _global_instruction_args(
        worker: WorkerConfig, task_type: str | None = None
    ) -> list[str]:
        if task_type == "reason":
            return []
        instructions = worker.env.get("REDTRACE_GLOBAL_INSTRUCTIONS", "").strip()
        return ["--append-system-prompt", instructions] if instructions else []

    def extract_response_text(self, stdout: str, stderr: str) -> str:
        for line in reversed(stdout.splitlines()):
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(payload, dict) and payload.get("type") == "result":
                structured = payload.get("structured_output")
                if isinstance(structured, dict):
                    return json.dumps(structured, ensure_ascii=False)
                if isinstance(structured, str) and structured.strip():
                    return structured
                result = payload.get("result")
                if isinstance(result, str) and result.strip():
                    return result
        return stdout
