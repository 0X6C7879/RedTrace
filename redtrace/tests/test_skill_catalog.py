from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml

from redtrace.capabilities import CapabilityStore


REPO_ROOT = Path(__file__).resolve().parents[2]
SKILLS_DIR = REPO_ROOT / "skills"
ALLOWED_FRONTMATTER = {
    "name",
    "description",
    "license",
    "allowed-tools",
    "metadata",
}
EXPECTED_TOP_LEVEL_SKILLS = {
    "brave-search",
    "playwright",
    "route-skills",
}


def _catalog_directories() -> list[Path]:
    return sorted(
        path
        for path in SKILLS_DIR.iterdir()
        if path.is_dir() and not path.name.startswith(".")
    )


@pytest.fixture(scope="module")
def catalog() -> CapabilityStore:
    return CapabilityStore(REPO_ROOT)


def test_skill_catalog_is_bounded_and_well_formed() -> None:
    directories = _catalog_directories()

    assert {directory.name for directory in directories} == EXPECTED_TOP_LEVEL_SKILLS
    assert len(directories) <= 40
    for directory in directories:
        entrypoint = directory / "SKILL.md"
        assert entrypoint.is_file(), f"{directory.name} has no top-level SKILL.md"
        content = entrypoint.read_text(encoding="utf-8")
        assert not content.startswith("\ufeff"), f"{directory.name} starts with a BOM"
        assert len(content) <= 65_536, f"{directory.name} exceeds RedTrace's size limit"
        assert len(content.splitlines()) <= 500, f"{directory.name} is too long"

        match = re.match(r"^---\n(.*?)\n---", content, re.DOTALL)
        assert match, f"{directory.name} has invalid YAML frontmatter"
        frontmatter = yaml.safe_load(match.group(1))
        assert isinstance(frontmatter, dict)
        assert set(frontmatter) <= ALLOWED_FRONTMATTER
        assert frontmatter.get("name") == directory.name
        description = frontmatter.get("description")
        assert isinstance(description, str) and description.strip()
        assert len(description) <= 1024
        assert "<" not in description and ">" not in description

    assert not {
        path.name
        for path in SKILLS_DIR.rglob("*")
        if path.name in {".git", ".DS_Store"}
    }


def test_route_skills_is_complete_and_shared_with_all_workers(
    catalog: CapabilityStore,
) -> None:
    record = catalog.get_skill("route-skills")
    required = {
        "upstream/RULES.md",
        "upstream/skills/SKILL.md",
        "upstream/skills/scripts/case-init.ps1",
        "upstream/skills/scripts/bootstrap-reverse.sh",
        "upstream/skills/scripts/refresh-tool-index.sh",
        "upstream/skills/ops/scope-contract.md",
        "upstream/skills/field-journal/_index.md",
        "upstream/skills/field-journal/_template.md",
        "upstream/skills/code-audit/SKILL.md",
        "upstream/skills/code-audit/capability-manifest.json",
        "upstream/skills/code-audit-runtime-verify/SKILL.md",
        "upstream/skills/code-audit-benchmark/SKILL.md",
        "upstream/CTF-Sandbox-Orchestrator/ctf-sandbox-orchestrator/SKILL.md",
    }

    assert record.enabled is True
    assert required <= set(record.files)
    assert "cab837a298fec6fa28a49ef746d0085e0b112cfa" in record.content
    search = catalog.get_skill("brave-search")
    assert search.enabled is True


def test_route_skills_controller_is_non_interactive_for_redtrace_workers() -> None:
    skill_dir = SKILLS_DIR / "route-skills"
    automation_rules = (skill_dir / "REDTRACE_RULES.md").read_text(encoding="utf-8")
    controller_files = (
        skill_dir / "upstream" / "skills" / "SKILL.md",
        skill_dir / "upstream" / "skills" / "CONTRIBUTING.md",
        skill_dir / "upstream" / "skills" / "dotnet-reverse" / "SKILL.md",
    )
    controller_text = "\n".join(path.read_text(encoding="utf-8") for path in controller_files)

    assert "自动选择" in automation_rules
    assert "不得等待用户选择" in automation_rules
    assert "3-6 个编号" not in controller_text
    assert "3–6 项下一步菜单" not in controller_text
    assert "无用户选择的情况下跨阶段" not in controller_text


def test_playwright_cli_skill_is_shared_with_all_workers(
    catalog: CapabilityStore,
) -> None:
    record = catalog.get_skill("playwright")

    assert record.enabled is True
    assert {
        "SKILL.md",
        "scripts/playwright_cli.sh",
        "references/cli.md",
        "references/workflows.md",
    } <= set(record.files)
