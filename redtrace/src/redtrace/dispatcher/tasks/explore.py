from __future__ import annotations

import logging
import time

from redtrace.board.models import Intent, ProjectDetail
from redtrace.dispatcher.config import DispatchConfig, WorkerConfig
from redtrace.dispatcher.contracts import parse_json_output, validate_explore_payload
from redtrace.dispatcher.control_plane import ControlPlaneClient
from redtrace.dispatcher.workers.base import ProviderError
from redtrace.dispatcher.prompting import (
    load_prompt_for_mode,
    render_prompt,
)
from redtrace.dispatcher.runtime.cancellation import TaskCancellation
from redtrace.dispatcher.runtime.containers import ContainerManager
from redtrace.dispatcher.runtime.heartbeat import HeartbeatLease
from redtrace.dispatcher.tasks.common import (
    BlackboardInbox,
    best_effort_release,
    cancel_reason,
    cleanup_skill_tracking,
    did_timeout,
    preflight_worker,
    exception_failure_outcome,
    ensure_worker_running,
    project_allows_conclude_fallback,
    preview,
    process_failure_outcome,
    record_session_checkpoint,
    reset_skill_tracking,
    run_worker_process,
    write_conclude_result,
    write_graph_snapshot_reference,
)
from redtrace.dispatcher.workers.registry import get_driver

LOG = logging.getLogger(__name__)


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
    result_committed = False
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

        # Clear any tracking file a crashed previous run of this same task
        # left behind, so a retry starts clean. Must run once at task start
        # only — execute/steering/conclude share the same tracking file.
        reset_skill_tracking(
            container_manager,
            container_name,
            "explore",
            project.project.id,
            intent.id,
            worker.name,
        )

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
                worker_name=worker.name,
                revision=project.blackboard_revision,
            )
        prompt = render_prompt(
            load_prompt_for_mode("explore.md", prompt_group=config.runtime.prompt_group if worker.type == "mock" else None),
            {
                "graph_yaml": graph_reference,
                "intent_id": intent.id,
                "intent_description": intent.description,
            },
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
            env_overrides=execute.env,
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
            except ProviderError as exc:
                LOG.warning(
                    "explore provider error project=%s intent=%s worker=%s code=%s message=%s execute_ms=%s total_ms=%s",
                    project.project.id,
                    intent.id,
                    worker.name,
                    exc.code,
                    exc.message,
                    execute_ms,
                    int((time.perf_counter() - task_started) * 1000),
                )
                best_effort_release(client, project.project.id, intent.id, worker.name)
                return "provider_error"
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
            result = write_conclude_result(
                client,
                project.project.id,
                intent.id,
                worker.name,
                description,
                source="explore_execute",
                phase_ms=execute_ms,
                total_ms=int((time.perf_counter() - task_started) * 1000),
            )
            result_committed = True
            return result
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
        if container_name is not None:
            cleanup_skill_tracking(
                container_name, "explore", project.project.id, intent.id, worker.name
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

    prompt = render_prompt(
        load_prompt_for_mode("explore_conclude.md", prompt_group=config.runtime.prompt_group if worker.type == "mock" else None),
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
        env_overrides=conclude.env,
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
    except ProviderError as exc:
        LOG.warning(
            "conclude provider error project=%s intent=%s worker=%s code=%s message=%s conclude_ms=%s",
            project_id,
            intent.id,
            worker.name,
            exc.code,
            exc.message,
            conclude_ms,
        )
        best_effort_release(client, project_id, intent.id, worker.name)
        return "provider_error"
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
    return write_conclude_result(
        client,
        project_id,
        intent.id,
        worker.name,
        description,
        source="explore_conclude",
        phase_ms=conclude_ms,
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
    session: str | None = None,
    env_overrides: dict[str, str] | None = None,
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
        session=session,
        env_overrides=env_overrides,
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
    env_overrides: dict[str, str] | None = None,
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
        session=session,
        env_overrides=env_overrides,
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
