from __future__ import annotations

from collections.abc import Iterator

from conftest import (
    FakeClient,
    FakeContainerManager,
    FakeDriver,
    FakeLease,
    make_config,
    make_intent,
    make_project,
)
from redtrace.dispatcher.control_plane import ApiResult
from redtrace.dispatcher.runtime.cancellation import TaskCancellation
from redtrace.dispatcher.runtime.process import ProcessResult
from redtrace.dispatcher.tasks import bootstrap, explore, reason
from redtrace.dispatcher.workers.health import HealthResult


def _lease_factory(lease: FakeLease):
    return lambda *_args, **_kwargs: lease


def test_reason_writes_graph_snapshot_and_creates_intent(monkeypatch) -> None:
    config = make_config()
    project = make_project()
    client = FakeClient(project)
    containers = FakeContainerManager()
    driver = FakeDriver()
    lease = FakeLease()
    graph_yaml = "project:\n  title: huge\n" + ("x" * 100_000)

    monkeypatch.setattr(reason, "get_driver", lambda *_a, **_k: driver)
    monkeypatch.setattr(reason.HeartbeatLease, "for_reason", _lease_factory(lease))
    monkeypatch.setattr(
        reason,
        "run_worker_process",
        lambda *_args, **_kwargs: ProcessResult(
            0,
            '{"accepted":true,"data":{"intents":[{"from":["f001"],"description":"next step"}]}}',
            "",
        ),
    )

    outcome = reason.run_reason_task(
        config,
        client,
        containers,
        project,
        graph_yaml,
        config.workers[0],
        TaskCancellation(),
    )

    assert outcome == "success"
    assert client.created_intents == [("proj_001", ["f001"], "next step", "test-worker")]
    assert client.released_reasons == [("proj_001", "test-worker")]
    assert lease.started and lease.stopped
    assert len(containers.writes) == 1
    container_name, path, content = containers.writes[0]
    assert container_name == "container-proj_001"
    assert path.startswith("/home/kali/workspace/.redtrace/prompts/reason_execute-")
    assert path.endswith("/graph.yaml")
    assert content == graph_yaml
    assert graph_yaml not in driver.execute_prompts[0]
    assert path in driver.execute_prompts[0]
    assert driver.conclude_prompts == []


def test_reason_uses_initial_environment_sensing_without_bootstrap(monkeypatch) -> None:
    config = make_config()
    project = make_project()
    project.facts = project.facts[:2]
    project.project.bootstrap_enabled = False
    client = FakeClient(project)
    containers = FakeContainerManager()
    driver = FakeDriver()
    lease = FakeLease()

    monkeypatch.setattr(reason, "get_driver", lambda *_a, **_k: driver)
    monkeypatch.setattr(reason.HeartbeatLease, "for_reason", _lease_factory(lease))
    monkeypatch.setattr(
        reason,
        "run_worker_process",
        lambda *_args, **_kwargs: ProcessResult(
            0,
            '{"accepted":true,"data":{"intents":[{"from":["origin"],"description":"inspect environment"}]}}',
            "",
        ),
    )

    outcome = reason.run_reason_task(
        config,
        client,
        containers,
        project,
        "graph",
        config.workers[0],
        TaskCancellation(),
    )

    assert outcome == "success"
    assert client.created_intents == [("proj_001", ["origin"], "inspect environment", "test-worker")]


def test_bootstrap_timeout_uses_cairn_conclude_fallback(monkeypatch) -> None:
    config = make_config()
    intent = make_intent()
    intent.creator = "dispatcher.bootstrap"
    project = make_project(intents=[intent])
    client = FakeClient(project)
    containers = FakeContainerManager()
    driver = FakeDriver()
    lease = FakeLease()
    results: Iterator[ProcessResult] = iter(
        [
            ProcessResult(124, "discovered workspace layout", "", timed_out=True),
            ProcessResult(
                0,
                '{"accepted":true,"data":{"fact":{"description":"confirmed partial result"}}}',
                "",
            ),
        ]
    )

    monkeypatch.setattr(bootstrap, "get_driver", lambda *_a, **_k: driver)
    monkeypatch.setattr(bootstrap.HeartbeatLease, "for_intent", _lease_factory(lease))
    monkeypatch.setattr(
        bootstrap,
        "run_worker_process",
        lambda *_args, **_kwargs: next(results),
    )

    outcome = bootstrap.run_bootstrap_task(
        config,
        client,
        containers,
        project,
        intent,
        config.workers[0],
        TaskCancellation(),
    )

    assert outcome == "success"
    assert client.concluded == [
        ("proj_001", "i001", "test-worker", "confirmed partial result")
    ]
    assert len(driver.conclude_prompts) == 1


def test_reason_repairs_invalid_format_once(monkeypatch) -> None:
    config = make_config()
    project = make_project()
    client = FakeClient(project)
    containers = FakeContainerManager()
    driver = FakeDriver()
    lease = FakeLease()
    results: Iterator[ProcessResult] = iter(
        [
            ProcessResult(0, "analysis finished, but this is not JSON", ""),
            ProcessResult(
                0,
                '{"accepted":true,"data":{"intents":[{"from":["f001"],"description":"next"}]}}',
                "",
            ),
        ]
    )

    monkeypatch.setattr(reason, "get_driver", lambda *_a, **_k: driver)
    monkeypatch.setattr(reason.HeartbeatLease, "for_reason", _lease_factory(lease))
    monkeypatch.setattr(
        reason, "run_worker_process", lambda *_args, **_kwargs: next(results)
    )

    outcome = reason.run_reason_task(
        config,
        client,
        containers,
        project,
        "graph",
        config.workers[0],
        TaskCancellation(),
    )

    assert outcome == "success"
    assert client.created_intents == [("proj_001", ["f001"], "next", "test-worker")]
    assert len(driver.conclude_prompts) == 1
    assert "不得调用工具" in driver.conclude_prompts[0]


def test_reason_timeout_recovers_with_same_session(monkeypatch) -> None:
    config = make_config()
    project = make_project()
    client = FakeClient(project)
    containers = FakeContainerManager()
    driver = FakeDriver()
    lease = FakeLease()
    results: Iterator[ProcessResult] = iter(
        [
            ProcessResult(124, "partial planning", "", timed_out=True),
            ProcessResult(
                0,
                '{"accepted":true,"data":{"intents":[{"from":["f001"],"description":"recovered"}]}}',
                "",
            ),
        ]
    )
    monkeypatch.setattr(reason, "get_driver", lambda *_a, **_k: driver)
    monkeypatch.setattr(reason.HeartbeatLease, "for_reason", _lease_factory(lease))
    monkeypatch.setattr(
        reason, "run_worker_process", lambda *_args, **_kwargs: next(results)
    )

    outcome = reason.run_reason_task(
        config,
        client,
        containers,
        project,
        "graph",
        config.workers[0],
        TaskCancellation(),
    )

    assert outcome == "success"
    assert client.created_intents == [("proj_001", ["f001"], "recovered", "test-worker")]
    assert len(driver.conclude_prompts) == 1


def test_reason_only_fills_available_open_intent_slots(monkeypatch) -> None:
    config = make_config()
    project = make_project(intents=[make_intent("i001")])
    client = FakeClient(project)
    containers = FakeContainerManager()
    driver = FakeDriver()
    lease = FakeLease()

    monkeypatch.setattr(reason, "get_driver", lambda *_a, **_k: driver)
    monkeypatch.setattr(reason.HeartbeatLease, "for_reason", _lease_factory(lease))
    monkeypatch.setattr(
        reason,
        "run_worker_process",
        lambda *_args, **_kwargs: ProcessResult(
            0,
            '{"accepted":true,"data":{"intents":['
            '{"from":["f001"],"description":"slot one"},'
            '{"from":["f001"],"description":"slot two"}]}}',
            "",
        ),
    )

    outcome = reason.run_reason_task(
        config,
        client,
        containers,
        project,
        "graph",
        config.workers[0],
        TaskCancellation(),
    )

    assert outcome == "success"
    assert client.created_intents == [
        ("proj_001", ["f001"], "slot one", "test-worker"),
        ("proj_001", ["f001"], "slot two", "test-worker"),
    ]


def test_reason_noop_still_commits_evaluated_revision(monkeypatch) -> None:
    config = make_config()
    project = make_project(intents=[make_intent("i001")])
    client = FakeClient(project)
    containers = FakeContainerManager()
    driver = FakeDriver()
    lease = FakeLease()

    monkeypatch.setattr(reason, "get_driver", lambda *_a, **_k: driver)
    monkeypatch.setattr(reason.HeartbeatLease, "for_reason", _lease_factory(lease))
    monkeypatch.setattr(
        reason,
        "run_worker_process",
        lambda *_args, **_kwargs: ProcessResult(
            0, '{"accepted":true,"data":{}}', ""
        ),
    )

    outcome = reason.run_reason_task(
        config,
        client,
        containers,
        project,
        "graph",
        config.workers[0],
        TaskCancellation(),
    )

    assert outcome == "success"
    assert client.created_intents == []
    assert client.completed == []


def test_explore_early_plain_text_exit_uses_conclude_fallback(monkeypatch) -> None:
    config = make_config()
    config.workers[0].type = "pi"
    intent = make_intent()
    project = make_project(intents=[intent])
    client = FakeClient(project)
    containers = FakeContainerManager()
    driver = FakeDriver()
    lease = FakeLease()
    results: Iterator[ProcessResult] = iter(
        [
            ProcessResult(0, "Need inspect files and keep working.", ""),
            ProcessResult(0, '{"accepted":true,"data":{"description":"confirmed fact"}}', ""),
        ]
    )

    monkeypatch.setattr(explore, "get_driver", lambda *_a, **_k: driver)
    monkeypatch.setattr(explore.HeartbeatLease, "for_intent", _lease_factory(lease))
    monkeypatch.setattr(explore, "_run_process", lambda *_args, **_kwargs: next(results))
    monkeypatch.setattr(
        "redtrace.dispatcher.tasks.common.run_worker_process",
        lambda *_args, **_kwargs: ProcessResult(0, '{"accepted":true,"data":{}}', ""),
    )

    outcome = explore.run_explore_task(
        config,
        client,
        containers,
        project,
        "facts:\n- id: f001\n",
        intent,
        config.workers[0],
        TaskCancellation(),
    )

    assert outcome == "success"
    assert client.concluded == [("proj_001", "i001", "test-worker", "confirmed fact")]
    assert len(containers.writes) == 1
    assert "/explore_execute-" in containers.writes[0][1]
    assert len(driver.execute_prompts) == 1
    assert "investigate" in driver.execute_prompts[0]
    assert len(driver.conclude_prompts) == 1
    assert lease.started and lease.stopped


def test_explore_healthcheck_failure_releases_claim(monkeypatch) -> None:
    config = make_config()
    config.runtime.worker_healthcheck = "startup_and_task"
    intent = make_intent()
    project = make_project(intents=[intent])
    client = FakeClient(project)
    containers = FakeContainerManager()
    lease = FakeLease()

    driver = FakeDriver()
    driver.health = HealthResult(ok=False, status=401, detail="unauthorized")
    monkeypatch.setattr(explore, "get_driver", lambda *_a, **_k: driver)
    monkeypatch.setattr(explore.HeartbeatLease, "for_intent", _lease_factory(lease))

    outcome = explore.run_explore_task(
        config,
        client,
        containers,
        project,
        "graph",
        intent,
        config.workers[0],
        TaskCancellation(),
    )

    assert outcome == "unhealthy"
    assert client.released == [("proj_001", "i001", "test-worker")]
    assert containers.writes == []


def test_bootstrap_success_concludes_fact_then_completes_project(monkeypatch) -> None:
    config = make_config()
    intent = make_intent()
    project = make_project(intents=[intent])
    client = FakeClient(project)
    containers = FakeContainerManager()
    driver = FakeDriver()
    lease = FakeLease()

    monkeypatch.setattr(bootstrap, "get_driver", lambda *_a, **_k: driver)
    monkeypatch.setattr(bootstrap.HeartbeatLease, "for_intent", _lease_factory(lease))
    monkeypatch.setattr(
        bootstrap,
        "run_worker_process",
        lambda *_args, **_kwargs: ProcessResult(
            0,
            '{"accepted":true,"data":{"fact":{"description":"solved"},'
            '"complete":{"description":"goal met"}}}',
            "",
        ),
    )

    outcome = bootstrap.run_bootstrap_task(
        config,
        client,
        containers,
        project,
        intent,
        config.workers[0],
        TaskCancellation(),
    )

    assert outcome == "success"
    assert client.concluded == [("proj_001", "i001", "test-worker", "solved")]
    assert client.completed == [("proj_001", ["f002"], "goal met", "test-worker")]
    assert lease.started and lease.stopped


def test_bootstrap_partial_execute_result_uses_conclude_fallback(monkeypatch) -> None:
    config = make_config()
    intent = make_intent()
    project = make_project(intents=[intent])
    client = FakeClient(project)
    containers = FakeContainerManager()
    driver = FakeDriver()
    lease = FakeLease()

    monkeypatch.setattr(bootstrap, "get_driver", lambda *_a, **_k: driver)
    monkeypatch.setattr(bootstrap.HeartbeatLease, "for_intent", _lease_factory(lease))
    monkeypatch.setattr(
        bootstrap,
        "run_worker_process",
        lambda *_args, **_kwargs: ProcessResult(
            0,
            '{"accepted":true,"data":{"fact":{"description":"initial confirmed fact"}}}',
            "",
        ),
    )

    outcome = bootstrap.run_bootstrap_task(
        config,
        client,
        containers,
        project,
        intent,
        config.workers[0],
        TaskCancellation(),
    )

    assert outcome == "success"
    assert client.concluded == [("proj_001", "i001", "test-worker", "initial confirmed fact")]
    assert client.completed == []
    assert len(driver.conclude_prompts) == 1
    assert lease.started and lease.stopped


def test_reason_complete_treats_inactive_project_as_success(monkeypatch) -> None:
    config = make_config()
    project = make_project()
    client = FakeClient(project)
    containers = FakeContainerManager()
    lease = FakeLease()

    def complete_403(*_args, **_kwargs) -> ApiResult:
        return ApiResult(403, text="inactive")

    client.complete = complete_403  # type: ignore[method-assign]
    monkeypatch.setattr(reason, "get_driver", lambda *_a, **_k: FakeDriver())
    monkeypatch.setattr(reason.HeartbeatLease, "for_reason", _lease_factory(lease))
    monkeypatch.setattr(
        reason,
        "run_worker_process",
        lambda *_args, **_kwargs: ProcessResult(
            0,
            '{"accepted":true,"data":{"complete":{"from":["f001"],"description":"done"}}}',
            "",
        ),
    )

    outcome = reason.run_reason_task(
        config,
        client,
        containers,
        project,
        "graph",
        config.workers[0],
        TaskCancellation(),
    )

    assert outcome == "success"
    assert client.released_reasons == [("proj_001", "test-worker")]


def test_reason_startup_only_mode_skips_task_healthcheck(monkeypatch) -> None:
    config = make_config()
    config.runtime.worker_healthcheck = "startup_only"
    project = make_project()
    client = FakeClient(project)
    containers = FakeContainerManager()
    lease = FakeLease()

    driver = FakeDriver()

    def _boom(*_a, **_k):
        raise AssertionError("task healthcheck should be skipped")

    driver.check_health = _boom  # type: ignore[method-assign]
    monkeypatch.setattr(reason, "get_driver", lambda *_a, **_k: driver)
    monkeypatch.setattr(reason.HeartbeatLease, "for_reason", _lease_factory(lease))
    monkeypatch.setattr(
        reason,
        "run_worker_process",
        lambda *_args, **_kwargs: ProcessResult(
            0,
            '{"accepted":true,"data":{"intents":[{"from":["f001"],"description":"next"}]}}',
            "",
        ),
    )

    outcome = reason.run_reason_task(
        config,
        client,
        containers,
        project,
        "graph",
        config.workers[0],
        TaskCancellation(),
    )

    assert outcome == "success"
    assert client.created_intents == [("proj_001", ["f001"], "next", "test-worker")]


def test_access_channel_fact_gets_registered_resource_id() -> None:
    class Client:
        @staticmethod
        def resource_snapshot(_project_id: str):
            return [
                {
                    "id": "ws_123456789abc",
                    "kind": "webshell",
                    "intent_id": "other-intent",
                    "worker": "other-worker",
                    "status": "available",
                }
            ]

    description, ok = explore._attach_access_resource_ids(
        Client(), "proj_001", "i001", "Pi", "WebShell 已验证可执行命令"
    )

    assert ok
    assert description.endswith("Shared Resource IDs: ws_123456789abc")


def test_listener_id_does_not_satisfy_access_channel_gate() -> None:
    class Client:
        @staticmethod
        def resource_snapshot(_project_id: str):
            return [
                {
                    "id": "lis_123456789abc",
                    "kind": "c2_listener",
                    "intent_id": "i001",
                    "worker": "Pi",
                }
            ]

    description, ok = explore._attach_access_resource_ids(
        Client(), "proj_001", "i001", "Pi", "reverse shell via lis_123456789abc"
    )

    assert not ok
    assert description == "reverse shell via lis_123456789abc"


def test_access_channel_fact_without_registered_resource_is_blocked() -> None:
    class Client:
        @staticmethod
        def resource_snapshot(_project_id: str):
            return []

    description, ok = explore._attach_access_resource_ids(
        Client(), "proj_001", "i001", "Pi", "reverse shell connected"
    )

    assert not ok
    assert description == "reverse shell connected"


def test_resource_commit_failure_preserves_result_without_reexecution(monkeypatch) -> None:
    config = make_config()
    intent = make_intent()
    project = make_project(intents=[intent])
    client = FakeClient(project)
    client.resource_snapshot = lambda _project_id: []  # type: ignore[attr-defined]
    containers = FakeContainerManager()
    driver = FakeDriver()
    lease = FakeLease()
    monkeypatch.setattr(
        explore,
        "_run_process",
        lambda *_args, **_kwargs: ProcessResult(
            0,
            '{"accepted":true,"data":{"description":"reverse shell connected"}}',
            "",
        ),
    )

    outcome = explore._try_conclude_fallback(
        config,
        client,
        containers,
        "container-proj_001",
        config.workers[0],
        driver,
        "proj_001",
        intent,
        "graph",
        "session-001",
        lease,
        TaskCancellation(),
        fallback_description="reverse shell connected",
    )

    assert outcome == "success"
    assert "Do not repeat exploitation" in client.concluded[-1][3]
