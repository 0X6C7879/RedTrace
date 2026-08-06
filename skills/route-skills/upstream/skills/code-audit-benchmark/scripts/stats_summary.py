#!/usr/bin/env python3
"""
统计摘要生成脚本

用法:
  python3 stats_summary.py --version prompt-0525-glm-5-retry2
  python3 stats_summary.py --version prompt-0525-glm-5-retry2 --by-vul-type
  python3 stats_summary.py --version prompt-0525-glm-5-retry2 --format markdown

功能:
  1. 直接从数据库计算统计指标
  2. 支持按漏洞类型分组
  3. 输出 JSON 或 Markdown 格式
"""

import argparse
import json
import os
import sys
from datetime import datetime

from utils import BenchmarkDB, compute_metrics, setup_logging


def get_stats_summary(
    version: str, db_path: str = None, by_vul_type: bool = False
) -> dict:
    """生成统计摘要"""
    logger = setup_logging(script_name="stats_summary")

    if db_path is None:
        db_path = os.environ.get(
            "CODE_AUDIT_BENCHMARK_DB", ".redtrace/code-audit/benchmark.db"
        )

    db = BenchmarkDB(db_path)

    version_data = db.get_version(version)
    if not version_data:
        logger.error(f"版本 '{version}' 不存在")
        return {"error": f"版本 '{version}' 不存在"}

    results = db.get_results(version)

    tp = tn = fp = fn = unknown = error = 0
    fp_by_vul = {}
    fn_by_vul = {}

    for r in results:
        c = r.get("classification") or ""
        vt = r.get("vul_type") or "unknown"

        if c == "TP":
            tp += 1
        elif c == "TN":
            tn += 1
        elif c == "FP":
            fp += 1
            fp_by_vul[vt] = fp_by_vul.get(vt, 0) + 1
        elif c == "FN":
            fn += 1
            fn_by_vul[vt] = fn_by_vul.get(vt, 0) + 1
        elif c == "unknown":
            unknown += 1
        else:
            error += 1

    metrics = compute_metrics(tp, tn, fp, fn)

    output = {
        "version": version,
        "generated_at": datetime.now().isoformat(),
        "summary": {
            "total": len(results),
            "tp": tp,
            "tn": tn,
            "fp": fp,
            "fn": fn,
            "unknown": unknown,
            "error": error,
            **metrics,
        },
        "error_breakdown": {
            "fp_by_vul_type": dict(
                sorted(fp_by_vul.items(), key=lambda x: x[1], reverse=True)
            ),
            "fn_by_vul_type": dict(
                sorted(fn_by_vul.items(), key=lambda x: x[1], reverse=True)
            ),
        },
    }

    if by_vul_type:
        vul_type_metrics = db.compute_metrics_by_vul_type(version)
        output["metrics_by_vul_type"] = [
            {
                "vul_type": m["vul_type"],
                "total": m["total_judged"],
                "tp": m["tp"],
                "tn": m["tn"],
                "fp": m["fp"],
                "fn": m["fn"],
                "precision": m.get("precision"),
                "recall": m.get("recall"),
                "f1_score": m.get("f1_score"),
            }
            for m in sorted(vul_type_metrics, key=lambda x: x.get("f1_score") or 0)
        ]

    db.close()
    return output


def format_markdown(data: dict) -> str:
    """格式式 Markdown 输出"""
    lines = [
        f"# Benchmark 统计摘要 - {data['version']}",
        "",
        f"**生成时间**: {data['generated_at']}",
        "",
        "## 总体指标",
        "",
        "| 指标 | 数值 |",
        "|------|------|",
    ]

    s = data["summary"]
    lines.append(f"| 总数 | {s['total']} |")
    lines.append(f"| TP | {s['tp']} |")
    lines.append(f"| TN | {s['tn']} |")
    lines.append(f"| FP | {s['fp']} |")
    lines.append(f"| FN | {s['fn']} |")
    lines.append(f"| Precision | {s.get('precision', 'N/A')} |")
    lines.append(f"| Recall | {s.get('recall', 'N/A')} |")
    lines.append(f"| F1 Score | {s.get('f1_score', 'N/A')} |")
    lines.append(f"| Accuracy | {s.get('accuracy', 'N/A')} |")

    eb = data["error_breakdown"]
    if eb["fp_by_vul_type"]:
        lines.extend(
            [
                "",
                "## FP 分布（按漏洞类型）",
                "",
                "| 漏洞类型 | 数量 |",
                "|----------|------|",
            ]
        )
        for vt, count in list(eb["fp_by_vul_type"].items())[:10]:
            lines.append(f"| {vt} | {count} |")

    if eb["fn_by_vul_type"]:
        lines.extend(
            [
                "",
                "## FN 分布（按漏洞类型）",
                "",
                "| 漏洞类型 | 数量 |",
                "|----------|------|",
            ]
        )
        for vt, count in list(eb["fn_by_vul_type"].items())[:10]:
            lines.append(f"| {vt} | {count} |")

    if "metrics_by_vul_type" in data:
        lines.extend(
            [
                "",
                "## 按漏洞类型指标",
                "",
                "| 漏洞类型 | Total | TP | TN | FP | FN | Precision | Recall | F1 |",
                "|----------|-------|----|----|----|----|----------|--------|-----|",
            ]
        )
        for m in data["metrics_by_vul_type"]:
            lines.append(
                f"| {m['vul_type']} | {m['total']} | {m['tp']} | {m['tn']} | {m['fp']} | {m['fn']} | "
                f"{m.get('precision', 'N/A')} | {m.get('recall', 'N/A')} | {m.get('f1_score', 'N/A')} |"
            )

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(
        description="生成统计摘要",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--version", "-v", required=True, help="版本号")
    parser.add_argument("--db", help="数据库路径（可选）")
    parser.add_argument("--by-vul-type", action="store_true", help="按漏洞类型分组")
    parser.add_argument(
        "--format",
        "-f",
        default="json",
        choices=["json", "markdown"],
        help="输出格式（默认 json）",
    )
    parser.add_argument("--output", "-o", help="输出文件路径（可选）")

    args = parser.parse_args()

    result = get_stats_summary(args.version, args.db, args.by_vul_type)

    if "error" in result:
        print(json.dumps(result, ensure_ascii=False, indent=2), file=sys.stderr)
        sys.exit(1)

    if args.format == "markdown":
        output_text = format_markdown(result)
    else:
        output_text = json.dumps(result, ensure_ascii=False, indent=2)

    if args.output:
        os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(output_text)
        print(f"结果已保存到: {args.output}")
    else:
        print(output_text)


if __name__ == "__main__":
    main()
