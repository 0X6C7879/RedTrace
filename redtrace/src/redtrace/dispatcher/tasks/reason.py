from __future__ import annotations

import logging
import time

from redtrace.board.models import ProjectDetail
from redtrace.dispatcher.config import DispatchConfig, WorkerConfig
from redtrace.dispatcher.contracts import parse_json_output, validate_reason_payload
from redtrace.dispatcher.control_plane import ControlPlaneClient
from redtrace.dispatcher.workers.base import ProviderError
from redtrace.dispatcher.prompting import (
    add_blackboard_guidance,
    format_fact_ids,
    format_json_block,
    format_open_intents,
    load_prompt,
    render_prompt,
)
from redtrace.dispatcher.runtime.cancellation import TaskCancellation
from redtrace.dispatcher.runtime.containers import ContainerManager
from redtrace.dispatcher.runtime.heartbeat import HeartbeatLease
from redtrace.dispatcher.tasks.common import (
    BlackboardInbox,
    best_effort_release_reason,
    cancel_reason,
    did_timeout,
    ensure_worker_running,
    preflight_worker,
    preview,
    process_failure_outcome,
    record_session_checkpoint,
    run_worker_process,
    write_graph_snapshot_reference,
)
from redtrace.dispatcher.workers.registry import get_driver

LOG = logging.getLogger(__name__)
FORMAT_REPAIR_TIMEOUT_SECONDS = 60


def run_reason_task(
    config: DispatchConfig,
    client: ControlPlaneClient,
    container_manager: ContainerManager,
    project: ProjectDetail,
    export_yaml: str,
    worker: WorkerConfig,
    cancellation: TaskCancellation,
) -> str:
    driver = get_driver(worker.type, config.runtime.execution)
    task_started = time.perf_counter()
    lease = HeartbeatLease.for_reason(
        client, project.project.id, worker.name, config.runtime.interval
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
            task_type="reason",
        )
        if early_result is not None:
            return early_result
        if worker.type != "mock" and callable(
            getattr(client, "wait_for_blackboard", None)
        ):
            inbox = BlackboardInbox(
                client,
                container_manager,
                container_name,
                project_id=project.project.id,
                intent_id=None,
                intent_description="",
                source_fact_ids=[],
                worker_name=worker.name,
                revision=project.blackboard_revision,
                task_type="reason",
                all_facts=True,
            )
        open_intents = [
            {
                "id": intent.id,
                "from": intent.from_,
                "description": intent.description,
                "worker": intent.worker,
                "priority": intent.priority,
                "state": intent.state,
                "attempt_count": intent.attempt_count,
                "fact_yield": intent.fact_yield,
                "drop_reason": intent.drop_reason,
                "superseded_by": intent.superseded_by,
            }
            for intent in project.intents
            if intent.to is None and intent.state in ("open", "working")
        ]
        explore_capacity = min(
            config.runtime.max_workers,
            config.runtime.max_project_workers,
            sum(
                candidate.max_running
                for candidate in config.workers
                if candidate.enabled and "explore" in candidate.task_types
            ),
        )
        working_explore = sum(
            intent.state == "working" and intent.worker is not None
            for intent in project.intents
        )
        execution = {
            "planning_mode": (
                "initial_environment_sensing"
                if all(fact.id in {"origin", "goal"} for fact in project.facts)
                else "frontier_replanning"
            ),
            "bootstrap": {
                "enabled": project.project.bootstrap_enabled,
                "handed_off": any(
                    intent.creator == "dispatcher.bootstrap"
                    and intent.state == "blocked"
                    and intent.failure_signature == "timeout"
                    for intent in project.intents
                ),
            },
            "available_workers": [
                {
                    "name": candidate.name,
                    "type": candidate.type,
                    "task_types": candidate.task_types,
                    "max_running": candidate.max_running,
                }
                for candidate in config.workers
                if candidate.enabled
            ],
            "explore_workers": {
                "total": explore_capacity,
                "working": working_explore,
                "idle": max(0, explore_capacity - working_explore),
            },
            "frontier": {
                "ready": sum(intent["state"] == "open" for intent in open_intents),
                "working": sum(
                    intent["state"] == "working" for intent in open_intents
                ),
            },
        }
        allowed_fact_ids = [fact.id for fact in project.facts if fact.id != "goal"]
        valid_intent_ids = [intent.id for intent in project.intents]
        LOG.debug(
            "reason context prepared project=%s worker=%s facts=%s allowed_fact_ids=%s hints=%s open_intents=%s",
            project.project.id,
            worker.name,
            len(project.facts),
            len(allowed_fact_ids),
            len(project.hints),
            len(open_intents),
        )
        largest_fact = max(
            project.facts, key=lambda fact: len(fact.description), default=None
        )
        LOG.info(
            "reason graph prepared project=%s worker=%s facts=%s intents=%s open_intents=%s hints=%s bytes=%s chars=%s largest_fact_chars=%s largest_fact_id=%s truncated=false",
            project.project.id,
            worker.name,
            len(project.facts),
            len(project.intents),
            len(open_intents),
            len(project.hints),
            len(export_yaml.encode()),
            len(export_yaml),
            len(largest_fact.description) if largest_fact is not None else 0,
            largest_fact.id if largest_fact is not None else None,
        )
        prompt = render_prompt(
            load_prompt(config.runtime.prompt_group, "reason.md"),
            {
                "graph_yaml": write_graph_snapshot_reference(
                    container_manager,
                    container_name,
                    export_yaml.strip(),
                    phase="reason_execute",
                ),
                "fact_ids": format_fact_ids(allowed_fact_ids),
                "open_intents": format_open_intents(open_intents),
                "execution": format_json_block(execution),
                "max_intents": str(config.tasks.reason.max_intents),
            },
        )
        if worker.type != "mock":
            prompt = add_blackboard_guidance(
                prompt,
                project.blackboard_revision,
                task_type="reason",
                context_harness_enabled=config.context_harness.enabled,
                local_execution=config.runtime.execution == "local",
            )

        session = driver.prepare_session()
        command = driver.build_execute(
            worker, prompt, session, task_type="reason"
        )
        execute_started = time.perf_counter()
        result = run_worker_process(
            container_manager,
            container_name,
            worker,
            command.argv,
            stdin_text=command.stdin,
            client=client,
            project_id=project.project.id,
            blackboard_revision=project.blackboard_revision,
            phase="reason_execute",
            timeout_seconds=config.tasks.reason.timeout,
            lease=lease,
            cancellation=cancellation,
            blackboard_inbox=inbox,
            live_control=command.live_control,
        )
        execute_ms = int((time.perf_counter() - execute_started) * 1000)
        total_ms = int((time.perf_counter() - task_started) * 1000)
        session = driver.extract_session(session, result.stdout, result.stderr)
        if command.live_control is not None:
            session = (
                getattr(command.live_control, "session_file", None)
                or getattr(command.live_control, "session_id", None)
                or session
            )
        execute_checkpoint = record_session_checkpoint(
            client,
            container_manager,
            project.project.id,
            None,
            worker,
            session,
            "execute_end",
        )
        cancelled = cancel_reason(result, cancellation)
        if cancelled is not None:
            LOG.info(
                "reason cancelled project=%s worker=%s reason=%s execute_ms=%s",
                project.project.id,
                worker.name,
                cancelled,
                execute_ms,
            )
            return "cancelled"
        if lease.failure is not None:
            LOG.warning(
                "heartbeat lost during reason project=%s worker=%s status=%s execute_ms=%s",
                project.project.id,
                worker.name,
                lease.failure.status_code,
                execute_ms,
            )
            return "heartbeat_loss"
        if did_timeout(result):
            LOG.warning(
                "reason timed out project=%s worker=%s execute_ms=%s total_ms=%s stdout_preview=%s stderr_preview=%s",
                project.project.id,
                worker.name,
                execute_ms,
                total_ms,
                preview(result.stdout),
                preview(result.stderr),
            )
            if not driver.supports_conclude() or session is None:
                return "timeout"
            if worker.type == "pi" and execute_checkpoint is not None:
                if not execute_checkpoint.get("exists"):
                    return "session_missing"
                if int(execute_checkpoint.get("size_bytes", 0)) == 0:
                    return "timeout"
            recovery_prompt = (
                "The planning time budget ended. Stop all tools and further analysis. "
                "Using only work already completed in this session, immediately return the "
                "best valid raw reason JSON object. Do not emit Markdown or commentary."
            )
            recovery_command = driver.build_conclude(
                worker, recovery_prompt, session, task_type="reason"
            )
            record_session_checkpoint(
                client,
                container_manager,
                project.project.id,
                None,
                worker,
                session,
                "resume_start",
            )
            result = run_worker_process(
                container_manager,
                container_name,
                worker,
                recovery_command.argv,
                stdin_text=recovery_command.stdin,
                client=client,
                project_id=project.project.id,
                blackboard_revision=project.blackboard_revision,
                phase="reason_timeout_recovery",
                timeout_seconds=min(
                    config.tasks.reason.timeout, FORMAT_REPAIR_TIMEOUT_SECONDS
                ),
                lease=lease,
                cancellation=cancellation,
            )
            cancelled = cancel_reason(result, cancellation)
            if cancelled is not None:
                return "cancelled"
            if lease.failure is not None or did_timeout(result) or result.returncode != 0:
                LOG.warning(
                    "reason timeout recovery failed project=%s worker=%s code=%s timed_out=%s",
                    project.project.id,
                    worker.name,
                    result.returncode,
                    result.timed_out,
                )
                return "timeout"
        if result.returncode != 0:
            LOG.warning(
                "reason command failed project=%s worker=%s code=%s execute_ms=%s total_ms=%s stdout_preview=%s stderr_preview=%s",
                project.project.id,
                worker.name,
                result.returncode,
                execute_ms,
                total_ms,
                preview(result.stdout),
                preview(result.stderr),
            )
            return process_failure_outcome(result)
        try:
            model_output = driver.extract_response_text(result.stdout, result.stderr)
            payload = parse_json_output(model_output)
            kind, data = validate_reason_payload(
                payload,
                valid_fact_ids=set(allowed_fact_ids),
                valid_intent_ids=set(valid_intent_ids),
            )
        except ProviderError as exc:
            LOG.warning(
                "reason provider error project=%s worker=%s code=%s message=%s execute_ms=%s total_ms=%s",
                project.project.id,
                worker.name,
                exc.code,
                exc.message,
                execute_ms,
                total_ms,
            )
            return "provider_error"
        except Exception as exc:
            if not driver.supports_conclude() or session is None:
                LOG.warning(
                    "reason parse failed project=%s worker=%s error=%s execute_ms=%s total_ms=%s stdout_preview=%s stderr_preview=%s",
                    project.project.id,
                    worker.name,
                    exc,
                    execute_ms,
                    total_ms,
                    preview(result.stdout),
                    preview(result.stderr),
                )
                return "contract_error"
            LOG.info(
                "reason output invalid; requesting format-only repair project=%s worker=%s error=%s",
                project.project.id,
                worker.name,
                exc,
            )
            repair_prompt = (
                "你上一条最终响应不符合 reason JSON contract。\n"
                f"校验错误：{preview(str(exc), 300)}\n"
                "不得调用工具、继续分析或重复任务。立即只返回一个修正后的 raw JSON object，"
                "不得输出 Markdown 或解释文字。只允许 GraphPatch 结构：\n"
                '{"accepted":false,"reason":"policy_refusal"}\n'
                '{"accepted":true,"data":{"create":[],"drop":[],'
                '"reprioritize":[],"supersede":[],"complete":null}}\n'
                'create 项形如 {"from":["fact-id"],"description":"...","priority":50}；'
                'drop 项形如 {"intent_id":"i001","reason":"..."}；'
                'reprioritize 项形如 {"intent_id":"i001","priority":90,"reason":"..."}；'
                'supersede 项形如 {"intent_id":"i001","by":"i002","reason":"..."}；'
                'complete 项形如 {"from":["fact-id"],"description":"..."}。\n'
            )
            try:
                repair_command = driver.build_conclude(
                    worker, repair_prompt, session, task_type="reason"
                )
                repair = run_worker_process(
                    container_manager,
                    container_name,
                    worker,
                    repair_command.argv,
                    stdin_text=repair_command.stdin,
                    client=client,
                    project_id=project.project.id,
                    blackboard_revision=project.blackboard_revision,
                    phase="reason_format_repair",
                    timeout_seconds=min(
                        config.tasks.reason.timeout, FORMAT_REPAIR_TIMEOUT_SECONDS
                    ),
                    lease=lease,
                    cancellation=cancellation,
                    blackboard_inbox=inbox,
                    live_control=repair_command.live_control,
                )
            except Exception as repair_exc:
                LOG.warning(
                    "reason format repair execution failed project=%s worker=%s error=%s",
                    project.project.id,
                    worker.name,
                    repair_exc,
                )
                return "provider_exit"
            cancelled = cancel_reason(repair, cancellation)
            if cancelled is not None:
                LOG.info(
                    "reason format repair cancelled project=%s worker=%s reason=%s",
                    project.project.id,
                    worker.name,
                    cancelled,
                )
                return "cancelled"
            if (
                lease.failure is not None
                or did_timeout(repair)
                or repair.returncode != 0
            ):
                LOG.warning(
                    "reason format repair failed project=%s worker=%s code=%s timed_out=%s stdout_preview=%s stderr_preview=%s",
                    project.project.id,
                    worker.name,
                    repair.returncode,
                    repair.timed_out,
                    preview(repair.stdout),
                    preview(repair.stderr),
                )
                return process_failure_outcome(repair)
            try:
                model_output = driver.extract_response_text(
                    repair.stdout, repair.stderr
                )
                payload = parse_json_output(model_output)
                kind, data = validate_reason_payload(
                    payload,
                    valid_fact_ids=set(allowed_fact_ids),
                    valid_intent_ids=set(valid_intent_ids),
                )
            except ProviderError as exc:
                LOG.warning(
                    "reason format repair provider error project=%s worker=%s code=%s message=%s",
                    project.project.id,
                    worker.name,
                    exc.code,
                    exc.message,
                )
                return "provider_error"
            except Exception as repair_exc:
                LOG.warning(
                    "reason format repair invalid project=%s worker=%s error=%s stdout_preview=%s stderr_preview=%s",
                    project.project.id,
                    worker.name,
                    repair_exc,
                    preview(repair.stdout),
                    preview(repair.stderr),
                )
                return "contract_error"
            result = repair
        if kind == "rejected":
            LOG.warning(
                "reason rejected project=%s worker=%s execute_ms=%s total_ms=%s stdout_preview=%s",
                project.project.id,
                worker.name,
                execute_ms,
                total_ms,
                preview(result.stdout),
            )
            return "rejected"

        patch = data or {}
        patch["base_planning_revision"] = project.project.planning_revision
        patch["worker"] = worker.name
        active_intents = sum(
            intent.to is None and intent.state in {"open", "working"}
            for intent in project.intents
        )
        create_limit = max(0, config.tasks.reason.max_intents - active_intents)
        patch["create"] = (patch.get("create") or [])[:create_limit]

        response = client.apply_graph_patch(project.project.id, patch)
        if response.status_code == 403:
            LOG.info(
                "project became inactive during reason graph patch project=%s worker=%s",
                project.project.id,
                worker.name,
            )
            return "success"
        if response.status_code == 409 and (
            response.data == {"detail": "revision_conflict"}
            or "revision_conflict" in response.text
        ):
            LOG.warning(
                "reason graph patch revision conflict project=%s worker=%s base_planning_revision=%s execute_ms=%s total_ms=%s",
                project.project.id,
                worker.name,
                project.project.planning_revision,
                execute_ms,
                total_ms,
            )
            return "revision_conflict"
        if not response.ok:
            LOG.warning(
                "reason graph patch failed project=%s worker=%s status=%s body=%s",
                project.project.id,
                worker.name,
                response.status_code,
                response.text,
            )
            return "api_error"
        LOG.info(
            "reason graph patch project=%s worker=%s create=%s drop=%s reprioritize=%s supersede=%s complete=%s execute_ms=%s total_ms=%s",
            project.project.id,
            worker.name,
            len(patch.get("create") or []),
            len(patch.get("drop") or []),
            len(patch.get("reprioritize") or []),
            len(patch.get("supersede") or []),
            bool(patch.get("complete")),
            execute_ms,
            total_ms,
        )
        return "success"
    finally:
        if inbox is not None:
            inbox.stop()
        lease.stop()
        best_effort_release_reason(client, project.project.id, worker.name)
