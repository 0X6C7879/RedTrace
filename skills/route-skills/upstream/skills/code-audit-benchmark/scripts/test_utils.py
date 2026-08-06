#!/usr/bin/env python3
"""utils.py 单元测试"""

import os

import pytest
from utils import (
    BenchmarkDB,
    DatabaseManager,
    calc_metric,
    classify_result,
    compute_metrics,
    resolve_ground_truth,
    setup_logging,
)


# ==================== setup_logging ====================
class TestSetupLogging:
    def test_returns_logger(self):
        logger = setup_logging(script_name="test_utils")
        assert logger.name == "root"
        assert logger.level == 20  # INFO

    def test_verbose_mode(self):
        logger = setup_logging(verbose=True, script_name="test_utils")
        assert logger.level == 10  # DEBUG


# ==================== calc_metric ====================
class TestCalcMetric:
    def test_normal(self):
        assert calc_metric(1, 2) == 0.5

    def test_zero_denominator(self):
        assert calc_metric(1, 0) is None


# ==================== compute_metrics ====================
class TestComputeMetrics:
    def test_all_zero(self):
        m = compute_metrics(0, 0, 0, 0)
        assert m["total_judged"] == 0
        assert m["precision"] is None
        assert m["f1_score"] is None

    def test_typical(self):
        m = compute_metrics(8, 6, 2, 4)
        assert m["tp"] == 8
        assert m["total_judged"] == 20
        assert m["precision"] == 0.8
        assert m["recall"] == round(8 / 12, 4)


# ==================== classify_result ====================
class TestClassifyResult:
    def test_tp(self):
        assert classify_result("漏洞", "Positive") == "TP"

    def test_fp(self):
        assert classify_result("漏洞", "Negative") == "FP"

    def test_tn(self):
        assert classify_result("安全", "Negative") == "TN"

    def test_fn(self):
        assert classify_result("安全", "Positive") == "FN"

    def test_unknown(self):
        assert classify_result("其他", "Positive") == "unknown"


# ==================== resolve_ground_truth ====================
class TestResolveGroundTruth:
    def test_positive(self):
        assert resolve_ground_truth(1) == "Positive"

    def test_negative(self):
        assert resolve_ground_truth(2) == "Negative"

    def test_unknown(self):
        assert resolve_ground_truth(0) == "Unknown"


# ==================== DatabaseManager ====================
class TestDatabaseManager:
    def test_init_creates_db(self, tmp_path):
        db_path = str(tmp_path / "test.db")
        schema = {
            "test_table": {
                "sql": "CREATE TABLE IF NOT EXISTS test_table (id INTEGER PRIMARY KEY, name TEXT)",
                "indexes": [],
            }
        }
        dm = DatabaseManager(db_path, schema)
        assert os.path.exists(db_path)
        count = dm.conn.execute("SELECT COUNT(*) FROM test_table").fetchone()[0]
        assert count == 0
        dm.close()

    def test_close(self, tmp_path):
        dm = DatabaseManager(str(tmp_path / "test.db"))
        dm.close()
        assert dm.conn is not None  # close doesn't set to None, just closes


# ==================== BenchmarkDB ====================
class TestBenchmarkDB:
    def _make_db(self, tmp_path):
        db = BenchmarkDB(str(tmp_path / "bench.db"))
        return db

    def test_create_and_get_version(self, tmp_path):
        db = self._make_db(tmp_path)
        assert db.create_version("v1", description="test")
        v = db.get_version("v1")
        assert v is not None
        assert v["version"] == "v1"
        assert v["status"] == "pending"
        db.close()

    def test_list_versions(self, tmp_path):
        db = self._make_db(tmp_path)
        db.create_version("v1")
        db.create_version("v2")
        versions = db.list_versions()
        assert len(versions) == 2
        db.close()

    def test_insert_and_get_results(self, tmp_path):
        db = self._make_db(tmp_path)
        db.create_version("v1")
        db.insert_result(
            {
                "version": "v1",
                "issue_id": "i1",
                "ground_truth": "Positive",
                "vul_type": "xss",
            }
        )
        results = db.get_results("v1")
        assert len(results) == 1
        assert results[0]["issue_id"] == "i1"
        db.close()

    def test_update_result(self, tmp_path):
        db = self._make_db(tmp_path)
        db.create_version("v1")
        db.insert_result(
            {"version": "v1", "issue_id": "i1", "ground_truth": "Positive"}
        )
        db.update_result("v1", "i1", classification="TP", agent_conclusion="漏洞")
        results = db.get_results("v1")
        assert results[0]["classification"] == "TP"
        db.close()

    def test_compute_version_metrics(self, tmp_path):
        db = self._make_db(tmp_path)
        db.create_version("v1")
        db.insert_result(
            {"version": "v1", "issue_id": "i1", "ground_truth": "Positive"}
        )
        db.update_result("v1", "i1", classification="TP")
        metrics = db.compute_version_metrics("v1")
        assert metrics["tp"] == 1
        assert metrics["total_issues"] == 1
        db.close()

    def test_delete_version(self, tmp_path):
        db = self._make_db(tmp_path)
        db.create_version("v1")
        db.insert_result(
            {"version": "v1", "issue_id": "i1", "ground_truth": "Positive"}
        )
        db.delete_version("v1")
        assert db.get_version("v1") is None
        assert db.get_results("v1") == []
        db.close()

    def test_compute_vote_stats(self, tmp_path):
        db = self._make_db(tmp_path)
        db.create_version("v1")
        db.insert_result(
            {"version": "v1", "issue_id": "i1", "ground_truth": "Positive"}
        )
        db.update_result(
            "v1", "i1", classification="TP", votes_count=3, vote_agreement=0.8
        )
        stats = db.compute_vote_stats("v1")
        assert stats["votes_count"] == 3
        assert stats["avg_agreement"] == 0.8
        db.close()

    def test_update_version_status(self, tmp_path):
        db = self._make_db(tmp_path)
        db.create_version("v1")
        db.update_version_status("v1", "completed")
        v = db.get_version("v1")
        assert v["status"] == "completed"
        assert v["completed_at"] is not None
        db.close()


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
