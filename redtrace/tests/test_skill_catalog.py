from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml

from redtrace.capabilities import CapabilityStore, workspace_payload


REPO_ROOT = Path(__file__).resolve().parents[2]
SKILLS_DIR = REPO_ROOT / "skills"
ALLOWED_FRONTMATTER = {
    "name",
    "description",
    "license",
    "allowed-tools",
    "metadata",
}
CLAUDE_RED_REFERENCES = {
    "claude-red-active-directory": {"offensive-active-directory.md"},
    "claude-red-cloud": {"offensive-cloud.md"},
    "claude-red-exploit-development": {
        "offensive-fuzzing.md",
        "offensive-shellcode.md",
        "offensive-toctou.md",
    },
    "claude-red-iot": {"offensive-iot.md"},
    "claude-red-mobile": {"offensive-mobile.md"},
    "claude-red-osint": {"offensive-osint.md"},
    "claude-red-wireless": {
        "offensive-bluetooth-ble.md",
        "offensive-bluetooth-classic.md",
        "offensive-deauth-disassoc.md",
        "offensive-evil-twin.md",
        "offensive-krack-fragattacks.md",
        "offensive-lorawan-sub-ghz.md",
        "offensive-wifi-recon.md",
        "offensive-wpa-enterprise.md",
        "offensive-wpa2-psk.md",
        "offensive-wpa3-sae.md",
        "offensive-wps.md",
        "offensive-z-wave.md",
        "offensive-zigbee-thread-matter.md",
    },
}


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


def test_skill_catalog_is_bounded_and_well_formed() -> None:
    directories = _catalog_directories()

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

    assert not list(SKILLS_DIR.rglob(".git"))
    assert not list(SKILLS_DIR.rglob(".DS_Store"))


def test_claude_red_is_classified_and_shared_with_all_workers(
    materialized_catalog: tuple[CapabilityStore, dict[str, bytes]],
) -> None:
    store, files = materialized_catalog

    assert not (SKILLS_DIR / "claude-red").exists()
    assert sum(map(len, CLAUDE_RED_REFERENCES.values())) == 21
    # Claude reads .claude/skills; Codex and Pi share the .agents/skills snapshot.
    for name, expected_references in CLAUDE_RED_REFERENCES.items():
        record = store.get_skill(name)
        skill_dir = SKILLS_DIR / name
        actual_references = {
            path.name for path in (skill_dir / "references").glob("*.md")
        }
        interface = yaml.safe_load(
            (skill_dir / "agents" / "openai.yaml").read_text(encoding="utf-8")
        )["interface"]

        assert record.enabled is True
        assert record.trust == "provisional"
        assert "## Tool readiness" in record.content
        assert actual_references == expected_references
        assert interface["display_name"]
        assert interface["short_description"]
        assert f"${name}" in interface["default_prompt"]

        for prefix in (".claude/skills", ".agents/skills"):
            assert f"{prefix}/{name}/SKILL.md" in files
            assert f"{prefix}/{name}/agents/openai.yaml" in files
            for reference in expected_references:
                assert f"{prefix}/{name}/references/{reference}" in files

    search = store.get_skill("brave-search")
    assert search.enabled is True
    assert ".claude/skills/brave-search/SKILL.md" in files
    assert ".agents/skills/brave-search/SKILL.md" in files


def test_playwright_cli_skill_is_shared_with_all_workers(
    materialized_catalog: tuple[CapabilityStore, dict[str, bytes]],
) -> None:
    store, files = materialized_catalog

    assert store.get_skill("playwright").enabled is True
    for prefix in (".claude/skills", ".agents/skills"):
        assert f"{prefix}/playwright/SKILL.md" in files
        assert f"{prefix}/playwright/scripts/playwright_cli.sh" in files
        assert f"{prefix}/playwright/references/cli.md" in files
        assert f"{prefix}/playwright/references/workflows.md" in files
