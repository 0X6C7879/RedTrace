#!/usr/bin/env python3
"""API Inventory CLI - 独立版本（无外部依赖）

所属模式: api-inventory
用途: 管理已发现的 API 端点（查询/更新/插入/删除/统计）
数据库: db/api_inventory.db (API_INVENTORY_DB_PATH)
命令: query / update / insert / stats / delete
"""

import argparse
import json
import logging
import os
import sqlite3
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _shared import (
    API_INVENTORY_SCHEMA,
    VALID_PRIORITIES,
    DatabaseManager,
    OutputPathError,
    get_db_path,
    migrate_inventory_schema,
    normalize_api_type,
    normalize_http_method,
    validate_output_file_path,
)

logger = logging.getLogger(__name__)


# ============ 数据库操作类 ============


class ApiInventoryDB:
    """API 库存数据库操作类（完整 CRUD）"""

    def __init__(self, db_path: str = None):
        self.base_db = DatabaseManager(
            get_db_path(db_path), API_INVENTORY_SCHEMA, check_integrity=True
        )
        self.conn = self.base_db.conn
        self._migrate_schema()

    def _migrate_schema(self):
        """补齐历史缺失列，条件创建唯一索引，迁移旧格式 api_type（裸字符串 → JSON 数组），迁移 NULL → unclassified"""
        migrate_inventory_schema(self.conn)

        try:
            rows = self.conn.execute(
                "SELECT id, api_type FROM api_inventory WHERE deleted_at IS NULL AND api_type IS NOT NULL"
            ).fetchall()
            migrated = 0
            for row in rows:
                old_val = row["api_type"]
                if old_val.startswith("["):
                    try:
                        parsed = json.loads(old_val)
                        if isinstance(parsed, list):
                            continue
                    except json.JSONDecodeError:
                        old_val = old_val.lstrip("[")
                if old_val.strip():
                    new_val = json.dumps([old_val.lower()])
                    self.conn.execute(
                        "UPDATE api_inventory SET api_type = ? WHERE id = ?",
                        (new_val, row["id"]),
                    )
                    migrated += 1
            if migrated > 0:
                self.conn.commit()
                logger.info(f"已迁移 {migrated} 条旧格式 api_type 为 JSON 数组")
        except Exception as e:
            logger.debug(f"api_type 迁移跳过: {e}")

        try:
            unclassified_val = json.dumps(["unclassified"])
            result = self.conn.execute(
                "UPDATE api_inventory SET api_type = ? "
                "WHERE deleted_at IS NULL AND api_type IS NULL AND status IN ('completed', 'pending')",
                (unclassified_val,),
            )
            migrated_null = result.rowcount
            if migrated_null > 0:
                self.conn.commit()
                logger.info(
                    f'已迁移 {migrated_null} 条 api_type NULL 为 ["unclassified"]'
                )
        except Exception as e:
            logger.debug(f"api_type NULL→unclassified 迁移跳过: {e}")

    def query_by_git(
        self,
        git_address: str = None,
        file_path: str = None,
        file_path_exact: str = None,
        http_method: str = None,
        priority: str = None,
        status: str = None,
        api_type: str = None,
        ids: list = None,
    ) -> list:
        """根据条件查询记录，支持可选筛选"""
        sql = """
            SELECT id, file_path, api_method, api_path, http_method, api_description, priority, api_type
            FROM api_inventory
            WHERE deleted_at IS NULL
        """
        params = []

        if ids:
            placeholders = ",".join("?" * len(ids))
            sql += f" AND id IN ({placeholders})"
            params.extend(ids)
        if git_address:
            sql += " AND git_address = ?"
            params.append(git_address)
        if file_path:
            sql += " AND file_path LIKE ?"
            params.append(f"%{file_path}%")
        if file_path_exact:
            sql += " AND file_path = ?"
            params.append(file_path_exact)
        if http_method:
            sql += " AND http_method = ?"
            params.append(http_method.upper())
        if priority:
            sql += " AND priority = ?"
            params.append(priority.upper())
        if api_type:
            sql += " AND api_type LIKE ?"
            params.append(f'%"{api_type.lower()}"%')
        if status == "processed":
            sql += " AND api_description IS NOT NULL AND api_description != ''"
        elif status == "unprocessed":
            sql += " AND (api_description IS NULL OR api_description = '')"

        sql += " ORDER BY id"
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

    def query_summary(self, git_address: str = None, status: str = None) -> list:
        """按 file_path 分组统计 API 数量，返回每个文件的 total/processed/unprocessed 计数

        status 参数（可选）：
          'unprocessed' → 只返回 unprocessed > 0 的文件行
          'processed'   → 只返回全部已处理（unprocessed = 0）的文件行
          None / 'all'  → 返回所有文件行
        """
        sql = """
            SELECT
                file_path,
                COUNT(*) AS total,
                SUM(CASE WHEN api_description IS NOT NULL AND api_description != '' THEN 1 ELSE 0 END) AS processed,
                SUM(CASE WHEN api_description IS NULL OR api_description = '' THEN 1 ELSE 0 END) AS unprocessed
            FROM api_inventory
            WHERE deleted_at IS NULL
        """
        params = []
        if git_address:
            sql += " AND git_address = ?"
            params.append(git_address)
        sql += " GROUP BY file_path"
        if status == "unprocessed":
            sql += " HAVING unprocessed > 0"
        elif status == "processed":
            sql += " HAVING unprocessed = 0"
        sql += " ORDER BY file_path"
        rows = self.conn.execute(sql, params).fetchall()
        return [dict(r) for r in rows]

    def batch_update(self, items: list) -> dict:
        """批量更新，所有字段可选：api_description、priority、api_type、api_path。至少需要一个更新字段。（支持重试）

        Returns:
            {"updated": int, "skipped": int, "failed": int, "failed_ids": [int]}
        """
        updated = 0
        skipped = 0
        failed = 0
        failed_ids = []
        now = datetime.now().isoformat()

        max_retries = 5
        base_delay = 0.1

        for item in items:
            if not item.get("id"):
                skipped += 1
                continue
            set_clauses = ["updated_at = ?"]
            params = [now]

            if "api_description" in item:
                set_clauses.append("api_description = ?")
                params.append(item["api_description"])

            if "priority" in item:
                priority = item["priority"].upper()
                if priority not in VALID_PRIORITIES:
                    skipped += 1
                    continue
                set_clauses.append("priority = ?")
                params.append(priority)

            if "api_type" in item:
                api_type_normalized = normalize_api_type(item.get("api_type"))
                set_clauses.append("api_type = ?")
                params.append(api_type_normalized)

            if item.get("api_path"):
                set_clauses.append("api_path = ?")
                params.append(item["api_path"])

            if len(set_clauses) <= 1:
                skipped += 1
                continue

            params.append(item["id"])
            sql = f"UPDATE api_inventory SET {', '.join(set_clauses)} WHERE id = ?"

            success = False
            for attempt in range(max_retries):
                try:
                    self.conn.execute(sql, params)
                    success = True
                    break
                except sqlite3.IntegrityError as e:
                    failed += 1
                    failed_ids.append(item.get("id"))
                    logger.warning(f"更新失败(唯一约束冲突) id={item.get('id')}: {e}")
                    break
                except sqlite3.OperationalError as e:
                    if "locked" in str(e) and attempt < max_retries - 1:
                        import time

                        delay = base_delay * (2**attempt)
                        time.sleep(delay)
                        continue
                    failed += 1
                    failed_ids.append(item.get("id"))
                    logger.warning(f"更新失败(重试耗尽) id={item.get('id')}: {e}")
                    break
                except Exception as e:
                    failed += 1
                    failed_ids.append(item.get("id"))
                    logger.warning(f"更新失败 id={item.get('id')}: {e}")
                    break
            if success:
                updated += 1

        self.conn.commit()
        return {
            "updated": updated,
            "skipped": skipped,
            "failed": failed,
            "failed_ids": failed_ids,
        }

    def batch_insert(self, records: list) -> dict:
        """批量插入记录（支持重试）

        Returns:
            {"inserted": int, "ignored": int, "failed": int, "failed_paths": [str]}
        """
        now = datetime.now().isoformat()
        inserted = 0
        ignored = 0
        failed = 0
        failed_paths = []

        max_retries = 5
        base_delay = 0.1

        for record in records:
            for attempt in range(max_retries):
                try:
                    record["http_method"] = normalize_http_method(
                        record.get("http_method", "")
                    )
                    api_type_normalized = normalize_api_type(record.get("api_type"))
                    priority_val = record.get("priority", "P3")
                    if priority_val.upper() not in VALID_PRIORITIES:
                        priority_val = "P3"
                    cursor = self.conn.execute(
                        """
                        INSERT OR IGNORE INTO api_inventory (
                            git_address, file_path, api_method, api_path, http_method, priority, api_type,
                            api_description, created_at, updated_at, status
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                        (
                            record["git_address"],
                            record["file_path"],
                            record.get("api_method", ""),
                            record["api_path"],
                            record["http_method"],
                            priority_val,
                            api_type_normalized,
                            record.get("api_description", ""),
                            now,
                            now,
                            "pending",
                        ),
                    )
                    if cursor.rowcount > 0:
                        inserted += 1
                    else:
                        ignored += 1
                    break
                except sqlite3.OperationalError as e:
                    if "locked" in str(e) and attempt < max_retries - 1:
                        import time

                        delay = base_delay * (2**attempt)
                        time.sleep(delay)
                        continue
                    failed += 1
                    failed_paths.append(record.get("api_path", "unknown"))
                    logger.warning(
                        f"插入失败(重试耗尽): {record.get('api_path', 'unknown')}, 错误: {e}"
                    )
                    break
                except Exception as e:
                    failed += 1
                    failed_paths.append(record.get("api_path", "unknown"))
                    logger.warning(
                        f"插入失败: {record.get('api_path', 'unknown')}, 错误: {e}"
                    )
                    break

        self.conn.commit()
        return {
            "inserted": inserted,
            "ignored": ignored,
            "failed": failed,
            "failed_paths": failed_paths,
        }

    def query_stats(self, git_address: str = None, include_files: bool = False) -> dict:
        """返回完整统计信息，用于汇总报告

        参数：
          git_address: 可选，筛选指定仓库
          include_files: 是否包含 by_file 分组统计

        返回：
          total, processed, unprocessed,
          by_priority: {P0,P1,P2,P3},
          by_http_method: {GET,POST,RPC,...},
          by_api_type: {toc,tob,inner,operate,admin,test,unclassified,untyped},
          by_file: [...]（仅当 include_files=True）
        """
        params = []
        where = "WHERE deleted_at IS NULL"
        if git_address:
            where += " AND git_address = ?"
            params.append(git_address)

        base = f"FROM api_inventory {where}"

        total = self.conn.execute(f"SELECT COUNT(*) AS cnt {base}", params).fetchone()[
            "cnt"
        ]
        processed = self.conn.execute(
            f"SELECT COUNT(*) AS cnt {base} AND api_description IS NOT NULL AND api_description != ''",
            params,
        ).fetchone()["cnt"]

        by_priority = {}
        for p in ("P0", "P1", "P2", "P3"):
            cnt = self.conn.execute(
                f"SELECT COUNT(*) AS cnt {base} AND priority = ?", params + [p]
            ).fetchone()["cnt"]
            by_priority[p] = cnt

        by_http_method = {}
        rows = self.conn.execute(
            f"SELECT http_method, COUNT(*) AS cnt {base} GROUP BY http_method", params
        ).fetchall()
        for r in rows:
            by_http_method[r["http_method"] or "OTHER"] = r["cnt"]

        by_api_type = dict.fromkeys(
            ("toc", "tob", "inner", "operate", "admin", "test", "unclassified"), 0
        )
        untyped = 0
        api_type_rows = self.conn.execute(f"SELECT api_type {base}", params).fetchall()
        for r in api_type_rows:
            val = r["api_type"]
            if not val:
                untyped += 1
                continue
            try:
                types = json.loads(val)
                if isinstance(types, list) and types:
                    for t in types:
                        if t in by_api_type:
                            by_api_type[t] += 1
                else:
                    untyped += 1
            except (json.JSONDecodeError, TypeError):
                untyped += 1
        by_api_type["untyped"] = untyped

        result = {
            "total": total,
            "processed": processed,
            "unprocessed": total - processed,
            "by_priority": by_priority,
            "by_http_method": by_http_method,
            "by_api_type": by_api_type,
        }

        if include_files:
            file_rows = self.conn.execute(
                f"""
                SELECT
                    file_path,
                    COUNT(*) AS total,
                    SUM(CASE WHEN api_description IS NOT NULL AND api_description != '' THEN 1 ELSE 0 END) AS processed,
                    SUM(CASE WHEN api_description IS NULL OR api_description = '' THEN 1 ELSE 0 END) AS unprocessed
                {base}
                GROUP BY file_path
                ORDER BY file_path
            """,
                params,
            ).fetchall()
            result["by_file"] = [dict(r) for r in file_rows]

        return result

    def find_duplicates(self, git_address: str = None) -> dict:
        """分析重复情况，分类输出

        返回：
        {
            'true_duplicates': [...],     # api_path + http_method 都相同（真正重复）
            'multi_methods': [...],       # api_path 相同但 http_method 不同（正常 RESTful）
            'path_variants': [...],       # api_method 相同但 api_path 不同（路径变体）
            'to_delete_ids': [...]        # 建议删除的ID列表（仅 true_duplicates 的重复项）
        }
        """
        git_filter = "AND git_address = ?" if git_address else ""
        git_params = [git_address] if git_address else []

        result = {
            "true_duplicates": [],
            "multi_methods": [],
            "path_variants": [],
            "to_delete_ids": [],
        }

        # 1. 真重复：api_path + http_method 完全相同
        sql = f"""
            SELECT api_path, http_method, GROUP_CONCAT(id) as ids, COUNT(*) as cnt
            FROM api_inventory
            WHERE deleted_at IS NULL {git_filter}
            GROUP BY api_path, http_method
            HAVING COUNT(*) > 1
        """
        rows = self.conn.execute(sql, git_params).fetchall()
        for row in rows:
            ids = sorted([int(x) for x in row["ids"].split(",")])
            # 保留有描述的，否则保留最新的（id 最大的）
            keep_id = self._select_best_record(ids)
            delete_ids = [i for i in ids if i != keep_id]
            result["true_duplicates"].append(
                {
                    "api_path": row["api_path"],
                    "http_method": row["http_method"],
                    "ids": ids,
                    "keep_id": keep_id,
                    "delete_ids": delete_ids,
                }
            )
            result["to_delete_ids"].extend(delete_ids)

        # 2. 多方法接口：api_path 相同但 http_method 不同（正常，不删除）
        sql = f"""
            SELECT api_path, GROUP_CONCAT(DISTINCT http_method) as methods, COUNT(*) as cnt
            FROM api_inventory
            WHERE deleted_at IS NULL {git_filter}
            GROUP BY api_path
            HAVING COUNT(DISTINCT http_method) > 1
        """
        rows = self.conn.execute(sql, git_params).fetchall()
        for row in rows:
            result["multi_methods"].append(
                {
                    "api_path": row["api_path"],
                    "http_methods": sorted(row["methods"].split(",")),
                    "count": row["cnt"],
                }
            )

        # 2.5 @RequestMapping 去重：同 (file_path, api_method, api_path) 不同 http_method
        # 与 2 的区别：2 是全局按 api_path 聚合（可能是不同 Controller 的同名路径），
        # 这里按 (file_path, api_method, api_path) 精确匹配，能确认是同一个 Java 方法产生的重复
        # 注：依赖 git_address 限定范围；CLI query 子命令 --git required=True 必传
        if git_address:
            mapping_sql = f"""
                SELECT file_path, api_method, api_path,
                       GROUP_CONCAT(DISTINCT http_method) as methods,
                       GROUP_CONCAT(id) as ids, COUNT(*) as cnt
                FROM api_inventory
                WHERE deleted_at IS NULL AND api_method != '' AND api_method IS NOT NULL
                {git_filter}
                GROUP BY git_address, file_path, api_method, api_path
                HAVING COUNT(DISTINCT http_method) > 1
            """
            mapping_rows = self.conn.execute(mapping_sql, git_params).fetchall()
            for row in mapping_rows:
                ids = sorted([int(x) for x in row["ids"].split(",")])
                keep_id = self._select_best_record(ids)
                delete_ids = [i for i in ids if i != keep_id]
                result["multi_methods"].append(
                    {
                        "api_path": row["api_path"],
                        "http_methods": sorted(row["methods"].split(",")),
                        "file_path": row["file_path"],
                        "api_method": row["api_method"],
                        "is_request_mapping_dedup": True,
                        "keep_id": keep_id,
                        "delete_ids": delete_ids,
                    }
                )
                result["to_delete_ids"].extend(delete_ids)

        # 3. 同方法多路径：file_path + api_method 相同但 api_path 不同
        # 使用 '|||' 分隔符：下方 paths/methods/ids 按位置对齐索引，
        # 默认逗号分隔在 api_path 含逗号时会错位导致删错记录
        _SEP = "|||"
        sql = f"""
            SELECT file_path, api_method,
                   GROUP_CONCAT(api_path, '{_SEP}') as paths,
                   GROUP_CONCAT(http_method, '{_SEP}') as methods,
                   GROUP_CONCAT(id, '{_SEP}') as ids,
                   COUNT(DISTINCT api_path) as path_cnt
            FROM api_inventory
            WHERE deleted_at IS NULL {git_filter}
            AND api_method != '' AND api_method IS NOT NULL
            GROUP BY file_path, api_method
            HAVING COUNT(DISTINCT api_path) > 1
        """
        rows = self.conn.execute(sql, git_params).fetchall()
        for row in rows:
            paths = row["paths"].split(_SEP)
            methods = row["methods"].split(_SEP)
            ids = [int(x) for x in row["ids"].split(_SEP)]

            # 按路径完整性分类
            complete_records = []
            incomplete_records = []
            for i, path in enumerate(paths):
                record_id = ids[i]
                # 完整路径特征：有明确参数名或更长路径
                has_explicit_param = (
                    "{" in path
                    and "}" in path
                    and path.replace("{", "").replace("}", "").strip() != path
                )
                is_longer = len(path.strip("/").split("/")) > 2
                if has_explicit_param or is_longer:
                    complete_records.append(
                        {"id": record_id, "path": path, "method": methods[i]}
                    )
                else:
                    incomplete_records.append(
                        {"id": record_id, "path": path, "method": methods[i]}
                    )

            result["path_variants"].append(
                {
                    "file_path": row["file_path"],
                    "api_method": row["api_method"],
                    "paths": paths,
                    "complete_ids": [r["id"] for r in complete_records],
                    "incomplete_ids": [r["id"] for r in incomplete_records],
                }
            )

        return result

    def _select_best_record(self, ids: list) -> int:
        """从多个重复记录中选择最佳保留记录

        优先级：有 api_description > 最新（id 最大）
        """
        if len(ids) == 1:
            return ids[0]

        placeholders = ",".join("?" * len(ids))
        rows = self.conn.execute(
            f"""
            SELECT id, api_description, created_at
            FROM api_inventory
            WHERE id IN ({placeholders})
            ORDER BY
                CASE WHEN api_description IS NOT NULL AND api_description != '' THEN 0 ELSE 1 END,
                id DESC
        """,
            ids,
        ).fetchall()

        # 查询为空（ID 已被删除）→ 回退到首个 ID，避免 IndexError
        return rows[0]["id"] if rows else ids[0]

    def delete_by_conditions(
        self,
        ids: list = None,
        git_address: str = None,
        file_path: str = None,
        file_pattern: str = None,
        http_method: str = None,
        api_method: str = None,
        dry_run: bool = False,
    ) -> dict:
        """软删除 API 记录（设置 deleted_at 时间戳）

        Args:
            git_address: Git 地址（必需）
            file_path: 精确匹配文件路径
            file_pattern: 文件路径模糊匹配（如 %/reg/%）
            http_method: HTTP 方法
            api_method: API 方法名
            dry_run: 仅预览不删除

        Returns:
            {'matched': 匹配数量, 'deleted': 删除数量, 'ids': 删除的ID列表}
        """
        now = datetime.now().isoformat()
        sql = "UPDATE api_inventory SET deleted_at = ?, updated_at = ? WHERE deleted_at IS NULL"
        params = [now, now]

        if ids:
            placeholders = ",".join("?" * len(ids))
            sql += f" AND id IN ({placeholders})"
            params.extend(ids)

        if git_address:
            sql += " AND git_address = ?"
            params.append(git_address)

        if file_path:
            sql += " AND file_path = ?"
            params.append(file_path)

        if file_pattern:
            sql += " AND file_path LIKE ?"
            params.append(file_pattern)

        if http_method:
            sql += " AND http_method = ?"
            params.append(http_method.upper())

        if api_method:
            sql += " AND api_method = ?"
            params.append(api_method)

        preview_sql = sql.replace(
            "UPDATE api_inventory SET deleted_at = ?, updated_at = ? WHERE deleted_at IS NULL",
            "SELECT id, file_path, api_path, http_method, api_method FROM api_inventory WHERE deleted_at IS NULL",
        )
        preview_params = params[2:]
        rows = self.conn.execute(preview_sql, preview_params).fetchall()
        matched = len(rows)
        matched_ids = [r["id"] for r in rows]

        deleted = 0
        if not dry_run and matched_ids:
            cursor = self.conn.execute(sql, params)
            deleted = cursor.rowcount
            self.conn.commit()

        return {
            "matched": matched,
            "deleted": deleted,
            "ids": matched_ids,
            "preview": [dict(r) for r in rows],
        }

    def close(self):
        """关闭数据库连接"""
        self.base_db.close()


# ============ 主函数 ============


def main():
    parser = argparse.ArgumentParser(description="API Inventory CLI")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # query 子命令
    query_parser = subparsers.add_parser("query", help="查询 API 记录")
    query_parser.add_argument("--ids", help="按 ID 查询，逗号分隔（如 1,2,3）")
    query_parser.add_argument(
        "--git", required=True, help="Git 地址（必填，限制查询范围）"
    )
    query_parser.add_argument("--file", help="文件路径模糊匹配")
    query_parser.add_argument("--file-exact", help="文件路径精确匹配")
    query_parser.add_argument(
        "--method", help="HTTP 方法 (GET/POST/PUT/DELETE/PATCH/RPC/OTHER)"
    )
    query_parser.add_argument("--priority", help="优先级 (P0/P1/P2/P3)")
    query_parser.add_argument(
        "--status",
        choices=["processed", "unprocessed", "all"],
        default="all",
        help="筛选状态: processed(已处理)/unprocessed(未处理)/all(全部)",
    )
    query_parser.add_argument(
        "--api-type", help="接口类型筛选 (inner/operate/admin/toc/tob/test)"
    )
    query_parser.add_argument(
        "--output-file",
        help="输出结果到 JSON 文件（推荐，必须使用 .code-audit-tmp/ 目录）",
    )
    query_parser.add_argument(
        "--summary",
        action="store_true",
        help="按 file_path 分组统计，返回每个文件的 total/processed/unprocessed 计数",
    )
    query_parser.add_argument(
        "--find-duplicates",
        action="store_true",
        help="查找重复记录（同一 file_path+api_method 有多条记录），返回每组重复信息及建议保留/删除的 id",
    )

    # update 子命令
    update_parser = subparsers.add_parser("update", help="批量更新记录")
    update_parser.add_argument(
        "--git", required=True, help="Git 地址（必填，限制更新范围）"
    )
    update_group = update_parser.add_mutually_exclusive_group(required=True)
    update_group.add_argument("--json", help="JSON 数组字符串（少量数据可用）")
    update_group.add_argument("--file", help="JSON 文件路径（推荐，适合批量数据）")

    # insert 子命令
    insert_parser = subparsers.add_parser("insert", help="批量插入记录")
    insert_parser.add_argument(
        "--git", required=True, help="Git 地址（必填，校验数据归属）"
    )
    insert_group = insert_parser.add_mutually_exclusive_group(required=True)
    insert_group.add_argument("--json", help="JSON 数组字符串（少量数据可用）")
    insert_group.add_argument("--file", help="JSON 文件路径（推荐，适合批量数据）")

    # stats 子命令
    stats_parser = subparsers.add_parser(
        "stats", help="返回完整统计信息（用于汇总报告）"
    )
    stats_parser.add_argument(
        "--git", required=True, help="Git 地址（必填，限制统计范围）"
    )
    stats_parser.add_argument(
        "--include-files",
        action="store_true",
        help="包含 by_file 分组统计（合并 --summary 功能）",
    )
    stats_parser.add_argument(
        "--output-file",
        help="输出结果到 JSON 文件（必须使用 .code-audit-tmp/ 目录）",
    )

    # delete 子命令
    delete_parser = subparsers.add_parser("delete", help="删除 API 记录")
    delete_parser.add_argument(
        "--ids", help="按 ID 删除，逗号分隔（如 1,2,3），必须同时指定 --git"
    )
    delete_parser.add_argument(
        "--git", required=True, help="Git 地址（必填，限制删除范围）"
    )
    delete_parser.add_argument("--file", help="精确匹配文件路径")
    delete_parser.add_argument("--file-pattern", help="文件路径模糊匹配（如 %/reg/%）")
    delete_parser.add_argument(
        "--method", help="HTTP 方法 (GET/POST/PUT/DELETE/PATCH/RPC/OTHER)"
    )
    delete_parser.add_argument("--api-method", help="API 方法名")
    delete_parser.add_argument("--dry-run", action="store_true", help="预览不删除")
    delete_parser.add_argument(
        "--confirm", action="store_true", help="确认删除（必需）"
    )

    args = parser.parse_args()

    try:
        validate_output_file_path(getattr(args, "output_file", None))
    except OutputPathError as e:
        print(json.dumps({"status": "error", "message": str(e)}, ensure_ascii=False))
        sys.exit(1)

    db = ApiInventoryDB()

    try:

        def _load_json_data(args):
            """从 --json 或 --file 加载 JSON 数据"""
            if args.file:
                try:
                    with open(args.file, encoding="utf-8") as f:
                        return json.load(f)
                except FileNotFoundError:
                    print(
                        json.dumps(
                            {"status": "error", "message": f"文件不存在: {args.file}"},
                            ensure_ascii=False,
                        )
                    )
                    sys.exit(1)
                except json.JSONDecodeError as e:
                    print(
                        json.dumps(
                            {"status": "error", "message": f"JSON 格式错误: {e}"},
                            ensure_ascii=False,
                        )
                    )
                    sys.exit(1)
            else:
                try:
                    return json.loads(args.json)
                except json.JSONDecodeError as e:
                    print(
                        json.dumps(
                            {"status": "error", "message": f"JSON 格式错误: {e}"},
                            ensure_ascii=False,
                        )
                    )
                    sys.exit(1)

        if args.command == "query":
            ids = [int(x.strip()) for x in args.ids.split(",")] if args.ids else None
            if getattr(args, "find_duplicates", False):
                results = db.find_duplicates(args.git)
                output = json.dumps(results, ensure_ascii=False, indent=2)
                if args.output_file:
                    with open(args.output_file, "w", encoding="utf-8") as f:
                        f.write(output + "\n")
                    print(
                        json.dumps(
                            {
                                "status": "success",
                                "duplicate_groups": len(
                                    results.get("true_duplicates", [])
                                ),
                                "to_delete_ids": len(results.get("to_delete_ids", [])),
                                "output_file": args.output_file,
                            },
                            ensure_ascii=False,
                        )
                    )
                else:
                    print(output)
            elif getattr(args, "summary", False):
                if (
                    ids
                    or args.file
                    or getattr(args, "file_exact", None)
                    or args.method
                    or args.priority
                    or getattr(args, "api_type", None)
                ):
                    print(
                        json.dumps(
                            {
                                "status": "error",
                                "message": "--summary 不可与 --ids/--file/--file-exact/--method/--priority/--api-type 同时使用",
                            },
                            ensure_ascii=False,
                        )
                    )
                    sys.exit(1)
                results = db.query_summary(
                    args.git, args.status if args.status != "all" else None
                )
                output = json.dumps(results, ensure_ascii=False, indent=2)
                if args.output_file:
                    with open(args.output_file, "w", encoding="utf-8") as f:
                        f.write(output + "\n")
                    print(
                        json.dumps(
                            {
                                "status": "success",
                                "file_count": len(results),
                                "output_file": args.output_file,
                            },
                            ensure_ascii=False,
                        )
                    )
                else:
                    print(output)
            else:
                results = db.query_by_git(
                    args.git,
                    args.file,
                    getattr(args, "file_exact", None),
                    args.method,
                    args.priority,
                    args.status,
                    getattr(args, "api_type", None),
                    ids,
                )
                output = json.dumps(results, ensure_ascii=False, indent=2)
                if args.output_file:
                    with open(args.output_file, "w", encoding="utf-8") as f:
                        f.write(output + "\n")
                    print(
                        json.dumps(
                            {
                                "status": "success",
                                "count": len(results),
                                "output_file": args.output_file,
                            },
                            ensure_ascii=False,
                        )
                    )
                else:
                    print(output)

        elif args.command == "update":
            items = _load_json_data(args)
            item_ids = [item.get("id") for item in items if item.get("id")]
            if item_ids:
                id_placeholders = ",".join("?" * len(item_ids))
                valid_ids = db.conn.execute(
                    f"SELECT id FROM api_inventory WHERE deleted_at IS NULL AND id IN ({id_placeholders}) AND git_address = ?",
                    item_ids + [args.git],
                ).fetchall()
                valid_id_set = {r["id"] for r in valid_ids}
                invalid_items = [
                    item
                    for item in items
                    if item.get("id") and item["id"] not in valid_id_set
                ]
                if invalid_items:
                    print(
                        json.dumps(
                            {
                                "status": "error",
                                "message": f"以下记录 ID 不属于 git={args.git}，禁止更新: {[i['id'] for i in invalid_items]}",
                            },
                            ensure_ascii=False,
                        )
                    )
                    return
            result = db.batch_update(items)
            print(
                json.dumps(
                    {
                        "status": "success" if result["failed"] == 0 else "partial",
                        "updated": result["updated"],
                        "skipped": result["skipped"],
                        "failed": result["failed"],
                        "failed_ids": result["failed_ids"],
                    },
                    ensure_ascii=False,
                )
            )

        elif args.command == "insert":
            records = _load_json_data(args)
            for record in records:
                record["git_address"] = args.git
            result = db.batch_insert(records)
            print(
                json.dumps(
                    {
                        "status": "success" if result["failed"] == 0 else "partial",
                        "inserted": result["inserted"],
                        "ignored": result["ignored"],
                        "failed": result["failed"],
                        "failed_paths": result["failed_paths"],
                    },
                    ensure_ascii=False,
                )
            )

        elif args.command == "stats":
            include_files = getattr(args, "include_files", False)
            result = db.query_stats(args.git, include_files=include_files)
            output = json.dumps(result, ensure_ascii=False, indent=2)
            if args.output_file:
                with open(args.output_file, "w", encoding="utf-8") as f:
                    f.write(output + "\n")
                print(
                    json.dumps(
                        {"status": "success", "output_file": args.output_file},
                        ensure_ascii=False,
                    )
                )
            else:
                print(output)

        elif args.command == "delete":
            if not args.confirm and not args.dry_run:
                print(
                    json.dumps(
                        {
                            "status": "error",
                            "message": "删除操作需要 --confirm 或 --dry-run",
                        },
                        ensure_ascii=False,
                    )
                )
                return

            ids = [int(x.strip()) for x in args.ids.split(",")] if args.ids else None

            if ids:
                id_placeholders = ",".join("?" * len(ids))
                valid_ids = db.conn.execute(
                    f"SELECT id FROM api_inventory WHERE deleted_at IS NULL AND id IN ({id_placeholders}) AND git_address = ?",
                    ids + [args.git],
                ).fetchall()
                valid_id_set = {r["id"] for r in valid_ids}
                invalid_ids = [i for i in ids if i not in valid_id_set]
                if invalid_ids:
                    print(
                        json.dumps(
                            {
                                "status": "error",
                                "message": f"以下 ID 不属于 git={args.git}，禁止删除: {invalid_ids}",
                            },
                            ensure_ascii=False,
                        )
                    )
                    return

            result = db.delete_by_conditions(
                ids=ids,
                git_address=args.git,
                file_path=args.file,
                file_pattern=args.file_pattern,
                http_method=args.method,
                api_method=args.api_method,
                dry_run=args.dry_run,
            )

            print(
                json.dumps(
                    {
                        "status": "success",
                        "matched": result["matched"],
                        "deleted": result["deleted"] if not args.dry_run else 0,
                        "dry_run": args.dry_run,
                        "preview": result["preview"][:10],
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
    except Exception as e:
        logger.error(f"执行失败: {e}")
        print(
            json.dumps({"status": "error", "message": str(e)[:500]}, ensure_ascii=False)
        )
    finally:
        db.close()


if __name__ == "__main__":
    main()
