#!/usr/bin/env python3
"""validate_bundle.py — code-audit 白盒能力 Bundle 完整性校验器。

检查项（对应融合方案 12.2）：
1. 七种审计模式文档全部存在
2. 四语言 router 与漏洞规则存在
3. Common 判定与质量门禁规则全部存在
4. Markdown 相对链接可解析
5. Python 脚本可编译；JSON Schema 可解析
6. 不存在 .codeflicker 硬编码路径与 macOS 临时目录硬编码
7. 不存在目标仓库根 AGENTS.md 覆盖行为
8. 案例映射（case-mapping.yaml）引用的案例文件不丢失
9. route-skills 路由能到达三个白盒子模块
10. learned 写入器和索引可用
11. capability-manifest.json 中每个原始核心文件均有目标映射
"""
from __future__ import annotations

import json
import py_compile
import re
import sys
from pathlib import Path

TOOL_ROOT = Path(__file__).resolve().parents[1]  # redtrace-tools/
SKILL_ROOT = TOOL_ROOT.parent  # route-skills/
CODE_AUDIT = SKILL_ROOT / "upstream" / "skills" / "code-audit"
UPSTREAM_SKILLS = SKILL_ROOT / "upstream" / "skills"

MODES = [
    "arch-scan",
    "api-audit",
    "mr-review",
    "sast-audit",
    "api-inventory",
    "report-review",
    "security-assessment",
]
LANGUAGES = ["java", "go", "python", "javascript"]
COMMON_RULES = [
    "false-positive-filtering",
    "audit-anti-patterns",
    "sanitization",
    "severity-rating",
    "category-enum",
    "source-discipline",
    "trusted-sources",
    "ssrf-proxy",
    "framework-spring",
    "kconf",
    "grpc",
    "blobstore",
    "threat-consumption",
]
LINK = re.compile(r"\]\((?!https?://|#)([^)#\s]+)(?:#[^)]*)?\)")
BAD_PATHS = re.compile(r"~?/\.codeflicker|/var/folders/|__MACOSX")


def check(errors: list[str], ok: bool, message: str) -> None:
    if not ok:
        errors.append(message)


def main() -> int:
    errors: list[str] = []

    # 1. 七种模式
    for mode in MODES:
        path = CODE_AUDIT / "references" / "modes" / f"{mode}.md"
        check(errors, path.is_file(), f"missing mode doc: {path}")

    # 2. 四语言 router 与漏洞规则
    for language in LANGUAGES:
        language_dir = CODE_AUDIT / "references" / language
        check(
            errors,
            (language_dir / f"{language}-router.md").is_file(),
            f"missing router: {language}-router.md",
        )
        rules = list(language_dir.glob(f"{language}-*.md"))
        check(errors, len(rules) >= 10, f"too few {language} rules: {len(rules)}")

    # 3. Common 规则
    for rule in COMMON_RULES:
        path = CODE_AUDIT / "references" / "common" / f"{rule}.md"
        check(errors, path.is_file(), f"missing common rule: {rule}.md")

    # 4. Markdown 相对链接
    markdown_files = [
        path
        for path in CODE_AUDIT.rglob("*.md")
        if "node_modules" not in path.parts
    ]
    for path in markdown_files:
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for target in LINK.findall(text):
            if "$" in target or target.startswith("<"):
                continue  # 环境变量路径占位符不参与解析
            resolved = (path.parent / target).resolve()
            if not resolved.exists():
                errors.append(f"broken link in {path.relative_to(SKILL_ROOT)}: {target}")

    # 5. 脚本与 Schema
    for script in (CODE_AUDIT / "scripts").glob("*.py"):
        try:
            py_compile.compile(str(script), doraise=True)
        except py_compile.PyCompileError as exc:
            errors.append(f"script does not compile: {script.name}: {exc}")
    schema = CODE_AUDIT / "scripts" / "output-schema.json"
    check(errors, schema.is_file(), "missing scripts/output-schema.json")
    if schema.is_file():
        try:
            json.loads(schema.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            errors.append(f"output-schema.json invalid: {exc}")
    for tool in TOOL_ROOT.glob("code-audit/*.py"):
        try:
            py_compile.compile(str(tool), doraise=True)
        except py_compile.PyCompileError as exc:
            errors.append(f"redtrace tool does not compile: {tool.name}: {exc}")

    # 6/7. 禁止内容与 AGENTS.md 覆盖行为
    scanned = [
        path
        for path in CODE_AUDIT.rglob("*")
        if path.is_file() and path.suffix in {".md", ".py", ".cjs", ".json", ".yaml"}
    ]
    for path in scanned:
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if BAD_PATHS.search(text):
            errors.append(f"forbidden hard-coded path in {path.relative_to(SKILL_ROOT)}")
        for line in text.splitlines():
            if re.search(r"\bAGENTS\.md\b", line) and "禁止" not in line:
                errors.append(
                    f"AGENTS.md write/consume reference remains in "
                    f"{path.relative_to(SKILL_ROOT)}: {line.strip()[:80]}"
                )

    # 8. 案例映射完整
    mapping = CODE_AUDIT / "references" / "cases" / "case-mapping.yaml"
    check(errors, mapping.is_file(), "missing cases/case-mapping.yaml")
    if mapping.is_file():
        text = mapping.read_text(encoding="utf-8", errors="replace")
        for reference in re.findall(r"([a-z0-9-]+-cases\.md)", text):
            check(
                errors,
                (CODE_AUDIT / "references" / "cases" / reference).is_file(),
                f"case mapping lost file: {reference}",
            )

    # 9. 路由可达三个白盒模块
    routing_files = [
        UPSTREAM_SKILLS / "SKILL.md",
        UPSTREAM_SKILLS / "MASTER-ROUTING.md",
        UPSTREAM_SKILLS / "routing.md",
    ]
    routing_text = "\n".join(
        path.read_text(encoding="utf-8", errors="replace")
        for path in routing_files
        if path.is_file()
    )
    for module in ("code-audit", "code-audit-runtime-verify", "code-audit-benchmark"):
        check(errors, module in routing_text, f"routing cannot reach module: {module}")

    # 10. learned 体系
    learned = CODE_AUDIT / "learned"
    check(errors, (learned / "learned.md").is_file(), "missing learned/learned.md")
    check(errors, (learned / "learned.index").is_file(), "missing learned/learned.index")
    check(errors, (learned / "entries").is_dir(), "missing learned/entries/")
    check(errors, (TOOL_ROOT / "code-audit" / "evolve.py").is_file(), "missing evolve.py")

    # 11. capability-manifest 映射完整
    manifest_path = CODE_AUDIT / "capability-manifest.json"
    check(errors, manifest_path.is_file(), "missing capability-manifest.json")
    if manifest_path.is_file():
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            manifest = None
            errors.append(f"capability-manifest.json invalid: {exc}")
        if manifest is not None:
            for record in manifest.get("files", []):
                target = CODE_AUDIT / record.get("target", "")
                check(
                    errors,
                    target.is_file(),
                    f"manifest target missing: {record.get('target')}",
                )
            declared_modes = set(manifest.get("requiredModes", []))
            check(errors, declared_modes == set(MODES), "manifest requiredModes mismatch")

    if errors:
        print(json.dumps({"valid": False, "errors": errors}, ensure_ascii=False, indent=2))
        return 1
    print(json.dumps({"valid": True, "checks": "all passed"}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
