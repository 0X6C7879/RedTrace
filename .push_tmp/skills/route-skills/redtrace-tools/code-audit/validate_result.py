#!/usr/bin/env python3
"""validate_result.py — 校验 code-audit 的 RedTrace 外层输出协议。

用法: python3 validate_result.py <result.json> [mode]

外层协议:
{
  "accepted": true,
  "data": {
    "skill": "route-skills/code-audit",
    "mode": "<七种模式之一>",
    "auditResult": {"findings": [], "passed_checks": [], "unknowns": []},
    ...
  }
}

只校验 RedTrace 外层；`data.auditResult` 的原始 Schema 仍由
code-audit/scripts/validate-output.cjs 负责（api-audit/mr-review/report-review）。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

MODES = {
    "arch-scan",
    "api-audit",
    "mr-review",
    "sast-audit",
    "api-inventory",
    "report-review",
    "security-assessment",
}
AUDIT_RESULT_KEYS = {"findings", "passed_checks", "unknowns"}


def validate(payload: dict, mode_hint: str | None = None) -> list[str]:
    errors: list[str] = []
    if not isinstance(payload, dict):
        return ["root must be a JSON object"]
    if payload.get("accepted") is not True:
        errors.append("accepted must be true for a final result")
    data = payload.get("data")
    if not isinstance(data, dict):
        errors.append("data must be an object")
        return errors
    skill = data.get("skill", "")
    if skill and not str(skill).startswith("route-skills/code-audit"):
        errors.append(f"data.skill must start with route-skills/code-audit, got {skill}")
    mode = data.get("mode")
    if mode not in MODES:
        errors.append(f"data.mode must be one of {sorted(MODES)}, got {mode}")
    elif mode_hint and mode != mode_hint:
        errors.append(f"data.mode {mode} does not match expected {mode_hint}")
    if mode == "security-assessment":
        if not data.get("reportPath"):
            errors.append("security-assessment requires data.reportPath")
        if not isinstance(data.get("summary"), dict):
            errors.append("security-assessment requires data.summary object")
    else:
        audit_result = data.get("auditResult")
        if not isinstance(audit_result, dict):
            errors.append("data.auditResult must be an object")
        else:
            missing = AUDIT_RESULT_KEYS - set(audit_result)
            if missing:
                errors.append(f"data.auditResult missing keys: {sorted(missing)}")
            for key in AUDIT_RESULT_KEYS & set(audit_result):
                if not isinstance(audit_result[key], list):
                    errors.append(f"data.auditResult.{key} must be a list")
    return errors


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    path = Path(sys.argv[1])
    mode_hint = sys.argv[2] if len(sys.argv) > 2 else None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(json.dumps({"valid": False, "errors": [f"cannot parse: {exc}"]}))
        return 1
    errors = validate(payload, mode_hint)
    print(json.dumps({"valid": not errors, "errors": errors}, ensure_ascii=False))
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
