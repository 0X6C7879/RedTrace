#!/usr/bin/env python3
"""API 发现 CLI - 从代码仓库中自动发现 REST API 端点（Agent 独立版本）

所属模式: api-inventory (初始化/发现/工作流子模式)
用途: 从代码仓库自动扫描 REST API 端点和 Java gRPC 接口，入库到 api_inventory.db
数据库: db/api_inventory.db (API_INVENTORY_DB_PATH)
依赖: codegraph 索引（.codegraph/codegraph.db），需提前运行 codegraph init <repo_path>
"""

import argparse
import json
import logging
import os
import sqlite3
import sys
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _shared import (
    API_INVENTORY_SCHEMA,
    HTTP_METHOD_PRECEDENCE,
    DatabaseManager,
    OutputPathError,
    get_db_path,
    migrate_inventory_schema,
    normalize_api_path,
    normalize_api_type,
    normalize_http_method,
    setup_logging,
    validate_output_file_path,
)

logger = logging.getLogger(__name__)


# ============ 数据结构 ============


@dataclass
class ApiEndpoint:
    """API 端点数据结构"""

    git_address: str
    file_path: str
    api_path: str
    http_method: str
    api_method: str = ""
    api_description: str = ""
    priority: str = "P3"
    api_type: str | None = None

    def __post_init__(self):
        self.http_method = normalize_http_method(self.http_method)

    def to_dict(self) -> dict:
        return {
            "git_address": self.git_address,
            "file_path": self.file_path,
            "api_path": self.api_path,
            "http_method": self.http_method,
            "api_method": self.api_method,
            "api_description": self.api_description,
            "priority": self.priority,
            "api_type": normalize_api_type(self.api_type),
        }

    @staticmethod
    def select_primary_path(paths: list[str]) -> str:
        """从多个路径中选择主路径（优先段数最多、最具体的路径）"""
        valid = [p for p in paths if p and p.strip()]
        if not valid:
            return ""
        non_root = [p for p in valid if p != "/"]
        if not non_root:
            return "/"
        return max(non_root, key=lambda p: (len(p.strip("/").split("/")), len(p)))


# ============ API 发现器 ============


class CodegraphApiDiscoverer:
    """Codegraph-based API discoverer — 查询 .codegraph/codegraph.db 中的 route 节点"""

    def __init__(self, repo_path: str, git_address: str):
        self.repo_path = Path(repo_path)
        self.git_address = git_address
        self.logger = logging.getLogger()

    def _make_relative_path(self, file_path: str) -> str:
        """将绝对路径转换为相对于 repo_path 的路径"""
        try:
            return str(Path(file_path).relative_to(self.repo_path))
        except ValueError:
            return file_path

    # 前端文件后缀：codegraph 会把 React/Vue 浏览器侧路由也标成 route，需排除
    _FRONTEND_EXTENSIONS = {".tsx", ".jsx", ".vue", ".svelte"}

    @staticmethod
    def _is_controller_file(file_path: str) -> bool:
        """判断文件是否为后端 Controller/路由文件（需要入库）

        规则：
        - 前端文件（.tsx/.jsx/.vue/.svelte）排除：浏览器侧路由，非后端 API
        - Java/Kotlin 文件须文件名含 Controller（大小写不敏感），排除 *Client/*ServiceImpl/*Test 等
        - 其它后端语言（Python/Go 等）放行
        """
        suffix = Path(file_path).suffix.lower()
        if suffix in CodegraphApiDiscoverer._FRONTEND_EXTENSIONS:
            return False
        if suffix in (".java", ".kt"):
            return "controller" in Path(file_path).stem.lower()
        return True

    def discover(self) -> list[ApiEndpoint]:
        codegraph_db = os.path.join(str(self.repo_path), ".codegraph", "codegraph.db")
        if not os.path.exists(codegraph_db):
            self.logger.error(
                f"[Codegraph] codegraph.db 不存在: {codegraph_db}\n"
                f"请先运行: codegraph init {self.repo_path}"
            )
            return []

        apis = []
        conn = None
        skipped_non_controller = 0
        try:
            conn = sqlite3.connect(codegraph_db)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA query_only = ON")

            rows = conn.execute("""
                SELECT r.name AS route_name, r.file_path, r.start_line,
                       MIN(m.name) AS method_name
                FROM nodes r
                LEFT JOIN edges e ON e.source = r.id AND e.kind = 'references'
                LEFT JOIN nodes m ON e.target = m.id AND m.kind = 'method'
                WHERE r.kind = 'route'
                GROUP BY r.id
                ORDER BY r.file_path, r.start_line
            """).fetchall()

            for row in rows:
                parts = row["route_name"].split(" ", 1)
                if len(parts) != 2:
                    continue

                http_method_raw = parts[0].upper()
                api_path = normalize_api_path(parts[1])

                if http_method_raw == "ANY":
                    http_method_raw = "GET"
                http_method = normalize_http_method(http_method_raw)

                rel_path = self._make_relative_path(row["file_path"])
                method_name = row["method_name"] or ""

                if not self._is_controller_file(rel_path):
                    self.logger.debug(f"[跳过非Controller/前端] {rel_path}")
                    skipped_non_controller += 1
                    continue

                apis.append(
                    ApiEndpoint(
                        git_address=self.git_address,
                        file_path=rel_path,
                        api_path=api_path,
                        http_method=http_method,
                        api_method=method_name,
                    )
                )

        except Exception as e:
            self.logger.warning(f"[Codegraph] 查询 codegraph.db 失败: {e}")
        finally:
            if conn:
                conn.close()

        if skipped_non_controller:
            self.logger.info(
                f"[Codegraph] 跳过非Controller Java文件: {skipped_non_controller} 条"
            )
        self.logger.info(f"[Codegraph] 发现 {len(apis)} 个 API 路由")
        return apis


# ============ 数据库操作 ============


class ApiInventoryDB:
    """API 库存数据库（写入版：仅供发现阶段使用）"""

    def __init__(self, db_path: str = None):
        self.base_db = DatabaseManager(get_db_path(db_path), API_INVENTORY_SCHEMA)
        self.conn = self.base_db.conn
        migrate_inventory_schema(self.conn)

    @staticmethod
    def _is_better_path(new_path: str, existing_path: str) -> bool:
        """判断新路径是否比已存在路径更完整（参数名更具体）

        完整性规则：
        1. 有明确参数名（如 {id}）比空占位符（如 {}）更完整
        2. 参数更具体的路径优先

        Examples:
            - /api/users/{id} > /api/users/{}  (有明确参数名)
            - /api/users/{id}/detail > /api/users/{id}  (路径段更多)
        """
        if not existing_path or existing_path.strip() == "/":
            return True
        if not new_path:
            return False

        new_segments = new_path.strip("/").split("/")
        existing_segments = existing_path.strip("/").split("/")

        new_param_names = 0
        existing_param_names = 0

        for seg in new_segments:
            if seg.startswith("{") and seg.endswith("}"):
                content = seg[1:-1].strip()
                if content:
                    new_param_names += 1

        for seg in existing_segments:
            if seg.startswith("{") and seg.endswith("}"):
                content = seg[1:-1].strip()
                if content:
                    existing_param_names += 1

        if new_param_names > existing_param_names:
            return True
        elif new_param_names < existing_param_names:
            return False

        if len(new_segments) > len(existing_segments):
            return True
        elif len(new_segments) < len(existing_segments):
            return False

        return len(new_path) > len(existing_path)

    def batch_insert(self, items: list[dict]) -> dict:
        """批量插入 API 记录，智能处理重复数据

        插入前检查是否存在 (git_address, file_path, api_method, http_method) 相同的记录：
        - 如果不存在：直接插入
        - 如果存在且路径不同：比较路径完整性，更完整则更新，否则跳过
        - 如果存在且路径相同：跳过（忽略）

        Returns:
            {"inserted": int, "updated": int, "ignored": int, "failed": int, "failed_paths": [str]}
        """
        now = datetime.now().isoformat()
        inserted = 0
        updated = 0
        ignored = 0
        failed = 0
        failed_paths = []

        max_retries = 5
        base_delay = 0.1

        for item in items:
            for attempt in range(max_retries):
                try:
                    api_type_normalized = normalize_api_type(item.get("api_type"))

                    existing = self.conn.execute(
                        """
                        SELECT id, api_path FROM api_inventory
                        WHERE git_address = ? AND file_path = ? AND api_method = ? AND http_method = ?
                        AND deleted_at IS NULL
                        LIMIT 1
                    """,
                        (
                            item["git_address"],
                            item["file_path"],
                            item.get("api_method", ""),
                            item["http_method"],
                        ),
                    ).fetchone()

                    if existing is None:
                        self.conn.execute(
                            """
                            INSERT INTO api_inventory (
                                git_address, file_path, api_method, api_path, http_method, api_description, priority, api_type,
                                created_at, updated_at, status
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                            (
                                item["git_address"],
                                item["file_path"],
                                item.get("api_method", ""),
                                item["api_path"],
                                item["http_method"],
                                item.get("api_description", ""),
                                item.get("priority", "P3"),
                                api_type_normalized,
                                now,
                                now,
                                "pending",
                            ),
                        )
                        inserted += 1
                    else:
                        existing_id = existing["id"]
                        existing_path = existing["api_path"]
                        new_path = item["api_path"]

                        if new_path == existing_path:
                            ignored += 1
                        elif self._is_better_path(new_path, existing_path):
                            self.conn.execute(
                                """
                                UPDATE api_inventory
                                SET api_path = ?, updated_at = ?
                                WHERE id = ?
                            """,
                                (new_path, now, existing_id),
                            )
                            updated += 1
                            logger.info(
                                f"[路径更新] {item['file_path']}#{item.get('api_method', '')} "
                                f"{existing_path} -> {new_path}"
                            )
                        else:
                            ignored += 1
                            logger.debug(
                                f"[跳过旧路径] {item['file_path']}#{item.get('api_method', '')} "
                                f"保留: {existing_path}, 忽略: {new_path}"
                            )
                    break

                except sqlite3.OperationalError as e:
                    if "locked" in str(e) and attempt < max_retries - 1:
                        import time

                        delay = base_delay * (2**attempt)
                        time.sleep(delay)
                        continue
                    failed += 1
                    failed_paths.append(item.get("api_path", "unknown"))
                    logger.warning(
                        f"插入失败(重试耗尽): {item.get('api_path', 'unknown')}, 错误: {e}"
                    )
                    break
                except sqlite3.IntegrityError:
                    # 并发写入撞唯一约束（与 api_inventory_cli 共库时 TOCTOU），
                    # 语义为"已存在/重复"，计为 ignored 而非 failed（与 UPDATE 路径一致）
                    ignored += 1
                    logger.debug(f"[跳过重复] {item.get('api_path', 'unknown')} 已存在")
                    break
                except Exception as e:
                    failed += 1
                    failed_paths.append(item.get("api_path", "unknown"))
                    logger.warning(
                        f"插入失败: {item.get('api_path', 'unknown')}, 错误: {e}"
                    )
                    break

        self.conn.commit()
        return {
            "inserted": inserted,
            "updated": updated,
            "ignored": ignored,
            "failed": failed,
            "failed_paths": failed_paths,
        }

    def get_stats(self, git_address: str) -> dict:
        """获取指定 git 地址的统计信息"""
        total = self.conn.execute(
            "SELECT COUNT(*) as cnt FROM api_inventory WHERE deleted_at IS NULL AND git_address = ?",
            (git_address,),
        ).fetchone()["cnt"]

        pending = self.conn.execute(
            "SELECT COUNT(*) as cnt FROM api_inventory WHERE deleted_at IS NULL AND git_address = ? AND (api_description IS NULL OR api_description = '')",
            (git_address,),
        ).fetchone()["cnt"]

        processed = total - pending
        return {"total": total, "pending": pending, "processed": processed}

    def close(self):
        """关闭数据库连接"""
        self.base_db.close()


# ============ CLI 入口 ============


def main():
    """CLI 入口"""
    parser = argparse.ArgumentParser(
        description="API 发现工具（Agent 版本，基于 codegraph）"
    )
    parser.add_argument(
        "repo_path",
        nargs="?",
        default=os.getcwd(),
        help="仓库本地路径（默认：当前目录）",
    )
    parser.add_argument("--git", required=True, help="Git 仓库地址")
    parser.add_argument(
        "--output-file",
        help="输出 JSON 文件路径（必须使用 .code-audit-tmp/ 目录）",
    )
    parser.add_argument("--dry-run", action="store_true", help="只发现不存储")
    parser.add_argument("--verbose", action="store_true", help="详细输出")

    args = parser.parse_args()
    logger = setup_logging(args.verbose, "api_discovery")

    try:
        validate_output_file_path(args.output_file)
    except OutputPathError as e:
        print(json.dumps({"status": "error", "message": str(e)}, ensure_ascii=False))
        sys.exit(1)

    logger.info(f"数据库路径: {get_db_path()}")

    try:
        _run_discovery(args, logger)
    except Exception as e:
        logger.error(f"执行失败: {e}")
        print(
            json.dumps({"status": "error", "message": str(e)[:500]}, ensure_ascii=False)
        )
        sys.exit(1)


def _run_discovery(args, logger):
    """核心发现逻辑"""
    logger.info(f"开始扫描: {args.repo_path}")
    logger.info(f"Git 地址: {args.git}")

    discoverer = CodegraphApiDiscoverer(args.repo_path, args.git)
    apis = discoverer.discover()

    # 多路径方法去重：Spring 中一个方法可映射多个路由路径
    # 按 (file_path, api_method) 分组，保留主路径（段数最多的路径），其余丢弃并告警
    grouped = defaultdict(list)
    for api in apis:
        grouped[(api.file_path, api.api_method)].append(api)

    deduped = []
    for (file_path, api_method), group in grouped.items():
        if len(group) > 1 and api_method:
            paths = [a.api_path for a in group]
            primary = ApiEndpoint.select_primary_path(paths)
            chosen = next((a for a in group if a.api_path == primary), group[0])
            logger.warning(
                f"[多路径方法] {file_path}#{api_method} 有 {len(group)} 条路径 "
                f"{paths}，保留主路径: {chosen.api_path}"
            )
            deduped.append(chosen)
        else:
            deduped.extend(group)
    apis = deduped

    # 第二遍：合并同 (file_path, api_method, api_path) 不同 http_method 的条目
    # 处理 @RequestMapping 未指定 method 时产生 GET + OTHER 重复的场景
    # 注意：分组键必须含 api_method，否则会误合并 RESTful 的 GET/POST 同路径不同方法
    path_groups = defaultdict(list)
    no_method_apis = []  # api_method 未解析出的条目不参与去重，直接保留
    for api in apis:
        if not api.api_method:
            no_method_apis.append(api)
            continue
        path_groups[(api.file_path, api.api_method, api.api_path)].append(api)

    final = list(no_method_apis)
    collapsed = 0
    for (fp, am, path), group in path_groups.items():
        if len(group) > 1:
            methods = [a.http_method for a in group]
            chosen = min(
                group, key=lambda a: HTTP_METHOD_PRECEDENCE.get(a.http_method, 99)
            )
            logger.info(
                f"[HTTP方法去重] {fp}#{am} {path} 多个HTTP方法 {methods}，保留: {chosen.http_method}"
            )
            final.append(chosen)
            collapsed += len(group) - 1
        else:
            final.extend(group)
    if collapsed:
        logger.info(f"[HTTP方法去重] 共合并 {collapsed} 个重复条目")
    apis = final

    if not apis:
        codegraph_db = os.path.join(args.repo_path, ".codegraph", "codegraph.db")
        if not os.path.exists(codegraph_db):
            print(
                json.dumps(
                    {
                        "status": "error",
                        "message": f"codegraph 索引不存在，请先运行: codegraph init {args.repo_path}",
                        "codegraph_db": codegraph_db,
                    },
                    ensure_ascii=False,
                )
            )
            sys.exit(1)
        logger.warning(
            "codegraph 索引存在但未发现 route 节点，项目可能使用不支持的路由框架"
        )

    if args.output_file:
        output_dir = os.path.dirname(args.output_file)
        if output_dir:
            os.makedirs(output_dir, exist_ok=True)
        with open(args.output_file, "w", encoding="utf-8") as f:
            json.dump([api.to_dict() for api in apis], f, indent=2, ensure_ascii=False)
        logger.info(f"结果已保存到: {args.output_file}")

    if not args.dry_run:
        db = ApiInventoryDB()

        result = db.batch_insert([api.to_dict() for api in apis])
        stats = db.get_stats(args.git)

        db.close()

        logger.info("=" * 50)
        logger.info("初始化完成")
        logger.info(f"  数据库已有记录: {stats['total']} 条")
        logger.info(
            f"  本次新增: {result['inserted']} 条, 路径更新: {result['updated']} 条, 跳过重复: {result['ignored']} 条, 失败: {result['failed']} 条"
        )
        logger.info(f"  待处理: {stats['pending']} 条")
        logger.info("=" * 50)
        if stats["pending"] > 0:
            logger.info("下一步: 执行 api-inventory update 模式处理待处理 API")
        else:
            logger.info("状态: 全部已处理，无需后续操作")

        print(
            json.dumps(
                {
                    "status": "success" if result["failed"] == 0 else "partial",
                    "discovered": len(apis),
                    "inserted": result["inserted"],
                    "updated": result["updated"],
                    "ignored": result["ignored"],
                    "failed": result["failed"],
                    "failed_paths": result["failed_paths"],
                    "db_total": stats["total"],
                    "db_pending": stats["pending"],
                },
                ensure_ascii=False,
            )
        )
    else:
        logger.info(f"Dry run: 发现 {len(apis)} 个 API (未存储)")
        print(json.dumps([api.to_dict() for api in apis], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
