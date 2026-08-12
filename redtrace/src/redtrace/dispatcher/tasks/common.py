from __future__ import annotations

import json
import logging
import uuid
from dataclasses import dataclass
from pathlib import Path

from redtrace.dispatcher.audit import AuditPublisher
from redtrace.dispatcher.config import DispatchConfig, WorkerConfig
from redtrace.dispatcher.control_plane import ControlPlaneClient
from redtrace.dispatcher.runtime.cancellation import TaskCancellation
from redtrace.dispatcher.runtime.containers import ContainerManager
from redtrace.dispatcher.runtime.heartbeat import HeartbeatLease
from redtrace.dispatcher.runtime.process import ProcessResult
from redtrace.dispatcher.workers.adapters.claudecode import CLAUDE_MAX_THINKING_TOKENS

PROCESS_COMMUNICATE_GRACE_SECONDS = 15
GRAPH_SNAPSHOT_ROOT = "/tmp/redtrace-prompts"
BLACKBOARD_NOTICE_ROOT = ".redtrace/blackboard-notices"
LOG = logging.getLogger(__name__)


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


def preflight_worker(
    config: DispatchConfig,
    driver,
    worker: WorkerConfig,
    cancellation: TaskCancellation,
    lease: HeartbeatLease,
    *,
    project_id: str,
    task_type: str,
    intent_id: str | None = None,
) -> str | None:
    """Return an early task result when a worker cannot safely start."""
    if not task_healthcheck_enabled(config):
        return None

    LOG.info(
        "checking worker health project=%s intent=%s task=%s worker=%s timeout=%ss",
        project_id,
        intent_id,
        task_type,
        worker.name,
        config.runtime.healthcheck_timeout,
    )
    health = driver.check_health(
        worker,
        timeout=config.runtime.healthcheck_timeout,
    )
    if cancellation.is_cancelled:
        LOG.info(
            "%s cancelled during healthcheck project=%s intent=%s worker=%s reason=%s",
            task_type,
            project_id,
            intent_id,
            worker.name,
            cancellation.reason,
        )
        return "cancelled"
    if lease.failure is not None:
        LOG.warning(
            "heartbeat lost during %s healthcheck project=%s intent=%s worker=%s status=%s",
            task_type,
            project_id,
            intent_id,
            worker.name,
            lease.failure.status_code,
        )
        return "failed"
    if not health.ok:
        LOG.warning(
            "worker unhealthy project=%s intent=%s task=%s worker=%s status=%s detail=%s",
            project_id,
            intent_id,
            task_type,
            worker.name,
            health.status,
            health.detail,
        )
        return "unhealthy"
    return None


def blackboard_notice_path(container_name: str, identity: str) -> str:
    notice_id = uuid.uuid5(uuid.NAMESPACE_URL, identity).hex[:16]
    relative = f"{BLACKBOARD_NOTICE_ROOT}/{notice_id}.json"
    workspace = Path(container_name)
    if workspace.is_absolute():
        return str(workspace / relative)
    return f"/home/kali/workspace/{relative}"


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


def run_worker_process(
    container_manager: ContainerManager,
    container_name: str,
    worker: WorkerConfig,
    argv: list[str],
    *,
    stdin_text: str | None = None,
    client: ControlPlaneClient | None = None,
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
    if project_id is not None:
        process_env.update(
            container_manager.conversation_environment(project_id, worker.type)
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
        # present in redtrace.yaml env wins over this default.
        process_env.setdefault("MAX_THINKING_TOKENS", CLAUDE_MAX_THINKING_TOKENS)
    # RedTrace workers default to Chinese thinking; override in redtrace.yaml
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
        notice_path = blackboard_notice_path(
            container_name, f"{worker.name}:{intent_id or phase.split('_', 1)[0]}"
        )
        process_env["REDTRACE_BLACKBOARD_NOTICE"] = notice_path
        if lease is not None:
            task_type = phase.split("_", 1)[0]

            def publish_blackboard_notice(previous: int, current: int) -> None:
                payload = client.blackboard_changes(
                    project_id,
                    blackboard_revision,
                    worker=worker.name,
                    task_type=task_type,
                    intent_id=intent_id,
                )
                payload["changed"] = current > blackboard_revision
                container_manager.write_text_file(
                    container_name,
                    notice_path,
                    json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                )

            if lease.watch_blackboard(
                blackboard_revision, publish_blackboard_notice
            ):
                container_manager.write_text_file(
                    container_name,
                    notice_path,
                    json.dumps(
                        {
                            "project": project_id,
                            "since": blackboard_revision,
                            "revision": blackboard_revision,
                            "changed": False,
                            "changes": [],
                        },
                        separators=(",", ":"),
                    ),
                )
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
            argv[-1] if argv else "",
        )
        set_output_handler = getattr(process, "set_output_handler", None)
        if callable(set_output_handler):
            set_output_handler(publisher.handle_output)
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


def project_allows_conclude_fallback(client: ControlPlaneClient, project_id: str, *, worker_name: str, intent_id: str) -> bool:
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


def best_effort_release_reason(client: ControlPlaneClient, project_id: str, worker_name: str) -> None:
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
    client: ControlPlaneClient,
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
    client: ControlPlaneClient,
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


def best_effort_release(client: ControlPlaneClient, project_id: str, intent_id: str, worker_name: str) -> None:
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
