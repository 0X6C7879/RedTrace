#!/usr/bin/env python3
"""regression.py — code-audit 误报回归与判定体系门禁。

静态回归：确认融合方案 13.3 列出的误报回归场景仍被 FP 规则覆盖，
且高危对抗复核、判定体系、Codegraph 优先策略未被迁移削弱。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

TOOL_ROOT = Path(__file__).resolve().parents[1]
CODE_AUDIT = TOOL_ROOT.parent / "upstream" / "skills" / "code-audit"

# 方案 13.3 误报回归场景 -> FP 规则文档中必须出现的特征词
FP_REGRESSION = {
    "UUID/随机 Blob Key 不可枚举": ["UUID", "uuid"],
    "加密参数不可预测": ["加密"],
    "Map fallback 固定安全字符串": ["fallback", "getOrDefault"],
    "全局租户拦截器": ["租户", "拦截器"],
    "RPC 同时传递身份 ID 与资源 ID": ["RPC", "rpc"],
    "测试代码": ["测试代码", "src/test"],
    "已禁用功能": ["禁用", "Deprecated", "功能开关"],
    "参数化查询": ["参数化"],
    "白名单": ["白名单"],
    "Kconf 可信配置": ["Kconf", "kconf"],
    "Source 实际不可控": ["不可控", "Source"],
    "无 HTTP/gRPC 入口": ["入口", "risk-a"],
}
JUDGEMENTS = ["vulnerability", "risk-a", "risk-b", "safe", "unknown"]


def main() -> int:
    errors: list[str] = []

    fp_doc = CODE_AUDIT / "references" / "common" / "false-positive-filtering.md"
    if not fp_doc.is_file():
        errors.append("missing false-positive-filtering.md")
    else:
        text = fp_doc.read_text(encoding="utf-8", errors="replace")
        for case, keywords in FP_REGRESSION.items():
            if not any(keyword in text for keyword in keywords):
                errors.append(f"FP regression case no longer covered: {case}")

    skill_md = CODE_AUDIT / "SKILL.md"
    if skill_md.is_file():
        text = skill_md.read_text(encoding="utf-8", errors="replace")
        for judgement in JUDGEMENTS:
            if judgement not in text:
                errors.append(f"judgement system lost: {judgement}")
        for policy in ("codegraph", "降级", "反幻觉"):
            if policy not in text:
                errors.append(f"core policy lost in SKILL.md: {policy}")
    else:
        errors.append("missing code-audit/SKILL.md")

    adversarial = (
        CODE_AUDIT / "references" / "modes" / "report-review" / "adversarial-validation.md"
    )
    if not adversarial.is_file():
        errors.append("missing adversarial-validation.md")
    else:
        text = adversarial.read_text(encoding="utf-8", errors="replace")
        if "VOTE" not in text and "票" not in text:
            errors.append("adversarial voting mechanism lost")

    severity = CODE_AUDIT / "references" / "common" / "severity-rating.md"
    if not severity.is_file():
        errors.append("missing severity-rating.md")

    if errors:
        print(json.dumps({"valid": False, "errors": errors}, ensure_ascii=False, indent=2))
        return 1
    print(json.dumps({"valid": True, "regression": "all passed"}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
