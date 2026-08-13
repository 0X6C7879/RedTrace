from __future__ import annotations

import logging
import time

from redtrace.board.models import ProjectDetail
from redtrace.dispatcher.config import DispatchConfig, WorkerConfig
from redtrace.dispatcher.contracts import parse_json_output, validate_reason_payload
from redtrace.dispatcher.control_plane import ControlPlaneClient
from redtrace.dispatcher.prompting import (
    add_blackboard_guidance,
    format_fact_ids,
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
    preflight_worker,
    preview,
    run_worker_process,
    write_graph_snapshot_reference,
)
from redtrace.dispatcher.workers.registry import get_driver

LOG = logging.getLogger(__name__)
FORMAT_REPAIR_TIMEOUT_SECONDS = 60


def _intent_target(config: DispatchConfig) -> int:
    explore_capacity = min(
        config.runtime.max_workers,
        config.runtime.max_project_workers,
        sum(worker.max_running for worker in config.workers if worker.enabled),
    )
    return min(config.tasks.reason.max_intents, max(1, explore_capacity + 1))


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
        container_name = container_manager.ensure_running(project.project.id)

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
            }
            for intent in project.intents
            if intent.to is None
        ]
        intent_target = _intent_target(config)
        available_intent_slots = max(0, intent_target - len(open_intents))
        allowed_fact_ids = [fact.id for fact in project.facts if fact.id != "goal"]
        LOG.debug(
            "reason context prepared project=%s worker=%s facts=%s allowed_fact_ids=%s hints=%s open_intents=%s",
            project.project.id,
            worker.name,
            len(project.facts),
            len(allowed_fact_ids),
            len(project.hints),
            len(open_intents),
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
                "max_intents": str(intent_target),
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
        command = driver.build_execute(worker, prompt, session)
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
            return "failed"
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
            return "failed"
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
            return "failed"
        try:
            model_output = driver.extract_response_text(result.stdout, result.stderr)
            payload = parse_json_output(model_output)
            kind, data = validate_reason_payload(
                payload,
                open_intents_empty=not open_intents,
                max_intents=available_intent_slots,
                valid_fact_ids=set(allowed_fact_ids),
            )
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
                return "failed"
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
                "不得输出 Markdown 或解释文字。只允许以下三种主结构：\n"
                '{"accepted":false,"reason":"policy_refusal"}\n'
                '{"accepted":true,"data":{"complete":{"from":["fact-id"],"description":"..."}}}\n'
                '{"accepted":true,"data":{"intents":[{"from":["fact-id"],"description":"..."}]}}\n'
            )
            try:
                repair_command = driver.build_conclude(worker, repair_prompt, session)
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
                return "failed"
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
                return "failed"
            try:
                model_output = driver.extract_response_text(
                    repair.stdout, repair.stderr
                )
                payload = parse_json_output(model_output)
                kind, data = validate_reason_payload(
                    payload,
                    open_intents_empty=not open_intents,
                    max_intents=available_intent_slots,
                    valid_fact_ids=set(allowed_fact_ids),
                )
            except Exception as repair_exc:
                LOG.warning(
                    "reason format repair invalid project=%s worker=%s error=%s stdout_preview=%s stderr_preview=%s",
                    project.project.id,
                    worker.name,
                    repair_exc,
                    preview(repair.stdout),
                    preview(repair.stderr),
                )
                return "failed"
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
        if kind == "complete":
            response = client.complete(
                project.project.id, data["from"], data["description"], worker.name
            )
            if response.status_code == 403:
                LOG.info(
                    "project became inactive during reason complete project=%s worker=%s",
                    project.project.id,
                    worker.name,
                )
                return "success"
            if not response.ok:
                LOG.warning(
                    "reason complete write failed project=%s worker=%s status=%s body=%s",
                    project.project.id,
                    worker.name,
                    response.status_code,
                    response.text,
                )
                return "failed"
            LOG.info(
                "project completed project=%s worker=%s from=%s execute_ms=%s total_ms=%s",
                project.project.id,
                worker.name,
                data["from"],
                execute_ms,
                total_ms,
            )
            return "success"
        if kind == "intents":
            created = 0
            for intent_data in data:
                response = client.create_intent(
                    project.project.id,
                    intent_data["from"],
                    intent_data["description"],
                    worker.name,
                )
                if response.status_code == 403:
                    LOG.info(
                        "project became inactive during reason intent create project=%s worker=%s created=%s",
                        project.project.id,
                        worker.name,
                        created,
                    )
                    return "success"
                if response.status_code == 409:
                    LOG.info(
                        "reason intent lost race project=%s worker=%s from=%s",
                        project.project.id,
                        worker.name,
                        intent_data["from"],
                    )
                    continue
                if not response.ok:
                    LOG.warning(
                        "reason intent write failed project=%s worker=%s status=%s body=%s",
                        project.project.id,
                        worker.name,
                        response.status_code,
                        response.text,
                    )
                    continue
                created += 1
                LOG.info(
                    "reason created intent project=%s worker=%s from=%s description=%s",
                    project.project.id,
                    worker.name,
                    intent_data["from"],
                    intent_data["description"],
                )
            LOG.info(
                "reason finished project=%s worker=%s created_intents=%s/%s execute_ms=%s total_ms=%s",
                project.project.id,
                worker.name,
                created,
                len(data),
                execute_ms,
                total_ms,
            )
            if created == 0:
                LOG.warning(
                    "reason created no intents project=%s worker=%s attempted=%s execute_ms=%s total_ms=%s",
                    project.project.id,
                    worker.name,
                    len(data),
                    execute_ms,
                    total_ms,
                )
                return "failed"
            return "success"
        LOG.info(
            "reason finished without graph change project=%s worker=%s execute_ms=%s total_ms=%s",
            project.project.id,
            worker.name,
            execute_ms,
            total_ms,
        )
        return "success"
    finally:
        if inbox is not None:
            inbox.stop()
        lease.stop()
        best_effort_release_reason(client, project.project.id, worker.name)
