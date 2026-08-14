#!/usr/bin/env python3
"""
从 benchmark 数据库查询错误案例

用法：
  python3 scripts/query_benchmark.py --version prompt-0525-glm-5-retry --type FP
  python3 scripts/query_benchmark.py --version prompt-0525-glm-5-retry --type summary
  python3 scripts/query_benchmark.py --version prompt-0525-glm-5-retry --type all --output tmp/cases.json
"""

import argparse
import json
import os
import sys

from utils import BenchmarkDB, setup_logging


def query_benchmark_errors(version: str, error_type: str = "all", db_path: str = None):
    """
    查询 benchmark 错误案例

    Args:
        version: 版本号
        error_type: 错误类型（FP/FN/all/summary）
        db_path: 数据库路径（默认环境变量 CODE_AUDIT_BENCHMARK_DB 或 .redtrace/code-audit/benchmark.db）

    Returns:
        dict: 包含版本信息和案例列表
    """
    logger = setup_logging(script_name="query_benchmark")

    if db_path is None:
        db_path = os.environ.get(
            "CODE_AUDIT_BENCHMARK_DB", ".redtrace/code-audit/benchmark.db"
        )

    if not os.path.exists(db_path):
        logger.error(f"数据库文件不存在: {db_path}")
        return {"error": f"数据库文件不存在: {db_path}"}

    db = BenchmarkDB(db_path)

    version_data = db.get_version(version)
    if not version_data:
        logger.error(f"版本 '{version}' 不存在")
        db.close()
        return {"error": f"版本 '{version}' 不存在"}

    if error_type == "summary":
        results = db.get_results(version)
        fp_count = sum(1 for r in results if r.get("classification") == "FP")
        fn_count = sum(1 for r in results if r.get("classification") == "FN")
        total = len(results)
        db.close()
        return {
            "version": version,
            "fp_count": fp_count,
            "fn_count": fn_count,
            "total": total,
            "cases": [],
        }

    cases = []
    if error_type in ("FP", "all"):
        fp_results = db.get_results(version, classification="FP")
        for r in fp_results:
            cases.append(
                {
                    "issue_id": r.get("issue_id", ""),
                    "vul_type": r.get("vul_type", "unknown"),
                    "ground_truth": r.get("ground_truth", "Unknown"),
                    "agent_conclusion": r.get("agent_conclusion_mapped", ""),
                    "classification": "FP",
                    "flickcli_session_id": r.get("flickcli_session_id", ""),
                    "git_address": r.get("git_address", ""),
                    "comment": r.get("comment", ""),
                }
            )

    if error_type in ("FN", "all"):
        fn_results = db.get_results(version, classification="FN")
        for r in fn_results:
            cases.append(
                {
                    "issue_id": r.get("issue_id", ""),
                    "vul_type": r.get("vul_type", "unknown"),
                    "ground_truth": r.get("ground_truth", "Unknown"),
                    "agent_conclusion": r.get("agent_conclusion_mapped", ""),
                    "classification": "FN",
                    "flickcli_session_id": r.get("flickcli_session_id", ""),
                    "git_address": r.get("git_address", ""),
                    "comment": r.get("comment", ""),
                }
            )

    db.close()

    fp_count = sum(1 for c in cases if c["classification"] == "FP")
    fn_count = sum(1 for c in cases if c["classification"] == "FN")

    logger.info(f"查询完成: FP={fp_count}, FN={fn_count}, Total={len(cases)}")

    return {
        "version": version,
        "fp_count": fp_count,
        "fn_count": fn_count,
        "total": len(cases),
        "cases": cases,
    }


def main():
    parser = argparse.ArgumentParser(
        description="查询 benchmark 错误案例",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  %(prog)s --version v1.0 --type FP
  %(prog)s --version v1.0 --type summary
  %(prog)s --version v1.0 --type all --output tmp/cases.json
        """,
    )
    parser.add_argument("--version", "-v", required=True, help="版本号")
    parser.add_argument(
        "--type",
        "-t",
        default="all",
        choices=["FP", "FN", "all", "summary"],
        help="错误类型（默认 all）",
    )
    parser.add_argument("--db", help="数据库路径（可选）")
    parser.add_argument("--output", "-o", help="输出文件路径（可选）")

    args = parser.parse_args()

    result = query_benchmark_errors(args.version, args.type, args.db)

    if "error" in result:
        print(json.dumps(result, ensure_ascii=False, indent=2), file=sys.stderr)
        sys.exit(1)

    if args.output:
        os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
        with open(args.output, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
        print(f"结果已保存到: {args.output}")
    else:
        print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
