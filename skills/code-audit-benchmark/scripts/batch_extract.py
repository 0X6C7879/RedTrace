#!/usr/bin/env python3
"""
批量提取完整分析数据

用法:
  python3 batch_extract.py --version prompt-0525-glm-5-retry2 --type FP --output tmp/full_analysis.json
  python3 batch_extract.py --version prompt-0525-glm-5-retry2 --type all --format text

功能:
  1. 查询数据库获取错误案例
  2. 定位会话文件
  3. 解析推理过程
  4. 自动分类错误类型
  5. 输出完整分析结果
"""

import argparse
import json
import os
import sys
from datetime import datetime

from utils import BenchmarkDB, setup_logging

sys.path.insert(0, str(Path(__file__).parent))
from classify_error import classify_single_case
from session_parser import extract_llm_reasoning, parse_session


def find_session_file(session_id: str, session_dir: str = None) -> str | None:
    """查找会话文件"""
    if session_dir is None:
        session_dir = os.environ.get(
            "REDTRACE_SESSION_DIR",
            os.environ.get("FLICKCLI_SESSION_DIR", "/data/flickcli/sessions"),
        )

    if not session_id:
        return None

    patterns = [
        os.path.join(session_dir, f"{session_id}.jsonl"),
        os.path.join(session_dir, session_id, "session.jsonl"),
        os.path.join(session_dir, "archived", f"{session_id}.jsonl"),
    ]

    for p in patterns:
        if os.path.exists(p):
            return p
    return None


def extract_case_analysis(
    case: dict, session_dir: str = None, format_type: str = "json"
) -> dict:
    """提取单个案例的完整分析"""
    result = {
        "issue_id": case.get("issue_id", ""),
        "vul_type": case.get("vul_type", "unknown"),
        "classification": case.get("classification", ""),
        "ground_truth": case.get("ground_truth", "Unknown"),
        "agent_conclusion": case.get("agent_conclusion", ""),
        "comment": case.get("comment", ""),
        "git_address": case.get("git_address", ""),
        "session_found": False,
        "session_analyzed": False,
        "reasoning_preview": "",
        "error_type": "unknown",
        "confidence": "low",
        "evidence": "",
    }

    session_id = case.get("flickcli_session_id", "")
    if not session_id:
        return result

    session_file = find_session_file(session_id, session_dir)
    if not session_file:
        return result

    result["session_found"] = True
    result["session_file"] = session_file

    try:
        messages = parse_session(session_file)
        if not messages:
            return result

        reasoning_items = extract_llm_reasoning(messages)
        if reasoning_items:
            reasoning_text = reasoning_items[0].get("content", "")
            result["reasoning_preview"] = (
                reasoning_text[:300] + "..."
                if len(reasoning_text) > 300
                else reasoning_text
            )

            classification = classify_single_case(
                reasoning_text,
                case.get("ground_truth", "Unknown"),
                case.get("agent_conclusion", ""),
                format_type,
            )
            result["error_type"] = classification.get("error_type", "unknown")
            result["confidence"] = classification.get("confidence", "low")
            result["evidence"] = classification.get("evidence", "")
            result["session_analyzed"] = True
    except Exception as e:
        result["error"] = str(e)

    return result


def batch_extract(
    version: str,
    error_type: str = "all",
    db_path: str = None,
    session_dir: str = None,
    format_type: str = "json",
) -> dict:
    """批量提取分析数据"""
    logger = setup_logging(script_name="batch_extract")

    if db_path is None:
        db_path = os.environ.get(
            "CODE_AUDIT_BENCHMARK_DB", ".redtrace/code-audit/benchmark.db"
        )

    db = BenchmarkDB(db_path)

    version_data = db.get_version(version)
    if not version_data:
        logger.error(f"版本 '{version}' 不存在")
        return {"error": f"版本 '{version}' 不存在"}

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

    analyzed_cases = []
    error_type_dist = {}
    session_found = 0
    session_analyzed = 0

    for case in cases:
        result = extract_case_analysis(case, session_dir, format_type)
        analyzed_cases.append(result)

        if result.get("session_found"):
            session_found += 1
        if result.get("session_analyzed"):
            session_analyzed += 1

        et = result.get("error_type", "unknown")
        error_type_dist[et] = error_type_dist.get(et, 0) + 1

    output = {
        "version": version,
        "total": len(cases),
        "session_found": session_found,
        "session_analyzed": session_analyzed,
        "error_type_distribution": error_type_dist,
        "generated_at": datetime.now().isoformat(),
        "cases": analyzed_cases,
    }

    if format_type == "text":
        output["cases"] = [
            {
                "issue_id": c["issue_id"][:8],
                "vul_type": c["vul_type"],
                "classification": c["classification"],
                "error_type": c["error_type"],
                "confidence": c["confidence"],
                "comment_preview": c["comment"][:50] + "..."
                if len(c.get("comment", "")) > 50
                else c.get("comment", ""),
            }
            for c in analyzed_cases
        ]

    logger.info(
        f"提取完成: total={len(cases)}, found={session_found}, analyzed={session_analyzed}"
    )
    return output


def main():
    parser = argparse.ArgumentParser(
        description="批量提取完整分析数据",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--version", "-v", required=True, help="版本号")
    parser.add_argument(
        "--type",
        "-t",
        default="all",
        choices=["FP", "FN", "all"],
        help="错误类型（默认 all）",
    )
    parser.add_argument("--db", help="数据库路径（可选）")
    parser.add_argument("--session-dir", help="会话文件目录（可选）")
    parser.add_argument("--output", "-o", help="输出文件路径（可选）")
    parser.add_argument(
        "--format",
        "-f",
        default="json",
        choices=["json", "text"],
        help="输出格式（默认 json，text 精简输出）",
    )

    args = parser.parse_args()

    result = batch_extract(
        args.version, args.type, args.db, args.session_dir, args.format
    )

    if "error" in result:
        print(json.dumps(result, ensure_ascii=False, indent=2), file=sys.stderr)
        sys.exit(1)

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
