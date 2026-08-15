#!/usr/bin/env python3
"""Security Assessment Query CLI - 安全评估报告专用查询工具（无外部依赖）

所属模式: security-assessment
用途: 从 api_inventory.db 查询白盒审计结果，为安全评估报告生成提供数据输入
数据库: db/api_inventory.db (API_INVENTORY_DB_PATH)
命令: vulns / apis / by-module / apis-by-file / by-vul-type / params / stats
"""

import argparse
import json
import logging
import os
import re
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _shared import (
    API_INVENTORY_SCHEMA,
    DatabaseManager,
    OutputPathError,
    get_db_path,
    validate_output_file_path,
)

logger = logging.getLogger(__name__)

SEVERITY_ORDER = {"critical": 4, "high": 3, "medium": 2, "low": 1, "info": 0}


def max_severity(*severities):
    """返回给定严重度列表中最高等级的值"""
    valid = [s for s in severities if s and s in SEVERITY_ORDER]
    if not valid:
        return None
    return max(valid, key=lambda s: SEVERITY_ORDER[s])


# ============ 查询类 ============


class SecurityAssessmentDB:
    def __init__(self, db_path: str = None):
        self.base_db = DatabaseManager(get_db_path(db_path), API_INVENTORY_SCHEMA)
        self.conn = self.base_db.conn

    # ---------- vulns: 扁平化全部漏洞/风险 ----------

    def query_vulns(
        self, git_address: str, severity: list = None, conclusion: list = None
    ) -> list:
        sql = """
            SELECT id, file_path, api_method, api_path, http_method,
                   api_description, priority, api_type, vul_types,
                   vulnerabilities_count, risks_count, overall_severity,
                   audit_status, result_json, key_findings, functional_impact
            FROM api_inventory
            WHERE deleted_at IS NULL AND git_address = ? AND audit_status IN ('BLOCK', 'WARNING')
        """
        rows = self.conn.execute(sql, [git_address]).fetchall()

        results = []
        for r in rows:
            row = dict(r)
            if not row.get("result_json"):
                continue
            try:
                result_data = json.loads(row["result_json"])
            except (json.JSONDecodeError, TypeError):
                continue

            findings = result_data.get("findings", {})
            for vuln in findings.get("vulnerabilities", []):
                item = self._flatten_finding(vuln, row)
                if self._match_filter(item, severity, conclusion):
                    results.append(item)
            for risk in findings.get("risks", []):
                item = self._flatten_finding(risk, row)
                if self._match_filter(item, severity, conclusion):
                    results.append(item)

        return results

    def _flatten_finding(self, finding: dict, api_row: dict) -> dict:
        api_type = api_row.get("api_type")
        if api_type and isinstance(api_type, str):
            try:
                api_type = json.loads(api_type)
            except (json.JSONDecodeError, TypeError):
                pass
        return {
            "api_id": api_row["id"],
            "api_path": api_row["api_path"],
            "http_method": api_row["http_method"],
            "file_path": api_row["file_path"],
            "api_method": api_row["api_method"],
            "api_description": api_row["api_description"],
            "priority": api_row["priority"],
            "api_type": api_type,
            "finding_id": finding.get("id"),
            "category": finding.get("category"),
            "conclusion": finding.get("conclusion"),
            "severity": finding.get("severity"),
            "entry_point": finding.get("entry_point"),
            "root_cause": finding.get("root_cause"),
            "description": finding.get("description"),
            "recommendation": finding.get("recommendation"),
            "confidence": finding.get("confidence"),
            "data_flow": finding.get("data_flow"),
            "example_payload": finding.get("example_payload"),
            "affected_locations": finding.get("affected_locations"),
        }

    def _match_filter(self, item: dict, severity: list, conclusion: list) -> bool:
        if severity and item.get("severity") not in severity:
            return False
        if conclusion and item.get("conclusion") not in conclusion:
            return False
        return True

    # ---------- apis: 带审计结果的 API 完整记录 ----------

    def query_apis(self, git_address: str, audit_status: list = None) -> list:
        if not audit_status:
            audit_status = ["BLOCK", "WARNING"]
        placeholders = ",".join("?" * len(audit_status))
        sql = f"""
            SELECT id, file_path, api_method, api_path, http_method,
                   api_description, priority, api_type, vul_types,
                   vulnerabilities_count, risks_count, overall_severity,
                   audit_status, result_json, key_findings, functional_impact
            FROM api_inventory
            WHERE deleted_at IS NULL AND git_address = ? AND audit_status IN ({placeholders})
        """
        params = [git_address] + audit_status
        rows = self.conn.execute(sql, params).fetchall()
        results = []
        for r in rows:
            row = dict(r)
            if row.get("api_type"):
                try:
                    row["api_type"] = json.loads(row["api_type"])
                except (json.JSONDecodeError, TypeError):
                    pass
            results.append(row)
        return results

    # ---------- by-module: 按文件分组统计 ----------

    def query_by_module(self, git_address: str, audit_status: list = None) -> list:
        if not audit_status:
            audit_status = ["BLOCK", "WARNING"]
        placeholders = ",".join("?" * len(audit_status))
        sql = f"""
            SELECT file_path,
                   COUNT(*) AS api_count,
                   COALESCE(SUM(vulnerabilities_count), 0) AS vulnerability_count,
                   COALESCE(SUM(risks_count), 0) AS risk_count,
                   GROUP_CONCAT(DISTINCT vul_types) AS vul_types_raw,
                   GROUP_CONCAT(DISTINCT overall_severity) AS severity_raw
            FROM api_inventory
            WHERE deleted_at IS NULL AND git_address = ? AND audit_status IN ({placeholders})
            GROUP BY file_path
            ORDER BY vulnerability_count DESC, risk_count DESC
        """
        params = [git_address] + audit_status
        rows = self.conn.execute(sql, params).fetchall()

        results = []
        for r in rows:
            row = dict(r)
            vul_types_set = set()
            if row.get("vul_types_raw"):
                raw = row["vul_types_raw"]
                for match in re.finditer(r"\[([^\]]*)\]", raw):
                    inner = match.group(1)
                    for item in inner.split(","):
                        cleaned = item.strip().strip('"').strip("'")
                        if cleaned:
                            vul_types_set.add(cleaned)
            row["vul_types"] = sorted(vul_types_set)
            del row["vul_types_raw"]
            sev_set = set()
            if row.get("severity_raw"):
                for s in row["severity_raw"].split(","):
                    s = s.strip()
                    if s:
                        sev_set.add(s)
            del row["severity_raw"]
            row["severity_max"] = max_severity(*sev_set) if sev_set else None
            results.append(row)
        return results

    # ---------- apis-by-file: 按文件分组返回所有接口（含 PASS） ----------

    def query_apis_by_file(self, git_address: str, audit_status: list = None) -> list:
        # 默认覆盖 PASS：与 query_apis 的关键差异，让 security-assessment 能看到安全接口
        if not audit_status:
            audit_status = ["BLOCK", "WARNING", "PASS"]
        placeholders = ",".join("?" * len(audit_status))
        sql = f"""
            SELECT file_path, api_method, api_path, http_method,
                   priority, vulnerabilities_count, risks_count,
                   overall_severity, audit_status, vul_types,
                   result_json, functional_impact
            FROM api_inventory
            WHERE deleted_at IS NULL AND git_address = ? AND audit_status IN ({placeholders})
            ORDER BY file_path, http_method, api_path
        """
        params = [git_address] + audit_status
        rows = self.conn.execute(sql, params).fetchall()

        file_groups = defaultdict(list)
        for r in rows:
            row = dict(r)
            file_path = row.get("file_path")
            if not file_path:
                continue
            status = row.get("audit_status")
            # 精简返回：所有接口共有的基础字段
            summary = {
                "api_path": row.get("api_path"),
                "api_method": row.get("api_method"),
                "http_method": row.get("http_method"),
                "audit_status": status,
                "overall_severity": row.get("overall_severity"),
                "priority": row.get("priority"),
                "functional_impact": row.get("functional_impact"),
            }
            # 有漏洞的接口多保留漏洞相关字段（vul_types 在此分支内解析，保证类型恒定）
            if status in ("BLOCK", "WARNING"):
                summary["vulnerabilities_count"] = row.get("vulnerabilities_count", 0)
                summary["risks_count"] = row.get("risks_count", 0)
                raw_vt = row.get("vul_types")
                try:
                    summary["vul_types"] = json.loads(raw_vt) if raw_vt else None
                except (json.JSONDecodeError, TypeError):
                    summary["vul_types"] = None
            # PASS 接口提取防护措施摘要（控制数据量，每条 reason 截断 80 字）
            if status == "PASS" and row.get("result_json"):
                try:
                    result_data = json.loads(row["result_json"])
                    passed_checks = result_data.get("findings", {}).get(
                        "passed_checks", []
                    )
                    summary["passed_checks_summary"] = [
                        (pc.get("reason") or "")[:80]
                        for pc in passed_checks
                        if isinstance(pc, dict)
                    ]
                except (json.JSONDecodeError, TypeError):
                    summary["passed_checks_summary"] = []
            file_groups[file_path].append(summary)

        results = []
        for file_path, summaries in sorted(file_groups.items()):
            results.append(
                {
                    "file_path": file_path,
                    "api_count": len(summaries),
                    "api_summary": summaries,
                }
            )
        return results

    # ---------- by-vul-type: 按漏洞类别分组 ----------

    def query_by_vul_type(self, git_address: str, category: list = None) -> list:
        sql = """
            SELECT id, api_path, http_method, file_path, priority,
                   audit_status, overall_severity, result_json, vul_types
            FROM api_inventory
            WHERE deleted_at IS NULL AND git_address = ? AND audit_status IN ('BLOCK', 'WARNING')
        """
        rows = self.conn.execute(sql, [git_address]).fetchall()

        category_map = defaultdict(
            lambda: {
                "category": "",
                "count": 0,
                "api_ids": [],
                "severities": [],
                "apis": [],
            }
        )

        for r in rows:
            row = dict(r)
            if not row.get("result_json"):
                continue
            try:
                result_data = json.loads(row["result_json"])
            except (json.JSONDecodeError, TypeError):
                continue

            findings = result_data.get("findings", {})
            seen_cats = set()
            all_findings = findings.get("vulnerabilities", []) + findings.get(
                "risks", []
            )
            for finding in all_findings:
                cat = finding.get("category", "Unknown")
                entry = category_map[cat]
                entry["severities"].append(finding.get("severity"))
                if cat not in seen_cats:
                    seen_cats.add(cat)
                    entry["count"] += 1
                    entry["api_ids"].append(row["id"])
                    entry["apis"].append(
                        {
                            "api_id": row["id"],
                            "api_path": row["api_path"],
                            "http_method": row["http_method"],
                            "severity": finding.get("severity"),
                            "conclusion": finding.get("conclusion"),
                        }
                    )

        results = []
        for cat, data in sorted(
            category_map.items(), key=lambda x: x[1]["count"], reverse=True
        ):
            if category and cat not in category:
                continue
            data["category"] = cat
            data["severity_max"] = max_severity(*data["severities"])
            del data["severities"]
            results.append(data)
        return results

    # ---------- params: 跨 API 共享参数 ----------

    def query_params(self, git_address: str) -> list:
        sql = """
            SELECT id, api_path, http_method, file_path, priority,
                   audit_status, overall_severity, result_json
            FROM api_inventory
            WHERE deleted_at IS NULL AND git_address = ?
        """
        rows = self.conn.execute(sql, [git_address]).fetchall()

        param_pattern = re.compile(r":(\w+)|\{(\w+)\}")
        param_map = defaultdict(list)

        for r in rows:
            row = dict(r)
            api_path = row.get("api_path", "")
            params_found = param_pattern.findall(api_path)
            for match in params_found:
                param_name = match[0] or match[1]
                param_map[param_name].append(
                    {
                        "api_id": row["id"],
                        "api_path": api_path,
                        "http_method": row["http_method"],
                        "file_path": row["file_path"],
                        "audit_status": row["audit_status"],
                        "overall_severity": row["overall_severity"],
                    }
                )

        results = []
        for param_name, apis in sorted(
            param_map.items(), key=lambda x: len(x[1]), reverse=True
        ):
            if len(apis) < 2:
                continue
            results.append(
                {
                    "param_name": param_name,
                    "usage_count": len(apis),
                    "apis": apis,
                }
            )
        return results

    # ---------- stats: 仓库范围统计 ----------

    def query_stats(self, git_address: str) -> dict:
        params = [git_address]
        where = "WHERE deleted_at IS NULL AND git_address = ?"

        total = self.conn.execute(
            f"SELECT COUNT(*) AS cnt FROM api_inventory {where}", params
        ).fetchone()["cnt"]

        audited = self.conn.execute(
            f"SELECT COUNT(*) AS cnt FROM api_inventory {where} AND audit_status IN ('BLOCK','WARNING','PASS')",
            params,
        ).fetchone()["cnt"]

        block = self.conn.execute(
            f"SELECT COUNT(*) AS cnt FROM api_inventory {where} AND audit_status = 'BLOCK'",
            params,
        ).fetchone()["cnt"]

        warning = self.conn.execute(
            f"SELECT COUNT(*) AS cnt FROM api_inventory {where} AND audit_status = 'WARNING'",
            params,
        ).fetchone()["cnt"]

        pass_count = self.conn.execute(
            f"SELECT COUNT(*) AS cnt FROM api_inventory {where} AND audit_status = 'PASS'",
            params,
        ).fetchone()["cnt"]

        pending = total - audited

        severity_counts = defaultdict(int)
        category_counts = defaultdict(int)
        rows = self.conn.execute(
            f"SELECT result_json FROM api_inventory {where} AND audit_status IN ('BLOCK','WARNING')",
            params,
        ).fetchall()
        for r in rows:
            if not r["result_json"]:
                continue
            try:
                data = json.loads(r["result_json"])
                findings = data.get("findings", {})
                for v in findings.get("vulnerabilities", []):
                    severity_counts[v.get("severity", "unknown")] += 1
                    category_counts[v.get("category", "Unknown")] += 1
                for rk in findings.get("risks", []):
                    severity_counts[rk.get("severity", "unknown")] += 1
                    category_counts[rk.get("category", "Unknown")] += 1
            except (json.JSONDecodeError, TypeError):
                pass

        return {
            "total_apis": total,
            "audited_apis": audited,
            "pending_apis": pending,
            "block_count": block,
            "warning_count": warning,
            "pass_count": pass_count,
            "by_severity": dict(severity_counts),
            "by_category": dict(category_counts),
        }

    def close(self):
        self.base_db.close()


# ============ 主函数 ============


def main():
    parser = argparse.ArgumentParser(
        description="Security Assessment Query CLI - 安全评估报告专用查询"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    # vulns
    vulns_parser = subparsers.add_parser(
        "vulns", help="查询仓库全部漏洞/风险（扁平列表）"
    )
    vulns_parser.add_argument("--git", required=True, help="Git 地址")
    vulns_parser.add_argument(
        "--severity", help="按严重度筛选，逗号分隔（critical,high,medium,low）"
    )
    vulns_parser.add_argument(
        "--conclusion", help="按结论筛选，逗号分隔（vulnerability,risk-a,risk-b）"
    )
    vulns_parser.add_argument(
        "--output-file",
        help="输出到 JSON 文件（必须使用 .code-audit-tmp/ 目录）",
    )

    # apis
    apis_parser = subparsers.add_parser("apis", help="查询带审计结果的 API 完整记录")
    apis_parser.add_argument("--git", required=True, help="Git 地址")
    apis_parser.add_argument(
        "--audit-status", help="审计状态筛选，逗号分隔（BLOCK,WARNING）"
    )
    apis_parser.add_argument(
        "--output-file",
        help="输出到 JSON 文件（必须使用 .code-audit-tmp/ 目录）",
    )

    # by-module
    module_parser = subparsers.add_parser("by-module", help="按 file_path 分组统计")
    module_parser.add_argument("--git", required=True, help="Git 地址")
    module_parser.add_argument("--audit-status", help="审计状态筛选，逗号分隔")
    module_parser.add_argument(
        "--output-file",
        help="输出到 JSON 文件（必须使用 .code-audit-tmp/ 目录）",
    )

    # by-vul-type
    vultype_parser = subparsers.add_parser("by-vul-type", help="按漏洞类别分组统计")
    vultype_parser.add_argument("--git", required=True, help="Git 地址")
    vultype_parser.add_argument(
        "--category", help="按类别筛选，逗号分隔（IDOR,SSRF,SQLi）"
    )
    vultype_parser.add_argument(
        "--output-file",
        help="输出到 JSON 文件（必须使用 .code-audit-tmp/ 目录）",
    )

    # params
    params_parser = subparsers.add_parser("params", help="提取跨 API 共享参数")
    params_parser.add_argument("--git", required=True, help="Git 地址")
    params_parser.add_argument(
        "--output-file",
        help="输出到 JSON 文件（必须使用 .code-audit-tmp/ 目录）",
    )

    # apis-by-file
    file_parser = subparsers.add_parser(
        "apis-by-file", help="按文件分组返回所有接口（含 PASS），用于跨接口组合分析"
    )
    file_parser.add_argument("--git", required=True, help="Git 地址")
    file_parser.add_argument(
        "--audit-status", help="审计状态筛选，逗号分隔（默认 BLOCK,WARNING,PASS）"
    )
    file_parser.add_argument(
        "--output-file",
        help="输出到 JSON 文件（必须使用 .code-audit-tmp/ 目录）",
    )

    # stats
    stats_parser = subparsers.add_parser("stats", help="仓库范围统计概览")
    stats_parser.add_argument("--git", required=True, help="Git 地址")
    stats_parser.add_argument(
        "--output-file",
        help="输出到 JSON 文件（必须使用 .code-audit-tmp/ 目录）",
    )

    args = parser.parse_args()

    try:
        validate_output_file_path(getattr(args, "output_file", None))
    except OutputPathError as e:
        print(json.dumps({"status": "error", "message": str(e)}, ensure_ascii=False))
        sys.exit(1)

    db = SecurityAssessmentDB()

    def _output(data, output_file=None):
        text = json.dumps(data, ensure_ascii=False, indent=2)
        if output_file:
            with open(output_file, "w", encoding="utf-8") as f:
                f.write(text + "\n")
            print(
                json.dumps(
                    {
                        "status": "success",
                        "count": len(data) if isinstance(data, list) else 1,
                        "output_file": output_file,
                    },
                    ensure_ascii=False,
                )
            )
        else:
            print(text)

    try:
        if args.command == "vulns":
            severity = (
                [s.strip() for s in args.severity.split(",")] if args.severity else None
            )
            conclusion = (
                [c.strip() for c in args.conclusion.split(",")]
                if args.conclusion
                else None
            )
            results = db.query_vulns(args.git, severity, conclusion)
            _output(results, args.output_file)

        elif args.command == "apis":
            audit_status = (
                [s.strip() for s in args.audit_status.split(",")]
                if args.audit_status
                else None
            )
            results = db.query_apis(args.git, audit_status)
            _output(results, args.output_file)

        elif args.command == "by-module":
            audit_status = (
                [s.strip() for s in args.audit_status.split(",")]
                if args.audit_status
                else None
            )
            results = db.query_by_module(args.git, audit_status)
            _output(results, args.output_file)

        elif args.command == "by-vul-type":
            category = (
                [c.strip() for c in args.category.split(",")] if args.category else None
            )
            results = db.query_by_vul_type(args.git, category)
            _output(results, args.output_file)

        elif args.command == "params":
            results = db.query_params(args.git)
            _output(results, args.output_file)

        elif args.command == "apis-by-file":
            audit_status = (
                [s.strip() for s in args.audit_status.split(",")]
                if args.audit_status
                else None
            )
            results = db.query_apis_by_file(args.git, audit_status)
            _output(results, args.output_file)

        elif args.command == "stats":
            result = db.query_stats(args.git)
            _output(result, args.output_file)

    finally:
        db.close()


if __name__ == "__main__":
    main()
