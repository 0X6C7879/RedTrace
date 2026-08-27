#!/usr/bin/env python3
"""Agent-friendly CLI for the TSec Benchmark Python SDK.

The CLI intentionally does not solve challenges. It only exposes the benchmark
control plane as compact JSON for RedTrace workers.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import os
import sys
from typing import Any


def emit(payload: dict[str, Any], *, stream: Any = sys.stdout) -> None:
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":"), default=str), file=stream)


def env_first(*names: str) -> str:
    for name in names:
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return ""


def resolve_config(args: argparse.Namespace) -> tuple[str, str]:
    base_url = (getattr(args, "base_url", None) or "").strip() or env_first(
        "BENCHMARK_BASE_URL", "TSEC_BASE_URL"
    )
    token = (getattr(args, "token", None) or "").strip() or env_first(
        "BENCHMARK_TOKEN", "TSEC_TOKEN"
    )
    return base_url, token


def load_sdk() -> Any:
    try:
        import tsec_benchmark  # type: ignore
    except ImportError as exc:
        raise RuntimeError(
            "tsec-benchmark SDK is not installed; install it in the active Python environment"
        ) from exc
    return tsec_benchmark


def as_jsonable(value: Any) -> Any:
    if dataclasses.is_dataclass(value):
        return {k: as_jsonable(v) for k, v in dataclasses.asdict(value).items()}
    if isinstance(value, dict):
        return {str(k): as_jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [as_jsonable(v) for v in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if hasattr(value, "__dict__"):
        return {
            str(k): as_jsonable(v)
            for k, v in vars(value).items()
            if not str(k).startswith("_")
        }
    return str(value)


def sdk_available() -> bool:
    try:
        load_sdk()
        return True
    except RuntimeError:
        return False


def require_config(args: argparse.Namespace) -> tuple[str, str]:
    base_url, token = resolve_config(args)
    missing = []
    if not base_url:
        missing.append("BENCHMARK_BASE_URL")
    if not token:
        missing.append("BENCHMARK_TOKEN")
    if missing:
        raise ValueError("missing configuration: " + ", ".join(missing))
    return base_url, token


def client_context(args: argparse.Namespace) -> tuple[Any, Any]:
    sdk = load_sdk()
    base_url, token = require_config(args)
    return sdk, sdk.TSecBenchmark(base_url=base_url, token=token)


def command_config(args: argparse.Namespace) -> int:
    base_url, token = resolve_config(args)
    emit(
        {
            "ok": bool(base_url and token and sdk_available()),
            "base_url_configured": bool(base_url),
            "token_configured": bool(token),
            "sdk_available": sdk_available(),
        }
    )
    return 0 if base_url and token and sdk_available() else 2


def command_vpn(args: argparse.Namespace) -> int:
    _, client = client_context(args)
    with client:
        result = client.check_vpn()
    emit({"ok": True, "vpn": as_jsonable(result)})
    return 0


def command_list(args: argparse.Namespace) -> int:
    _, client = client_context(args)
    with client:
        challenges = list(client.list_challenges())
    if args.incomplete:
        challenges = [ch for ch in challenges if not bool(getattr(ch, "is_completed", False))]
    payload = [as_jsonable(ch) for ch in challenges]
    emit({"ok": True, "count": len(payload), "challenges": payload})
    return 0


def command_start(args: argparse.Namespace) -> int:
    _, client = client_context(args)
    with client:
        result = client.start_challenge(args.unique_code)
    emit({"ok": True, "start": as_jsonable(result)})
    return 0


def command_hint(args: argparse.Namespace) -> int:
    if not args.confirm_score_penalty:
        emit(
            {
                "ok": False,
                "error": "score_penalty_confirmation_required",
                "message": "get_hint() can reduce flag score; rerun with --confirm-score-penalty",
            },
            stream=sys.stderr,
        )
        return 2
    _, client = client_context(args)
    with client:
        result = client.get_hint(args.unique_code)
    emit({"ok": True, "hint": as_jsonable(result)})
    return 0


def command_submit(args: argparse.Namespace) -> int:
    sdk, client = client_context(args)
    duplicate_cls = getattr(sdk, "DuplicateSubmit", None)
    try:
        with client:
            result = client.submit_flag(args.unique_code, args.flag)
    except Exception as exc:
        if duplicate_cls is not None and isinstance(exc, duplicate_cls):
            emit(
                {
                    "ok": True,
                    "duplicate": True,
                    "unique_code": args.unique_code,
                    "message": getattr(exc, "message", "flag already submitted"),
                }
            )
            return 0
        raise
    emit({"ok": True, "submit": as_jsonable(result)})
    return 0


def command_close(args: argparse.Namespace) -> int:
    _, client = client_context(args)
    with client:
        result = client.close_challenge(args.unique_code)
    emit({"ok": True, "close": as_jsonable(result)})
    return 0


def add_common_auth(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--base-url",
        default=None,
        help="Benchmark API base URL; defaults to BENCHMARK_BASE_URL then TSEC_BASE_URL",
    )
    parser.add_argument(
        "--token",
        default=None,
        help="Benchmark token; defaults to BENCHMARK_TOKEN then TSEC_TOKEN (never printed)",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="tsecbench", description="TSec Benchmark control-plane CLI")
    add_common_auth(parser)
    sub = parser.add_subparsers(dest="command", required=True)

    p_config = sub.add_parser("config", help="Check local configuration without printing secrets")
    p_config.set_defaults(func=command_config)

    p_vpn = sub.add_parser("vpn", help="Run SDK/VPN preflight")
    p_vpn.set_defaults(func=command_vpn)

    p_list = sub.add_parser("list", help="List challenge status and progress")
    p_list.add_argument("--incomplete", action="store_true", help="Only return incomplete challenges")
    p_list.set_defaults(func=command_list)

    p_start = sub.add_parser("start", help="Start one challenge container")
    p_start.add_argument("unique_code")
    p_start.set_defaults(func=command_start)

    p_hint = sub.add_parser("hint", help="Get challenge hint; may reduce score")
    p_hint.add_argument("unique_code")
    p_hint.add_argument(
        "--confirm-score-penalty",
        action="store_true",
        help="Required acknowledgement that viewing a hint may reduce score",
    )
    p_hint.set_defaults(func=command_hint)

    p_submit = sub.add_parser("submit", help="Submit one flag")
    p_submit.add_argument("unique_code")
    p_submit.add_argument("--flag", required=True)
    p_submit.set_defaults(func=command_submit)

    p_close = sub.add_parser("close", help="Close one challenge container")
    p_close.add_argument("unique_code")
    p_close.set_defaults(func=command_close)

    return parser


def normalize_error(exc: Exception) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "ok": False,
        "error": exc.__class__.__name__,
        "message": str(getattr(exc, "message", None) or exc),
    }
    for attr in ("code", "detail", "status_code"):
        value = getattr(exc, attr, None)
        if value is not None:
            payload[attr] = as_jsonable(value)
    return payload


def exit_code_for(exc: Exception) -> int:
    name = exc.__class__.__name__
    code = str(getattr(exc, "code", "") or "")
    if name == "VpnCheckError":
        return 3
    if code == "resource_unavailable":
        return 6
    if code == "invalid_state":
        return 5
    if code in {"task_not_found", "challenge_not_found"}:
        return 4
    if name == "TSecConnectionError":
        return 7
    return 8


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        return int(args.func(args))
    except (ValueError, RuntimeError) as exc:
        emit(normalize_error(exc), stream=sys.stderr)
        return 2
    except Exception as exc:
        # SDK exceptions expose code/message/detail/status_code. Keeping this generic
        # also preserves forward compatibility with new SDK-specific exception types.
        emit(normalize_error(exc), stream=sys.stderr)
        return exit_code_for(exc)


if __name__ == "__main__":
    raise SystemExit(main())
