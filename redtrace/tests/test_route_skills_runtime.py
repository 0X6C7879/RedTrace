from __future__ import annotations

import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
JOURNAL_WRITER = (
    REPO_ROOT
    / "skills"
    / "route-skills"
    / "redtrace-tools"
    / "field-journal"
    / "write.py"
)


def test_field_journal_writer_serializes_concurrent_entry_and_index_updates(
    tmp_path: Path,
) -> None:
    journal = tmp_path / "field-journal"
    journal.mkdir()
    (journal / "_index.md").write_text(
        "# 项目经验索引\n\n"
        "## 统计\n\n"
        "- 真实项目数：0\n"
        "- 种子参考数：0\n"
        "- 总条目数：0\n\n"
        "## 按场景分类\n\n"
        "## 使用说明\n",
        encoding="utf-8",
    )
    draft = tmp_path / "entry.md"
    draft.write_text("## 可复用模式\n\nconcurrent-safe pattern\n", encoding="utf-8")

    def write_entry(index: int) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                sys.executable,
                str(JOURNAL_WRITER),
                "--journal-dir",
                str(journal),
                "--slug",
                "same-finding",
                "--summary",
                f"并发经验 {index}",
                "--keywords",
                "concurrency,atomic-index",
                "--entry-file",
                str(draft),
            ],
            check=False,
            capture_output=True,
            text=True,
        )

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(write_entry, range(8)))

    assert all(result.returncode == 0 for result in results), [
        result.stderr for result in results
    ]
    entries = sorted(journal.glob("????-??-??_redtrace-same-finding*.md"))
    assert len(entries) == 8
    index_text = (journal / "_index.md").read_text(encoding="utf-8")
    assert index_text.count("atomic-index") == 8
    assert "- 真实项目数：8" in index_text
    assert "- 总条目数：8" in index_text
