from __future__ import annotations

import logging
import re
import subprocess
import sys
import tempfile
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from redtrace.dispatcher.audit import AuditPublisher
from redtrace.dispatcher.config import DispatchConfig, WorkerConfig
from redtrace.dispatcher.protocol.client import CairnClient
from redtrace.dispatcher.runtime.cancellation import TaskCancellation
from redtrace.dispatcher.runtime.containers import ContainerManager
from redtrace.dispatcher.runtime.heartbeat import HeartbeatLease
from redtrace.dispatcher.runtime.process import ProcessResult
from redtrace.dispatcher.workers.adapters.claudecode import CLAUDE_MAX_THINKING_TOKENS

PROCESS_COMMUNICATE_GRACE_SECONDS = 15
GRAPH_SNAPSHOT_ROOT = "/tmp/redtrace-prompts"
LOG = logging.getLogger(__name__)
SAFE_LEARNING_SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
PRIVATE_LEARNING_MARKERS = re.compile(
    r"(?i)(?:https?://|\b\d{1,3}(?:\.\d{1,3}){3}\b|flag\s*\{|"
    r"(?:password|credential|api[_-]?key|secret)\s*[:=]|"
    r"(?:^|\s)(?:/home/|/tmp/|[a-z]:[\\/]))"
)


@dataclass(slots=True)
class ConcludeWriteResult:
    status: str
    fact_id: str | None = None


def preview(text: str, limit: int = 2048) -> str:
    truncated = len(text) > limit
    compact = " ".join(text[:limit].split())
    return compact + ("..." if truncated else "")


def did_timeout(result: ProcessResult) -> bool:
    return not result.cancelled and (result.timed_out or result.returncode in (124, 137))


def is_transient_model_failure(stdout: str, stderr: str) -> bool:
    text = f"{stdout}\n{stderr}".casefold()
    return any(
        marker in text
        for marker in (
            "429",
            "502",
            "too many requests",
            "rate limit",
            "bad gateway",
            "temporarily unavailable",
            "overloaded",
            "upstream timeout",
        )
    )


def cancel_reason(result: ProcessResult, cancellation: TaskCancellation | None = None) -> str | None:
    if result.cancelled:
        return result.cancel_reason or "cancelled"
    if cancellation is not None:
        return cancellation.reason
    return None


def communicate_timeout(timeout_seconds: int, grace_seconds: int = PROCESS_COMMUNICATE_GRACE_SECONDS) -> int:
    return timeout_seconds + grace_seconds


def task_healthcheck_enabled(config: DispatchConfig) -> bool:
    if config.runtime.execution == "local":
        return False
    return config.runtime.worker_healthcheck == "startup_and_task"


def write_graph_snapshot_reference(
    container_manager: ContainerManager,
    container_name: str,
    graph_yaml: str,
    *,
    phase: str,
) -> str:
    path = f"{GRAPH_SNAPSHOT_ROOT}/{phase}-{uuid.uuid4().hex[:12]}/graph.yaml"
    written_path = container_manager.write_text_file(container_name, path, graph_yaml)
    readable_path = written_path or path
    return (
        "Graph 的 YAML snapshot 位于当前 Workspace 的以下文件：\n\n"
        f"{readable_path}\n\n"
        "使用 Graph 前读取完整文件，并将其内容作为本 Graph section 的 YAML snapshot。"
    )


def write_field_journal_learning(worker: WorkerConfig, payload: dict[str, Any]) -> bool:
    data = payload.get("data") if payload.get("accepted") is True else payload
    learning = data.get("learning") if isinstance(data, dict) else None
    if not isinstance(learning, dict):
        return False
    slug = str(learning.get("slug") or "").strip()
    summary = str(learning.get("summary") or "").strip()
    entry = str(learning.get("entry") or "").strip()
    keywords = learning.get("keywords")
    if (
        not SAFE_LEARNING_SLUG.fullmatch(slug)
        or not summary
        or len(summary) > 240
        or not entry
        or not isinstance(keywords, list)
        or any(not isinstance(keyword, str) or not keyword.strip() for keyword in keywords)
        or PRIVATE_LEARNING_MARKERS.search(f"{summary}\n{entry}")
    ):
        LOG.warning("skipping unsafe or invalid field-journal learning slug=%s", slug)
        return False
    skill_root = worker.env.get("REDTRACE_HOST_SKILLS_DIR", "").strip()
    writer = Path(skill_root) / "route-skills" / "redtrace-tools" / "field-journal" / "write.py"
    if not writer.is_file():
        LOG.warning("field-journal writer is unavailable path=%s", writer)
        return False
    temporary_name = ""
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            suffix=".md",
            delete=False,
        ) as temporary:
            temporary.write(entry)
            temporary_name = temporary.name
        completed = subprocess.run(
            [
                sys.executable,
                str(writer),
                "--slug",
                slug,
                "--summary",
                summary,
                "--keywords",
                ",".join(keyword.strip() for keyword in keywords),
                "--entry-file",
                temporary_name,
            ],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        if completed.returncode != 0:
            LOG.warning("field-journal write failed slug=%s error=%s", slug, preview(completed.stderr))
            return False
        LOG.info("field-journal learning recorded slug=%s", slug)
        return True
    except (OSError, subprocess.SubprocessError):
        LOG.warning("field-journal write failed slug=%s", slug, exc_info=True)
        return False
    finally:
        if temporary_name:
            Path(temporary_name).unlink(missing_ok=True)


def run_worker_process(
    container_manager: ContainerManager,
    container_name: str,
    worker: WorkerConfig,
    argv: list[str],
    *,
    stdin_text: str | None = None,
    client: CairnClient | None = None,
    project_id: str | None = None,
    intent_id: str | None = None,
    blackboard_revision: int = 0,
    phase: str,
    timeout_seconds: int,
    lease: HeartbeatLease | None = None,
    cancellation: TaskCancellation | None = None,
) -> ProcessResult:
    LOG.info(
        "starting container exec container=%s worker=%s phase=%s timeout=%ss",
        container_name,
        worker.name,
        phase,
        timeout_seconds,
    )
    process_env = dict(worker.env)
    process_env.pop("REDTRACE_HOST_SKILLS_DIR", None)
    if project_id is not None:
        process_env.update(
            container_manager.conversation_environment(
                project_id, worker.type, worker.name
            )
        )
    if worker.context_length is not None:
        if worker.type == "claudecode":
            process_env["CLAUDE_CODE_AUTO_COMPACT_WINDOW"] = str(
                worker.context_length
            )
        elif worker.type == "pi":
            process_env["PI_MODEL_CONTEXT_WINDOW"] = str(worker.context_length)
    if worker.type == "claudecode":
        # Run Claude Code at full extended-thinking strength. A value already
        # present in dispatch.yaml env wins over this default.
        process_env.setdefault("MAX_THINKING_TOKENS", CLAUDE_MAX_THINKING_TOKENS)
    # RedTrace workers default to Chinese thinking; override in dispatch.yaml
    # by setting REDTRACE_LANG to a different value in worker env.
    process_env.setdefault("REDTRACE_LANG", "zh-CN")
    if client is not None and project_id is not None:
        process_env.update(
            {
                "REDTRACE_PROJECT_ID": project_id,
                "REDTRACE_WORKER": worker.name,
                "REDTRACE_TASK_TYPE": phase.split("_", 1)[0],
                "REDTRACE_PHASE": phase,
                "REDTRACE_BLACKBOARD_CURSOR": str(blackboard_revision),
            }
        )
        server_url = getattr(client, "base_url", None)
        if isinstance(server_url, str) and server_url:
            process_env["REDTRACE_SERVER"] = server_url
        if intent_id is not None:
            process_env["REDTRACE_INTENT_ID"] = intent_id
    process_options: dict[str, object] = {"timeout_seconds": timeout_seconds}
    if stdin_text is not None:
        process_options["stdin_text"] = stdin_text
    process = container_manager.build_exec_process(
        container_name,
        process_env,
        argv,
        **process_options,
    )
    publisher = None
    if client is not None and project_id is not None and worker.type != "mock":
        publisher = AuditPublisher(
            client,
            project_id,
            intent_id,
            worker,
            phase,
            container_name,
            stdin_text if stdin_text is not None else (argv[-1] if argv else ""),
        )
        set_output_handler = getattr(process, "set_output_handler", None)
        if callable(set_output_handler):
            set_output_handler(publisher.handle_output)
        attach_process = getattr(publisher, "attach_process", None)
        if callable(attach_process):
            attach_process(process)
    try:
        process.start()
        if lease is not None:
            lease.attach_process(process)
        if cancellation is not None:
            cancellation.attach_process(process)
        result = process.communicate(timeout=communicate_timeout(timeout_seconds))
        if publisher is not None:
            publisher.finish(result)
        return result
    except Exception as exc:
        if publisher is not None:
            publisher.fail(exc)
        raise
    finally:
        if lease is not None:
            lease.attach_process(None)
        if cancellation is not None:
            cancellation.attach_process(None)
        if publisher is not None:
            publisher.close()


def project_allows_conclude_fallback(client: CairnClient, project_id: str, *, worker_name: str, intent_id: str) -> bool:
    project = client.get_project(project_id)
    if project.project.status == "active":
        return True
    LOG.info(
        "skip conclude fallback because project is no longer active project=%s intent=%s worker=%s status=%s",
        project_id,
        intent_id,
        worker_name,
        project.project.status,
    )
    return False


def best_effort_release_reason(client: CairnClient, project_id: str, worker_name: str) -> None:
    response = client.release_reason(project_id, worker_name)
    if not response.ok and response.status_code not in (403, 409):
        LOG.warning(
            "reason release failed project=%s worker=%s status=%s",
            project_id,
            worker_name,
            response.status_code,
        )
    elif response.ok:
        LOG.info("released reason project=%s worker=%s", project_id, worker_name)
    else:
        LOG.info(
            "reason release skipped project=%s worker=%s status=%s",
            project_id,
            worker_name,
            response.status_code,
        )


def write_conclude_result(
    client: CairnClient,
    project_id: str,
    intent_id: str,
    worker_name: str,
    description: str,
    *,
    source: str,
    phase_ms: int,
    total_ms: int | None = None,
) -> str:
    return write_conclude_result_with_fact_id(
        client,
        project_id,
        intent_id,
        worker_name,
        description,
        source=source,
        phase_ms=phase_ms,
        total_ms=total_ms,
    ).status


def write_conclude_result_with_fact_id(
    client: CairnClient,
    project_id: str,
    intent_id: str,
    worker_name: str,
    description: str,
    *,
    source: str,
    phase_ms: int,
    total_ms: int | None = None,
) -> ConcludeWriteResult:
    response = client.conclude(project_id, intent_id, worker_name, description)
    if response.ok:
        fact_id: str | None = None
        if isinstance(response.data, dict):
            fact = response.data.get("fact")
            if isinstance(fact, dict):
                candidate = fact.get("id")
                if isinstance(candidate, str) and candidate:
                    fact_id = candidate
        if total_ms is None:
            LOG.info(
                "intent concluded project=%s intent=%s worker=%s source=%s phase_ms=%s",
                project_id,
                intent_id,
                worker_name,
                source,
                phase_ms,
            )
        else:
            LOG.info(
                "intent concluded project=%s intent=%s worker=%s source=%s phase_ms=%s total_ms=%s",
                project_id,
                intent_id,
                worker_name,
                source,
                phase_ms,
                total_ms,
            )
        return ConcludeWriteResult(status="success", fact_id=fact_id)
    if response.status_code == 403:
        LOG.info(
            "project became inactive during conclude project=%s intent=%s worker=%s",
            project_id,
            intent_id,
            worker_name,
        )
    else:
        LOG.warning(
            "conclude write failed project=%s intent=%s worker=%s status=%s body=%s",
            project_id,
            intent_id,
            worker_name,
            response.status_code,
            response.text,
        )
    best_effort_release(client, project_id, intent_id, worker_name)
    return ConcludeWriteResult(status="failed", fact_id=None)


def best_effort_release(client: CairnClient, project_id: str, intent_id: str, worker_name: str) -> None:
    response = client.release(project_id, intent_id, worker_name)
    if not response.ok and response.status_code not in (403, 409):
        LOG.warning(
            "release failed project=%s intent=%s worker=%s status=%s",
            project_id,
            intent_id,
            worker_name,
            response.status_code,
        )
    elif response.ok:
        LOG.info("released intent project=%s intent=%s worker=%s", project_id, intent_id, worker_name)
    else:
        LOG.info(
            "release skipped project=%s intent=%s worker=%s status=%s",
            project_id,
            intent_id,
            worker_name,
            response.status_code,
        )
