#!/usr/bin/env python3
"""benchmark-attribution 自包含工具模块（内联依赖，无外部引用）
来源: scripts/common.py, scripts/lib/benchmark_db.py, scripts/lib/schemas.py
"""

import logging
import os
import sqlite3
import sys
import time
from datetime import datetime

# ==================== 日志 ====================
_log_handlers: list[logging.Handler] = []


def setup_logging(verbose: bool = False, script_name: str = None) -> logging.Logger:
    """配置日志系统"""
    global _log_handlers
    log_dir = "logs"
    os.makedirs(log_dir, exist_ok=True)
    log_format = "%(asctime)s - %(levelname)s - %(message)s"

    if script_name is None:
        script_name = os.path.splitext(os.path.basename(sys.argv[0]))[0]
    log_file = f"{log_dir}/{script_name}.log"

    handlers = [
        logging.FileHandler(log_file, mode="a", encoding="utf-8"),
        logging.StreamHandler(),
    ]
    for h in handlers:
        h.setFormatter(logging.Formatter(log_format))

    _logger = logging.getLogger()
    _logger.setLevel(logging.DEBUG if verbose else logging.INFO)

    for h in _log_handlers:
        h.close()
        _logger.removeHandler(h)
    _log_handlers = handlers
    for h in handlers:
        _logger.addHandler(h)
    return _logger


# ==================== 数据库管理 ====================
class DatabaseManager:
    """通用 SQLite 数据库管理器"""

    def __init__(self, db_path: str, schema: dict[str, dict] = None):
        self.db_path = db_path
        self.schema = schema
        self.conn = None
        self._init_db()

    def _init_db(self):
        db_dir = os.path.dirname(self.db_path)
        if db_dir:
            os.makedirs(db_dir, exist_ok=True)
        self.conn = sqlite3.connect(self.db_path, check_same_thread=False, timeout=30.0)
        self.conn.row_factory = sqlite3.Row
        self._enable_wal_mode()

        if self.schema:
            for table_config in self.schema.values():
                self.conn.execute(table_config["sql"])
                for index_sql in table_config.get("indexes", []):
                    try:
                        self.conn.execute(index_sql)
                    except sqlite3.IntegrityError as e:
                        logging.getLogger().warning(
                            f"[数据库] 索引创建跳过（已有数据冲突）: {e}"
                        )
        self.conn.commit()
        logging.getLogger().info(f"[数据库] 初始化完成: {self.db_path}")

    def _enable_wal_mode(self):
        try:
            self.conn.execute("PRAGMA journal_mode=WAL")
            self.conn.execute("PRAGMA busy_timeout=30000")
            self.conn.execute("PRAGMA synchronous=NORMAL")
        except Exception as e:
            logging.getLogger().warning(f"启用 WAL 模式失败: {e}")

    def get_stats(self) -> dict:
        total = self.conn.execute(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table'"
        ).fetchone()[0]
        return {"total_tables": total}

    def close(self):
        if self.conn:
            self.conn.close()


# ==================== Schema ====================
BENCHMARK_SCHEMA = {
    "benchmark_versions": {
        "sql": """
            CREATE TABLE IF NOT EXISTS benchmark_versions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                version TEXT UNIQUE NOT NULL,
                description TEXT,
                prompt_template TEXT,
                model TEXT DEFAULT 'glm-5',
                config_json TEXT,
                total_issues INTEGER DEFAULT 0,
                status TEXT DEFAULT 'pending',
                tp INTEGER DEFAULT 0,
                tn INTEGER DEFAULT 0,
                fp INTEGER DEFAULT 0,
                fn INTEGER DEFAULT 0,
                unknown_count INTEGER DEFAULT 0,
                error_count INTEGER DEFAULT 0,
                precision_val REAL,
                recall_val REAL,
                f1_score REAL,
                accuracy_val REAL,
                specificity_val REAL,
                npv_val REAL,
                created_at TEXT,
                updated_at TEXT,
                completed_at TEXT
            )
        """,
        "indexes": [
            "CREATE INDEX IF NOT EXISTS idx_benchmark_versions_version ON benchmark_versions(version)",
        ],
    },
    "benchmark_results": {
        "sql": """
            CREATE TABLE IF NOT EXISTS benchmark_results (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                version TEXT NOT NULL,
                issue_id TEXT NOT NULL,
                vul_type TEXT,
                git_address TEXT,
                git_branch TEXT,
                git_commit TEXT,
                file_path TEXT,
                vul_content TEXT,
                ground_truth TEXT NOT NULL,
                api_issue_status INTEGER,
                comment TEXT,
                agent_conclusion TEXT,
                agent_conclusion_mapped TEXT,
                agent_full_answer TEXT,
                flickcli_session_id TEXT,
                flickcli_steps INTEGER DEFAULT 0,
                flickcli_duration REAL DEFAULT 0.0,
                classification TEXT,
                run_status TEXT DEFAULT 'pending',
                run_error TEXT,
                run_timestamp TEXT,
                votes_count INTEGER DEFAULT 0,
                vote_details TEXT,
                vote_conclusion TEXT,
                vote_agreement REAL,
                created_at TEXT,
                updated_at TEXT,
                UNIQUE(version, issue_id)
            )
        """,
        "indexes": [
            "CREATE INDEX IF NOT EXISTS idx_br_version ON benchmark_results(version)",
            "CREATE INDEX IF NOT EXISTS idx_br_version_issue ON benchmark_results(version, issue_id)",
            "CREATE INDEX IF NOT EXISTS idx_br_classification ON benchmark_results(version, classification)",
        ],
    },
    "benchmark_metrics_by_vul_type": {
        "sql": """
            CREATE TABLE IF NOT EXISTS benchmark_metrics_by_vul_type (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                version TEXT NOT NULL,
                vul_type TEXT NOT NULL,
                tp INTEGER DEFAULT 0,
                tn INTEGER DEFAULT 0,
                fp INTEGER DEFAULT 0,
                fn INTEGER DEFAULT 0,
                total_judged INTEGER DEFAULT 0,
                precision_val REAL,
                recall_val REAL,
                f1_score REAL,
                accuracy_val REAL,
                created_at TEXT,
                UNIQUE(version, vul_type)
            )
        """,
        "indexes": [
            "CREATE INDEX IF NOT EXISTS idx_bm_version ON benchmark_metrics_by_vul_type(version)",
        ],
    },
}


# ==================== Benchmark 工具函数 ====================
MAX_RETRIES = 5
BASE_DELAY = 0.1

AGENT_POSITIVE = {"漏洞", "有效告警", "vulnerability"}
AGENT_NEGATIVE = {
    "安全",
    "无效告警",
    "风险",
    "风险-A",
    "风险-B",
    "safe",
    "risk-a",
    "risk-b",
}

_logger = logging.getLogger(__name__)


def calc_metric(numerator: int, denominator: int) -> float | None:
    return round(numerator / denominator, 4) if denominator > 0 else None


def classify_result(agent_conclusion: str, ground_truth: str) -> str:
    if agent_conclusion in AGENT_POSITIVE:
        return "TP" if ground_truth == "Positive" else "FP"
    if agent_conclusion in AGENT_NEGATIVE:
        return "TN" if ground_truth == "Negative" else "FN"
    return "unknown"


def compute_metrics(tp: int, tn: int, fp: int, fn: int) -> dict:
    total = tp + tn + fp + fn
    precision = calc_metric(tp, tp + fp)
    recall = calc_metric(tp, tp + fn)
    if precision is not None and recall is not None:
        f1 = (
            round(2 * precision * recall / (precision + recall), 4)
            if (precision + recall) > 0
            else 0.0
        )
    else:
        f1 = None
    return {
        "tp": tp,
        "tn": tn,
        "fp": fp,
        "fn": fn,
        "total_judged": total,
        "precision": precision,
        "recall": recall,
        "f1_score": f1,
        "accuracy": calc_metric(tp + tn, total),
        "specificity": calc_metric(tn, tn + fp),
        "npv": calc_metric(tn, tn + fn),
    }


def resolve_ground_truth(api_issue_status) -> str:
    if api_issue_status == 1:
        return "Positive"
    if api_issue_status == 2:
        return "Negative"
    return "Unknown"


# ==================== BenchmarkDB ====================
class BenchmarkDB(DatabaseManager):
    """Benchmark 数据库管理器"""

    def __init__(self, db_path: str = ".redtrace/code-audit/benchmark.db"):
        super().__init__(db_path, BENCHMARK_SCHEMA)
        self._migrate_votes_columns()
        _logger.info(f"[数据库] Benchmark DB 初始化完成: {self.db_path}")

    def _migrate_votes_columns(self):
        required_columns = {
            "votes_count": "INTEGER DEFAULT 0",
            "vote_details": "TEXT",
            "vote_conclusion": "TEXT",
            "vote_agreement": "REAL",
        }
        try:
            columns = [
                r[1]
                for r in self.conn.execute(
                    "PRAGMA table_info(benchmark_results)"
                ).fetchall()
            ]
        except Exception:
            return
        for col, col_type in required_columns.items():
            if col not in columns:
                self._execute_with_retry(
                    f"ALTER TABLE benchmark_results ADD COLUMN {col} {col_type}"
                )

    def _execute_with_retry(
        self,
        sql: str,
        params: tuple = (),
        max_retries: int = MAX_RETRIES,
        base_delay: float = BASE_DELAY,
    ):
        for attempt in range(max_retries):
            try:
                cursor = self.conn.execute(sql, params)
                self.conn.commit()
                return cursor
            except Exception as e:
                if "locked" in str(e) and attempt < max_retries - 1:
                    time.sleep(base_delay * (2**attempt))
                    continue
                raise
        return None

    # ==================== 版本管理 ====================
    def create_version(
        self,
        version: str,
        description: str = "",
        prompt_template: str = "",
        model: str = "glm-5",
        config_json: str = "",
    ) -> bool:
        now = datetime.now().isoformat()
        try:
            self._execute_with_retry(
                """INSERT INTO benchmark_versions
                   (version, description, prompt_template, model, config_json, status, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)""",
                (version, description, prompt_template, model, config_json, now, now),
            )
            return True
        except Exception as e:
            _logger.error(f"[数据库] 创建版本失败: {e}")
            return False

    def get_version(self, version: str) -> dict | None:
        row = self.conn.execute(
            "SELECT * FROM benchmark_versions WHERE version = ?", (version,)
        ).fetchone()
        return dict(row) if row else None

    def list_versions(self) -> list[dict]:
        rows = self.conn.execute(
            "SELECT * FROM benchmark_versions ORDER BY created_at DESC"
        ).fetchall()
        return [dict(r) for r in rows]

    def update_version_status(self, version: str, status: str):
        now = datetime.now().isoformat()
        extra = ", completed_at = ?" if status == "completed" else ""
        params = [status, now, version]
        if status == "completed":
            params.insert(2, now)
        self._execute_with_retry(
            f"UPDATE benchmark_versions SET status = ?, updated_at = ?{extra} WHERE version = ?",
            tuple(params),
        )

    def update_version_metrics(self, version: str, metrics: dict):
        now = datetime.now().isoformat()
        self._execute_with_retry(
            """UPDATE benchmark_versions SET
                total_issues = ?, tp = ?, tn = ?, fp = ?, fn = ?,
                unknown_count = ?, error_count = ?,
                precision_val = ?, recall_val = ?, f1_score = ?,
                accuracy_val = ?, specificity_val = ?, npv_val = ?,
                updated_at = ?
               WHERE version = ?""",
            (
                metrics.get("total_issues", 0),
                metrics.get("tp", 0),
                metrics.get("tn", 0),
                metrics.get("fp", 0),
                metrics.get("fn", 0),
                metrics.get("unknown_count", 0),
                metrics.get("error_count", 0),
                metrics.get("precision"),
                metrics.get("recall"),
                metrics.get("f1_score"),
                metrics.get("accuracy"),
                metrics.get("specificity"),
                metrics.get("npv"),
                now,
                version,
            ),
        )

    def delete_version(self, version: str):
        self._execute_with_retry(
            "DELETE FROM benchmark_results WHERE version = ?", (version,)
        )
        self._execute_with_retry(
            "DELETE FROM benchmark_metrics_by_vul_type WHERE version = ?", (version,)
        )
        self._execute_with_retry(
            "DELETE FROM benchmark_versions WHERE version = ?", (version,)
        )

    # ==================== 结果管理 ====================
    def insert_result(self, data: dict) -> bool:
        now = datetime.now().isoformat()
        try:
            self._execute_with_retry(
                """INSERT OR IGNORE INTO benchmark_results
                   (version, issue_id, vul_type, git_address, git_branch, git_commit,
                    file_path, vul_content, ground_truth, api_issue_status, comment,
                    run_status, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)""",
                (
                    data["version"],
                    data["issue_id"],
                    data.get("vul_type"),
                    data.get("git_address"),
                    data.get("git_branch"),
                    data.get("git_commit"),
                    data.get("file_path"),
                    data.get("vul_content"),
                    data["ground_truth"],
                    data.get("api_issue_status"),
                    data.get("comment"),
                    now,
                    now,
                ),
            )
            return True
        except Exception as e:
            _logger.error(f"[数据库] 插入结果失败: {e}")
            return False

    def update_result(self, version: str, issue_id: str, **kwargs):
        now = datetime.now().isoformat()
        sets = ", ".join(f"{k} = ?" for k in kwargs)
        params = list(kwargs.values()) + [now, version, issue_id]
        self._execute_with_retry(
            f"UPDATE benchmark_results SET {sets}, updated_at = ? WHERE version = ? AND issue_id = ?",
            tuple(params),
        )

    def get_results(self, version: str, classification: str = None) -> list[dict]:
        if classification:
            rows = self.conn.execute(
                "SELECT * FROM benchmark_results WHERE version = ? AND classification = ?",
                (version, classification),
            ).fetchall()
        else:
            rows = self.conn.execute(
                "SELECT * FROM benchmark_results WHERE version = ?", (version,)
            ).fetchall()
        return [dict(r) for r in rows]

    # ==================== 指标计算 ====================
    def compute_version_metrics(self, version: str) -> dict:
        results = self.get_results(version)
        tp = tn = fp = fn = unknown_count = error_count = 0
        for r in results:
            c = r.get("classification") or ""
            if c == "TP":
                tp += 1
            elif c == "TN":
                tn += 1
            elif c == "FP":
                fp += 1
            elif c == "FN":
                fn += 1
            elif c == "unknown":
                unknown_count += 1
            else:
                error_count += 1

        metrics = compute_metrics(tp, tn, fp, fn)
        metrics["total_issues"] = len(results)
        metrics["unknown_count"] = unknown_count
        metrics["error_count"] = error_count
        return metrics

    def compute_metrics_by_vul_type(self, version: str) -> list[dict]:
        results = self.get_results(version)
        groups = {}
        for r in results:
            vt = r.get("vul_type") or "unknown"
            groups.setdefault(vt, []).append(r)

        out = []
        for vt, items in groups.items():
            tp = tn = fp = fn = 0
            for r in items:
                c = r.get("classification") or ""
                if c == "TP":
                    tp += 1
                elif c == "TN":
                    tn += 1
                elif c == "FP":
                    fp += 1
                elif c == "FN":
                    fn += 1
            m = compute_metrics(tp, tn, fp, fn)
            m["version"] = version
            m["vul_type"] = vt
            out.append(m)
        return out

    def save_metrics_by_vul_type(self, version: str, metrics_list: list[dict]):
        now = datetime.now().isoformat()
        for m in metrics_list:
            self._execute_with_retry(
                """INSERT OR REPLACE INTO benchmark_metrics_by_vul_type
                   (version, vul_type, tp, tn, fp, fn, total_judged,
                    precision_val, recall_val, f1_score, accuracy_val, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    version,
                    m["vul_type"],
                    m["tp"],
                    m["tn"],
                    m["fp"],
                    m["fn"],
                    m["total_judged"],
                    m.get("precision"),
                    m.get("recall"),
                    m.get("f1_score"),
                    m.get("accuracy"),
                    now,
                ),
            )

    def compute_vote_stats(self, version: str) -> dict:
        results = self.get_results(version)
        agreements = []
        tie_count = 0
        votes_count = 0
        for r in results:
            vc = r.get("votes_count") or 0
            if vc > 0:
                votes_count = vc
            ag = r.get("vote_agreement")
            if ag is not None:
                agreements.append(ag)
            if r.get("classification") == "unknown" and vc > 1:
                tie_count += 1
        avg_agreement = (
            round(sum(agreements) / len(agreements), 4) if agreements else None
        )
        return {
            "votes_count": votes_count if votes_count > 1 else None,
            "avg_agreement": avg_agreement,
            "tie_count": tie_count,
        }
