from __future__ import annotations

import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def test_deploy_script_unifies_linux_and_macos_without_legacy_entrypoints() -> None:
    script_path = REPO_ROOT / "deploy.sh"
    script = script_path.read_text(encoding="utf-8")

    assert script_path.stat().st_mode & 0o111
    assert not (REPO_ROOT / "deploy-local.sh").exists()
    assert not (REPO_ROOT / "deploy-macos.sh").exists()
    assert "D:\\AI\\ctf-skills" not in script
    assert "/ctf-skills/scripts" not in script
    assert 'Darwin) DEFAULT_HOST=127.0.0.1' in script
    assert 'Linux) DEFAULT_HOST=0.0.0.0' in script
    assert "setup_macos" in script
    assert "setup_linux" in script
    assert script.count("ensure_npm_cli()") == 1
    assert script.count("prepare_local_config()") == 1
    assert script.count("start_component()") == 1
    assert "detect_system_package_manager" in script
    assert "apt, dnf/yum, pacman, zypper, and apk" in script
    assert 'bash "$CTF_TOOL_INSTALLER" system' in script
    assert "/etc/apt/sources" not in script
    assert '"$HOME/.profile"' not in script
    assert "REDTRACE_KEEP_APT_SOURCES" not in script
    assert "seed_pi_prebuilt_deps" not in script
    assert ".redtrace/workers" not in script
    assert "registry.npmmirror.com" in script
    assert "mirrors.aliyun.com/pypi/simple" in script
    assert 'if has "$command"; then' in script
    assert "rtk gain" in script
    assert "@anthropic-ai/claude-code@latest" in script
    assert "@openai/codex@latest" in script
    assert "@earendil-works/pi-coding-agent@latest" in script
    assert "@playwright/cli@latest" in script
    assert "ensure_playwright_cli_skill" in script
    assert "playwright-cli install-browser chromium" in script
    assert "--with-deps" not in script
    assert "uv sync --frozen" in script
    assert "REDTRACE_LOCAL_PATH_PREPEND" in script
    assert "pid_is_running" in script
    assert "detected Windows WSL" in script
    assert "ensure_brave_search_skill" in script
    assert "ensure_ghidra_headless_skill" in script
    assert "NationalSecurityAgency/ghidra/releases/latest" in script
    assert "sha256sum -c -" in script
    assert "REDTRACE_GHIDRA_HOME" in script
    assert "ensure_nuclei" in script
    assert "disable-update-check: true" in script
    assert "ensure_rsactftool" in script
    assert "ensure_qiling" in script
    assert "github.com/RsaCtfTool/RsaCtfTool.git@" in script
    assert "nuclei" in script
    assert "exploitdb" not in script
    assert "searchsploit" not in script
    assert "cysignals==1.12.6" in script
    assert "verify_security_toolchain" in script
    assert "set_common_env_secret" in script
    assert "test_brave_search_skill" in script
    assert "REDTRACE_SKIP_BRAVE_TEST" in script
    assert 'chmod 600 "$CONFIG_PATH"' in script
    assert "openjdk@21 ghidra" in script
    assert "ensure_sage" not in script
    assert "REDTRACE_INSTALL_SAGE" not in script
    assert "SageMath" not in script
    assert "repair_brew_formula_cli ffmpeg ffmpeg -version" in script
    assert "repair_tshark" in script
    assert "brew reinstall lz4" in script
    assert "ensure_brew_formula_cli_path qemu qemu-system-x86_64" in script
    assert "DYLD_FALLBACK_LIBRARY_PATH" in script
    assert 'WORKER_PATH="$JAVA_HOME/bin:' in script
    assert "npm ci --prefix" in script
    assert "configure_brave_search_key" in script
    assert "REDTRACE_PLAINTEXT_SECRETS" in script
    assert "skipping optional Python and Ruby security tools" in script
    assert "start_launch_agents" in script
    assert "launchctl bootstrap" in script
    assert "KeepAlive" in script
    assert "DEFAULT_USE_LAUNCHD" in script
    assert "os.setsid()" in script
    assert 'chmod 600 "$CONFIG_PATH"' in script


def test_playwright_cli_skill_is_complete_and_deployable() -> None:
    skill_dir = REPO_ROOT / "skills" / "playwright"
    wrapper = skill_dir / "scripts" / "playwright_cli.sh"

    assert (skill_dir / "SKILL.md").is_file()
    assert (skill_dir / "LICENSE.txt").is_file()
    assert (skill_dir / "NOTICE.txt").is_file()
    assert (skill_dir / "references" / "cli.md").is_file()
    assert (skill_dir / "references" / "workflows.md").is_file()
    assert wrapper.is_file()
    assert wrapper.stat().st_mode & 0o111
    assert "@playwright/cli" in wrapper.read_text(encoding="utf-8")


def test_ctf_tool_installer_supports_all_linux_package_families() -> None:
    script_path = REPO_ROOT / "install_ctf_tools.sh"
    script = script_path.read_text(encoding="utf-8")

    mode_patterns = {
        "apt": "    apt)",
        "dnf": "    dnf|yum)",
        "yum": "    dnf|yum)",
        "pacman": "    pacman)",
        "zypper": "    zypper)",
        "apk": "    apk)",
    }
    for manager, pattern in mode_patterns.items():
        assert pattern in script
        completed = subprocess.run(
            ["bash", str(script_path), "--dry-run", manager],
            check=False,
            capture_output=True,
            text=True,
        )
        assert completed.returncode == 0, completed.stderr
        assert f"System package manager: {manager}" in completed.stdout
        assert "Would install" in completed.stdout

    assert "cysignals==1.12.6" in script
    assert "nuclei-engine@$NUCLEI_VERSION" in script
    assert "configure_nuclei_engine" in script
    assert "disable-update-check: true" in script
    assert "github.com/RsaCtfTool/RsaCtfTool.git@" in script
    assert "install_qiling" in script
    assert "isolated Python 3.11 environment" in script
    assert "SageMath" not in script
    assert "No vulnerability database, PoC collection" in script
    assert "nuclei-templates" not in script
    assert "exploitdb" not in script
    qiling_wrapper = REPO_ROOT / "skills" / "ctf-reverse" / "scripts" / "qiling-python"
    assert qiling_wrapper.is_file()
    assert qiling_wrapper.stat().st_mode & 0o111


def test_ghidra_headless_skill_is_installed_with_all_exporters() -> None:
    skill_dir = REPO_ROOT / "skills" / "ghidra-headless"

    assert (skill_dir / "SKILL.md").is_file()
    assert (skill_dir / "scripts" / "find-ghidra.sh").is_file()
    assert (skill_dir / "scripts" / "ghidra-analyze.sh").is_file()
    exporters = {
        path.name
        for path in (skill_dir / "scripts" / "ghidra_scripts").glob("*.java")
    }
    assert exporters == {
        "ExportAll.java",
        "ExportCalls.java",
        "ExportDecompiled.java",
        "ExportFunctions.java",
        "ExportStrings.java",
        "ExportSymbols.java",
    }


def test_container_has_known_vulnerability_and_crypto_toolchain() -> None:
    dockerfile = (REPO_ROOT / "container" / "Dockerfile").read_text(
        encoding="utf-8"
    )
    agent_instructions = (REPO_ROOT / "container" / "AGENTS.md").read_text(
        encoding="utf-8"
    )

    for package in (
        "python3-venv",
        "hashcat",
        "ffmpeg",
        "qrencode",
        "zbar-tools",
        "sox",
        "tesseract-ocr",
    ):
        assert package in dockerfile
    assert "nuclei_3.11.0_checksums.txt" in dockerfile
    assert "sha256sum -c -" in dockerfile
    assert "cysignals fpylll py_ecc" in dockerfile
    assert "pyzbar pytesseract segno" in dockerfile
    assert "github.com/RsaCtfTool/RsaCtfTool.git@" in dockerfile
    assert "RsaCtfTool --help" in dockerfile
    assert "playwright-cli install-browser chromium --with-deps" in dockerfile
    assert "exploitdb" not in dockerfile
    assert "nuclei-templates.git" not in dockerfile
    assert "/home/kali/pocs" not in dockerfile
    assert "/home/kali/knowledges" not in dockerfile
    assert "PayloadsAllTheThings" not in dockerfile
    assert "/home/kali/knowledges" not in agent_instructions
    assert "必须先联网搜索厂商公告、CVE 和公开 PoC/EXP" in agent_instructions
    assert "不要下载或同步整套漏洞库" in agent_instructions
    assert "先审查并运行 PoC 验证漏洞" in agent_instructions
