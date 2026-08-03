from __future__ import annotations

import json
import os

from redtrace.capabilities import CLAUDE_MCP_PATH
from redtrace.dispatcher.config import WorkerConfig
from redtrace.dispatcher.workers.base import DriverResult, SeedSessionDriver
from redtrace.dispatcher.workers.health import HealthResult, http_ping, proxies_from_env

ANTHROPIC_VERSION = "2023-06-01"
if not hasattr(os, "geteuid"):
    os.geteuid = lambda: -1  # type: ignore[attr-defined]
REDTRACE_OUTPUT_SCHEMA = json.dumps(
    {
        "type": "object",
        "properties": {
            "accepted": {"type": "boolean"},
            "data": {"type": "object"},
        },
        "required": ["accepted", "data"],
        "additionalProperties": False,
    },
    separators=(",", ":"),
)


class ClaudeCodeDriver(SeedSessionDriver):
    type_name = "claudecode"

    def __init__(self, local: bool = False):
        self.local = local

    def local_binary(self) -> str | None:
        return "claude"

    @staticmethod
    def _permission_args() -> list[str]:
        # Claude Code rejects bypassPermissions/--dangerously-skip-permissions
        # when executed as root. WSL deployments intentionally run RedTrace as
        # root, so use its non-interactive deny-by-default mode with the
        # workspace tools explicitly allowed instead.
        if hasattr(os, "geteuid") and os.geteuid() == 0:
            return [
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
                "Skill",
                "WebFetch",
                "WebSearch",
                "mcp__*",
            ]
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

    def build_execute(self, worker: WorkerConfig, prompt: str, session: str | None) -> DriverResult:
        assert session is not None
        model_args = (
            ["--model", worker.env["ANTHROPIC_MODEL"]]
            if worker.api_configured()
            else []
        )
        argv = [
                "claude",
                "--session-id",
                session,
                *self._permission_args(),
                *model_args,
                "--mcp-config",
                self._mcp_config(worker),
                *self._plugin_args(worker),
                "-p",
                "--output-format",
                "stream-json",
                "--verbose",
                "--include-partial-messages",
                "--json-schema",
                REDTRACE_OUTPUT_SCHEMA,
            ]
        if not self.local:
            argv.extend(["--", prompt])
        return DriverResult(
            argv=argv,
            session=session,
            stdin=prompt if self.local else None,
        )

    def build_conclude(
        self,
        worker: WorkerConfig,
        prompt: str,
        session: str,
    ) -> DriverResult:
        model_args = (
            ["--model", worker.env["ANTHROPIC_MODEL"]]
            if worker.api_configured()
            else []
        )
        argv = [
            "claude",
            "-r",
            session,
            *self._permission_args(),
            *model_args,
            "--mcp-config",
            self._mcp_config(worker),
            *self._plugin_args(worker),
            "-p",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--json-schema",
            REDTRACE_OUTPUT_SCHEMA,
        ]
        if not self.local:
            argv.extend(["--", prompt])
        return DriverResult(
            argv=argv,
            session=session,
            stdin=prompt if self.local else None,
        )

    @classmethod
    def _mcp_config(cls, worker: WorkerConfig) -> str:
        return worker.env.get("REDTRACE_CLAUDE_MCP_CONFIG", CLAUDE_MCP_PATH)

    @classmethod
    def _plugin_args(cls, worker: WorkerConfig) -> list[str]:
        plugin_dir = worker.env.get("REDTRACE_CLAUDE_PLUGIN_DIR")
        return ["--plugin-dir", plugin_dir] if plugin_dir else []

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
