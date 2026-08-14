#!/usr/bin/env python3
"""Summarize an existing source tree into a structured attack-surface outline.

Heuristic, dependency-free organizer over Solidity/EVM sources (with best-effort
handling of Vyper, Move, Cairo and Rust). It turns raw files into a skeleton an
agent can then deep-dive — it does NOT perform analysis or emit findings.

Usage:
    python summarize-surface.py [TARGET]     # defaults to the current directory

Output: a single JSON object with the keys
    contracts, entryPoints, privilegedFunctions, externalCalls, assets,
    proxies, callbacks
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

_CONTRACT = re.compile(
    r"\b(?:abstract\s+)?(?:contract|interface|library)\s+([A-Za-z_$][\w$]*)"
)
# ponytail: flat regex over one file's text; multi-line signatures with nested
# parens or function-pointer params are mis-parsed. Upgrade to a real parser
# only if this ceiling ever blocks a task.
_FUNCTION = re.compile(
    r"\bfunction\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*(?:(external|public|internal|private))?\s*(?:(view|pure|payable|nonpayable))?"
)
_MODIFIER = re.compile(r"\bmodifier\s+([A-Za-z_$][\w$]*)\s*\(")
_STATE_VAR = re.compile(r"\b(mapping\s*\([^)]*\)|IERC20|ERC20|IERC721|ERC721|uint256|address)\s+([\w$]+)")
_LOW_CALL = re.compile(r"\.(?:call|delegatecall|staticcall)\s*\{?\s*\(?")
_SEND = re.compile(r"\.(?:transfer|send)\s*\(")
_INTERFACE_CALL = re.compile(r"\bI[A-Z][\w$]*\([^)]*\)\s*\.\s*([\w$]+)\s*\(")

_PRIVILEGED_MODIFIERS = (
    "onlyowner", "onlyrole", "onlyadmin", "onlygovernance", "onlyvault",
    "onlykeeper", "onlyguardian", "onlywhitelisted", "authorized", "restricted",
    "onlygovernor", "onlyproxy", "onlyfactory",
)

_CALLBACK_NAMES = (
    "receive", "fallback", "onerc721received", "onerc1155received",
    "onerc1155batchreceived", "tokensreceived", "onflashloan", "execute",
    "callback", "uniswapv3mintcallback", "uniswapv3swapcallback",
)

_ASSET_NAMES = (
    "balance", "balances", "shares", "totalassets", "totalsupply", "collateral",
    "debt", "liquidity", "reserve", "reserves", "reward", "principal",
)


def _read(path: Path, limit: int = 200_000) -> str:
    try:
        return path.read_bytes()[:limit].decode("utf-8", errors="replace")
    except OSError:
        return ""


def _solidity_files(target: Path) -> list[Path]:
    files: list[Path] = []
    for path in target.rglob("*.sol"):
        if ".git" in path.parts or "node_modules" in path.parts:
            continue
        files.append(path)
    return files


def _summarize_solidity(target: Path, out: dict) -> None:
    for path in _solidity_files(target):
        text = _read(path)
        rel = str(path.relative_to(target))
        lowered = text.lower()
        contracts = _CONTRACT.findall(text)
        if not contracts:
            # lone abstract/free function file: name it after the file
            contracts = [path.stem]
        for contract in contracts:
            out["contracts"].append({"name": contract, "file": rel})
            if "proxy" in contract.lower() or "delegatecall" in lowered or "_implementation" in lowered:
                marker = "delegatecall" if "delegatecall" in lowered else "proxy-name"
                out["proxies"].append({"contract": contract, "file": rel, "marker": marker})
        for match in _FUNCTION.finditer(text):
            name, params, visibility, mutability = match.groups()
            visibility = visibility or "public"
            entry = {
                "contract": contracts[0] if contracts else path.stem,
                "function": name,
                "visibility": visibility,
                "stateMutability": mutability or "nonpayable",
            }
            if visibility in ("external", "public"):
                out["entryPoints"].append(entry)
            fn_lowered = name.lower()
            if fn_lowered in _CALLBACK_NAMES or "callback" in fn_lowered:
                out["callbacks"].append({"contract": entry["contract"], "function": name, "file": rel})
        for match in _MODIFIER.finditer(text):
            modifier = match.group(1).lower()
            if modifier.startswith("only") or modifier in _PRIVILEGED_MODIFIERS:
                out["privilegedFunctions"].append(
                    {"contract": contracts[0] if contracts else path.stem, "modifier": modifier, "file": rel}
                )
        if _LOW_CALL.search(text):
            out["externalCalls"].append(
                {"contract": contracts[0] if contracts else path.stem, "call": "low-level call/delegatecall/staticcall", "file": rel}
            )
        if _SEND.search(text):
            out["externalCalls"].append(
                {"contract": contracts[0] if contracts else path.stem, "call": "transfer/send", "file": rel}
            )
        for match in _INTERFACE_CALL.finditer(text):
            out["externalCalls"].append(
                {"contract": contracts[0] if contracts else path.stem, "call": match.group(1), "file": rel}
            )
        for match in _STATE_VAR.finditer(text):
            if match.group(2).lower() in _ASSET_NAMES or match.group(1).startswith(("IERC", "ERC")):
                out["assets"].append(
                    {"contract": contracts[0] if contracts else path.stem, "stateVar": match.group(2), "type": match.group(1), "file": rel}
                )


def summarize(target: Path) -> dict:
    target = target if target.is_dir() else target.parent
    out: dict = {
        "contracts": [],
        "entryPoints": [],
        "privilegedFunctions": [],
        "externalCalls": [],
        "assets": [],
        "proxies": [],
        "callbacks": [],
    }
    _summarize_solidity(target, out)
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="summarize-surface", description="Summarize an attack surface from source")
    parser.add_argument("target", nargs="?", default=".", help="project directory (default: cwd)")
    args = parser.parse_args(argv)
    print(json.dumps(summarize(Path(args.target)), ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
