#!/usr/bin/env python3
"""Detect a blockchain project's stack from its filesystem layout.

Dependency-free and read-only: it inspects build-system markers and source
pragmas only. It does NOT judge vulnerabilities and does NOT reach the network.

Usage:
    python detect-stack.py [TARGET]     # defaults to the current directory

Output: a single JSON object, e.g.
    {"chain": "evm", "vm": "evm", "language": "solidity",
     "framework": "foundry", "proxy": true, "protocolHints": ["vault", "erc4626"]}
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

SOLIDITY_PRAGMA = re.compile(r"^\s*pragma\s+solidity\b", re.MULTILINE)
VYPER_VERSION = re.compile(r"^\s*#\s*@version\b", re.MULTILINE)
SUI_IMPORT = re.compile(r"\b(sui|sui_system)\s*::", re.MULTILINE)
APTOS_IMPORT = re.compile(r"\baptos_framework\s*::", re.MULTILINE)

# filename/body marker -> protocol hint
_PROTOCOL_MARKERS: dict[str, tuple[str, ...]] = {
    "vault": ("erc4626", "vault", "converttoshares", "converttoshares", "convertToShares", "convertToAssets", "vault.sol"),
    "lending": ("lending", "borrow", "collateral", "liquidation", "healthfactor", "comptroller", "aave", "compound"),
    "dex": ("uniswap", "amm", "swap", "liquidity", "pool", "dex", "curve", "balancer"),
    "staking": ("staking", "stake", "reward", "unstake", "rewarddebt"),
    "governance": ("governor", "governance", "vote", "proposal", "delegate", "timelock"),
    "bridge": ("bridge", "cross-chain", "crosschain", "relayer", "message", "wrapped"),
    "oracle": ("oracle", "chainlink", "aggregator", "twap", "pricefeed", "price"),
    "nft": ("erc721", "erc1155", "nft", "tokenuri"),
    "token": ("erc20", "token", "permit"),
    "account-abstraction": ("entrypoint", "useroperation", "userop", "account abstraction", "erc4337", "smart account"),
}

# build-system / runtime markers, first match wins
_FRAMEWORK_MARKERS: list[tuple[str, str, str, str]] = [
    # (filename glob-ish prefix, chain, language, framework)
    ("Anchor.toml", "solana", "rust", "anchor"),
    ("Move.toml", "move", "move", "move"),
    ("Scarb.toml", "starknet", "cairo", "scarb"),
    ("foundry.toml", "evm", "solidity", "foundry"),
    ("hardhat.config", "evm", "solidity", "hardhat"),
    ("truffle-config", "evm", "solidity", "truffle"),
    ("brownie-config", "evm", "solidity", "brownie"),
    ("ape-config", "evm", "solidity", "ape"),
]


def _read(path: Path, limit: int = 200_000) -> str:
    try:
        data = path.read_bytes()[:limit]
        return data.decode("utf-8", errors="replace")
    except OSError:
        return ""


def _rglob_files(target: Path, suffixes: tuple[str, ...], max_files: int = 400) -> list[Path]:
    files: list[Path] = []
    for suffix in suffixes:
        for path in target.rglob(f"*{suffix}"):
            if ".git" in path.parts or "node_modules" in path.parts:
                continue
            files.append(path)
            if len(files) >= max_files:
                return files
    return files


def _first_marker_file(target: Path, prefixes: tuple[str, ...]) -> Path | None:
    for path in target.rglob("*"):
        if ".git" in path.parts or "node_modules" in path.parts:
            continue
        if path.is_file() and any(path.name == prefix or path.name.startswith(prefix) for prefix in prefixes):
            return path
    return None


def _proxy_detected(solidity_text: str, filenames: list[str]) -> bool:
    lowered_names = " ".join(filenames).lower()
    if "proxy" in lowered_names:
        return True
    for marker in ("delegatecall", "upgradeTo", "_setImplementation", "transparent proxy", "beacon"):
        if marker in solidity_text:
            return True
    return False


def _protocol_hints(text: str, filenames: list[str]) -> list[str]:
    haystack = f"{text}\n{' '.join(filenames)}".lower()
    hints: list[str] = []
    for hint, markers in _PROTOCOL_MARKERS.items():
        if any(marker.lower() in haystack for marker in markers):
            hints.append(hint)
    return sorted(hints)


def _evm_language(target: Path) -> str | None:
    solidity_files = _rglob_files(target, (".sol",), max_files=20)
    vyper_files = _rglob_files(target, (".vy",), max_files=20)
    if solidity_files:
        return "solidity"
    if vyper_files:
        return "vyper"
    return None


def _move_flavor(target: Path, move_toml_text: str) -> str:
    combined = move_toml_text
    for path in _rglob_files(target, (".move",), max_files=60):
        combined += "\n" + _read(path, 20_000)
    if APTOS_IMPORT.search(combined) or "aptosframework" in combined.lower():
        return "aptos"
    return "sui"


def detect(target: Path) -> dict:
    """Return a stack-detection dict for *target*."""
    target = target if target.is_dir() else target.parent

    # 1. Explicit build-system / runtime markers.
    for prefix, chain, language, framework in _FRAMEWORK_MARKERS:
        marker = _first_marker_file(target, (prefix,))
        if marker is None:
            continue
        text = _read(marker, 200_000)
        result = {
            "chain": chain,
            "vm": chain,
            "language": language,
            "framework": framework,
            "proxy": False,
            "protocolHints": [],
        }
        if prefix == "Move.toml":
            result["chain"] = _move_flavor(target, text)
        if prefix == "Scarb.toml":
            result["chain"] = "starknet"
        # Gather protocol hints from the same sources later.
        return _enrich(target, result)

    # 2. Rust / Wasm chains via Cargo.toml.
    cargo = target / "Cargo.toml"
    if cargo.is_file():
        cargo_text = _read(cargo, 200_000)
        lowered = cargo_text.lower()
        if any(word in lowered for word in ("substrate", "frame", "pallet", "ink!")):
            return _enrich(target, {"chain": "substrate", "vm": "substrate", "language": "rust", "framework": "cargo", "proxy": False, "protocolHints": []})
        if any(word in lowered for word in ("cosmwasm", "cosmos", "cw-storage")):
            return _enrich(target, {"chain": "cosmos", "vm": "wasm", "language": "rust", "framework": "cosmwasm", "proxy": False, "protocolHints": []})
        if any(word in lowered for word in ("solana-program", "anchor-lang", "anchor")):
            return _enrich(target, {"chain": "solana", "vm": "solana", "language": "rust", "framework": "anchor", "proxy": False, "protocolHints": []})

    # 3. TON (FunC / Tact sources).
    if _rglob_files(target, (".fc", ".tact"), max_files=5):
        return _enrich(target, {"chain": "ton", "vm": "tvm", "language": "func", "framework": "tact", "proxy": False, "protocolHints": []})

    # 4. EVM language by source extension.
    language = _evm_language(target)
    if language:
        return _enrich(target, {"chain": "evm", "vm": "evm", "language": language, "framework": "none", "proxy": False, "protocolHints": []})

    # 5. Node ecosystem without Solidity sources yet.
    if (target / "package.json").is_file():
        return _enrich(target, {"chain": "evm", "vm": "evm", "language": "solidity", "framework": "node", "proxy": False, "protocolHints": []})

    return _enrich(target, {"chain": "unknown", "vm": "unknown", "language": "unknown", "framework": "none", "proxy": False, "protocolHints": []})


def _enrich(target: Path, result: dict) -> dict:
    """Fill proxy flag and protocolHints from source contents."""
    text_parts: list[str] = []
    filenames: list[str] = []
    suffixes = (".sol", ".vy", ".move", ".cairo", ".rs", ".fc", ".tact")
    for path in _rglob_files(target, suffixes, max_files=300):
        filenames.append(path.name)
        text_parts.append(_read(path, 50_000))
    combined = "\n".join(text_parts)
    result["proxy"] = _proxy_detected(combined, filenames) if result["chain"] in ("evm", "unknown") else result.get("proxy", False)
    result["protocolHints"] = _protocol_hints(combined, filenames)
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="detect-stack", description="Detect a blockchain project's stack")
    parser.add_argument("target", nargs="?", default=".", help="project directory (default: cwd)")
    args = parser.parse_args(argv)
    print(json.dumps(detect(Path(args.target)), ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
