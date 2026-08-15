from __future__ import annotations

import logging
import time

from redtrace.board.models import Intent, ProjectDetail
from redtrace.dispatcher.config import DispatchConfig, WorkerConfig
from redtrace.dispatcher.contracts import (
    parse_json_output,
    validate_bootstrap_conclude_payload,
    validate_bootstrap_execute_payload,
)
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
    best_effort_release,
    cancel_reason,
    did_timeout,
    preflight_worker,
    ensure_worker_running,
    exception_failure_outcome,
    project_allows_conclude_fallback,
    preview,
    process_failure_outcome,
    record_session_checkpoint,
    run_worker_process,
    write_conclude_result,
    write_conclude_result_with_fact_id,
)
from redtrace.dispatcher.workers.registry import get_driver

LOG = logging.getLogger(__name__)


def run_bootstrap_task(
    config: DispatchConfig,
    client: ControlPlaneClient,
    container_manager: ContainerManager,
    project: ProjectDetail,
    intent: Intent,
    worker: WorkerConfig,
    cancellation: TaskCancellation,
) -> str:
    driver = get_driver(worker.type, config.runtime.execution)
    task_started = time.perf_counter()
    container_name: str | None = None
    session: str | None = None
    lease = HeartbeatLease.for_intent(
        client, project.project.id, intent.id, worker.name, config.runtime.interval
    )
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
            task_type="bootstrap",
            intent_id=intent.id,
        )
        if early_result is not None:
            best_effort_release(client, project.project.id, intent.id, worker.name)
            return early_result

        prompt = render_prompt(
            load_prompt(config.runtime.prompt_group, "bootstrap.md"),
            _bootstrap_prompt_replacements(project),
        )
        if worker.type != "mock":
            prompt = add_blackboard_guidance(
                prompt,
                project.blackboard_revision,
                task_type="bootstrap",
                context_harness_enabled=config.context_harness.enabled,
                local_execution=config.runtime.execution == "local",
            )

        session = driver.prepare_session()
        execute = driver.build_execute(
            worker, prompt, session, task_type="bootstrap"
        )
        session = execute.session
        execute_started = time.perf_counter()
        first = run_worker_process(
            container_manager,
            container_name,
            worker,
            execute.argv,
            stdin_text=execute.stdin,
            client=client,
            project_id=project.project.id,
            intent_id=intent.id,
            blackboard_revision=project.blackboard_revision,
            phase="bootstrap",
            timeout_seconds=config.tasks.bootstrap.timeout,
            lease=lease,
            cancellation=cancellation,
            live_control=execute.live_control,
        )
        execute_ms = int((time.perf_counter() - execute_started) * 1000)
        session = driver.extract_session(session, first.stdout, first.stderr)
        if execute.live_control is not None:
            session = (
                getattr(execute.live_control, "session_file", None)
                or getattr(execute.live_control, "session_id", None)
                or session
            )
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
                "bootstrap cancelled project=%s intent=%s worker=%s reason=%s execute_ms=%s",
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
                "heartbeat lost during bootstrap project=%s intent=%s worker=%s status=%s execute_ms=%s",
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
                kind, data = validate_bootstrap_execute_payload(payload)
            except Exception as exc:
                LOG.warning(
                    "bootstrap parse failed project=%s intent=%s worker=%s error=%s execute_ms=%s total_ms=%s stdout_preview=%s stderr_preview=%s",
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
                    project,
                    intent,
                    session,
                    lease,
                    cancellation,
                )
            if kind == "rejected":
                LOG.warning(
                    "bootstrap rejected project=%s intent=%s worker=%s execute_ms=%s total_ms=%s stdout_preview=%s",
                    project.project.id,
                    intent.id,
                    worker.name,
                    execute_ms,
                    int((time.perf_counter() - task_started) * 1000),
                    preview(first.stdout),
                )
                best_effort_release(client, project.project.id, intent.id, worker.name)
                return "rejected"
            return _write_bootstrap_complete_result(
                client,
                project.project.id,
                intent.id,
                worker.name,
                data["fact_description"],
                data["complete_description"],
                source="bootstrap",
                phase_ms=execute_ms,
                total_ms=int((time.perf_counter() - task_started) * 1000),
            )
        if did_timeout(first):
            LOG.warning(
                "bootstrap timed out project=%s intent=%s worker=%s execute_ms=%s total_ms=%s stdout_preview=%s stderr_preview=%s",
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
                project,
                intent,
                session,
                lease,
                cancellation,
            )
        LOG.warning(
            "bootstrap command failed project=%s intent=%s worker=%s code=%s execute_ms=%s total_ms=%s stdout_preview=%s stderr_preview=%s",
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
            "bootstrap task crashed project=%s intent=%s worker=%s",
            project.project.id,
            intent.id,
            worker.name,
        )
        best_effort_release(client, project.project.id, intent.id, worker.name)
        return exception_failure_outcome(exc)
    finally:
        lease.stop()


def _try_conclude_fallback(
    config: DispatchConfig,
    client: ControlPlaneClient,
    container_manager: ContainerManager,
    container_name: str,
    worker: WorkerConfig,
    driver,
    project: ProjectDetail,
    intent: Intent,
    session: str | None,
    lease: HeartbeatLease,
    cancellation: TaskCancellation,
) -> str:
    if not driver.supports_conclude() or not session:
        LOG.info(
            "bootstrap conclude fallback unavailable project=%s intent=%s worker=%s supports_conclude=%s has_session=%s",
            project.project.id,
            intent.id,
            worker.name,
            driver.supports_conclude(),
            bool(session),
        )
        best_effort_release(client, project.project.id, intent.id, worker.name)
        return "contract_error"
    if lease.failure is not None:
        LOG.warning(
            "bootstrap conclude fallback skipped because heartbeat already lost project=%s intent=%s worker=%s",
            project.project.id,
            intent.id,
            worker.name,
        )
        best_effort_release(client, project.project.id, intent.id, worker.name)
        return "heartbeat_loss"
    if cancellation.is_cancelled:
        LOG.info(
            "bootstrap conclude fallback skipped because task was cancelled project=%s intent=%s worker=%s reason=%s",
            project.project.id,
            intent.id,
            worker.name,
            cancellation.reason,
        )
        best_effort_release(client, project.project.id, intent.id, worker.name)
        return "cancelled"

    if not project_allows_conclude_fallback(
        client,
        project.project.id,
        worker_name=worker.name,
        intent_id=intent.id,
    ):
        best_effort_release(client, project.project.id, intent.id, worker.name)
        return "cancelled"

    container_name = ensure_worker_running(
        container_manager, project.project.id, worker
    )
    record_session_checkpoint(
        client,
        container_manager,
        project.project.id,
        intent.id,
        worker,
        session,
        "resume_start",
    )

    prompt = render_prompt(
        load_prompt(config.runtime.prompt_group, "bootstrap_conclude.md"),
        _bootstrap_prompt_replacements(project),
    )
    conclude = driver.build_conclude(
        worker, prompt, session, task_type="bootstrap"
    )
    LOG.info(
        "starting bootstrap conclude fallback project=%s intent=%s worker=%s",
        project.project.id,
        intent.id,
        worker.name,
    )
    conclude_started = time.perf_counter()
    result = run_worker_process(
        container_manager,
        container_name,
        worker,
        conclude.argv,
        stdin_text=conclude.stdin,
        client=client,
        project_id=project.project.id,
        intent_id=intent.id,
        blackboard_revision=project.blackboard_revision,
        phase="bootstrap_conclude",
        timeout_seconds=config.tasks.bootstrap.conclude_timeout,
        lease=lease,
        cancellation=cancellation,
        live_control=conclude.live_control,
    )
    conclude_ms = int((time.perf_counter() - conclude_started) * 1000)
    cancelled = cancel_reason(result, cancellation)
    if cancelled is not None:
        LOG.info(
            "bootstrap conclude cancelled project=%s intent=%s worker=%s reason=%s conclude_ms=%s",
            project.project.id,
            intent.id,
            worker.name,
            cancelled,
            conclude_ms,
        )
        best_effort_release(client, project.project.id, intent.id, worker.name)
        return "cancelled"
    if lease.failure is not None:
        best_effort_release(client, project.project.id, intent.id, worker.name)
        return "heartbeat_loss"
    if result.timed_out or result.returncode != 0:
        LOG.warning(
            "bootstrap conclude failed project=%s intent=%s worker=%s code=%s timed_out=%s conclude_ms=%s stdout_preview=%s stderr_preview=%s",
            project.project.id,
            intent.id,
            worker.name,
            result.returncode,
            result.timed_out,
            conclude_ms,
            preview(result.stdout),
            preview(result.stderr),
        )
        best_effort_release(client, project.project.id, intent.id, worker.name)
        return process_failure_outcome(result)
    try:
        model_output = driver.extract_response_text(result.stdout, result.stderr)
        payload = parse_json_output(model_output)
        conclude_data = (
            payload.get("data") if isinstance(payload.get("data"), dict) else payload
        )
        if isinstance(conclude_data, dict) and isinstance(
            conclude_data.get("complete"), dict
        ):
            LOG.warning(
                "bootstrap conclude returned unexpected complete payload project=%s intent=%s worker=%s complete_preview=%s",
                project.project.id,
                intent.id,
                worker.name,
                preview(str(conclude_data.get("complete"))),
            )
        kind, fact_description = validate_bootstrap_conclude_payload(payload)
    except Exception as exc:
        LOG.warning(
            "bootstrap conclude parse failed project=%s intent=%s worker=%s error=%s conclude_ms=%s stdout_preview=%s stderr_preview=%s",
            project.project.id,
            intent.id,
            worker.name,
            exc,
            conclude_ms,
            preview(result.stdout),
            preview(result.stderr),
        )
        best_effort_release(client, project.project.id, intent.id, worker.name)
        return "contract_error"
    if kind == "rejected":
        LOG.warning(
            "bootstrap conclude rejected project=%s intent=%s worker=%s conclude_ms=%s stdout_preview=%s",
            project.project.id,
            intent.id,
            worker.name,
            conclude_ms,
            preview(result.stdout),
        )
        best_effort_release(client, project.project.id, intent.id, worker.name)
        return "rejected"
    return write_conclude_result(
        client,
        project.project.id,
        intent.id,
        worker.name,
        fact_description,
        source="bootstrap_conclude",
        phase_ms=conclude_ms,
    )


def _bootstrap_prompt_replacements(project: ProjectDetail) -> dict[str, str]:
    facts = {fact.id: fact.description for fact in project.facts}
    hints = [
        {
            "id": hint.id,
            "content": hint.content,
            "creator": hint.creator,
            "created_at": hint.created_at,
        }
        for hint in project.hints
    ]
    return {
        "origin": facts.get("origin", ""),
        "goal": facts.get("goal", ""),
        "hints": format_hints(hints),
    }


def _write_bootstrap_complete_result(
    client: ControlPlaneClient,
    project_id: str,
    intent_id: str,
    worker_name: str,
    fact_description: str,
    complete_description: str,
    *,
    source: str,
    phase_ms: int,
    total_ms: int | None = None,
) -> str:
    conclude = write_conclude_result_with_fact_id(
        client,
        project_id,
        intent_id,
        worker_name,
        fact_description,
        source=source,
        phase_ms=phase_ms,
        total_ms=total_ms,
    )
    if conclude.status != "success":
        return conclude.status
    if conclude.fact_id is None:
        LOG.warning(
            "bootstrap complete deferred because conclude response omitted fact id project=%s intent=%s worker=%s source=%s",
            project_id,
            intent_id,
            worker_name,
            source,
        )
        return "success"

    response = client.complete(
        project_id, [conclude.fact_id], complete_description, worker_name
    )
    if response.status_code in (403, 409):
        LOG.info(
            "bootstrap complete deferred project=%s intent=%s worker=%s source=%s status=%s fact_id=%s",
            project_id,
            intent_id,
            worker_name,
            source,
            response.status_code,
            conclude.fact_id,
        )
        return "success"
    if not response.ok:
        LOG.warning(
            "bootstrap complete write failed project=%s intent=%s worker=%s source=%s fact_id=%s status=%s body=%s",
            project_id,
            intent_id,
            worker_name,
            source,
            conclude.fact_id,
            response.status_code,
            response.text,
        )
        return "success"
    if total_ms is None:
        LOG.info(
            "bootstrap completed project=%s intent=%s worker=%s source=%s from=%s phase_ms=%s",
            project_id,
            intent_id,
            worker_name,
            source,
            [conclude.fact_id],
            phase_ms,
        )
    else:
        LOG.info(
            "bootstrap completed project=%s intent=%s worker=%s source=%s from=%s phase_ms=%s total_ms=%s",
            project_id,
            intent_id,
            worker_name,
            source,
            [conclude.fact_id],
            phase_ms,
            total_ms,
        )
    return "success"
