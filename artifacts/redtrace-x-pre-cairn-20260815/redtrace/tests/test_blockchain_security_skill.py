from __future__ import annotations

import importlib.util
import json
import os
import re
from pathlib import Path

import pytest
import yaml

from redtrace.capabilities import CapabilityStore


REPO_ROOT = Path(__file__).resolve().parents[2]
SKILLS_DIR = REPO_ROOT / "skills"
SKILL_DIR = SKILLS_DIR / "blockchain-security"


def _load_detect_stack():
    path = SKILL_DIR / "scripts" / "detect-stack.py"
    spec = importlib.util.spec_from_file_location("detect_stack", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _frontmatter() -> dict:
    content = (SKILL_DIR / "SKILL.md").read_text(encoding="utf-8")
    match = re.match(r"^---\n(.*?)\n---", content, re.DOTALL)
    assert match, "blockchain-security SKILL.md has invalid frontmatter"
    data = yaml.safe_load(match.group(1))
    assert isinstance(data, dict)
    return data


def test_blockchain_security_is_discovered_and_well_formed() -> None:
    store = CapabilityStore(REPO_ROOT)
    names = {skill.name for skill in store.list_skills()}
    assert "blockchain-security" in names
    record = store.get_skill("blockchain-security")
    assert record.enabled is True
    assert record.name == "blockchain-security"


def test_frontmatter_name_matches_canonical_id() -> None:
    assert _frontmatter()["name"] == "blockchain-security"


def test_description_is_nonempty_single_line() -> None:
    description = _frontmatter()["description"]
    assert isinstance(description, str) and description.strip()
    assert len(description) <= 1024
    assert "\n" not in description and "\r" not in description
    assert "<" not in description and ">" not in description


def test_skill_md_within_redtrace_size_limit() -> None:
    content = (SKILL_DIR / "SKILL.md").read_text(encoding="utf-8")
    assert not content.startswith("﻿")
    assert len(content) <= 65_536


def test_references_are_scannable_and_complete() -> None:
    expected = {
        "methodology.md",
        "attack-surface.md",
        "vulnerability-taxonomy.md",
        "defi-invariants.md",
        "exploit-validation.md",
        "tool-workflows.md",
        "evm-solidity.md",
        "solana.md",
        "move.md",
        "cairo.md",
        "ton-cosmos-substrate.md",
        "case-patterns.md",
    }
    refs_dir = SKILL_DIR / "references"
    assert refs_dir.is_dir()
    actual = {p.name for p in refs_dir.iterdir() if p.suffix == ".md"}
    assert actual == expected
    for name in expected:
        text = (refs_dir / name).read_text(encoding="utf-8")
        assert text.strip(), f"{name} is empty"


def test_scripts_are_executable_and_runnable() -> None:
    for name in ("detect-stack.py", "summarize-surface.py"):
        path = SKILL_DIR / "scripts" / name
        assert path.is_file()
        assert path.stat().st_mode & 0o111, f"{name} is not executable"
        assert path.read_text(encoding="utf-8").startswith("#!/usr/bin/env python3")


@pytest.mark.parametrize(
    ("marker", "expected"),
    [
        ("foundry.toml", {"chain": "evm", "framework": "foundry", "language": "solidity"}),
        ("hardhat.config.ts", {"chain": "evm", "framework": "hardhat", "language": "solidity"}),
        ("Anchor.toml", {"chain": "solana", "framework": "anchor"}),
        ("Scarb.toml", {"chain": "starknet", "framework": "scarb"}),
    ],
)
def test_detect_stack_build_systems(tmp_path: Path, marker: str, expected: dict) -> None:
    (tmp_path / marker).write_text("", encoding="utf-8")
    module = _load_detect_stack()
    result = module.detect(tmp_path)
    for key, value in expected.items():
        assert result[key] == value


def test_detect_stack_move_sui_and_aptos(tmp_path: Path) -> None:
    module = _load_detect_stack()
    (tmp_path / "Move.toml").write_text("[package]\nname = \"p\"\n", encoding="utf-8")
    sources = tmp_path / "sources"
    sources.mkdir()
    (sources / "m.move").write_text("module x::y { use sui::transfer; }", encoding="utf-8")
    assert module.detect(tmp_path)["chain"] == "sui"

    aptos = tmp_path / "aptos"
    aptos.mkdir()
    (aptos / "Move.toml").write_text("[package]\nname = \"p\"\n", encoding="utf-8")
    (aptos / "sources").mkdir()
    (aptos / "sources" / "m.move").write_text(
        "module x::y { use aptos_framework::coin::Coin; }", encoding="utf-8"
    )
    assert module.detect(aptos)["chain"] == "aptos"


def test_detect_stack_output_is_json(tmp_path: Path) -> None:
    module = _load_detect_stack()
    (tmp_path / "foundry.toml").write_text("", encoding="utf-8")
    result = module.detect(tmp_path)
    assert isinstance(json.loads(json.dumps(result)), dict)
    assert "protocolHints" in result
    assert isinstance(result["protocolHints"], list)


def test_no_legacy_patterns_reintroduced() -> None:
    assert not (SKILLS_DIR / "tool-index.md").exists()
    assert not (SKILLS_DIR / "route-skills").exists()
    skill_text = (SKILL_DIR / "SKILL.md").read_text(encoding="utf-8")
    assert "../tool-index.md" not in skill_text
    assert "route-skills" not in skill_text
    for ref in (SKILL_DIR / "references").iterdir():
        assert "../tool-index.md" not in ref.read_text(encoding="utf-8")


def test_no_duplicate_fine_grained_skills() -> None:
    store = CapabilityStore(REPO_ROOT)
    names = {skill.name for skill in store.list_skills()}
    forbidden = {
        "solidity-security",
        "defi-security",
        "foundry",
        "slither",
        "evm-security",
        "smart-contract-security",
    }
    assert forbidden.isdisjoint(names)
