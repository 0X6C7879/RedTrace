from __future__ import annotations

import json
import logging
import re
import threading
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from redtrace.dispatcher.audit import AuditPublisher
from redtrace.dispatcher.config import DispatchConfig, WorkerConfig
from redtrace.dispatcher.control_plane import ControlPlaneClient
from redtrace.dispatcher.runtime.cancellation import TaskCancellation
from redtrace.dispatcher.runtime.containers import ContainerManager
from redtrace.dispatcher.runtime.heartbeat import HeartbeatLease
from redtrace.dispatcher.runtime.process import ProcessResult
from redtrace.dispatcher.workers.adapters.claudecode import CLAUDE_MAX_THINKING_TOKENS

PROCESS_COMMUNICATE_GRACE_SECONDS = 15
GRAPH_SNAPSHOT_ROOT = "/home/kali/workspace/.redtrace/prompts"
BLACKBOARD_NOTICE_ROOT = ".redtrace/blackboard-notices"
LOG = logging.getLogger(__name__)
_COORDINATION_KEY = re.compile(
    r"https?://[^\s]+|\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b|"
    r"\bCVE-\d{4}-\d+\b|\b(?:ws|lis|ses|pay)_[0-9a-f]{12}\b|"
    r"(?:/[A-Za-z0-9._~!$&'()*+,;=:@%+-]+){2,}",
    re.IGNORECASE,
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
    return not result.cancelled and (
        result.timed_out or result.returncode in (124, 137)
    )


def process_failure_outcome(result: ProcessResult) -> str:
    if did_timeout(result):
        return "timeout"
    text = f"{result.stdout}\n{result.stderr}".lower()
    if "no session found" in text or "session not found" in text:
        return "session_missing"
    return "provider_exit"


def exception_failure_outcome(exc: Exception) -> str:
    text = str(exc).lower()
    if "workspace integrity failure" in text:
        return "workspace_integrity"
    if "session" in text and ("missing" in text or "not found" in text):
        return "session_missing"
    return "internal_error"


def record_session_checkpoint(
    client: CairnClient,
    container_manager: ContainerManager,
    project_id: str,
    intent_id: str | None,
    worker: WorkerConfig,
    session_id: str | None,
    stage: str,
) -> dict[str, object] | None:
    if worker.type != "pi" or not session_id:
        return None
    inspect = getattr(container_manager, "session_checkpoint", None)
    publish = getattr(client, "record_session_checkpoint", None)
    if not callable(inspect) or not callable(publish):
        return None
    try:
        checkpoint = inspect(project_id, worker.type, worker.name, session_id)
        publish(
            {
                "project_id": project_id,
                "intent_id": intent_id,
                "worker": worker.name,
                "provider": worker.type,
                "session_id": session_id,
                "stage": stage,
                **checkpoint,
            }
        )
        return checkpoint
    except Exception:
        LOG.warning(
            "session checkpoint publish failed project=%s worker=%s session=%s stage=%s",
            project_id,
            worker.name,
            session_id,
            stage,
            exc_info=True,
        )
        return None


def ensure_worker_running(
    container_manager: ContainerManager, project_id: str, worker: WorkerConfig
) -> str:
    ensure = getattr(container_manager, "ensure_worker_running", None)
    if callable(ensure):
        return ensure(project_id, worker.name, worker.type)
    return container_manager.ensure_running(project_id)


def cancel_reason(
    result: ProcessResult, cancellation: TaskCancellation | None = None
) -> str | None:
    if result.cancelled:
        return result.cancel_reason or "cancelled"
    if cancellation is not None:
        return cancellation.reason
    return None


def communicate_timeout(
    timeout_seconds: int, grace_seconds: int = PROCESS_COMMUNICATE_GRACE_SECONDS
) -> int:
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


class BlackboardInbox:
    """A per-turn, project-scoped inbox that emits short relevant Fact signals."""

    def __init__(
        self,
        client: ControlPlaneClient,
        container_manager: ContainerManager,
        container_name: str,
        *,
        project_id: str,
        intent_id: str | None,
        intent_description: str,
        source_fact_ids: list[str],
        worker_name: str,
        revision: int,
        task_type: str = "explore",
        all_facts: bool = False,
    ):
        self._client = client
        self._container_manager = container_manager
        self._container_name = container_name
        self._project_id = project_id
        self._intent_id = intent_id
        self._intent_description = intent_description
        self._source_fact_ids = set(source_fact_ids) - {"origin", "goal"}
        self._worker_name = worker_name
        self._task_type = task_type
        self._all_facts = all_facts
        self._cursor = revision
        self._initial_revision = revision
        self.notice_path = blackboard_notice_path(
            container_name, f"{worker_name}:{intent_id or task_type}"
        )
        self._changes: list[dict[str, Any]] = []
        self._pending: list[dict[str, Any]] = []
        self._signalled_revision = revision
        self._signal_sender: Callable[[str], bool] | None = None
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._started = False

    def start(self) -> None:
        with self._lock:
            if self._started:
                return
            self._started = True
        self._write_notice()
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._started:
            # The daemon exits when its bounded long-poll returns; task completion
            # must not wait on an otherwise idle inbox connection.
            self._thread.join(timeout=0.05)

    def on_process_attached(
        self, signal_sender: Callable[[str], bool] | None = None
    ) -> None:
        with self._lock:
            self._signal_sender = signal_sender
        self.start()
        self._signal_pending()

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                current = self._client.wait_for_blackboard(
                    self._project_id,
                    self._cursor,
                    timeout=2.0,
                )
                if self._stop.is_set():
                    return
                if current <= self._cursor:
                    continue
                payload = self._client.blackboard_changes(
                    self._project_id,
                    self._cursor,
                    worker=self._worker_name,
                    task_type=self._task_type,
                    intent_id=self._intent_id,
                    include_source=True,
                )
                self._publish(payload)
            except Exception as exc:
                if not self._stop.is_set():
                    LOG.warning(
                        "blackboard inbox failed project=%s intent=%s worker=%s error=%s",
                        self._project_id,
                        self._intent_id,
                        self._worker_name,
                        exc,
                    )
                    self._stop.wait(0.5)

    def _publish(self, payload: dict[str, Any]) -> None:
        revision = int(payload.get("revision", self._cursor))
        incoming = [
            change
            for change in payload.get("changes", [])
            if isinstance(change, dict)
            and int(change.get("revision", 0)) > self._cursor
        ]
        relevant = [change for change in incoming if self._should_signal(change)]
        with self._lock:
            self._cursor = max(self._cursor, revision)
            self._changes = (self._changes + incoming)[-100:]
            self._pending = (self._pending + relevant)[-4:]
            signal_revision = max(
                (int(change.get("revision", 0)) for change in relevant),
                default=0,
            )
        self._write_notice()
        if signal_revision:
            self._signal_pending()

    def _signal_pending(self) -> None:
        with self._lock:
            pending = [
                change
                for change in self._pending
                if int(change.get("revision", 0)) > self._signalled_revision
            ]
            revision = max(
                (int(change.get("revision", 0)) for change in pending),
                default=0,
            )
            sender = self._signal_sender
            if not pending or sender is None:
                return
            if sender(format_fact_signal(pending)):
                self._signalled_revision = max(self._signalled_revision, revision)
                self._pending = [
                    change
                    for change in self._pending
                    if int(change.get("revision", 0)) > self._signalled_revision
                ]

    def _write_notice(self) -> None:
        with self._lock:
            payload = {
                "project": self._project_id,
                "since": self._initial_revision,
                "revision": self._cursor,
                "changed": bool(self._changes),
                "changes": list(self._changes),
            }
        self._container_manager.write_text_file(
            self._container_name,
            self.notice_path,
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        )

    def _should_signal(self, change: dict[str, Any]) -> bool:
        if change.get("action") != "added":
            return False
        if change.get("kind") == "hint":
            return True
        if change.get("kind") != "fact":
            return False
        node = change.get("node")
        if not isinstance(node, dict):
            return False
        source = node.get("source")
        if not isinstance(source, dict) or source.get("intent_id") == self._intent_id:
            return False
        if self._all_facts:
            return True
        other_sources = set(source.get("from") or []) - {"origin", "goal"}
        if self._source_fact_ids & other_sources:
            return True
        current_keys = {
            match.group(0).lower()
            for match in _COORDINATION_KEY.finditer(self._intent_description)
        }
        other_text = " ".join(
            (
                str(source.get("intent_description") or ""),
                str(node.get("description") or ""),
            )
        )
        other_keys = {
            match.group(0).lower() for match in _COORDINATION_KEY.finditer(other_text)
        }
        return bool(current_keys & other_keys)


def format_fact_signal(changes: list[dict[str, Any]]) -> str:
    change = max(changes, key=lambda item: int(item.get("revision", 0)))
    node = change.get("node") if isinstance(change.get("node"), dict) else {}
    revision = int(change.get("revision", 0))
    node_id = str(change.get("node_id") or node.get("id") or "")
    summary = str(node.get("description") or node.get("content") or "").strip()
    summary = " ".join(summary.split())[:240]
    kind = "Fact" if change.get("kind") == "fact" else "Hint"
    inspect = (
        f"需要时运行 redtrace-blackboard source {node_id} 查看详情和来源对话。"
        if kind == "Fact" and node_id
        else "需要时读取 REDTRACE_BLACKBOARD_NOTICE 查看详情。"
    )
    return (
        f"[RedTrace {kind} signal r{revision}] {node_id}: {summary}\n"
        f"这是可选的新证据，不要求采用，也不要自动改变当前方向；由你判断相关性。{inspect}"
    )


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
        "当前 Task Graph snapshot 位于当前 Workspace 的以下文件：\n\n"
        f"{readable_path}\n\n"
        "该文件包含当前 Blackboard 中的 Fact、Hint 和 Intent。"
        "请根据当前规划需要自行决定读取方式：可以直接读取文件，"
        "也可以使用 redtrace-blackboard 对节点、上下文、来源和最新变化进行按需查询。"
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
    blackboard_inbox: BlackboardInbox | None = None,
    live_control: Any | None = None,
    session: str | None = None,
    env_overrides: dict[str, str] | None = None,
) -> ProcessResult:
    LOG.info(
        "starting container exec container=%s worker=%s phase=%s timeout=%ss",
        container_name,
        worker.name,
        phase,
        timeout_seconds,
    )
    process_env = dict(worker.env)
    if env_overrides:
        process_env.update(env_overrides)
    task_type = phase.split("_", 1)[0]
    if task_type == "reason":
        for name in (
            "REDTRACE_SKILLS_DIR",
            "REDTRACE_SKILL_PATHS",
            "REDTRACE_SKILL_MEMORY_DIR",
            "REDTRACE_GLOBAL_INSTRUCTIONS",
        ):
            process_env.pop(name, None)
    if project_id is not None:
        environment = getattr(
            container_manager, "worker_conversation_environment", None
        )
        process_env.update(
            environment(project_id, worker.type, worker.name)
            if callable(environment)
            else container_manager.conversation_environment(project_id, worker.type)
        )
    if worker.context_length is not None:
        if worker.type == "claudecode":
            process_env["CLAUDE_CODE_AUTO_COMPACT_WINDOW"] = str(worker.context_length)
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
                "REDTRACE_TASK_TYPE": task_type,
                "REDTRACE_PHASE": phase,
                "REDTRACE_BLACKBOARD_CURSOR": str(blackboard_revision),
            }
        )
        # Skill tracking lifecycle is fully decoupled from the provider
        # session ID. A deterministic tracking id is derived from the
        # task identity (project+intent+worker+task_type) so the same file
        # survives execute -> steering -> conclude regardless of whether
        # the provider session is known before the first run (Claude seeds
        # one up front; Codex/Pi only discover it from the output stream).
        # Reason tasks never create a tracking file.
        if task_type != "reason":
            tracking_path = resolve_skill_tracking_path(
                container_name, task_type, project_id, intent_id, worker.name
            )
            if tracking_path is not None:
                process_env["REDTRACE_LOADED_SKILLS_FILE"] = str(tracking_path)
                _seed_loaded_skills(
                    tracking_path, process_env.get("REDTRACE_SKILL_PATHS", "")
                )
        server_url = getattr(client, "base_url", None)
        if isinstance(server_url, str) and server_url:
            process_env["REDTRACE_SERVER"] = server_url
        if intent_id is not None:
            process_env["REDTRACE_INTENT_ID"] = intent_id
        notice_path = (
            blackboard_inbox.notice_path
            if blackboard_inbox is not None
            else blackboard_notice_path(
                container_name, f"{worker.name}:{intent_id or phase.split('_', 1)[0]}"
            )
        )
        process_env["REDTRACE_BLACKBOARD_NOTICE"] = notice_path
        if lease is not None and blackboard_inbox is None:
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

            if lease.watch_blackboard(blackboard_revision, publish_blackboard_notice):
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
    if live_control is not None:
        process_options["keep_stdin_open"] = True
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
            live_control.prompt
            if live_control is not None
            else stdin_text
            if stdin_text is not None
            else argv[-1]
            if argv
            else "",
        )
    output_handlers = [
        handler
        for handler in (
            live_control.handle_output if live_control is not None else None,
            publisher.handle_output if publisher is not None else None,
        )
        if handler is not None
    ]
    set_output_handler = getattr(process, "set_output_handler", None)
    if callable(set_output_handler) and output_handlers:

        def handle_output(channel: str, line: str) -> None:
            for handler in output_handlers:
                handler(channel, line)

        set_output_handler(handle_output)
    try:
        if live_control is not None:
            live_control.attach(process)
        process.start()
        if lease is not None:
            lease.attach_process(process)
        if cancellation is not None:
            cancellation.attach_process(process)
        if blackboard_inbox is not None:
            blackboard_inbox.on_process_attached(
                live_control.send_signal if live_control is not None else None
            )
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


def resolve_skill_tracking_path(
    container_name: str,
    task_type: str,
    project_id: str | None,
    intent_id: str | None,
    worker_name: str,
) -> Path | None:
    """Return the per-task loaded-skills tracking file path.

    Decoupled from the provider session ID: the tracking id is derived
    from the task identity (project + intent + worker + task_type), so the
    same file is reused across execute / steering / conclude for one task
    even when the provider session is unknown until after the first run
    (Codex thread id, Pi session id are only extracted from the output
    stream). Reason tasks never create a tracking file.
    """
    if (
        not container_name
        or task_type == "reason"
        or not project_id
        or not intent_id
        or not worker_name
    ):
        return None
    tracking_id = uuid.uuid5(
        uuid.NAMESPACE_URL,
        f"{project_id}:{intent_id}:{worker_name}:{task_type}",
    ).hex[:12]
    workspace = Path(container_name)
    if workspace.is_absolute():
        return workspace / ".redtrace" / f"loaded-skills-{tracking_id}.json"
    return Path(f"/home/kali/workspace/.redtrace/loaded-skills-{tracking_id}.json")


def _seed_loaded_skills(tracking_path: Path, skill_paths_env: str) -> None:
    """Pre-populate the tracking file with the professional skills exposed
    for this task.

    This is the Runtime / capability-exposure layer recording which
    professional skills are loaded for the task — no LLM prompt, no reliance
    on the agent remembering to call ``track-load``. ``skill-evolution`` is
    excluded so ordinary verified experience is not written to it by default;
    experience belongs to the professional skill that produced it.
    """
    try:
        paths = json.loads(skill_paths_env) if skill_paths_env else []
    except (json.JSONDecodeError, TypeError):
        return
    if not isinstance(paths, list):
        return
    names = {
        Path(path).name
        for path in paths
        if isinstance(path, str) and path and Path(path).name
    }
    names.discard("skill-evolution")
    if not names:
        return
    try:
        existing: set[str] = set()
        if tracking_path.is_file():
            data = json.loads(tracking_path.read_text(encoding="utf-8"))
            if isinstance(data, list):
                existing = {str(s) for s in data}
        merged = sorted(existing | names)
        tracking_path.parent.mkdir(parents=True, exist_ok=True)
        tracking_path.write_text(
            json.dumps(merged, ensure_ascii=False), encoding="utf-8"
        )
    except (OSError, json.JSONDecodeError, TypeError):
        pass


def _read_loaded_skills(tracking_path: Path | None) -> list[str]:
    """Read loaded skill IDs from a resolved tracking path."""
    if tracking_path is None:
        return []
    try:
        data = tracking_path.read_text(encoding="utf-8")
        skills = json.loads(data)
        if isinstance(skills, list):
            return [str(s) for s in skills]
    except (OSError, json.JSONDecodeError, TypeError):
        pass
    return []


def _cleanup_skill_tracking(tracking_path: Path | None) -> None:
    """Remove the per-task skill tracking file once the task completes."""
    if tracking_path is None:
        return
    try:
        tracking_path.unlink(missing_ok=True)
    except OSError:
        pass


def cleanup_skill_tracking(
    container_name: str,
    task_type: str,
    project_id: str | None,
    intent_id: str | None,
    worker_name: str,
) -> None:
    """Remove the per-task skill tracking file. No LLM call.

    Uses the task identity (not the provider session id) so the file created
    at task start is removed at task end even when no session was ever known.
    """
    tracking_path = resolve_skill_tracking_path(
        container_name, task_type, project_id, intent_id, worker_name
    )
    _cleanup_skill_tracking(tracking_path)


def project_allows_conclude_fallback(
    client: ControlPlaneClient, project_id: str, *, worker_name: str, intent_id: str
) -> bool:
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


def best_effort_release_reason(
    client: ControlPlaneClient, project_id: str, worker_name: str
) -> None:
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
    return ConcludeWriteResult(status="api_error", fact_id=None)


def best_effort_release(
    client: ControlPlaneClient, project_id: str, intent_id: str, worker_name: str
) -> None:
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
        LOG.info(
            "released intent project=%s intent=%s worker=%s",
            project_id,
            intent_id,
            worker_name,
        )
    else:
        LOG.info(
            "release skipped project=%s intent=%s worker=%s status=%s",
            project_id,
            intent_id,
            worker_name,
            response.status_code,
        )
