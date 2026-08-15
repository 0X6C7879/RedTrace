from __future__ import annotations

import logging
import re
import time

from redtrace.board.models import Intent, ProjectDetail
from redtrace.dispatcher.config import DispatchConfig, WorkerConfig
from redtrace.dispatcher.contracts import parse_json_output, validate_explore_payload
from redtrace.dispatcher.control_plane import ControlPlaneClient
from redtrace.dispatcher.prompting import (
    add_blackboard_guidance,
    format_hints,
    load_prompt,
    render_prompt,
)
from redtrace.dispatcher.runtime.cancellation import TaskCancellation
from redtrace.dispatcher.runtime.containers import ContainerManager
from redtrace.dispatcher.runtime.heartbeat import HeartbeatLease
from redtrace.dispatcher.tasks.common import (
    BlackboardInbox,
    best_effort_release,
    cancel_reason,
    did_timeout,
    preflight_worker,
    exception_failure_outcome,
    ensure_worker_running,
    project_allows_conclude_fallback,
    preview,
    process_failure_outcome,
    record_session_checkpoint,
    run_learning_checkpoint,
    run_worker_process,
    write_conclude_result,
    write_graph_snapshot_reference,
)
from redtrace.dispatcher.workers.registry import get_driver

LOG = logging.getLogger(__name__)
_ACCESS_CHANNEL = re.compile(
    r"web\s*shell|reverse\s*shell|c2\s*session|反弹\s*shell|反向\s*shell|持久.{0,8}通道",
    re.IGNORECASE,
)
_ACCESS_RESOURCE_ID = re.compile(r"\b(?:ws|ses)_[0-9a-f]{12}\b", re.IGNORECASE)


def run_explore_task(
    config: DispatchConfig,
    client: ControlPlaneClient,
    container_manager: ContainerManager,
    project: ProjectDetail,
    export_yaml: str,
    intent: Intent,
    worker: WorkerConfig,
    cancellation: TaskCancellation,
) -> str:
    driver = get_driver(worker.type, config.runtime.execution)
    task_started = time.perf_counter()
    container_name: str | None = None
    session: str | None = None
    checkpoint_due = False
    lease = HeartbeatLease.for_intent(
        client, project.project.id, intent.id, worker.name, config.runtime.interval
    )
    inbox: BlackboardInbox | None = None
    lease.start()
    try:
        container_name = ensure_worker_running(
            container_manager, project.project.id, worker
        )

        early_result = preflight_worker(
            config,
            driver,
            worker,
            cancellation,
            lease,
            project_id=project.project.id,
            task_type="explore",
            intent_id=intent.id,
        )
        if early_result is not None:
            best_effort_release(client, project.project.id, intent.id, worker.name)
            return early_result

        graph_reference = write_graph_snapshot_reference(
            container_manager,
            container_name,
            export_yaml.strip(),
            phase="explore_execute",
        )
        if worker.type != "mock" and callable(
            getattr(client, "wait_for_blackboard", None)
        ):
            inbox = BlackboardInbox(
                client,
                container_manager,
                container_name,
                project_id=project.project.id,
                intent_id=intent.id,
                intent_description=intent.description,
                source_fact_ids=intent.from_,
                worker_name=worker.name,
                revision=project.blackboard_revision,
            )
        prompt = render_prompt(
            load_prompt(config.runtime.prompt_group, "explore.md"),
            {
                "graph_yaml": graph_reference,
                "intent_id": intent.id,
                "intent_description": intent.description,
            },
        )
        if worker.type != "mock":
            prompt = add_blackboard_guidance(
                prompt,
                project.blackboard_revision,
                task_type="explore",
                context_harness_enabled=config.context_harness.enabled,
                local_execution=config.runtime.execution == "local",
                hints=format_hints([hint.model_dump() for hint in project.hints]),
            )

        session = driver.prepare_session()
        execute = driver.build_execute(
            worker, prompt, session, task_type="explore"
        )
        session = execute.session
        checkpoint_due = True
        execute_started = time.perf_counter()
        first, session = _run_with_steering(
            driver,
            client,
            project.project.id,
            intent.id,
            container_manager,
            container_name,
            worker,
            execute,
            session=session,
            phase="explore_execute",
            timeout=config.tasks.explore.timeout,
            lease=lease,
            cancellation=cancellation,
            blackboard_revision=project.blackboard_revision,
            inbox=inbox,
        )
        execute_ms = int((time.perf_counter() - execute_started) * 1000)
        session = driver.extract_session(session, first.stdout, first.stderr)
        record_session_checkpoint(
            client,
            container_manager,
            project.project.id,
            intent.id,
            worker,
            session,
            "execute_end",
        )
        cancelled = cancel_reason(first, cancellation)
        if cancelled is not None:
            LOG.info(
                "explore cancelled project=%s intent=%s worker=%s reason=%s execute_ms=%s",
                project.project.id,
                intent.id,
                worker.name,
                cancelled,
                execute_ms,
            )
            best_effort_release(client, project.project.id, intent.id, worker.name)
            return "cancelled"
        if lease.failure is not None:
            LOG.warning(
                "heartbeat lost during explore project=%s intent=%s worker=%s status=%s execute_ms=%s",
                project.project.id,
                intent.id,
                worker.name,
                lease.failure.status_code,
                execute_ms,
            )
            best_effort_release(client, project.project.id, intent.id, worker.name)
            return "heartbeat_loss"
        if not did_timeout(first) and first.returncode == 0:
            try:
                model_output = driver.extract_response_text(first.stdout, first.stderr)
                payload = parse_json_output(model_output)
                kind, description = validate_explore_payload(payload)
            except Exception as exc:
                LOG.warning(
                    "explore parse failed project=%s intent=%s worker=%s error=%s execute_ms=%s total_ms=%s stdout_preview=%s stderr_preview=%s",
                    project.project.id,
                    intent.id,
                    worker.name,
                    exc,
                    execute_ms,
                    int((time.perf_counter() - task_started) * 1000),
                    preview(first.stdout),
                    preview(first.stderr),
                )
                return _try_conclude_fallback(
                    config,
                    client,
                    container_manager,
                    container_name,
                    worker,
                    driver,
                    project.project.id,
                    intent,
                    graph_reference,
                    session,
                    lease,
                    cancellation,
                    inbox=inbox,
                )
            if kind == "rejected":
                LOG.warning(
                    "explore rejected project=%s intent=%s worker=%s execute_ms=%s total_ms=%s stdout_preview=%s",
                    project.project.id,
                    intent.id,
                    worker.name,
                    execute_ms,
                    int((time.perf_counter() - task_started) * 1000),
                    preview(first.stdout),
                )
                best_effort_release(client, project.project.id, intent.id, worker.name)
                return "rejected"
            description, resource_ok = _attach_access_resource_ids(
                client, project.project.id, intent.id, worker.name, description
            )
            if not resource_ok:
                return _try_conclude_fallback(
                    config,
                    client,
                    container_manager,
                    container_name,
                    worker,
                    driver,
                    project.project.id,
                    intent,
                    graph_reference,
                    session,
                    lease,
                    cancellation,
                    inbox=inbox,
                    correction_prompt=(
                        "你已声明建立 WebShell/reverse shell/C2 通道，但当前 Intent 没有共享 Resource。"
                        "立即使用 redtrace-resource 注册；失败时查看对应子命令 --help 并修正参数重试一次。"
                        "确认 snapshot 中出现 Resource ID 后，只返回符合原 explore schema 的 raw JSON，"
                        "description 必须包含该 ID。不要重新利用漏洞。"
                    ),
                    fallback_description=description,
                )
            return write_conclude_result(
                client,
                project.project.id,
                intent.id,
                worker.name,
                description,
                source="explore_execute",
                phase_ms=execute_ms,
                total_ms=int((time.perf_counter() - task_started) * 1000),
            )
        if did_timeout(first):
            LOG.warning(
                "explore timed out project=%s intent=%s worker=%s execute_ms=%s total_ms=%s stdout_preview=%s stderr_preview=%s",
                project.project.id,
                intent.id,
                worker.name,
                execute_ms,
                int((time.perf_counter() - task_started) * 1000),
                preview(first.stdout),
                preview(first.stderr),
            )
            return _try_conclude_fallback(
                config,
                client,
                container_manager,
                container_name,
                worker,
                driver,
                project.project.id,
                intent,
                graph_reference,
                session,
                lease,
                cancellation,
                inbox=inbox,
            )
        LOG.warning(
            "explore command failed project=%s intent=%s worker=%s code=%s execute_ms=%s total_ms=%s stdout_preview=%s stderr_preview=%s",
            project.project.id,
            intent.id,
            worker.name,
            first.returncode,
            execute_ms,
            int((time.perf_counter() - task_started) * 1000),
            preview(first.stdout),
            preview(first.stderr),
        )
        best_effort_release(client, project.project.id, intent.id, worker.name)
        return process_failure_outcome(first)
    except Exception as exc:
        LOG.exception(
            "explore task crashed project=%s intent=%s worker=%s",
            project.project.id,
            intent.id,
            worker.name,
        )
        best_effort_release(client, project.project.id, intent.id, worker.name)
        return exception_failure_outcome(exc)
    finally:
        if checkpoint_due and container_name is not None:
            run_learning_checkpoint(
                driver,
                client,
                container_manager,
                container_name,
                worker,
                session,
                task_type="explore",
                project_id=project.project.id,
                intent_id=intent.id,
                blackboard_revision=project.blackboard_revision,
                timeout_seconds=config.tasks.explore.conclude_timeout,
                lease=lease,
                cancellation=cancellation,
                blackboard_inbox=inbox,
            )
        if inbox is not None:
            inbox.stop()
        lease.stop()


def _try_conclude_fallback(
    config: DispatchConfig,
    client: ControlPlaneClient,
    container_manager: ContainerManager,
    container_name: str,
    worker: WorkerConfig,
    driver,
    project_id: str,
    intent: Intent,
    graph_reference: str,
    session: str | None,
    lease: HeartbeatLease,
    cancellation: TaskCancellation,
    inbox: BlackboardInbox | None = None,
    correction_prompt: str | None = None,
    fallback_description: str | None = None,
) -> str:
    if not driver.supports_conclude() or not session:
        LOG.info(
            "conclude fallback unavailable project=%s intent=%s worker=%s supports_conclude=%s has_session=%s",
            project_id,
            intent.id,
            worker.name,
            driver.supports_conclude(),
            bool(session),
        )
        if fallback_description is not None:
            return write_conclude_result(
                client,
                project_id,
                intent.id,
                worker.name,
                _resource_commit_failure(fallback_description),
                source="explore_resource_commit",
                phase_ms=0,
            )
        best_effort_release(client, project_id, intent.id, worker.name)
        return "contract_error"
    if lease.failure is not None:
        LOG.warning(
            "conclude fallback skipped because heartbeat already lost project=%s intent=%s worker=%s",
            project_id,
            intent.id,
            worker.name,
        )
        best_effort_release(client, project_id, intent.id, worker.name)
        return "heartbeat_loss"
    if cancellation.is_cancelled:
        LOG.info(
            "conclude fallback skipped because task was cancelled project=%s intent=%s worker=%s reason=%s",
            project_id,
            intent.id,
            worker.name,
            cancellation.reason,
        )
        best_effort_release(client, project_id, intent.id, worker.name)
        return "cancelled"

    if not project_allows_conclude_fallback(
        client,
        project_id,
        worker_name=worker.name,
        intent_id=intent.id,
    ):
        best_effort_release(client, project_id, intent.id, worker.name)
        return "cancelled"

    container_name = ensure_worker_running(container_manager, project_id, worker)
    record_session_checkpoint(
        client,
        container_manager,
        project_id,
        intent.id,
        worker,
        session,
        "resume_start",
    )

    prompt = correction_prompt or render_prompt(
        load_prompt(config.runtime.prompt_group, "explore_conclude.md"),
        {
            "graph_yaml": graph_reference,
            "intent_id": intent.id,
            "intent_description": intent.description,
        },
    )
    conclude = driver.build_conclude(
        worker, prompt, session, task_type="explore"
    )
    LOG.info(
        "starting conclude fallback project=%s intent=%s worker=%s",
        project_id,
        intent.id,
        worker.name,
    )
    conclude_started = time.perf_counter()
    result, _ = _run_with_steering(
        driver,
        client,
        project_id,
        intent.id,
        container_manager,
        container_name,
        worker,
        conclude,
        session=session,
        phase="explore_conclude",
        timeout=config.tasks.explore.conclude_timeout,
        lease=lease,
        cancellation=cancellation,
        inbox=inbox,
    )
    conclude_ms = int((time.perf_counter() - conclude_started) * 1000)
    cancelled = cancel_reason(result, cancellation)
    if cancelled is not None:
        LOG.info(
            "conclude cancelled project=%s intent=%s worker=%s reason=%s conclude_ms=%s",
            project_id,
            intent.id,
            worker.name,
            cancelled,
            conclude_ms,
        )
        best_effort_release(client, project_id, intent.id, worker.name)
        return "cancelled"
    if lease.failure is not None:
        best_effort_release(client, project_id, intent.id, worker.name)
        return "heartbeat_loss"
    if result.timed_out or result.returncode != 0:
        LOG.warning(
            "conclude failed project=%s intent=%s worker=%s code=%s timed_out=%s conclude_ms=%s stdout_preview=%s stderr_preview=%s",
            project_id,
            intent.id,
            worker.name,
            result.returncode,
            result.timed_out,
            conclude_ms,
            preview(result.stdout),
            preview(result.stderr),
        )
        best_effort_release(client, project_id, intent.id, worker.name)
        return process_failure_outcome(result)
    try:
        model_output = driver.extract_response_text(result.stdout, result.stderr)
        payload = parse_json_output(model_output)
        kind, description = validate_explore_payload(payload)
    except Exception as exc:
        LOG.warning(
            "conclude parse failed project=%s intent=%s worker=%s error=%s conclude_ms=%s stdout_preview=%s stderr_preview=%s",
            project_id,
            intent.id,
            worker.name,
            exc,
            conclude_ms,
            preview(result.stdout),
            preview(result.stderr),
        )
        best_effort_release(client, project_id, intent.id, worker.name)
        return "contract_error"
    if kind == "rejected":
        LOG.warning(
            "conclude rejected project=%s intent=%s worker=%s conclude_ms=%s stdout_preview=%s",
            project_id,
            intent.id,
            worker.name,
            conclude_ms,
            preview(result.stdout),
        )
        best_effort_release(client, project_id, intent.id, worker.name)
        return "rejected"
    description, resource_ok = _attach_access_resource_ids(
        client, project_id, intent.id, worker.name, description
    )
    if not resource_ok:
        LOG.warning(
            "access channel missing shared resource project=%s intent=%s worker=%s",
            project_id,
            intent.id,
            worker.name,
        )
        return write_conclude_result(
            client,
            project_id,
            intent.id,
            worker.name,
            _resource_commit_failure(fallback_description or description),
            source="explore_resource_commit",
            phase_ms=conclude_ms,
        )
    return write_conclude_result(
        client,
        project_id,
        intent.id,
        worker.name,
        description,
        source="explore_conclude",
        phase_ms=conclude_ms,
    )


def _attach_access_resource_ids(
    client: ControlPlaneClient,
    project_id: str,
    intent_id: str,
    worker_name: str,
    description: str,
) -> tuple[str, bool]:
    if not _ACCESS_CHANNEL.search(description):
        return description, True
    ids = {
        str(resource["id"]).lower(): str(resource["id"])
        for resource in client.resource_snapshot(project_id)
        if isinstance(resource, dict)
        and resource.get("kind") in {"webshell", "c2_session"}
        and _ACCESS_RESOURCE_ID.fullmatch(str(resource.get("id", "")))
        and resource.get("status", "available") not in {"closed", "deleted"}
    }
    cited = {
        resource_id.lower() for resource_id in _ACCESS_RESOURCE_ID.findall(description)
    }
    if cited:
        return description, bool(cited & ids.keys())
    if not ids:
        return description, False
    return f"{description.rstrip()}\nShared Resource IDs: {', '.join(sorted(ids.values()))}", True


def _resource_commit_failure(description: str) -> str:
    return (
        "Execution result preserved; shared access Resource registration failed. "
        "Do not repeat exploitation—repair only the Resource record.\n"
        + description.strip()
    )


def _run_process(
    client: ControlPlaneClient,
    project_id: str,
    intent_id: str,
    container_manager: ContainerManager,
    container_name: str,
    worker: WorkerConfig,
    argv: list[str],
    *,
    stdin_text: str | None = None,
    phase: str,
    timeout: int,
    lease: HeartbeatLease,
    cancellation: TaskCancellation,
    blackboard_revision: int = 0,
    inbox: BlackboardInbox | None = None,
    live_control=None,
):
    return run_worker_process(
        container_manager,
        container_name,
        worker,
        argv,
        stdin_text=stdin_text,
        client=client,
        project_id=project_id,
        intent_id=intent_id,
        blackboard_revision=blackboard_revision,
        phase=phase,
        timeout_seconds=timeout,
        lease=lease,
        cancellation=cancellation,
        blackboard_inbox=inbox,
        live_control=live_control,
    )


def _run_with_steering(
    driver,
    client: ControlPlaneClient,
    project_id: str,
    intent_id: str,
    container_manager: ContainerManager,
    container_name: str,
    worker: WorkerConfig,
    invocation,
    *,
    session: str | None,
    phase: str,
    timeout: int,
    lease: HeartbeatLease,
    cancellation: TaskCancellation,
    blackboard_revision: int = 0,
    inbox: BlackboardInbox | None = None,
):
    result = _run_process(
        client,
        project_id,
        intent_id,
        container_manager,
        container_name,
        worker,
        invocation.argv,
        stdin_text=invocation.stdin,
        phase=phase,
        timeout=timeout,
        lease=lease,
        cancellation=cancellation,
        blackboard_revision=blackboard_revision,
        inbox=inbox,
        live_control=getattr(invocation, "live_control", None),
    )
    session = driver.extract_session(session, result.stdout, result.stderr)
    control = getattr(invocation, "live_control", None)
    if control is not None:
        session = (
            getattr(control, "session_file", None)
            or getattr(control, "session_id", None)
            or session
        )
    return result, session
