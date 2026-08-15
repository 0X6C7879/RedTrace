from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml

from redtrace.capabilities import CapabilityStore, workspace_payload


REPO_ROOT = Path(__file__).resolve().parents[2]
SKILLS_DIR = REPO_ROOT / "skills"
def _catalog_directories() -> list[Path]:
    return sorted(
        path
        for path in SKILLS_DIR.iterdir()
        if path.is_dir() and not path.name.startswith(".")
    )


@pytest.fixture(scope="module")
def materialized_catalog() -> tuple[CapabilityStore, dict[str, bytes]]:
    store = CapabilityStore(REPO_ROOT)
    _, files = workspace_payload(store)
    return store, files


def test_skill_catalog_is_flat_and_well_formed() -> None:
    directories = _catalog_directories()
    names = {directory.name for directory in directories}

    assert len(directories) >= 80
    assert {"api-security", "attack-chain", "code-audit", "ctf-sandbox-orchestrator"} <= names
    for directory in directories:
        entrypoint = directory / "SKILL.md"
        assert entrypoint.is_file(), f"{directory.name} has no top-level SKILL.md"
        content = entrypoint.read_text(encoding="utf-8")
        assert not content.startswith("\ufeff"), f"{directory.name} starts with a BOM"
        assert len(content) <= 65_536, f"{directory.name} exceeds RedTrace's size limit"

        match = re.match(r"^---\n(.*?)\n---", content, re.DOTALL)
        assert match, f"{directory.name} has invalid YAML frontmatter"
        frontmatter = yaml.safe_load(match.group(1))
        assert isinstance(frontmatter, dict)
        assert frontmatter.get("name") == directory.name
        description = frontmatter.get("description")
        assert isinstance(description, str) and description.strip()
        assert len(description) <= 1024
        assert "<" not in description and ">" not in description

    assert not list(SKILLS_DIR.rglob(".git"))
    assert not list(SKILLS_DIR.rglob(".DS_Store"))


def test_specialist_skills_are_shared_with_all_workers(
    materialized_catalog: tuple[CapabilityStore, dict[str, bytes]],
) -> None:
    store, files = materialized_catalog
    for name in ("api-security", "code-audit", "ctf-sandbox-orchestrator", "playwright"):
        assert store.get_skill(name).enabled is True
        for prefix in (".claude/skills", ".agents/skills"):
            assert f"{prefix}/{name}/SKILL.md" in files

    assert ".claude/skills/code-audit/scripts/validate-output.cjs" in files
    assert ".agents/skills/pentest-tools/tools/burp-mcp-full/mcp-bridge.js" in files
