from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

from pydantic import ValidationError
import pytest

from redtrace.capabilities import (
    CONTEXT_CLI_PATH,
    MANIFEST_PATH,
    PI_PROVIDER_EXTENSION_PATH,
    CapabilityStore,
    materialize_local_workspace,
    workspace_payload,
)
from redtrace.context_cli import __file__ as context_cli_file
from redtrace.dispatcher.config import ContextHarnessConfig, LocalConfig
from redtrace.dispatcher.prompting import add_blackboard_guidance, render_prompt
from redtrace.dispatcher.runtime.local_backend import LocalBackend
from redtrace.dispatcher.runtime.local_process import LocalProcess
from redtrace.dispatcher.runtime.stream_buffer import (
    BoundedLineEmitter,
    BoundedTextBuffer,
    TRUNCATED_STREAM_LINE,
)


CLI = Path(context_cli_file)


def _run_cli(
    tmp_path: Path,
    *arguments: str,
    enabled: bool = True,
) -> subprocess.CompletedProcess[str]:
    env = {
        **os.environ,
        "REDTRACE_CONTEXT_ARTIFACT_ROOT": str(tmp_path / "artifacts"),
        "REDTRACE_CONTEXT_HARNESS_ENABLED": "1" if enabled else "0",
        "REDTRACE_CONTEXT_INLINE_BYTES": "1024",
        "REDTRACE_CONTEXT_VISIBLE_BYTES": "2048",
        "REDTRACE_CONTEXT_QUERY_BYTES": "4096",
        "REDTRACE_CONTEXT_PARSE_BYTES": str(1024 * 1024),
    }
    return subprocess.run(
        [sys.executable, str(CLI), *arguments],
        capture_output=True,
        text=True,
        env=env,
        timeout=20,
    )


def _evidence_id(output: str) -> str:
    match = re.search(r"\bevidence=(ev-[a-zA-Z0-9-]+)", output)
    assert match is not None
    return match.group(1)


def test_large_jsonl_is_preserved_and_returns_bounded_evidence_summary(
    tmp_path: Path,
) -> None:
    script = (
        "import json\n"
        "for i in range(200):\n"
        " print(json.dumps({'template-id':'exposed-panel','info':"
        "{'name':'Exposed admin','severity':'high'},"
        "'matched-at':f'http://target/{i}'}))\n"
    )

    result = _run_cli(
        tmp_path,
        "run",
        "--kind",
        "jsonl",
        "--source",
        "http://target",
        "--",
        sys.executable,
        "-c",
        script,
    )

    assert result.returncode == 0
    assert "structured records parsed: 200" in result.stdout
    assert "high=200" in result.stdout
    evidence_id = _evidence_id(result.stdout)
    artifact_id = "ctx-" + evidence_id[3:]
    raw = (tmp_path / "artifacts" / artifact_id / "stdout.raw").read_text()
    assert len(raw.splitlines()) == 200
    metadata = json.loads(
        (tmp_path / "artifacts" / artifact_id / "metadata.json").read_text()
    )
    assert metadata["raw_bytes"] > metadata["visible_bytes"]
    assert metadata["stdout_sha256"]
    assert metadata["peak_memory_bytes"] > 0

    query = _run_cli(
        tmp_path,
        "query",
        evidence_id,
        "--keyword",
        "target/199",
        "--length",
        "1024",
    )
    assert query.returncode == 0
    assert "target/199" in query.stdout
    assert len(query.stdout.encode()) <= 1024

    metrics = _run_cli(tmp_path, "metrics")
    payload = json.loads(metrics.stdout)
    assert payload["raw_bytes"] > payload["agent_visible_bytes"]
    assert payload["token_reduction_rate"] > 0
    assert payload["additional_queries"] == 1


def test_web_capture_reports_interactive_and_dom_changes(tmp_path: Path) -> None:
    first = tmp_path / "first.html"
    first.write_text(
        "<html><title>Portal</title><h1>Login</h1>"
        "<form action='/login'><input name='user'><button>Sign in</button></form></html>",
        encoding="utf-8",
    )
    second = tmp_path / "second.html"
    second.write_text(
        "<html><title>Portal</title><h1>Admin</h1>"
        "<form action='/login'><input name='user'><input name='otp'>"
        "<button>Verify</button></form></html>",
        encoding="utf-8",
    )

    initial = _run_cli(
        tmp_path,
        "capture",
        str(first),
        "--kind",
        "web",
        "--source",
        "http://target/login",
    )
    changed = _run_cli(
        tmp_path,
        "capture",
        str(second),
        "--kind",
        "web",
        "--source",
        "http://target/login",
    )

    assert initial.returncode == changed.returncode == 0
    assert "input user" in initial.stdout
    assert "DOM change:" in changed.stdout
    assert "input otp" in changed.stdout


def test_plain_small_output_and_disabled_harness_are_transparent(
    tmp_path: Path,
) -> None:
    command = [sys.executable, "-c", "print('small output')"]

    small = _run_cli(tmp_path, "run", "--", *command)
    disabled = _run_cli(tmp_path, "run", "--", *command, enabled=False)

    assert small.returncode == disabled.returncode == 0
    assert small.stdout == disabled.stdout == "small output\n"
    assert "artifact=" not in small.stdout


def test_artifact_setup_failure_downgrades_to_raw_execution(tmp_path: Path) -> None:
    (tmp_path / "artifacts").write_text("not a directory", encoding="utf-8")

    result = _run_cli(
        tmp_path,
        "run",
        "--",
        sys.executable,
        "-c",
        "print('raw fallback')",
    )

    assert result.returncode == 0
    assert result.stdout == "raw fallback\n"


def test_binary_capture_is_never_injected_inline(tmp_path: Path) -> None:
    image = tmp_path / "page.png"
    image.write_bytes(b"\x89PNG\r\n\x1a\n" + b"x" * 4096)

    result = _run_cli(tmp_path, "capture", str(image), "--source", "page")

    assert result.returncode == 0
    assert "kind=binary" in result.stdout
    assert "binary content is preserved" in result.stdout
    assert "\x89PNG" not in result.stdout


def test_child_exit_code_and_stderr_are_preserved_as_failure_signals(
    tmp_path: Path,
) -> None:
    result = _run_cli(
        tmp_path,
        "run",
        "--kind",
        "text",
        "--",
        sys.executable,
        "-c",
        "import sys; print('permission denied', file=sys.stderr); raise SystemExit(7)",
    )

    assert result.returncode == 7
    assert "permission denied" in result.stderr


def test_context_config_is_bounded_and_exports_worker_environment() -> None:
    config = ContextHarnessConfig()
    environment = config.environment()

    assert environment["REDTRACE_CONTEXT_HARNESS_ENABLED"] == "1"
    assert environment["PYTHONUTF8"] == "1"
    assert environment["PYTHONIOENCODING"] == "utf-8"
    assert environment["LANG"] == "C.UTF-8"
    assert environment["LC_ALL"] == "C.UTF-8"
    assert int(environment["REDTRACE_CONTEXT_INLINE_BYTES"]) == config.inline_bytes
    with pytest.raises(ValidationError, match="workspace-relative"):
        ContextHarnessConfig(artifact_root="../outside")


def test_render_prompt_requires_chinese_utf8_worker_output() -> None:
    rendered = render_prompt("{task}", {"task": "执行任务"})

    assert "请优先使用简体中文回答" in rendered
    assert "用中文写入 Fact、Intent、Hint" in rendered
    assert "PowerShell `-Encoding UTF8`" in rendered


def test_render_prompt_preserves_machine_readable_json_templates() -> None:
    rendered = render_prompt('{"phase":"{phase}"}', {"phase": "reason"})

    assert json.loads(rendered) == {"phase": "reason"}
    assert "语言与编码要求" not in rendered


def test_local_backend_injects_redtrace_managed_harness_configuration(
    tmp_path: Path,
) -> None:
    config = ContextHarnessConfig(enabled=False, inline_bytes=4096)
    backend = LocalBackend(
        config=LocalConfig(workspace_root=str(tmp_path)),
        context_harness=config,
    )

    process = backend.build_exec_process(
        str(tmp_path),
        {"REDTRACE_CONTEXT_INLINE_BYTES": "999999"},
        [sys.executable, "-V"],
    )

    assert process.env["REDTRACE_CONTEXT_HARNESS_ENABLED"] == "0"
    assert process.env["REDTRACE_CONTEXT_INLINE_BYTES"] == "4096"


def test_workspace_payload_contains_one_shared_executable(tmp_path: Path) -> None:
    _, files = workspace_payload(CapabilityStore(tmp_path))

    assert CONTEXT_CLI_PATH in files
    assert files[CONTEXT_CLI_PATH].startswith(b"#!/usr/bin/env python3")


def test_frozen_local_workspace_only_refreshes_context_runtime(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    skill = workspace / ".agents" / "skills" / "frozen" / "SKILL.md"
    skill.parent.mkdir(parents=True)
    skill.write_text("frozen skill", encoding="utf-8")
    manifest_path = workspace / MANIFEST_PATH
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(
        json.dumps(
            {
                "digest": "frozen-digest",
                "snapshotFrozen": True,
                "skills": ["frozen"],
                "managedFiles": [],
            }
        ),
        encoding="utf-8",
    )

    digest = materialize_local_workspace(
        CapabilityStore(tmp_path / "capabilities"),
        workspace,
    )
    updated = json.loads(manifest_path.read_text(encoding="utf-8"))

    assert digest == "frozen-digest"
    assert skill.read_text(encoding="utf-8") == "frozen skill"
    assert (workspace / CONTEXT_CLI_PATH).is_file()
    assert (workspace / PI_PROVIDER_EXTENSION_PATH).is_file()
    assert updated["digest"] == "frozen-digest"
    assert updated["snapshotFrozen"] is True
    assert CONTEXT_CLI_PATH in updated["runtimeFiles"]
    assert PI_PROVIDER_EXTENSION_PATH in updated["runtimeFiles"]


def test_worker_stream_buffer_keeps_prefix_and_tail_with_bounded_memory() -> None:
    buffer = BoundedTextBuffer(max_chars=128, prefix_chars=32)
    buffer.append("session-id:" + "a" * 40)
    buffer.append("x" * 500)
    buffer.append("FINAL_RESULT")
    output = buffer.text()

    assert buffer.truncated
    assert buffer.total_chars > 500
    assert len(output) < 260
    assert output.startswith("session-id:")
    assert output.endswith("FINAL_RESULT")


def test_local_worker_streams_every_line_but_returns_a_bounded_result(
    tmp_path: Path,
) -> None:
    seen: list[str] = []
    process = LocalProcess(
        [
            sys.executable,
            "-c",
            "print('SESSION first'); print('x' * 20000); print('FINAL result')",
        ],
        cwd=str(tmp_path),
        env=dict(os.environ),
        timeout_seconds=10,
        max_output_chars=2048,
    )
    process.set_output_handler(
        lambda channel, line: seen.append(line) if channel == "stdout" else None
    )

    process.start()
    result = process.communicate(timeout=20)

    assert result.returncode == 0
    assert result.stdout_truncated
    assert result.stdout_bytes > 20_000
    assert result.stdout.startswith("SESSION first")
    assert result.stdout.rstrip().endswith("FINAL result")
    assert "".join(seen).startswith("SESSION first")
    assert "".join(seen).rstrip().endswith("FINAL result")


def test_live_audit_line_emitter_bounds_pathological_single_records() -> None:
    emitted: list[str] = []
    emitter = BoundedLineEmitter(emitted.append, max_line_chars=1024)

    emitter.feed("x" * 4096)
    emitter.feed("\nnormal\n")
    emitter.flush()

    assert emitted == [TRUNCATED_STREAM_LINE, "normal\n"]


def test_prompt_guidance_reuses_existing_state_and_bounded_queries() -> None:
    prompt = add_blackboard_guidance(
        "task",
        4,
        context_harness_enabled=True,
    )
    disabled = add_blackboard_guidance(
        "task",
        4,
        context_harness_enabled=False,
    )

    assert "redtrace-context run -- rtk" in prompt
    assert "Fact only for a confirmed conclusion" in prompt
    assert "parallel Idea, Memory" in prompt
    assert "native Web search/fetch" in prompt
    assert "`brave-search` Skill as the fallback" in prompt
    assert "## Active WebShell and C2 workflow" in prompt
    assert "redtrace-resource snapshot --kind webshell" in prompt
    assert "redtrace-resource webshell-create" in prompt
    assert "redtrace-resource listener-create" in prompt
    assert "`payload-oneliner` or a compiled Beacon with `payload-build`" in prompt
    assert "do not stop at that boundary" in prompt
    assert "redtrace-resource changes --since <audit_cursor>" in prompt
    assert "decision-point refresh, not a timer" in prompt
    assert "## Known-vulnerability-first exploitation" in prompt
    assert "perform at least one live Web query" in prompt
    assert "Do not install, clone, or synchronize bulk vulnerability databases" in prompt
    assert "fetch only the specific PoC/EXP" in prompt
    assert "pass that explicit template path" in prompt
    assert "never invoke automatic template discovery" in prompt
    assert "Prefer an existing PoC over inventing a new exploit" in prompt
    assert "When the PoC confirms the vulnerability" in prompt
    assert "execution order, not an approval gate" in prompt
    assert "Only move to custom vulnerability discovery" in prompt
    assert "## Missing tool bootstrap" in prompt
    assert "official documentation" in prompt
    assert "user-local installation" in prompt
    assert "`--version` and a small smoke check" in prompt
    assert "instead of looping or blocking it" in prompt
    assert "Context Harness" not in disabled


def test_context_harness_defaults_are_sized_for_long_tasks() -> None:
    config = ContextHarnessConfig()

    assert config.inline_bytes == 256 * 1024
    assert config.visible_bytes == 64 * 1024
    assert config.query_bytes == 1024 * 1024
    assert config.parse_bytes == 64 * 1024 * 1024
    assert config.worker_output_chars == 32 * 1024 * 1024
