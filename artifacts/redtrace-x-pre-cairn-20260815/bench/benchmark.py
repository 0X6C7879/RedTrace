"""TSecBench 平台 API 客户端（纯标准库，直接对接 CHALLENGES_API.md 的 HTTP 接口）。"""

from __future__ import annotations

import http.client
import json
from urllib import error as urlerror
from urllib import request
from urllib.parse import urlencode


class BenchmarkError(Exception):
    """平台业务异常（统一 {code, message, detail} 结构）。"""

    def __init__(self, code: str, message: str, status_code: int | None = None, detail: dict | None = None) -> None:
        self.code = code
        self.message = message
        self.status_code = status_code
        self.detail = detail or {}
        super().__init__(f"{code}: {message}")


class TaskNotFound(BenchmarkError):
    pass


class ChallengeNotFound(BenchmarkError):
    pass


class InvalidState(BenchmarkError):
    pass


class DuplicateSubmit(BenchmarkError):
    pass


class ResourceUnavailable(BenchmarkError):
    pass


class InternalError(BenchmarkError):
    pass


class VpnCheckFailed(Exception):
    pass


_ERROR_CLASSES = {
    "task_not_found": TaskNotFound,
    "challenge_not_found": ChallengeNotFound,
    "invalid_state": InvalidState,
    "duplicate": DuplicateSubmit,
    "resource_unavailable": ResourceUnavailable,
    "internal_error": InternalError,
}


class BenchmarkClient:
    def __init__(self, base_url: str, token: str, timeout: float = 30) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout

    def _request(self, method: str, path: str, *, params: dict | None = None, body: dict | None = None):
        url = self.base_url + path
        if params:
            url += "?" + urlencode(params)
        headers = {"BENCHMARK_TOKEN": self.token, "Accept": "application/json"}
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = request.Request(url, data=data, headers=headers, method=method)
        try:
            with request.urlopen(req, timeout=self.timeout) as resp:
                status = resp.status
                raw = resp.read().decode("utf-8", "replace")
        except urlerror.HTTPError as exc:
            status = exc.code
            raw = exc.read().decode("utf-8", "replace")
        except (OSError, http.client.HTTPException) as exc:
            # URLError/timeout/connection reset/DNS 等瞬时网络故障统一映射成
            # 可重试的 BenchmarkError，避免一次抖动直接终止整场跑分。
            raise BenchmarkError(
                "network_error", f"平台网络请求失败({type(exc).__name__}): {exc}"
            ) from exc

        payload = None
        if raw:
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                payload = None

        if status >= 400:
            if isinstance(payload, dict) and payload.get("code"):
                cls = _ERROR_CLASSES.get(payload["code"], BenchmarkError)
                raise cls(payload["code"], payload.get("message", ""), status, payload.get("detail"))
            raise BenchmarkError(f"http_{status}", f"HTTP {status}: {raw[:300]}", status)
        return payload

    # -- VPN 联通预检（强制前置） -------------------------------------------
    def check_vpn(self, vpn_url: str) -> dict:
        req = request.Request(vpn_url, method="GET")
        try:
            with request.urlopen(req, timeout=10) as resp:
                raw = resp.read().decode("utf-8", "replace")
        except Exception as exc:  # noqa: BLE001
            raise VpnCheckFailed(f"VPN 预检地址不可达: {exc}") from exc
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise VpnCheckFailed(f"VPN 预检返回非 JSON: {raw[:200]}") from exc
        if not isinstance(payload, dict) or payload.get("status") != "ok":
            raise VpnCheckFailed(f"VPN 预检 status != ok: {raw[:200]}")
        return payload

    # -- challenges 接口 ----------------------------------------------------
    def list_challenges(self) -> list:
        return self._request("GET", "/openapi/v1/challenges")

    def start_challenge(self, unique_code: str) -> dict:
        return self._request("POST", "/openapi/v1/challenges/start", params={"unique_code": unique_code})

    def get_hint(self, unique_code: str) -> dict:
        return self._request("GET", "/openapi/v1/challenges/hint", params={"unique_code": unique_code})

    def submit_flag(self, unique_code: str, flag: str) -> dict:
        return self._request("POST", "/openapi/v1/challenges/submit", body={"unique_code": unique_code, "flag": flag})

    def close_challenge(self, unique_code: str) -> dict:
        return self._request("POST", "/openapi/v1/challenges/close", params={"unique_code": unique_code})
