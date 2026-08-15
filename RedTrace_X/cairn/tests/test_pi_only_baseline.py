from __future__ import annotations

from concurrent.futures import Future
from pathlib import Path
from string import Template

from cairn.dispatcher.config import DispatchConfig
from cairn.dispatcher.models import RunningTask
from cairn.dispatcher.runtime.cancellation import TaskCancellation
from cairn.dispatcher.scheduler.loop import DispatcherLoop


ROOT = Path(__file__).resolve().parents[2]
EXPECTED_SKILLS = {
    "api-security",
    "blockchain-security",
    "browser-automation",
    "llm-security",
    "pwn-chain",
    "reverse-engineering",
    "tsec-benchmark",
}


def _load_benchmark_config(tmp_path: Path) -> DispatchConfig:
    rendered = Template((ROOT / "dispatch.yaml.template").read_text(encoding="utf-8")).substitute(
        API_KEY="test-key",
        MODEL="glm-5.2-agent-chanllenge",
        AGENT_BASE_URL="https://agent-awd.baidu.com",
        BENCHMARK_TOKEN="test-token",
        BENCHMARK_BASE_URL="https://tsecbench.zc.tencent.com",
        VPN_CHECK_URL="http://10.0.100.58",
        PI_CODING_AGENT_DIR=str(ROOT / "container" / ".pi" / "agent"),
    )
    path = tmp_path / "dispatch.yaml"
    path.write_text(rendered, encoding="utf-8")
    return DispatchConfig.load(path)


def test_benchmark_topology_is_pi_only_with_three_explore_slots(tmp_path: Path) -> None:
    config = _load_benchmark_config(tmp_path)
    coordinator = [worker for worker in config.workers if "reason" in worker.task_types]
    explorers = [worker for worker in config.workers if worker.task_types == ["explore"]]

    assert {worker.type for worker in config.workers} == {"pi"}
    assert [worker.name for worker in coordinator] == ["pi-coordinator"]
    assert coordinator[0].task_types == ["bootstrap", "reason"]
    assert [worker.name for worker in explorers] == ["pi-explore-1", "pi-explore-2", "pi-explore-3"]
    assert all(worker.max_running == 1 for worker in explorers)
    assert config.runtime.max_workers == config.runtime.max_project_workers == 4
    assert config.tasks.reason.max_intents == 3
    assert {worker.env["PI_MODEL"] for worker in config.workers} == {"glm-5.2-agent-chanllenge"}
    assert {worker.env["PI_BASE_URL"] for worker in config.workers} == {"https://agent-awd.baidu.com/v1"}


def test_scheduler_can_lease_three_explore_workers_concurrently(tmp_path: Path) -> None:
    loop = DispatcherLoop.__new__(DispatcherLoop)
    loop.config = _load_benchmark_config(tmp_path)
    loop.futures = {}
    loop.worker_unhealthy_until = {}
    loop.worker_rejected_until = {}

    selected: list[str] = []
    for index in range(3):
        worker = loop._select_worker("proj", "explore").worker
        assert worker is not None
        selected.append(worker.name)
        loop.futures[Future()] = RunningTask(
            "proj",
            "explore",
            worker.name,
            TaskCancellation(),
            intent_id=f"i{index}",
        )

    assert set(selected) == {"pi-explore-1", "pi-explore-2", "pi-explore-3"}
    assert loop._select_worker("proj", "explore").worker is None


def test_pi_user_skill_directory_contains_only_benchmark_domains() -> None:
    skills = ROOT / "container" / ".pi" / "agent" / "skills"
    actual = {path.name for path in skills.iterdir() if path.is_dir()}

    assert actual == EXPECTED_SKILLS
    assert all((skills / name / "SKILL.md").is_file() for name in actual)


def test_local_startup_runs_pi_binary_and_gateway_healthchecks(tmp_path: Path) -> None:
    loop = DispatcherLoop.__new__(DispatcherLoop)
    loop.config = _load_benchmark_config(tmp_path)
    loop._startup_healthchecks_checked = False
    calls: list[str] = []
    loop._run_local_binary_check = lambda: calls.append("binary")
    loop._run_startup_healthchecks = lambda *, show_commands: calls.append(f"gateway:{show_commands}")

    loop.run_startup_healthchecks(show_commands=True)

    assert calls == ["binary", "gateway:True"]
