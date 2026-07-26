#!/usr/bin/env python3
"""Before/after benchmark using real curl and nmap tasks against a local target."""

from __future__ import annotations

import argparse
import hashlib
import http.server
import json
import os
import shutil
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any


PAGE = (
    "<!doctype html><html><head><title>RedTrace Harness Target</title></head>"
    "<body><h1>Admin Login</h1><form method='post' action='/login'>"
    "<input name='username'><input name='password' type='password'>"
    "<button>Sign in</button></form><pre>"
    + ("diagnostic-line\n" * 8000)
    + "</pre></body></html>"
).encode()


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(PAGE)))
        self.end_headers()
        self.wfile.write(PAGE)

    def log_message(self, _format: str, *_args: object) -> None:
        return


class QuietServer(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, _request: object, _client_address: object) -> None:
        return


def _run(command: list[str], env: dict[str, str] | None = None) -> dict[str, Any]:
    started = time.perf_counter()
    result = subprocess.run(
        command,
        capture_output=True,
        env=env,
        timeout=60,
    )
    return {
        "command": command,
        "returncode": result.returncode,
        "stdout": result.stdout,
        "stderr": result.stderr,
        "duration_ms": int((time.perf_counter() - started) * 1000),
    }


def _artifact_record(root: Path) -> dict[str, Any]:
    index = root / "index.jsonl"
    line = index.read_text(encoding="utf-8").splitlines()[-1]
    return json.loads(line)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(256 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _file_contains(path: Path, marker: bytes) -> bool:
    overlap = b""
    with path.open("rb") as stream:
        while chunk := stream.read(64 * 1024):
            value = overlap + chunk
            if marker in value:
                return True
            overlap = value[-max(0, len(marker) - 1) :]
    return False


def _harness_run(
    command: list[str],
    kind: str,
    source: str,
    cli: Path,
) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="redtrace-context-bench-") as directory:
        root = Path(directory)
        env = {
            **os.environ,
            "REDTRACE_CONTEXT_ARTIFACT_ROOT": str(root),
            "REDTRACE_CONTEXT_INLINE_BYTES": "1024",
            "REDTRACE_CONTEXT_VISIBLE_BYTES": "4096",
        }
        harnessed = _run(
            [
                sys.executable,
                str(cli),
                "run",
                "--kind",
                kind,
                "--source",
                source,
                "--",
                *command,
            ],
            env,
        )
        record = _artifact_record(root)
        raw = root / record["artifact_id"] / "stdout.raw"
        raw_digest = _sha256_file(raw)
        semantic_markers = {
            "http": b"200 OK",
            "xml": b'state="open"',
        }
        marker = semantic_markers.get(kind)
        semantic_success = marker is None or _file_contains(raw, marker)
        digest_verified = raw_digest == record["stdout_sha256"]
    return {
        "run": harnessed,
        "record": record,
        "semantic_success": semantic_success,
        "digest_verified": digest_verified,
    }


def _case(
    name: str,
    command: list[str],
    kind: str,
    source: str,
    cli: Path,
) -> dict[str, Any]:
    baseline = _run(command)
    harness = _harness_run(command, kind, source, cli)
    harnessed = harness["run"]
    record = harness["record"]
    marker = b"200 OK" if kind == "http" else b'state="open"' if kind == "xml" else None
    baseline_semantic_success = marker is None or marker in baseline["stdout"]
    success_preserved = (
        baseline["returncode"] == harnessed["returncode"]
        and baseline_semantic_success == harness["semantic_success"]
        and harness["digest_verified"]
    )
    return {
        "name": name,
        "success_preserved": success_preserved,
        "baseline_exit_code": baseline["returncode"],
        "harness_exit_code": harnessed["returncode"],
        "baseline_duration_ms": baseline["duration_ms"],
        "harness_duration_ms": harnessed["duration_ms"],
        "overhead_ms": harnessed["duration_ms"] - baseline["duration_ms"],
        "raw_bytes": record["raw_bytes"],
        "agent_visible_bytes": len(harnessed["stdout"]),
        "token_reduction_rate": round(
            max(0.0, 1 - len(harnessed["stdout"]) / max(1, record["raw_bytes"])),
            6,
        ),
        "parse_ms": record["parse_ms"],
        "peak_memory_bytes": record["peak_memory_bytes"],
        "artifact_digest_verified": harness["digest_verified"],
        "semantic_success_preserved": (
            baseline_semantic_success == harness["semantic_success"]
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument(
        "--context-cli",
        type=Path,
        default=Path(__file__).parents[1] / "src" / "redtrace" / "context_cli.py",
    )
    parser.add_argument(
        "--enforce",
        action="store_true",
        help="exit non-zero if success/concurrency regressions are detected",
    )
    args = parser.parse_args()

    with QuietServer(("127.0.0.1", 0), Handler) as server:
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        url = f"http://127.0.0.1:{port}/"
        cases: list[tuple[str, list[str], str, str]] = []
        curl = shutil.which("curl")
        if curl:
            cases.append(("http-page", [curl, "-sS", "-i", url], "http", url))
        nmap = shutil.which("nmap")
        if nmap:
            cases.append(
                (
                    "nmap-xml",
                    [
                        nmap,
                        "-sT",
                        "-sV",
                        "--version-light",
                        "-Pn",
                        "-p",
                        str(port),
                        "-oX",
                        "-",
                        "127.0.0.1",
                    ],
                    "xml",
                    f"127.0.0.1:{port}",
                )
            )
        if not cases:
            print(json.dumps({"error": "curl and nmap are unavailable"}))
            return 2

        results = [
            _case(name, command, kind, source, args.context_cli)
            for name, command, kind, source in cases
        ]
        concurrency = max(1, min(args.concurrency, 16))
        concurrency_case = next(
            (case for case in cases if case[0] == "nmap-xml"),
            cases[0],
        )
        baseline_concurrent_started = time.perf_counter()
        with ThreadPoolExecutor(max_workers=concurrency) as executor:
            baseline_concurrent = list(
                executor.map(
                    lambda _: _run(concurrency_case[1]),
                    range(concurrency),
                )
            )
        baseline_concurrent_ms = int(
            (time.perf_counter() - baseline_concurrent_started) * 1000
        )
        harness_concurrent_started = time.perf_counter()
        with ThreadPoolExecutor(max_workers=concurrency) as executor:
            harness_concurrent = list(
                executor.map(
                    lambda _: _harness_run(
                        concurrency_case[1],
                        concurrency_case[2],
                        concurrency_case[3],
                        args.context_cli,
                    ),
                    range(concurrency),
                )
            )
        harness_concurrent_ms = int(
            (time.perf_counter() - harness_concurrent_started) * 1000
        )
        server.shutdown()

    report = {
        "schema_version": 1,
        "target": "ephemeral localhost HTTP service",
        "tools": [case[0] for case in cases],
        "cases": results,
        "concurrency": {
            "workers": concurrency,
            "baseline_duration_ms": baseline_concurrent_ms,
            "harness_duration_ms": harness_concurrent_ms,
            "throughput_ratio": round(
                baseline_concurrent_ms / max(1, harness_concurrent_ms),
                6,
            ),
            "all_success_preserved": all(
                baseline["returncode"] == harness["run"]["returncode"]
                and harness["semantic_success"]
                and harness["digest_verified"]
                for baseline, harness in zip(
                    baseline_concurrent,
                    harness_concurrent,
                    strict=True,
                )
            ),
            "max_peak_memory_bytes": max(
                item["record"]["peak_memory_bytes"] for item in harness_concurrent
            ),
        },
        "success_rate_preserved": all(item["success_preserved"] for item in results),
        "performance_preserved": all(
            item["overhead_ms"] <= max(500, item["baseline_duration_ms"] * 0.15)
            for item in results
        ),
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if args.enforce and (
        not report["success_rate_preserved"]
        or not report["concurrency"]["all_success_preserved"]
        or not report["performance_preserved"]
        or report["concurrency"]["throughput_ratio"] < 0.85
    ):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
