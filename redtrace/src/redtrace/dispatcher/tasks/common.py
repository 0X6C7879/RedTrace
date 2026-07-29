from __future__ import annotations

import logging
import time
import uuid
from dataclasses import dataclass

from redtrace.dispatcher.config import DispatchConfig, WorkerConfig
from redtrace.dispatcher.audit import AuditPublisher
from redtrace.dispatcher.contracts import extract_skill_feedback
from redtrace.dispatcher.protocol.client import CairnClient
from redtrace.dispatcher.runtime.cancellation import TaskCancellation
from redtrace.dispatcher.runtime.containers import ContainerManager
from redtrace.dispatcher.runtime.heartbeat import HeartbeatLease
from redtrace.dispatcher.runtime.process import ProcessResult

PROCESS_COMMUNICATE_GRACE_SECONDS = 15
LOG_PREVIEW_LIMIT = 1200
GRAPH_SNAPSHOT_ROOT = "/tmp/redtrace-prompts"
LOG = logging.getLogger(__name__)


@dataclass(slots=True)
class ConcludeWriteResult:
    status: str
    fact_id: str | None = None


def preview(text: str, limit: int = LOG_PREVIEW_LIMIT) -> str:
    compact = " ".join(text.split())
    if len(compact) <= limit:
        return compact
    return compact[:limit] + "..."


def queue_skill_feedback(
    client: CairnClient,
    payload: dict,
    *,
    project_id: str,
    intent_id: str | None,
    worker_name: str,
    task_type: str,
) -> None:
    """Best-effort handoff after model output; feedback can never fail the task."""
    feedback = extract_skill_feedback(payload)
    if feedback is None:
        return
    try:
        response = client.submit_skill_feedback(
            feedback,
            project_id=project_id,
            intent_id=intent_id,
            worker=worker_name,
            task_type=task_type,
        )
        if not response.ok:
            LOG.debug(
                "Skill feedback not queued project=%s intent=%s worker=%s "
                "status=%s",
                project_id,
                intent_id,
                worker_name,
                response.status_code,
            )
    except Exception:
        LOG.debug("Skill feedback handoff failed", exc_info=True)


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
        "The graph YAML snapshot is stored in this file inside the current workspace:\n\n"
        f"{readable_path}\n\n"
        "Before using the graph, read the entire file and treat its contents as the YAML snapshot "
        "for this Graph section."
    )


def run_worker_process(
    container_manager: ContainerManager,
    container_name: str,
    worker: WorkerConfig,
    argv: list[str],
    *,
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
    process = container_manager.build_exec_process(
        container_name,
        process_env,
        argv,
        timeout_seconds=timeout_seconds,
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
