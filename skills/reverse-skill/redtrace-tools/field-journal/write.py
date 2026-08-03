#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import tempfile
import time
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path


SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
REAL_ENTRY = re.compile(r"^\d{4}-\d{2}-\d{2}[_-].+\.md$")
SECTION = "### RedTrace 自动回写"
USAGE_HEADING = "## 使用说明"


def _atomic_write(path: Path, content: str) -> None:
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        path.chmod(0o644)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


@contextmanager
def _journal_lock(journal: Path):
    lock = journal / ".redtrace-journal.lock.d"
    deadline = time.monotonic() + 30
    while True:
        try:
            lock.mkdir()
            break
        except FileExistsError:
            try:
                stale = time.time() - lock.stat().st_mtime > 300
            except FileNotFoundError:
                continue
            if stale:
                try:
                    lock.rmdir()
                except OSError:
                    pass
                continue
            if time.monotonic() >= deadline:
                raise TimeoutError(f"timed out waiting for journal lock: {lock}")
            time.sleep(0.05)
    try:
        yield
    finally:
        lock.rmdir()


def _next_entry_path(journal: Path, slug: str) -> Path:
    date = datetime.now(UTC).date().isoformat()
    base = journal / f"{date}_redtrace-{slug}.md"
    if not base.exists():
        return base
    suffix = 2
    while True:
        candidate = journal / f"{date}_redtrace-{slug}-{suffix}.md"
        if not candidate.exists():
            return candidate
        suffix += 1


def _replace_stat(index: str, label: str, value: int) -> str:
    pattern = re.compile(rf"^- {re.escape(label)}：\d+$", re.MULTILINE)
    replacement = f"- {label}：{value}"
    if pattern.search(index):
        return pattern.sub(replacement, index, count=1)
    return index


def _update_index(journal: Path, entry: Path, summary: str, keywords: list[str]) -> str:
    index_path = journal / "_index.md"
    if index_path.is_file():
        index = index_path.read_text(encoding="utf-8")
    else:
        index = (
            "# 项目经验索引\n\n## 统计\n\n"
            "- 真实项目数：0\n- 种子参考数：0\n- 总条目数：0\n\n"
            "## 按场景分类\n\n## 使用说明\n"
        )

    keyword_text = ", ".join(keywords)
    line = f"- [{entry.stem}](./{entry.name}) — {summary}"
    if keyword_text:
        line += f"；关键词: {keyword_text}"
    line += "\n"

    if SECTION not in index:
        block = f"{SECTION}\n\n{line}\n"
        if USAGE_HEADING in index:
            index = index.replace(USAGE_HEADING, block + USAGE_HEADING, 1)
        else:
            index = index.rstrip() + "\n\n" + block
    else:
        section_start = index.index(SECTION) + len(SECTION)
        next_heading = index.find("\n## ", section_start)
        insert_at = len(index) if next_heading < 0 else next_heading
        prefix = index[:insert_at].rstrip() + "\n"
        suffix = index[insert_at:]
        index = prefix + line + ("\n" if suffix and not suffix.startswith("\n\n") else "") + suffix

    real_count = sum(
        1
        for path in journal.glob("*.md")
        if path.name != "_index.md" and REAL_ENTRY.fullmatch(path.name)
    )
    seed_count = sum(1 for _path in journal.glob("seed-*.md"))
    index = _replace_stat(index, "真实项目数", real_count)
    index = _replace_stat(index, "种子参考数", seed_count)
    index = _replace_stat(index, "总条目数", real_count + seed_count)
    return index


def write_entry(
    journal: Path,
    *,
    slug: str,
    summary: str,
    keywords: list[str],
    content: str,
) -> Path:
    journal = journal.resolve()
    journal.mkdir(parents=True, exist_ok=True)
    with _journal_lock(journal):
        entry = _next_entry_path(journal, slug)
        body = content.strip() + "\n"
        if not body.startswith("# "):
            body = f"# {summary}\n\n{body}"
        _atomic_write(entry, body)
        try:
            index = _update_index(journal, entry, summary, keywords)
            _atomic_write(journal / "_index.md", index)
        except BaseException:
            entry.unlink(missing_ok=True)
            raise
        return entry


def main() -> int:
    default_journal = (
        Path(__file__).resolve().parents[2]
        / "upstream"
        / "skills"
        / "field-journal"
    )
    parser = argparse.ArgumentParser(
        description="Atomically add one anonymized RedTrace field-journal entry."
    )
    parser.add_argument("--journal-dir", type=Path, default=default_journal)
    parser.add_argument("--slug", required=True)
    parser.add_argument("--summary", required=True)
    parser.add_argument("--keywords", default="")
    parser.add_argument("--entry-file", required=True, type=Path)
    args = parser.parse_args()

    if not SLUG.fullmatch(args.slug):
        parser.error("--slug must match ^[a-z0-9][a-z0-9-]{0,63}$")
    summary = args.summary.strip()
    if not summary or len(summary) > 240 or "\n" in summary:
        parser.error("--summary must be one non-empty line of at most 240 characters")
    content = args.entry_file.read_text(encoding="utf-8")
    if len(content.encode("utf-8")) > 1_048_576:
        parser.error("--entry-file exceeds 1 MiB")
    keywords = [value.strip() for value in args.keywords.split(",") if value.strip()]
    if any(len(value) > 64 or "\n" in value for value in keywords):
        parser.error("each keyword must be one line of at most 64 characters")

    entry = write_entry(
        args.journal_dir,
        slug=args.slug,
        summary=summary,
        keywords=keywords,
        content=content,
    )
    print(
        json.dumps(
            {"entry": str(entry), "index": str(entry.parent / "_index.md")},
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
