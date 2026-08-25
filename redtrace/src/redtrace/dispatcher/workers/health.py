from __future__ import annotations

from dataclasses import dataclass

import requests

DETAIL_LIMIT = 200
_PROXY_KEYS = {
    "http": ("http_proxy", "HTTP_PROXY"),
    "https": ("https_proxy", "HTTPS_PROXY"),
}


@dataclass(frozen=True, slots=True)
class HealthResult:
    ok: bool
    status: int | None
    detail: str


def http_ping(
    url: str,
    *,
    headers: dict[str, str],
    json_body: dict,
    timeout: float,
    proxies: dict[str, str] | None = None,
) -> HealthResult:
    """Probe a provider without launching a worker process."""
    try:
        response = requests.post(
            url,
            headers=headers,
            json=json_body,
            timeout=timeout,
            proxies=proxies,
        )
    except requests.RequestException as exc:
        return HealthResult(False, None, _preview(str(exc)))
    if 200 <= response.status_code < 300:
        return HealthResult(True, response.status_code, "")
    return HealthResult(False, response.status_code, _preview(response.text))


def proxies_from_env(env: dict[str, str]) -> dict[str, str] | None:
    fallback = _first(env, "all_proxy", "ALL_PROXY")
    proxies = {
        scheme: value
        for scheme, keys in _PROXY_KEYS.items()
        if (value := _first(env, *keys) or fallback)
    }
    return proxies or None


def _first(env: dict[str, str], *keys: str) -> str | None:
    return next((env[key] for key in keys if env.get(key)), None)


def _preview(text: str) -> str:
    compact = " ".join(text.split())
    if len(compact) <= DETAIL_LIMIT:
        return compact
    return f"{compact[:DETAIL_LIMIT]}..."
