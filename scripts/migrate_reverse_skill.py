#!/usr/bin/env python3
"""Migrate zhaoxuya520/reverse-skill into RedTrace's shared skill catalog.

The migration is deterministic and source-pinned. Semantic duplicates are removed
according to config/reverse-skill-migration.json, while RedTrace runtime skills
that are tightly coupled to the dispatcher are preserved.

Examples:
    python scripts/migrate_reverse_skill.py
    python scripts/migrate_reverse_skill.py --apply --validate
    python scripts/migrate_reverse_skill.py --apply --source-dir ../reverse-skill
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
import tempfile
import urllib.request
import zipfile
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Any

ALLOWED_FRONTMATTER = {
    "name",
    "description",
    "license",
    "allowed-tools",
    "metadata",
}
FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n?", re.DOTALL)
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


@dataclass(frozen=True)
class PlannedSkill:
    source: Path
    target_name: str
    source_kind: str = "skill"


class MigrationError(RuntimeError):
    pass


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
        help="RedTrace repository root",
    )
    parser.add_argument(
        "--policy",
        type=Path,
        default=None,
        help="Migration policy JSON; defaults to config/reverse-skill-migration.json",
    )
    parser.add_argument(
        "--source-dir",
        type=Path,
        default=None,
        help="Use an existing reverse-skill checkout instead of downloading",
    )
    parser.add_argument(
        "--source-archive",
        type=Path,
        default=None,
        help="Use a local reverse-skill ZIP archive instead of downloading",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Apply changes. Without this flag, only print the migration plan.",
    )
    parser.add_argument(
        "--validate",
        action="store_true",
        help="Run RedTrace skill catalog tests after applying",
    )
    parser.add_argument(
        "--keep-backup",
        action="store_true",
        help="Save replaced RedTrace skill directories under .redtrace/migration-backups",
    )
    return parser.parse_args()


def load_policy(repo_root: Path, supplied: Path | None) -> tuple[Path, dict[str, Any]]:
    policy_path = supplied or repo_root / "config" / "reverse-skill-migration.json"
    policy_path = policy_path.resolve()
    try:
        policy = json.loads(policy_path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise MigrationError(f"policy not found: {policy_path}") from exc
    except json.JSONDecodeError as exc:
        raise MigrationError(f"invalid policy JSON: {policy_path}: {exc}") from exc
    if policy.get("source", {}).get("priority") != "reverse-skill":
        raise MigrationError("policy must set source.priority to reverse-skill")
    return policy_path, policy


def download_archive(repository: str, ref: str, destination: Path) -> str:
    url = f"https://github.com/{repository}/archive/{ref}.zip"
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "RedTrace reverse-skill migration"},
    )
    digest = hashlib.sha256()
    with urllib.request.urlopen(request, timeout=120) as response, destination.open("wb") as out:
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            out.write(chunk)
    return digest.hexdigest()


def safe_extract_zip(archive: Path, destination: Path) -> None:
    destination = destination.resolve()
    with zipfile.ZipFile(archive) as bundle:
        for item in bundle.infolist():
            relative = PurePosixPath(item.filename)
            if relative.is_absolute() or ".." in relative.parts:
                raise MigrationError(f"unsafe archive member: {item.filename}")
            output = destination.joinpath(*relative.parts)
            resolved_parent = output.parent.resolve()
            if destination != resolved_parent and destination not in resolved_parent.parents:
                raise MigrationError(f"archive member escapes destination: {item.filename}")
            if item.is_dir():
                output.mkdir(parents=True, exist_ok=True)
                continue
            output.parent.mkdir(parents=True, exist_ok=True)
            with bundle.open(item) as source, output.open("wb") as target:
                shutil.copyfileobj(source, target)


def locate_source_root(extracted: Path) -> Path:
    candidates = [path for path in extracted.iterdir() if path.is_dir()]
    for candidate in candidates:
        if (candidate / "skills").is_dir() and (candidate / "README.md").is_file():
            return candidate
    if (extracted / "skills").is_dir():
        return extracted
    raise MigrationError("cannot locate reverse-skill root in archive")


def prepare_source(
    policy: dict[str, Any],
    source_dir: Path | None,
    source_archive: Path | None,
    temporary: Path,
) -> tuple[Path, str | None]:
    if source_dir is not None:
        root = source_dir.expanduser().resolve()
        if not (root / "skills").is_dir():
            raise MigrationError(f"invalid reverse-skill source directory: {root}")
        return root, None

    extracted = temporary / "source"
    extracted.mkdir(parents=True, exist_ok=True)
    if source_archive is not None:
        archive = source_archive.expanduser().resolve()
        if not archive.is_file():
            raise MigrationError(f"source archive not found: {archive}")
        archive_sha = hashlib.sha256(archive.read_bytes()).hexdigest()
    else:
        archive = temporary / "reverse-skill.zip"
        source = policy["source"]
        archive_sha = download_archive(source["repository"], source["ref"], archive)
    safe_extract_zip(archive, extracted)
    return locate_source_root(extracted), archive_sha


def parse_frontmatter(content: str) -> tuple[dict[str, Any], str]:
    match = FRONTMATTER_RE.match(content.replace("\r\n", "\n"))
    if not match:
        return {}, content.replace("\r\n", "\n")
    data: dict[str, Any] = {}
    for raw_line in match.group(1).splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or ":" not in line:
            continue
        key, value = line.split(":", 1)
        key = key.strip()
        if key in {"name", "description", "license", "allowed-tools"}:
            data[key] = value.strip().strip("\"'")
    return data, content[match.end() :].replace("\r\n", "\n")


def quote_yaml(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def normalize_skill(entrypoint: Path, name: str, provenance: str) -> str:
    if not NAME_RE.fullmatch(name):
        raise MigrationError(f"invalid target skill name: {name}")
    original = entrypoint.read_text(encoding="utf-8-sig")
    metadata, body = parse_frontmatter(original)
    description = str(metadata.get("description") or "").strip()
    if not description:
        description = f"Imported reverse-skill capability for {name}."
    lines = ["---", f"name: {name}", f"description: {quote_yaml(description)}"]
    for key in ("license", "allowed-tools"):
        value = str(metadata.get(key) or "").strip()
        if value:
            lines.append(f"{key}: {quote_yaml(value)}")
    lines.extend(
        [
            "metadata:",
            "  source: reverse-skill",
            f"  source_ref: {quote_yaml(provenance)}",
            "---",
            "",
        ]
    )
    return "\n".join(lines) + body.lstrip("\n").rstrip() + "\n"


def skill_revision(content: str, trust: str) -> str:
    digest = hashlib.sha256()
    digest.update(b"enabled=1\n")
    digest.update(f"trust={trust}\n".encode())
    digest.update(b"successful_reuses=0\n")
    digest.update(b"failure_count=0\n")
    digest.update(content.encode("utf-8"))
    return digest.hexdigest()


def write_state(directory: Path, content: str, policy: dict[str, Any]) -> None:
    state_policy = policy.get("state", {})
    trust = str(state_policy.get("trust") or "provisional")
    source_ref = str(policy["source"]["ref"])
    state = {
        "enabled": bool(state_policy.get("enabled", True)),
        "version": 1,
        "revision": skill_revision(content, trust),
        "updatedAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "trust": trust,
        "successfulReuses": 0,
        "failureCount": 0,
        "provisionalTask": f"reverse-skill-import:{source_ref[:12]}",
    }
    (directory / ".redtrace.json").write_text(
        json.dumps(state, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )


def discover_skills(source_root: Path, policy: dict[str, Any]) -> list[PlannedSkill]:
    excluded = set(policy.get("excludeSourceSkills", []))
    planned: list[PlannedSkill] = []
    source_skills = source_root / "skills"
    for directory in sorted(source_skills.iterdir(), key=lambda item: item.name):
        if directory.name in excluded:
            continue
        if directory.is_dir() and (directory / "SKILL.md").is_file():
            planned.append(PlannedSkill(directory, directory.name))

    if policy.get("copyCtfBundle", True):
        ctf_root = source_root / "CTF-Sandbox-Orchestrator"
        ctf_entry = ctf_root / "ctf-sandbox-orchestrator" / "SKILL.md"
        if ctf_entry.is_file():
            planned.append(
                PlannedSkill(ctf_root, "ctf-sandbox-orchestrator", "ctf-bundle")
            )
    return planned


def duplicate_targets(policy: dict[str, Any], planned: list[PlannedSkill]) -> set[str]:
    available = {item.target_name for item in planned}
    preserve = set(policy.get("preserveRedTraceSkills", []))
    targets: set[str] = set()
    for source_name, old_names in policy.get("semanticReplacements", {}).items():
        if source_name not in available:
            continue
        for old_name in old_names:
            if old_name not in preserve:
                targets.add(old_name)
    return targets


def backup_directory(source: Path, backup_root: Path) -> None:
    if source.exists():
        destination = backup_root / source.name
        if destination.exists():
            shutil.rmtree(destination)
        shutil.copytree(source, destination, symlinks=False)


def copy_skill(
    item: PlannedSkill,
    skills_dir: Path,
    policy: dict[str, Any],
) -> None:
    destination = skills_dir / item.target_name
    if destination.exists():
        shutil.rmtree(destination)
    if item.source_kind == "ctf-bundle":
        shutil.copytree(item.source, destination, symlinks=False)
        source_entry = destination / "ctf-sandbox-orchestrator" / "SKILL.md"
        if not source_entry.is_file():
            raise MigrationError("CTF bundle entrypoint is missing after copy")
        shutil.copy2(source_entry, destination / "SKILL.md")
    else:
        shutil.copytree(item.source, destination, symlinks=False)

    provenance = f"{policy['source']['repository']}@{policy['source']['ref']}"
    normalized = normalize_skill(destination / "SKILL.md", item.target_name, provenance)
    (destination / "SKILL.md").write_text(normalized, encoding="utf-8", newline="\n")
    write_state(destination, normalized, policy)


def replace_exact(path: Path, old: str, new: str) -> bool:
    if not path.is_file():
        return False
    content = path.read_text(encoding="utf-8")
    if old not in content:
        return False
    path.write_text(content.replace(old, new), encoding="utf-8", newline="\n")
    return True


def patch_catalog_limits(repo_root: Path, policy: dict[str, Any]) -> list[str]:
    limits = policy["catalogLimits"]
    changed: list[str] = []
    capabilities = repo_root / "redtrace" / "src" / "redtrace" / "capabilities.py"
    replacements = [
        ("DEFAULT_MAX_SKILLS = 40", f"DEFAULT_MAX_SKILLS = {int(limits['maxSkills'])}"),
        (
            "DEFAULT_MAX_SKILL_CHARS = 65_536",
            f"DEFAULT_MAX_SKILL_CHARS = {int(limits['maxSkillChars']):_}",
        ),
    ]
    for old, new in replacements:
        if replace_exact(capabilities, old, new):
            changed.append(str(capabilities.relative_to(repo_root)))

    catalog_test = repo_root / "redtrace" / "tests" / "test_skill_catalog.py"
    test_replacements = [
        (
            "assert len(directories) <= 40",
            f"assert len(directories) <= {int(limits['maxSkills'])}",
        ),
        (
            "assert len(content) <= 65_536",
            f"assert len(content) <= {int(limits['maxSkillChars']):_}",
        ),
        (
            "assert len(content.splitlines()) <= 500",
            f"assert len(content.splitlines()) <= {int(limits['maxSkillLines'])}",
        ),
    ]
    for old, new in test_replacements:
        if replace_exact(catalog_test, old, new):
            changed.append(str(catalog_test.relative_to(repo_root)))
    return sorted(set(changed))


def write_lock(
    skills_dir: Path,
    policy_path: Path,
    policy: dict[str, Any],
    archive_sha: str | None,
    imported: list[str],
    removed: list[str],
) -> None:
    lock_dir = skills_dir / ".redtrace"
    lock_dir.mkdir(parents=True, exist_ok=True)
    lock = {
        "schemaVersion": 1,
        "source": policy["source"],
        "archiveSha256": archive_sha,
        "policy": str(policy_path),
        "importedAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "importedSkills": imported,
        "removedRedTraceSkills": removed,
    }
    (lock_dir / "reverse-skill.lock.json").write_text(
        json.dumps(lock, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def write_notice(repo_root: Path, policy: dict[str, Any]) -> None:
    notice = repo_root / "THIRD_PARTY_NOTICES.md"
    marker = "<!-- reverse-skill migration -->"
    section = f"""\n{marker}\n## reverse-skill\n\nRedTrace imports security skill content from `zhaoxuya520/reverse-skill` at commit\n`{policy['source']['ref']}`. The upstream repository is primarily MIT licensed.\nIts bundled `CTF-Sandbox-Orchestrator` content is GPL-3.0 and remains subject to\nthat license. Upstream copyright and license files must be retained when the\nmigration is applied.\n"""
    current = notice.read_text(encoding="utf-8") if notice.is_file() else "# Third-Party Notices\n"
    if marker not in current:
        notice.write_text(current.rstrip() + "\n" + section, encoding="utf-8", newline="\n")


def validate(repo_root: Path) -> None:
    command = [
        sys.executable,
        "-m",
        "pytest",
        "redtrace/tests/test_skill_catalog.py",
        "-q",
    ]
    subprocess.run(command, cwd=repo_root, check=True)


def print_plan(
    planned: list[PlannedSkill],
    removed: set[str],
    policy: dict[str, Any],
) -> None:
    print(f"source: {policy['source']['repository']}@{policy['source']['ref']}")
    print(f"priority: {policy['source']['priority']}")
    print(f"import skills: {len(planned)}")
    for item in planned:
        print(f"  + {item.target_name} ({item.source_kind})")
    print(f"remove semantic duplicates: {len(removed)}")
    for name in sorted(removed):
        print(f"  - {name}")
    print("RedTrace runtime skills preserved:")
    for name in sorted(policy.get("preserveRedTraceSkills", [])):
        print(f"  = {name}")


def main() -> int:
    args = parse_args()
    repo_root = args.repo_root.expanduser().resolve()
    policy_path, policy = load_policy(repo_root, args.policy)
    skills_dir = repo_root / "skills"
    if not skills_dir.is_dir():
        raise MigrationError(f"RedTrace skills directory not found: {skills_dir}")

    with tempfile.TemporaryDirectory(prefix="redtrace-reverse-skill-") as temp_name:
        temporary = Path(temp_name)
        source_root, archive_sha = prepare_source(
            policy,
            args.source_dir,
            args.source_archive,
            temporary,
        )
        planned = discover_skills(source_root, policy)
        if not planned:
            raise MigrationError("no source skills discovered")
        removed = duplicate_targets(policy, planned)
        print_plan(planned, removed, policy)
        if not args.apply:
            print("\nDry run only. Re-run with --apply to mutate the repository.")
            return 0

        backup_root: Path | None = None
        if args.keep_backup:
            stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
            backup_root = repo_root / ".redtrace" / "migration-backups" / stamp
            backup_root.mkdir(parents=True, exist_ok=True)

        for name in sorted(removed):
            target = skills_dir / name
            if backup_root is not None:
                backup_directory(target, backup_root)
            if target.exists():
                shutil.rmtree(target)

        for item in planned:
            target = skills_dir / item.target_name
            if backup_root is not None and target.exists():
                backup_directory(target, backup_root)
            copy_skill(item, skills_dir, policy)

        changed_limits = patch_catalog_limits(repo_root, policy)
        write_lock(
            skills_dir,
            policy_path,
            policy,
            archive_sha,
            sorted(item.target_name for item in planned),
            sorted(removed),
        )
        write_notice(repo_root, policy)

        print("\nMigration applied.")
        print(f"Imported {len(planned)} reverse-skill entries.")
        print(f"Removed {len(removed)} RedTrace semantic duplicates.")
        if changed_limits:
            print("Updated catalog bounds:")
            for path in changed_limits:
                print(f"  * {path}")
        if args.validate:
            validate(repo_root)
            print("Skill catalog validation passed.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (MigrationError, OSError, subprocess.CalledProcessError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1)
