from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from typing import Any

import requests
from pydantic import TypeAdapter
from requests.adapters import HTTPAdapter

from redtrace.server.models import ProjectDetail, ProjectSummary, Settings

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


class CairnClient:
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

    def active_peer_work(self, project_id: str, worker: str) -> list[dict[str, str]]:
        """Return live claimed Intents owned by other Workers."""
        try:
            response = self._session().get(
                self._url(f"/projects/{project_id}"),
                timeout=min(self._timeout, 1.0),
            )
            response.raise_for_status()
            project = ProjectDetail.model_validate(response.json())
        except (requests.RequestException, ValueError, TypeError) as exc:
            LOG.debug("peer work refresh failed project=%s error=%s", project_id, exc)
            return []
        return [
            {
                "intent_id": intent.id,
                "worker": intent.worker,
                "description": intent.description,
            }
            for intent in project.intents
            if intent.worker and intent.worker != worker and intent.concluded_at is None
        ]

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

    def snapshot_resources(
        self,
        project_id: str,
        *,
        worker: str,
        intent_id: str | None,
    ) -> ApiResult:
        """Load shared access state once before an Explore worker starts."""
        try:
            response = self._session().get(
                self._url(f"/projects/{project_id}/operations/snapshot"),
                params={"kinds": "webshell,c2_listener,c2_session,c2_payload"},
                headers={
                    "X-RedTrace-Worker": worker,
                    "X-RedTrace-Task": "explore",
                    "X-RedTrace-Intent": intent_id or "",
                },
                timeout=min(self._timeout, 1.0),
            )
        except requests.RequestException as exc:
            LOG.warning("resource snapshot failed project=%s error=%s", project_id, exc)
            return ApiResult(status_code=0, text=str(exc))
        data: Any | None = None
        if response.headers.get("content-type", "").startswith("application/json"):
            try:
                data = response.json()
            except ValueError:
                pass
        return ApiResult(response.status_code, data, response.text)

    def ensure_webshell_resource(
        self,
        project_id: str,
        *,
        target: str,
        command_param: str,
        method: str,
        worker: str,
        intent_id: str | None,
    ) -> ApiResult:
        """Idempotently promote a verified direct WebShell command to a shared resource."""
        try:
            response = self._session().get(
                self._url(f"/projects/{project_id}/resources"),
                params={"kind": "webshell", "q": target, "limit": 100},
                timeout=min(self._timeout, 1.0),
            )
            response.raise_for_status()
            resources = response.json().get("resources", [])
            for resource in resources:
                if isinstance(resource, dict) and resource.get("target") == target:
                    return ApiResult(status_code=200, data={"resource": resource})
        except (requests.RequestException, ValueError, TypeError) as exc:
            LOG.debug("WebShell dedupe lookup failed target=%s error=%s", target, exc)
        name = target.rsplit("/", 1)[-1] or "detected-webshell"
        return self._request_json(
            "POST",
            f"/projects/{project_id}/resources",
            json={
                "kind": "webshell",
                "name": f"detected:{name}"[:200],
                "target": target,
                "summary": "Worker command verified this reusable WebShell endpoint.",
                "status": "available",
                "metadata": {
                    "shell_type": "custom",
                    "protocol": "raw",
                    "method": method,
                    "command_param": command_param,
                },
                "secret": {},
                "actor_type": "worker",
                "actor": worker,
                "worker": worker,
                "intent_id": intent_id,
                "publish_fact": False,
            },
        )

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
