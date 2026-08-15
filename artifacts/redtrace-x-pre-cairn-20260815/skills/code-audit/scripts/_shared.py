#!/usr/bin/env python3
"""_shared.py — api_discovery_cli / api_inventory_cli / security_assessment_query_cli 局部公共模块

⚠️ 仅供本目录三个 CLI 文件使用，不依赖上级目录任何模块（零外部依赖）
"""

import json
import logging
import os
import re
import sqlite3
import sys
import time
from contextlib import contextmanager
from pathlib import Path

_logger = logging.getLogger(__name__)

# Skill 根目录：从当前文件位置推导，不写死用户主目录
SKILL_ROOT = Path(__file__).resolve().parents[1]


# ============ 并发文件锁 ============


@contextmanager
def file_lock(target_path, timeout_seconds: float = 30.0):
    """跨进程目录锁：保护同一 db 的初始化/迁移等写操作，避免多 Worker 冲突。

    锁目录为 `<target_path>.lock.d`；只序列化管理性写入，常规读写仍依赖 SQLite WAL + busy_timeout。
    """
    lock_dir = Path(f"{target_path}.lock.d")
    lock_dir.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + timeout_seconds
    while True:
        try:
            lock_dir.mkdir()
            break
        except FileExistsError:
            if time.monotonic() >= deadline:
                # 锁残留容错：超时后强制接管，避免死锁阻塞审计任务
                try:
                    lock_dir.rmdir()
                except OSError:
                    pass
                raise TimeoutError(f"等待数据库写锁超时: {lock_dir}")
            time.sleep(0.1)
    try:
        yield
    finally:
        try:
            lock_dir.rmdir()
        except OSError:
            pass


# ============ 日志 ============


def setup_logging(verbose: bool = False, script_name: str = None) -> logging.Logger:
    """配置根 logger：文件 + 控制台双输出（日志写入任务 Workspace 的 .redtrace/code-audit/logs）"""
    log_dir = os.path.join(".redtrace", "code-audit", "logs")
    os.makedirs(log_dir, exist_ok=True)
    log_format = "%(asctime)s - %(levelname)s - %(message)s"

    if script_name is None:
        script_name = os.path.splitext(os.path.basename(sys.argv[0]))[0]
    log_file = os.path.join(log_dir, f"{script_name}.log")

    handlers = [
        logging.FileHandler(log_file, mode="a", encoding="utf-8"),
        logging.StreamHandler(),
    ]
    for h in handlers:
        h.setFormatter(logging.Formatter(log_format))

    root = logging.getLogger()
    root.setLevel(logging.DEBUG if verbose else logging.INFO)
    for h in root.handlers[:]:
        h.close()
        root.removeHandler(h)
    for h in handlers:
        root.addHandler(h)
    return root


# ============ 枚举常量 ============

VALID_HTTP_METHODS = frozenset(
    {"GET", "POST", "PUT", "DELETE", "PATCH", "RPC", "OTHER"}
)
VALID_API_TYPES = frozenset(
    {"inner", "operate", "admin", "toc", "tob", "test", "unclassified"}
)
VALID_PRIORITIES = frozenset({"P0", "P1", "P2", "P3"})

# 同方法不同 HTTP 方法的优先级（GET 最优先，OTHER 最后）
# 注意：scripts/core/result.py 有同名常量，调整顺序时两处同步
HTTP_METHOD_PRECEDENCE = {
    "GET": 0,
    "POST": 1,
    "PUT": 2,
    "DELETE": 3,
    "PATCH": 4,
    "RPC": 5,
    "OTHER": 6,
}


# ============ 规范化函数 ============


def normalize_http_method(method: str) -> str:
    """规范化 HTTP 方法：转大写 + 校验合法值，非法值返回 'OTHER'"""
    if not method:
        return "GET"
    normalized = method.upper()
    return normalized if normalized in VALID_HTTP_METHODS else "OTHER"


def normalize_api_type(value, allow_null: bool = False) -> str | None:
    """规范化 api_type：统一输出 JSON 数组字符串

    支持输入: None, "toc", '["tob","admin"]', ["tob","admin"]
    输出: '["toc"]' 或 '["tob","admin"]' 或 '["unclassified"]'

    Args:
        allow_null: True 时保留旧行为（None 输入返回 None），
                   False 时将无法识别的值统一归为 ["unclassified"]
    """
    UNCLASSIFIED = json.dumps(["unclassified"], ensure_ascii=False)

    if value is None:
        return None if allow_null else UNCLASSIFIED

    if isinstance(value, list):
        valid = [v.lower() for v in value if v and str(v).lower() in VALID_API_TYPES]
        if not valid:
            _logger.warning(f"api_type 数组中无有效元素: {value}")
            return None if allow_null else UNCLASSIFIED
        return json.dumps(sorted(set(valid)), ensure_ascii=False)

    val = str(value).strip()
    if not val:
        return None if allow_null else UNCLASSIFIED

    if val.startswith("["):
        try:
            parsed = json.loads(val)
            if isinstance(parsed, list):
                valid = [
                    v.lower() for v in parsed if v and str(v).lower() in VALID_API_TYPES
                ]
                if not valid:
                    _logger.warning(f"api_type JSON 数组中无有效元素: {val}")
                    return None if allow_null else UNCLASSIFIED
                return json.dumps(sorted(set(valid)), ensure_ascii=False)
        except json.JSONDecodeError:
            pass

    val_lower = val.lower()
    if val_lower in VALID_API_TYPES:
        return json.dumps([val_lower], ensure_ascii=False)

    _logger.warning(f"跳过无效 api_type: {value}")
    return None if allow_null else UNCLASSIFIED


# Flask 路由参数：<converter:variable> 或 <variable>，统一提取变量名
_FLASK_PARAM_RE = re.compile(r"<(?:[a-zA-Z_]\w*:)?([a-zA-Z_]\w*)>")


def normalize_api_path(raw_path: str) -> str:
    """归一化 API path 参数占位符为冒号风格，并剥离 query string、折叠多余斜杠

    Java/Spring: /api/users/{id}     -> /api/users/:id
    Flask:       /api/users/<int:id> -> /api/users/:id
                 /api/users/<id>     -> /api/users/:id
    含 query:    /api/v1/info?format=json -> /api/v1/info
    """
    path = raw_path
    if "?" in path:
        path = path.split("?", 1)[0]
    # 先处理 Flask <...>，再处理 Java {…}，两者字符集不重叠
    path = _FLASK_PARAM_RE.sub(r":\1", path)
    path = path.replace("{", ":").replace("}", "")
    while "//" in path:
        path = path.replace("//", "/")
    return path


# ============ 数据库 Schema ============

API_INVENTORY_SCHEMA = {
    "api_inventory": {
        "sql": """
            CREATE TABLE IF NOT EXISTS api_inventory (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                git_address TEXT NOT NULL,
                file_path TEXT NOT NULL,
                api_method TEXT,
                api_path TEXT NOT NULL,
                http_method TEXT,
                api_description TEXT,
                priority TEXT DEFAULT 'P3',
                api_type TEXT DEFAULT NULL,

                -- 审计字段
                vul_types TEXT,
                vulnerabilities_count INTEGER DEFAULT 0,
                risks_count INTEGER DEFAULT 0,
                overall_severity TEXT,
                audit_status TEXT DEFAULT 'pending',
                result_json TEXT,
                key_findings TEXT,
                functional_impact TEXT,

                -- Flickcli 追踪
                flickcli_session_id TEXT,
                flickcli_steps INTEGER DEFAULT 0,
                flickcli_duration REAL DEFAULT 0.0,
                audit_error TEXT,

                -- 状态追踪
                status TEXT DEFAULT 'pending',
                retry_count INTEGER DEFAULT 0,

                -- 时间戳
                created_at TEXT,
                updated_at TEXT,
                processed_at TEXT,

                -- 采纳状态
                adopted_status INTEGER DEFAULT 0,
                adopted_comment TEXT,

                -- 复核/外网标记
                reviewed_at TEXT,
                external_api INTEGER DEFAULT 0,
                external_evidence TEXT DEFAULT NULL,

                deleted_at TEXT DEFAULT NULL
            )
        """,
        "indexes": [
            "CREATE INDEX IF NOT EXISTS idx_git_address ON api_inventory(git_address)",
            "CREATE INDEX IF NOT EXISTS idx_status ON api_inventory(status)",
            "CREATE INDEX IF NOT EXISTS idx_audit_status ON api_inventory(audit_status)",
            "CREATE INDEX IF NOT EXISTS idx_api_type ON api_inventory(api_type)",
            "CREATE INDEX IF NOT EXISTS idx_api_path ON api_inventory(api_path)",
            "CREATE INDEX IF NOT EXISTS idx_vul_types ON api_inventory(vul_types)",
            "CREATE INDEX IF NOT EXISTS idx_external_api ON api_inventory(external_api)",
        ],
        "unique_indexes": [
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_active_v2 ON api_inventory(git_address, file_path, api_method, http_method) WHERE deleted_at IS NULL",
        ],
    }
}


# ============ 数据库管理器 ============


class DatabaseManager:
    """通用 SQLite 数据库管理器（支持并发写入）"""

    def __init__(
        self, db_path: str, schema: dict = None, check_integrity: bool = False
    ):
        self.db_path = db_path
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(db_path, check_same_thread=False, timeout=30.0)
        self.conn.row_factory = sqlite3.Row
        self._enable_wal_mode()
        if check_integrity:
            self._check_integrity()
        if schema:
            with file_lock(db_path):
                self._init_schema(schema)

    def _enable_wal_mode(self):
        """启用 WAL 模式以提升并发性能"""
        try:
            self.conn.execute("PRAGMA journal_mode=WAL")
            self.conn.execute("PRAGMA busy_timeout=30000")
            self.conn.execute("PRAGMA synchronous=NORMAL")
        except Exception as e:
            _logger.warning(f"启用 WAL 模式失败: {e}")

    def _check_integrity(self):
        """数据库完整性检查（写入场景启用）"""
        try:
            result = self.conn.execute("PRAGMA quick_check").fetchone()
            if result[0] != "ok":
                _logger.error(
                    f"数据库完整性检查失败: {result[0]}，建议备份数据后重建数据库"
                )
        except Exception as e:
            _logger.warning(f"数据库完整性检查异常: {e}")

    def _init_schema(self, schema: dict):
        """初始化数据库表结构"""
        for table_name, table_config in schema.items():
            self.conn.execute(table_config["sql"])
            for index_sql in table_config.get("indexes", []):
                self.conn.execute(index_sql)
            for index_sql in table_config.get("unique_indexes", []):
                try:
                    self.conn.execute(index_sql)
                except sqlite3.IntegrityError:
                    pass  # 有重复数据时跳过，由 _migrate_schema 去重后创建
        self.conn.commit()

    def close(self):
        """关闭数据库连接"""
        if self.conn:
            self.conn.close()
            self.conn = None

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()
        return False


# ============ Schema 迁移 ============


def migrate_inventory_schema(conn) -> None:
    """补齐 api_inventory 历史缺失列，条件创建唯一索引（先去重）

    两个写入场景（api_discovery_cli / api_inventory_cli）共用此逻辑。
    api_inventory_cli 额外执行旧格式 api_type 迁移，不在此处处理。
    """
    _MIGRATION_COLUMNS = [
        "ALTER TABLE api_inventory ADD COLUMN api_type TEXT DEFAULT NULL",
        "ALTER TABLE api_inventory ADD COLUMN deleted_at TEXT DEFAULT NULL",
        "ALTER TABLE api_inventory ADD COLUMN reviewed_at TEXT",
        "ALTER TABLE api_inventory ADD COLUMN external_api INTEGER DEFAULT 0",
        "ALTER TABLE api_inventory ADD COLUMN external_evidence TEXT DEFAULT NULL",
    ]
    for sql in _MIGRATION_COLUMNS:
        try:
            conn.execute(sql)
        except Exception as e:
            # ADD COLUMN 抛"列已存在"属迁移幂等正常分支，用 debug 留线索便于排障；
            # 真正致命的错误（磁盘满/权限/损坏）与正常分支在这里不易精确区分，
            # 均归 debug，下方唯一索引创建失败才用 warning（那是不可恢复的真错误）
            _logger.debug(f"[迁移] 步骤跳过: {sql[:60]}... : {e}")

    try:
        v2_exists = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_unique_active_v2'"
        ).fetchone()
        # 清理旧版 idx_unique_active（列组合为 api_path，与 v2 的 api_method 不同，避免冲突）
        conn.execute("DROP INDEX IF EXISTS idx_unique_active")
        if not v2_exists:
            cursor = conn.execute("""
                DELETE FROM api_inventory WHERE deleted_at IS NULL AND id NOT IN (
                    SELECT id FROM (
                        SELECT id,
                               ROW_NUMBER() OVER (
                                   PARTITION BY git_address, file_path, api_method, http_method
                                   ORDER BY
                                       CASE WHEN result_json IS NOT NULL THEN 0 ELSE 1 END,
                                       CASE WHEN audit_status != 'pending' THEN 0 ELSE 1 END,
                                       updated_at DESC
                               ) AS rn
                        FROM api_inventory WHERE deleted_at IS NULL
                    ) WHERE rn = 1
                )
            """)
            if cursor.rowcount > 0:
                _logger.warning(
                    f"[迁移] 按 (git_address, file_path, api_method, http_method) 去重删除 {cursor.rowcount} 条重复记录"
                )
            conn.execute("""
                CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_active_v2
                ON api_inventory(git_address, file_path, api_method, http_method)
                WHERE deleted_at IS NULL
            """)
            conn.commit()
    except Exception as e:
        conn.rollback()
        _logger.warning(f"[迁移] 唯一索引创建失败: {e}")

    for index_sql in API_INVENTORY_SCHEMA.get("api_inventory", {}).get("indexes", []):
        try:
            conn.execute(index_sql)
        except Exception as e:
            _logger.debug(f"[迁移] 索引创建跳过: {index_sql[:60]}... : {e}")
    conn.commit()


# ============ 工具函数 ============


def get_db_path(override: str = None) -> str:
    """获取数据库路径：优先使用参数，其次环境变量，默认任务级 .redtrace/code-audit/api-inventory.db"""
    return override or os.getenv(
        "API_INVENTORY_DB_PATH",
        os.path.join(".redtrace", "code-audit", "api-inventory.db"),
    )


class OutputPathError(ValueError):
    """--output-file 路径不合法（必须使用 .code-audit-tmp/ 目录）"""

    pass


def validate_output_file_path(output_file: str) -> None:
    """校验 --output-file 路径必须使用 .code-audit-tmp/ 目录，不合法抛 OutputPathError。

    共享库不直接退出进程；由各 CLI 入口捕获后自行决定如何输出错误并退出。
    """
    if not output_file:
        return
    normalized = os.path.normpath(output_file)
    path_parts = normalized.split(os.sep)
    if ".code-audit-tmp" not in path_parts:
        raise OutputPathError(
            f"--output-file 路径必须使用 .code-audit-tmp/ 目录，当前路径: {output_file}；"
            f"示例: --output-file .code-audit-tmp/result.json"
        )
