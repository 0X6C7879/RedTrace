#!/usr/bin/env python3
"""Dependency-free CLI for RedTrace's per-Skill learning loop."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
import time
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterator


NAME = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
SECRET = re.compile(
    r"(?i)\b(password|passwd|secret|token|api[_-]?key|credential|authorization)"
    r"(\s*[:=]\s*)([^\s,;]+)"
)
BEARER = re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{8,}")
FLAG = re.compile(r"(?i)\b(?:flag|ctf)\{[^}\r\n]{1,512}\}")
URL = re.compile(r'''(?i)\bhttps?://[^\s)\]>"']+''')
IPV4 = re.compile(r"(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])")
PRIVATE_KEY = re.compile(
    r"-----BEGIN [^-\r\n]*PRIVATE KEY-----.*?-----END [^-\r\n]*PRIVATE KEY-----",
    re.DOTALL,
)
MAX_CONTENT_BYTES = 16_384
MAX_ENTRIES_PER_SKILL = 100


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _skills_dir() -> Path:
    raw = _env("REDTRACE_SKILLS_DIR")
    if not raw:
        raise ValueError("REDTRACE_SKILLS_DIR is required")
    return Path(raw).resolve()


def _memory_dir(skills_dir: Path) -> Path:
    raw = _env("REDTRACE_SKILL_MEMORY_DIR")
    path = Path(raw).resolve() if raw else skills_dir / ".redtrace" / "learning"
    if path != skills_dir and skills_dir not in path.parents:
        raise ValueError("REDTRACE_SKILL_MEMORY_DIR must be inside REDTRACE_SKILLS_DIR")
    return path


def _skill(skills_dir: Path, value: str) -> str:
    name = value.strip().lower()
    if not NAME.fullmatch(name) or not (skills_dir / name / "SKILL.md").is_file():
        raise ValueError(f"unknown canonical Skill: {value}")
    return name


def _one_line(value: str, label: str, limit: int) -> str:
    text = value.strip()
    if not text or len(text) > limit or "\n" in text or "\r" in text:
        raise ValueError(f"{label} must be one non-empty line of at most {limit} characters")
    return text


def _sanitize(text: str) -> str:
    workspace = _env("REDTRACE_WORKSPACE")
    if workspace:
        text = text.replace(workspace, "<workspace>").replace(workspace.replace("\\", "/"), "<workspace>")
    text = PRIVATE_KEY.sub("<redacted-private-key>", text)
    text = SECRET.sub(lambda match: f"{match.group(1)}{match.group(2)}<redacted>", text)
    text = BEARER.sub("Bearer <redacted>", text)
    text = FLAG.sub("<redacted-flag>", text)
    text = URL.sub("<target-url>", text)
    return IPV4.sub("<target-ip>", text)


def _atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, path)
    except BaseException:
        Path(temporary_name).unlink(missing_ok=True)
        raise


@contextmanager
def _lock(memory: Path) -> Iterator[None]:
    lock = memory / ".lock"
    memory.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + 5
    while True:
        try:
            lock.mkdir()
            break
        except FileExistsError:
            if time.monotonic() >= deadline:
                raise TimeoutError("timed out waiting for Skill learning lock")
            try:
                if time.time() - lock.stat().st_mtime > 30:
                    lock.rmdir()
                    continue
            except (FileNotFoundError, OSError):
                continue
            time.sleep(0.05)
    try:
        yield
    finally:
        lock.rmdir()


def _read_records(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    records: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(item, dict):
            records.append(item)
    return records


def _content_file(path: Path) -> str:
    resolved = path.resolve()
    workspace = Path(_env("REDTRACE_WORKSPACE", str(Path.cwd()))).resolve()
    if resolved != workspace and workspace not in resolved.parents:
        raise ValueError("--content-file must be inside REDTRACE_WORKSPACE")
    data = resolved.read_bytes()
    if len(data) > MAX_CONTENT_BYTES:
        raise ValueError(f"--content-file exceeds {MAX_CONTENT_BYTES} bytes")
    return data.decode("utf-8")


def learn(args: argparse.Namespace) -> dict[str, Any]:
    skills = _skills_dir()
    name = _skill(skills, args.skill)
    summary = _sanitize(_one_line(args.summary, "--summary", 240))
    evidence = _sanitize(_one_line(args.evidence, "--evidence", 500))
    content = _sanitize(_content_file(args.content_file).strip())
    if not content:
        raise ValueError("--content-file is empty")
    digest = hashlib.sha256(f"{name}\n{summary}\n{evidence}\n{content}".encode()).hexdigest()
    memory = _memory_dir(skills)
    path = memory / f"{name}.jsonl"
    with _lock(memory):
        records = _read_records(path)
        if any(item.get("digest") == digest for item in records):
            return {"status": "duplicate", "skill": name, "digest": digest}
        record = {
            "at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            "skill": name,
            "summary": summary,
            "evidence": evidence,
            "content": content,
            "digest": digest,
            "project": _env("REDTRACE_PROJECT_ID"),
            "intent": _env("REDTRACE_INTENT_ID"),
            "worker": _env("REDTRACE_WORKER"),
        }
        records.append(record)
        serialized = "".join(
            json.dumps(item, ensure_ascii=False, separators=(",", ":")) + "\n"
            for item in records[-MAX_ENTRIES_PER_SKILL:]
        )
        _atomic_write(path, serialized)
        audit_path = memory / "audit.jsonl"
        audit = _read_records(audit_path)
        audit.append({key: record[key] for key in ("at", "skill", "digest", "project", "intent", "worker")})
        _atomic_write(
            audit_path,
            "".join(json.dumps(item, ensure_ascii=False, separators=(",", ":")) + "\n" for item in audit[-1000:]),
        )
    return {"status": "stored", "skill": name, "digest": digest}


def _legacy_notes(memory: Path, name: str, limit: int) -> list[str]:
    legacy = memory / "legacy"
    if not legacy.is_dir():
        return []
    terms = {name, name.replace("-", " ")}
    notes: list[str] = []
    for path in sorted(legacy.glob("*.md"), reverse=True):
        if path.name.startswith("_"):
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        lowered = text.lower()
        if not any(term in lowered for term in terms):
            continue
        excerpt = _sanitize(" ".join(text.split())[:600])
        notes.append(f"- [legacy:{path.stem}] {excerpt}")
        if len(notes) >= limit:
            break
    return notes


def _bundled_note(skills: Path, name: str) -> str | None:
    path = skills / name / "learned" / "learned.md"
    if not path.is_file():
        return None
    excerpt = _sanitize(" ".join(path.read_text(encoding="utf-8", errors="replace").split())[:1200])
    return f"- [curated] {excerpt}" if excerpt else None


def recall(args: argparse.Namespace) -> str:
    skills = _skills_dir()
    name = _skill(skills, args.skill)
    memory = _memory_dir(skills)
    records = _read_records(memory / f"{name}.jsonl")[-args.limit :]
    lines = [f"# RedTrace learnings: {name}"]
    for item in records:
        lines.extend(
            [
                f"- {item.get('summary', '')}",
                f"  Evidence: {item.get('evidence', '')}",
                f"  Note: {item.get('content', '')}",
            ]
        )
    remaining = max(0, args.limit - len(records))
    bundled = _bundled_note(skills, name)
    if bundled and remaining:
        lines.append(bundled)
        remaining -= 1
    lines.extend(_legacy_notes(memory, name, remaining))
    if len(lines) == 1:
        lines.append("- No reusable learning recorded yet.")
    return "\n".join(lines)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="redtrace-skill")
    commands = parser.add_subparsers(dest="command", required=True)
    recall_parser = commands.add_parser("recall", help="Read bounded reusable learnings for one Skill")
    recall_parser.add_argument("skill")
    recall_parser.add_argument("--limit", type=int, default=5, choices=range(1, 11), metavar="1..10")
    learn_parser = commands.add_parser("learn", help="Store one verified, sanitized reusable learning")
    learn_parser.add_argument("skill")
    learn_parser.add_argument("--summary", required=True)
    learn_parser.add_argument("--evidence", required=True)
    learn_parser.add_argument("--content-file", required=True, type=Path)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        if args.command == "recall":
            print(recall(args))
        else:
            print(json.dumps(learn(args), ensure_ascii=False, separators=(",", ":")))
    except (OSError, UnicodeError, ValueError, TimeoutError) as exc:
        print(f"redtrace-skill: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
