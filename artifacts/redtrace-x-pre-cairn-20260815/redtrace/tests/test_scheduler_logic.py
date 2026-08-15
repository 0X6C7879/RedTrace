from __future__ import annotations

import json
from concurrent.futures import Future
from types import SimpleNamespace

from conftest import make_config, make_intent, make_project
from redtrace.board.models import Fact, ProjectSummary
from redtrace.dispatcher.runtime.cancellation import TaskCancellation
from redtrace.dispatcher.scheduler import project_policy
from redtrace.dispatcher.scheduler.loop import DispatcherLoop
from redtrace.dispatcher.scheduler.state import ReasonCheckpoint, RunningTask
from redtrace.dispatcher.scheduler.worker_select import select_worker


def _loop() -> DispatcherLoop:
    loop = DispatcherLoop.__new__(DispatcherLoop)
    loop.reason_checkpoints = {}
    loop.reason_request_generations = {}
    loop.runtime_project_ids = set()
    loop.cleanup_futures = {}
    loop._cleanup_pending = set()
    loop._inactive_cleanup_done = {}
    loop.worker_unhealthy_until = {}
    loop.worker_rejected_until = {}
    loop.explore_retry_avoid = {}
    loop.task_failures = {}
    loop.task_retry_until = {}
    loop.reason_debounce_until = {}
    loop.reason_dirty_since = {}
    loop._log_state = {}
    loop.project_cursor = 0
    loop.futures = {}
    return loop


def _summary(project_id: str, status: str) -> ProjectSummary:
    return ProjectSummary(
        id=project_id,
        title=project_id,
        status=status,
        bootstrap_enabled=True,
        created_at="2026-01-01T00:00:00Z",
        fact_count=2,
        intent_count=0,
        working_intent_count=0,
        unclaimed_intent_count=0,
        hint_count=0,
    )


def test_reason_graph_snapshot_uses_already_loaded_detail() -> None:
    project = make_project(intents=[make_intent()])

    payload = json.loads(project_policy.reason_graph_snapshot(project))

    assert payload["project"]["title"] == project.project.title
    assert payload["facts"][0]["id"] == "origin"
    assert payload["intents"][0]["from"] == project.intents[0].from_
    assert "shared_resources" not in payload


def test_explore_snapshot_only_contains_dependencies_without_truncation() -> None:
    intent = make_intent()
    intent.from_ = ["f001"]
    project = make_project(intents=[intent])
    project.facts[2].description = "x" * 2000
    project.facts.append(Fact(id="f999", description="unrelated"))

    payload = json.loads(project_policy.compact_snapshot(project, intent))

    assert {fact["id"] for fact in payload["facts"]} == {"origin", "goal", "f001"}
    assert payload["facts"][2]["description"] == "x" * 2000
    assert "truncated" not in json.dumps(payload)
    assert [item["id"] for item in payload["intents"]] == [intent.id]


def test_reason_trigger_detects_new_facts_and_open_intent_completion() -> None:
    loop = _loop()
    project = make_project(intents=[make_intent()])
    loop.reason_checkpoints["proj_001"] = ReasonCheckpoint(
        fact_count=3,
        hint_count=1,
        open_intent_count=1,
    )
    project.facts.append(Fact(id="f002", description="new"))
    project.intents = []

    assert loop._reason_trigger(project) == "facts:3->4,open_intents:1->0"


def test_reason_trigger_returns_none_when_graph_is_unchanged() -> None:
    loop = _loop()
    project = make_project(intents=[make_intent()])
    loop.reason_checkpoints["proj_001"] = ReasonCheckpoint(
        fact_count=3,
        hint_count=1,
        open_intent_count=1,
    )

    assert loop._reason_trigger(project) is None


def test_refresh_runtime_projects_discards_active_and_changed_cleanup_markers() -> None:
    loop = _loop()
    loop.runtime_project_ids = {"active", "stopped", "deleted"}
    loop._inactive_cleanup_done = {
        "active": "stopped",
        "stopped": "stopped",
        "changed": "completed",
        "deleted": "completed",
    }

    loop._refresh_runtime_projects(
        [
            _summary("active", "active"),
            _summary("stopped", "stopped"),
            _summary("changed", "stopped"),
        ]
    )

    assert loop.runtime_project_ids == {"active"}
    assert loop._inactive_cleanup_done == {"stopped": "stopped"}


def test_reap_cleanup_future_records_only_successful_inactive_cleanup() -> None:
    loop = _loop()
    succeeded: Future[bool] = Future()
    failed: Future[bool] = Future()
    succeeded.set_result(True)
    failed.set_result(False)
    loop.cleanup_futures = {
        succeeded: ("container-success", "proj-success", "completed"),
        failed: ("container-failed", "proj-failed", "stopped"),
    }
    loop._cleanup_pending = {"container-success", "container-failed"}
    loop._inactive_cleanup_done = {"proj-failed": "stopped"}

    loop._reap_cleanup_futures()

    assert loop.cleanup_futures == {}
    assert loop._cleanup_pending == set()
    assert loop._inactive_cleanup_done == {"proj-success": "completed"}


def test_select_worker_prefers_idle_before_priority() -> None:
    workers = make_config().workers
    lower_priority = workers[0].model_copy(update={"name": "lower", "priority": 1})
    busy_high_priority = workers[0].model_copy(
        update={"name": "busy-high", "priority": 0, "max_running": 3}
    )

    selection = select_worker(
        [busy_high_priority, lower_priority],
        {"busy-high": 1, "lower": 0},
        {},
        {},
        project_id="proj_001",
        work_kind="reason",
        now=0,
    )

    assert selection.worker is lower_priority


def test_select_worker_prefers_priority_within_idle_tier() -> None:
    worker = make_config().workers[0]
    high_priority = worker.model_copy(update={"name": "high", "priority": 0})
    low_priority = worker.model_copy(update={"name": "low", "priority": 1})

    selection = select_worker(
        [low_priority, high_priority],
        {},
        {},
        {},
        project_id="proj_001",
        work_kind="reason",
        now=0,
    )

    assert selection.worker is high_priority


def test_select_worker_only_uses_workers_configured_for_task() -> None:
    worker = make_config().workers[0]
    reason_only = worker.model_copy(
        update={"name": "reason", "task_types": ["reason"], "priority": 0}
    )
    explore = worker.model_copy(
        update={"name": "explore", "task_types": ["explore"], "priority": 1}
    )

    selection = select_worker(
        [reason_only, explore],
        {},
        {},
        {},
        project_id="proj_001",
        work_kind="explore",
        now=0,
    )

    assert selection.worker is explore
    assert selection.blocked_task_type == ["reason"]


def test_new_fact_does_not_trigger_reason_while_ready_intent_fills_capacity() -> None:
    loop = _loop()
    loop.config = make_config()
    loop.futures = {}
    project = make_project(intents=[make_intent()])
    project.intents[0].worker = None
    project.facts.append(Fact(id="f002", description="new"))
    loop.reason_checkpoints["proj_001"] = ReasonCheckpoint(
        fact_count=3,
        hint_count=1,
        open_intent_count=1,
    )
    loop.container_manager = type(
        "Containers", (), {"container_name": lambda _self, project_id: project_id}
    )()
    loop.client = type(
        "Client",
        (),
        {
            "get_project": lambda _self, _project_id: project,
            "export_project": lambda _self, _project_id: "graph",
        },
    )()
    dispatched: list[tuple[str, str]] = []
    loop._dispatch_reason = lambda _project, _graph, trigger: (
        dispatched.append(("reason", trigger)) or True
    )
    loop._dispatch_explore = lambda *_args: dispatched.append(("explore", "")) or True

    summary = _summary("proj_001", "active")
    summary.unclaimed_intent_count = 1
    assert loop._try_dispatch_project(summary)
    assert dispatched == [("explore", "")]


def test_ready_intent_dispatches_when_reason_worker_is_busy() -> None:
    loop = _loop()
    loop.config = make_config()
    project = make_project(intents=[make_intent()])
    project.intents[0].worker = None
    project.facts.append(Fact(id="f002", description="new"))
    loop.reason_checkpoints["proj_001"] = ReasonCheckpoint(3, 1, 1)
    loop.container_manager = SimpleNamespace(
        container_name=lambda project_id: project_id
    )
    loop.client = SimpleNamespace(get_project=lambda _project_id: project)
    dispatched: list[str] = []
    loop._dispatch_reason = lambda *_args: dispatched.append("reason") or False
    loop._dispatch_explore = lambda *_args: dispatched.append("explore") or True
    assert not loop._reason_coalesce_ready("proj_001")
    loop.reason_dirty_since["proj_001"] -= 10

    assert loop._try_dispatch_project(_summary("proj_001", "active"))
    assert dispatched == ["reason", "explore"]


def test_idle_explore_capacity_triggers_reason_before_frontier_is_empty() -> None:
    loop = _loop()
    base = make_config()
    explore_workers = [
        base.workers[0].model_copy(
            update={"name": f"explore-{index}", "task_types": ["explore"]}
        )
        for index in range(3)
    ]
    reason_worker = base.workers[0].model_copy(
        update={"name": "reason-only", "task_types": ["reason"]}
    )
    loop.config = base.model_copy(
        update={
            "runtime": base.runtime.model_copy(
                update={"max_workers": 4, "max_project_workers": 4}
            ),
            "workers": [*explore_workers, reason_worker],
        }
    )
    first = make_intent("i001")
    first.worker = "explore-0"
    second = make_intent("i002")
    second.worker = "explore-1"
    project = make_project(intents=[first, second])
    loop.reason_checkpoints["proj_001"] = ReasonCheckpoint(3, 1, 3)
    for worker, intent_id in (("explore-0", "i001"), ("explore-1", "i002")):
        loop.futures[Future()] = RunningTask(
            "proj_001",
            "explore",
            worker,
            TaskCancellation(),
            intent_id=intent_id,
        )
    loop.container_manager = SimpleNamespace(
        container_name=lambda project_id: project_id
    )
    loop.client = SimpleNamespace(get_project=lambda _project_id: project)
    dispatched: list[str] = []
    loop._dispatch_reason = lambda _project, _graph, trigger: (
        dispatched.append(trigger) or True
    )

    summary = _summary("proj_001", "active")
    summary.fact_count = 3
    summary.intent_count = 2
    summary.working_intent_count = 2
    assert loop._try_dispatch_project(summary)
    assert dispatched == ["frontier_low:open_intents:3->2"]


def test_intent_completion_during_reason_requests_follow_up_reason() -> None:
    loop = _loop()
    loop.reason_request_generations["proj_001"] = 2
    future: Future[str] = Future()
    future.set_result("success")
    loop.futures[future] = RunningTask(
        "proj_001",
        "reason",
        "worker",
        TaskCancellation(),
        fact_count=4,
        hint_count=1,
        open_intent_count=1,
        reason_request_generation=1,
    )

    loop._reap_futures()

    assert loop.reason_checkpoints["proj_001"].request_generation == 1
    assert (
        project_policy.reason_trigger(
            loop.reason_checkpoints["proj_001"],
            fact_count=4,
            hint_count=1,
            open_intents=1,
            request_generation=2,
        )
        == "intent_results:1->2"
    )


def test_successful_explore_records_runtime_without_direct_reason_request() -> None:
    loop = _loop()
    reported: list[tuple] = []
    loop.client = SimpleNamespace(
        report_intent_outcome=lambda *args: reported.append(args)
    )
    future: Future[str] = Future()
    future.set_result("success")
    loop.futures[future] = RunningTask(
        "proj_001", "explore", "worker", TaskCancellation(), intent_id="i001"
    )

    loop._reap_futures()

    assert loop.reason_request_generations == {}
    assert loop.reason_debounce_until == {}
    assert reported[0][:4] == ("proj_001", "i001", "worker", "success")
    assert reported[0][4] >= 0


def test_revision_conflict_requests_follow_up_without_advancing_checkpoint() -> None:
    loop = _loop()
    loop.reason_checkpoints["proj_001"] = ReasonCheckpoint(4, 1, 2)
    future: Future[str] = Future()
    future.set_result("revision_conflict")
    loop.futures[future] = RunningTask(
        "proj_001",
        "reason",
        "reason-worker",
        TaskCancellation(),
        fact_count=4,
        hint_count=1,
        open_intent_count=2,
        reason_request_generation=0,
    )

    loop._reap_futures()

    assert loop.reason_checkpoints["proj_001"] == ReasonCheckpoint(4, 1, 2)
    assert loop.reason_request_generations["proj_001"] == 1
    assert loop.reason_dirty_since["proj_001"] == 0.0


def test_failed_task_retries_use_exponential_backoff(monkeypatch) -> None:
    loop = _loop()
    monkeypatch.setattr("redtrace.dispatcher.scheduler.loop.time.time", lambda: 100.0)
    for expected_deadline in (105.0, 115.0, 160.0, 400.0, 400.0):
        future: Future[str] = Future()
        future.set_result("failed")
        loop.futures[future] = RunningTask(
            "proj_001", "explore", "worker", TaskCancellation(), intent_id="i001"
        )
        loop._reap_futures()
        assert loop.task_retry_until[("proj_001", "explore", "i001")] == expected_deadline

    assert loop._task_retry_blocked(("proj_001", "explore", "i001"), now=399.0)
    assert not loop._task_retry_blocked(("proj_001", "explore", "i001"), now=400.0)


def test_failed_explore_switches_to_different_worker_configuration() -> None:
    loop = _loop()
    worker = make_config().workers[0]
    failed = worker.model_copy(update={"name": "failed", "priority": 0})
    alternate = worker.model_copy(update={"name": "alternate", "priority": 1})
    loop.config = make_config().model_copy(update={"workers": [failed, alternate]})
    future: Future[str] = Future()
    future.set_result("failed")
    loop.futures[future] = RunningTask(
        "proj_001", "explore", "failed", TaskCancellation(), intent_id="i001"
    )

    loop._reap_futures()
    avoid_worker = loop.explore_retry_avoid[("proj_001", "i001")]
    selection = loop._select_worker(
        "proj_001", "explore", avoid_worker=avoid_worker
    )

    assert selection.worker is alternate
    assert avoid_worker == "failed"


def test_failed_explore_reuses_same_worker_when_no_other_is_idle() -> None:
    worker = make_config().workers[0]
    busy_alternate = worker.model_copy(update={"name": "busy"})

    selection = select_worker(
        [worker, busy_alternate],
        {"busy": 1},
        {},
        {},
        project_id="proj_001",
        work_kind="explore",
        now=0,
        avoid_worker=worker.name,
    )

    assert selection.worker is worker


def test_initial_enabled_project_dispatches_bootstrap_with_any_worker() -> None:
    loop = _loop()
    loop.config = make_config()
    loop.futures = {}
    project = make_project()
    project.facts = project.facts[:2]
    loop.container_manager = type(
        "Containers", (), {"container_name": lambda _self, project_id: project_id}
    )()
    loop.client = type(
        "Client",
        (),
        {
            "get_project": lambda _self, _project_id: project,
            "export_project": lambda _self, _project_id: "graph",
        },
    )()
    dispatched: list[tuple[str, str]] = []
    loop._dispatch_initial_project = lambda _project: (
        dispatched.append(("bootstrap", "")) or True
    )
    loop._dispatch_reason = lambda _project, _graph, trigger: (
        dispatched.append(("reason", trigger)) or True
    )

    assert loop._try_dispatch_project(_summary("proj_001", "active"))
    assert dispatched == [("bootstrap", "")]


def test_initial_project_without_bootstrap_worker_dispatches_reason() -> None:
    loop = _loop()
    config = make_config()
    loop.config = config.model_copy(
        update={
            "workers": [
                config.workers[0].model_copy(
                    update={"task_types": ["reason", "explore"]}
                )
            ]
        }
    )
    project = make_project()
    project.facts = project.facts[:2]
    loop.container_manager = SimpleNamespace(
        container_name=lambda project_id: project_id
    )
    loop.client = SimpleNamespace(get_project=lambda _project_id: project)
    dispatched: list[str] = []
    loop._dispatch_initial_project = (
        lambda _project: dispatched.append("bootstrap") or True
    )
    loop._dispatch_reason = lambda *_args: dispatched.append("reason") or True

    assert loop._try_dispatch_project(_summary("proj_001", "active"))
    assert dispatched == ["reason"]


def test_initial_disabled_project_skips_configured_bootstrap_worker() -> None:
    loop = _loop()
    loop.config = make_config()
    loop.futures = {}
    project = make_project()
    project.project.bootstrap_enabled = False
    project.facts = project.facts[:2]
    loop.container_manager = type(
        "Containers", (), {"container_name": lambda _self, project_id: project_id}
    )()
    loop.client = type(
        "Client",
        (),
        {
            "get_project": lambda _self, _project_id: project,
            "export_project": lambda _self, _project_id: "graph",
        },
    )()
    dispatched: list[tuple[str, str]] = []
    loop._dispatch_initial_project = lambda _project: (
        dispatched.append(("bootstrap", "")) or True
    )
    loop._dispatch_reason = lambda _project, _graph, trigger: (
        dispatched.append(("reason", trigger)) or True
    )

    assert loop._try_dispatch_project(_summary("proj_001", "active"))
    assert dispatched == [("reason", "initial")]


def test_initial_enabled_project_requires_bootstrap() -> None:
    loop = _loop()
    loop.config = make_config()
    project = make_project()
    project.project.bootstrap_enabled = True
    project.facts = project.facts[:2]

    assert project_policy.requires_bootstrap(project)


def test_initial_enabled_project_keeps_existing_bootstrap_intent_when_workers_change() -> (
    None
):
    loop = _loop()
    loop.config = make_config()
    project = make_project(intents=[make_intent()])
    project.project.bootstrap_enabled = True
    project.facts = project.facts[:2]
    project.intents[0].description = "bootstrap"
    project.intents[0].creator = "dispatcher.bootstrap"
    project.intents[0].from_ = ["origin"]

    assert project_policy.requires_bootstrap(project)


def test_cancel_inactive_tasks_marks_stopped_and_deleted_projects() -> None:
    loop = _loop()
    stopped = TaskCancellation()
    deleting = TaskCancellation()
    deleted = TaskCancellation()
    loop.futures = {
        Future(): RunningTask("stopped", "explore", "worker", stopped),
        Future(): RunningTask("deleting", "explore", "worker", deleting),
        Future(): RunningTask("deleted", "reason", "worker", deleted),
    }

    loop._cancel_inactive_tasks(
        [
            _summary("stopped", "stopped"),
            _summary("deleting", "deleting"),
        ]
    )

    assert stopped.reason == "stopped"
    assert deleting.reason == "deleting"
    assert deleted.reason == "deleted"


def test_initialize_reason_checkpoint_only_for_active_projects_with_open_intents() -> (
    None
):
    loop = _loop()
    loop.config = make_config()
    active = _summary("active", "active")
    active.unclaimed_intent_count = 1

    loop._initialize_reason_checkpoints(
        [
            active,
            _summary("idle", "active"),
            _summary("stopped", "stopped"),
        ]
    )

    assert loop.reason_checkpoints == {
        "active": ReasonCheckpoint(fact_count=2, hint_count=0, open_intent_count=1)
    }


def test_select_worker_reports_busy_unhealthy_and_rejected_workers(
    monkeypatch,
) -> None:
    loop = _loop()
    base = make_config()
    busy = base.workers[0].model_copy(update={"name": "busy"})
    unhealthy = base.workers[0].model_copy(update={"name": "unhealthy"})
    rejected = base.workers[0].model_copy(update={"name": "rejected"})
    loop.config = base.model_copy(
        update={"workers": [busy, unhealthy, rejected]}
    )
    loop.futures = {Future(): RunningTask("proj", "reason", "busy", TaskCancellation())}
    loop.worker_unhealthy_until = {"unhealthy": 110.0}
    loop.worker_rejected_until = {("proj", "reason", "rejected"): 120.0}
    monkeypatch.setattr("redtrace.dispatcher.scheduler.loop.time.time", lambda: 100.0)

    selection = loop._select_worker("proj", "reason")

    assert selection.worker is None
    assert selection.blocked_busy == ["busy(1/1)"]
    assert selection.blocked_unhealthy == ["unhealthy(10.0s)"]
    assert selection.blocked_rejected == ["rejected(20.0s)"]


def test_stable_summary_skips_project_detail_request() -> None:
    loop = _loop()
    loop.config = make_config()
    loop.container_manager = SimpleNamespace(container_name=lambda project_id: project_id)
    loop.client = SimpleNamespace(
        get_project=lambda project_id: (_ for _ in ()).throw(
            AssertionError(f"unexpected detail request for {project_id}")
        )
    )
    loop.reason_checkpoints["stable"] = ReasonCheckpoint(2, 0, 0)

    assert loop._try_dispatch_project(_summary("stable", "active")) is False


def test_disabled_worker_healthcheck_skips_automatic_startup_but_force_runs_diagnostic() -> (
    None
):
    loop = _loop()
    config = make_config()
    loop.config = config.model_copy(
        update={
            "runtime": config.runtime.model_copy(
                update={"worker_healthcheck": "disabled"}
            )
        }
    )
    calls: list[bool] = []
    loop._run_startup_healthchecks = lambda *, show_commands: calls.append(
        show_commands
    )
    loop._startup_healthchecks_checked = False

    loop.run_startup_healthchecks()

    assert calls == []
    assert loop._startup_healthchecks_checked

    loop._startup_healthchecks_checked = False
    loop.run_startup_healthchecks(show_commands=True, force=True)

    assert calls == [True]


def test_startup_only_worker_healthcheck_runs_automatic_startup_check() -> None:
    loop = _loop()
    config = make_config()
    loop.config = config.model_copy(
        update={
            "runtime": config.runtime.model_copy(
                update={"worker_healthcheck": "startup_only"}
            )
        }
    )
    calls: list[bool] = []
    loop._run_startup_healthchecks = lambda *, show_commands: calls.append(
        show_commands
    )
    loop._startup_healthchecks_checked = False

    loop.run_startup_healthchecks()

    assert calls == [False]
