#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="redtrace-skill",
        description="Submit one validated, full-replacement Skill improvement to RedTrace.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    propose = subparsers.add_parser("propose")
    propose.add_argument("--name", required=True, help="proposed or existing Skill name")
    propose.add_argument("--target", help="existing Skill to replace; omit to use automatic matching")
    propose.add_argument("--candidate", required=True, type=Path, help="complete replacement SKILL.md")
    propose.add_argument("--summary", required=True)
    propose.add_argument("--validated", action="append", required=True, help="concrete validation performed")
    propose.add_argument("--tool-calls-saved", type=int, default=0)
    propose.add_argument("--steps-avoided", type=int, default=0)
    propose.add_argument("--duration-saved-ms", type=int, default=0)
    return parser


def _submit(args: argparse.Namespace) -> int:
    if min(args.tool_calls_saved, args.steps_avoided, args.duration_saved_ms) < 0:
        raise ValueError("impact values must be non-negative")
    if not any((args.tool_calls_saved, args.steps_avoided, args.duration_saved_ms)):
        raise ValueError("at least one measured improvement is required")
    candidate_path = args.candidate.resolve()
    try:
        relative = candidate_path.relative_to(Path.cwd().resolve())
    except ValueError:
        relative = None
    if relative is not None and relative.parts and relative.parts[0] in {
        ".agents",
        ".claude",
        ".codex",
        ".pi",
    }:
        raise ValueError("runtime Skill snapshots are read-only; submit a separate replacement file")
    content = candidate_path.read_text(encoding="utf-8")
    expected_revision = None
    manifest_path = Path(".redtrace/capabilities.json")
    if manifest_path.is_file():
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            versions = manifest.get("skillVersions", {})
            snapshot = versions.get(args.target or args.name, {})
            expected_revision = snapshot.get("revision")
        except (json.JSONDecodeError, OSError, AttributeError):
            expected_revision = None
    payload = {
        "proposed_name": args.name,
        "target_skill": args.target,
        "content": content,
        "summary": args.summary,
        "validation": args.validated,
        "impact": {
            "task_succeeded": True,
            "tool_calls_saved": args.tool_calls_saved,
            "invalid_steps_avoided": args.steps_avoided,
            "duration_saved_ms": args.duration_saved_ms,
        },
        "project_id": os.environ.get("REDTRACE_PROJECT_ID"),
        "intent_id": os.environ.get("REDTRACE_INTENT_ID"),
        "worker": os.environ.get("REDTRACE_WORKER"),
        "task_type": os.environ.get("REDTRACE_TASK_TYPE"),
        "expected_revision": expected_revision,
    }
    server = os.environ.get("REDTRACE_SERVER", "http://127.0.0.1:8000").rstrip("/")
    request = urllib.request.Request(
        f"{server}/capabilities/evolution/proposals",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    timeout = float(os.environ.get("REDTRACE_SKILL_SUBMIT_TIMEOUT", "0.75"))
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            result = json.load(response)
    except (OSError, urllib.error.HTTPError, ValueError) as exc:
        print(f"Skill proposal was not queued: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0


def main() -> int:
    parser = _parser()
    args = parser.parse_args()
    try:
        if args.command == "propose":
            return _submit(args)
    except (OSError, UnicodeError, ValueError) as exc:
        parser.error(str(exc))
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
