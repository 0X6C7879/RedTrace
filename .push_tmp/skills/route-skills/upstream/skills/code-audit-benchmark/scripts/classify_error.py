#!/usr/bin/env python3
"""
自动判定错误类型

用法：
  python3 scripts/classify_error.py --reasoning "用户输入..." --ground-truth Negative --agent-conclusion 漏洞
  python3 scripts/classify_error.py --from-file tmp/analysis.json --output tmp/classified.json
  python3 scripts/classify_error.py --from-file tmp/analysis.json --format text
"""

import argparse
import json
import os
import re
import sys
from datetime import datetime

from utils import setup_logging

ERROR_PATTERNS = {
    "dataflow_imprecise": {
        "name": "数据流分析不精确",
        "keywords": [
            "store.get",
            "cache.get",
            "map.get",
            "db.query",
            "findById",
            "getById",
            "return false",
            "return null",
            "throw",
            "拦截",
            "校验失败",
            "if.*null.*return",
        ],
        "evidence_patterns": [
            (
                r"(\w+\.get\([^)]+\))[^}]*(return\s+(false|null)|throw)",
                "存在拦截型校验：查询失败即中断控制流",
            ),
            (r"if\s*\([^)]*==\s*null[^)]*\)\s*return", "空值检查会中断控制流"),
            (
                r"(\w+)Store\.get\((\w+)\)[^}]*if\s*\(\1\s*==\s*null\)",
                "数据查询结果判空后会中断控制流",
            ),
        ],
        "skill_step": "Step 6.2 控制流可达性验证",
        "suggestion": "检查数据流起点前是否存在查询操作，验证查询键格式是否受控，确认查询失败是否中断控制流",
    },
    "protection_disagreement": {
        "name": "防护有效性判断不一致",
        "keywords": [
            "startsWith",
            "contains",
            "equals",
            "白名单",
            "黑名单",
            "filter",
            "validate",
            "sanitize",
            "校验",
            "过滤",
            "check",
            "verify",
        ],
        "evidence_patterns": [
            (r"startsWith\s*\(", "Agent 识别到前缀匹配，可能认为可被绕过"),
            (r"contains\s*\(", "精确匹配比前缀匹配更安全"),
            (r"白名单[^)]*startsWith", "白名单使用前缀匹配可能被绕过"),
            (r"equals\s*\(", "精确匹配通常被认为是安全的"),
        ],
        "skill_step": "Step 6.4 防护有效性验证",
        "suggestion": "明确白名单匹配方式的安全性等级：startsWith < contains < equals",
    },
    "history_misuse": {
        "name": "历史经验使用不当",
        "keywords": [
            "历史",
            "历史记录",
            "备注",
            "history",
            "经验",
            "相似案例",
            "之前",
            "已处理",
        ],
        "evidence_patterns": [
            (r"历史[^。]*显示|历史记录[^。]*显示", "Agent 引用了历史记录作为依据"),
            (r"但当前|然而[^。]*方法|但该", "存在转折，可能未验证历史记录适用性"),
        ],
        "skill_step": "Step 5 历史经验查询",
        "suggestion": "引用历史记录前，必须验证：漏洞类型一致、代码路径一致、防护方法在当前路径生效",
    },
    "version_mismatch": {
        "name": "代码版本不一致",
        "keywords": [
            "不存在",
            "已移除",
            "已重构",
            "代码变更",
            "版本不同",
            "sink.*不存在",
            "已删除",
            "removed",
        ],
        "evidence_patterns": [
            (r"sink[^。]*不存在|不存在[^。]*sink", "Sink 点已移除或重构"),
            (r"代码[^。]*变更|已重构|已删除", "代码版本与扫描时不同"),
            (r"该方法[^。]*不存在", "方法已被移除"),
        ],
        "skill_step": "Step 4 代码版本验证",
        "suggestion": "对比 CodeQL 报告的文件路径+行号与会话中分析的代码，确认 sink 点存在性",
    },
}


def extract_code_snippet(text: str, max_length: int = 200) -> dict[str, str]:
    """从文本中提取代码片段"""
    result = {"file": "", "line": "", "snippet": ""}

    file_match = re.search(r"(?:文件|file|File)[:\s]+([^\s,，]+)", text)
    if file_match:
        result["file"] = file_match.group(1).strip()

    line_match = re.search(r"(?:行|line|Line)[:\s]+(\d+)", text)
    if line_match:
        result["line"] = line_match.group(1)

    code_blocks = re.findall(r"```[a-z]*\n?([^`]+)```", text, re.DOTALL)
    if code_blocks:
        snippet = code_blocks[0].strip()[:max_length]
        result["snippet"] = snippet

    return result


def find_keyword_positions(text: str, keywords: list[str]) -> list[dict[str, str]]:
    """定位关键词在文本中的位置"""
    positions = []
    text_lower = text.lower()

    for kw in keywords:
        kw_lower = kw.lower()
        start = 0
        while True:
            pos = text_lower.find(kw_lower, start)
            if pos == -1:
                break

            context_start = max(0, pos - 30)
            context_end = min(len(text), pos + len(kw) + 30)
            context = text[context_start:context_end].replace("\n", " ")

            positions.append(
                {"keyword": kw, "position": pos, "context": f"...{context}..."}
            )
            start = pos + 1

    return positions[:10]


def classify_single_case(
    reasoning: str, ground_truth: str, agent_conclusion: str, format_type: str = "json"
) -> dict:
    """
    判定单个案例的错误类型

    Args:
        reasoning: Agent 推理过程文本
        ground_truth: 人工标注（Positive/Negative）
        agent_conclusion: Agent 判定（漏洞/safe）
        format_type: 输出格式（json/text）

    Returns:
        包含 error_type, confidence, evidence 的字典
    """
    ground_truth_norm = ground_truth.capitalize()
    agent_conclusion_lower = agent_conclusion.lower()

    is_fp = (
        agent_conclusion_lower in ["漏洞", "vulnerability"]
        and ground_truth_norm == "Negative"
    )
    is_fn = (
        agent_conclusion_lower in ["safe", "安全"] and ground_truth_norm == "Positive"
    )

    if not is_fp and not is_fn:
        return {
            "error_type": "not_error",
            "confidence": "high",
            "evidence": f"Agent 判定({agent_conclusion})与 Ground Truth({ground_truth})一致",
            "reasoning": "非错误案例",
            "validation_needed": False,
        }

    keywords = []
    for error_type, config in ERROR_PATTERNS.items():
        for kw in config["keywords"]:
            if kw.lower() in reasoning.lower():
                keywords.append(kw)
    keywords = list(set(keywords))

    evidences = []
    matched_patterns = []
    for error_type, config in ERROR_PATTERNS.items():
        for pattern, description in config["evidence_patterns"]:
            match = re.search(pattern, reasoning, re.IGNORECASE | re.DOTALL)
            if match:
                evidences.append(
                    {
                        "error_type": error_type,
                        "description": description,
                        "matched_text": match.group(0)[:100],
                    }
                )
                matched_patterns.append(error_type)

    type_scores = dict.fromkeys(ERROR_PATTERNS.keys(), 0)

    for kw in keywords:
        for error_type, config in ERROR_PATTERNS.items():
            if kw.lower() in [k.lower() for k in config["keywords"]]:
                type_scores[error_type] += 1

    for ev in evidences:
        type_scores[ev["error_type"]] += 2

    sorted_types = sorted(type_scores.items(), key=lambda x: x[1], reverse=True)

    if sorted_types[0][1] == 0:
        result = {
            "error_type": "unknown",
            "confidence": "low",
            "evidence": "无法从推理过程中识别明确错误类型",
            "reasoning": reasoning[:500] if reasoning else "",
            "validation_needed": True,
            "matched_keywords": keywords[:5],
            "next_action": "建议人工审查此案例",
        }
    else:
        best_type = sorted_types[0][0]
        best_score = sorted_types[0][1]
        second_score = sorted_types[1][1] if len(sorted_types) > 1 else 0

        if best_score >= 3 and best_score > second_score * 1.5:
            confidence = "high"
            validation_needed = False
        elif best_score >= 2:
            confidence = "medium"
            validation_needed = True
        else:
            confidence = "low"
            validation_needed = True

        matched_evidences = [ev for ev in evidences if ev["error_type"] == best_type]
        config = ERROR_PATTERNS[best_type]

        code_snippet = extract_code_snippet(reasoning)
        keyword_positions = find_keyword_positions(reasoning, config["keywords"])

        if format_type == "text":
            evidence = {
                "summary": matched_evidences[0]["description"]
                if matched_evidences
                else f"关键词匹配: {', '.join(keywords[:3])}",
                "matched_keywords": keywords[:5],
                "keyword_positions": keyword_positions,
                "code_reference": code_snippet,
                "skill_step": config["skill_step"],
                "suggestion": config["suggestion"],
            }
        else:
            evidence = (
                matched_evidences[0]["description"]
                if matched_evidences
                else f"关键词匹配: {', '.join(keywords[:3])}"
            )

        result = {
            "error_type": config["name"],
            "confidence": confidence,
            "evidence": evidence,
            "reasoning": reasoning[:500] if reasoning else "",
            "validation_needed": validation_needed,
            "skill_step": config["skill_step"],
            "matched_patterns": [ev["description"] for ev in matched_evidences[:3]],
        }

    return result


def classify_batch(cases: list[dict], format_type: str = "json") -> dict:
    """批量判定错误类型"""
    results = []

    for case in cases:
        reasoning = case.get("reasoning", "") or case.get("reasoning_steps", [{}])[
            0
        ].get("content", "")
        ground_truth = case.get("ground_truth", "Unknown")
        agent_conclusion = case.get("agent_conclusion", "unknown")

        classification = classify_single_case(
            reasoning, ground_truth, agent_conclusion, format_type
        )

        result = {**case, **classification}
        results.append(result)

    error_type_dist = {}
    for r in results:
        et = r.get("error_type", "unknown")
        error_type_dist[et] = error_type_dist.get(et, 0) + 1

    return {
        "total": len(results),
        "classified": sum(
            1 for r in results if r.get("error_type") not in ["not_error", "unknown"]
        ),
        "error_type_distribution": error_type_dist,
        "low_confidence_count": sum(1 for r in results if r.get("confidence") == "low"),
        "needs_validation_count": sum(1 for r in results if r.get("validation_needed")),
        "results": results,
    }


def format_agent_output(data: dict) -> str:
    """格式化为 Agent 可读的输出"""
    lines = [
        "## 错误类型判定结果",
        "",
        f"**总数**: {data.get('total', 0)}",
        f"**已分类**: {data.get('classified', 0)}",
        f"**待验证**: {data.get('needs_validation_count', 0)}",
        "",
        "### 错误类型分布",
        "",
    ]

    for et, count in sorted(
        data.get("error_type_distribution", {}).items(),
        key=lambda x: x[1],
        reverse=True,
    ):
        lines.append(f"- {et}: {count}")

    lines.extend(["", "### 关键发现", ""])

    results = data.get("results", [])
    for r in results[:3]:
        if r.get("error_type") not in ["not_error", "unknown"]:
            lines.append(f"#### 案例 {r.get('issue_id', 'unknown')[:8]}")
            lines.append(f"- **错误类型**: {r.get('error_type')}")
            lines.append(f"- **置信度**: {r.get('confidence')}")
            if isinstance(r.get("evidence"), dict):
                lines.append(f"- **证据**: {r['evidence'].get('summary', 'N/A')}")
                lines.append(
                    f"- **对应步骤**: {r['evidence'].get('skill_step', 'N/A')}"
                )
            lines.append("")

    low_conf = [r for r in results if r.get("confidence") == "low"]
    if low_conf:
        lines.extend(["### ⚠️ 低置信度案例（需人工确认）", ""])
        for r in low_conf:
            lines.append(f"- {r.get('issue_id', 'unknown')[:8]}: {r.get('error_type')}")

    lines.extend(
        ["", "---", f"**生成时间**: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"]
    )

    return "\n".join(lines)


def main():
    setup_logging(script_name="classify_error")
    parser = argparse.ArgumentParser(
        description="自动判定错误类型",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  %(prog)s --reasoning "用户输入..." --ground-truth Negative --agent-conclusion 漏洞
  %(prog)s --from-file tmp/analysis.json --output tmp/classified.json
  %(prog)s --from-file tmp/analysis.json --format text
        """,
    )
    parser.add_argument("--reasoning", "-r", help="Agent 推理过程文本")
    parser.add_argument("--ground-truth", "-g", help="人工标注（Positive/Negative）")
    parser.add_argument("--agent-conclusion", "-a", help="Agent 判定（漏洞/safe）")
    parser.add_argument("--from-file", "-f", help="从 JSON 文件读取批量案例")
    parser.add_argument("--output", "-o", help="输出文件路径（可选）")
    parser.add_argument(
        "--format",
        choices=["json", "text"],
        default="json",
        help="输出格式（默认 json，text 格式更适合人类阅读）",
    )

    args = parser.parse_args()

    if args.from_file:
        if not os.path.exists(args.from_file):
            print(f"错误: 文件不存在 {args.from_file}", file=sys.stderr)
            sys.exit(1)

        with open(args.from_file, encoding="utf-8") as f:
            data = json.load(f)

        cases = data.get("cases", [data]) if isinstance(data, dict) else data
        output_data = classify_batch(cases, args.format)

    elif args.reasoning and args.ground_truth and args.agent_conclusion:
        result = classify_single_case(
            args.reasoning, args.ground_truth, args.agent_conclusion, args.format
        )
        output_data = result
    else:
        print(
            "错误: 必须提供 --from-file 或 (--reasoning, --ground-truth, --agent-conclusion)",
            file=sys.stderr,
        )
        sys.exit(1)

    if args.format == "text" and isinstance(output_data, dict):
        if "results" in output_data:
            output_text = format_agent_output(output_data)
        else:
            lines = [
                "## 单案例判定结果",
                "",
                f"- **错误类型**: {output_data.get('error_type', 'N/A')}",
                f"- **置信度**: {output_data.get('confidence', 'N/A')}",
                f"- **证据**: {output_data.get('evidence', 'N/A') if isinstance(output_data.get('evidence'), str) else output_data.get('evidence', {}).get('summary', 'N/A')}",
                f"- **对应步骤**: {output_data.get('skill_step', 'N/A')}",
                f"- **需人工验证**: {'是' if output_data.get('validation_needed') else '否'}",
            ]
            output_text = "\n".join(lines)
    else:
        output_text = json.dumps(output_data, ensure_ascii=False, indent=2)

    if args.output:
        os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(output_text)
        print(f"结果已保存到: {args.output}")
    else:
        print(output_text)


if __name__ == "__main__":
    main()
