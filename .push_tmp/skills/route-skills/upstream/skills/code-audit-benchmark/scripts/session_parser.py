#!/usr/bin/env python3
"""
会话解析脚本 - 从 JSONL 会话文件中提取关键信息

用法:
  python3 session_parser.py --file <session_file> --types <types> [--output <format>]

参数:
  --file: 会话文件路径（JSONL 格式）
  --types: 要提取的内容类型，逗号分隔
           可选值: user_input, llm_reasoning, llm_output, tool_call, tool_result, all
  --output: 输出格式（json/text，默认 text）
  --limit: 限制输出条数（可选）

示例:
  # 提取所有内容
  python3 session_parser.py --file session.jsonl --types all

  # 仅提取推理过程和工具调用
  python3 session_parser.py --file session.jsonl --types llm_reasoning,tool_call --output json

  # 提取用户输入和 LLM 输出
  python3 session_parser.py --file session.jsonl --types user_input,llm_output
"""

import argparse
import json
import sys
from pathlib import Path
from typing import Any


def parse_session(file_path: str) -> list[dict[str, Any]]:
    """解析 JSONL 会话文件"""
    messages = []
    error_count = 0
    with open(file_path, encoding="utf-8") as f:
        for line_no, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                data = json.loads(line)
                data["_line_no"] = line_no
                messages.append(data)
            except json.JSONDecodeError as e:
                error_count += 1
                print(
                    f"Warning: Line {line_no} is not valid JSON: {e}", file=sys.stderr
                )

    if not messages:
        print(f"Warning: No valid messages parsed from {file_path}", file=sys.stderr)
    elif error_count > 0:
        print(
            f"Info: Parsed {len(messages)} messages, {error_count} parse errors",
            file=sys.stderr,
        )

    return messages


def extract_user_input(messages: list[dict]) -> list[dict]:
    """提取用户输入"""
    results = []
    for msg in messages:
        if msg.get("role") == "user" and msg.get("type") == "message":
            content = msg.get("content", "")
            if isinstance(content, str):
                results.append(
                    {
                        "line_no": msg.get("_line_no"),
                        "type": "user_input",
                        "content": content,
                        "timestamp": msg.get("timestamp"),
                    }
                )
    return results


def extract_llm_reasoning(messages: list[dict]) -> list[dict]:
    """提取 LLM 推理过程"""
    results = []
    for msg in messages:
        if msg.get("role") == "assistant" and msg.get("type") == "message":
            content_list = msg.get("content", [])
            if isinstance(content_list, list):
                for item in content_list:
                    if isinstance(item, dict) and item.get("type") == "reasoning":
                        results.append(
                            {
                                "line_no": msg.get("_line_no"),
                                "type": "llm_reasoning",
                                "content": item.get("text", ""),
                                "timestamp": msg.get("timestamp"),
                                "model": msg.get("model"),
                            }
                        )
    return results


def extract_llm_output(messages: list[dict]) -> list[dict]:
    """提取 LLM 文本输出（不含推理）"""
    results = []
    for msg in messages:
        if msg.get("role") == "assistant" and msg.get("type") == "message":
            content_list = msg.get("content", [])
            if isinstance(content_list, list):
                text_parts = []
                for item in content_list:
                    if isinstance(item, dict) and item.get("type") == "text":
                        text_parts.append(item.get("text", ""))
                if text_parts:
                    results.append(
                        {
                            "line_no": msg.get("_line_no"),
                            "type": "llm_output",
                            "content": "\n".join(text_parts),
                            "timestamp": msg.get("timestamp"),
                            "model": msg.get("model"),
                        }
                    )
    return results


def extract_tool_calls(messages: list[dict]) -> list[dict]:
    """提取工具调用"""
    results = []
    for msg in messages:
        if msg.get("role") == "assistant" and msg.get("type") == "message":
            content_list = msg.get("content", [])
            if isinstance(content_list, list):
                for item in content_list:
                    if isinstance(item, dict) and item.get("type") == "tool_use":
                        results.append(
                            {
                                "line_no": msg.get("_line_no"),
                                "type": "tool_call",
                                "tool_name": item.get("name"),
                                "tool_input": item.get("input"),
                                "tool_id": item.get("id"),
                                "timestamp": msg.get("timestamp"),
                            }
                        )
    return results


def extract_tool_results(messages: list[dict]) -> list[dict]:
    """提取工具返回结果"""
    results = []
    for msg in messages:
        if msg.get("role") == "tool" and msg.get("type") == "message":
            content_list = msg.get("content", [])
            if isinstance(content_list, list):
                for item in content_list:
                    if isinstance(item, dict) and item.get("type") == "tool-result":
                        tool_result = {
                            "line_no": msg.get("_line_no"),
                            "type": "tool_result",
                            "tool_call_id": item.get("toolCallId"),
                            "tool_name": item.get("toolName"),
                            "timestamp": msg.get("timestamp"),
                        }
                        result_data = item.get("result", {})
                        if isinstance(result_data, dict):
                            llm_content = result_data.get("llmContent", "")
                            if isinstance(llm_content, str) and len(llm_content) > 500:
                                tool_result["result"] = (
                                    llm_content[:500] + "\n... [truncated]"
                                )
                            else:
                                tool_result["result"] = llm_content
                            tool_result["return_display"] = result_data.get(
                                "returnDisplay"
                            )
                        else:
                            tool_result["result"] = str(result_data)[:500]
                        results.append(tool_result)
    return results


def extract_conclusion(messages: list[dict]) -> list[dict]:
    """提取最终结论（conclusion_type 字段）"""
    results = []
    for msg in messages:
        if msg.get("role") == "assistant" and msg.get("type") == "message":
            content_list = msg.get("content", [])
            if isinstance(content_list, list):
                for item in content_list:
                    if isinstance(item, dict) and item.get("type") == "text":
                        text = item.get("text", "")
                        if "conclusion_type" in text:
                            try:
                                data = json.loads(text)
                                results.append(
                                    {
                                        "line_no": msg.get("_line_no"),
                                        "type": "conclusion",
                                        "conclusion_type": data.get("conclusion_type"),
                                        "judgment_rationale": data.get(
                                            "judgment_rationale", ""
                                        ),
                                        "judgment_summary": data.get(
                                            "judgment_summary", ""
                                        ),
                                        "raw": text,
                                    }
                                )
                            except json.JSONDecodeError:
                                pass
    return results


def format_text_output(items: list[dict], content_type: str) -> str:
    """格式式文本输出"""
    lines = []
    for i, item in enumerate(items, 1):
        lines.append(f"\n{'=' * 60}")
        lines.append(f"[{content_type.upper()}] #{i} (Line {item.get('line_no', '?')})")
        lines.append(f"{'=' * 60}")

        if content_type == "user_input":
            lines.append(item.get("content", ""))
        elif content_type == "llm_reasoning" or content_type == "llm_output":
            lines.append(f"Model: {item.get('model', 'N/A')}")
            lines.append(f"Timestamp: {item.get('timestamp', 'N/A')}")
            lines.append(f"\n{item.get('content', '')}")
        elif content_type == "tool_call":
            lines.append(f"Tool: {item.get('tool_name', 'N/A')}")
            lines.append(f"ID: {item.get('tool_id', 'N/A')}")
            lines.append(f"Timestamp: {item.get('timestamp', 'N/A')}")
            lines.append("\nInput:")
            input_data = item.get("tool_input", {})
            lines.append(json.dumps(input_data, indent=2, ensure_ascii=False))
        elif content_type == "tool_result":
            lines.append(f"Tool: {item.get('tool_name', 'N/A')}")
            lines.append(f"Call ID: {item.get('tool_call_id', 'N/A')}")
            lines.append(f"Timestamp: {item.get('timestamp', 'N/A')}")
            lines.append("\nResult:")
            lines.append(str(item.get("result", "")))
        elif content_type == "conclusion":
            lines.append(f"Conclusion Type: {item.get('conclusion_type', 'N/A')}")
            lines.append(f"\nJudgment Rationale:\n{item.get('judgment_rationale', '')}")
            lines.append(f"\nJudgment Summary:\n{item.get('judgment_summary', '')}")

    return "\n".join(lines) if lines else f"No {content_type} found."


def main():
    parser = argparse.ArgumentParser(
        description="从 JSONL 会话文件中提取关键信息",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--file", "-f", required=True, help="会话文件路径")
    parser.add_argument(
        "--types",
        "-t",
        required=True,
        help="要提取的内容类型（逗号分隔）: user_input, llm_reasoning, llm_output, tool_call, tool_result, conclusion, all",
    )
    parser.add_argument(
        "--output",
        "-o",
        default="text",
        choices=["json", "text"],
        help="输出格式（默认 text）",
    )
    parser.add_argument(
        "--limit", "-l", type=int, default=0, help="限制输出条数（0 表示不限制）"
    )

    args = parser.parse_args()

    file_path = Path(args.file)
    if not file_path.exists():
        print(f"Error: File not found: {file_path}", file=sys.stderr)
        sys.exit(1)

    messages = parse_session(str(file_path))

    type_map = {
        "user_input": extract_user_input,
        "llm_reasoning": extract_llm_reasoning,
        "llm_output": extract_llm_output,
        "tool_call": extract_tool_calls,
        "tool_result": extract_tool_results,
        "conclusion": extract_conclusion,
    }

    requested_types = [t.strip().lower() for t in args.types.split(",")]

    if "all" in requested_types:
        requested_types = list(type_map.keys())

    all_results = {}
    for t in requested_types:
        if t in type_map:
            items = type_map[t](messages)
            if args.limit > 0:
                items = items[: args.limit]
            all_results[t] = items

    if args.output == "json":
        print(json.dumps(all_results, indent=2, ensure_ascii=False))
    else:
        for t, items in all_results.items():
            print(format_text_output(items, t))


if __name__ == "__main__":
    main()
