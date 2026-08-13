from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from typing import Any

import requests
from pydantic import TypeAdapter
from redtrace.board.models import ProjectDetail, ProjectSummary, Settings
from requests.adapters import HTTPAdapter

LOG = logging.getLogger(__name__)


class ProtocolError(RuntimeError):
    def __init__(self, message: str, status_code: int, response_text: str = ""):
        super().__init__(message)
        self.status_code = status_code
        self.response_text = response_text


@dataclass(slots=True)
class ApiResult:
    status_code: int
    data: Any | None = None
    text: str = ""

    @property
    def ok(self) -> bool:
        return 200 <= self.status_code < 300


class ControlPlaneClient:
    def __init__(self, base_url: str, timeout: float = 10.0):
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._summary_adapter = TypeAdapter(list[ProjectSummary])
        self._local = threading.local()
        self._sessions: dict[int, requests.Session] = {}
        self._sessions_lock = threading.Lock()

    @property
    def base_url(self) -> str:
        return self._base_url

    def close(self) -> None:
        with self._sessions_lock:
            sessions = list(self._sessions.values())
            self._sessions.clear()
        for session in sessions:
            session.close()

    def list_projects(self) -> list[ProjectSummary]:
        response = self._session().get(self._url("/projects"), timeout=self._timeout)
        response.raise_for_status()
        return self._summary_adapter.validate_python(response.json())

    def wait_for_changes(self, after: int | None, *, timeout: float) -> int:
        response = self._session().get(
            self._url("/dispatcher/changes"),
            params={"after": after, "timeout": timeout},
            timeout=(self._timeout, timeout + self._timeout),
        )
        response.raise_for_status()
        return int(response.json()["generation"])

    def get_project(self, project_id: str) -> ProjectDetail:
        response = self._session().get(
            self._url(f"/projects/{project_id}"), timeout=self._timeout
        )
        response.raise_for_status()
        return ProjectDetail.model_validate(response.json())

    def blackboard_changes(
        self,
        project_id: str,
        since: int,
        *,
        worker: str,
        task_type: str,
        intent_id: str | None,
        include_source: bool = False,
    ) -> dict[str, Any]:
        cursor = since
        changes: list[dict[str, Any]] = []
        revision = since
        headers = {
            "X-RedTrace-Worker": worker,
            "X-RedTrace-Task": task_type,
        }
        if intent_id:
            headers["X-RedTrace-Intent"] = intent_id
        while True:
            response = self._session().get(
                self._url(f"/projects/{project_id}/blackboard/changes"),
                params={
                    "since": cursor,
                    "limit": 100,
                    "include_source": include_source,
                },
                headers=headers,
                timeout=self._timeout,
            )
            response.raise_for_status()
            page = response.json()
            changes.extend(page.get("changes") or [])
            revision = int(page.get("revision", revision))
            next_cursor = int(page.get("next_revision", cursor))
            if not page.get("has_more") or next_cursor <= cursor:
                break
            cursor = next_cursor
        return {
            "project": project_id,
            "command": "changes",
            "since": since,
            "revision": revision,
            "next_revision": revision,
            "has_more": False,
            "changes": changes,
        }

    def wait_for_blackboard(
        self,
        project_id: str,
        since: int,
        *,
        timeout: float,
    ) -> int:
        response = self._session().get(
            self._url(f"/projects/{project_id}/blackboard/wait"),
            params={"since": since, "timeout": timeout},
            timeout=(self._timeout, timeout + self._timeout),
        )
        response.raise_for_status()
        return int(response.json()["revision"])

    def resource_snapshot(self, project_id: str) -> list[dict[str, Any]]:
        """Return the bounded shared access-resource snapshot for Worker gates."""
        try:
            response = self._session().get(
                self._url(f"/projects/{project_id}/operations/snapshot"),
                params={
                    "kinds": "webshell,c2_listener,c2_session,c2_payload",
                    "limit": 100,
                },
                timeout=self._timeout,
            )
            response.raise_for_status()
            data = response.json()
        except (requests.RequestException, ValueError) as exc:
            LOG.warning("resource snapshot failed project=%s error=%s", project_id, exc)
            return []
        resources = data.get("resources") if isinstance(data, dict) else None
        return resources if isinstance(resources, list) else []

    def report_project_runtime_cleaned(
        self,
        project_id: str,
        *,
        success: bool,
        error: str = "",
    ) -> None:
        response = self._session().post(
            self._url(f"/projects/{project_id}/deletion/runtime-cleaned"),
            json={"success": success, "error": error},
            timeout=self._timeout,
        )
        response.raise_for_status()

    def get_settings(self) -> Settings:
        response = self._session().get(self._url("/settings"), timeout=self._timeout)
        response.raise_for_status()
        return Settings.model_validate(response.json())

    def heartbeat(self, project_id: str, intent_id: str, worker: str) -> ApiResult:
        return self._request_json(
            "POST",
            f"/projects/{project_id}/intents/{intent_id}/heartbeat",
            json={"worker": worker},
        )

    def claim_intent(self, project_id: str, intent_id: str, worker: str) -> ApiResult:
        return self._request_json(
            "POST",
            f"/projects/{project_id}/intents/{intent_id}/claim",
            json={"worker": worker},
        )

    def claim_reason(self, project_id: str, worker: str, trigger: str) -> ApiResult:
        return self._request_json(
            "POST",
            f"/projects/{project_id}/reason/claim",
            json={"worker": worker, "trigger": trigger},
        )

    def reason_heartbeat(self, project_id: str, worker: str) -> ApiResult:
        return self._request_json(
            "POST",
            f"/projects/{project_id}/reason/heartbeat",
            json={"worker": worker},
        )

    def release_reason(self, project_id: str, worker: str) -> ApiResult:
        return self._request_json(
            "POST",
            f"/projects/{project_id}/reason/release",
            json={"worker": worker},
        )

    def release(self, project_id: str, intent_id: str, worker: str) -> ApiResult:
        return self._request_json(
            "POST",
            f"/projects/{project_id}/intents/{intent_id}/release",
            json={"worker": worker},
        )

    def conclude(
        self, project_id: str, intent_id: str, worker: str, description: str
    ) -> ApiResult:
        return self._request_json(
            "POST",
            f"/projects/{project_id}/intents/{intent_id}/conclude",
            json={"worker": worker, "description": description},
        )

    def complete(
        self, project_id: str, from_ids: list[str], description: str, worker: str
    ) -> ApiResult:
        return self._request_json(
            "POST",
            f"/projects/{project_id}/complete",
            json={"from": from_ids, "description": description, "worker": worker},
        )

    def create_intent(
        self, project_id: str, from_ids: list[str], description: str, creator: str
    ) -> ApiResult:
        return self._request_json(
            "POST",
            f"/projects/{project_id}/intents",
            json={
                "from": from_ids,
                "description": description,
                "creator": creator,
                "worker": None,
            },
        )

    def append_audit_events(
        self,
        run: dict[str, Any],
        events: list[dict[str, Any]],
    ) -> None:
        response = self._session().post(
            self._url("/audit/events"),
            json={"run": run, "events": events},
            timeout=(0.2, 0.8),
        )
        response.raise_for_status()

    def _request_json(self, method: str, path: str, json: dict[str, Any]) -> ApiResult:
        try:
            response = self._session().request(
                method,
                self._url(path),
                json=json,
                timeout=self._timeout,
            )
        except requests.RequestException as exc:
            LOG.warning("request failed method=%s path=%s error=%s", method, path, exc)
            return ApiResult(status_code=0, text=str(exc))
        data: Any | None = None
        if response.headers.get("content-type", "").startswith("application/json"):
            data = response.json()
        return ApiResult(
            status_code=response.status_code, data=data, text=response.text
        )

    def _url(self, path: str) -> str:
        return f"{self._base_url}{path}"

    def _session(self) -> requests.Session:
        session = getattr(self._local, "session", None)
        if session is not None:
            return session

        session = requests.Session()
        adapter = HTTPAdapter(pool_connections=64, pool_maxsize=64, pool_block=False)
        session.mount("http://", adapter)
        session.mount("https://", adapter)
        self._local.session = session
        with self._sessions_lock:
            self._sessions[threading.get_ident()] = session
        return session
