#!/usr/bin/env python3
"""evolve.py — code-audit learned 经验事务写入器（轻量进化体系唯一写入入口）。

设计原则（不新增独立 Skill Evolution Agent，不产生额外模型调用）：
- 执行审计任务的 Worker 在任务结束前直接调用本脚本沉淀经验。
- 目录锁 learned/.lock.d + 原子写入，支持多 Worker 并发。
- learned.md 只追加简短索引，详细内容写入 entries/，机器索引写入 learned.index（JSONL）。
- 每次写入向 skills/.redtrace/audit.jsonl 追加审计记录。
- 项目事实只写任务 Workspace 的 .redtrace/code-audit/，禁止进入本目录。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import tempfile
import time
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path


TOOL_ROOT = Path(__file__).resolve().parents[1]  # redtrace-tools/
SKILL_ROOT = TOOL_ROOT.parent  # route-skills/
DEFAULT_LEARNED = SKILL_ROOT / "upstream" / "skills" / "code-audit" / "learned"
SKILLS_DIR = SKILL_ROOT.parent  # skills/
AUDIT_LOG = SKILLS_DIR / ".redtrace" / "audit.jsonl"

MODES = {
    "arch-scan",
    "api-audit",
    "mr-review",
    "sast-audit",
    "api-inventory",
    "report-review",
    "security-assessment",
    "runtime-verify",
    "benchmark",
}
RESULTS = {"vulnerability", "false-positive", "safe-pattern", "workflow"}
SUMMARY = re.compile(r"^[^\n]{1,240}$")
IDENT = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")

# 禁止沉淀的敏感内容（粗筛，作者仍需自行脱敏）
FORBIDDEN = re.compile(
    r"(password\s*[:=]|secret[_-]?key\s*[:=]|token\s*[:=]|cookie\s*[:=]"
    r"|BEGIN (RSA|EC|OPENSSH) PRIVATE KEY)",
    re.IGNORECASE,
)


def _atomic_write(path: Path, content: str) -> None:
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        try:
            path.chmod(0o644)
        except OSError:
            pass
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def _append(path: Path, line: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    content = path.read_text(encoding="utf-8") if path.is_file() else ""
    if content and not content.endswith("\n"):
        content += "\n"
    _atomic_write(path, content + line + "\n")


@contextmanager
def _learned_lock(learned: Path):
    lock = learned / ".lock.d"
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
                raise TimeoutError(f"timed out waiting for learned lock: {lock}")
            time.sleep(0.05)
    try:
        yield
    finally:
        lock.rmdir()


def _next_entry_id(learned: Path) -> str:
    index = learned / "learned.index"
    count = 0
    if index.is_file():
        for line in index.read_text(encoding="utf-8").splitlines():
            if line.strip():
                count += 1
    return f"CA-LEARN-{count + 1:04d}"


def write_entry(
    learned: Path,
    *,
    mode: str,
    language: str,
    category: str,
    result: str,
    summary: str,
    content: str,
    finding_id: str = "",
    task_id: str = "",
    worker_type: str = "",
) -> tuple[str, Path]:
    learned = learned.resolve()
    entries = learned / "entries"
    entries.mkdir(parents=True, exist_ok=True)
    now = datetime.now(UTC)
    with _learned_lock(learned):
        entry_id = _next_entry_id(learned)
        front_matter = "\n".join(
            [
                "---",
                f"id: {entry_id}",
                f"mode: {mode}",
                f"language: {language}",
                f"category: {category}",
                f"result: {result}",
                f"summary: {summary}",
                f"finding_id: {finding_id or 'null'}",
                f"task_id: {task_id or 'null'}",
                f"created_at: {now.isoformat(timespec='seconds')}",
                "sanitized: true",
                "---",
                "",
                "",
            ]
        )
        entry = entries / f"{entry_id.lower()}.md"
        _atomic_write(entry, front_matter + content.strip() + "\n")
        index_line = (
            f"- [{entry_id}](./entries/{entry.name}) mode={mode} "
            f"language={language} category={category} result={result} — {summary}"
        )
        try:
            _append(learned / "learned.md", index_line)
            _append(
                learned / "learned.index",
                json.dumps(
                    {
                        "id": entry_id,
                        "mode": mode,
                        "language": language,
                        "category": category,
                        "result": result,
                        "summary": summary,
                        "findingId": finding_id or None,
                        "taskId": task_id or None,
                        "entry": f"entries/{entry.name}",
                        "at": now.isoformat(timespec="seconds"),
                    },
                    ensure_ascii=False,
                ),
            )
        except BaseException:
            entry.unlink(missing_ok=True)
            raise
        _append(
            AUDIT_LOG,
            json.dumps(
                {
                    "action": "skill-learning-write",
                    "skill": "route-skills",
                    "module": "code-audit",
                    "entry": entry_id,
                    "taskId": task_id or None,
                    "workerType": worker_type or None,
                    "sha256": hashlib.sha256(content.encode("utf-8")).hexdigest(),
                    "at": now.isoformat(timespec="seconds"),
                },
                ensure_ascii=False,
            ),
        )
        return entry_id, entry


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Atomically append one sanitized code-audit learned entry."
    )
    parser.add_argument("--learned-dir", type=Path, default=DEFAULT_LEARNED)
    parser.add_argument("--domain", default="code-audit")
    parser.add_argument("--mode", required=True)
    parser.add_argument("--language", default="unknown")
    parser.add_argument("--category", required=True)
    parser.add_argument("--result", required=True, choices=sorted(RESULTS))
    parser.add_argument("--summary", required=True)
    parser.add_argument("--entry-file", required=True, type=Path)
    parser.add_argument("--finding-id", default="")
    parser.add_argument("--task-id", default="")
    parser.add_argument("--worker-type", default="")
    args = parser.parse_args()

    if args.domain != "code-audit":
        parser.error("--domain currently only supports code-audit")
    if args.mode not in MODES:
        parser.error(f"--mode must be one of: {', '.join(sorted(MODES))}")
    if not SUMMARY.fullmatch(args.summary):
        parser.error("--summary must be one non-empty line of at most 240 characters")
    for label, value in (
        ("--category", args.category),
        ("--finding-id", args.finding_id),
        ("--task-id", args.task_id),
    ):
        if value and not IDENT.fullmatch(value):
            parser.error(f"{label} must match ^[A-Za-z0-9._:-]{{1,128}}$")
    content = args.entry_file.read_text(encoding="utf-8")
    if len(content.encode("utf-8")) > 1_048_576:
        parser.error("--entry-file exceeds 1 MiB")
    if FORBIDDEN.search(content) or FORBIDDEN.search(args.summary):
        parser.error("entry contains credential-like material; sanitize first")

    entry_id, entry = write_entry(
        args.learned_dir,
        mode=args.mode,
        language=args.language,
        category=args.category,
        result=args.result,
        summary=args.summary.strip(),
        content=content,
        finding_id=args.finding_id,
        task_id=args.task_id,
        worker_type=args.worker_type,
    )
    print(json.dumps({"id": entry_id, "entry": str(entry)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
