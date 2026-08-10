#!/usr/bin/env python3
"""Dependency-free, post-RTK context harness for RedTrace task workspaces.

The file is copied into ``.redtrace/bin`` for local and container workers, so
keep it self-contained and limited to the Python standard library.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
import xml.etree.ElementTree as ET
from collections import Counter, deque
from dataclasses import dataclass, field
from datetime import UTC, datetime
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, BinaryIO, Iterable


SECRET_RE = re.compile(
    r"(?i)\b(authorization|api[_-]?key|token|secret|password|cookie)"
    r"(\s*[:=]\s*)([^\s,;]+)"
)
SIGNAL_RE = re.compile(
    r"(?i)\b(critical|high|medium|vulnerab|cve-\d|exploit|exposed|"
    r"unauthori[sz]ed|forbidden|denied|error|failed|timeout|credential|"
    r"password|token|secret|open\b|success|confirmed)\b"
)
HTTP_RE = re.compile(rb"^HTTP/\d(?:\.\d)?\s+\d{3}\b")
SECURITY_TEXT_RE = re.compile(
    rb"(?im)^(Nmap scan report|PORT\s+STATE\s+SERVICE|"
    rb"\[[a-z-]+\]\s+\[[^\]]+\]\s+https?://|"
    rb".*\b(?:critical|high)\b.*\b(?:vulnerab|cve-|matched-at)\b)"
)
MAX_SIGNAL_LINES = 16


def _env_int(name: str, default: int, minimum: int = 1) -> int:
    try:
        return max(minimum, int(os.environ.get(name, default)))
    except (TypeError, ValueError):
        return default


@dataclass(frozen=True, slots=True)
class Settings:
    enabled: bool
    root: Path
    inline_bytes: int
    visible_bytes: int
    query_bytes: int
    parse_bytes: int

    @classmethod
    def from_env(cls) -> "Settings":
        enabled = os.environ.get("REDTRACE_CONTEXT_HARNESS_ENABLED", "1").lower()
        return cls(
            enabled=enabled not in {"0", "false", "no", "off"},
            root=Path(
                os.environ.get(
                    "REDTRACE_CONTEXT_ARTIFACT_ROOT",
                    ".redtrace/artifacts/context",
                )
            ),
            inline_bytes=_env_int("REDTRACE_CONTEXT_INLINE_BYTES", 32 * 1024),
            visible_bytes=_env_int("REDTRACE_CONTEXT_VISIBLE_BYTES", 8 * 1024),
            query_bytes=_env_int("REDTRACE_CONTEXT_QUERY_BYTES", 64 * 1024),
            parse_bytes=_env_int("REDTRACE_CONTEXT_PARSE_BYTES", 16 * 1024 * 1024),
        )


@dataclass(slots=True)
class ChannelCapture:
    path: Path
    size: int = 0
    digest: Any = field(default_factory=hashlib.sha256)
    error: Exception | None = None

    def drain(self, pipe: BinaryIO, passthrough: BinaryIO | None = None) -> None:
        try:
            with self.path.open("wb", buffering=256 * 1024) as output:
                while True:
                    chunk = pipe.read(64 * 1024)
                    if not chunk:
                        break
                    output.write(chunk)
                    self.digest.update(chunk)
                    self.size += len(chunk)
                    if passthrough is not None:
                        passthrough.write(chunk)
                        passthrough.flush()
        except Exception as exc:  # The caller falls back to raw output.
            self.error = exc
        finally:
            try:
                pipe.close()
            except Exception:
                pass


@dataclass(slots=True)
class SignalSummary:
    kind: str
    lines: list[str]
    state: dict[str, Any] = field(default_factory=dict)


class PageSignals(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title = ""
        self.headings: list[str] = []
        self.interactive: list[str] = []
        self.links: list[str] = []
        self.scripts: list[str] = []
        self.text: list[str] = []
        self.tags: Counter[str] = Counter()
        self._capture: str | None = None
        self._parts: list[str] = []
        self._link_href = ""

    def handle_starttag(
        self,
        tag: str,
        attrs: list[tuple[str, str | None]],
    ) -> None:
        values = {key: value or "" for key, value in attrs}
        self.tags[tag] += 1
        if tag in {"title", "h1", "h2", "h3", "button", "a"}:
            self._capture = tag
            self._parts = []
            if tag == "a":
                self._link_href = values.get("href", "")
        if tag == "form":
            self.interactive.append(
                f"form {values.get('method', 'get').upper()} {values.get('action') or '(current)'}"
            )
        elif tag in {"input", "select", "textarea"}:
            identity = values.get("name") or values.get("id") or "(unnamed)"
            self.interactive.append(
                f"{tag} {identity} type={values.get('type') or tag}"
            )
        elif tag == "script" and values.get("src"):
            self.scripts.append(values["src"])

    def handle_endtag(self, tag: str) -> None:
        if tag != self._capture:
            return
        value = " ".join(" ".join(self._parts).split())
        if value:
            if tag == "title":
                self.title = value
            elif tag in {"h1", "h2", "h3"}:
                self.headings.append(value)
            elif tag == "button":
                self.interactive.append(f"button {value}")
            elif tag == "a":
                self.links.append(value)
                self.interactive.append(
                    f"link {value} -> {self._link_href or '(no href)'}"
                )
        self._capture = None
        self._parts = []
        self._link_href = ""

    def handle_data(self, data: str) -> None:
        clean = " ".join(data.split())
        if not clean:
            return
        if self._capture is not None:
            self._parts.append(clean)
        if len(clean) >= 3:
            self.text.append(clean)


def _utcnow() -> str:
    return datetime.now(UTC).isoformat()


def _peak_memory_bytes() -> int:
    try:
        if os.name == "nt":
            import ctypes
            from ctypes import wintypes

            class ProcessMemoryCounters(ctypes.Structure):
                _fields_ = [
                    ("cb", wintypes.DWORD),
                    ("PageFaultCount", wintypes.DWORD),
                    ("PeakWorkingSetSize", ctypes.c_size_t),
                    ("WorkingSetSize", ctypes.c_size_t),
                    ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                    ("PagefileUsage", ctypes.c_size_t),
                    ("PeakPagefileUsage", ctypes.c_size_t),
                ]

            counters = ProcessMemoryCounters()
            counters.cb = ctypes.sizeof(counters)
            current_process = ctypes.windll.kernel32.GetCurrentProcess
            current_process.restype = wintypes.HANDLE
            get_memory = ctypes.windll.psapi.GetProcessMemoryInfo
            get_memory.argtypes = [
                wintypes.HANDLE,
                ctypes.c_void_p,
                wintypes.DWORD,
            ]
            get_memory.restype = wintypes.BOOL
            ok = get_memory(
                current_process(),
                ctypes.byref(counters),
                counters.cb,
            )
            return int(counters.PeakWorkingSetSize) if ok else 0
        import resource

        value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return int(value if sys.platform == "darwin" else value * 1024)
    except (AttributeError, ImportError, OSError):
        return 0


def _safe_text(value: Any, limit: int = 500) -> str:
    text = SECRET_RE.sub(r"\1\2[REDACTED]", str(value))
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _atomic_json(path: Path, value: dict[str, Any]) -> None:
    temporary = path.with_suffix(path.suffix + f".{uuid.uuid4().hex}.tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, path)
    try:
        path.chmod(0o600)
    except OSError:
        pass


def _append_jsonl(path: Path, value: dict[str, Any]) -> None:
    payload = (
        json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n"
    ).encode("utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
    try:
        os.write(descriptor, payload)
    finally:
        os.close(descriptor)


def _artifact_ids() -> tuple[str, str]:
    suffix = datetime.now(UTC).strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:10]
    return f"ctx-{suffix}", f"ev-{suffix}"


def _read_sample(path: Path, limit: int) -> bytes:
    size = path.stat().st_size
    with path.open("rb") as stream:
        if size <= limit:
            return stream.read()
        head_size = max(1, limit * 2 // 3)
        head = stream.read(head_size)
        stream.seek(max(head_size, size - (limit - head_size)))
        return head + b"\n... sample gap ...\n" + stream.read(limit - head_size)


def _detect_kind(sample: bytes, declared: str) -> str:
    if declared != "auto":
        return declared
    stripped = sample.lstrip()
    if stripped.startswith(
        (b"\x89PNG\r\n\x1a\n", b"\xff\xd8\xff", b"GIF87a", b"GIF89a", b"%PDF-")
    ):
        return "binary"
    if HTTP_RE.match(stripped):
        return "http"
    lower = stripped[:4096].lower()
    if b"<!doctype html" in lower or b"<html" in lower:
        return "web"
    if stripped.startswith((b"{", b"[")):
        try:
            json.loads(stripped.decode("utf-8", errors="replace"))
            return "json"
        except json.JSONDecodeError:
            pass
    json_lines = 0
    for line in stripped.splitlines()[:8]:
        try:
            if isinstance(json.loads(line), dict):
                json_lines += 1
        except (json.JSONDecodeError, UnicodeDecodeError):
            continue
    if json_lines >= 2:
        return "jsonl"
    if stripped.startswith(b"<?xml") or stripped.startswith(b"<nmaprun"):
        return "xml"
    if SECURITY_TEXT_RE.search(sample):
        return "security-text"
    return "text"


def _page_summary(
    html: str,
    previous: dict[str, Any] | None,
    status: str | None = None,
) -> SignalSummary:
    parser = PageSignals()
    parser.feed(html)
    interactive = sorted(set(parser.interactive))[:40]
    state = {
        "title": parser.title,
        "headings": sorted(set(parser.headings))[:30],
        "interactive": interactive,
        "scripts": sorted(set(parser.scripts))[:30],
        "dom": hashlib.sha256(
            json.dumps(
                {
                    "tags": sorted(parser.tags.items()),
                    "interactive": interactive,
                    "headings": state_headings
                    if (state_headings := sorted(set(parser.headings))[:30])
                    else [],
                },
                sort_keys=True,
            ).encode()
        ).hexdigest()[:16],
    }
    lines = []
    if status:
        lines.append(f"response: {status}")
    lines.extend(
        [
            f"title: {_safe_text(parser.title or '(untitled)')}",
            "headings: "
            + (", ".join(_safe_text(item, 120) for item in state["headings"][:8]) or "none"),
            "interactive: "
            + (", ".join(_safe_text(item, 160) for item in interactive[:12]) or "none"),
        ]
    )
    body_signals = []
    for value in parser.text:
        if SIGNAL_RE.search(value) and value not in body_signals:
            body_signals.append(value)
        if len(body_signals) >= 8:
            break
    if body_signals:
        lines.append(
            "page signals: " + " | ".join(_safe_text(item, 180) for item in body_signals)
        )
    if previous:
        old_interactive = set(previous.get("interactive") or [])
        new_interactive = set(interactive)
        added = sorted(new_interactive - old_interactive)
        removed = sorted(old_interactive - new_interactive)
        if previous.get("dom") == state["dom"]:
            lines.append("DOM change: none")
        else:
            lines.append(
                "DOM change: "
                f"+{len(added)} interactive / -{len(removed)} interactive"
            )
            if added:
                lines.append("interactive added: " + ", ".join(added[:8]))
            if removed:
                lines.append("interactive removed: " + ", ".join(removed[:8]))
    return SignalSummary("web", lines, state)


def _http_summary(
    data: bytes,
    previous: dict[str, Any] | None,
) -> SignalSummary:
    header_bytes, separator, body = data.partition(b"\r\n\r\n")
    if not separator:
        header_bytes, separator, body = data.partition(b"\n\n")
    header_text = header_bytes.decode("utf-8", errors="replace")
    header_lines = header_text.splitlines()
    status = header_lines[0] if header_lines else "HTTP response"
    headers = {}
    for line in header_lines[1:]:
        key, marker, value = line.partition(":")
        if marker:
            headers[key.strip().lower()] = value.strip()
    content_type = headers.get("content-type", "")
    if "html" in content_type or b"<html" in body[:4096].lower():
        result = _page_summary(
            body.decode("utf-8", errors="replace"),
            previous,
            status=status,
        )
        result.lines.insert(1, f"content-type: {_safe_text(content_type)}")
        return result
    lines = [
        f"response: {_safe_text(status)}",
        f"content-type: {_safe_text(content_type or 'unknown')}",
        f"body bytes sampled: {len(body)}",
    ]
    for key in ("location", "www-authenticate", "server", "set-cookie"):
        if key in headers:
            lines.append(f"{key}: {_safe_text(headers[key])}")
    body_text = body.decode("utf-8", errors="replace")
    lines.extend(_signal_lines(body_text))
    return SignalSummary("http", lines)


def _json_objects(path: Path, budget: int) -> Iterable[dict[str, Any]]:
    consumed = 0
    with path.open("rb") as stream:
        for raw in stream:
            consumed += len(raw)
            if consumed > budget:
                break
            try:
                value = json.loads(raw)
            except (json.JSONDecodeError, UnicodeDecodeError):
                continue
            if isinstance(value, dict):
                yield value


def _network_state(value: Any) -> tuple[list[str], Counter[str]]:
    requests: list[str] = []
    statuses: Counter[str] = Counter()
    if not isinstance(value, dict):
        return requests, statuses
    entries = ((value.get("log") or {}).get("entries") or [])
    if isinstance(entries, list):
        for entry in entries[:2000]:
            if not isinstance(entry, dict):
                continue
            request = entry.get("request") or {}
            response = entry.get("response") or {}
            url = request.get("url")
            method = request.get("method") or "GET"
            if isinstance(url, str):
                requests.append(f"{method} {url}")
            status = response.get("status")
            if status is not None:
                statuses[str(status)] += 1
    return sorted(set(requests))[:200], statuses


def _json_summary(
    path: Path,
    kind: str,
    budget: int,
    previous: dict[str, Any] | None,
) -> SignalSummary:
    if kind == "jsonl":
        severities: Counter[str] = Counter()
        templates: Counter[str] = Counter()
        findings: list[str] = []
        count = 0
        keys: Counter[str] = Counter()
        for value in _json_objects(path, budget):
            count += 1
            keys.update(value.keys())
            info = value.get("info") if isinstance(value.get("info"), dict) else {}
            severity = value.get("severity") or info.get("severity")
            if severity:
                severities[str(severity).lower()] += 1
            template = value.get("template-id") or value.get("template")
            if template:
                templates[str(template)] += 1
            matched = value.get("matched-at") or value.get("url") or value.get("host")
            name = info.get("name") or template or value.get("type")
            if matched and len(findings) < MAX_SIGNAL_LINES:
                findings.append(f"{name or 'result'} @ {matched}")
        lines = [
            f"structured records parsed: {count}",
            "severities: "
            + (
                ", ".join(f"{key}={value}" for key, value in severities.most_common())
                or "not reported"
            ),
            "common fields: " + ", ".join(key for key, _ in keys.most_common(12)),
        ]
        if path.stat().st_size > budget:
            lines.insert(
                1,
                f"parse budget reached at {budget} bytes; remaining records stay queryable",
            )
        if templates:
            lines.append(
                "templates: "
                + ", ".join(f"{key}={value}" for key, value in templates.most_common(8))
            )
        lines.extend(f"finding: {_safe_text(item)}" for item in findings)
        return SignalSummary("jsonl", lines)

    if path.stat().st_size > budget:
        return SignalSummary(
            "json",
            [f"structured JSON exceeds parse budget ({budget} bytes); query the Artifact"],
        )
    try:
        value = json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except json.JSONDecodeError:
        return SignalSummary("json", ["invalid JSON; raw content preserved"])
    if isinstance(value, dict) and isinstance(value.get("results"), list):
        results = value["results"]
        lines = [f"results: {len(results)}"]
        for item in results[:MAX_SIGNAL_LINES]:
            if not isinstance(item, dict):
                continue
            target = item.get("url") or item.get("host") or item.get("input")
            fields = [
                f"{key}={item[key]}"
                for key in ("status", "length", "words", "lines")
                if key in item
            ]
            lines.append(f"result: {_safe_text(target)} {' '.join(fields)}")
        return SignalSummary("json", lines)
    requests, statuses = _network_state(value)
    if requests:
        state = {"network": requests}
        lines = [
            f"network requests: {len(requests)}",
            "status codes: "
            + ", ".join(f"{key}={count}" for key, count in statuses.most_common()),
        ]
        lines.extend(f"request: {_safe_text(item)}" for item in requests[:10])
        if previous:
            old = set(previous.get("network") or [])
            new = set(requests)
            lines.append(
                f"network change: +{len(new - old)} / -{len(old - new)} requests"
            )
        return SignalSummary("har", lines, state)
    if isinstance(value, dict):
        return SignalSummary(
            "json",
            [
                f"object fields: {', '.join(sorted(map(str, value.keys()))[:30])}",
                *[
                    f"{key}: {_safe_text(item)}"
                    for key, item in value.items()
                    if SIGNAL_RE.search(str(key)) and not isinstance(item, (dict, list))
                ][:MAX_SIGNAL_LINES],
            ],
        )
    return SignalSummary("json", [f"top-level {type(value).__name__}"])


def _xml_summary(path: Path, budget: int) -> SignalSummary:
    if path.stat().st_size > budget:
        return SignalSummary(
            "xml",
            [f"XML exceeds parse budget ({budget} bytes); query the Artifact"],
        )
    hosts = 0
    open_ports: list[str] = []
    scripts: list[str] = []
    try:
        for _, element in ET.iterparse(path, events=("end",)):
            if element.tag == "host":
                hosts += 1
            elif element.tag == "port":
                state = element.find("state")
                if state is not None and state.attrib.get("state") == "open":
                    service = element.find("service")
                    open_ports.append(
                        f"{element.attrib.get('protocol', '?')}/{element.attrib.get('portid', '?')}"
                        f" {service.attrib.get('name', '') if service is not None else ''}".strip()
                    )
            elif element.tag == "script" and len(scripts) < MAX_SIGNAL_LINES:
                scripts.append(
                    f"{element.attrib.get('id', 'script')}: {element.attrib.get('output', '')}"
                )
            element.clear()
    except ET.ParseError as exc:
        return SignalSummary("xml", [f"XML parse error: {_safe_text(exc)}"])
    return SignalSummary(
        "nmap-xml",
        [
            f"hosts: {hosts}",
            f"open ports: {len(open_ports)}",
            *[f"port: {_safe_text(item)}" for item in open_ports[:MAX_SIGNAL_LINES]],
            *[f"script: {_safe_text(item)}" for item in scripts],
        ],
    )


def _signal_lines(text: str) -> list[str]:
    selected: list[str] = []
    seen: set[str] = set()
    for line in text.splitlines():
        clean = _safe_text(line)
        if clean and SIGNAL_RE.search(clean) and clean not in seen:
            selected.append(f"signal: {clean}")
            seen.add(clean)
        if len(selected) >= MAX_SIGNAL_LINES:
            break
    return selected


def _text_summary(data: bytes, kind: str) -> SignalSummary:
    text = data.decode("utf-8", errors="replace")
    lines = _signal_lines(text)
    raw_lines = [line for line in text.splitlines() if line.strip()]
    if not lines:
        lines.extend(f"sample: {_safe_text(line)}" for line in raw_lines[:6])
        if len(raw_lines) > 12:
            lines.extend(f"tail: {_safe_text(line)}" for line in raw_lines[-4:])
    return SignalSummary(kind, [f"lines sampled: {len(raw_lines)}", *lines])


def _previous_state(root: Path, source: str | None) -> dict[str, Any] | None:
    if not source:
        return None
    index = root / "index.jsonl"
    if not index.is_file():
        return None
    size = index.stat().st_size
    with index.open("rb") as stream:
        stream.seek(max(0, size - 1024 * 1024))
        lines = stream.read().splitlines()
    for raw in reversed(lines):
        try:
            item = json.loads(raw)
        except (json.JSONDecodeError, UnicodeDecodeError):
            continue
        if item.get("source") != source:
            continue
        metadata = root / str(item.get("artifact_id")) / "metadata.json"
        try:
            value = json.loads(metadata.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        state = value.get("summary_state")
        return state if isinstance(state, dict) else None
    return None


def _summarize(
    path: Path,
    declared: str,
    source: str | None,
    settings: Settings,
) -> SignalSummary:
    sample = _read_sample(path, settings.parse_bytes)
    kind = _detect_kind(sample, declared)
    previous = _previous_state(settings.root, source)
    if kind == "http":
        return _http_summary(sample, previous)
    if kind == "web":
        return _page_summary(
            sample.decode("utf-8", errors="replace"),
            previous,
        )
    if kind in {"json", "jsonl", "har"}:
        return _json_summary(path, "json" if kind == "har" else kind, settings.parse_bytes, previous)
    if kind == "xml":
        return _xml_summary(path, settings.parse_bytes)
    if kind == "binary":
        return SignalSummary(
            "binary",
            [
                f"binary bytes: {path.stat().st_size}",
                "binary content is preserved in the Artifact and is not injected inline",
            ],
        )
    return _text_summary(sample, kind)


def _format_summary(
    artifact_id: str,
    evidence_id: str,
    summary: SignalSummary,
    raw_bytes: int,
    settings: Settings,
) -> str:
    header = [
        f"[redtrace-context] artifact={artifact_id} evidence={evidence_id}",
        f"kind={summary.kind} raw_bytes={raw_bytes}",
    ]
    budget = max(512, settings.visible_bytes)
    output: list[str] = header
    used = sum(len(line.encode("utf-8")) + 1 for line in output)
    for line in summary.lines:
        clean = _safe_text(line, 1000)
        cost = len(clean.encode("utf-8")) + 2
        if used + cost > budget - 240:
            output.append("… additional signals are available in the Artifact …")
            break
        output.append(f"- {clean}")
        used += cost
    output.extend(
        [
            (
                f"query: redtrace-context query {evidence_id} "
                "--keyword <term> | --lines <start>:<end> | --offset <bytes> --length <bytes>"
            ),
            "Do not reread the complete Artifact unless a bounded query cannot answer the next step.",
        ]
    )
    return "\n".join(output) + "\n"


def _command_text(command: list[str]) -> str:
    return " ".join(_safe_text(item, 200) for item in command)


def _emit_file(path: Path, target: BinaryIO) -> None:
    with path.open("rb") as stream:
        shutil.copyfileobj(stream, target, length=64 * 1024)
    target.flush()


def _fallback_exec(command: list[str]) -> int:
    if not command:
        return 2
    if os.name != "nt":
        os.execvpe(command[0], command, os.environ)
    return subprocess.call(command)


def _record_metrics(root: Path, value: dict[str, Any]) -> None:
    try:
        _append_jsonl(root / "metrics.jsonl", value)
    except OSError:
        pass


def _run_command(args: argparse.Namespace, settings: Settings) -> int:
    command = list(args.command)
    if command and command[0] == "--":
        command.pop(0)
    if not command:
        print("redtrace-context run requires a command after --", file=sys.stderr)
        return 2
    if not settings.enabled:
        return _fallback_exec(command)

    artifact_id, evidence_id = _artifact_ids()
    artifact_dir = settings.root / artifact_id
    stdout_path = artifact_dir / "stdout.raw"
    stderr_path = artifact_dir / "stderr.raw"
    try:
        artifact_dir.mkdir(parents=True, exist_ok=False)
        for path in (stdout_path, stderr_path):
            path.touch(mode=0o600, exist_ok=False)
    except OSError:
        shutil.rmtree(artifact_dir, ignore_errors=True)
        return _fallback_exec(command)

    started = time.perf_counter()
    try:
        process = subprocess.Popen(
            command,
            stdin=None,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=os.environ,
        )
    except OSError:
        shutil.rmtree(artifact_dir, ignore_errors=True)
        return _fallback_exec(command)
    assert process.stdout is not None
    assert process.stderr is not None
    stdout_capture = ChannelCapture(stdout_path)
    stderr_capture = ChannelCapture(stderr_path)
    stdout_thread = threading.Thread(
        target=stdout_capture.drain,
        args=(process.stdout, sys.stdout.buffer if args.passthrough else None),
        daemon=True,
    )
    stderr_thread = threading.Thread(
        target=stderr_capture.drain,
        args=(process.stderr, sys.stderr.buffer if args.passthrough else None),
        daemon=True,
    )
    stdout_thread.start()
    stderr_thread.start()
    returncode = process.wait()
    stdout_thread.join()
    stderr_thread.join()
    command_ms = int((time.perf_counter() - started) * 1000)
    peak_memory = _peak_memory_bytes()

    if stdout_capture.error or stderr_capture.error:
        if not args.passthrough:
            if stdout_path.is_file():
                _emit_file(stdout_path, sys.stdout.buffer)
            if stderr_path.is_file():
                _emit_file(stderr_path, sys.stderr.buffer)
        return returncode

    raw_bytes = stdout_capture.size + stderr_capture.size
    parse_started = time.perf_counter()
    visible_output: str | None = None
    stderr_signals: list[str] = []
    try:
        summary = _summarize(stdout_path, args.kind, args.source, settings)
        detected = summary.kind
        should_summarize = (
            not args.passthrough
            and (
                raw_bytes > settings.inline_bytes
                or detected not in {"text"}
                or args.kind != "auto"
            )
        )
        if should_summarize:
            visible_output = _format_summary(
                artifact_id,
                evidence_id,
                summary,
                raw_bytes,
                settings,
            )
            if returncode and stderr_capture.size:
                error_summary = _text_summary(
                    _read_sample(stderr_path, min(settings.visible_bytes, settings.parse_bytes)),
                    "stderr",
                )
                stderr_signals = [
                    f"[stderr] {_safe_text(line)}"
                    for line in error_summary.lines[:8]
                ]
            visible_bytes = len(visible_output.encode("utf-8"))
        else:
            _emit_file(stdout_path, sys.stdout.buffer)
            _emit_file(stderr_path, sys.stderr.buffer)
            visible_bytes = raw_bytes
        parse_ms = int((time.perf_counter() - parse_started) * 1000)
    except Exception:
        if not args.passthrough:
            _emit_file(stdout_path, sys.stdout.buffer)
            _emit_file(stderr_path, sys.stderr.buffer)
        summary = SignalSummary("fallback", [])
        should_summarize = False
        visible_bytes = raw_bytes
        parse_ms = int((time.perf_counter() - parse_started) * 1000)

    record = {
        "schema_version": 1,
        "artifact_id": artifact_id,
        "evidence_id": evidence_id,
        "created_at": _utcnow(),
        "project_id": os.environ.get("REDTRACE_PROJECT_ID"),
        "intent_id": os.environ.get("REDTRACE_INTENT_ID"),
        "worker": os.environ.get("REDTRACE_WORKER"),
        "phase": os.environ.get("REDTRACE_PHASE"),
        "source": args.source,
        "command": _command_text(command),
        "kind": summary.kind,
        "returncode": returncode,
        "stdout_bytes": stdout_capture.size,
        "stderr_bytes": stderr_capture.size,
        "raw_bytes": raw_bytes,
        "visible_bytes": visible_bytes,
        "stdout_sha256": stdout_capture.digest.hexdigest(),
        "stderr_sha256": stderr_capture.digest.hexdigest(),
        "summary_state": summary.state,
        "parse_ms": parse_ms,
        "command_duration_ms": command_ms,
        "task_duration_ms": int((time.perf_counter() - started) * 1000),
        "peak_memory_bytes": peak_memory,
        "summarized": should_summarize,
    }
    keep_artifact = should_summarize or args.keep_small or args.passthrough
    metadata_ready = False
    if keep_artifact:
        try:
            _atomic_json(artifact_dir / "metadata.json", record)
            metadata_ready = True
        except OSError:
            if should_summarize:
                _emit_file(stdout_path, sys.stdout.buffer)
                _emit_file(stderr_path, sys.stderr.buffer)
                visible_bytes = raw_bytes
                should_summarize = False
                visible_output = None
        if metadata_ready:
            try:
                _append_jsonl(settings.root / "index.jsonl", record)
            except OSError:
                print(
                    "[redtrace-context] Artifact index update failed; direct evidence-ID "
                    "queries remain available",
                    file=sys.stderr,
                )
    else:
        shutil.rmtree(artifact_dir, ignore_errors=True)

    if should_summarize and metadata_ready and visible_output is not None:
        sys.stdout.write(visible_output)
        for line in stderr_signals:
            print(line, file=sys.stderr)

    reduction = 0.0 if raw_bytes == 0 else max(0.0, 1.0 - visible_bytes / raw_bytes)
    _record_metrics(
        settings.root,
        {
            "timestamp": _utcnow(),
            "artifact_id": artifact_id if keep_artifact and metadata_ready else None,
            "raw_bytes": raw_bytes,
            "visible_bytes": visible_bytes,
            "estimated_raw_tokens": (raw_bytes + 3) // 4,
            "estimated_visible_tokens": (visible_bytes + 3) // 4,
            "token_reduction_rate": round(reduction, 6),
            "parse_ms": parse_ms,
            "command_duration_ms": command_ms,
            "task_duration_ms": record["task_duration_ms"],
            "peak_memory_bytes": peak_memory,
            "returncode": returncode,
            "summarized": should_summarize,
        },
    )
    return returncode


def _capture_file(args: argparse.Namespace, settings: Settings) -> int:
    if not settings.enabled:
        if args.path == "-":
            shutil.copyfileobj(sys.stdin.buffer, sys.stdout.buffer)
        else:
            _emit_file(Path(args.path), sys.stdout.buffer)
        return 0
    artifact_id, evidence_id = _artifact_ids()
    artifact_dir = settings.root / artifact_id
    raw_path = artifact_dir / "stdout.raw"
    try:
        artifact_dir.mkdir(parents=True, exist_ok=False)
    except OSError:
        if args.path == "-":
            shutil.copyfileobj(sys.stdin.buffer, sys.stdout.buffer)
        else:
            _emit_file(Path(args.path), sys.stdout.buffer)
        return 0
    started = time.perf_counter()
    digest = hashlib.sha256()
    size = 0
    source: BinaryIO
    if args.path == "-":
        source = sys.stdin.buffer
    else:
        source = Path(args.path).open("rb")
    try:
        with raw_path.open("wb") as output:
            while True:
                chunk = source.read(64 * 1024)
                if not chunk:
                    break
                output.write(chunk)
                digest.update(chunk)
                size += len(chunk)
    finally:
        if args.path != "-":
            source.close()
    (artifact_dir / "stderr.raw").touch(mode=0o600)
    capture_ms = int((time.perf_counter() - started) * 1000)
    parse_started = time.perf_counter()
    try:
        summary = _summarize(raw_path, args.kind, args.source, settings)
        visible = _format_summary(
            artifact_id,
            evidence_id,
            summary,
            size,
            settings,
        )
    except Exception:
        _emit_file(raw_path, sys.stdout.buffer)
        shutil.rmtree(artifact_dir, ignore_errors=True)
        return 0
    parse_ms = int((time.perf_counter() - parse_started) * 1000)
    record = {
        "schema_version": 1,
        "artifact_id": artifact_id,
        "evidence_id": evidence_id,
        "created_at": _utcnow(),
        "project_id": os.environ.get("REDTRACE_PROJECT_ID"),
        "intent_id": os.environ.get("REDTRACE_INTENT_ID"),
        "worker": os.environ.get("REDTRACE_WORKER"),
        "phase": os.environ.get("REDTRACE_PHASE"),
        "source": args.source,
        "command": f"capture {args.path}",
        "kind": summary.kind,
        "returncode": 0,
        "stdout_bytes": size,
        "stderr_bytes": 0,
        "raw_bytes": size,
        "visible_bytes": len(visible.encode("utf-8")),
        "stdout_sha256": digest.hexdigest(),
        "stderr_sha256": hashlib.sha256(b"").hexdigest(),
        "summary_state": summary.state,
        "parse_ms": parse_ms,
        "command_duration_ms": capture_ms,
        "task_duration_ms": int((time.perf_counter() - started) * 1000),
        "peak_memory_bytes": _peak_memory_bytes(),
        "summarized": True,
    }
    try:
        _atomic_json(artifact_dir / "metadata.json", record)
    except OSError:
        _emit_file(raw_path, sys.stdout.buffer)
        return 0
    try:
        _append_jsonl(settings.root / "index.jsonl", record)
    except OSError:
        print(
            "[redtrace-context] Artifact index update failed; direct evidence-ID "
            "queries remain available",
            file=sys.stderr,
        )
    sys.stdout.write(visible)
    _record_metrics(settings.root, record)
    return 0


def _artifact_dir(root: Path, evidence_id: str) -> Path:
    if evidence_id.startswith("ev-"):
        evidence_id = "ctx-" + evidence_id[3:]
    if not re.fullmatch(r"ctx-[A-Za-z0-9-]{8,80}", evidence_id):
        raise ValueError("invalid evidence or artifact ID")
    path = root / evidence_id
    if not path.is_dir():
        raise FileNotFoundError(evidence_id)
    return path


def _query(args: argparse.Namespace, settings: Settings) -> int:
    try:
        directory = _artifact_dir(settings.root, args.evidence_id)
    except (ValueError, FileNotFoundError) as exc:
        print(f"redtrace-context: Artifact not found: {exc}", file=sys.stderr)
        return 2
    raw_path = directory / f"{args.stream}.raw"
    metadata_path = directory / "metadata.json"
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        metadata = {"artifact_id": directory.name}

    selector = bool(args.keyword or args.lines or args.offset is not None)
    if not selector:
        view = {
            key: metadata.get(key)
            for key in (
                "artifact_id",
                "evidence_id",
                "created_at",
                "source",
                "kind",
                "returncode",
                "raw_bytes",
                "stdout_bytes",
                "stderr_bytes",
                "stdout_sha256",
                "stderr_sha256",
            )
        }
        print(json.dumps(view, ensure_ascii=False, indent=2))
        print(
            "Select bounded content with --keyword, --lines, or --offset/--length.",
            file=sys.stderr,
        )
        return 0

    emitted = 0
    if args.keyword:
        pattern = re.compile(
            re.escape(args.keyword),
            re.IGNORECASE if args.ignore_case else 0,
        )
        with raw_path.open("r", encoding="utf-8", errors="replace") as stream:
            for number, line in enumerate(stream, start=1):
                if not pattern.search(line):
                    continue
                payload = f"{number}:{line}"
                encoded = payload.encode("utf-8")
                remaining = min(args.length, settings.query_bytes) - emitted
                if remaining <= 0:
                    break
                if len(encoded) > remaining:
                    chunk = encoded[:remaining].decode("utf-8", errors="ignore")
                    sys.stdout.write(chunk)
                    emitted += len(chunk.encode("utf-8"))
                    break
                sys.stdout.write(payload)
                emitted += len(encoded)
    elif args.lines:
        match = re.fullmatch(r"(\d+):(\d+)", args.lines)
        if not match:
            print("--lines must use start:end", file=sys.stderr)
            return 2
        start, end = map(int, match.groups())
        if start < 1 or end < start or end - start > 2000:
            print("invalid or excessive line range", file=sys.stderr)
            return 2
        with raw_path.open("r", encoding="utf-8", errors="replace") as stream:
            for number, line in enumerate(stream, start=1):
                if number < start:
                    continue
                if number > end:
                    break
                encoded = line.encode("utf-8")
                remaining = min(args.length, settings.query_bytes) - emitted
                if remaining <= 0:
                    break
                if len(encoded) > remaining:
                    chunk = encoded[:remaining].decode("utf-8", errors="ignore")
                    sys.stdout.write(chunk)
                    emitted += len(chunk.encode("utf-8"))
                    break
                sys.stdout.write(line)
                emitted += len(encoded)
    else:
        length = min(args.length, settings.query_bytes)
        with raw_path.open("rb") as stream:
            stream.seek(max(0, args.offset or 0))
            data = stream.read(length)
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
        emitted = len(data)

    _append_jsonl(
        settings.root / "queries.jsonl",
        {
            "timestamp": _utcnow(),
            "artifact_id": directory.name,
            "evidence_id": metadata.get("evidence_id"),
            "stream": args.stream,
            "keyword": args.keyword,
            "lines": args.lines,
            "offset": args.offset,
            "requested_bytes": args.length,
            "output_bytes": emitted,
            "project_id": os.environ.get("REDTRACE_PROJECT_ID"),
            "worker": os.environ.get("REDTRACE_WORKER"),
            "intent_id": os.environ.get("REDTRACE_INTENT_ID"),
        },
    )
    return 0


def _list_artifacts(args: argparse.Namespace, settings: Settings) -> int:
    index = settings.root / "index.jsonl"
    if not index.is_file():
        print("[]")
        return 0
    values: deque[dict[str, Any]] = deque(maxlen=args.limit)
    with index.open("r", encoding="utf-8", errors="replace") as stream:
        for line in stream:
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                continue
            if args.kind and item.get("kind") != args.kind:
                continue
            values.append(item)
    compact = [
        {
            key: item.get(key)
            for key in (
                "artifact_id",
                "evidence_id",
                "created_at",
                "source",
                "kind",
                "raw_bytes",
                "returncode",
            )
        }
        for item in reversed(values)
    ]
    print(json.dumps(compact, ensure_ascii=False, indent=2))
    return 0


def _metrics(args: argparse.Namespace, settings: Settings) -> int:
    metrics_path = settings.root / "metrics.jsonl"
    values: deque[dict[str, Any]] = deque(maxlen=args.limit)
    if metrics_path.is_file():
        with metrics_path.open("r", encoding="utf-8", errors="replace") as stream:
            for line in stream:
                try:
                    values.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    raw = sum(int(item.get("raw_bytes") or 0) for item in values)
    visible = sum(int(item.get("visible_bytes") or 0) for item in values)
    queries_path = settings.root / "queries.jsonl"
    query_count = 0
    if queries_path.is_file():
        with queries_path.open("rb") as stream:
            query_count = sum(1 for _ in stream)
    result = {
        "runs": len(values),
        "raw_bytes": raw,
        "agent_visible_bytes": visible,
        "estimated_raw_tokens": (raw + 3) // 4,
        "estimated_agent_visible_tokens": (visible + 3) // 4,
        "token_reduction_rate": round(0.0 if not raw else max(0.0, 1 - visible / raw), 6),
        "additional_queries": query_count,
        "parse_ms": sum(int(item.get("parse_ms") or 0) for item in values),
        "task_duration_ms": sum(int(item.get("task_duration_ms") or 0) for item in values),
        "peak_memory_bytes": max(
            (int(item.get("peak_memory_bytes") or 0) for item in values),
            default=0,
        ),
        "failed_runs": sum(1 for item in values if item.get("returncode")),
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="redtrace-context",
        description="Post-RTK security-output Artifact and context harness",
    )
    subparsers = parser.add_subparsers(dest="command_name", required=True)

    run = subparsers.add_parser("run", help="run a command and summarize only high-volume output")
    run.add_argument("--kind", default="auto", choices=("auto", "text", "security-text", "json", "jsonl", "xml", "http", "web", "har", "binary"))
    run.add_argument("--source", help="stable URL/target label used for DOM/network change detection")
    run.add_argument("--passthrough", action="store_true", help="tee raw streams in real time while retaining an Artifact")
    run.add_argument("--keep-small", action="store_true", help="retain small plain-text outputs too")
    run.add_argument("command", nargs=argparse.REMAINDER)

    capture = subparsers.add_parser("capture", help="capture a file or stdin as an Artifact")
    capture.add_argument("path", nargs="?", default="-")
    capture.add_argument("--kind", default="auto", choices=("auto", "text", "security-text", "json", "jsonl", "xml", "http", "web", "har", "binary"))
    capture.add_argument("--source")

    query = subparsers.add_parser("query", help="perform a bounded Artifact query")
    query.add_argument("evidence_id")
    query.add_argument("--stream", choices=("stdout", "stderr"), default="stdout")
    query.add_argument("--keyword")
    query.add_argument("--ignore-case", action="store_true")
    query.add_argument("--lines")
    query.add_argument("--offset", type=int)
    query.add_argument("--length", type=int, default=8192)

    listing = subparsers.add_parser("list", help="list recent Artifact metadata")
    listing.add_argument("--limit", type=int, default=20)
    listing.add_argument("--kind")

    metrics = subparsers.add_parser("metrics", help="aggregate context-harness performance metrics")
    metrics.add_argument("--limit", type=int, default=10000)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    settings = Settings.from_env()
    if args.command_name == "run":
        return _run_command(args, settings)
    if args.command_name == "capture":
        return _capture_file(args, settings)
    if args.command_name == "query":
        args.length = max(1, min(args.length, settings.query_bytes))
        return _query(args, settings)
    if args.command_name == "list":
        args.limit = max(1, min(args.limit, 200))
        return _list_artifacts(args, settings)
    if args.command_name == "metrics":
        args.limit = max(1, min(args.limit, 100_000))
        return _metrics(args, settings)
    parser.error("unknown command")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
