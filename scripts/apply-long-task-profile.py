#!/usr/bin/env python3
"""Raise a RedTrace dispatcher config to the 1M-context long-task profile."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import tempfile
from typing import Any

import yaml

PROFILE_MINIMUMS: dict[tuple[str, ...], int] = {
    ("runtime", "healthcheck_timeout"): 60,
    ("tasks", "bootstrap", "timeout"): 7_200,
    ("tasks", "bootstrap", "conclude_timeout"): 1_800,
    ("tasks", "reason", "timeout"): 1_800,
    ("tasks", "explore", "timeout"): 14_400,
    ("tasks", "explore", "conclude_timeout"): 1_800,
    ("context_harness", "inline_bytes"): 262_144,
    ("context_harness", "visible_bytes"): 131_072,
    ("context_harness", "query_bytes"): 1_048_576,
    ("context_harness", "parse_bytes"): 67_108_864,
    ("context_harness", "worker_output_chars"): 33_554_432,
}
PI_CONTEXT_WINDOW = 1_048_576


def _mapping_at(root: dict[str, Any], path: tuple[str, ...]) -> dict[str, Any]:
    current = root
    for key in path:
        value = current.get(key)
        if not isinstance(value, dict):
            value = {}
            current[key] = value
        current = value
    return current


def _positive_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def apply_profile(config: dict[str, Any]) -> list[dict[str, Any]]:
    changes: list[dict[str, Any]] = []
    for path, minimum in PROFILE_MINIMUMS.items():
        parent = _mapping_at(config, path[:-1])
        key = path[-1]
        previous = parent.get(key)
        parsed = _positive_int(previous)
        if parsed is not None and parsed >= minimum:
            continue
        parent[key] = minimum
        changes.append(
            {
                "path": ".".join(path),
                "before": previous,
                "after": minimum,
            }
        )

    workers = config.get("workers")
    if not isinstance(workers, list):
        workers = []
        config["workers"] = workers
    for index, worker in enumerate(workers):
        if not isinstance(worker, dict) or worker.get("type") != "pi":
            continue
        env = worker.get("env")
        if not isinstance(env, dict):
            env = {}
            worker["env"] = env
        previous = env.get("PI_MODEL_CONTEXT_WINDOW")
        parsed = _positive_int(previous)
        if parsed is not None and parsed >= PI_CONTEXT_WINDOW:
            continue
        env["PI_MODEL_CONTEXT_WINDOW"] = str(PI_CONTEXT_WINDOW)
        changes.append(
            {
                "path": f"workers[{index}].env.PI_MODEL_CONTEXT_WINDOW",
                "before": previous,
                "after": str(PI_CONTEXT_WINDOW),
            }
        )
    return changes


def _atomic_write(path: Path, text: str) -> None:
    descriptor, temporary = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Raise RedTrace timeouts and Context Harness budgets to the "
            "1M-context long-task profile without reducing larger custom values."
        )
    )
    parser.add_argument("config", type=Path, help="dispatcher YAML file")
    parser.add_argument(
        "--check",
        action="store_true",
        help="report required changes without writing the file",
    )
    parser.add_argument(
        "--no-backup",
        action="store_true",
        help="do not create <config>.pre-1m.bak before the first write",
    )
    args = parser.parse_args()

    path = args.config.expanduser().resolve()
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        parser.error(f"config not found: {path}")
    try:
        config = yaml.safe_load(raw) or {}
    except yaml.YAMLError as exc:
        parser.error(f"invalid YAML: {exc}")
    if not isinstance(config, dict):
        parser.error("config root must be a mapping")

    changes = apply_profile(config)
    result = {
        "config": str(path),
        "profile": "1m-long-task",
        "changed": bool(changes),
        "changes": changes,
        "check_only": bool(args.check),
    }
    if changes and not args.check:
        if not args.no_backup:
            backup = path.with_name(path.name + ".pre-1m.bak")
            if not backup.exists():
                shutil.copy2(path, backup)
                result["backup"] = str(backup)
        rendered = yaml.safe_dump(
            config,
            allow_unicode=True,
            default_flow_style=False,
            sort_keys=False,
        )
        _atomic_write(path, rendered)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
