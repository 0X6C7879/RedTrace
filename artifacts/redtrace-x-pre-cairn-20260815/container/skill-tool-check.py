#!/usr/bin/env python3
"""Skill → tool consistency check (spec §28).

Cross-references the known tool registry (toolchain-manifest.py) against every
kept skill: if a skill references a *known* tool that is not on PATH, the build
fails. Only curated tool names are checked, so prose/identifiers don't produce
false positives.

Usage: python3 skill-tool-check.py [skills-dir] [--manifest PATH]
"""

from __future__ import annotations

import importlib.util
import re
import shutil
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent


def _load_manifest_tools() -> dict[str, tuple]:
    spec = importlib.util.spec_from_file_location(
        "toolchain_manifest", _HERE / "toolchain-manifest.py"
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module.TOOLS


def _skill_texts(skill_dir: Path) -> list[str]:
    texts: list[str] = []
    for path in skill_dir.rglob("*"):
        if path.is_dir() or path.suffix not in {".md", ".sh", ".py", ".yaml", ".yml", ".json"}:
            continue
        try:
            texts.append(path.read_text(encoding="utf-8", errors="replace"))
        except OSError:
            continue
    return texts


def main() -> int:
    args = [a for a in sys.argv[1:]]
    skills_dir = Path("skills")
    if args and not args[0].startswith("--"):
        skills_dir = Path(args.pop(0))

    known = _load_manifest_tools()
    # A tool is "checked" only if it is not already on PATH (i.e. not a host tool).
    required = {name for name in known if not shutil.which(name)}

    missing_by_skill: dict[str, set[str]] = {}
    for skill in sorted(p for p in skills_dir.iterdir() if p.is_dir()):
        text = "\n".join(_skill_texts(skill))
        referenced = {
            name for name in required
            if re.search(rf"\b{re.escape(name)}\b", text, re.IGNORECASE)
        }
        if referenced:
            missing_by_skill[skill.name] = sorted(referenced)

    if not missing_by_skill:
        print("skill-tool check ok")
        return 0

    for skill, tools in missing_by_skill.items():
        print(f"{skill}: {', '.join(tools)}")
    print(
        f"skill-tool check failed: {len(missing_by_skill)} skills reference "
        "known tools that are not installed"
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
