#!/usr/bin/env python3
"""Generate /opt/redtrace/toolchain-manifest.json from a curated command list.

Each entry records name/version/category/path so Worker and humans can confirm
what tooling is actually available in the image (spec §26).

Usage: python3 toolchain-manifest.py [--category web,binary,ai,blockchain,agent,data,runtime]
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

# name -> (category, version-flags). A missing version flag means "no -V/--version".
TOOLS: dict[str, tuple[str, tuple[str, ...]]] = {
    # runtime / compilers
    "python3": ("runtime", ("--version",)),
    "uv": ("runtime", ("--version",)),
    "node": ("runtime", ("--version",)),
    "npm": ("runtime", ("--version",)),
    "pnpm": ("runtime", ("--version",)),
    "cargo": ("runtime", ("--version",)),
    "rustc": ("runtime", ("--version",)),
    "go": ("runtime", ("version",)),
    "java": ("runtime", ("-version",)),
    "ruby": ("runtime", ("--version",)),
    "perl": ("runtime", ("--version",)),
    "gcc": ("runtime", ("--version",)),
    "clang": ("runtime", ("--version",)),
    # agent CLIs
    "claude": ("agent", ("--version",)),
    "codex": ("agent", ("--version",)),
    "pi": ("agent", ("--version",)),
    # web
    "curl": ("web", ("--version",)),
    "wget": ("web", ("--version",)),
    "openssl": ("web", ("version",)),
    "nmap": ("web", ("--version",)),
    "nc": ("web", ()),
    "socat": ("web", ("-V",)),
    "httpx": ("web", ("-version",)),
    "ffuf": ("web", ("-V",)),
    "feroxbuster": ("web", ("--version",)),
    "dirsearch": ("web", ("--version",)),
    "arjun": ("web", ("--version",)),
    "katana": ("web", ("-version",)),
    "whatweb": ("web", ("--version",)),
    "wafw00f": ("web", ("--version",)),
    "nuclei": ("web", ("-version",)),
    "nikto": ("web", ("-Version",)),
    "sqlmap": ("web", ("--version",)),
    "dalfox": ("web", ("version",)),
    "commix": ("web", ("--version",)),
    "sstimap": ("web", ("--help",)),
    "jwt_tool": ("web", ("--help",)),
    "grpcurl": ("web", ("-version",)),
    "websocat": ("web", ("-V",)),
    "jq": ("web", ("--version",)),
    "sqlite3": ("web", ("--version",)),
    "semgrep": ("web", ("--version",)),
    "gitleaks": ("web", ("version",)),
    "syft": ("web", ("version",)),
    "grype": ("web", ("version",)),
    "john": ("web", ("--version",)),
    "hashcat": ("web", ("--version",)),
    # binary
    "file": ("binary", ("--version",)),
    "strings": ("binary", ("--version",)),
    "readelf": ("binary", ("--version",)),
    "objdump": ("binary", ("--version",)),
    "patchelf": ("binary", ("--version",)),
    "checksec": ("binary", ("--version",)),
    "binwalk": ("binary", ("--help",)),
    "upx": ("binary", ("--version",)),
    "radare2": ("binary", ("-v",)),
    "gdb": ("binary", ("--version",)),
    "strace": ("binary", ("-V",)),
    "ltrace": ("binary", ("-V",)),
    "ROPgadget": ("binary", ("--version",)),
    "ropper": ("binary", ("--version",)),
    "one_gadget": ("binary", ("--version",)),
    "seccomp-tools": ("binary", ("version",)),
    "qemu-x86_64": ("binary", ("--version",)),
    "qemu-aarch64": ("binary", ("--version",)),
    "analyzeHeadless": ("binary", ()),
    "RsaCtfTool": ("binary", ("--version",)),
    "jadx": ("binary", ("--version",)),
    "apktool": ("binary", ("--version",)),
    "pwndbg": ("binary", ("--version",)),
    "pwninit": ("binary", ("--version",)),
    "uncompyle6": ("binary", ("--version",)),
    "pycdc": ("binary", ("--version",)),
    "wasm-tools": ("binary", ("--version",)),
    "ilspycmd": ("binary", ("--version",)),
    # ai
    "promptfoo": ("ai", ("--version",)),
    "mitmproxy": ("ai", ("--version",)),
    "promptmap2": ("ai", ("--help",)),
    "inspect": ("ai", ("--version",)),
    "agent-threat-bench": ("ai", ("--help",)),
    # blockchain
    "forge": ("blockchain", ("--version",)),
    "cast": ("blockchain", ("--version",)),
    "anvil": ("blockchain", ("--version",)),
    "chisel": ("blockchain", ("--version",)),
    "solc": ("blockchain", ("--version",)),
    "solc-select": ("blockchain", ("--version",)),
    "slither": ("blockchain", ("--version",)),
    "crytic-compile": ("blockchain", ("--version",)),
    "echidna": ("blockchain", ("--version",)),
    "halmos": ("blockchain", ("--version",)),
    "aderyn": ("blockchain", ("--version",)),
    "heimdall": ("blockchain", ("--version",)),
    "myth": ("blockchain", ("version",)),
    "solana": ("blockchain", ("--version",)),
    "solana-test-validator": ("blockchain", ("--version",)),
    "cargo-build-sbf": ("blockchain", ("--version",)),
    "anchor": ("blockchain", ("--version",)),
    "sui": ("blockchain", ("--version",)),
    "aptos": ("blockchain", ("--version",)),
    "move": ("blockchain", ()),
    "scarb": ("blockchain", ("--version",)),
    "snforge": ("blockchain", ("--version",)),
    "sncast": ("blockchain", ("--version",)),
    "starknet-devnet": ("blockchain", ("--version",)),
    "blueprint": ("blockchain", ("--version",)),
    "tact": ("blockchain", ("--version",)),
    "wasmd": ("blockchain", ("version",)),
    "cosmwasm-check": ("blockchain", ("--version",)),
    "cargo-contract": ("blockchain", ("--version",)),
    "substrate-contracts-node": ("blockchain", ("--version",)),
}


def _run_version(argv: list[str]) -> str:
    try:
        proc = subprocess.run(
            argv, capture_output=True, text=True, timeout=20
        )
    except (OSError, subprocess.TimeoutExpired):
        return ""
    out = (proc.stdout or "") + (proc.stderr or "")
    return " ".join(out.strip().splitlines())[:200]


def build_manifest(only: set[str] | None = None) -> list[dict]:
    manifest: list[dict] = []
    for name, (category, flags) in TOOLS.items():
        if only and category not in only:
            continue
        path = shutil.which(name)
        version = _run_version([name, *flags]) if (path and flags) else ""
        manifest.append(
            {
                "name": name,
                "version": version,
                "category": category,
                "path": path or "",
                "available": bool(path),
            }
        )
    return manifest


def main() -> int:
    only = None
    if len(sys.argv) > 1:
        only = set(sys.argv[1].removeprefix("--category=").split(","))
    manifest = build_manifest(only)
    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
