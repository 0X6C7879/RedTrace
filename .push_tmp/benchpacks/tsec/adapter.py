"""TSec Benchmark adapter: maps the generic BenchmarkAdapter onto tsec-benchmark SDK."""
from __future__ import annotations

from dataclasses import asdict
from typing import Any

from tsec_benchmark import (
    ChallengeNotFound,
    DuplicateSubmit,
    InvalidState,
    ResourceUnavailable,
    TaskNotFound,
    TSecBenchmarkAsync,
    TSecConnectionError,
    VpnCheckError,
)

from protocol import BenchmarkAdapter

_POLICY: dict[type, str] = {
    VpnCheckError: "vpn",
    DuplicateSubmit: "duplicate",
    InvalidState: "invalid_state",
    ResourceUnavailable: "resource_unavailable",
    TSecConnectionError: "connection",
    TaskNotFound: "task_not_found",
    ChallengeNotFound: "challenge_not_found",
}


class TSecAdapter(BenchmarkAdapter):
    def __init__(self, config: dict[str, Any]) -> None:
        super().__init__(config)
        platform = config["platform"]
        self.client = TSecBenchmarkAsync(
            base_url=platform["base_url"], token=platform["token"]
        )

    async def __aenter__(self) -> "TSecAdapter":
        await self.client.__aenter__()  # SDK runs the VPN precheck here
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.client.__aexit__(*exc)

    async def check_connection(self) -> Any:
        # Returns VpnCheckResult; caller checks the ``ok`` flag.
        return await self.client.check_vpn()

    async def list_tasks(self) -> list[dict[str, Any]]:
        return [asdict(challenge) for challenge in await self.client.list_challenges()]

    async def start_task(self, task_id: str) -> dict[str, Any]:
        return asdict(await self.client.start_challenge(task_id))

    async def get_task_context(self, task_id: str) -> dict[str, Any] | None:
        for challenge in await self.client.list_challenges():
            if challenge.unique_code == task_id:
                return asdict(challenge)
        return None

    async def submit_answer(self, task_id: str, answer: str) -> dict[str, Any]:
        return asdict(await self.client.submit_flag(task_id, answer))

    async def get_hint(self, task_id: str) -> dict[str, Any]:
        return asdict(await self.client.get_hint(task_id))

    async def close_task(self, task_id: str) -> dict[str, Any]:
        return asdict(await self.client.close_challenge(task_id))

    @staticmethod
    def classify_error(exc: BaseException) -> str:
        return _POLICY.get(type(exc), "other")
